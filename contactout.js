/* ContactOut adapter — people search + email reveal.
 *
 * ⚠ VERIFY AGAINST CURRENT DOCS. Endpoint paths, filter field names and the
 * response shape below are a best-effort mapping; ContactOut has changed them
 * before. Everything provider-specific is confined to ENDPOINTS, buildQuery()
 * and normalize() so there is exactly one place to correct.
 *
 * Search strategy (per the brief): Upwork hides surnames, so we search on
 * first name + education + location and post-filter on the last initial that
 * Upwork *does* expose ("Zyad K." -> surname must start with K).            */

import { PauseRun } from './errors.js';

const BASE = 'https://api.contactout.com/v1';
const ENDPOINTS = {
  search: BASE + '/people/search',
  email:  BASE + '/people/email',
};

function headers(cfg) {
  return {
    'Content-Type': 'application/json',
    'authorization': 'basic',
    'token': (cfg.contactOutToken || '').trim(),
  };
}

async function call(url, cfg, init = {}) {
  const res = await fetch(url, { ...init, headers: headers(cfg) });

  // Pause the whole run rather than burning the queue against a dead quota.
  if (res.status === 429) throw new PauseRun('ContactOut rate limited (429)');
  if (res.status === 401 || res.status === 403) throw new PauseRun(`ContactOut auth/quota rejected (${res.status})`);
  if (res.status === 402) throw new PauseRun('ContactOut credits exhausted (402)');
  if (!res.ok) throw new Error(`ContactOut ${res.status}`);

  return res.json();
}

/* --------------------------- query construction -------------------------- */

function buildQuery(profile) {
  const q = { name: profile.firstName, page: 1 };
  // Education is the strongest narrowing signal we have when the surname is hidden.
  if (profile.education.length) q.education = profile.education.map(e => e.school).filter(Boolean);
  if (profile.country)          q.location  = [profile.country];
  if (profile.title)            q.job_title = [profile.title];
  if (profile.skills.length)    q.skills    = profile.skills.slice(0, 5);
  return q;
}

/* ---------------------------- response mapping --------------------------- */

function pick(o, ...keys) {
  for (const k of keys) if (o && o[k]) return o[k];
  return '';
}

function normalize(raw) {
  const list = Array.isArray(raw) ? raw
    : (raw && (raw.profiles || raw.data || raw.results)) || [];
  const arr = Array.isArray(list) ? list : Object.values(list);

  return arr.map(p => ({
    id:        pick(p, 'id', 'li_vanity', 'profile_id'),
    fullName:  pick(p, 'full_name', 'name'),
    headline:  pick(p, 'headline', 'title', 'job_title'),
    company:   pick(p, 'company', 'current_company'),
    location:  pick(p, 'location', 'country'),
    linkedin:  pick(p, 'linkedin_url', 'li_url', 'url', 'profile_url'),
    avatar:    pick(p, 'profile_picture', 'avatar', 'image_url', 'photo_url'),
    education: []
      .concat(p?.education || p?.schools || [])
      .map(e => (typeof e === 'string' ? e : pick(e, 'school', 'name', 'title')))
      .filter(Boolean),
    emails: [].concat(p?.email || p?.emails || p?.work_email || []).filter(Boolean),
    raw: p,
  })).filter(p => p.fullName);
}

/* -------------------------------- surface -------------------------------- */

/** Search, then drop anyone whose surname contradicts the Upwork last initial. */
export async function coSearch(cfg, profile) {
  const raw = await call(ENDPOINTS.search, cfg, {
    method: 'POST',
    body: JSON.stringify(buildQuery(profile)),
  });

  const all = normalize(raw);
  if (!profile.lastInitial) return { all, kept: all };

  const kept = all.filter(p => {
    const parts = p.fullName.trim().split(/\s+/);
    const surname = parts.length > 1 ? parts[parts.length - 1] : '';
    return !surname || surname[0].toUpperCase() === profile.lastInitial;
  });
  return { all, kept };
}

/** Reveal an address for one match. Costs a credit — call only after matching. */
export async function coEmail(cfg, match) {
  if (match.emails.length) return match.emails[0];
  if (!match.linkedin) return '';

  const raw = await call(
    `${ENDPOINTS.email}?profile=${encodeURIComponent(match.linkedin)}`, cfg, { method: 'GET' });

  const found = raw?.profile?.email || raw?.email || raw?.data?.email || [];
  return [].concat(found).filter(Boolean)[0] || '';
}
