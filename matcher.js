/* Identity matcher — decides which ContactOut result is the Upwork freelancer.
 *
 * Text signals only: first name, last initial, education, title, location,
 * skills. Upwork hides surnames, so education plus the surname initial plus
 * country is what actually narrows the field.
 *
 * Tier 1 (deterministic, free) runs first and short-circuits the API call when
 * a single survivor's school matches — most confident matches never cost a
 * token. Tier 2 asks the model to adjudicate the rest.                       */

import { PauseRun } from './errors.js';

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';

const SYSTEM = `You decide which LinkedIn profile, if any, belongs to a given Upwork freelancer.
Upwork hides surnames, so you get a first name and a last initial only. Education, job title, location and skills carry the signal.
Be conservative: a wrong match is far worse than no match. If the evidence is thin, return index -1.
Reply with JSON only.`;

const SCHEMA = `Reply with a JSON object: {"index": <0-based index of the best match, or -1 if none>, "confidence": <0-100>, "reason": "<one short sentence>"}`;

const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Do any of the freelancer's schools appear in this candidate's education? */
export function schoolOverlap(upworkSchools, candidateSchools) {
  const a = upworkSchools.map(norm).filter(s => s.length > 3);
  const b = candidateSchools.map(norm).filter(s => s.length > 3);
  return a.some(x => b.some(y => y.includes(x) || x.includes(y)));
}

/** Tier 1: one survivor whose school matches needs no model call. */
export function deterministicMatch(profile, candidates) {
  if (candidates.length !== 1) return null;
  if (!profile.education.length) return null;
  const schools = profile.education.map(e => e.school);
  if (!schoolOverlap(schools, candidates[0].education)) return null;
  return { index: 0, confidence: 95, reason: 'sole survivor, school matches', source: 'education' };
}

function isRefusal(text) {
  return /\b(can't|cannot|unable to|won't be able)\b[^.]{0,60}\b(identify|verify|determine who|confirm the identity)/i
    .test(text || '');
}

/** Tier 2: model adjudication over the profile text. */
export async function aiMatch(cfg, profile, candidates) {
  const key = (cfg.openaiKey || '').trim();
  if (!key || !candidates.length) return null;

  const target = {
    first_name: profile.firstName,
    last_initial: profile.lastInitial,
    country: profile.country,
    title: profile.title,
    education: profile.education,
    skills: profile.skills.slice(0, 8),
  };
  const options = candidates.map((c, i) => ({
    index: i,
    full_name: c.fullName,
    headline: c.headline,
    company: c.company,
    location: c.location,
    education: c.education,
    // Role history disambiguates namesakes better than the headline alone —
    // a ContactOut search on a common first name returns dozens.
    experience: (c.experience || []).slice(0, 5),
  }));

  const user = [
    'UPWORK FREELANCER:', JSON.stringify(target, null, 2), '',
    'LINKEDIN CANDIDATES:', JSON.stringify(options, null, 2), '',
    SCHEMA,
  ].join('\n');

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify({
      model: cfg.openaiModel || 'gpt-4o',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
    }),
  });

  if (res.status === 429) throw new PauseRun('OpenAI rate limited (429)');
  if (res.status === 401) throw new PauseRun('OpenAI key rejected (401)');
  if (res.status === 402 || res.status === 403) throw new PauseRun(`OpenAI quota/access rejected (${res.status})`);
  if (!res.ok) throw new Error(`OpenAI ${res.status}`);

  const msg = (await res.json())?.choices?.[0]?.message;
  const out = msg?.content || '';
  if (msg?.refusal || isRefusal(out)) return { index: -1, confidence: 0, reason: 'model declined', source: 'openai' };

  try {
    const p = JSON.parse(out);
    return {
      index: Number.isInteger(p.index) ? p.index : -1,
      confidence: Math.max(0, Math.min(100, Number(p.confidence) || 0)),
      reason: String(p.reason || ''),
      source: 'openai',
    };
  } catch {
    return { index: -1, confidence: 0, reason: 'unparseable response', source: 'openai' };
  }
}
