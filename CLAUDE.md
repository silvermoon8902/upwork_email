# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Manifest V3 Chrome/Edge extension (no build step, no bundler, no dependencies — plain
files loaded via **Load unpacked**). It walks an Upwork talent-search URL while the user is
logged in, opens each candidate profile in a real tab, matches the freelancer to a ContactOut
profile, and POSTs the resolved email to a Google Apps Script web app that appends rows to a
Sheet. See [README.md](README.md) for the user-facing setup/usage docs.

## Commands

There is no build, lint, or test suite. The full verification loop is:

```bash
node --check background.js     # and each other .js file
```

Then reload manually: `chrome://extensions` → Developer mode → **Load unpacked** (first time)
or the reload ↻ button on the extension card. Service-worker logs are behind the card's
"service worker" link (a separate DevTools window from any page console); popup logs are in
the popup's own inspector (right-click the popup → Inspect).

`apps_script.gs` is not deployed from this repo — it is pasted into the Apps Script editor
attached to the target Sheet and re-deployed as a Web app (Execute as **Me**, Access
**Anyone**) manually. Editing it here has no effect until that is redone.

## Architecture

The service worker is an ES module (`"type": "module"` in the manifest), so `background.js`
imports the resolver modules directly. Three isolated contexts, no shared bundling:

- **`background.js`** — orchestrator: run state machine, tab choreography, page scrapers, sink POST.
  - **`contactout_ui.js`** — ContactOut search + email reveal, **driven through the dashboard UI
    in a tab** (the API is a paid tier the account doesn't have).
  - **`matcher.js`** — identity matching (school overlap, then OpenAI).
  - **`errors.js`** — `PauseRun`, the error class meaning "stop the sweep, don't skip one candidate".
  - **`imghash.js`** — perceptual hashing. **Currently unused**; not imported by anything.
- **`popup.js` / `popup.html` / `popup.css`** — a dumb view. It only reads/writes config and
  sends commands; it holds no run logic.
- **`apps_script.gs`** — server-side sink, lives in Google, not executed here.

### Run state machine

`S` in [background.js](background.js) is the single in-memory run state (`status`, `page`,
`queue`, `queueIndex`, tab ids, counters). It is mirrored to `chrome.storage.local` under
`hv_state` on every step, because **MV3 kills the service worker between async gaps** — the
`keepalive` alarm (`chrome.alarms`, 0.4 min) re-enters `drive()` if the SW woke up while
`status === 'running'`. `driving` is the re-entry guard that makes that idempotent.

`drive()` is one loop: refill `S.queue` from the next search page → process each candidate →
random inter-candidate delay → advance the page when the queue drains.

Two things in that loop are load-bearing and easy to regress:

- **`processCandidate` returns a boolean**, and that — not `S.status` — decides whether the
  queue advances. `true` means the candidate was handled (skipped, matched, or errored
  non-fatally); `false` means the run paused mid-candidate and it must be retried on Resume.
  Keying the advance off the status flag instead causes a finished candidate to be reprocessed.
- **`loadPage` returns a `status` of `ok` / `empty` / `blocked` / `error`.** `empty` ends the
  sweep normally; `error` pauses so the page stays resumable. Collapsing those two back into
  "no candidates" makes a transient scrape failure silently end a long run and log it as success.

### Waiting out the interstitial

Upwork fronts both search pages and profiles with a "verifying you are human" challenge that
**normally clears itself** after a few seconds, and the Vue list renders only after that. Both
scrapers therefore **poll** (`SEARCH_MAX_WAIT_MS`, `PROFILE_MAX_WAIT_MS`) instead of reading
once at a fixed delay — a single snapshot sees an empty DOM and reports zero candidates.

`scrapeSearchPage` returns a `status`, and `pending` is deliberately distinct from `empty`:

- `ok` — candidate links found; whatever was in the way has cleared.
- `blocked` — challenge text or a captcha iframe is present.
- `empty` — Upwork **explicitly** said there are no results. Only this ends the sweep.
- `pending` — nothing recognisable yet; keep polling.

Running out of the window yields `blocked` (an interstitial was seen at some point, so the user
is asked to solve it) or `error` (nothing ever rendered — pause, stay resumable). Never `empty`.
Treating a bare zero-candidate DOM as `empty` is exactly the bug that ended sweeps at page 1.

The `noResults` patterns in `scrapeSearchPage` are **unverified against a real end-of-results
page**. If a sweep pauses with "never rendered" instead of finishing cleanly, the last snapshot's
first 400 characters are logged to the SW console — use that to fix the patterns.

### Tab choreography (deliberate, easy to break)

- The **search tab** is created inactive once and reused across pages (`ensureSearchTab`).
- Each **profile tab** is created with `active: false` and *then* activated in a second call
  (`createProfileTab`). Creating a foreground tab directly from a cold service worker is
  rejected under Dolphin Anty ("Onboarding tab should not be opened at startup") — don't
  collapse those two calls back into one.
- On a captcha or quota pause the profile tab is **kept open** (`S.profileTabId`) so the user
  can solve the challenge in place. On reuse, `processCandidate` **verifies the tab's URL still
  contains the candidate id** and re-navigates if not — solving a captcha can land the tab
  elsewhere, and scraping it then reads the wrong page and silently drops the candidate.
- `waitForLoad` checks `tab.status === 'complete'` *before* registering its `onUpdated`
  listener. Without that check an already-loaded tab waits out the full timeout.
- `humanScroll` is injected before every scrape to look like a real visitor. Removing it
  measurably increases captcha frequency.

### Injected scrapers

`scrapeSearchPage`, `scrapeProfile`, and `humanScrollFn` are passed to
`chrome.scripting.executeScript({func})`, which **serializes the function source** — they run
in the page's world with no access to module scope. They must stay fully self-contained: no
outer-scope constants, no shared helpers, no imports (nested helper functions declared *inside*
them are fine, and `scrapeProfile` uses that for `clean`/`sectionByHeading`). That is why the
captcha-detection regex is duplicated in both scrapers; keep the copies in sync when editing it.

Upwork is a Vue SPA with hashed `data-v-*` attributes, so the scrapers deliberately prefer
`itemprop`, `data-qa`, and `innerText` regex fallbacks over structural selectors. When a field
starts coming back empty on live pages, those two functions are the place to adjust — nothing
else depends on Upwork's DOM.

Three fields in `scrapeProfile` are scoped deliberately and should not be relaxed back to
body-text matching:

- **Badge** reads `.vetted-rated-badges`, not the page text. Upwork renders an explainer
  popover containing "Top Rated Plus talent is highly rated…" on *every* profile, and a
  freelancer's own overview can name the badges — body-wide matching promotes people who
  don't hold the badge.
- **Total earnings** reads `.cfe-ui-profile-summary-stats .col-compact` by matching the
  caption ("Total earnings" / "Total jobs" / "Total hours"), because the columns share one
  markup shape and their order isn't guaranteed. The old innerText regex is kept only as a
  fallback. `statByLabel` also yields Total jobs / Total hours if those are ever wanted.
- **Title** must exclude `[itemprop="name"]`. A bare `.air3-card-section h2` matches the
  freelancer's *name* heading, which sits in the same section, so the title silently came
  back as "Jaclyn B.".

Job success has a second source: the progress ring carries the number in a class
(`air3-progress-circle-99`), read with `getAttribute('class')` since those are SVG nodes.

`scrapeProfileWithRetry` requires `name` **and** at least one of education/skills before
accepting a scrape. Keying only on `name` returns on first paint and never gives the
late-rendering sections a chance.

`scrapeWorkHistoryFn` is separate from `scrapeProfile` and runs **once**, only for candidates
about to be saved — it clicks tabs and waits, so it must not sit inside the retry loop. It
reads two dates out of `.work-history-section`: the latest *ended* contract and the latest
*still-running* one. Two things it depends on:

- **"Completed jobs" and "In progress" are separate tabs rendering separate lists.** Whichever
  is inactive is not in the DOM at all, so the missing one is clicked and re-read.
- Entries are classified by the date range itself — a range ending in `Present` is a live
  contract (take its *start*), anything else is finished (take its *end*). Dates are the max
  over all visible entries, not the first: the section has a sort toggle, so position is not
  reliable.

### Driving the ContactOut dashboard

There is no API token — the dashboard is driven in a reused background tab (`S.coTabId`), which
the user must be logged into.

**The query goes in the URL, not the form.** Running a search by hand lands on
`/dashboard/search?nm=Edwin&page=1&school=Full%20Sail%20University`, so `buildSearchUrl` hands
`nm` (Name) and `school` (School/Degree) over directly and skips react-select entirely.
`fillSearchFormFn` is only a **fallback**, used when the dashboard loads that URL but stays on
its idle pane — `scrapeResultsFn` reports that as `not-searched`, which is deliberately distinct
from `unknown` (layout changed). Conflating them made a search that never fired look like a
selector problem.

`coSearchViaTab` retries **without** the school when a school-filtered search returns `empty`:
ContactOut's school taxonomy doesn't always match Upwork's wording, and a school that matches
nothing filters out the very person being looked for.

When the form fallback does run, three things in it are load-bearing:

- **React ignores `el.value = x`.** `fillSearchFormFn` writes through
  `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set` and then dispatches
  `input`, or the value is reverted on the next render.
- **Never anchor on react-select's generated ids.** `react-select-17-input` shifts whenever the
  form's field count changes (collapsing an "Advanced" section is enough). Every field is found
  by its `<label>` text instead. Name is the one exception — `input[name="nm"]` is stable.
- **react-select commits on `mousedown`, not `click`,** and its menu loads async, so `pick()`
  types, polls for `.contactout-select__option`, then fires mousedown/mouseup/click.
- **The left nav has its own "Search" item and it comes first in the DOM.** The submit button is
  selected as the *last* button labelled "Search" that shares a near ancestor with
  `input[name="nm"]` — taking the first match clicked the nav and the search never ran.

Each search reloads the tab *and* clicks "Clear all" — School/Degree is a multi-select, so
without the reset every candidate inherits the previous one's schools.

Result cards carry hashed emotion classes (`css-9w0zfn`, `css-1o52pgu`) that rotate on every
ContactOut deploy — **never select on those**. `scrapeResultsFn` anchors on stable handles:

- `a[data-testid="linkedin-link"]` is the card's identity; the card itself is found by walking
  up until an ancestor also contains `button.reveal-btn`. The sibling `github.com/search?q=…`
  and `twitter.com/search?q=…` anchors are *search* links, not profiles — never treat them as one.
- The name `<span>` is `linkedinAnchor.parentElement.previousElementSibling`.
- **Experience and education rows are the same markup**; only the leading icon differs.
  `viewBox="0 0 12 12"` is the briefcase (experience), `"0 0 12 10"` the graduation cap
  (education). That viewBox check is the only thing separating them — ContactOut returns
  duplicate rows, so both lists dedupe.
- Emails are masked (`***@hotmail.com`) until `button.reveal-btn` is clicked, which spends a
  credit. "View phone" shares that class, so the reveal button is matched on its *label*.
  `[data-testid="confidence-level-indicator"][data-tip="Verified"]` is a per-address quality flag.
- The header reads "1 - 15 of 70 profiles"; the page caps at 15, so `total` is logged whenever
  it exceeds what was read — a common first name silently truncating is worth seeing.

`winner.hasEmail` is checked **after** matching, not before. Filtering email-less cards out of
the pool first would let a confident match land on the wrong person instead of reporting a dead end.

If the card layout changes, `scrapeResultsFn` returns `debugSample` (a slice of the results
markup) which is logged to the SW console — use that rather than guessing at new selectors.

### Identity matching

Upwork hides surnames from non-contracted clients, so `splitName` turns `"Zyad K."` into
`{firstName: 'Zyad', lastInitial: 'K'}`. **The ContactOut query uses the first name only** —
`buildQuery` sends `name: firstName` plus education/location/title filters. The last initial is
never sent; `coSearch` applies it afterwards as a surname post-filter, which discards most
results before anything costs a credit or a token.

Matching is two tiers, cheapest first ([matcher.js](matcher.js)):

1. `deterministicMatch` — one survivor whose school overlaps the Upwork education. 95%, free.
2. `aiMatch` — OpenAI adjudicates over profile **text** and returns `{index, confidence, reason}`.

Below `cfg.matchThreshold` the candidate is dropped rather than guessed. `aiMatch` detects
refusals (both `message.refusal` and prose declines) and degrades to "no match" so a refusal is
never parsed as a match.

### Pause-worthy errors

Anything that means "the run cannot usefully continue" throws `PauseRun` from
[errors.js](errors.js) — ContactOut and OpenAI 401/402/403/429. `processCandidate` catches it,
keeps the tab, and pauses. This replaced substring-matching on error messages
(`String(e).includes('rate-limited')`), which silently failed to catch 429s. Use the class, not
message text.

### Sink contract

`processCandidate` POSTs the **full** scraped record; `apps_script.gs` selects a subset of it
into columns. Fields currently sent but not written: `upwork_name`, `linkedin_profile_link`,
`email_verified`, `education`, `match_source`. Surfacing one is an Apps-Script-only change —
add it to `HEADER` *and* `appendRow` in the same position.

`HEADER` and `appendRow` are positionally coupled to each other, and **`EMAIL_COL` must track
the `Email` column's 1-based index** (currently 3) — the dedupe reads that column. Any change
here means re-deploying the Apps Script *and* renaming the old sheet: the sink refuses to append
when an existing header doesn't match, rather than writing misaligned rows.

There is no Timestamp column — rows carry no record of when they were added.

### Config plumbing

A config field must be added in three places to work: `DEFAULT_CONFIG` in `background.js`, the
`CFG_FIELDS` map in `popup.js` (with its kind — `text` / `int` / `bool`), and an input with a
matching `id` in `popup.html`. `DEFAULT_CONFIG.postEndpoint` carries a live pre-filled Apps
Script URL.

### Popup ↔ background protocol

`chrome.runtime.sendMessage({cmd, ...})` for commands (`getState`, `saveConfig`, `start`,
`pause`, `resume`, `stop`, `clearLog`); the listener returns `true` to keep `sendResponse`
alive across its async body. The background pushes `{type: 'tick', state}` broadcasts on every
state change, whose rejection is swallowed because the popup is usually closed. The log is a
300-entry ring buffer in `chrome.storage.local` (`hv_log`), re-read in full by the popup on
every tick.

## Behaviors not in the README

- `SKIP_COUNTRIES` at the top of `background.js` drops candidates by lowercased
  `[itemprop="country-name"]` match before any paid lookup.
- A profile with neither education nor a title is skipped — a first name alone is too broad a
  ContactOut query to be worth a credit.
