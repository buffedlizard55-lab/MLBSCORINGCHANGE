/* ============================================================================
 * analysis/study.mjs — the error→hit model study of 2026-09-30, in one run.
 *
 * Question (owner): "the scoring is not that predictive … we should be able to
 * find a pattern where anything that was initially scored an error was changed
 * to a single should have a higher score … raise the scores on errors that
 * were changed to a hit."
 *
 * Sections (run with --only=a,b to pick):
 *   a  baseline      — how well does the published model's out-of-fold score
 *                      separate changed plays? (AUC, rank of positives,
 *                      calibration)
 *   b  rates         — change rates by every candidate feature, on the exact
 *                      Statcast features of all settled 2024–2026 plays
 *   c  leaktrap      — why the error type cannot be a historical feature, and
 *                      what the official log's own wording implies anyway
 *   d  groups        — permutation tests for batter identity and official
 *                      scorer (is there a "who" effect left after features?)
 *   e  candidates    — the candidate feature sets, each through the exact
 *                      production protocol (selectAndFit: 10-fold CV grouped
 *                      by game, one-SE rule, out-of-time on 2026)
 *   f  chosen        — the production-ladder selection and what it does to
 *                      the scores of changed plays
 *
 * Data: analysis/model-rows.json.gz (tools/dump-model-rows.mjs, GitHub
 * Actions, MLB StatsAPI playByPlay). Hit probability: the published surface,
 * exactly as the pipeline scores it. Protocol: identical to pipeline/run.mjs.
 * ========================================================================== */

import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { selectAndFit } from '../pipeline/lib/model-build.mjs';
import { auc, logLoss, brier } from '../pipeline/lib/stats.mjs';
import { originalErrorKindFromLog } from '../pipeline/lib/log-classifier.mjs';

const require = createRequire(import.meta.url);
const SM = require('../assets/js/scoring-model.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const model = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/model/scoring-model.json'), 'utf8'));
const dump = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'analysis/model-rows.json.gz'))).toString());
const rows = dump
  .filter((r) => r.settled && r.rec)
  .map((r) => ({
    id: r.id, gamePk: r.gamePk, season: r.season, y: r.y, status: r.status,
    oof: r.oof && r.oof.p != null ? r.oof.p : null,
    batterId: r.rec && r.rec.b != null ? r.rec.b : null,
    scorerId: r.scorerId != null ? r.scorerId : null,
    play: SM.playFromRecord(r.rec),
  }));
const P = rows.reduce((s, r) => s + r.y, 0);
console.log(`settled error→hit population 2024–2026: ${rows.length} plays, ${P} changed to a hit (${(100 * P / rows.length).toFixed(1)}%)`);

const only = (process.argv.find((a) => a.startsWith('--only=')) || '--only=').slice(7).split(',').filter(Boolean);
const want = (k) => !only.length || only.includes(k);

function rankStats(p) {
  const order = p.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]);
  const rank = new Array(p.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j += 1;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) rank[order[k][1]] = r;
    i = j + 1;
  }
  const pct = rows.filter((r) => r.y).map((r) => 1 - (rank[rows.indexOf(r)] - 1) / (rows.length - 1)).sort((a, b) => a - b);
  const q = (v) => pct[Math.floor(v * (pct.length - 1))];
  return {
    medianPct: q(0.5), top10: pct.filter((v) => v >= 0.9).length, top20: pct.filter((v) => v >= 0.8).length, n: pct.length,
  };
}
const dist = (p) => {
  const chg = p.filter((_, i) => rows[i].y);
  const std = p.filter((_, i) => !rows[i].y);
  const cnt = (arr, lo) => arr.filter((v) => v >= lo).length;
  const hi = p.map((v, i) => ({ v, y: rows[i].y })).filter((x) => x.v >= 0.18);
  return {
    changedMean: 100 * chg.reduce((a, b) => a + b, 0) / chg.length,
    changedN18: cnt(chg, 0.18), changedN25: cnt(chg, 0.25),
    standsN18: cnt(std, 0.18), standsN25: cnt(std, 0.25),
    obs18: hi.length ? 100 * hi.reduce((s, x) => s + x.y, 0) / hi.length : null, n18: hi.length,
  };
};

/* ---- a. baseline ---------------------------------------------------------------- */
if (want('a')) {
  console.log('\n=== a. baseline: the published model, out-of-fold ===');
  const p = rows.map((r) => r.oof).filter((v) => v != null);
  const yy = rows.filter((r) => r.oof != null).map((r) => r.y);
  console.log(`AUC ${auc(p, yy).toFixed(4)}  logLoss ${logLoss(p, yy).toFixed(5)}  brier ${brier(p, yy).toFixed(5)}`);
  for (const s of [2024, 2025, 2026]) {
    const sub = rows.filter((r) => r.season === s && r.oof != null);
    console.log(`  ${s}: AUC ${auc(sub.map((r) => r.oof), sub.map((r) => r.y)).toFixed(4)} (n=${sub.length}, ${sub.reduce((s2, r) => s2 + r.y, 0)} chg)`);
  }
  const rs = rankStats(rows.map((r) => r.oof));
  console.log(`changed plays in the top 10% of scores: ${rs.top10}/${rs.n}; top 20%: ${rs.top20}; median percentile ${(100 * rs.medianPct).toFixed(0)}`);
  console.log('calibration (published CV table): 20–35% band predicted 0.247 vs observed 0.450 (n=20); 35–50%: 1/1 — the top end is under-confident');
}

/* ---- b. rates ------------------------------------------------------------------- */
if (want('b')) {
  console.log('\n=== b. change rates by candidate feature (settled 2024–2026, exact Statcast) ===');
  const tab = (name, keyFn, order) => {
    const m = new Map();
    for (const r of rows) {
      const k = keyFn(r);
      if (k === null) continue;
      const c = m.get(k) || { n: 0, y: 0 };
      c.n += 1; c.y += r.y; m.set(k, c);
    }
    const out = [...m.entries()].map(([k, c]) => ({ k, n: c.n, y: c.y, r: c.y / c.n }));
    if (order) out.sort((a, b) => order.indexOf(a.k) - order.indexOf(b.k));
    else out.sort((a, b) => b.n - a.n);
    console.log(`\n${name}`);
    for (const x of out) console.log(`  ${String(x.k).padEnd(16)} n=${String(x.n).padStart(4)}  chg=${String(x.y).padStart(3)}  rate=${(100 * x.r).toFixed(1)}%`);
  };
  const evBins = ['<65', '65-70', '70-75', '75-80', '80-85', '85-95', '95-105', '105+', 'na'];
  tab('exit velocity (all trajectories)', (r) => {
    const ls = r.play.ls;
    if (ls == null) return 'na';
    return ls < 65 ? '<65' : ls < 70 ? '65-70' : ls < 75 ? '70-75' : ls < 80 ? '75-80' : ls < 85 ? '80-85' : ls < 95 ? '85-95' : ls < 105 ? '95-105' : '105+';
  }, evBins);
  tab('exit velocity (ground balls only)', (r) => {
    const ls = r.play.ls;
    if (SM.trajGroup(r.play.traj) !== 'ground_ball' || ls == null) return null;
    return ls < 65 ? '<65' : ls < 70 ? '65-70' : ls < 75 ? '70-75' : ls < 80 ? '75-80' : ls < 85 ? '80-85' : ls < 95 ? '85-95' : '95+';
  }, ['<65', '65-70', '70-75', '75-80', '80-85', '85-95', '95+']);
  tab('half of the inning', (r) => (r.play.top === true ? 'top (away)' : r.play.top === false ? 'bottom (home)' : null), ['top (away)', 'bottom (home)']);
  tab('inning', (r) => (r.play.inn == null ? null : r.play.inn <= 3 ? '1-3' : r.play.inn <= 6 ? '4-6' : '7+'), ['1-3', '4-6', '7+']);
  tab('batter side', (r) => r.play.bs || null, ['L', 'R']);
  tab('soft grounder (<70 mph) by fielder group', (r) => {
    if (SM.trajGroup(r.play.traj) !== 'ground_ball' || r.play.ls == null) return null;
    return (r.play.ls < 70 ? 'soft|' : 'fast|') + SM.locationGroup(r.play.loc);
  }, null);
}

/* ---- c. the error-type leak trap ------------------------------------------------- */
if (want('c')) {
  console.log('\n=== c. the error-type trap and what the log implies anyway ===');
  const settled = dump.filter((r) => r.settled);
  const standsKind = {}; const chgLogKind = {};
  for (const r of settled) {
    if (r.status === 'stands') {
      const credit = (r.rec && r.rec.errs || []).find((x) => x.b === 1) || (r.rec && r.rec.errs || [])[0];
      const k = credit ? (SM.ERROR_KIND_BY_CREDIT[credit.k] || 'other') : 'none';
      standsKind[k] = (standsKind[k] || 0) + 1;
    } else if (r.y) {
      const k = r.logKind || 'no_clause';
      chgLogKind[k] = (chgLogKind[k] || 0) + 1;
    }
  }
  console.log('stands plays — error type from final credits (valid, ruling never changed):', standsKind);
  console.log('changed plays — original error type from the log wording of the OLD ruling:', chgLogKind);
  const kinds = ['fielding', 'throwing', 'missed_catch'];
  const named = kinds.reduce((s, k) => s + (chgLogKind[k] || 0), 0);
  const standsNamed = kinds.reduce((s, k) => s + (standsKind[k] || 0), 0);
  console.log('coverage of changed plays with a named type:', named, '/', P, '(wording bias — §15 caveat applies)');
  for (const k of kinds) {
    const shareChg = (chgLogKind[k] || 0) / Math.max(1, named);
    const shareSt = (standsKind[k] || 0) / Math.max(1, standsNamed);
    console.log(`  ${k.padEnd(13)} share among changes ${(100 * shareChg).toFixed(1)}%  among stands ${(100 * shareSt).toFixed(1)}%  implied relative rate ${(shareChg / shareSt).toFixed(2)}x`);
  }
}

/* ---- d. permutation tests --------------------------------------------------------- */
if (want('d')) {
  console.log('\n=== d. is there a "who" effect left? permutation tests on model residuals ===');
  const withOof = rows.filter((r) => r.oof != null);
  const test = (label, keyFn, reps = 2000) => {
    const groups = new Map();
    for (const r of withOof) {
      const k = keyFn(r);
      if (k == null) continue;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    const Tstat = (gs) => gs.reduce((T, g) => {
      const O = g.reduce((s, r) => s + r.y, 0);
      const E = g.reduce((s, r) => s + r.oof, 0);
      const V = g.reduce((s, r) => s + r.oof * (1 - r.oof), 0);
      return T + (V > 0 ? (O - E) ** 2 / V : 0);
    }, 0);
    const T = Tstat([...groups.values()]);
    const y = withOof.map((r) => r.y); const p = withOof.map((r) => r.oof); const lab = withOof.map(keyFn);
    let exceed = 0;
    for (let it = 0; it < reps; it += 1) {
      for (let i = lab.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [lab[i], lab[j]] = [lab[j], lab[i]];
      }
      const g2 = new Map();
      for (let i = 0; i < lab.length; i += 1) {
        if (lab[i] == null) continue;
        if (!g2.has(lab[i])) g2.set(lab[i], []);
        g2.get(lab[i]).push({ y: y[i], oof: p[i] });
      }
      if (Tstat([...g2.values()]) >= T) exceed += 1;
    }
    console.log(`${label}: ${groups.size} groups, T/groups = ${(T / groups.size).toFixed(3)}, permutation p = ${(exceed / reps).toFixed(3)} ${exceed / reps < 0.05 ? '(SIGNAL)' : '(no detectable difference)'}`);
  };
  test('batter identity', (r) => r.batterId);
  test('official scorer', (r) => r.scorerId, 1000);
}

/* ---- e. candidates --------------------------------------------------------------- */
if (want('e')) {
  console.log('\n=== e. candidate feature sets (production protocol, per set) ===');
  const BASE = ['logit_hit_prob', 'loc:P', 'loc:C', 'loc:1B', 'loc:3B', 'loc:OF', 'traj:line_drive', 'traj:fly_ball', 'traj:popup', 'traj:bunt'];
  const SETS = {
    'CURRENT (base+loc+traj)': BASE,
    '+ ev_z + ev_missing (old candidate)': [...BASE, 'ev_z', 'ev_missing'],
    '+ ev_soft + ev_hard': [...BASE, 'ev_soft', 'ev_hard'],
    '+ ev_soft + ev_hard + hp_x_of': [...BASE, 'ev_soft', 'ev_hard', 'hp_x_of'],
    '+ ev_soft + ev_hard + loc:SS': [...BASE, 'ev_soft', 'ev_hard', 'loc:SS'],
    '+ ev extremes + hp_x_of + hp_sq + loc:SS': [...BASE, 'ev_soft', 'ev_hard', 'hp_x_of', 'hp_sq', 'loc:SS'],
  };
  console.log('set'.padEnd(44), 'λ    ', 'cvLL  ', 'cvAUC ', '| ootLL ', 'ootAUC', '| per-season OOF AUC');
  for (const [name, terms] of Object.entries(SETS)) {
    const fit = selectAndFit(rows, [terms], model, { ootSeason: 2026 });
    const spec = fit.spec;
    const per = [];
    for (const s of [2024, 2025, 2026]) {
      const sub = rows.map((r, i) => ({ r, p: fit.oofById.get(r.id) })).filter((x) => x.r.season === s && x.p != null);
      per.push(`${s}:${auc(sub.map((x) => x.p), sub.map((x) => x.r.y)).toFixed(3)}`);
    }
    console.log(
      name.padEnd(44), String(spec.lambda).padEnd(5),
      spec.cv.logLoss.toFixed(5), spec.cv.auc.toFixed(4), '|',
      spec.outOfTime.logLoss.toFixed(5), spec.outOfTime.auc.toFixed(4), '|', per.join(' '),
    );
  }
}

/* ---- f. chosen -------------------------------------------------------------------- */
if (want('f')) {
  console.log('\n=== f. the production ladder (new E_SETS, pipeline/run.mjs) ===');
  const BASE = ['logit_hit_prob', 'loc:P', 'loc:C', 'loc:1B', 'loc:3B', 'loc:OF', 'traj:line_drive', 'traj:fly_ball', 'traj:popup', 'traj:bunt'];
  const LADDER = [
    [],
    ['logit_hit_prob'],
    ['logit_hit_prob', 'infield'],
    ['logit_hit_prob', 'loc:P', 'loc:C', 'loc:1B', 'loc:3B', 'loc:OF'],
    BASE,
    [...BASE, 'ev_z', 'ev_missing'],
    [...BASE, 'ev_soft', 'ev_hard'],
    [...BASE, 'ev_soft', 'ev_hard', 'hp_x_of'],
    [...BASE, 'ev_soft', 'ev_hard', 'hp_x_of', 'hp_sq', 'loc:SS'],
    [...BASE, 'ev_z', 'ev_missing', 'batting_home'],
  ];
  const cur = selectAndFit(rows, [BASE], model, { ootSeason: 2026 });
  const lad = selectAndFit(rows, LADDER, model, { ootSeason: 2026 });
  for (const [name, fit] of [['CURRENT model', cur], ['LADDER selection', lad]]) {
    const spec = fit.spec;
    const d = dist(rows.map((r) => fit.oofById.get(r.id)));
    const rs = rankStats(rows.map((r) => fit.oofById.get(r.id)));
    console.log(`\n${name}: λ=${spec.lambda} terms=${spec.terms.join(', ')}`);
    console.log(`  cv: logLoss ${spec.cv.logLoss} (base ${spec.cv.baseLogLoss})  AUC ${spec.cv.auc}  brier ${spec.cv.brier}`);
    console.log(`  out-of-time (train <2026, test 2026): logLoss ${spec.outOfTime.logLoss} (base ${spec.outOfTime.baseLogLoss})  AUC ${spec.outOfTime.auc}  brier ${spec.outOfTime.brier}`);
    console.log(`  changed plays: mean score ${d.changedMean.toFixed(1)}, ≥18: ${d.changedN18}, ≥25: ${d.changedN25} (of ${P})`);
    console.log(`  stands plays:  ≥18: ${d.standsN18}, ≥25: ${d.standsN25} (of ${rows.length - P})`);
    console.log(`  observed P(changed | score ≥ 18) = ${d.obs18 == null ? 'n/a' : d.obs18.toFixed(0) + '%'} over ${d.n18} plays`);
    console.log(`  positives in top 10%: ${rs.top10}/${rs.n}, median percentile ${(100 * rs.medianPct).toFixed(0)}`);
  }
  console.log('\ncoefficients (ladder):');
  console.log('  intercept', lad.spec.intercept);
  lad.spec.terms.forEach((t, i) => console.log(`  ${t.padEnd(18)} ${lad.spec.coef[i]}`));
}
