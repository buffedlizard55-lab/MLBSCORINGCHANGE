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
| [MLB Official Scoring Changes](https://www.mlb.com/official-information/scoring-changes) | every post-game scoring change of the current season | fetched every run |
| Internet Archive captures of that page — [2025 (2026-02-10)](https://web.archive.org/web/20260210034254/https://www.mlb.com/official-information/scoring-changes), [2024 (2025-01-21)](https://web.archive.org/web/20250121083545/https://www.mlb.com/official-information/scoring-changes) | the complete 2024 and 2025 lists | last capture after each season, found with the [CDX API](https://web.archive.org/cdx/search/cdx?url=mlb.com/official-information/scoring-changes&output=json) |
| MLB StatsAPI `/teams`, `/schedule` (game types R, F, D, L, W), `/game/{gamePk}/playByPlay` | every completed game's plate appearances: result, batter, inning, runners, fielding credits, Statcast `hitData` | a `fields` projection, verified equal to the unprojected payload on one game per season every run |
| [Baseball Savant Statcast search](https://baseballsavant.mlb.com/statcast_search) (field-error CSV) | cross-check only: counts, exit velocity / launch angle, `estimated_ba_using_speedangle` | current season, every run |

Run of 2026-09-24: 7,322 completed games (2,472 / 2,477 / 2,373), 553,300 plate appearances,
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
- **Error → hit population:** initial ruling `error` (StatsAPI `field_error`); label 1 if the
  final ruling is a hit (or hit + error). **Hit → error population:** initial hit other than a
  home run; label 1 if the final ruling is an error.
- **Settled plays only:** games at least 14 days old (changes can take days to post). The 2026
  games of the last 14 days are scored but not used for training.

## 7. Features (known at the time of the play)

- **Hit probability (xBA-style):** share of comparable batted balls that became hits, on a grid
  of exit velocity 40–120 mph (2-mph cells) × launch angle −60° to 72° (3° cells), built from
  370,650 batted balls with the training plays excluded. Empirical-Bayes smoothing (25 pseudo
  counts): cell → 3×3 block → launch-angle strip → overall. Without Statcast data: rate by
  trajectory × fielder, then trajectory, then overall. Validation: Pearson **0.974** with Savant's
  `estimated_ba_using_speedangle` on 1,003 plays (mean absolute difference 0.029).
- **Fielder group** (from `hitData.location`: P, C, 1B, 2B, 3B, SS, OF), **trajectory**
  (ground ball, line drive, fly ball, popup, bunt), standardised **exit velocity**, **batting at
  home**, **home club** (the official scorer is assigned per park).
- **Excluded on purpose:** the error type and fielding credits — after a change to a hit they
  no longer exist in the data, so they would leak the answer.

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
| λ | 3 | 1 |
| Plays / changed | 3,166 / 192 (6.06%) | 100,969 / 120 (0.12%) |
| CV AUC | 0.620 | 0.913 |
| CV log loss (base) | 0.2225 (0.2287) | 0.0074 (0.0092) |
| CV Brier (base) | 0.0560 (0.0570) | 0.00118 (0.00119) |
| Out-of-time AUC, 2026 | 0.615 (945 plays, 58 changed) | 0.934 (30,982 plays, 46 changed) |

Error → hit coefficients: intercept −2.458; logit(hit prob.) +0.339; OF +1.253; 1B +0.434;
C +0.357; 3B +0.258; P −0.030; line drive −0.488; fly ball −0.954; popup +0.050; bunt +0.499.
The home-club set was tested and **rejected** by the selection rule.

**What drives error → hit changes (raw rates, settled plays):**

| Comparable-ball hit rate | Errors | Changed to hit | Rate |
| --- | --- | --- | --- |
| 0.00–0.10 | 950 | 38 | 4.0% |
| 0.10–0.20 | 696 | 35 | 5.0% |
| 0.20–0.35 | 874 | 51 | 5.8% |
| 0.35–0.50 | 320 | 29 | 9.1% |
| 0.50–0.70 | 285 | 36 | 12.6% |
| 0.70–1.00 | 41 | 3 | 7.3% |

By fielder: outfield 11.0% (218), first base 7.5%, second base 6.4%, third base 6.2%, pitcher
5.1%, shortstop 3.8%. By trajectory: line drive 10.8% (111), ground ball 6.0% (2,810), fly ball
3.3%, popup 2.9%. By season: 6.2% / 5.9% / 6.1%.

## 9. Score bands

Scores are probabilities ×100. Bands are relative to each question's base rate:
error → hit: Low 0–4, Typical 5–8, Elevated 9–17 (≈1.5× typical), High 18–49 (≈3×), Likely 50+.
Hit → error (base 0.12%): Low 0, Elevated 1–4, High 5–49, Likely 50+.

## 10. Pending rulings

Verified finding: *Official Scorer Ruling Pending* markers (`os_ruling_pending_primary` /
`os_ruling_pending_prior`) appear in **0 of 553,300** final plate appearances — they exist only
while the ruling is pending. The distribution therefore comes from how comparable batted balls
were scored: keys trajectory × fielder × exit-velocity bin (<70, 70–85, 85–95, 95–105, 105+) ×
launch-angle bin (<−10, −10–5, 5–15, 15–25, 25–40, 40+) × whether the batter reached safely,
each level shrunk toward the coarser one (20 pseudo counts; cells need ≥30 plays). A `prior`
marker refers to the previous plate appearance, whose batted ball is used. The live feed logs
each pending ruling's resolution, which allows calibrating this with real outcomes later.

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

## 13. Reproduce

```bash
node tools/pipeline-offline-smoke.mjs   # end-to-end on a synthetic stub (offline)
node pipeline/run.mjs                   # real run — needs access to MLB hosts (GitHub Actions)
node pipeline/run.mjs --seasons=2026 --max-games=50 --no-savant   # quick partial run
```
