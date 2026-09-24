# Scoring-change model — methodology

This document describes exactly what `pipeline/` computes and what
`assets/js/scoring-model.js` scores. Numbers quoted are from the pipeline run of
**2026-09-24** (GitHub Actions run 36044396417); the live values are always in
`data/model/scoring-model.json`, `data/model/pipeline-report.json` and on
[`scoring.html`](../scoring.html) → Model.

## 1. Questions answered

| Question | Output | Used on |
| --- | --- | --- |
| **Error → hit**: will a play scored *reached on error* be officially changed to a hit? | probability → score 0–100 | 🎯 Error Watch, ✏️ Scoring Change rows, Official Changes |
| **Hit → error** (non-home-run hits): will a hit be changed to an error? | probability → score 0–100 | ✏️ Scoring Change rows, Official Changes |
| **Pending ruling**: for an *Official Scorer Ruling Pending* play, what will the final ruling be? | distribution over hit / error / fielder's choice / out / sacrifice / other | ⚖️ Scoring Pending rows |

Every row also shows the **final result**: the play's current official ruling (live, from
StatsAPI) and, once posted, the matching entry in MLB's official log.

## 2. Sources

| Source | What we take | Access |
| --- | --- | --- |
| [MLB Official Scoring Changes](https://www.mlb.com/official-information/scoring-changes) | the scoring changes MLB publishes for the current season | fetched every run |
| Internet Archive captures of that page — [2025 (2026-02-10)](https://web.archive.org/web/20260210034254/https://www.mlb.com/official-information/scoring-changes), [2024 (2025-01-21)](https://web.archive.org/web/20250121083545/https://www.mlb.com/official-information/scoring-changes) | the complete 2024 and 2025 lists | last capture after each season, found with the [CDX API](https://web.archive.org/cdx/search/cdx?url=mlb.com/official-information/scoring-changes&output=json) |
| MLB StatsAPI `/teams`, `/schedule` (game types R, F, D, L, W), `/game/{gamePk}/playByPlay` | every completed game's plate appearances: result, batter, inning, runners, fielding credits, Statcast `hitData` | a `fields` projection, verified equal to the unprojected payload on one game per season every run |
| [Baseball Savant Statcast search](https://baseballsavant.mlb.com/statcast_search) (field-error CSV) | cross-check only: counts, exit velocity / launch angle, `estimated_ba_using_speedangle` | current season, every run |
| MLB StatsAPI `/api/v1.1/game/{gamePk}/feed/live?fields=gameData,officialScorer,id,fullName,venue,name` | official scorer and venue of every game (§17) | once per game, cached |
| Live capture — `data/capture/` (this project, from StatsAPI playByPlay during live games) | rulings as first called, error type, pending markers and their resolutions (§14) | every 10 min during game hours |

Run of 2026-09-24 (20:15 UTC): 7,323 completed games (2,472 / 2,477 / 2,374), 553,370 plate appearances,
0 fetch failures, projection self-check equal in all three seasons.

## 3. Reading the official log

- **Formats (verified on the pages):** 2026 is an HTML `<ol>` whose items carry *no* number —
  the browser draws "1.", "2.", … so the entry number is the list position. 2024/2025 use text
  numbers "N) …". Variants seen and handled: single-hyphen separator (2024 #1–7), `ARI-LAD`
  (2024 #77), `SD at SF` (2025 #157), doubleheader suffixes (`CLE2`, `GM2`, `(GM1)`), `BOS@NYY!`,
  missing dates or innings, and inning text without the word "inning" (2026).
- **Result:** 229 (2024), 211 (2025, incl. 1 postseason) and 253 (2026) entries, no numbering gaps.
- **Provenance:** each season file stores the source URL, capture time, byte size and SHA-256 of
  the HTML; `data/official/raw/scoring-changes-<season>.txt` keeps the verbatim entry lines.

## 4. Classifying entries

Each ruling phrase is put in a category: `hit`, `hit+error`, `error`, `fc`, `fc+error`, `sac`,
`sac+error`, `out`, `other_pa` (walk / HBP / interference) or `other`. Templates, in order:

| Rule | Pattern (examples from the real log) |
| --- | --- |
| T1 | "*new* … instead of *old*" — both sides must be play rulings |
| T3 | "the *old* for/charged to NAME has been changed to *new*"; also "Nathaniel Lowe's single has been changed to a fielder's choice" |
| T2 | "originally ruled/scored", "the original ruling was", "had been credited with/scored", "it was originally …", "what was ruled …" + the nearest clause stating the new ruling |
| T4 | "NAME now has a single … the error … remains" |

Anything else is bookkeeping (base running, wild pitch / passed ball, putouts / assists,
fielding sequences, RBI, earned runs, error removed / added, sacrifice credit, double-play
credit, win / loss / save) or `unclassified` (flagged). Clauses such as "removing the error"
do not count as an error. After this pass: 1 / 2 / 0 unclassified entries (2024 / 2025 / 2026).

## 5. Linking each entry to its play, and verifying it

1. **Game:** team codes via StatsAPI `abbreviation` / `teamCode` / `fileCode`, plus documented
   aliases (CHW→CWS, WAS→WSH, ARI↔AZ, OAK↔ATH, …). Fallbacks, each **flagged**: ±3 days,
   swapped home/away, same-date correction of a mistyped code when that club played exactly one
   game that day against a similarly coded opponent (`TBN@TOR` → TB; `TOR@LAA` → LAD), ±10 days.
2. **Plate appearance:** a batter of that half-inning whose full name (or unique last name, or a
   last name within edit distance 2 — flagged) appears in the text; among candidates, prefer the
   one whose current ruling agrees with the new ruling, then the earliest mention.
3. **Verification against StatsAPI's current ruling:** `exact`, `compatible` or `mismatch`.
   *Compatible* encodes conventions verified on linked plays: a sacrifice fielder's choice is
   coded `sac_bunt` (2026 #123, #186; 2025 #102); reaching on an error on a play with another
   fielding event is coded in the fielder's-choice family (2024 #28, #141; 2025 #44; 2026 #56).
4. **Chains:** several entries about one play are ordered; earlier entries replaced by a later
   one are marked `superseded_by` (e.g. 2024 #14 → #24).

Run of 2026-09-24: 662 of 693 entries linked to their exact play; every error → hit entry
linked. Remaining flags (56 entries) are listed on the Irregularities tab — including genuine
errors in MLB's log (e.g. 2026 #140 "6/6 NYM@PHI": that day PHI hosted CWS per
[StatsAPI](https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=2026-06-05&endDate=2026-06-07&teamId=143)).

## 6. Labels

- A plate appearance's **initial** ruling is the first linked entry's old ruling; its **final**
  ruling is the last entry's new ruling. A chain is used only if its last entry agrees with the
  play's current StatsAPI ruling; otherwise the play keeps its current ruling and the entry stays
  flagged. Plays with no entry: initial = final = current ruling.
- An error → error entry labels a play only if that play itself is scored an error: on any
  other play it concerns a runner's error (e.g. 2025 #128) and says nothing about the batter's
  ruling. Such entries whose play carries a runner error in StatsAPI are flagged
  `runner_error_change:verified` instead of a mismatch.
- **Error → hit population:** initial ruling `error` (StatsAPI `field_error`); label 1 if the
  final ruling is a hit (or hit + error). **Hit → error population:** initial hit other than a
  home run; label 1 if the final ruling is an error.
- **Settled plays only:** games at least 14 days old (changes can take days to post). The 2026
  games of the last 14 days are scored but not used for training.

## 7. Features (known at the time of the play)

- **Hit probability (xBA-style):** share of comparable batted balls that became hits, on a grid
  of exit velocity 40–120 mph (2-mph cells) × launch angle −60° to 72° (3° cells), built from
  370,696 batted balls with the training plays excluded. Empirical-Bayes smoothing (25 pseudo
  counts): cell → 3×3 block → launch-angle strip → overall. Without Statcast data: rate by
  trajectory × fielder, then trajectory, then overall. Validation: Pearson **0.974** with Savant's
  `estimated_ba_using_speedangle` on 1,003 plays (mean absolute difference 0.029).
- **Fielder group** (from `hitData.location`: P, C, 1B, 2B, 3B, SS, OF), **trajectory**
  (ground ball, line drive, fly ball, popup, bunt), standardised **exit velocity**, **batting at
  home**, **home club** and **official scorer** (candidates only — see §17).
- **Excluded from the historical fit on purpose:** the error type and fielding credits — after a
  change to a hit they no longer exist in the data, so they would leak the answer. The error type
  enters only through the captured-data adjustment (§15), which uses the type *as captured live
  before any change*.
- Inputs that can be unknown when a play is scored live (the game's official scorer before it is
  loaded; the error type of a play that was already changed) take the term's training mean — the
  average effect — never silently the reference group's effect.

## 8. Fitting and selecting

- L2-regularised logistic regression (Newton–Raphson; intercept not penalised), λ ∈ {0.3, 1, 3, 10}.
- 10-fold cross-validation **grouped by game** (a deterministic hash of `gamePk`).
- Candidate feature sets from intercept-only up to all features (+ home club). Rule: the
  **simplest model within one standard error** of the best cross-validated log loss, using the SE
  of *paired* per-play loss differences.
- Scores for training plays shown on the site are **out-of-fold** (the play was not used to fit
  the model that scored it).
- **Out-of-time check:** fit on 2024–2025, predict settled 2026 plays.

**Selected models (run of 2026-09-24)**

| | Error → hit | Hit → error |
| --- | --- | --- |
| Terms | logit(hit prob.), fielder group (P, C, 1B, 3B, OF vs 2B/SS), trajectory | logit(hit prob.), infield, trajectory |
| λ | 1 | 1 |
| Plays / changed | 3,161 / 189 (5.98%) | 100,972 / 120 (0.12%) |
| CV AUC | 0.609 | 0.913 |
| CV log loss (base) | 0.2199 (0.2264) | 0.0074 (0.0092) |
| CV Brier (base) | 0.0549 (0.0562) | 0.00118 (0.00119) |
| Out-of-time AUC, 2026 | 0.622 (944 plays, 58 changed) | 0.934 (30,982 plays, 46 changed) |

Error → hit coefficients: intercept −2.485; logit(hit prob.) +0.350; OF +1.919; 1B +0.521;
C +0.602; 3B +0.314; P −0.025; line drive −1.178; fly ball −1.876; popup +0.074; bunt +0.775.
The home-club and official-scorer sets were tested and **rejected** by the selection rule (§17).

**What drives error → hit changes (raw rates, settled plays):**

| Comparable-ball hit rate | Errors | Changed to hit | Rate |
| --- | --- | --- | --- |
| 0.00–0.10 | 949 | 38 | 4.0% |
| 0.10–0.20 | 696 | 35 | 5.0% |
| 0.20–0.35 | 872 | 50 | 5.7% |
| 0.35–0.50 | 320 | 29 | 9.1% |
| 0.50–0.70 | 283 | 34 | 12.0% |
| 0.70–1.00 | 41 | 3 | 7.3% |

By fielder: outfield 9.8% (215), first base 7.5%, second base 6.4%, third base 6.2%, pitcher
5.1%, shortstop 3.8%. By trajectory: line drive 9.2% (109), ground ball 6.0% (2,808), fly ball
2.6%, popup 2.9%. By season: 6.1% / 5.7% / 6.1%.

## 9. Score bands

Scores are probabilities ×100. Bands are relative to each question's base rate:
error → hit: Low 0–3, Typical 4–8, Elevated 9–17 (≈1.5× typical), High 18–49 (≈3×), Likely 50+.
Hit → error (base 0.12%): Low 0, Elevated 1–4, High 5–49, Likely 50+.

## 10. Pending rulings

Verified finding: *Official Scorer Ruling Pending* markers (`os_ruling_pending_primary` /
`os_ruling_pending_prior`) appear in **0 of 553,300** final plate appearances — they exist only
while the ruling is pending. The distribution therefore comes from how comparable batted balls
were scored: keys trajectory × fielder × exit-velocity bin (<70, 70–85, 85–95, 95–105, 105+) ×
launch-angle bin (<−10, −10–5, 5–15, 15–25, 25–40, 40+) × whether the batter reached safely,
each level shrunk toward the coarser one (20 pseudo counts; cells need ≥30 plays). A `prior`
marker refers to the previous plate appearance, whose batted ball is used. Captured pending
rulings and their resolutions recalibrate this distribution (§16).

## 11. Live integration (reviews.html)

- The feed's hot-path playByPlay projection is unchanged. Statcast `hitData` comes from a
  separate projection (`MLB.getPlayHitData`), requested only for games with an error, a pending
  ruling or an observed change, at most every 15 s per game.
- 🎯 **Error Watch** tracks each `field_error` plate appearance of the date, re-reads its current
  ruling every poll and shows the change when it happens. It is not a feed entry, so it never
  triggers the alert sound and is not written to the feed log.
- The official-log confirmation ("✓ Official MLB log #N") comes from
  `data/official/scoring-changes-<season>.json`, refreshed every 30 minutes.
- Game pages (`game.html`): the Challenges & Reviews tab's scoring-change and pending cards get
  the same model line through a guarded hook in `reviews.js` `renderReviewCard`; `game.js` scores
  from the page's own live feed (which already carries `hitData`) via the shared pure
  `MLBScoringModel.scoreReview`.
- Without `assets/js/scoring-model.js` or the model file, everything renders as before.

## 12. Operations

- **Season rollover:** seasons default to 2024 through the current year. The live page serves
  every season it lists; archived seasons reuse their stored parse (the Internet Archive is
  fetched once per capture); a season the live page stops listing is served from the stored copy.
  The "current" season is the latest one with completed games. The site reads seasons from the
  report and `data/model/error-watch.json`, so no yearly code edit is needed.
- **Failures:** a failed run exits non-zero, leaves every data file untouched and keeps the last
  good `pipeline-report.json`, adding `fatal` and `failedAt`; `scoring.html` shows the notice.
  A live page with no season header at all (structure change) writes an excerpt to `_probe/`
  and a warning.
- **Freshness:** every 3 hours on `main`; the workflow also requests a GitHub Pages rebuild.
- **Live capture:** every 10 minutes during game hours (15:00–08:59 UTC, March–November) on
  `main` (`.github/workflows/live-capture.yml`); a run with no live games exits in seconds and
  commits nothing. `tests.yml` ignores data-only pushes.

## 13. Reproduce

```bash
node tools/pipeline-offline-smoke.mjs   # end-to-end on a synthetic stub (offline)
node pipeline/run.mjs                   # real run — needs access to MLB hosts (GitHub Actions)
node pipeline/run.mjs --seasons=2026 --max-games=50 --no-savant   # quick partial run
node tools/capture-test.mjs             # live capture, offline (synthetic stub)
node pipeline/capture.mjs --polls=1     # real capture poll — needs access to MLB hosts
```

## 14. Live capture — why and how

**Verified finding (2026-09-24): MLB StatsAPI rewrites history.** After a scoring change, the
time-machine endpoints return the *new* ruling even for moments before the change:

- 2026 official log #3 — "Ozzie Albies now has a single instead of … an error charged to Max
  Muncy" (game 824943, at-bat 36, ended 00:28:35 UTC). The `diffPatch` that completed the play
  ([00:28:22 → 00:28:35](https://statsapi.mlb.com/api/v1.1/game/824943/feed/live/diffPatch?startTimecode=20260331_002822&endTimecode=20260331_002835))
  already writes `"eventType":"single"` with an `f_fielded_ball` credit, and the
  [00:30:00 snapshot](https://statsapi.mlb.com/api/v1.1/game/824943/feed/live?timecode=20260331_003000&fields=liveData,plays,allPlays,result,eventType,description,atBatIndex)
  shows "Ozzie Albies singles on a ground ball to third baseman Max Muncy."
- 2026 official log #6 — Brandon Nimmo, game 824863 at-bat 48 (ended 00:20:50 UTC): the
  [00:21:30 snapshot](https://statsapi.mlb.com/api/v1.1/game/824863/feed/live?timecode=20260331_002130&fields=liveData,plays,allPlays,result,eventType,atBatIndex)
  already says `single`.
- The game's `timestamps` list ends when the game ends — later edits have no timecode of their own.

So a play's original call — and its error type — can only be known if it was recorded before it
changed. `pipeline/capture.mjs` does that:

- Every 10 minutes during game hours it reads the day's schedule (`hydrate=team`) and polls the
  play-by-play of every game in progress 4 times, 2 minutes apart (projection = the pipeline's
  plus `isComplete` and `endTime`); games that finished in the last 14 hours are polled once.
  Spring-training and exhibition games are skipped.
- It records every plate appearance scored `field_error` and every plate appearance an
  *Official Scorer Ruling Pending* marker refers to (detected with the site's own
  `MLBReviews.findOfficialScoringPendingPlay`; a `prior` marker points at the previous plate
  appearance). The marker's raw fields are stored verbatim.
- Each entry keeps `states` — the ruling as first seen, then one new state per change of event
  type / error type / charged position / pending marker (wording-only edits are ignored) — plus
  the batted ball and the score the published model gave at capture time.
- Plays first seen more than 6 hours after they ended are not added (not "live"). The pipeline
  counts a first state as the *original call* only if it was seen within **30 minutes** of the end
  of the play.
- Files: `data/capture/rulings-YYYY-MM.json`, one play per line, byte-stable; a file is rewritten
  only when a ruling is captured or changes (idle runs create no commits). `status.json` is a
  heartbeat rewritten at most every 3 hours when nothing changes.

## 15. Error type — the captured-data adjustment

- **Rows:** captured errors whose first state is within 30 minutes of the play and whose game is
  ≥ 14 days old (settled). Label: the play's current ruling (from the pipeline's fresh
  play-by-play) is a hit. Unlike the historical labels (official log only), this also counts
  changes made during the game.
- **Model:** logit P = main-model logit (out-of-fold where available) + shift + error-type terms
  (`kind:throwing`, `kind:missed_catch`; fielding = reference), every coefficient L2-shrunk toward
  0, i.e. toward "the main model is right".
- **Selection:** 5-fold CV grouped by game; the simplest candidate (none → shift → shift + error
  type) within one paired standard error of the best. **Gates:** ≥ 8 changes to try a shift; ≥ 15
  changes and ≥ 150 errors to try error-type terms. Status is published (`collecting`,
  `not_selected`, `active`); only `active` changes a score.
- **Early evidence (descriptive, not used in scores):** the official log names the original error
  type for part of the changes, in its own wording. `originalErrorKindFromLog` reads only the
  clause that describes the original call ("instead of …", "(was) originally …"), so a new
  ruling's own errors are ignored. The pipeline compares each type's share among those changes with
  its share among errors that stood (`errorToHit.errorKind.impliedRelativeRate`). This assumes the
  log's wording does not depend on the type — which cannot be checked — so it is shown as context
  only.

## 16. Pending rulings — calibration from captured outcomes

- **Rows:** captured pending rulings with a known resolution (the first later state without a
  marker, or the play's final ruling). Prediction: the comparable-ball distribution (§10) for the
  play, from the current model.
- **Calibration:** per-outcome weights w_o = (observed_o + 5) / (expected_o + 5), applied by
  multiplying and renormalising. With few rulings the weights stay near 1.
- **Validation and gate:** leave-one-out log loss of the calibrated distribution vs the raw one;
  used only with ≥ 10 resolved rulings **and** a lower leave-one-out log loss. Brier score and
  top-pick accuracy are reported too.
- **Bias to keep in mind:** polling every 2 minutes for about 6 of every 10 minutes misses some
  short-lived markers, so captured pending rulings lean toward longer decisions.

## 17. Official scorer and home park

- `gameData.officialScorer` {id, fullName} and `gameData.venue` come from a ~150-byte
  `feed/live` projection per game (verified on games 824943 and 745444), cached for good.
- **Permutation test** (every run, all seasons): with out-of-fold probabilities from the best
  model *without* group terms, T = Σ_groups (O − E)² / V (O = changes, E = Σ p, V = Σ p(1 − p)).
  Group labels are shuffled across plays (2,000 times for error → hit, 500 for hit → error; fixed
  seed) to get T's null distribution. Dispersion T / groups ≈ 1 means no difference.
- **Predictive test:** a candidate model with one term per official scorer (≥ 40 plays) and one per
  home club enters the same cross-validated selection as every other candidate (§8). Scorer or
  park terms reach the scores only if selected. The live feed then looks up the game's scorer
  (one tiny request per game, made only when the published model has scorer terms); until then,
  the average scorer effect is used.
- **Per-scorer table** on the site: plays, changes, expected, O/E and O/E shrunk toward 1
  ((O + 10) / (E + 10)). Read it with the test: when the test finds no difference, the spread is
  mostly chance.
