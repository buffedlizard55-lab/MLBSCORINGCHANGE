/* ============================================================================
 * pipeline/lib/model-build.mjs — build every table / coefficient that
 * assets/js/scoring-model.js consumes. Pure (input: compact PA records).
 * ==========================================================================*/

import { createRequire } from 'node:module';
import {
  fitLogistic, predictLogistic, auc, brier, logLoss, calibrationTable, foldOf,
} from './stats.mjs';
import { HIT_EVENTS } from './statsapi.mjs';

const require = createRequire(import.meta.url);
export const SM = require('../../assets/js/scoring-model.js');

const round = (v, d = 4) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);

export function isBattedBall(rec) {
  return rec && rec.ty === 'atBat' && rec.hd && (rec.hd.traj || Number.isFinite(rec.hd.ls));
}

/**
 * Hit-probability surface: P(hit | exit velocity cell, launch angle cell).
 * Each fine cell is shrunk toward its 3×3 coarse cell, which is shrunk toward
 * its launch-angle strip, which is shrunk toward the overall rate (m pseudo
 * counts at each level) — standard empirical-Bayes smoothing.
 */
export function buildHitProbSurface(records, {
  evMin = 40, evStep = 2, nEv = 40, laMin = -60, laStep = 3, nLa = 44, m = 25, exclude = null,
} = {}) {
  const hF = new Float64Array(nEv * nLa);
  const nF = new Float64Array(nEv * nLa);
  const hL = new Float64Array(nLa);
  const nL = new Float64Array(nLa);
  let H = 0;
  let N = 0;
  const clampI = (v, n) => (v < 0 ? 0 : v >= n ? n - 1 : v);
  for (const rec of records) {
    if (!isBattedBall(rec)) continue;
    if (exclude && exclude.has(`${rec.g}:${rec.ai}`)) continue;
    const { ls, la } = rec.hd;
    if (!Number.isFinite(ls) || !Number.isFinite(la)) continue;
    const i = clampI(Math.floor((ls - evMin) / evStep), nEv);
    const j = clampI(Math.floor((la - laMin) / laStep), nLa);
    const hit = HIT_EVENTS.has(rec.et) ? 1 : 0;
    hF[i * nLa + j] += hit; nF[i * nLa + j] += 1;
    hL[j] += hit; nL[j] += 1;
    H += hit; N += 1;
  }
  const overall = N ? H / N : null;
  const laRate = Array.from({ length: nLa }, (_, j) => (hL[j] + m * overall) / (nL[j] + m));
  const rate = new Array(nEv * nLa);
  for (let i = 0; i < nEv; i += 1) {
    for (let j = 0; j < nLa; j += 1) {
      let hc = 0; let nc = 0;
      const i0 = Math.floor(i / 3) * 3; const j0 = Math.floor(j / 3) * 3;
      for (let a = i0; a < Math.min(nEv, i0 + 3); a += 1) {
        for (let b = j0; b < Math.min(nLa, j0 + 3); b += 1) { hc += hF[a * nLa + b]; nc += nF[a * nLa + b]; }
      }
      const rc = (hc + m * laRate[j]) / (nc + m);
      rate[i * nLa + j] = round((hF[i * nLa + j] + m * rc) / (nF[i * nLa + j] + m));
    }
  }
  return { evMin, evStep, nEv, laMin, laStep, nLa, smoothing: m, nBalls: N, overall: round(overall), rate };
}

/** P(hit | trajectory, fielder) fallbacks for balls without EV/LA. */
export function buildHitProbFallback(records, { m = 25, exclude = null } = {}) {
  const tl = new Map(); const t = new Map();
  let H = 0; let N = 0;
  const add = (map, key, hit) => {
    const c = map.get(key) || { h: 0, n: 0 };
    c.h += hit; c.n += 1; map.set(key, c);
  };
  for (const rec of records) {
    if (!isBattedBall(rec)) continue;
    if (exclude && exclude.has(`${rec.g}:${rec.ai}`)) continue;
    const hit = HIT_EVENTS.has(rec.et) ? 1 : 0;
    const tg = SM.trajGroup(rec.hd.traj);
    add(tl, `${tg}|${SM.locationGroup(rec.hd.loc)}`, hit);
    add(t, tg, hit);
    H += hit; N += 1;
  }
  const overall = N ? H / N : null;
  const byTraj = {};
  for (const [k, c] of t) byTraj[k] = round((c.h + m * overall) / (c.n + m));
  const byTrajLoc = {};
  for (const [k, c] of tl) {
    const parent = byTraj[k.split('|')[0]] ?? overall;
    byTrajLoc[k] = round((c.h + m * parent) / (c.n + m));
  }
  return { overall: round(overall), byTraj, byTrajLoc, nBalls: N };
}

export const PENDING_OUTCOMES = ['hit', 'error', 'fc', 'out', 'sac', 'other'];

/**
 * Outcome distribution of comparable batted balls, keyed at four levels of
 * detail (see SM.pendingDistribution). Each level is shrunk to its parent.
 */
export function buildPendingTable(records, {
  evEdges = [70, 85, 95, 105], laEdges = [-10, 5, 15, 25, 40], m = 20, minN = 30,
} = {}) {
  const K = PENDING_OUTCOMES.length;
  const counts = new Map();
  const add = (key, o) => {
    let c = counts.get(key);
    if (!c) { c = new Array(K).fill(0); counts.set(key, c); }
    c[o] += 1;
  };
  for (const rec of records) {
    if (!isBattedBall(rec)) continue;
    const o = PENDING_OUTCOMES.indexOf(SM.outcomeOf(rec.et));
    const tg = SM.trajGroup(rec.hd.traj);
    const lg = SM.locationGroup(rec.hd.loc);
    const eb = SM.binIndex(evEdges, rec.hd.ls);
    const lb = SM.binIndex(laEdges, rec.hd.la);
    const rs = rec.br === 1 ? ['R', 'A'] : rec.br === 0 ? ['O', 'A'] : ['A'];
    for (const r of rs) {
      add([tg, lg, eb, lb, r].join('|'), o);
      add([tg, lg, r].join('|'), o);
      add([tg, r].join('|'), o);
      add(r, o);
    }
  }
  const probs = new Map();
  const parentKey = (key) => {
    const parts = key.split('|');
    if (parts.length === 5) return [parts[0], parts[1], parts[4]].join('|');
    if (parts.length === 3) return [parts[0], parts[2]].join('|');
    if (parts.length === 2) return parts[1];
    return null;
  };
  const keys = [...counts.keys()].sort((a, b) => a.split('|').length - b.split('|').length);
  const table = {};
  for (const key of keys) {
    const c = counts.get(key);
    const n = c.reduce((s, v) => s + v, 0);
    const pk = parentKey(key);
    const parent = pk ? probs.get(pk) : null;
    const p = c.map((v, o) => (parent ? (v + m * parent[o]) / (n + m) : v / n));
    probs.set(key, p);
    table[key] = { n, p: p.map((v) => round(v, 4)) };
  }
  return { outcomes: PENDING_OUTCOMES, evEdges, laEdges, smoothing: m, minN, table };
}

/**
 * Cross-validated model selection + final fit.
 * rows: [{id, gamePk, season, y, play}] — play = SM.playFromRecord(rec)
 */
export function selectAndFit(rows, candidateSets, model, {
  k = 10, lambdas = [0.3, 1, 3, 10], ootSeason = null,
} = {}) {
  const y = rows.map((r) => r.y);
  const hps = rows.map((r) => SM.hitProbability(model, r.play).p);
  const designFor = (terms) => rows.map((r, i) => SM.featureVector({ terms }, hps[i], r.play));
  const base = y.reduce((s, v) => s + v, 0) / Math.max(1, y.length);
  const folds = rows.map((r) => foldOf(r.gamePk, k));
  const evaluations = [];
  const fits = [];
  for (const terms of candidateSets) {
    const X = designFor(terms);
    for (const lambda of terms.length ? lambdas : [1]) {
      const oof = new Array(rows.length);
      for (let f = 0; f < k; f += 1) {
        const trX = []; const trY = [];
        for (let i = 0; i < rows.length; i += 1) if (folds[i] !== f) { trX.push(X[i]); trY.push(y[i]); }
        const trMean = trY.reduce((s, v) => s + v, 0) / Math.max(1, trY.length);
        const fit = terms.length
          ? fitLogistic(trX, trY, { lambda })
          : { intercept: Math.log(Math.max(1e-6, trMean) / Math.max(1e-6, 1 - trMean)), coef: [] };
        for (let i = 0; i < rows.length; i += 1) if (folds[i] === f) oof[i] = predictLogistic(fit, X[i]);
      }
      // Per-fold log loss → mean and standard error (for the 1-SE rule).
      const foldLoss = [];
      for (let f = 0; f < k; f += 1) {
        const pf = []; const yf = [];
        for (let i = 0; i < rows.length; i += 1) if (folds[i] === f) { pf.push(oof[i]); yf.push(y[i]); }
        if (pf.length) foldLoss.push(logLoss(pf, yf));
      }
      const meanFold = foldLoss.reduce((s, v) => s + v, 0) / foldLoss.length;
      const sd = Math.sqrt(foldLoss.reduce((s, v) => s + (v - meanFold) ** 2, 0) / Math.max(1, foldLoss.length - 1));
      const ev = {
        terms, lambda, logLoss: logLoss(oof, y), auc: auc(oof, y), brier: brier(oof, y),
        se: sd / Math.sqrt(foldLoss.length),
      };
      evaluations.push(ev);
      fits.push({ ev, oof, X });
    }
  }
  // One-standard-error rule: the simplest model (fewest terms, then the
  // strongest regularisation) whose CV log loss is within 1 SE of the best.
  const minimum = fits.reduce((a, b) => (b.ev.logLoss < a.ev.logLoss ? b : a));
  const threshold = minimum.ev.logLoss + minimum.ev.se;
  const best = fits
    .filter((f) => f.ev.logLoss <= threshold)
    .sort((a, b) => a.ev.terms.length - b.ev.terms.length || b.ev.lambda - a.ev.lambda || a.ev.logLoss - b.ev.logLoss)[0];
  const final = best.ev.terms.length
    ? fitLogistic(best.X, y, { lambda: best.ev.lambda })
    : { intercept: Math.log(base / (1 - base)), coef: [] };
  const result = {
    terms: best.ev.terms,
    lambda: best.ev.lambda,
    intercept: round(final.intercept, 6),
    coef: final.coef.map((c) => round(c, 6)),
    baseRate: round(base, 5),
    n: rows.length,
    positives: y.reduce((s, v) => s + v, 0),
    cv: {
      folds: k,
      logLoss: round(best.ev.logLoss, 5),
      baseLogLoss: round(logLoss(rows.map(() => base), y), 5),
      auc: round(best.ev.auc, 4),
      brier: round(best.ev.brier, 5),
      baseBrier: round(brier(rows.map(() => base), y), 5),
      calibration: calibrationTable(best.oof, y).map((r) => ({
        ...r, predicted: round(r.predicted, 4), observed: round(r.observed, 4),
      })),
    },
    selectionRule: 'one-standard-error rule on 10-fold (by game) cross-validated log loss',
    bestLogLoss: round(minimum.ev.logLoss, 5),
    bestLogLossSE: round(minimum.ev.se, 5),
    selection: evaluations.map((e) => ({
      terms: e.terms, lambda: e.lambda, logLoss: round(e.logLoss, 5), se: round(e.se, 5), auc: round(e.auc, 4), brier: round(e.brier, 5),
    })),
  };
  // Out-of-time check: train on seasons before ootSeason, test on ootSeason.
  if (ootSeason != null) {
    const trI = []; const teI = [];
    rows.forEach((r, i) => (r.season < ootSeason ? trI : r.season === ootSeason ? teI : []).push(i));
    const tePos = teI.reduce((s, i) => s + y[i], 0);
    if (trI.length && teI.length && tePos > 0) {
      const fit = result.terms.length
        ? fitLogistic(trI.map((i) => best.X[i]), trI.map((i) => y[i]), { lambda: result.lambda })
        : { intercept: Math.log(base / (1 - base)), coef: [] };
      const p = teI.map((i) => predictLogistic(fit, best.X[i]));
      const yt = teI.map((i) => y[i]);
      const trBase = trI.reduce((s, i) => s + y[i], 0) / trI.length;
      result.outOfTime = {
        trainSeasons: `< ${ootSeason}`,
        testSeason: ootSeason,
        n: teI.length,
        positives: tePos,
        auc: round(auc(p, yt), 4),
        logLoss: round(logLoss(p, yt), 5),
        baseLogLoss: round(logLoss(yt.map(() => trBase), yt), 5),
        brier: round(brier(p, yt), 5),
        baseBrier: round(brier(yt.map(() => trBase), yt), 5),
        calibration: calibrationTable(p, yt).map((r) => ({
          ...r, predicted: round(r.predicted, 4), observed: round(r.observed, 4),
        })),
      };
    }
  }
  const oofById = new Map(rows.map((r, i) => [r.id, best.oof[i]]));
  return { spec: result, oofById };
}
