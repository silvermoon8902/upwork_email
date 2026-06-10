# Upwork → GitHub Email Harvester

Browser extension (Chrome/Edge, Manifest V3). While you're logged into Upwork as
a client, it walks a talent-search URL, opens each candidate's profile, resolves
their GitHub linked account to an email, and POSTs the result to a Google Sheet.

## Pipeline

```
Search URL (page N from its page= param)
  └─ open each profile in a real, visible tab
       └─ scrape: name, job success, badge, hourly rate, total earning,
                  GitHub avatar numeric id (from "Linked accounts")
            └─ api.github.com/user/<id>  → login + public email + real github.com URL
                 └─ if no public email → commit emails from public events / repos
                      (filtering out *noreply.github.com)
  └─ if a real email is found → POST payload to the Apps Script sink
  └─ auto-advance pages until a page has no candidates
```

## POST payload

```json
{
  "upwork_name":         "Zyad K.",
  "upwork_profile_link": "https://www.upwork.com/freelancers/~0185be00d6d12e8b0a",
  "github_profile_link": "https://github.com/zyadkhalil",
  "email_address":       "zyad@example.com",
  "job_success_score":   "100%",
  "badge":               "Top Rated Plus",
  "hourly_rate":         "$28.50/hr",
  "total_earning":       "$90K+"
}
```

Only candidates with a **real, non-`noreply` email** are POSTed.

## Setup

### 1. Google Sheet sink
1. Create a Google Sheet.
2. Extensions → Apps Script. Paste `apps_script.gs`.
3. Deploy → New deployment → **Web app** (Execute as **Me**, Access **Anyone**).
4. Copy the `/exec` URL.

### 2. Load the extension
1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → this folder.
2. Click the toolbar icon → **Settings**:
   - **Search URL** — paste your Upwork talent search URL. The run starts at its
     `page=` value (e.g. `&page=20` starts at page 20); no `page=` ⇒ page 1.
   - **GitHub PAT** — classic token with `read:user` + `user:email` (public read
     only). Raises the GitHub API limit from 60 → 5,000 req/hr.
   - **POST endpoint** — the Apps Script `/exec` URL (pre-filled).
   - **Delays** — randomized wait between profiles (default 4–10s). Higher = fewer
     captchas.
3. **Save settings**, then **Start**.

## Controls
- **Start** — begin from the search URL's page.
- **Pause / Resume** — state persists.
- **Stop** — reset.
- The toolbar badge shows `•` while running and `!` on a captcha.

## CAPTCHA
Upwork challenges fast navigation. When one is detected the run **auto-pauses** and
logs a warning — solve it in the open tab, then click **Resume** (it retries the
same candidate). Increase the delays to reduce how often this happens.

## Files
- `manifest.json` — MV3 manifest
- `background.js` — orchestrator (search walk, profile scrape, GitHub API, POST)
- `popup.html` / `popup.css` / `popup.js` — control panel + live log
- `apps_script.gs` — Google Sheet sink

## Tuning note
Upwork's DOM (Vue, hashed `data-v-*` attrs) changes over time. The scrapers use
resilient selectors with text fallbacks, but if a field comes back empty on live
pages, the selectors in `scrapeSearchPage()` / `scrapeProfile()` (in
`background.js`) are where to adjust.
```
