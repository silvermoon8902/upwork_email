/* ============================================================================
 * Upwork → ContactOut Email Harvester — background service worker (orchestrator)
 *
 * Flow:
 *   1. Take the saved search URL; start page = its `page` param (default 1).
 *   2. Navigate a reusable search tab to that page; scrape candidate ~ids + names.
 *   3. For each candidate: open the profile in a real, visible tab; scrape name,
 *      country, title, education, skills, job success, badge, rate, earnings,
 *      and whether a GitHub account is linked.
 *   4. Skip anyone with a linked GitHub account (config: skipIfGithub) — that
 *      segment is handled elsewhere.
 *   5. ContactOut search on FIRST NAME ONLY ("Zyad K." -> "Zyad"), narrowed by
 *      education / country / title, then post-filtered on the last initial.
 *   6. Match: school overlap first (free), model adjudication otherwise.
 *   7. Above the confidence threshold -> reveal the email and POST to the sink.
 *   8. Auto-advance pages until a page yields no candidates.
 *
 * Start / Pause / Resume. Captcha auto-pauses (solve in the tab, then Resume).
 * ==========================================================================*/

import {
  CO_SEARCH_URL, buildSearchUrl, fillSearchFormFn, scrapeResultsFn, revealEmailFn,
  lookupSchoolFn, bestSchoolMatch, normalize, filterByLastInitial
} from './contactout_ui.js';
import { deterministicMatch, aiMatch } from './matcher.js';
import { PauseRun, shouldPause } from './errors.js';

const STORE = { config: 'hv_config', state: 'hv_state', log: 'hv_log' };

// Candidates located in these countries are skipped (lowercased match on country-name).
const SKIP_COUNTRIES = ['india', 'pakistan'];

// Upwork's "verifying you are human" interstitial normally clears on its own,
// so both scrapes re-read until content appears instead of giving up on the
// first look. Only after these windows expire is it treated as stuck.
const SEARCH_POLL_MS = 2500;
const SEARCH_MAX_WAIT_MS = 60000;
const PROFILE_MAX_WAIT_MS = 45000;

// A ContactOut result set larger than this means the filters didn't bite — the
// page only ever yields 15 rows, so matching against them is a lottery that
// still costs an OpenAI call per candidate. Skip instead of guessing.
const MAX_SEARCH_TOTAL = 300;

const DEFAULT_CONFIG = {
  searchUrl: '',
  openaiKey: '',
  openaiModel: 'gpt-4o',
  postEndpoint: 'https://script.google.com/macros/s/AKfycbwG_SXJPo_dn0FJQchDxGJOgYtNqgnsk98drSgRJfxhz3BS3RgjVcY-g2b3OyonhqwecQ/exec',
  minDelayMs: 4000,
  maxDelayMs: 10000,
  matchThreshold: 75,   // reject matches the matcher scores below this
  maxCandidates: 8,     // ContactOut results considered per freelancer
  skipIfGithub: true    // the target segment is freelancers WITHOUT a GitHub link
};

// In-memory mirror of the run state (also persisted so Resume survives SW death).
let S = {
  status: 'idle',          // idle | running | paused
  captcha: false,
  page: 1,
  queue: [],               // [{ id, name, profileUrl }]
  queueIndex: 0,
  searchTabId: null,       // reused background tab for search pages
  profileTabId: null,      // current profile tab (kept open across a captcha pause)
  coTabId: null,           // reused background tab holding the ContactOut dashboard
  processed: 0,
  emails: 0,
  current: ''
};

let driving = false;       // guards the drive() loop against re-entry

/* ----------------------------- persistence ------------------------------ */

async function loadConfig() {
  const o = await chrome.storage.local.get(STORE.config);
  return Object.assign({}, DEFAULT_CONFIG, o[STORE.config] || {});
}
async function saveConfig(cfg) {
  const merged = Object.assign({}, DEFAULT_CONFIG, cfg);
  await chrome.storage.local.set({ [STORE.config]: merged });
  return merged;
}
async function persistState() {
  await chrome.storage.local.set({ [STORE.state]: S });
  broadcast();
}
async function restoreState() {
  const o = await chrome.storage.local.get(STORE.state);
  if (o[STORE.state]) S = Object.assign(S, o[STORE.state]);
}

/* -------------------------------- logging ------------------------------- */

async function pushLog(msg, level = 'info') {
  const o = await chrome.storage.local.get(STORE.log);
  const arr = o[STORE.log] || [];
  arr.push({ t: Date.now(), level, msg });
  while (arr.length > 300) arr.shift();
  await chrome.storage.local.set({ [STORE.log]: arr });
  broadcast();
}

function broadcast() {
  // Popup may be closed -> ignore "no receiver" errors.
  chrome.runtime.sendMessage({ type: 'tick', state: publicState() }).catch(() => {});
}
function publicState() {
  return {
    status: S.status, captcha: S.captcha, page: S.page,
    queueLen: S.queue.length, queueIndex: S.queueIndex,
    processed: S.processed, emails: S.emails, current: S.current
  };
}

function setBadge(captcha) {
  chrome.action.setBadgeText({ text: captcha ? '!' : (S.status === 'running' ? '•' : '') });
  chrome.action.setBadgeBackgroundColor({ color: captcha ? '#d33' : '#14a800' });
}

/* ------------------------------- helpers -------------------------------- */

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randDelay(cfg) {
  const lo = Math.max(0, cfg.minDelayMs), hi = Math.max(lo, cfg.maxDelayMs);
  return Math.round(lo + Math.random() * (hi - lo));
}
function parsePage(url) {
  try { const u = new URL(url); const p = parseInt(u.searchParams.get('page'), 10); return p > 0 ? p : 1; }
  catch { return 1; }
}
function withPage(url, page) {
  const u = new URL(url); u.searchParams.set('page', String(page)); return u.toString();
}

// "Zyad K." -> { firstName: 'Zyad', lastInitial: 'K' }. The search keyword is the
// first name alone; the initial is only ever used to filter results afterwards.
function splitName(display) {
  const parts = (display || '').trim().split(/\s+/).filter(Boolean);
  const firstName = (parts[0] || '').replace(/[^\p{L}\p{M}'-]/gu, '');
  let lastInitial = '';
  if (parts.length > 1) {
    const m = parts[parts.length - 1].match(/\p{L}/u);
    if (m) lastInitial = m[0].toUpperCase();
  }
  return { firstName, lastInitial };
}

// Resolves as soon as the tab is complete, including when it already was —
// registering the listener after navigation used to mean waiting out the timeout.
async function waitForLoad(tabId, timeout = 25000) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') return;
  } catch { return; }

  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); resolve();
    };
    const listener = (id, info) => { if (id === tabId && info.status === 'complete') finish(); };
    const timer = setTimeout(finish, timeout);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function runInTab(tabId, func, args) {
  const opts = { target: { tabId }, func };
  if (args !== undefined) opts.args = [args];   // must be JSON-serializable
  const [res] = await chrome.scripting.executeScript(opts);
  return res ? res.result : null;
}

async function closeTab(tabId) {
  try { await chrome.tabs.remove(tabId); } catch {}
}

async function humanScroll(tabId) {
  try { await chrome.scripting.executeScript({ target: { tabId }, func: humanScrollFn }); } catch {}
}

/* ------------------------- injected page scrapers ----------------------- */
/* These run in the page context (serialized by executeScript) — keep them
 * fully self-contained, no references to outer scope. */

/* Returns a status, not a bare list: `pending` (nothing rendered yet) must stay
 * distinct from `empty` (Upwork says there are genuinely no results), or a page
 * that is still loading behind an interstitial ends the sweep as a success. */
function scrapeSearchPage() {
  const txt = document.body ? document.body.innerText : '';

  const seen = new Set(), out = [];
  document.querySelectorAll('a[href*="~"]').forEach(a => {
    const href = a.getAttribute('href') || '';
    const m = href.match(/~([0-9a-z]{8,})/i);
    if (!m) return;
    const id = '~' + m[1];
    if (seen.has(id)) return;
    seen.add(id);
    let name = '';
    const tile = a.closest('section, article, [data-test*="Tile"], [data-test*="Card"], div');
    const nameEl = (tile && tile.querySelector('[itemprop="name"], h3, h4')) || a;
    name = (nameEl.textContent || '').replace(/\s+/g, ' ').trim();

    // Country off the tile lets the country filter run before a profile tab is
    // ever opened. Walk up only while the ancestor still holds this one
    // candidate — one level too far and every row inherits the first row's
    // country, which would skip the wrong people.
    let country = '';
    let node = a;
    for (let i = 0; i < 8 && node.parentElement; i++) {
      node = node.parentElement;
      const ids = new Set();
      node.querySelectorAll('a[href*="~"]').forEach(link => {
        const mm = (link.getAttribute('href') || '').match(/~([0-9a-z]{8,})/i);
        if (mm) ids.add(mm[1]);
      });
      if (ids.size > 1) break;                       // now spanning several tiles
      const c = node.querySelector('[itemprop="country-name"]');
      if (c) { country = (c.textContent || '').replace(/\s+/g, ' ').trim(); break; }
    }

    out.push({ id, name, country, profileUrl: 'https://www.upwork.com/freelancers/' + id });
  });

  // Candidates rendering means whatever was in the way has cleared.
  if (out.length) return { status: 'ok', candidates: out, url: location.href };

  const captcha = /Pardon Our Interruption|Verifying you are human|Just a moment|verify you are human|checking your browser|review the security of your connection/i.test(txt)
    || !!document.querySelector('#px-captcha, iframe[src*="captcha"], iframe[title*="challenge"]');
  if (captcha) return { status: 'blocked', candidates: [], url: location.href };

  // Only an explicit marker ends the sweep. An empty DOM is far more often a
  // page that hasn't rendered yet than the real end of the results.
  const noResults = /no results found|we couldn't find any|didn't match any|no freelancers (were )?found|0 freelancers|try adjusting your (search|filters)|broaden your search/i.test(txt);
  if (noResults) return { status: 'empty', candidates: [], url: location.href };

  return { status: 'pending', candidates: [], url: location.href, sample: txt.slice(0, 400) };
}

function scrapeProfile() {
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();

  // Find the container of the section whose heading matches `re`. Upwork uses h5
  // for most profile section headings (Languages, Verifications, Education) and
  // h4 for a few — omitting h5/h6 here silently emptied the education list.
  const sectionByHeading = re => {
    const heads = document.querySelectorAll('h2, h3, h4, h5, h6, [data-qa$="-title"], [role="presentation"]');
    for (const h of heads) {
      if (re.test(clean(h.textContent))) return h.closest('section, .air3-card-section, div') || h.parentElement;
    }
    return null;
  };

  const txt = document.body ? document.body.innerText : '';
  const blocked = /Pardon Our Interruption|Verifying you are human|Just a moment|verify you are human/i.test(txt)
    || !!document.querySelector('#px-captcha, iframe[src*="captcha"], iframe[title*="challenge"]');
  if (blocked) return { blocked: true, url: location.href };

  let name = '';
  const nameEl = document.querySelector('h1[itemprop="name"], h2[itemprop="name"], [itemprop="name"]');
  if (nameEl) name = clean(nameEl.textContent);

  let title = '';
  // `.air3-card-section h2` on its own matches the *name* heading — it lives in
  // the same section — so the title has to exclude it.
  const titleEl = document.querySelector(
    '[data-qa="freelancer-title"], h2[data-qa="title"], .air3-card-section h2:not([itemprop="name"])');
  if (titleEl) title = clean(titleEl.textContent);

  let hourlyRate = '';
  const rm = txt.match(/\$\s?[\d,.]+\s*\/\s*hr/i);
  if (rm) hourlyRate = rm[0].replace(/\s+/g, '');

  // Summary stats pair a .stat-amount with its caption inside each .col-compact.
  // Read them by label — the columns are not in a guaranteed order.
  const statByLabel = re => {
    for (const col of document.querySelectorAll('.cfe-ui-profile-summary-stats .col-compact')) {
      const amount = col.querySelector('.stat-amount');
      if (amount && re.test(clean(col.textContent))) return clean(amount.textContent);
    }
    return '';
  };
  let earning = statByLabel(/total earnings/i);
  if (!earning) {   // fallback for layouts without the stats card
    const em = txt.match(/\$\s?[\d,.]+\s*[KMB]?\+?\s*(?:total\s+)?earn/i);
    if (em) { const mm = em[0].match(/\$\s?[\d,.]+\s*[KMB]?\+?/); if (mm) earning = mm[0].replace(/\s+/g, ''); }
  }

  // "99% Job Success". The progress ring also encodes it as a class
  // (air3-progress-circle-99), which survives the label text changing.
  let jss = '';
  const jssEl = document.querySelector('.cfe-ui-profile-job-success');
  let m = jssEl && clean(jssEl.textContent).match(/(\d+)\s*%/);
  if (!m && jssEl) {
    for (const el of jssEl.querySelectorAll('[class]')) {
      // getAttribute, not .className — these are SVG nodes.
      const cm = (el.getAttribute('class') || '').match(/air3-progress-circle-(\d+)/);
      if (cm) { m = [null, cm[1]]; break; }
    }
  }
  if (m) jss = m[1] + '%';

  // Scoped to the badge element. The page also carries an explainer popover
  // reading "Top Rated Plus talent is highly rated…", and a freelancer's own
  // overview can name the badges, so matching body text false-positives.
  let badge = '';
  const badgeEl = document.querySelector('.vetted-rated-badges .air3-badge-tagline, .vetted-rated-badges');
  const badgeTxt = badgeEl ? clean(badgeEl.textContent) : '';
  if (/top rated plus/i.test(badgeTxt)) badge = 'Top Rated Plus';
  else if (/top rated/i.test(badgeTxt)) badge = 'Top Rated';
  else if (/rising talent/i.test(badgeTxt)) badge = 'Rising Talent';

  let country = '';
  const cEl = document.querySelector('[itemprop="country-name"]');
  if (cEl) country = clean(cEl.textContent);

  // Education: school lines are the ones without a year range or degree prefix.
  const education = [];
  const eduSec = document.querySelector('[data-qa="education"], [data-cy="education"], .education-section')
    || sectionByHeading(/^education$/i);
  if (eduSec) {
    const lines = (eduSec.innerText || '').split('\n').map(clean)
      .filter(l => l && !/^education$/i.test(l));
    let pending = null;
    for (const line of lines) {
      const isDetail = /\b(19|20)\d{2}\b/.test(line)
        || /^(bachelor|master|associate|doctor|ph\.?d|b\.?s|m\.?s|b\.?a|m\.?a|mba|bsc|msc|diploma|certificate)/i.test(line);
      if (isDetail) { if (pending) pending.detail = line; }
      else { pending = { school: line, detail: '' }; education.push(pending); }
    }
  }

  const skills = [];
  const seenSkill = new Set();
  document.querySelectorAll('[data-qa="skill"], .air3-token, .skill-name, [data-test="Skill"]').forEach(el => {
    const s = clean(el.textContent);
    if (s && s.length < 40 && !seenSkill.has(s.toLowerCase())) { seenSkill.add(s.toLowerCase()); skills.push(s); }
  });

  // Presence check only, and scoped to the linked-accounts block — searching the
  // whole document for a span reading "github" matches skill tags and portfolio text.
  let hasGithub = false;
  const linked = document.querySelector('[data-qa="linked-accounts"]') || sectionByHeading(/^linked accounts$/i);
  if (linked) {
    for (const t of linked.querySelectorAll('.title, span, a')) {
      if (/^\s*github\s*$/i.test(t.textContent)) { hasGithub = true; break; }
    }
    if (!hasGithub && linked.querySelector('a[href*="github.com"]')) hasGithub = true;
  }

  return {
    blocked: false, name, title, country, hourlyRate, jss, badge, earning,
    education, skills: skills.slice(0, 15), hasGithub, url: location.href
  };
}

/* Injected: the two "recent activity" dates out of the work-history section —
 * when the freelancer last finished a contract, and when they were last hired.
 *
 * "Completed jobs" and "In progress" are separate tabs rendering separate
 * lists, so whichever one is inactive is not in the DOM at all and has to be
 * clicked before it can be read. Dates are taken as the max over every visible
 * entry rather than the first one, because the section has a sort toggle and
 * position can't be trusted. */
async function scrapeWorkHistoryFn() {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();

  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
                   jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const toIso = (mon, day, year) => {
    const m = MONTHS[(mon || '').slice(0, 3).toLowerCase()];
    return m ? `${year}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}` : '';
  };

  // "Aug 5, 2026 - Aug 21, 2026"  |  "Aug 21, 2026 - Present"
  const RANGE = /([A-Z][a-z]{2,8})\s+(\d{1,2}),\s*(\d{4})\s*[-–]\s*(?:([A-Z][a-z]{2,8})\s+(\d{1,2}),\s*(\d{4})|Present)/g;

  const section = document.querySelector('.work-history-section, .work-history')
    || Array.from(document.querySelectorAll('section'))
        .find(s => /work history/i.test(clean(s.textContent).slice(0, 200)));
  if (!section) return { completedEnd: '', hiredStart: '' };

  let completedEnd = '', hiredStart = '';

  const harvest = () => {
    const text = section.innerText || '';
    RANGE.lastIndex = 0;
    let m;
    while ((m = RANGE.exec(text)) !== null) {
      if (m[4]) {
        const iso = toIso(m[4], m[5], m[6]);   // has an end date -> contract finished
        if (iso > completedEnd) completedEnd = iso;
      } else {
        const iso = toIso(m[1], m[2], m[3]);   // "- Present" -> still running, so this is the hire date
        if (iso > hiredStart) hiredStart = iso;
      }
    }
  };

  harvest();

  // Deepest element whose text is just the tab label; the click bubbles to
  // whichever ancestor Vue bound the handler to.
  const tabFor = re => {
    const hits = Array.from(section.querySelectorAll('button, a, [role="tab"], li, div, span'))
      .filter(el => { const t = clean(el.textContent); return re.test(t) && t.length < 40; });
    return hits[hits.length - 1] || null;
  };

  const pending = [
    [/^completed jobs/i, () => completedEnd],
    [/^in progress/i, () => hiredStart],
  ];
  for (const [re, value] of pending) {
    if (value()) continue;                     // that tab was already the open one
    const tab = tabFor(re);
    if (!tab) continue;
    tab.click();
    for (let i = 0; i < 12; i++) {
      await sleep(400);
      harvest();
      if (value()) break;
    }
  }

  return { completedEnd, hiredStart };
}

// Injected: one pass to the bottom and back before scraping — enough to look
// like a visitor and to force the below-the-fold sections to lay out.
async function humanScrollFn() {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const bottom = () => Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
  window.scrollTo(0, bottom());
  await sleep(500);
  window.scrollTo(0, 0);
}

/* -------------------------------- sink ---------------------------------- */

async function postToSink(endpoint, payload) {
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return res.ok;
  } catch (e) {
    await pushLog('POST failed: ' + e, 'error');
    return false;
  }
}

/* ------------------------------ orchestration --------------------------- */

// Dolphin Anty rejects creating a *foreground* tab from a cold service worker
// ("Onboarding tab should not be opened at startup"). Workana's working pattern:
// create the tab in the background, then activate it separately. We do the same.
async function createProfileTab(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  try { await chrome.tabs.update(tab.id, { active: true }); } catch {}  // bring forward to watch
  return tab.id;
}

// Search pages don't need watching — keep that tab in the background and reuse it.
async function ensureSearchTab(url) {
  if (S.searchTabId != null) {
    try {
      await chrome.tabs.get(S.searchTabId);
      await chrome.tabs.update(S.searchTabId, { url });
      return S.searchTabId;
    } catch { S.searchTabId = null; }
  }
  const tab = await chrome.tabs.create({ url, active: false });
  S.searchTabId = tab.id;
  return tab.id;
}

/* ---------------------------- ContactOut tab ---------------------------- */
/* The API is a paid tier, so the dashboard is driven in a real logged-in tab.
 * One tab is reused for the whole run; each search reloads it so the React form
 * starts from a clean state (the in-page "Clear all" is clicked as well). */

async function ensureContactOutTab() {
  if (S.coTabId != null) {
    try { await chrome.tabs.get(S.coTabId); return S.coTabId; }
    catch { S.coTabId = null; }
  }
  const tab = await chrome.tabs.create({ url: CO_SEARCH_URL, active: false });
  S.coTabId = tab.id;
  await waitForLoad(tab.id);
  await sleep(4000);   // SPA settle
  return tab.id;
}

// One query: hand it over in the URL, and only fall back to driving the form if
// the dashboard loads that URL without actually running the search.
async function coSearchOnce(cfg, profile, filters) {
  const tabId = await ensureContactOutTab();
  const url = buildSearchUrl(profile.firstName, filters);

  // Logged in full so a filter that silently fails to narrow is visible, and so
  // the same query can be pasted into a browser to compare.
  await pushLog(`  query: ${url}`);

  await chrome.tabs.update(tabId, { url });
  await waitForLoad(tabId);
  await sleep(3000);

  let out = await runInTab(tabId, scrapeResultsFn, cfg.maxCandidates);

  if (out && out.status === 'not-searched') {
    await pushLog('  ContactOut ignored the URL query — pressing Search instead.', 'warn');
    const filled = await runInTab(tabId, fillSearchFormFn, {
      firstName: profile.firstName,
      schools: filters.school ? [filters.school] : [],
    });
    if (!filled || !filled.ok) {
      throw new PauseRun(`ContactOut search could not be submitted (${(filled && filled.error) || 'no result'}) — is the dashboard logged in?`);
    }
    out = await runInTab(tabId, scrapeResultsFn, cfg.maxCandidates);
  }

  if (!out) throw new Error('ContactOut results scrape returned nothing');
  if (out.status === 'quota') throw new PauseRun('ContactOut credits exhausted or upgrade required');
  if (out.status === 'not-searched') throw new PauseRun('ContactOut never ran the search');
  if (out.status === 'unknown') {
    // Card layout changed — surface a sample rather than guessing at selectors.
    await pushLog('ContactOut results not recognised — see the SW console for a DOM sample.', 'error');
    console.log('[ContactOut debugSample]', out.debugSample);
    throw new PauseRun('ContactOut results DOM not recognised');
  }
  return out;
}

/* A first name plus a country is nowhere near enough — "Anna" in Ukraine is
 * 53,715 people. So the query starts as narrow as the Upwork profile allows and
 * widens only when a tier comes back empty, because ContactOut's school and
 * job-title taxonomies won't always match Upwork's wording and a filter that
 * matches nothing excludes the very person being looked for. */
/* Upwork's school wording is not ContactOut's. Feed it through the School/Degree
 * autocomplete to get the taxonomy's own name for it — an unrecognised value is
 * either ignored or matches nothing, and either way the filter stops helping.
 * Cached because schools repeat heavily across a sweep and each lookup is a
 * couple of seconds of typing and polling. */
const schoolCache = new Map();

async function resolveSchool(upworkSchool) {
  const key = upworkSchool.toLowerCase().trim();
  if (schoolCache.has(key)) return schoolCache.get(key);

  let canonical = '';
  try {
    const tabId = await ensureContactOutTab();
    const out = await runInTab(tabId, lookupSchoolFn, upworkSchool);
    canonical = bestSchoolMatch(upworkSchool, (out && out.options) || []);
  } catch (e) {
    await pushLog(`  school lookup failed for "${upworkSchool}": ${e}`, 'warn');
  }

  if (canonical && canonical.toLowerCase() !== key) {
    await pushLog(`  school "${upworkSchool}" → "${canonical}".`);
  } else if (!canonical) {
    await pushLog(`  ContactOut has no school matching "${upworkSchool}" — searching without it.`, 'warn');
  }

  schoolCache.set(key, canonical);
  return canonical;
}

async function coSearchViaTab(cfg, profile) {
  const upworkSchool = (profile.education[0] || {}).school || '';
  const school = upworkSchool ? await resolveSchool(upworkSchool) : '';
  const location = profile.country || '';
  const title = profile.title || '';

  const tiers = [];
  if (school && title) tiers.push({ school, title, location });
  if (school) tiers.push({ school, location });
  if (title) tiers.push({ title, location });
  tiers.push({ location });

  let out = null;
  for (const filters of tiers) {
    out = await coSearchOnce(cfg, profile, filters);
    if (out.status !== 'empty') break;
    await pushLog('  no results at that filter level — widening.', 'warn');
  }

  // Still hopeless on the widest useful tier. The last initial is the only
  // signal left, and it only costs a page load in cases already being skipped.
  if (out.total > MAX_SEARCH_TOTAL && profile.lastInitial) {
    await pushLog(`  ${out.total} matches — retrying with surname initial "${profile.lastInitial}".`, 'warn');
    const narrowed = await coSearchOnce(cfg, profile, {
      ...tiers[0], surnameInitial: profile.lastInitial
    });
    if (narrowed.status === 'ok' && narrowed.total && narrowed.total <= MAX_SEARCH_TOTAL) {
      out = narrowed;
    }
  }

  const read = (out.results || []).length;
  if (out.total > read) {
    await pushLog(`  "${profile.firstName}" matched ${out.total} profiles — reading the first ${read}.`, 'warn');
  }

  // Past this point the filters plainly aren't biting. Matching a couple of
  // dozen arbitrary rows out of tens of thousands can't succeed, and every
  // attempt costs an OpenAI call — report it rather than guessing.
  if (out.total > MAX_SEARCH_TOTAL) {
    return { all: [], kept: [], tooBroad: true, total: out.total };
  }

  const all = normalize(out.results || []);
  return { all, kept: filterByLastInitial(all, profile.lastInitial), total: out.total };
}

async function coRevealViaTab(match) {
  const tabId = await ensureContactOutTab();
  const out = await runInTab(tabId, revealEmailFn, match.linkedin);
  if (!out) return '';
  if (out.status === 'quota') throw new PauseRun('ContactOut credits exhausted');
  return out.status === 'ok' ? out.email : '';
}

/* Poll rather than snapshot. Upwork puts a "verifying you are human"
 * interstitial in front of the search page that usually clears itself after a
 * few seconds, and the Vue list renders after that — a single read at a fixed
 * delay sees an empty DOM and used to end the whole sweep as a success.
 *
 * Only `empty` ends the sweep; running out of time yields `blocked` (if an
 * interstitial was seen, so the user can solve it) or `error` (so the page
 * stays resumable). */
async function loadPage(cfg, page) {
  const url = withPage(cfg.searchUrl, page);
  await pushLog(`Loading search page ${page}…`);

  let tabId;
  try {
    tabId = await ensureSearchTab(url);
    await waitForLoad(tabId);
  } catch (e) {
    await pushLog('Search tab failed: ' + e, 'error');
    return { status: 'error', candidates: [] };
  }

  await sleep(2500);   // let the first paint happen before the first read

  const deadline = Date.now() + SEARCH_MAX_WAIT_MS;
  let sawCaptcha = false, last = null;

  while (Date.now() < deadline) {
    try { last = await runInTab(tabId, scrapeSearchPage); }
    catch (e) { last = null; }

    if (last && last.status === 'ok') {
      await pushLog(`Page ${page}: found ${last.candidates.length} candidates.`);
      return { status: 'ok', candidates: last.candidates };
    }
    if (last && last.status === 'empty') {
      return { status: 'empty', candidates: [] };
    }
    if (last && last.status === 'blocked' && !sawCaptcha) {
      sawCaptcha = true;
      await pushLog('  interstitial on search page — waiting for it to clear…', 'warn');
    }
    await sleep(SEARCH_POLL_MS);
  }

  if (sawCaptcha) return { status: 'blocked', candidates: [] };

  // Rendered nothing recognisable and never said "no results" — don't guess.
  await pushLog(`Page ${page}: nothing rendered after ${Math.round(SEARCH_MAX_WAIT_MS / 1000)}s.`, 'error');
  if (last && last.sample) console.log('[search page sample]', last.sample);
  return { status: 'error', candidates: [] };
}

/* Requires `name` AND a late-rendering section before accepting a scrape —
 * keying on `name` alone returns on first paint. Also keeps polling through an
 * interstitial rather than pausing on sight of one: the same self-clearing
 * challenge that fronts the search page fronts profiles too. */
async function scrapeProfileWithRetry(tabId) {
  const deadline = Date.now() + PROFILE_MAX_WAIT_MS;
  let last = null, warned = false;

  while (Date.now() < deadline) {
    try { last = await runInTab(tabId, scrapeProfile); }
    catch (e) { last = null; }

    if (last && !last.blocked && last.name
        && ((last.education || []).length || (last.skills || []).length)) {
      return last;
    }
    if (last && last.blocked && !warned) {
      warned = true;
      await pushLog('  interstitial on profile — waiting for it to clear…', 'warn');
    }
    await sleep(2500);
  }
  return last;   // may still be {blocked:true}; the caller pauses and keeps the tab
}

function captchaPause() {
  S.status = 'paused';
  S.captcha = true;
  setBadge(true);
}

async function pauseForQuota(msg) {
  await pushLog(`⚠️ ${msg} — pausing. Fix it, then click Resume.`, 'warn');
  S.status = 'paused';
  setBadge(false);
}

/* Returns true when the candidate was handled (advance the queue), false when
 * the run paused mid-candidate and it must be retried on Resume. */
async function processCandidate(cfg, cand) {
  S.current = cand.name || cand.id;

  // Cheapest possible skip: the search tile already carried the country, so
  // don't spend a tab load and a scrape on someone who is filtered out anyway.
  // (Absent on tiles that don't expose it — those fall through to the scrape.)
  if (cand.country && SKIP_COUNTRIES.indexOf(cand.country.toLowerCase()) !== -1) {
    await pushLog(`⏭ ${cand.name || cand.id}: ${cand.country} — skipped from search page.`);
    return true;
  }

  await pushLog(`▶ ${cand.name || cand.id} — opening profile…`);

  // Reuse a tab left open for captcha solving; otherwise open a fresh one.
  let tabId = S.profileTabId;
  if (tabId != null) {
    S.profileTabId = null;
    try {
      await chrome.tabs.get(tabId);
      await waitForLoad(tabId, 8000);
      // Solving a captcha can land the tab somewhere else entirely; scraping it
      // then reads the wrong page and silently drops the candidate.
      const t = await chrome.tabs.get(tabId);
      if (!t.url || !t.url.includes(cand.id)) {
        await chrome.tabs.update(tabId, { url: cand.profileUrl });
        await waitForLoad(tabId);
        await sleep(3000);
      }
    } catch { tabId = null; }
  }
  if (tabId == null) {
    tabId = await createProfileTab(cand.profileUrl);
    await waitForLoad(tabId);
    await sleep(3000);
  }

  await humanScroll(tabId);  // look like a real visitor before scraping

  let keepOpen = false;
  try {
    const data = await scrapeProfileWithRetry(tabId);
    if (!data) {
      await pushLog(`— ${cand.name || cand.id}: profile scrape failed.`, 'error');
      return true;
    }
    if (data.blocked) {
      await pushLog('⚠️ CAPTCHA on profile — solve it in the open tab, then click Resume.', 'warn');
      keepOpen = true; S.profileTabId = tabId; captchaPause();
      return false;
    }

    const display = data.name || cand.name || '';
    const label = display || cand.id;

    if (data.country && SKIP_COUNTRIES.indexOf(data.country.toLowerCase()) !== -1) {
      await pushLog(`⏭ ${label}: ${data.country} — skipped.`);
      return true;
    }
    if (cfg.skipIfGithub && data.hasGithub) {
      await pushLog(`⏭ ${label}: has a linked GitHub account — skipped.`);
      return true;
    }

    const { firstName, lastInitial } = splitName(display);
    if (!firstName) {
      await pushLog(`— ${label}: no usable first name.`);
      return true;
    }
    // First name alone is far too broad without something to narrow on.
    if (!data.education.length && !data.title) {
      await pushLog(`— ${label}: no education or title to search on — skipped.`);
      return true;
    }

    const profile = {
      firstName, lastInitial,
      country: data.country,
      title: data.title,
      education: data.education,
      skills: data.skills,
    };

    const { all, kept, tooBroad, total } = await coSearchViaTab(cfg, profile);
    if (tooBroad) {
      await pushLog(`— ${label}: ${total} ContactOut matches for "${firstName}" — too broad to identify, skipped.`, 'warn');
      return true;
    }
    if (!all.length) {
      await pushLog(`— ${label}: no ContactOut results for "${firstName}".`);
      return true;
    }
    if (!kept.length) {
      await pushLog(`— ${label}: ${all.length} results, none with surname "${lastInitial}".`);
      return true;
    }

    const pool = kept.slice(0, cfg.maxCandidates);
    if (kept.length > pool.length) {
      await pushLog(`  ${label}: ${kept.length} survivors, evaluating first ${pool.length}.`, 'warn');
    }

    let verdict = deterministicMatch(profile, pool);
    if (!verdict) verdict = await aiMatch(cfg, profile, pool);

    if (!verdict || verdict.index < 0 || !pool[verdict.index]) {
      await pushLog(`— ${label}: no confident match (${(verdict && verdict.reason) || 'no matcher configured'}).`);
      return true;
    }
    if (verdict.confidence < cfg.matchThreshold) {
      await pushLog(`— ${label}: best match ${verdict.confidence}% < ${cfg.matchThreshold}% — rejected.`);
      return true;
    }

    const winner = pool[verdict.index];
    // Checked after matching, not before: dropping email-less cards from the pool
    // first would let a confident match land on the wrong person instead.
    if (!winner.hasEmail) {
      await pushLog(`— ${label} → ${winner.fullName}: matched, but ContactOut lists no email.`);
      return true;
    }

    const email = await coRevealViaTab(winner);
    if (!email) {
      await pushLog(`— ${label} → ${winner.fullName}: matched, but no email available.`);
      return true;
    }

    // Only worth the tab-clicking for candidates actually being saved.
    let activity = { completedEnd: '', hiredStart: '' };
    try { activity = (await runInTab(tabId, scrapeWorkHistoryFn)) || activity; }
    catch (e) { await pushLog(`  work history unreadable for ${label}: ${e}`, 'warn'); }

    const payload = {
      upwork_name: display,
      upwork_profile_link: cand.profileUrl,
      linkedin_profile_link: winner.linkedin,
      email_address: email,
      full_name: winner.fullName,
      education: data.education.map(e => e.school).join('; '),
      match_confidence: String(verdict.confidence),
      match_source: verdict.source,
      email_verified: winner.verified ? 'Verified' : '',
      job_success_score: data.jss,
      badge: data.badge,
      hourly_rate: data.hourlyRate,
      total_earning: data.earning,
      last_completed_end: activity.completedEnd,   // latest finished contract
      last_hired_start: activity.hiredStart        // latest still-running contract
    };
    const ok = await postToSink(cfg.postEndpoint, payload);
    if (ok) S.emails++;
    await pushLog(
      `✅ ${display} → ${email}  (${winner.fullName}, ${verdict.confidence}% via ${verdict.source})${ok ? '' : '  [POST failed]'}`,
      'ok');
    return true;

  } catch (e) {
    if (shouldPause(e)) {
      keepOpen = true; S.profileTabId = tabId;
      await pauseForQuota(String(e.message || e));
      return false;
    }
    await pushLog(`Error on ${cand.name || cand.id}: ${e}`, 'error');
    return true;
  } finally {
    if (!keepOpen) await closeTab(tabId);
  }
}

async function drive() {
  if (driving) return;
  driving = true;
  setBadge(false);
  try {
    const cfg = await loadConfig();
    while (S.status === 'running') {
      if (S.queueIndex >= S.queue.length) {
        const res = await loadPage(cfg, S.page);
        if (S.status !== 'running') break;
        if (res.status === 'blocked') {
          await pushLog('⚠️ CAPTCHA on search page did not clear on its own — solve it, then click Resume.', 'warn');
          captchaPause();
          break;
        }
        if (res.status === 'error') {
          // Not the same as an empty page — stay resumable on this page.
          await pauseForQuota(`Search page ${S.page} never rendered`);
          break;
        }
        if (res.status === 'empty') {
          await pushLog('No candidates on this page — sweep complete.', 'ok');
          S.status = 'idle'; S.current = ''; setBadge(false); break;
        }
        S.queue = res.candidates; S.queueIndex = 0; S.page++;
        await persistState();
      }

      const cand = S.queue[S.queueIndex];
      // `handled` — not the run status — decides whether the queue advances, so
      // pausing after a finished candidate no longer re-runs it on Resume.
      const handled = await processCandidate(cfg, cand);
      if (handled) { S.processed++; S.queueIndex++; }
      await persistState();
      if (S.status !== 'running') break;

      await sleep(randDelay(cfg));
      if (S.status !== 'running') break;
    }
  } catch (e) {
    await pushLog('Run error: ' + e, 'error');
    S.status = 'paused';
  } finally {
    driving = false;
    await persistState();
  }
}

/* ------------------------------- commands ------------------------------- */

async function cmdStart() {
  const cfg = await loadConfig();
  if (!cfg.searchUrl) { await pushLog('Set a search URL first.', 'error'); return; }

  // Orphaned tabs from a previous run would otherwise pile up.
  if (S.searchTabId != null) await closeTab(S.searchTabId);
  if (S.profileTabId != null) await closeTab(S.profileTabId);
  if (S.coTabId != null) await closeTab(S.coTabId);

  S = {
    status: 'running', captcha: false,
    page: parsePage(cfg.searchUrl),
    queue: [], queueIndex: 0,
    searchTabId: null, profileTabId: null, coTabId: null,
    processed: 0, emails: 0, current: ''
  };
  await pushLog('Log in to contactout.com in this browser before starting.', 'info');
  await pushLog(`Start — search from page ${S.page}.`, 'ok');
  await persistState();
  drive();
}

async function cmdPause() {
  if (S.status === 'running') { S.status = 'paused'; setBadge(S.captcha); await pushLog('Paused.', 'warn'); await persistState(); }
}

async function cmdResume() {
  if (S.status === 'paused') {
    S.status = 'running'; S.captcha = false; setBadge(false);
    await pushLog('Resumed.', 'ok'); await persistState();
    drive();
  }
}

async function cmdStop() {
  S.status = 'idle'; S.captcha = false; S.queue = []; S.queueIndex = 0; S.current = '';
  if (S.searchTabId != null) { await closeTab(S.searchTabId); S.searchTabId = null; }
  if (S.profileTabId != null) { await closeTab(S.profileTabId); S.profileTabId = null; }
  if (S.coTabId != null) { await closeTab(S.coTabId); S.coTabId = null; }
  setBadge(false); await pushLog('Stopped.', 'warn'); await persistState();
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg && msg.cmd) {
      case 'getState': {
        const cfg = await loadConfig();
        const o = await chrome.storage.local.get(STORE.log);
        sendResponse({ state: publicState(), config: cfg, log: o[STORE.log] || [] });
        return;
      }
      case 'saveConfig': { const c = await saveConfig(msg.config); sendResponse({ config: c }); return; }
      case 'start': await cmdStart(); sendResponse({ ok: true }); return;
      case 'pause': await cmdPause(); sendResponse({ ok: true }); return;
      case 'resume': await cmdResume(); sendResponse({ ok: true }); return;
      case 'stop': await cmdStop(); sendResponse({ ok: true }); return;
      case 'clearLog': await chrome.storage.local.set({ [STORE.log]: [] }); broadcast(); sendResponse({ ok: true }); return;
      default: sendResponse({ ok: false });
    }
  })();
  return true; // async response
});

// Keepalive: an alarm tick wakes the SW so short inter-candidate delays don't
// let it die mid-sweep. (Long captcha pauses may still sleep the SW; Resume re-kicks.)
chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => { if (S.status === 'running' && !driving) drive(); });

chrome.runtime.onStartup.addListener(restoreState);
restoreState();
