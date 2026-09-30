# Error → hit model — study and improvement (2026-09-30)

**The question (owner, session 2026-09-30):** *"the scoring is not that predictive. we should be
able to find a pattern where anything that was initially scored an error was changed to a single,
should have a higher score. we have some cases where we have a high score on an error and it was
changed to a single, but we should see if we can raise the scores on errors that were changed to a
hit."*

Everything below is computed from the repo's own data and is reproducible with
`node analysis/study.mjs` (sections `a`–`f`; see the [reproduce](#9-reproduce) section). The
per-play dataset behind it — the exact Statcast features of every settled reached-on-error play of
2024–2026 — is committed as `analysis/model-rows.json.gz` (dumped from MLB StatsAPI by
`tools/dump-model-rows.mjs` on GitHub Actions; provenance in `analysis/model-rows.meta.json`).

## TL;DR

| | current model | with the new features |
| --- | --- | --- |
| CV AUC (10-fold, grouped by game) | 0.608 | **0.624** |
| Out-of-time AUC (train 2024–25, test 2026) | 0.620 | **0.650** |
| CV log loss (base rate) | 0.2186 (0.2251) | **0.2175** (0.2251) |
| changed plays scoring ≥ 18 (High band) | 11 of 189 | **17 of 189** |
| stands plays scoring ≥ 18 (false alarms) | 22 | 22 |
| observed P(changed \| score ≥ 18) | 33% | **44%** |
| median percentile rank of changed plays | 66th | **70th** |

The pattern the model was missing is a **U-shape in exit velocity**: among reached-on-error plays,
the ones the scorer changes to a hit are disproportionately **beaten-out rollers under ~70 mph**
and **hot shots at 105+ mph**. The comparable-ball hit probability is monotonically *higher* for
harder hits, so it cannot express "soft contact gets changed more"; a linear exit-velocity term was
already a candidate and lost. Two indicator terms (`ev_soft`, `ev_hard`) plus an outfield interaction
with the hit probability (`hp_x_of`) capture it. All of it is information known the moment the play
happens — no leakage.

## 1. Data and method

- **Population** (identical to the model's): every plate appearance whose *original* ruling was a
  batter-reached-on-error, 2024–2026, settled games only (≥ 14 days old) — **3,187 plays, 189
  changed to a hit (5.9%)**. Labels and out-of-fold probabilities come from the committed
  `data/model/error-events-*.json`; the compact play records (Statcast `hitData`, runners, outs,
  score, bat side) were re-fetched from MLB StatsAPI playByPlay by the dump tool.
- **Hit probability**: the published surface in `data/model/scoring-model.json` — the same one the
  site and the live feed use.
- **Protocol**: `selectAndFit` from `pipeline/lib/model-build.mjs` — L2 logistic regression,
  10-fold CV grouped by game, the one-standard-error rule on paired per-play log-loss differences,
  out-of-time check (train < 2026, test 2026). The study never touches the published model's
  fitting; it only evaluates candidates through the same machinery.

## 2. Baseline diagnosis — how un-predictive is it, exactly?

Out-of-fold, on the exact training data (the published `p` on every settled play):

- **AUC 0.608** (2024: 0.599, 2025: 0.614, 2026: 0.614); log loss 0.2186 vs 0.2251 at the base rate.
- Only **44 of 189 changed plays sit in the top 10%** of scores; the median changed play ranks at
  the **66th percentile** — barely better than a coin flip.
- The top end is **under-confident**: in the 20–35% CV band the model predicts 0.247 and 9 of 20
  plays changed (45%); the single 35–50% play changed. When the model does say "High", it is right
  about a third of the time at ≥ 18 and more often above that.

So the owner's read is correct: there is real signal at the top end, but the model both ranks
weakly and compresses its own best guesses.

## 3. What actually separates changed plays (settled 2024–2026, exact Statcast)

**Exit velocity — the U-shape** (all trajectories):

| EV | plays | changed | rate |
| --- | --- | --- | --- |
| < 65 mph | 405 | 29 | **7.2%** |
| 65–70 | 172 | 13 | **7.6%** |
| 70–75 | 229 | 10 | 4.4% |
| 75–80 | 245 | 12 | 4.9% |
| 80–85 | 284 | 10 | **3.5%** |
| 85–95 | 820 | 49 | 6.0% |
| 95–105 | 823 | 46 | 5.6% |
| 105+ | 177 | 19 | **10.7%** |

Ground balls only: < 70 mph → 6.8–7.9% vs ~3.6–4.0% at 70–85 mph. Gameday's own `hardness` field
says the same thing: soft 7.5% and hard 10.3% vs medium 5.6%.

Mechanism: a scorer who first charges an error reconsiders along one question — *"with ordinary
effort, would the batter have been safe anyway?"* On a **dribbler the fielder must rush**, the
answer is often yes for a fast-enough batter → changed to an infield single. On a **hot shot that
ate up the fielder**, ordinary effort often does not stop it → hit. The mid-speed balls right at a
fielder are the ones where the muff really turned an out into a runner → error stands. The
comparable-ball hit probability cannot see this: for the *average* batter a 60 mph roller is an out
(hitProb ≈ 0.06), which is exactly why 19 of the 23 lowest-scoring misses in 2026 were soft ground
balls that became infield singles.

Other confirmed separators (already in the model, quoted for context): balls that reached the
outfield (9.4–9.8% overall; ground balls through the infield 9/10 changed), bunts (22% in 2026),
catcher-position plays (28.6%, n=7), 3B grounders (8.0%) vs SS grounders (4.2%).

## 4. What does *not* separate changed plays (checked, so it stays out of the model)

| Candidate | Finding |
| --- | --- |
| **Half of the inning** (home batter) | 2026 alone looked strong (bottom 7.5% vs top 4.6%) — but on 2024–2026 it is 5.9% vs 6.0%. A one-season artifact; `batting_home` stays rejected. |
| Inning | 6.7% / 5.5% / 5.6% (1–3 / 4–6 / 7+). Mild, not selected. |
| Batter side (L/R) | 6.6% vs 5.6%. Mild, not selected. |
| Outs / runners on | 0 outs 6.6% vs 5.2%/5.8%; "Empty" 25% is n=20 noise. Not selected. |
| **Batter identity** (speed, in principle) | Permutation test on model residuals: T/groups = 1.06, **p = 0.32** — no batter effect left once EV/angle/location are in. A batter-speed feature has nothing detectable to add at this sample size. |
| **Official scorer** | T/groups = 1.04, p = 0.36 — replicates the pipeline's own §17 result with an independent method. |

## 5. The error-type trap (and what the log implies anyway)

The single most intuitive feature — *what kind of error it was first called* — cannot be trained
on: after a change to a hit the error credit is **gone** from final data, so the type exists for
plays that stood and not for plays that changed (2026 Error Watch: 910 settled stands plays carry
`current_ruling` kinds, 58 of 60 settled `none`-kind plays are the changed ones). Training on it
would leak the label; the AGENTS.md rule that allows it **only as captured live before any change**
is exactly right, and the captured-data adjustment (MODEL.md §15) is the sanctioned path — status
today: `collecting`.

For context only (the log's wording may depend on the type, and it names the original type for just
54 of 189 changes): missed-catch errors are over-represented among changes (implied relative rate
**2.2×**, 11.1% of named changes vs 5.0% of stands), throwing 1.10×, fielding 0.85×. Once live
capture accumulates (≥ 15 changes, ≥ 150 errors), the adjustment can test this properly.

## 6. The new features (all known at the moment of the play)

| Term | Definition | Why |
| --- | --- | --- |
| `ev_soft` | exit velocity < 70 mph | the beaten-out roller |
| `ev_hard` | exit velocity ≥ 105 mph | the hot shot |
| `hp_x_of` | logit(hitProb) × [ball reached the OF] | a dropped liner is a different question from an infield roller; the hit-probability slope differs |
| `hp_sq` | logit(hitProb)² | non-linearity candidate (tested; not selected by the 1-SE rule on current data) |
| `loc:SS` | SS split from 2B | tested; borderline (best CV AUC of the family but weaker out-of-time) |
| `bat_left`, `inn_late` | context, computable live | tested; not selected |

`ev_soft`/`ev_hard` use the term's training mean when Statcast EV has not arrived yet (same
convention as scorer/error-type terms). Live wiring: `bs` and `inn` now travel on the play object
(`playFromRecord`, `playFromStatsApi`, `scoreReview`) so context terms are computable in the feed.

## 7. Validation (production protocol, per candidate set)

| set | λ | CV log loss | CV AUC | OOT log loss | OOT AUC |
| --- | --- | --- | --- | --- | --- |
| current (hp + fielder + trajectory) | 1 | 0.21864 | 0.6081 | 0.21771 | 0.6203 |
| + linear `ev_z` (old candidate) | 3 | 0.21943 | 0.6198 | 0.21918 | 0.6315 |
| + `ev_soft` + `ev_hard` | 3 | 0.21874 | 0.6280 | 0.21916 | 0.6437 |
| + `ev_soft` + `ev_hard` + `hp_x_of` | 1 | **0.21753** | 0.6241 | **0.21653** | **0.6497** |
| + extremes + `hp_x_of` + `hp_sq` + `loc:SS` | 1 | 0.21670 | 0.6315 | 0.21704 | 0.6399 |

Per-season OOF AUC for the chosen 13-term set: 2024 0.617, 2025 0.628, 2026 0.649 (current:
0.599 / 0.614 / 0.614) — the gain is not one season's quirk. The linear `ev_z` candidate was
always going to lose (the effect is U-shaped, not linear), which is why EV had been tested and
rejected before; the indicators are what the data actually shows.

Selected coefficients (13-term, λ = 1, on the study data): intercept −2.538; logit_hit_prob +0.425;
loc:OF +1.723; loc:1B +0.537; loc:C +0.366; loc:3B +0.346; loc:P −0.281; line_drive −1.065;
fly_ball −2.052; popup −0.011; bunt +0.581; **ev_soft +0.545; ev_hard +0.386; hp_x_of −0.323**.

## 8. What it does to the scores of changed plays

Out-of-fold, changed plays: mean score 7.8 → 8.2; **≥ 18: 11 → 17**; ≥ 25: 7 → 6. Stands plays ≥ 18:
22 → 22 (no extra false alarms). Observed P(changed | score ≥ 18): 33% → **44%** (39 plays).
Median percentile rank of changed plays: 66 → 70; top-20% capture 70 → 69–70. The gain is spread
across the upper-middle of the ranking (which is what AUC measures) rather than piling into the
top decile, and the High band is now about as likely as not to be right. This is an honest
improvement, not a re-tuning of the score display: probabilities are still fit, calibrated and
selected by the unchanged one-SE rule.

Note on λ: within one standard error of the best CV log loss the exact regularization strength
(0.3 / 1 / 3) is a knife-edge — each pipeline run re-selects it on fresh data. All variants of the
new family beat the current model on AUC (CV 0.617–0.630, OOT 0.640–0.654) and put 15–17 changed
plays in the High band.

## 9. What shipped

1. `assets/js/scoring-model.js` — new term types (`ev_soft`, `ev_hard`, `hp_x_of`, `hp_sq`,
   `bat_left`, `inn_late`), unknown-input handling for them, and `bs`/`inn` on the normalised play
   objects (record, StatsAPI and `scoreReview` live paths).
2. `pipeline/run.mjs` — three new candidate sets in the `E_SETS` ladder after the linear-EV
   candidate. The pipeline's own one-SE selection decides on every run; nothing is hard-coded to
   the study's numbers.
3. `tools/dump-model-rows.mjs` + `.github/workflows/model-rows-dump.yml` — the on-demand,
   cache-reusing dump of the model population with exact features (re-run it after any season
   rollover to refresh `analysis/model-rows.json.gz`).
4. `tools/pipeline-model-test.mjs` — tests for the new terms (values, boundaries, training-mean
   behaviour, and a synthetic `selectAndFit` run through them).
5. This study + `analysis/study.mjs` + `analysis/README.md`.

What did **not** ship, deliberately: error type as a historical feature (leakage — §5), batter
speed (no residual batter effect — §4), scorer/home-park terms (no effect, replicates §17), and any
change to the selection rule or the score bands.

## 10. Reproduce

```bash
# data: analysis/model-rows.json.gz (committed; regenerate on demand from GitHub Actions)
gh workflow run model-rows-dump.yml --ref <branch>     # or push to tools/dump-model-rows.mjs

node analysis/study.mjs            # everything: baseline, rates, traps, tests, candidates, ladder
node analysis/study.mjs --only=e   # just the candidate comparison
```

The study needs no network: it reads the committed dump and the published model file.
