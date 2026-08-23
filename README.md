# Upwork → ContactOut Email Harvester

Browser extension (Chrome/Edge, Manifest V3). While you're logged into Upwork as
a client, it walks a talent-search URL, opens each candidate's profile, matches
the freelancer to a ContactOut profile, and POSTs the resolved email to a Google
Sheet.

## Pipeline

```
Search URL (page N from its page= param)
  └─ open each profile in a real, visible tab
       └─ scrape: name, country, title, education, skills, job success,
                  badge, hourly rate, total earning, linked-GitHub flag
            └─ skip if a GitHub account is linked (skipIfGithub)
                 └─ ContactOut search on FIRST NAME ONLY ("Zyad K." → "Zyad"),
                    narrowed by education / country / title
                      └─ post-filter on the last initial (surname must start "K")
                           └─ match: school overlap (free) → OpenAI (paid)
                                └─ above threshold → reveal email → POST
  └─ auto-advance pages until a page has no candidates
```

### Why first name only

Upwork hides surnames from non-contracted clients, so the search keyword is the
first name alone. The last initial is never sent to ContactOut — it's applied
afterwards as a filter on the returned surnames, which throws out most of the
noise before anything costs a credit or a token.

### Matching

Two tiers, cheapest first:

1. **School overlap** — exactly one result survives the surname filter *and* its
   education matches the Upwork profile's. Accepted at 95%, no API call.
2. **OpenAI** — adjudicates the remaining cases over profile text (first name,
   last initial, education, title, location, skills) and returns
   `{index, confidence, reason}`. Anything below **Match threshold** is dropped.

Without an OpenAI key, tier 1 still works on its own; everything ambiguous is
skipped rather than guessed.

## POST payload

```json
{
  "upwork_name":           "Zyad K.",
  "upwork_profile_link":   "https://www.upwork.com/freelancers/~0185be00d6d12e8b0a",
  "linkedin_profile_link": "https://www.linkedin.com/in/zyadkhalil",
  "email_address":         "zyad@example.com",
  "full_name":             "Zyad Khalil",
  "education":             "Cairo University",
  "match_confidence":      "95",
  "match_source":          "education",
  "job_success_score":     "100%",
  "badge":                 "Top Rated Plus",
  "hourly_rate":           "$28.50/hr",
  "total_earning":         "$90K+"
}
```

## Setup

### 1. Google Sheet sink
1. Create a Google Sheet.
2. Extensions → Apps Script. Paste `apps_script.gs`.
3. Deploy → New deployment → **Web app** (Execute as **Me**, Access **Anyone**).
4. Copy the `/exec` URL.

> Upgrading from v0.1? The column layout changed. Rename the old `Candidates`
> sheet — the script recreates it with the new header and refuses to append to a
> mismatched one.

### 2. Load the extension
1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → this folder.
2. Click the toolbar icon → **Settings**:
   - **Search URL** — the run starts at its `page=` value; no `page=` ⇒ page 1.
   - **ContactOut API token** — required.
   - **OpenAI API key** / **model** — optional; enables tier-2 matching.
   - **POST endpoint** — the Apps Script `/exec` URL.
   - **Delays** — randomized wait between profiles (default 4–10s). Higher = fewer captchas.
   - **Match threshold** — minimum confidence to accept (default 75).
   - **Max results / profile** — ContactOut results considered (default 8).
   - **Skip linked GitHub** — on by default; the target segment is freelancers *without* one.
3. **Save settings**, then **Start**.

## Controls
- **Start** — begin from the search URL's page.
- **Pause / Resume** — state persists.
- **Stop** — reset and close the run's tabs.
- The toolbar badge shows `•` while running and `!` on a captcha.

## Pausing
The run auto-pauses (rather than burning through the queue) on:
- a **CAPTCHA** — solve it in the open tab, then **Resume**; the same candidate is retried.
- **ContactOut** 401/402/403/429 — bad token, no credits, or rate limited.
- **OpenAI** 401/402/403/429.
- a **search page that couldn't be read** — distinct from a genuinely empty page,
  which ends the sweep normally.

## Files
- `manifest.json` — MV3 manifest (module service worker)
- `background.js` — orchestrator (search walk, profile scrape, matching, POST)
- `contactout.js` — ContactOut search + email reveal
- `matcher.js` — school-overlap and OpenAI matching
- `errors.js` — `PauseRun`, the errors that stop the sweep
- `imghash.js` — perceptual image hashing (not wired into the pipeline)
- `popup.html` / `popup.css` / `popup.js` — control panel + live log
- `apps_script.gs` — Google Sheet sink

## Tuning notes
- **ContactOut**: endpoint paths, filter field names and the response shape in
  `contactout.js` are a best-effort mapping — **verify them against current
  docs**. Everything provider-specific lives in `ENDPOINTS`, `buildQuery()` and
  `normalize()`.
- **Upwork DOM**: Vue with hashed `data-v-*` attrs, so it drifts. The scrapers use
  resilient selectors with text fallbacks; if a field comes back empty, adjust
  `scrapeSearchPage()` / `scrapeProfile()` in `background.js`.
