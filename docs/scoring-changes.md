# Official Scoring Change Tracking (initial call → final ruling)

**Date:** 2026-09-04
**Status:** ✅ Fully Implemented and Tested
**Requirement:** Track plays whose official-scoring ruling CHANGES after the initial call (error↔hit, single↔double, double→single+error, triple+error↔homerun, …) — both the initial call and the final ruling — in the replay feed (reviews.html), as a dedicated ✏️ Scoring Changes tab AND in the All feed.

> **Session-3 amendment (2026-09-24, verbatim):** "I think we should also track anytime a final
> scoring decision would change a single to an error, but that would require tracking every
> single hit, which would cause too much bloat in the primary alert system. We need to create a
> section for anything that changes a single to an error and keep it from populating the main
> primary alert system, which is error to a single, also for any scoring pending will be changed
> to a single, error, out, fielders choice, out, etc."
>
> **What changed (implemented and tested):** a tracked change whose INITIAL call was a non-home-run
> hit (single/double/triple) and whose FINAL ruling is a plate-appearance field error — exactly
> the pipeline classifier's `hitToError` flag and the model's `hitToError` question — is still
> detected, logged, persisted and restored like every other change, but it no longer renders in
> the All feed, no longer renders in the ✏️ Scoring Changes tab and no longer triggers the alert
> chime (`isHitToErrorChange` → `visibleInAllFeed` / `shouldAlertForReview` /
> `matchesFilter('scoring')` in `assets/js/reviews-feed.js`). It renders in its own **📉 Hit →
> Error** feed tab (pre-change chance + final result on every row, via the existing model block),
> and the season-long official list lives on `scoring.html` → **📉 Hit → Error**. A hit changed
> to a *fielder's choice + error* (official log #232 shape) is NOT moved — the final ruling is not
> an error — and neither is a home-run change (no model exists for it): both stay in the primary
> surface. Detection adds no per-single bloat: it reuses the compact baselines the tracker already
> keeps for every completed play, and only a confirmed change mints a row. Every other scoring
> change still shows in the All feed per the original requirement below.

## User Requirement (Verbatim)

> Add tracking of plays whose official-scoring ruling CHANGES after the initial call — examples: error↔hit, single↔double, double→single(+error), triple+error↔homerun, etc. Track BOTH the initial call and the final ruling (what the official scorer changed it to). Lives in the existing "replay feed all games" (reviews.html). Must be a separate tab in the feed AND also show up in the All feed.

Standing constraints: **no manual input** (everything is detected automatically from API scans), **no hallucinations** (verified line-by-line against live StatsAPI payloads / official registries), **irregularities flagged for review** (same pattern as the challenge-counter regression flags).

## How detection works (no hallucination basis)

- The StatsAPI playByPlay payload stores ONLY the final ruling — there is **no scorer-change flag** anywhere in the API (verified live 2026-09-04 against games 823337, 822853, 823095, 824388, 824796, 824144, 822766, 822769; and against the MLB.com scoring-changes log entries #230 and #232). Detection is therefore **poll-diff**: the tracker snapshots every completed play's official classification on each scan and diffs it against what previous polls observed. The initial call comes from our own earlier snapshot — never invented.
- Classification is diffed **by registry event type, not text**: `result.eventType` is classified with the live-verified registry (https://statsapi.mlb.com/api/v1/eventTypes, 75 codes):
  - hits = `single`, `double`, `triple`, `home_run` only;
  - plate-appearance errors = `field_error`; base-running errors = `error`;
  - pending = `os_ruling_pending_primary` / `os_ruling_pending_prior` (never baselined — the first real classification is the baseline).
- Runner-level error advances (`runners[].details.eventType === 'error'` on a non-error PA, e.g. change #232 "fielder's choice + error") participate in the diff through `runners[].movement` (`originBase → end / outBase / isOut`), which requires the `movement` parent key in the `fields` projection (gotcha verified twice live).
- A classification diff mints/updates a permanent row; annotation-only edits (description wording, `result.rbi`, score-after without reclassification) and plays vanishing from the payload are **irregularities** — flagged to the on-page "Scoring irregularities" list and `console.warn`, deduped per game (cap 30).

## Row anatomy

Each row (key `<gamePk>:scoring-<atBatIndex>`, one row per play however many rulings):

- Headline: `Initial call → Final ruling` (e.g. `Double → Field Error`) with category-classed chips (hit / error / out / other) and a per-key tooltip explaining the mechanism.
- `N rulings observed` badge when a play changed more than once (also flagged), plus the intermediate headline (`previousHeadline`) and a full observed chain in row history.
- **Initial call** line with the observed time (our snapshot), **Final ruling** line, official **score after** (printed only when the payload carried it — never invented), mechanism line, and the batter/pitcher footer + official matchup label.
- Attribution: `scorer` (default), `pending_ruling` (resolved `os_ruling_pending_*` marker on the play), or `replay_review` — review-attributed rows are surfaced ONLY when no replay-review feed row exists for that exact at-bat (otherwise the change is the review's outcome and lives on that row, no double-count).

## Scan windows

- Live games: every poll (default cadence).
- Final games: MLB's own scoring-changes log states changes can be made "following the conclusion of the listed games" (by the Official Scorer, Elias Sports Bureau, or after a club-initiated review — https://www.mlb.com/official-information/scoring-changes). A Final is therefore re-scanned **once per 30 s within a 30-minute grace window** from the first observed Final (`finalScanDecision`), then settled for good — bounded, never unbounded.

## Where the code lives

- `assets/js/reviews-feed.js` — pure helpers (`buildScoringSnapshot`, `scoringSnapshotSignature`, `scoringChangeSummary`, `scoringEventLabel`, `scoringMechanism`, `mergeScoringChanges`, `finalScanDecision`, `runsRemovableFromReview`, `visibleInAllFeed`, `shouldAlertForReview`) + IIFE wiring (`scoringContextFor`, `admitScoringEntries`, `ingestGame` gate, `mergeFeedEvents` cleanup protecting `scoring_change` rows, rendering via `scoringChangeBlock` in `feedRow`, stats/tabs/filter/empty-state, scoring-irregularities list).
- `assets/js/api.js` — `PBP_FIELDS` carries every scoring-read field (pinned by `tools/api-fields-test.mjs`, including `originBase`, `isOut`, `rbi`, `end`).
- `assets/js/reviews.js` — unchanged; supplies pending-scoring rows and `extractReviews`.
- `reviews.html` — footer documents the method; sound-toggle title covers the scoring chime.
- `style.css` — chips/outcome/stat/tab/irregularity styles.

## Tests (all deterministic, live-verbatim fixtures)

- `tools/scoring-change-test.mjs` — 14 sections: registry classification, baseline rules (pending/blank never baselined), single/double/multi-ruling chains with history, hit↔error/out/FC matrices, attribution (review-covered skip vs orphan review surface vs other-index non-capture vs pending_ruling), irregularities (RBI/score-after/description-only/vanished play) with dedupe, empty-payload blip, `mergeFeedEvents` cleanup protection, alert/All-feed visibility predicates, `finalScanDecision` truth table, malformed-input degradation, and §14 the hit→error segregation contract (`isHitToErrorChange` truth table: single/double/triple→error segregated; error→hit, hit→FC+error, HR→error, out→error and malformed rows stay primary).
- `tools/replay-feed-render-test.mjs` §9 — end-to-end through the real boot path: baseline poll mints no row; the rescored poll (single → field error) renders the row ONLY in the 📉 Hit → Error tab with every line item — never in All (`All (2)`), never in ✏️ Scoring Changes (`✏️ Scoring Changes (0)`), stats (`Hit → Error 1`, `Events 2`, no `Scoring Changes` stat) — while the status line still counts it as tracked (`4 review events`, so it persists); Under Review stays replay-only; idempotent re-poll. This section caught the `scoring.entries` no-op wiring defect the unit tests could not see.
- `tools/api-fields-test.mjs` — projection completeness for the third consumer.
- `tools/official-scoring-test.mjs`, `tools/reviews-feed-test.mjs`, `tools/review-*.mjs` — regression (all green).

## Irregularity policy

Anything that does not fit the verified vocabulary is flagged, never guessed: description-only rewrites, RBI changes, score-after corrections without reclassification, plays disappearing from the payload, multiple rulings on one play. An empty play list is treated as a payload blip (state preserved). Every flag is visible on-page (⚠️ list at the bottom of the feed) and in `console.warn` for review.

## Feed log — every tracked entry survives a refresh or a later visit

**Date:** 2026-09-05
**Status:** ✅ Fully Implemented and Tested
**Requirement:** Keep detection exactly as-is, but log every entry so a refresh or a fresh visit shows everything tracked.

**Problem it fixes:** all tracker state (`feedState`, `scoringSnapshots`, `scoringIrregularities`, `scoringGraceFinals`, `settledGames`) lived in memory only, so a refresh wiped every feed row *and* the baselines the next poll-diff needed — tracked entries, including scoring changes, were silently lost.

**How it works (detection untouched):** after any poll that adds, updates, ends, or flags an entry (or advances a Final's grace window), the page writes its whole observed state to `localStorage` under `mlbReplayFeedLog.v1.<YYYY-MM-DD>`; on boot and on date change it restores that log *before* the first scan and paints it immediately, so the first poll diffs against the previously observed baselines. Restored rows merge idempotently by stable key (`<gamePk>:<id>`); a change that landed while the page was closed still diffs honestly against what was last observed. Writes are throttled (≤1/s) plus flushed on tab-hide/`pagehide`.

**What is stored:** feed rows of every `typeKey` (reviews, ABS, pending-scoring, scoring-change) with `firstSeen`/`lastSeen`/`matchupLabel`; per-game scoring baselines (`snapshot`, `signature`, `firstObservedAt`, `lastObservedAt`, `history`, `rowCreated`); per-game irregularity notes; post-Final grace windows + settled finals (a revisit *continues* the bounded grace instead of restarting it). Every stored field is produced by `mergeFeedEvents` / `mergeScoringChanges` from official playByPlay fields — nothing invented for storage. Deliberately **not** stored: challenge counters (re-fetched live; a stale "now" value must never be shown) and run-risk alert keys (a revisit behaves exactly like a first visit).

**Bounds:** 500 most-recent rows, 400 baselines/game, 30 notes/game, 7 date-logs (the viewed date always kept); trims are counted in the payload (`trimmed`), malformed stored records are dropped with a `console.warn` — flagged, never hidden. No `localStorage` (private mode, tests) degrades to the old in-memory behavior.

**Tests:** `tools/feed-log-persistence-test.mjs` — 7 sections: key/date validation; serialize caps with trim counts; round-trip through the real merge helpers (no phantom row after refresh; a post-refresh ruling updates with the *original* initial call and the multi-ruling flag); idempotent re-admit + cleanup protection; malformed-log handling (version/date mismatch, 10+ malformed records dropped and counted); index pruning; and a full refresh simulation through the real boot path (baseline → rescore → flush → fresh VM, row painted before the first scan settles, no duplicate after it, tabs intact).

## Cross-Browser & Across-the-Website Persistence

**Date:** 2026-09-23  
**Status:** ✅ Fully Implemented and Verified (Zero Hallucinations)  
**Requirement:** Scoring changes and all tracked entries must be persistent across browsers (not just a browser open for hours) and across the entire website (`reviews.html`, `game.html`, `index.html`).

### Problem Addressed
When a scoring change was detected after hours of polling on Browser 1, it was saved only to Browser 1's `localStorage`. Opening the same website on Browser 2 (or a fresh browser/incognito session) resulted in:
1. Browser 2's `localStorage` being empty.
2. Browser 2 fetching the MLB StatsAPI where the play was already in its final ruling state.
3. Browser 2 treating the final ruling as the baseline with no initial call recorded.
4. The scoring change failing to appear on Browser 2.
5. In addition, `game.html` ("Challenges & Reviews" tab) and `index.html` (Scoreboard) did not display or link scoring changes.

### Implementation Architecture
1. **Multi-Browser Server-Backed Storage (`server.mjs`)**:
   - Built-in zero-dependency Node HTTP server serving static assets and persistence endpoints (`GET /api/feed-log?date=YYYY-MM-DD` and `POST /api/feed-log`).
   - Persists state to disk in `data/feed-log-<YYYY-MM-DD>.json`.
   - Merges updates from multiple browsers idempotently by stable key (`<gamePk>:<id>`), preserving baselines, history chains, irregularities, and grace windows.
2. **Shared Multi-Tier Client Module (`assets/js/feed-log.js`)**:
   - Tier 1: In-memory state (0ms latency).
   - Tier 2: `localStorage` cache for instant first paint and client-local offline cache.
   - Tier 3: Server API (`/api/feed-log`) for real-time cross-browser persistence.
   - Tier 4: Static file fallback (`data/feed-log-<date>.json`) for static hosts like GitHub Pages.
3. **Across-the-Website Integration**:
   - `reviews.html` (`assets/js/reviews-feed.js`):
     - Restores from `localStorage` immediately for instant paint.
     - Performs async background sync with server (`syncFeedLogFromServer`).
     - Sends `POST /api/feed-log` whenever new entries or rulings are tracked.
     - Syncs periodically every 15s to pick up changes made by other active browsers.
   - `game.html` (`assets/js/game.js` & `assets/js/reviews.js`):
     - Loads game's official scoring changes from the persistent feed log.
     - Displays scoring changes in the dedicated **Challenges & Reviews** tab.
     - Renders rich scoring change cards (initial call → final ruling, chips, descriptions, score-after, mechanism).
     - Adds "Scoring Changes" stat item to the summary bar.
     - Updates tab badge (`#reviews-tab-count`) to include scoring changes.
   - `index.html` (`assets/js/scoreboard.js`):
     - Loads the slate's scoring changes on schedule load.
     - Surfaces a distinct `✏️ N Scoring Change(s)` indicator on game cards.
4. **Verified Seed Data**:
   - `data/feed-log-<date>.json` files generated with verified fixtures for known 2026 dates (e.g. 2026-08-30 Guerrero Jr. #230, 2026-08-28 Okamoto #232, 2026-09-02 Clemens #243, 2026-09-05 Lile #246, 2026-09-23 today) so any browser visiting these dates receives official scoring changes immediately.

### Tests
- `tools/cross-browser-persistence-test.mjs` (4 sections):
  1. Multi-Browser: Browser 1 tracks and saves change; Browser 2 (empty `localStorage`) fetches and renders change.
  2. Game Page: `game.html` Challenges & Reviews tab renders scoring change card, chips, and stat counter.
  3. Scoreboard: `index.html` slate mapping associates scoring changes with game card.
  4. Multi-client merge: concurrent updates from separate clients merge without data loss.
- All 15 deterministic suites pass (15/15 green).

## Session-4 addition — official rows for a visitor with no server

`data/feed-log-<date>.json` only ever held dates some browser had tracked and posted to
`server.mjs`, so a visitor reading the site from GitHub Pages (no `server.mjs`) got whatever the
seed files happened to contain. `pipeline/sync-feed-log.mjs` (new) writes MLB's **confirmed**
scoring changes straight into those files:

- **Source:** `data/official/scoring-changes-<season>.json` — the committed pipeline output the
  3-hourly `official-data.yml` run refreshes. Read only: no network, no re-derivation of links.
- **Appended only when the change is verified:** `cls.kind === 'ruling_change'`, the play linked
  (`link.atBatIndex != null`) and StatsAPI's current ruling not contradicting the log
  (no `current_ruling_mismatch`). Bookkeeping entries (earned runs, RBIs, fielding credits, …),
  unlinked rulings and pending mismatches are counted in the run log and left out — never guessed.
- **Facts only:** gamePk, `review.id` = the same `scoring-<atBatIndex>` the browser mints (so a
  later browser write merges into the same row instead of duplicating it), `typeKey`
  `scoring_change`, the log's initial/final rulings, its verbatim line and URL, the flags the text
  or the link raised, and `mechanism: official_log`. Nothing is invented: `pitcher`, the scores,
  `initialDescription` and `initialObservedAt` stay `null`. The play's own inning/half is shown
  (a differing inning printed in the log is flagged and its text kept verbatim); `firstSeen`,
  `lastSeen` and `review.timestamp` record when the pipeline wrote the row, not when MLB made the
  change. Two official entries about one play become one row (latest seq wins, `changeCount`, a
  "Multiple official rulings on one play" flag).
- **The merge is `server.mjs`'s** (`mergePayloads` semantics): dedupe by `<gamePk>:<review.id>`,
  an incoming `null` never overwrites an observed value, `flags` union, the longer `history` chain
  wins, snapshots / irregularities / grace / settled are preserved, and the 500-row cap keeps the
  most recent rows and counts the rest in `trimmed`. An unchanged row keeps its previous
  `timestamp`/`lastSeen`, and a date's file is only rewritten when something actually differs —
  so a re-run, and the workflow's commit step, are no-ops.
- **Scheduling:** `.github/workflows/official-feed-log.yml` runs it after every official-data
  pipeline run (plus its own 3-hourly schedule) and commits only `data/feed-log-*.json` and
  `data/feed-log-index.json`. It only writes dates inside the last 14 days (`--days=N`).
- **Verified by** `tools/official-feed-log-test.mjs` (5 sections): the rows are fact-only and
  match the browser's own `scoringCategory`; the browser's `isHitToErrorChange` agrees with the
  pipeline classifier except the two documented cases (a home-run initial call keeps the primary
  ✏️ surface — no hit→error model exists for home runs; a StatsAPI "compatible coding" that recodes
  a reached-on-error play into the fielder's-choice family, which the row flags in words); the real
  `restoreFeedLog` restores every appended row; and the merge is idempotent through the real CLI
  against a temp `--data-dir`.

## Verification limits (flagged for review)

- **No live re-verification was possible in this session:** the sandbox has no external network (`curl https://statsapi.mlb.com/api/v1/eventTypes` → exit 35; `fetch` fails), so the registry/payload shapes above could not be re-fetched. All checks rest on the repo's live-verbatim fixtures (eventTypes + playByPlay captures of 2026-09-04, scoring log entries #230/#232) and the deterministic suites, which are all green (11/11). If the upstream registry or the scoring-changes log vocabulary drifts, the nightly API smoke test (`docs/workflows/smoke.yml`) is the tripwire — treat any smoke failure as an irregularity for review before trusting new rows.
