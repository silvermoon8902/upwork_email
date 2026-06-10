/* ============================================================================
 * Upwork → GitHub Email Harvester — background service worker (orchestrator)
 *
 * Flow:
 *   1. Take the saved search URL; start page = its `page` param (default 1).
 *   2. Navigate a reusable search tab to that page; scrape candidate ~ids + names.
 *   3. For each candidate: open the profile in a real, visible tab; scrape name,
 *      job success, badge, hourly rate, total earning, and the GitHub avatar's
 *      numeric id from "Linked accounts".
 *   4. Resolve GitHub: api.github.com/user/<id> -> login + public email.
 *      If no public email -> dig commit author emails from public events / repos,
 *      filtering out *noreply.github.com.
 *   5. If a real email is found -> POST the payload to the sink (Apps Script).
 *   6. Auto-advance pages until a page yields no candidates.
 *
 * Start / Pause / Resume. Captcha auto-pauses (solve in the tab, then Resume).
 * ==========================================================================*/

const STORE = { config: 'hv_config', state: 'hv_state', log: 'hv_log' };

const DEFAULT_CONFIG = {
  searchUrl: '',
  githubToken: '',
  postEndpoint: 'https://script.google.com/macros/s/AKfycbwG_SXJPo_dn0FJQchDxGJOgYtNqgnsk98drSgRJfxhz3BS3RgjVcY-g2b3OyonhqwecQ/exec',
  minDelayMs: 4000,
  maxDelayMs: 10000
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
function isNoreply(email) {
  return /noreply\.github\.com$/i.test(email || '');
}

async function waitForLoad(tabId, timeout = 25000) {
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

async function runInTab(tabId, func) {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func });
    return res ? res.result : null;
  } catch (e) {
    return { error: String(e) };
  }
}

async function closeTab(tabId) {
  try { await chrome.tabs.remove(tabId); } catch {}
}

/* ------------------------- injected page scrapers ----------------------- */
/* These run in the page context (serialized by executeScript) — keep them
 * fully self-contained, no references to outer scope. */

function scrapeSearchPage() {
  const txt = document.body ? document.body.innerText : '';
  const blocked = /Pardon Our Interruption|Verifying you are human|Just a moment|verify you are human/i.test(txt)
    || !!document.querySelector('#px-captcha, iframe[src*="captcha"], iframe[title*="challenge"]');

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
    out.push({ id, name, profileUrl: 'https://www.upwork.com/freelancers/' + id });
  });
  return { blocked, candidates: out, url: location.href };
}

function scrapeProfile() {
  const txt = document.body ? document.body.innerText : '';
  const blocked = /Pardon Our Interruption|Verifying you are human|Just a moment|verify you are human/i.test(txt)
    || !!document.querySelector('#px-captcha, iframe[src*="captcha"], iframe[title*="challenge"]');
  if (blocked) return { blocked: true };

  let name = '';
  const nameEl = document.querySelector('h1[itemprop="name"], h2[itemprop="name"], [itemprop="name"]');
  if (nameEl) name = nameEl.textContent.replace(/\s+/g, ' ').trim();

  let hourlyRate = '';
  const rm = txt.match(/\$\s?[\d,.]+\s*\/\s*hr/i);
  if (rm) hourlyRate = rm[0].replace(/\s+/g, '');

  let jss = '';
  const jssEl = document.querySelector('.cfe-ui-profile-job-success');
  let m = jssEl && jssEl.textContent.match(/(\d+)\s*%/);
  if (!m) m = txt.match(/(\d+)\s*%\s*Job Success/i);
  if (m) jss = m[1] + '%';

  let badge = '';
  if (/Top Rated Plus/i.test(txt)) badge = 'Top Rated Plus';
  else if (/Top Rated/i.test(txt)) badge = 'Top Rated';
  else if (/Rising Talent/i.test(txt)) badge = 'Rising Talent';

  let earning = '';
  const em = txt.match(/\$\s?[\d,.]+\s*[KMB]?\+?\s*(?:total\s+)?earn/i);
  if (em) { const mm = em[0].match(/\$\s?[\d,.]+\s*[KMB]?\+?/); if (mm) earning = mm[0].replace(/\s+/g, ''); }

  let github = null;
  const linked = document.querySelector('[data-qa="linked-accounts"]') || document;
  const titleEls = linked.querySelectorAll('.title, span');
  for (const t of titleEls) {
    if (!/^\s*github\s*$/i.test(t.textContent)) continue;
    const container = t.closest('.air3-grid-container') || t.parentElement;
    const img = container && container.querySelector('img');
    let numericId = null;
    if (img && img.src) { const mm = img.src.match(/\/u\/(\d+)/); if (mm) numericId = mm[1]; }
    const userEl = container && container.querySelector('.username');
    github = { numericId, username: userEl ? userEl.textContent.trim() : '' };
    break;
  }

  return { blocked: false, name, hourlyRate, jss, badge, earning, github, url: location.href };
}

/* ------------------------------ GitHub API ------------------------------ */

async function ghGet(url, token) {
  const headers = { 'Accept': 'application/vnd.github+json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(url, { headers });
  if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
    throw new Error('github-rate-limited');
  }
  if (!res.ok) throw new Error('github ' + res.status);
  return res.json();
}

async function resolveGithub(numericId, token) {
  const u = await ghGet('https://api.github.com/user/' + numericId, token);
  return { login: u.login, name: u.name, email: u.email, html_url: u.html_url };
}

function topEmail(counts) {
  let best = '', n = -1;
  for (const k in counts) if (counts[k] > n) { n = counts[k]; best = k; }
  return best;
}

async function findCommitEmail(login, token) {
  // 1) Public events (one call, usually enough).
  try {
    const ev = await ghGet(`https://api.github.com/users/${login}/events/public?per_page=100`, token);
    const counts = {};
    if (Array.isArray(ev)) for (const e of ev) {
      if (e.type === 'PushEvent' && e.payload && e.payload.commits) {
        for (const c of e.payload.commits) {
          const em = c.author && c.author.email;
          if (em && !isNoreply(em)) counts[em] = (counts[em] || 0) + 1;
        }
      }
    }
    const best = topEmail(counts);
    if (best) return best;
  } catch (e) { if (String(e).includes('rate-limited')) throw e; }

  // 2) Fallback: recent owned repos -> commits by this author.
  try {
    const repos = await ghGet(`https://api.github.com/users/${login}/repos?sort=pushed&per_page=5&type=owner`, token);
    if (Array.isArray(repos)) for (const r of repos) {
      if (r.fork) continue;
      try {
        const commits = await ghGet(`https://api.github.com/repos/${login}/${r.name}/commits?author=${login}&per_page=10`, token);
        if (Array.isArray(commits)) for (const c of commits) {
          const em = c.commit && c.commit.author && c.commit.author.email;
          if (em && !isNoreply(em)) return em;
        }
      } catch (e) { if (String(e).includes('rate-limited')) throw e; }
    }
  } catch (e) { if (String(e).includes('rate-limited')) throw e; }

  return '';
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

async function loadPage(cfg, page) {
  const url = withPage(cfg.searchUrl, page);
  await pushLog(`Loading search page ${page}…`);
  const tabId = await ensureSearchTab(url);
  await waitForLoad(tabId);
  await sleep(3500); // SPA settle
  const res = await runInTab(tabId, scrapeSearchPage);
  if (!res || res.error) { await pushLog('Search scrape error: ' + (res && res.error), 'error'); return { blocked: false, candidates: [] }; }
  if (res.blocked) return { blocked: true, candidates: [] };
  await pushLog(`Page ${page}: found ${res.candidates.length} candidates.`);
  return { blocked: false, candidates: res.candidates };
}

async function scrapeProfileWithRetry(tabId) {
  for (let i = 0; i < 4; i++) {
    const r = await runInTab(tabId, scrapeProfile);
    if (r && r.blocked) return r;
    if (r && (r.name || r.github)) return r;
    await sleep(2000);
  }
  return await runInTab(tabId, scrapeProfile);
}

function captchaPause() {
  S.status = 'paused';
  S.captcha = true;
  setBadge(true);
}

async function processCandidate(cfg, cand) {
  S.current = cand.name || cand.id;
  await pushLog(`▶ ${cand.name || cand.id} — opening profile…`);

  // Reuse a tab left open for captcha solving; otherwise open a fresh one.
  let tabId = S.profileTabId;
  if (tabId != null) {
    S.profileTabId = null;
    try { await chrome.tabs.get(tabId); await waitForLoad(tabId, 8000); }
    catch { tabId = null; }
  }
  if (tabId == null) {
    tabId = await createProfileTab(cand.profileUrl);
    await waitForLoad(tabId);
    await sleep(3000);
  }

  let keepOpen = false;
  try {
    const data = await scrapeProfileWithRetry(tabId);
    if (data && data.blocked) {
      await pushLog('⚠️ CAPTCHA on profile — solve it in the open tab, then click Resume.', 'warn');
      keepOpen = true; S.profileTabId = tabId; captchaPause();
      return;
    }

    const name = (data && data.name) || cand.name || '';
    if (!data || !data.github || !data.github.numericId) {
      await pushLog(`— ${name || cand.id}: no GitHub linked account.`);
      return;
    }

    let gh;
    try {
      gh = await resolveGithub(data.github.numericId, cfg.githubToken);
    } catch (e) {
      if (String(e).includes('rate-limited')) {
        await pushLog('⚠️ GitHub rate limit hit — pausing. Add/refresh a PAT, then Resume.', 'warn');
        keepOpen = true; S.profileTabId = tabId; S.status = 'paused'; setBadge(false);
        return;
      }
      await pushLog(`GitHub resolve failed for ${name}: ${e}`, 'error');
      return;
    }

    const githubLink = gh.html_url || ('https://github.com/' + gh.login);
    let email = (gh.email && !isNoreply(gh.email)) ? gh.email : '';
    if (!email) {
      try { email = await findCommitEmail(gh.login, cfg.githubToken); }
      catch (e) {
        if (String(e).includes('rate-limited')) {
          await pushLog('⚠️ GitHub rate limit hit — pausing. Add/refresh a PAT, then Resume.', 'warn');
          keepOpen = true; S.profileTabId = tabId; S.status = 'paused'; setBadge(false);
          return;
        }
      }
    }

    if (email && !isNoreply(email)) {
      const payload = {
        upwork_name: name,
        upwork_profile_link: cand.profileUrl,
        github_profile_link: githubLink,
        email_address: email,
        job_success_score: (data && data.jss) || '',
        badge: (data && data.badge) || '',
        hourly_rate: (data && data.hourlyRate) || '',
        total_earning: (data && data.earning) || ''
      };
      const ok = await postToSink(cfg.postEndpoint, payload);
      S.emails++;
      await pushLog(`✅ ${name} → ${email}  (${githubLink})${ok ? '' : '  [POST failed]'}`, 'ok');
    } else {
      await pushLog(`— ${name} (${gh.login}): no public/commit email found.`);
    }
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
        if (res.blocked) {
          await pushLog('⚠️ CAPTCHA on search page — solve it, then click Resume.', 'warn');
          captchaPause();
          break;
        }
        if (res.candidates.length === 0) {
          await pushLog('No candidates on this page — sweep complete.', 'ok');
          S.status = 'idle'; S.current = ''; setBadge(false); break;
        }
        S.queue = res.candidates; S.queueIndex = 0; S.page++;
        await persistState();
      }

      const cand = S.queue[S.queueIndex];
      await processCandidate(cfg, cand);
      if (S.status !== 'running') { await persistState(); break; }

      S.processed++; S.queueIndex++;
      await persistState();
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
  S = {
    status: 'running', captcha: false,
    page: parsePage(cfg.searchUrl),
    queue: [], queueIndex: 0,
    searchTabId: null, profileTabId: null,
    processed: 0, emails: 0, current: ''
  };
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
