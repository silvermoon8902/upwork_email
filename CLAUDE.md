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

`scrapeProfileWithRetry` requires `name` **and** at least one of education/skills before
accepting a scrape. Keying only on `name` returns on first paint and never gives the
late-rendering sections a chance.

### Driving the ContactOut dashboard

There is no API token — `coSearchViaTab` fills the real search form in a reused background
tab (`S.coTabId`), which the user must be logged into. Three things there are load-bearing:

- **React ignores `el.value = x`.** `fillSearchFormFn` writes through
  `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set` and then dispatches
  `input`, or the value is reverted on the next render.
- **Never anchor on react-select's generated ids.** `react-select-17-input` shifts whenever the
  form's field count changes (collapsing an "Advanced" section is enough). Every field is found
  by its `<label>` text instead. Name is the one exception — `input[name="nm"]` is stable.
- **react-select commits on `mousedown`, not `click`,** and its menu loads async, so `pick()`
  types, polls for `.contactout-select__option`, then fires mousedown/mouseup/click.

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

The POST body keys in `processCandidate` are positionally coupled to `appendRow` in
`apps_script.gs`, and the Sheet dedupes on **`EMAIL_COL = 5`**. Changing the payload shape means
editing the payload, `HEADER`, the `appendRow` order, and `EMAIL_COL` together — and
re-deploying the Apps Script. The sink refuses to append when an existing sheet's header
doesn't match, rather than writing misaligned rows.

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
