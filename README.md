# ⚾ MLB Scoring Changes — MLB Live PBP + scoring-change model

**Live site (this copy):** <https://buffedlizard55-lab.github.io/MLBSCORINGCHANGE/> ·
[Replay Feed](https://buffedlizard55-lab.github.io/MLBSCORINGCHANGE/reviews.html) ·
[✏️ Scoring Changes](https://buffedlizard55-lab.github.io/MLBSCORINGCHANGE/scoring.html)
**Original site (never modified from here):** <https://buffedlizard55-lab.github.io/MLB-Live-PBP/reviews.html>

---

## 📌 Start here — project charter

> **Read this section at the start of every work session.** It is the project's starting
> point: what we are building, for whom, and how we decide. Everything below it is
> reference material.

### The request (verbatim)

> Review the repo. We are going to reverse engineer this site https://buffedlizard55-lab.github.io/MLB-Live-PBP/reviews.html Basically just copy the entire repo since it functionally works very well and i use it everyday. I don't want to break anything on this site so I want to create a copy that I can work on. Let's create a scoring-change model and integrate it into observed, captured, and any logged events that the alert system detects. We should aim to provide a score out of 100 whether the observed, captured, and logged event will be overturned from an error to a single, also for any scoring pending will be changed to a single, error, out, fielders choice, out, etc. We should include both the expected chance it will be overturned as well as the final result of the event.

> Put this prompt into the repo readme and read it everytime we work on the project as a starting point to make sure we are building what we are aiming for and have a strong base to continue building and improving on making something useful for everyday use. It should solve the problem of having to manually check everything ourselves and having an up to date current feed.

### Follow-up request — session 2 (verbatim)

> 1. Train on the rulings your feed captures live (error type included). This is the biggest available accuracy gain for error→hit.
> 2. Calibrate the pending chances with the outcomes the feed now logs.
> 3. Re-test official-scorer (home park) effects as seasons accumulate; the data doesn't support them yet.

### Follow-up request — session 3 (verbatim)

> I think we should also track anytime a final scoring decision would change a single to an error, but that would require tracking every single hit, which would cause too much bloat in the primary alert system. We need to create a section for anything that changes a single to an error and keep it from populating the main primary alert system, which is error to a single, also for any scoring pending will be changed to a single, error, out, fielders choice, out, etc.

(The first line quotes a suggestion made at the end of session 1. Session 2 found the evidence
does not support "biggest gain" for error *type* itself — see *Current results* — but the live
capture it required is built and running.)

### The xBA conversation that framed the model (condensed — not verbatim)

- **Q:** *How is xBA calculated on Baseball Savant?* — **A (summary):** xBA asks "given how this
  ball was hit, how often do comparable balls become hits?", using historical Statcast data
  (exit velocity, launch angle, and sprint speed on weakly hit balls); each batted ball gets a
  probability (e.g. 105 mph / 20° → .850, 75 mph / 5° → .080), strikeouts count as outs, and it
  removes positioning, range and luck. Savant exposes it as `estimated_ba_using_speedangle`.
- **Q (the flaw):** *Both of those balls were ruled outs — but suppose both reached base on a play
  first ruled an **error**. What is the chance the final ruling becomes a **hit**?* — **A (summary):**
  xBA is not the chance an official scorer overturns a ruling. That needs its own model,
  P(final hit | initial error, exit velocity, launch angle, location, fielder, play type, …),
  learned from historical changed rulings; the answer's illustration ("Play A .080 → 5%,
  Play B .850 → 70%") was hypothetical. Initial ruling → later ruling (groundout → error,
  error → single, single → error, fielding error → hit) is a scoring-change model.
- **What the official data actually shows (this project, 2024–2026):** errors on balls that
  comparable batted balls turn into hits 50–70% of the time were changed to hits **12.0%**
  of the time (34 of 283); errors on weak contact (under 10%) **4.0%** (38 of 949). A real,
  roughly 3× effect — but most errors, even on well-struck balls, stand.

### Standing instructions (from the same request)

- Copy the **entire** source repo; never break or modify the original site.
- Work line by line; verify from official / trusted sources and give links for manual review;
  **no hallucinations**.
- Work autonomously (no manual input needed); **flag irregularities** for review, never hide them.
- "The goal of this project is to get a full list that follow our requirements."
- Keep Arena's Core Values **Maximize P(Win)** and **Own the Outcome** as focal points.
- GitHub Pages site: clean, user friendly, simple, organized, all relevant information easy to
  read, with official verified source links.
- Work in passes (implement → review for bugs / gaps / wrong assumptions → re-check against
  this charter); open a PR, merge to `main`, and report remaining work and limitations.

### Acceptance checklist — where each requirement lives

| Requirement | Where it is implemented |
| --- | --- |
| Exact copy; original untouched | Commit `ddca0b8` = original at `859e958`. Browser storage isolated (`mlbScoringChange.*` keys, `tools/storage-namespace-test.mjs`) because both sites share one origin. |
| Score /100: error → single | `assets/js/scoring-model.js` `scoreErrorToHit`, shown on **🎯 Error Watch** rows and ✏️ Scoring Change rows (live feed) and on `scoring.html`. |
| Pending ruling → single / error / FC / out … | ⚖️ Scoring Pending rows (feed and game page) show "Likely final ruling" chances (`pendingDistribution`). |
| Observed, captured and logged events | *Observed*: every live `field_error` play (Error Watch). *Captured*: rulings the feed saw change (✏️ rows). *Logged*: MLB's official log, parsed and linked play-by-play (`data/official/`). |
| Expected chance **and** final result | Every row shows both: the pre-change chance and the live / official final ruling. |
| Full list | `scoring.html` → Official Changes (every entry, 2024–2026) and Error Watch (every error of the season). |
| Up to date, no manual checking | `.github/workflows/official-data.yml` rebuilds everything from official sources every 3 hours; the live feed polls StatsAPI continuously. |
| Official source links | Every row links to Gameday / Baseball Savant / StatsAPI / the official MLB log. |
| Irregularities flagged | `data/official/irregularities.json` → `scoring.html` ⚑ Irregularities (e.g. log typos like `TBN@TOR`, games that do not exist on the stated date). |
| Train on live-captured rulings, error type included (follow-up 1) | `pipeline/capture.mjs` + `.github/workflows/live-capture.yml` record every error call and pending marker as first called → `data/capture/`; the pipeline's captured-data adjustment (`pipeline/lib/adjust.mjs`) switches on by itself once enough captured errors settle and cross-validation shows a gain. Status on `scoring.html` → Model. |
| Calibrate pending chances with logged outcomes (follow-up 2) | Captured pending rulings + resolutions → per-outcome weights, leave-one-out validated (`pendingCalibration`); applied in the feed and on game pages when active. |
| Re-test official-scorer / home-park effects (follow-up 3) | Every pipeline run: official scorer of every game (`gameData.officialScorer`), permutation test + cross-validated candidate (`pipeline/lib/effects.mjs`); verdict and per-scorer table on `scoring.html` → Model. |
| Track single → error changes in their own section, OUT of the primary alert system (session 3) | Live feed: `isHitToErrorChange` (`assets/js/reviews-feed.js`) — a non-HR hit → `field_error` change is excluded from the All feed, the ✏️ Scoring Changes tab and the alert chime, and renders only in the **📉 Hit → Error** tab (with its pre-change chance /100 and the final result). Season list: `scoring.html` → **📉 Hit → Error** (every official hit→error change 2024–2026, each entry classified, linked to its play where found and checked against the play's current StatsAPI ruling — mismatches flagged, never hidden). Same definition everywhere: the pipeline's `hitToError` classifier flag. |
| …without tracking every single (no bloat) | Detection reuses the compact per-play classification baselines the scoring tracker already keeps for every completed play (one small snapshot per play, never a feed row); only a *confirmed* change mints a row. Season-long confirmation comes from MLB's official log via the 3-hourly pipeline, not from scanning hits. |

## 🧭 Arena Core Values — focal points

- **Maximize P(Win)** — “Maximize the Probability of Winning”: our decision making framework. In every decision, we weigh tradeoffs, assess risk, and choose the path that maximizes the probability that Arena succeeds. We set aside our emotions and make tough decisions in order to maximize P(Win). “Maximize P(Win)” frees us from constraints and clarifies that we must put Arena first.
- **Own the Outcome** — We own results end to end — not just our individual slice of the work. When problems arise and we have the means to act, we do so without waiting for permission or assignment. We treat failure and success as signals and use them to improve. At Arena, we stay accountable to the final outcome.

How they shaped this project: we optimise for what actually helps the daily user (a ranked
watch-list plus the final result, refreshed automatically) rather than impressive-looking
numbers; accuracy is reported out-of-sample, with calibration, and weak spots are stated
plainly; every data problem found is either fixed at the source or flagged in public.

## What this copy adds

1. **🎯 Error Watch** (live feed tab) — every play scored "reached on error" today, with its
   0–100 chance of becoming a hit, the batted ball, the live final ruling and, once MLB posts it,
   the official-log confirmation. It never triggers sounds and is not saved into the feed log.
2. **Model lines on existing rows** — ✏️ Scoring Change rows show the pre-change chance and the
   final result; ⚖️ Scoring Pending rows show the chances of each final ruling — in the Replay
   Feed and on each game page's Challenges & Reviews tab.
2a. **📉 Hit → Error sections** (session-3 charter) — a play first ruled a single (or
   double/triple) whose final ruling is an error is tracked, logged and persisted like any
   other change, but deliberately kept OUT of the primary alert system (the All feed, the ✏️
   Scoring Changes tab and the alert chime). It lives in its own **📉 Hit → Error** tab on the
   live feed — with the pre-change chance /100 and the final result on every row — and in the
   **📉 Hit → Error** section of `scoring.html` (every officially logged hit→error change,
   2024–2026). No every-single tracking: detection reuses the compact per-play baselines the
   scoring tracker already keeps, so the feed never fills with single-by-single noise.
3. **✏️ Scoring Changes page** (`scoring.html`) — Error Watch for the whole season, MLB's
   official list for 2024–2026 (verbatim, classified, linked to the exact play and checked against
   its current ruling), the model card (accuracy, calibration, what drives changes, limitations)
   and the irregularities list.
4. **Official-data pipeline** (`pipeline/`, runs on GitHub Actions every 3 hours) — parses the
   official log (live page for 2026; Internet Archive captures for 2024 and 2025), scans every
   completed game's play-by-play, links and verifies each entry, fits the models, cross-checks
   against Baseball Savant, and commits `data/official/*.json` and `data/model/*.json`. It rolls
   over to new seasons by itself, reuses the immutable archive captures, and after a failed run
   keeps the last good data online with a visible failure notice.
5. **📡 Live ruling capture** (`pipeline/capture.mjs`, every 10 minutes during game hours on
   GitHub Actions) — MLB StatsAPI rewrites its history after a scoring change (verified: its
   time-stamped snapshots show the *new* ruling even for moments before the change), so the
   original call of a play exists only if it is recorded before it changes. The capture records
   every "reached on error" call — with its error type (fielding / throwing / missed catch) — and
   every "Official Scorer Ruling Pending" marker as first seen, plus each later change, in
   `data/capture/`. The pipeline turns that into a leakage-free training set (error-type
   adjustment) and into the pending-ruling calibration; both switch on automatically once the data
   supports them. Error Watch rows show the error type and when the call was captured.
6. **Official scorer & home park re-tested every run** — the official scorer of every game is
   looked up; a permutation test and a cross-validated candidate model decide whether scorer or
   park terms belong in the scores (so far: no).

## Current results (pipeline runs of 2026-09-24; the site always shows the latest)

| | Error → hit | Hit → error |
| --- | --- | --- |
| Settled plays / changed | 3,161 / 189 (6.0%) | 100,972 / 120 (0.12%) |
| Cross-validated AUC (by game) | 0.609 | 0.913 |
| Out-of-time AUC (fit 2024–25 → predict 2026) | 0.622 | 0.934 |
| Log loss vs always-base-rate | 0.2199 vs 0.2264 | 0.0074 vs 0.0092 |

- Coverage: 7,323 completed games; 553,370 plate appearances; 693 official entries
  (229 + 211 + 253) with 662 linked to their exact play.
- The xBA-style hit probability (370,696 batted balls) correlates **0.974** with Savant's
  `estimated_ba_using_speedangle` on the same plays; all 1,015 regular-season 2026 errors match
  Savant exactly.
- Calibration (error → hit): plays scored 5–10 were changed 6.0% of the time; 10–20 → 12.0%.
- Label clean-up (session 2 review): 3 official entries no longer count as error → hit — they are
  RBI / runner changes on a hit (2024 #49, 2025 #55, 2025 #128) — and runner-level error → error
  entries no longer label the batter's play (3 spurious "error that stood" rows removed).
- Full methodology: [`docs/MODEL.md`](docs/MODEL.md).

**Official scorer & home park (follow-up 3)** — official scorer found for all 7,323 completed
games (88 / 92 / 82 scorers in 2024 / 2025 / 2026); re-tested on every run:

| Question · grouping | Groups | Dispersion (1 = no difference) | Permutation p | Cross-validated candidate | Verdict |
| --- | --- | --- | --- | --- | --- |
| Error → hit · official scorer | 101 | 1.04 | 0.32 | log loss +0.0014 vs best (SE 0.0011) | not used |
| Error → hit · home club | 31 | 1.01 | 0.38 | +0.0022 (SE 0.0016) | not used |
| Hit → error · official scorer | 103 | 0.81 | 0.90 | — | not used |
| Hit → error · home club | 31 | 0.71 | 0.85 | — | not used |

**Error type (follow-up 1)** — early evidence from past seasons, descriptive only. The official
log names the original error type for 54 of the 189 error → hit changes (fielding 28, throwing 20,
missed catch 6; 119 say only "an error", 16 have no "instead of / originally" clause). Compared
with the errors that stood (fielding 61%, throwing 34%, missed catch 5%), throwing errors were
**not** changed less often (ratio 1.09); missed-catch errors about twice as often (2.22, from
only 6 changes). So error type is probably a
modest signal, not the large one suggested at the end of session 1. The live capture now measures
it properly; the adjustment turns on only if cross-validation confirms a gain.

**Live capture** — first capture 2026-09-24 20:00 UTC (MIA @ CHC: Esteury Ruiz reaches on a
fielding error by 3B Pedro Ramírez — recorded with its error type, batted ball and the 5/100 score
shown then). Error-type adjustment and pending calibration: *collecting* until enough captured
plays settle (≥ 8 changes for a shift; ≥ 15 changes and ≥ 150 errors for error-type terms;
≥ 10 resolved pending rulings).

## Limitations (read before trusting a number)

- Error → hit discrimination is **modest** (AUC ≈ 0.62). Scores rank a watch-list; they do not
  decide a play. Scores cluster between 2 and 30; bands ("Elevated", "High") are relative to the
  6% base rate.
- "Official Scorer Ruling Pending" markers are **not kept** in final play-by-play (0 of 553,300
  plate appearances), so pending-ruling chances start from how comparable batted balls were
  scored; the captured pending rulings recalibrate them once ≥ 10 are resolved and the
  calibration wins a leave-one-out test.
- The **original error type** of past plays that were changed to hits is gone from MLB's data
  (StatsAPI's snapshots are rewritten), so it can only be learned from plays captured live from
  2026-09-24 on. With about 6% of errors changed, it will take roughly a season of captures
  before the error-type terms can be tested — the status is shown on the Model tab.
- The capture polls every 2 minutes for about 6 of every 10 minutes, 15:00–08:59 UTC, March to
  November; GitHub can delay scheduled runs. Very short-lived pending markers can be missed (so
  captured pending rulings lean toward longer decisions), and games outside those hours (e.g.
  Tokyo openers) are not captured. The feed's own browser log stays in each browser and is not
  used for training.
- Training labels come from MLB's official log. Changes made during a game may not appear in it
  (not verified either way); the live capture now sees them directly and the Model tab counts
  captured changes that are not (yet) in the log.
- StatsAPI does not always apply a logged change (e.g. 2026 #13: the log says Alex Freeland now
  has a single, while StatsAPI still shows the original sacrifice). Entries whose play's current
  ruling disagrees with the log are flagged and kept out of training labels.
- Prior seasons depend on Internet Archive captures of MLB's page (2025: 2026-02-10 capture;
  2024: 2025-01-21 capture).

## Remaining work (next sessions)

- Let the live capture run: check `data/capture/status.json` and the Model tab's *Live capture*
  table after game days (plays captured, changes seen live, changes not in MLB's log).
- When the error-type adjustment or the pending calibration turns *active*, review its
  coefficients / weights and calibration on the Model tab before relying on it.
- Scorer / park effects: nothing to do unless the verdict changes (it is re-tested every run).
- Model headroom beyond error type: the log's own changes are ~6% of errors, so further gains
  most likely need new inputs (fielder range / sprint speed from Savant, play description text).
- Optional opt-in alert when an error's score is "High".

## Working on this repo

1. Read the charter above. 2. Check the latest pipeline report
   (`data/model/pipeline-report.json`: warnings, `fatal`) and `data/official/irregularities.json`.
3. Run the tests: `for t in tools/*-test.mjs tools/pipeline-offline-smoke.mjs; do node "$t"; done`
   (skip `tools/smoke-test.mjs` offline — it needs live network). 4. See [`AGENTS.md`](AGENTS.md)
   for the rules this project follows.

---

# ⚾ MLB Live PBP — Live MLB Scoreboard & Play-by-Play (original README, copied)

> ### 🛑 **Safe baseline for this copy** 🛑
> *[copy note]* The original repository's `v1.0.0-stable-checkpoint` tag exists only in
> [buffedlizard55-lab/MLB-Live-PBP](https://github.com/buffedlizard55-lab/MLB-Live-PBP) (it points to `94ed9ad`, 2026-08-07).
> In **this** repository the safe baseline is commit `ddca0b8` — a byte-for-byte copy of the original
> site at `859e958` (2026-09-23), before any scoring-model change. To return this copy to it:
> ```bash
> git reset --hard ddca0b8
> ```

A zero-dependency, static web app that pulls **live MLB game data** straight from the
public MLB StatsAPI and renders it in a **Gameday-style scoreboard** — exactly the data
mlb.com uses, re-implemented from scratch in vanilla HTML/CSS/JS.

- **Scoreboard** (like [MLB.com](https://www.mlb.com/scoreboard)) — every game for any
  date, with live scores, inning, count, probable pitchers, and W/L/S decisions.
- **Game view** (like [MLB.com Gameday](https://www.mlb.com/gameday)) — **who's at bat,
  who's pitching, the count, outs, runners on base**, on-deck / in-the-hole hitters,
  pitch counts, last play, inning-by-inning linescore, full box score, and the complete
  play-by-play timeline with pitch-by-pitch details.
- **Instant Replay Reviews & Challenge Alerts** — real-time alerts and dedicated tracking
  for **Manager Challenges**, **Crew Chief Reviews**, **Umpire Reviews**, and **ABS**
  (Automated Ball-Strike system) pitch challenges across both the Scoreboard and Game views:
  - **All-Games "Replay Feed" page** (`reviews.html`) — a live, chat-style feed that pulls
    review events from **every game on the schedule** (not just one game): new manager
    challenges, crew chief reviews, umpire reviews, ABS pitch challenges and
    boundary-call reviews (potential home runs / fair-foul at the wall) appear at the
    top of the feed as they happen, with game link, inning, challenging team, reason,
    outcome, batter/pitcher context, and a three-row **review score tracker**:
    **Before review** (the call-on-field score when the active review is first
    observed), **Possible after** (call stands plus any conditional run-removal
    scenario supported by the reviewed scoring movements), and **Actual after**
    (the official score after the resolved reviewed play/action, when exposed).
    For example: `NYY 6 – BOS 5`, possible
    `NYY 5 – BOS 5` if the reviewed safe-at-home run is removed, then the actual
    official score after the ruling. The possible score is **not a prediction**:
    on a home-run/boundary review MLB may instead place runners. A boundary review
    with no currently credited run says “score impact pending” and does not invent
    an alternate score. If the page opens only after resolution, it shows an
    attributable official Actual-after score when available and honestly marks
    Before/Possible as not observed. A later end-of-plate-appearance score is not
    assigned to an earlier pitch review. For ABS,
    the feed also shows the pitch count before the challenge, who challenged (batter /
    catcher / pitcher, from official play text or the challenging team's batting/
    fielding side), and the count after the call is overturned or stands.
    Every ABS-challenge and manager-challenge row also carries a
    **challenges-remaining tracker**: the challenging team's current official
    counter (e.g. `CIN: 2 ABS challenges left now (2 successful · 0 failed)` or
    `PIT: 1 manager challenge left now (0 used)`), with the both-teams summary
    (`Challenges left: CIN 1 MGR · 2 ABS — CHC 1 MGR · 2 ABS`) on hover and on
    the Under-Review live strip. The numbers are the **official StatsAPI
    counters read as-is** — `review.away/home.used/remaining` (manager
    challenges, from the schedule's `hydrate=review` and feed/live
    `gameData.review`) and `gameData.absChallenges.away/home.usedSuccessful/
    usedFailed/remaining` (ABS, feed/live only; verified live 2026-08-28) —
    never counts derived from feed events, never zero-filled when absent
    (pre-ABS seasons have no `absChallenges` object at all), and a used-counter
    that moves backwards between polls is flagged on the row as an
    irregularity instead of being silently corrected. Crew-chief, umpire and
    boundary reviews are not charged to a team's counter, so those rows show
    no counter line by design. Includes
    an "Under Review" live strip, per-type
    filters — **All** (every category except ABS pitch challenges:
    challenges, reviews, boundary calls, under review, runs at risk),
    **ABS** (ABS challenges stay fully tracked here, in the **ABS
    Challenges** stat, and in the challenges-remaining counters),
    **Challenges**, **Reviews**, **Boundary Calls**, **Under Review**,
    **⚠️ Runs at Risk** —,
    summary stats for the whole day, and an optional **sound alert** — a gentle
    synthesized raindrop chime (three soft drops blooming into a warm two-note
    chime, ~1.2s, pure sine tones with a light echo) when a new challenge, review,
    or boundary call lands. It is off by default, remembers your choice per
    browser, and never fires for routine ABS pitch challenges (the run-at-risk
    case below is the one exception, and it uses this exact same chime).
  - **⚠️ Runs at Risk — "could this review take a run OFF the board?"** The feed
    tracks, per review, whether the call on the field credited runs to the very
    event now under review, so an overturn could remove them from the score. When
    it can, you get, immediately: the **same gentle raindrop chime** used for any
    new review (one alert sound for the whole page — it is literally the same
    audio graph, and shares its 2.5s cooldown), an
    optional **desktop notification**, a persistent **red banner** at the top of
    the page listing every affected game with the call-stands score and — only
    when the payload actually supports it — the score if the runs come off,
    a **⚠️ N RUN(S) AT RISK** badge and glow on the feed row,
    a **Runs at Risk** stat, and a dedicated filter tab. It fires once per review
    (not once per poll), clears the moment the review resolves, and applies to
    every review type — manager challenge, crew chief/umpire review, boundary call,
    "under review", and ABS — because it is decided by the *data*, not the type: a
    run counts only when the official payload has a `runners[]` record with
    `details.isScoringEvent:true` whose `details.playIndex` matches the reviewed
    event. A score change elsewhere in the plate appearance (a steal of home, a
    wild pitch) never counts, and the ruling itself is **never predicted**.
    Note that browsers block audio until you have interacted with the page, so a
    run-at-risk chime on the very first page load may be silent until you click
    something; the desktop notification is not affected.
  - **Scoreboard Live Ticker & Alert Badges** — surfaces any game currently in review or challenge,
    with a link straight to the all-games Replay Feed.
  - **Live Game Review Alert Banner** — eye-catching alert at the top of the game and live module when a call is under review.
  - **Dedicated "Challenges & Reviews" Tab** — full breakdown of every review event with summary stats (overturn rate, breakdown by challenge type and team), call reasons, and outcomes (Overturned, Stands, Confirmed).
  - **Play-by-Play Chips** — highlighted review outcome chips directly on affected plays.
  - All review parsing is validated against the real StatsAPI shapes (`reviewDetails`
    with codes `MJ` = ABS pitch challenge, `MA`/`MF` = manager challenges, and
    `NH` = boundary-call review, plus
    `feed.gameData.review` / `feed.gameData.absChallenges` challenge counters) — see
    `docs/verification-report.md` and `tools/review-test.mjs`.
- **Two-sided hit forecast** — a transparent per-plate-appearance hit probability that
  compounds the batter's and pitcher's season rates (log5), real platoon splits,
  recent form, head-to-head history, same-game familiarity, and the live count into a
  single number with a matchup tier (Elite → Pitcher's edge) and per-driver point
  adjustments. It appears in the live at-bat card, the Props & Matchup tab, and
  completed PBP rows.
- Auto-refreshes: on a live game page the full feed lands every **500ms**, while
  a dedicated **250ms status watcher** catches a brand-new challenge/review the
  instant MLB flips the official game status (and while a review is in flight
  the page probes the lean play-by-play endpoint every **250ms**, pulling the
  full feed only when the review state flips). The Replay Feed scans every live
  game's play-by-play every **250ms** and sweeps the whole slate's official
  status every **250ms**. The scoreboard keeps its 500ms hydrated-schedule poll
  and adds the same **250ms status sweep** for the review ticker. Works on
  desktop and mobile.
- **"Under review" is detected from the official game status, not from play
  text.** All three surfaces run a dedicated **250ms review-status watcher**
  (`GET /api/v1/schedule` with a `fields` projection and no hydrations — the
  whole slate's `gamePk` + `status` in ~2.4 KB, ~1/8th the size of the schedule
  the rest of the page uses); the Replay Feed and the scoreboard use it for
  the whole slate, and the game page sweeps a ~150-byte per-game status
  projection on the same cadence. MLB flips `status.statusCode` the instant a
  review is **called**, while the play description is written when it
  **resolves** — so this cuts the worst-case wait from ~3s (the schedule cache)
  to ~250ms plus one round trip, and it surfaces the official review reason
  ("Tag play", "Home run", "Pitch Result", …) before any play text exists.
  Detection reads the API's own status registry (`GET /api/v1/gameStatus`:
  `M*` manager challenge, `N*` umpire review, `IH` instant replay, `MJ`/`NJ`
  ABS pitch challenge) instead of matching the words "challenge"/"review" —
  which silently missed crew-chief reviews, whose official `detailedState` is
  **"Instant Replay"**. See `docs/verification-report.md` §16.
- No build step, no frameworks, no API keys — it runs on **GitHub Pages** (or any static
  host, or even `file://`).

> **Live demo:** [buffedlizard55-lab.github.io/MLB-Live-PBP](https://buffedlizard55-lab.github.io/MLB-Live-PBP/)

---

## How it works — reverse-engineering MLB.com Gameday

MLB.com's Gameday is a JavaScript app. It reads JSON from a public, undocumented API at
**`https://statsapi.mlb.com/api/v1/`** (plus `v1.1` for live game feeds) and pulls
images (logos, headshots) from **`mlbstatic.com`**. No login, no API key, and the API
sends CORS headers, so any static page can call it directly from the browser.

This project does the same thing with its own front end. The API calls we make:

| What we need | Endpoint |
| --- | --- |
| Games for a date (scoreboard cards, probables, live count) | `GET /api/v1/schedule?sportId=1&date=YYYY-MM-DD&hydrate=probablePitcher,linescore,decisions,review` |
| **Review status for the whole slate** (Replay Feed's 250ms watcher) | `GET /api/v1/schedule?sportId=1&date=YYYY-MM-DD&fields=dates,games,gamePk,season,status,abstractGameState,codedGameState,detailedState,statusCode,reason,startTimeTBD,abstractGameCode` |
| **Review status for one game** (game page's 250ms status watcher, ~150 B) | `GET /api/v1.1/game/{gamePk}/feed/live?fields=gameData,status,abstractGameState,codedGameState,detailedState,statusCode,reason,startTimeTBD,abstractGameCode` |
| Official game-status registry (source of every review `statusCode` + `reason`) | `GET /api/v1/gameStatus` |
| Full game state — play-by-play, current at-bat, linescore, box score, decisions, rosters | `GET /api/v1.1/game/{gamePk}/feed/live` |
| Fallback feed (older games) | `GET /api/v1/game/{gamePk}/feed/live` |
| Fallback bundle (if the feed 404s) | `GET /api/v1/game/{gamePk}/playByPlay` + `/boxscore` + `/linescore` |
| Play-by-play only (all-games Replay Feed scans this per game) | `GET /api/v1/game/{gamePk}/playByPlay` |
| Team logos | `https://www.mlbstatic.com/team-logos/team-cap-on-dark/{teamId}.svg` |
| Player headshots | `https://img.mlbstatic.com/mlb-photos/image/upload/.../v1/people/{playerId}/headshot/67/current` |
| Batter / pitcher season inputs for the forecast | `GET /api/v1/people/{playerId}/stats?stats=expectedStatistics,season,statSplits,gameLog&group=hitting&sitCodes=vl,vr&season=YYYY` (same CSV for `group=pitching`). **Note:** the `statcast` stat is rejected with HTTP 400 for `group=hitting` on the live API (verified 2026-08-19), so it is deliberately not requested — xBA comes from `expectedStatistics`. |
| Career head-to-head for the live forecast | `GET /api/v1/people/{batterId}/stats?stats=vsPlayer&group=hitting&opposingPlayerId={pitcherId}` |

The live feed is the heart of it — one response contains everything Gameday shows:

```
liveData.plays.allPlays[]      → every at-bat: result, description, count, outs,
                                 batter/pitcher matchup, runner movement, pitch events
liveData.plays.currentPlay     → the at-bat happening RIGHT NOW (batter, pitcher, count)
liveData.linescore             → inning state, inning-by-inning runs/hits/errors
liveData.boxscore              → per-player batting & pitching lines, batting order
liveData.decisions             → winning/losing/saving pitcher
gameData.players / teams       → names, positions, records, venue, weather, status
```

The app polls `feed/live` every 500ms while a game is in progress (every 250ms
while a review is in flight, via a lean play-by-play probe that fetches the
full feed only when the review state flips) and only rebuilds the DOM when the
baseball state changes
(count, pitch event, score, inning, play, or review outcome). The heavy box-score
table is lazy-rendered only when its tab is open. Preview and final games use
slower cadences, and polling pauses automatically while the tab is hidden.

## Two-sided hit forecast

The hit percentage is a **transparent, per-plate-appearance estimate** — not an MLB
projection or a betting line. It is built to *discriminate*: great spots and terrible
spots land far apart instead of clustering around the league average. Two numbers are
shown, and they intentionally live in different bands:

- **Per-PA headline ("Hit this PA")** — the chance the batter gets a hit in *this*
  plate appearance. For **real MLB matchups this typically reads 22–30%** (league hit
  rates cluster around `.245`, and real batters/pitchers do too); the model's full
  clamp band is 13–62% per-PA (10–78% with live count), reached only by stacked
  synthetic edges like an overmatched call-up vs an ace (~13%) or an elite hitter on
  a hitter's count vs a weak arm (~50%). A single-PA hit rate can't honestly reach
  80%: even a perfect .400 hitter vs a .150-allowed pitcher resolves to ~55% before
  clamps. See `tools/model-calibration-report.mjs` for the archetype grid.
- **"≥1 hit in next N PAs" projection** — the *wide* number, and where the promised
  16–95% spread actually lives. It is `1 − (1 − per-PA)^remaining PAs`, so during a
  live game it naturally reads **50–95%** (the broadcast-style graphic number most
  fans expect). It is shown on the live at-bat card and in the Props & Matchup tab;
  on a **Final game there are no PAs left, so it reads "—"/0%** and the per-PA rate is
  the relevant number. Both are per-batter and per-pitcher.

The model:

1. **Season level (both sides):** the batter's xBA/AVG hit-production signal and the
   pitcher's xBA-allowed/opponent-AVG signal are each regressed toward a `.245` league
   baseline (light regression so a full-season signal can move the forecast by
   ~10-14 points), then compounded in log-odds space — a generalized **log5** (Bill
   James's odds-ratio method), so extreme signals push the estimate toward the
   extremes rather than canceling toward the mean. Total evidence is capped at
   ±1.9 logits from the league prior.
2. **Platoon splits:** each player's real `vs LHP` / `vs RHP` (pitchers: `vs LHB` /
   `vs RHB`) split enters as a shrunken *differential* against their own season rate.
   Without split data, a small flat handedness adjustment is used instead.
3. **Recent form:** the player's game-log window (last ~8 games, strictly before the
   modeled game's date, so a forecast never leaks the game's own result) nudges the
   estimate with a meaningful weight (capped so a single hot/cold week cannot dominate
   the season signal).
4. **Head-to-head:** the career batter/pitcher line is a bounded but real nudge
   (~up to 5.5 pts of weighted signal).
5. **Same-game familiarity:** each repeat plate appearance against the same pitcher
   adds a small times-through-the-order bump (~+0.75 pts/pass, capped at the third look).
6. **Live count:** mid-at-bat, the fresh-count estimate is multiplied in odds space by
   an empirically anchored count factor (3-1 » 0-0 » 0-2); walks are *not* hits, so
   3-ball factors deliberately exclude the walk's value (see
   `tools/count-model-derivation.mjs` for the derivation and anchors).

The headline number is the **hit probability for this plate appearance**; the chance
of at least one more hit across the remaining expected plate appearances is shown as a
secondary projection. A **matchup tier** (Elite matchup / Favorable / Neutral / Tough /
Pitcher's edge) and per-driver **adjustment chips** (season, platoon, form, history,
familiarity, count — in percentage points) make every forecast explainable.

If one player has no usable season data, the forecast remains available but labels the
fallback (for example, “Batter input; pitcher baseline fallback”). If neither side has
data, it shows the league baseline instead of pretending the estimate is personalized.
The same cached model powers the live at-bat card, Props & Matchup tab, and PBP chips;
for archived games the request is scoped to the feed's game season.

## Project structure

```
.
├── index.html                 # Scoreboard page (all games for a date)
├── game.html                  # Game page (?gamePk=<id>)
├── reviews.html               # All-games Replay Feed (live chat-style review feed)
├── scoring.html               # ✏️ Scoring Changes: Error Watch, Official Changes, 📉 Hit → Error, Model, Irregularities
├── 404.html
├── server.mjs                 # Zero-dependency static server + cross-browser feed-log API
├── assets/
│   ├── css/style.css          # Dark Gameday-style theme (responsive)
│   └── js/
│       ├── api.js             # MLB StatsAPI client (fetch, retry, fallbacks, formatters)
│       ├── ui.js              # Shared UI: team logos, colors, count dots, runners diamond
│       ├── reviews.js         # Challenge & replay review parser (Manager, Crew Chief, ABS)
│       ├── reviews-feed.js    # All-games Replay Feed logic (diff helpers + page; 📉 Hit → Error segregation)
│       ├── scoreboard.js      # Scoreboard page logic
│       ├── props.js           # Two-sided hit model, stat cache, Props & Matchup tab
│       ├── feed-log.js        # Multi-tier feed-log client (memory → localStorage → server → static)
│       ├── scoring-model.js   # Shared scoring-change model (error→hit, hit→error, pending chances)
│       ├── scoring-page.js    # scoring.html renderer (pipeline outputs only)
│       └── game.js            # Game page logic (live "at bat" module, linescore, box, PBP)
├── pipeline/                  # Official-data pipeline + live ruling capture (GitHub Actions)
├── data/                      # Pipeline outputs (official lists, model, reports) + capture evidence + feed logs
├── tools/                     # Deterministic test suites (node tools/*-test.mjs)
└── docs/                      # Methodology (MODEL.md), verification reports, workflow notes
    └── workflows/             # Optional GitHub Actions files (see deployment section)
```

## Run it locally

Run the built-in persistence server (recommended — persists scoring changes and reviews to disk across browsers):

```bash
# Node built-in server (multi-browser persistent logging backend)
node server.mjs

# or any static file server
python3 -m http.server 8000
# or
npx serve .
```

Then open <http://localhost:8000>. You can also open `index.html` directly in a browser
(`file://` works — the app uses plain scripts, no modules).

To run the deterministic, network-free checks:

```bash
node tools/hit-model-test.mjs                  # two-sided hit forecast model
node tools/review-test.mjs                     # challenge / replay review parser (incl. real API shapes)
node tools/reviews-feed-test.mjs               # all-games Replay Feed diff helpers
node tools/replay-feed-render-test.mjs         # end-to-end Replay Feed render (captured live payloads)
node tools/review-probe-test.mjs               # in-review lean-probe signature (game.js)
node tools/review-status-test.mjs              # official gameStatus registry + review detection (all 4 copies)
node tools/review-watcher-test.mjs             # 250ms review-status watcher, driven through the real boot path
node tools/page-status-watcher-test.mjs        # 250ms watchers on the game page + scoreboard, real boot path
node tools/api-rate-limit-test.mjs             # HTTP-429 self-throttle (60s quiet period) in the API client
node tools/official-scoring-test.mjs           # official-scorer pending rulings
node tools/api-fields-test.mjs                 # playByPlay `fields` projection coverage
node tools/scoring-change-test.mjs             # official scoring-change tracker (hit ↔ error ↔ out; hit→error segregation)
node tools/feed-log-persistence-test.mjs       # replay feed log: every entry survives refresh/revisit
node tools/cross-browser-persistence-test.mjs  # cross-browser & across-the-website persistence verification
node tools/scoring-model-feed-test.mjs         # scoring-change model on live feed rows (error→hit, hit→error, pending)
node tools/scoring-model-game-test.mjs         # scoring-change model on game-page rows
node tools/scoring-page-test.mjs               # scoring.html renders the real pipeline outputs (all 5 sections)
node tools/storage-namespace-test.mjs          # browser storage keys stay under 'mlbScoringChange.' (origin shared with the original site)
node tools/pipeline-log-test.mjs               # official-log parser + classifier (ruling transitions, flags)
node tools/pipeline-model-test.mjs             # model fitting / scoring / banding on synthetic populations
node tools/capture-test.mjs                    # live ruling capture (first-call states, pending markers)
node tools/pipeline-offline-smoke.mjs          # end-to-end pipeline run against stubbed official sources
```

(The whole batch: `for t in tools/*-test.mjs tools/pipeline-offline-smoke.mjs; do node "$t" || break; done`.
`tools/smoke-test.mjs` is the only suite that needs live network access.)

Every entry tracked (challenges, reviews, scoring-pending rulings, scoring
changes) is persistent across the website:
- **Across browsers & sessions**: saved to the backend disk store (`data/feed-log-<date>.json`)
  via `POST /api/feed-log` and cached in `localStorage`, so opening the website on
  another browser immediately restores all tracked entries and baselines.
- **Across the website**:
  - `reviews.html`: renders the All feed and dedicated ✏️ Scoring Changes tab.
  - `game.html`: dedicated **Challenges & Reviews** tab displays official scoring changes
    with full initial-call-to-final-ruling breakdown, and updates the tab badge.
  - `index.html`: scoreboard cards display the `✏️ N Scoring Change(s)` indicator.
  (see `docs/scoring-changes.md`).

To *see and hear* the ⚠️ Runs at Risk surfaces without waiting for a live review,
serve the repo and open the offline, fixture-driven preview — it stubs the API with
the exact same deterministic payload the render test uses and makes no network
request:

```bash
python3 -m http.server 8000
# then open http://localhost:8000/tools/run-risk-preview.html
```

## Deploy to GitHub Pages

The site is 100% static (repo root = site root), so GitHub Pages serves it directly
with no build step and no workflow permissions:

1. **Push this project to GitHub** (any repo — e.g. `yourname/MLB-Live-PBP`).
2. In the repo: **Settings → Pages → Source → "Deploy from a branch"** → branch
   `main` → folder `/ (root)` → **Save**.
3. Your site is live at **`https://<your-username>.github.io/<repo-name>/`** —
   e.g. `https://buffedlizard55-lab.github.io/MLB-Live-PBP/`. Every push to `main`
   republishes it automatically (takes ~1 minute).

### Optional: Actions-based deployment & CI smoke test

The repo's Pages setup doesn't require Actions. If you'd rather deploy via GitHub
Actions (and/or run the nightly API smoke test), ready-to-use workflow files are in
[`docs/workflows/`](docs/workflows/):

- `pages.yml` — deploys to Pages on every push to `main` (requires the repo setting
  **Pages → Source → "GitHub Actions"** instead of branch deployment).
- `smoke.yml` — runs the deterministic two-sided model checks and a nightly
  check that the upstream MLB StatsAPI still matches our parsers; run it anytime
  from **Actions** with "Run workflow".

To use them, copy the file contents into `.github/workflows/` in the repo (the GitHub
web UI's *Add file* is the easiest way), then go to **Settings → Pages → Source →
GitHub Actions**.

### Customizing

- **Season / league:** `SPORT_ID` in `assets/js/api.js` (1 = MLB). Minor-league IDs
  (11–14) also work.
- **Refresh rate:** `LIVE_POLL_MS`, `REVIEW_POLL_MS`, `PREVIEW_POLL_MS`, and `FINAL_POLL_MS` in
  `assets/js/game.js` (the 250ms in-review probe uses `REVIEW_POLL_MS` against the
  lean `playByPlay` endpoint); `LIVE_POLL_MS` / `REVIEW_POLL_MS` / `IDLE_POLL_MS`
  in `assets/js/scoreboard.js` and `assets/js/reviews-feed.js`;
  `FETCH_CONCURRENCY` in `assets/js/reviews-feed.js` (how many games the all-games
  feed fetches in parallel per scan).
- **Team colors:** `TEAM_COLORS` in `assets/js/ui.js`.

## Notes & etiquette

- The MLB StatsAPI is **unofficial and may change without notice**. The client is
  written defensively (fallbacks for every endpoint and missing fields) and the app
  degrades gracefully if a field disappears.
- Be a good citizen: the app needs **no API key** (the StatsAPI is keyless and
  open-CORS) and it self-limits — every page pauses when the tab is hidden,
  backs off on preview/final games, bounds post-Final re-scans to a 30-minute
  grace window, and (since 2026-09-05) the shared client self-throttles for
  60 seconds if the API ever answers **HTTP 429**, so it can never hammer a
  host that has asked it to slow down. The Replay Feed scans live games'
  playByPlay (the light, `fields`-projected endpoint — no boxscore/rosters)
  every 250ms, subtracts scan time from the next wait, fetches in-review games
  first, and only re-renders when a review event actually changes. Worst case
  on a full ~15-game slate that is ~60 playByPlay requests/s plus ~4 tiny
  status sweeps/s (~64 req/s, single client) — far below "thousands of requests
  per second", and the same cadence the page already used whenever any review
  was in flight. The StatsAPI is
  pull-only — a shorter poll only reduces how long a landed event sits unseen.
- Review/challenge data shapes were verified against the live API on 2026-08-19
  (schedule `hydrate=review`, `reviewDetails` codes `MJ`/`MA`/`MF`, and
  `gameData.absChallenges`); see `docs/verification-report.md`.
- Team logos, headshots, and the underlying data are © MLB Advanced Media / MLB and
  their respective owners. This is an unofficial fan project — not affiliated with
  or endorsed by MLB.

## License

[MIT](LICENSE)
