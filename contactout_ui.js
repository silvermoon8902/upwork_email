/* ContactOut adapter — drives the dashboard UI in a real tab.
 *
 * The API is a paid tier, so instead of fetching we fill the search form the
 * same way the Upwork side works: keep one logged-in tab, inject a filler, read
 * the results back out.
 *
 * Everything exported as a *Fn is passed to chrome.scripting.executeScript and
 * runs in the page's world — keep them self-contained (nested helpers only, no
 * module scope). They receive plain JSON via executeScript's `args`.
 *
 * Anchoring note: react-select generates sequential ids (react-select-17-input)
 * that shift whenever the form's field count changes — collapsing an "Advanced"
 * section is enough. Every form selector below anchors on the field's <label>
 * text instead. Result cards anchor on data-testid and svg viewBox, both of
 * which survive the emotion class hashes (css-9w0zfn, css-1o52pgu…) rotating on
 * every ContactOut deploy. Never select on those.                             */

export const CO_SEARCH_URL = 'https://contactout.com/dashboard/search';

/* The dashboard drives its search off query params — running one by hand lands on
 *   /dashboard/search?nm=Edwin&page=1&school=Full%20Sail%20University
 * so the query can be handed over in the URL instead of typed into react-select.
 * `nm` is the Name field, `school` is School/Degree.
 *
 * `location` is inferred from the form's hidden <input name="location"> — the
 * other params match their field names exactly, so it very likely does too, but
 * it is the one param here not confirmed against a real URL. The search URL is
 * logged on every query: if `total` doesn't drop when a location is present,
 * this is the param to check first. */
export function buildSearchUrl(firstName, opts) {
  const o = opts || {};
  const u = new URL(CO_SEARCH_URL);
  // Upwork hides surnames, but appending the initial it *does* expose is the
  // last narrowing signal available when a first name alone is hopeless.
  u.searchParams.set('nm', o.surnameInitial ? `${firstName} ${o.surnameInitial}` : firstName);
  u.searchParams.set('page', String(o.page || 1));
  if (o.school) u.searchParams.set('school', o.school);
  if (o.location) u.searchParams.set('location', o.location);
  return u.toString();
}

/* --------------------------- injected: fill form ------------------------- */

/** args: { firstName, schools: string[] } -> { ok, error?, schoolsApplied } */
export async function fillSearchFormFn(query) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // React tracks its own value on the DOM node; a plain `el.value = x` is
  // silently reverted on the next render. Go through the native setter and
  // fire the event React actually listens for.
  const setNative = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const norm = s => (s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

  // Field labels are <label><span>Name</span>…</label>; match on the first span.
  const labelFor = text => {
    for (const l of document.querySelectorAll('label')) {
      const span = l.querySelector('span');
      if (span && norm(span.textContent) === text) return l;
    }
    return null;
  };

  const byText = (sel, re) =>
    Array.from(document.querySelectorAll(sel)).find(el => re.test(norm(el.textContent)));

  // Reset first: School/Degree is a multi-select, so without this every search
  // inherits the previous candidate's schools.
  const clear = byText('button, a, span[role="button"]', /^clear all$/i);
  if (clear) { clear.click(); await sleep(600); }

  const nameInput = document.querySelector('input[name="nm"]')
    || (labelFor('Name') && labelFor('Name').querySelector('input'));
  if (!nameInput) return { ok: false, error: 'name input not found' };
  setNative(nameInput, query.firstName);
  await sleep(300);

  // react-select: focus, type, wait for the async menu, click the first option.
  const pick = async (labelText, value) => {
    const label = labelFor(labelText);
    const input = label && label.querySelector('input.contactout-select__input');
    if (!input) return false;

    input.focus();
    setNative(input, value);

    for (let i = 0; i < 24; i++) {
      await sleep(250);
      const menu = label.querySelector('.contactout-select__menu')
        || document.querySelector('.contactout-select__menu');
      if (!menu) continue;
      const opts = Array.from(menu.querySelectorAll('.contactout-select__option, [id*="-option-"]'));
      if (!opts.length) continue;
      // The first option echoes the typed text verbatim — that is free text,
      // not a taxonomy entry. Take the first real suggestion when one exists.
      const echoed = norm(opts[0].textContent).toLowerCase() === norm(value).toLowerCase();
      const target = (echoed && opts.length > 1) ? opts[1] : opts[0];
      // react-select commits on mousedown, not click.
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      target.click();
      await sleep(400);
      return true;
    }
    // Nothing matched — clear the stray text so it can't leak into the query.
    setNative(input, '');
    return false;
  };

  let schoolsApplied = 0;
  for (const school of (query.schools || []).slice(0, 3)) {
    if (await pick('School/Degree', school)) schoolsApplied++;
  }

  // The left nav also has a "Search" item and it comes first in the DOM, so
  // never take the first match — the form's submit is the last one, and it must
  // share a near ancestor with the Name field.
  const searchBtn = Array.from(document.querySelectorAll('button'))
    .filter(b => /^search$/i.test(norm(b.textContent)))
    .filter(b => {
      let el = b;
      for (let i = 0; i < 6 && el.parentElement; i++) {
        el = el.parentElement;
        if (el.contains(nameInput)) return true;
      }
      return false;
    })
    .pop();
  if (!searchBtn) return { ok: false, error: 'search button not found' };
  if (searchBtn.disabled) return { ok: false, error: 'search button disabled — form did not take the input' };
  searchBtn.click();

  return { ok: true, schoolsApplied };
}

/* ---------------------- injected: resolve a school ----------------------- */

/* School/Degree is an autocomplete over ContactOut's own taxonomy, so Upwork's
 * wording has to be translated before it can be used as a `school=` filter.
 * Type the Upwork string, read the menu, hand the labels back — nothing is
 * selected here, this is a lookup only.
 *
 * The first option is always a verbatim echo of what was typed (typing "full"
 * offers "full" above "Full Sail University"), i.e. free text rather than a
 * real school. bestSchoolMatch() below is what discards it. */

/** args: school string -> { options: string[] } */
export async function lookupSchoolFn(query) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const norm = s => (s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

  const setNative = (el, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };

  let label = null;
  for (const l of document.querySelectorAll('label')) {
    const span = l.querySelector('span');
    if (span && norm(span.textContent) === 'School/Degree') { label = l; break; }
  }
  const input = label && label.querySelector('input.contactout-select__input');
  if (!input) return { options: [], error: 'school field not found' };

  input.focus();
  setNative(input, query);

  let options = [];
  for (let i = 0; i < 24; i++) {
    await sleep(250);
    const menu = label.querySelector('.contactout-select__menu')
      || document.querySelector('.contactout-select__menu');
    if (!menu) continue;
    const opts = menu.querySelectorAll('.contactout-select__option, [id*="-option-"]');
    if (!opts.length) continue;
    options = Array.from(opts).map(o => norm(o.textContent)).filter(Boolean);
    break;
  }

  setNative(input, '');   // leave the field as we found it
  return { options };
}

/* ------------------------- injected: read results ------------------------ */

/** args: max -> { status, total, results[], debugSample? } */
export async function scrapeResultsFn(max) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const clean = s => (s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

  // The card is the nearest ancestor of the LinkedIn link that also contains the
  // contact column — structural, so it survives the hashed class names.
  const cardOf = a => {
    let el = a;
    for (let i = 0; i < 10 && el.parentElement; i++) {
      el = el.parentElement;
      if (el.querySelector('button.reveal-btn, [data-testid="contact-infotext-wrapper"]')) return el;
    }
    return null;
  };

  let anchors = [], preSearch = false;
  for (let i = 0; i < 40; i++) {          // results load async after Search
    await sleep(500);
    const body = clean(document.body.innerText);
    if (/out of credits|credit limit|upgrade to (view|reveal)/i.test(body)) {
      return { status: 'quota', total: 0, results: [] };
    }
    anchors = Array.from(document.querySelectorAll('a[data-testid="linkedin-link"]'));
    if (anchors.length) break;
    // ContactOut's zero-results pane offers a LinkedIn search instead of listing
    // anything, and doesn't always use the words "no results".
    if (/no results|no profiles found|0 profiles|no matching profiles|go to linkedin search|couldn't find|could not find|try (a )?(different|broader|another)|adjust your (search|filters)|broaden your search/i.test(body)) {
      return { status: 'empty', total: 0, results: [] };
    }
    // The dashboard's idle pane. Filters may be filled, but nothing was run —
    // reporting this as "layout not recognised" hid a search that never fired.
    preSearch = /let's start searching|find emails and phones for/i.test(body);
  }

  if (!anchors.length && preSearch) return { status: 'not-searched', total: 0, results: [] };

  // "1 - 15 of 70 profiles" — how many the name matched before the page cap.
  const totalMatch = clean(document.body.innerText).match(/\d+\s*-\s*\d+\s+of\s+([\d,]+)\s+profiles/i);
  const total = totalMatch ? parseInt(totalMatch[1].replace(/,/g, ''), 10) : anchors.length;

  if (!anchors.length) {
    // Carry the visible text too — an unrecognised *state* (some new empty or
    // upsell pane) is far likelier than an unrecognised card layout, and the
    // text says which in one line without opening the SW console.
    const pane = document.querySelector('[data-testid*="result"], main') || document.body;
    return {
      status: 'unknown', total: 0, results: [],
      textSample: clean(pane.innerText).slice(0, 300),
      debugSample: (document.body.innerHTML || '').slice(0, 6000),
    };
  }

  const seen = new Set(), results = [];
  for (const a of anchors) {
    const card = cardOf(a);
    if (!card) continue;

    const linkedin = a.getAttribute('href') || '';
    if (!linkedin || seen.has(linkedin)) continue;
    seen.add(linkedin);

    // <span>Name</span> sits immediately before the div holding the social icons.
    const nameEl = a.parentElement && a.parentElement.previousElementSibling;
    const fullName = clean(nameEl && nameEl.textContent)
      || clean((card.querySelector('span.font-semibold') || {}).textContent);

    const locEl = card.querySelector('div.text-xs.truncate');
    const avatarEl = card.querySelector('img[alt="avatar"]');

    // Experience and education rows share one layout; only the leading icon
    // differs — briefcase is viewBox "0 0 12 12", graduation cap is "0 0 12 10".
    const experience = [], education = [];
    card.querySelectorAll('span.w-full.text-sm').forEach(span => {
      const row = span.closest('div.inline-flex');
      const svg = row && row.querySelector('svg');
      if (!svg) return;
      const copy = span.cloneNode(true);
      copy.querySelectorAll('button').forEach(b => b.remove());   // drop "...more"
      const text = clean(copy.textContent);
      if (!text) return;
      const vb = svg.getAttribute('viewBox');
      if (vb === '0 0 12 10') { if (!education.includes(text)) education.push(text); }
      else if (vb === '0 0 12 12') { if (!experience.includes(text)) experience.push(text); }
    });

    // Masked ("***@hotmail.com") until a credit is spent on View email.
    const emails = Array.from(card.querySelectorAll('[data-testid="contact-infotext-wrapper"]'))
      .map(w => clean(w.textContent)).filter(t => t.includes('@'));

    results.push({
      linkedin,
      fullName,
      location: clean(locEl && locEl.textContent),
      avatar: avatarEl ? avatarEl.src : '',
      experience,
      education,
      maskedEmails: emails,
      hasEmail: emails.length > 0,
      verified: !!card.querySelector('[data-testid="confidence-level-indicator"][data-tip="Verified"]'),
    });
    if (results.length >= max) break;
  }

  return { status: results.length ? 'ok' : 'empty', total, results };
}

/* ------------------------ injected: reveal an email ---------------------- */

/** args: linkedin href -> { status, email?, emails? }. Costs a credit. */
export async function revealEmailFn(linkedinHref) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const clean = s => (s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  const FULL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

  const a = Array.from(document.querySelectorAll('a[data-testid="linkedin-link"]'))
    .find(x => (x.getAttribute('href') || '') === linkedinHref);
  if (!a) return { status: 'not-found' };

  let card = a;
  for (let i = 0; i < 10 && card.parentElement; i++) {
    card = card.parentElement;
    if (card.querySelector('button.reveal-btn')) break;
  }
  if (!card || !card.querySelector('button.reveal-btn')) return { status: 'not-found' };

  // Revealed addresses lose the asterisk mask.
  const readEmails = () =>
    Array.from(card.querySelectorAll('[data-testid="contact-infotext-wrapper"]'))
      .map(w => clean(w.textContent))
      .filter(t => t.includes('@') && !t.includes('*'))
      .map(t => (t.match(FULL) || [])[0])
      .filter(Boolean);

  const already = readEmails();
  if (already.length) return { status: 'ok', email: already[0], emails: already };

  // "View phone" is the same button class — match on the label, not the class.
  const btn = Array.from(card.querySelectorAll('button.reveal-btn'))
    .find(b => /email/i.test(clean(b.textContent)))
    || Array.from(card.querySelectorAll('button[aria-label="reveal"]'))[0];
  if (!btn) return { status: 'no-button' };
  btn.click();

  for (let i = 0; i < 30; i++) {
    await sleep(500);
    if (/out of credits|credit limit|upgrade to (view|reveal)/i.test(clean(document.body.innerText))) {
      return { status: 'quota' };
    }
    const found = readEmails();
    if (found.length) return { status: 'ok', email: found[0], emails: found };
  }
  return { status: 'timeout' };
}

/* ------------------------------ module-side ------------------------------ */

const clean = s => (s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

/* Rows read as "<Role> at <Company> in 2019 - Present" and, for education,
 * either "<Degree> at <School> in 1998 - 2000" or bare "<School> in 2007 - 2013". */
function stripYears(s) {
  return clean(s.replace(/\s+in\s+\d{4}\s*-\s*(?:\d{4}|Present)\s*$/i, ''));
}
function afterAt(s) {
  const i = s.toLowerCase().lastIndexOf(' at ');
  return i === -1 ? s : clean(s.slice(i + 4));
}
function beforeAt(s) {
  const i = s.toLowerCase().lastIndexOf(' at ');
  return i === -1 ? s : clean(s.slice(0, i));
}

/** Fold scraped cards into the shape matcher.js expects. */
export function normalize(rows) {
  return rows.map(r => {
    const firstJob = stripYears(r.experience[0] || '');
    return {
      id: r.linkedin,
      fullName: r.fullName,
      headline: beforeAt(firstJob),
      company: afterAt(firstJob),
      location: r.location,
      linkedin: r.linkedin,
      avatar: r.avatar,
      education: r.education.map(e => afterAt(stripYears(e))).filter(Boolean),
      experience: r.experience.map(stripYears),
      verified: r.verified,
      hasEmail: r.hasEmail,
      emails: [],
    };
  }).filter(r => r.fullName);
}

/* Pick ContactOut's canonical school for an Upwork school string.
 *
 * The menu's first entry is a verbatim echo of the query — free text, not a
 * taxonomy entry — so it is only accepted when nothing real scores well enough.
 * Returns '' rather than a weak guess: a school ContactOut doesn't recognise
 * filters out the very person being searched for. */
export function bestSchoolMatch(query, options) {
  const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const q = norm(query);
  if (!q || !options || !options.length) return '';

  const tokens = s => new Set(norm(s).split(' ').filter(t => t.length > 2));
  const qt = tokens(query);

  const score = opt => {
    const o = norm(opt);
    if (!o) return 0;
    if (o === q) return 1;
    if (o.includes(q) || q.includes(o)) return 0.9;
    const ot = tokens(opt);
    if (!qt.size || !ot.size) return 0;
    let shared = 0;
    qt.forEach(t => { if (ot.has(t)) shared++; });
    return shared / Math.max(qt.size, ot.size);
  };

  // Drop the echo unless it is the only thing on offer.
  const real = options.length > 1 && norm(options[0]) === q ? options.slice(1) : options;

  let best = '', bestScore = 0;
  for (const opt of real) {
    const s = score(opt);
    if (s > bestScore) { bestScore = s; best = opt; }
  }
  return bestScore >= 0.5 ? best : '';
}

/** Upwork exposes the last initial ("Zyad K.") — drop surnames that contradict it. */
export function filterByLastInitial(rows, lastInitial) {
  if (!lastInitial) return rows;
  return rows.filter(p => {
    const parts = p.fullName.trim().split(/\s+/);
    const surname = parts.length > 1 ? parts[parts.length - 1] : '';
    return !surname || surname[0].toUpperCase() === lastInitial;
  });
}
