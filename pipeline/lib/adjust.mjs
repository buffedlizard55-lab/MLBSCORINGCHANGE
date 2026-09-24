/* ============================================================================
 * pipeline/lib/adjust.mjs — models fitted on the LIVE-CAPTURED rulings
 * (data/capture, see capture-lib.mjs). Pure functions, no I/O.
 *
 *   fitLogisticOffset     L2 logistic regression with a fixed offset
 *   capturedAdjustment    error→hit: a logit shift + error-type terms on top of
 *                         the main model, fitted ONLY on plays whose original
 *                         call (and error type) was captured before any change
 *   pendingCalibration    per-outcome re-weighting of the pending-ruling
 *                         distribution from captured pending rulings + their
 *                         resolutions, validated leave-one-out
 * Every piece has a data gate and an out-of-sample test; below the gate or
 * without an improvement it reports "collecting" / "not selected" and the
 * published scores are unchanged.
 * ==========================================================================*/

import { sigmoid, solve, foldOf, auc } from './stats.mjs';

const round = (v, d = 5) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);
const EPS = 1e-9;
const lossOf = (p, y) => -Math.log(y ? Math.max(EPS, p) : Math.max(EPS, 1 - p));

/**
 * Logistic regression with offset: logit P = offset + b0 + x·b. Every
 * coefficient (intercept included) is shrunk toward 0 with an L2 penalty —
 * i.e. toward "the main model is right" — because this is an adjustment.
 */
export function fitLogisticOffset(X, y, offset, { lambda = 1, intercept = true, maxIter = 60, tol = 1e-9 } = {}) {
  const n = y.length;
  const d = n && X[0] ? X[0].length : 0;
  const k = d + (intercept ? 1 : 0);
  const beta = new Array(k).fill(0);
  if (!k || !n) return { intercept: 0, coef: new Array(d).fill(0), converged: true };
  let converged = false;
  for (let it = 0; it < maxIter; it += 1) {
    const g = new Array(k).fill(0);
    const H = Array.from({ length: k }, () => new Array(k).fill(0));
    for (let i = 0; i < n; i += 1) {
      const row = intercept ? [1, ...X[i]] : X[i];
      let z = offset[i];
      for (let j = 0; j < k; j += 1) z += beta[j] * row[j];
      const p = sigmoid(z);
      const r = y[i] - p;
      const w = Math.max(p * (1 - p), 1e-10);
      for (let j = 0; j < k; j += 1) {
        g[j] += r * row[j];
        for (let l = 0; l < k; l += 1) H[j][l] += w * row[j] * row[l];
      }
    }
    for (let j = 0; j < k; j += 1) { g[j] -= lambda * beta[j]; H[j][j] += lambda; }
    const step = solve(H, g);
    let maxStep = 0;
    for (let j = 0; j < k; j += 1) { beta[j] += step[j]; maxStep = Math.max(maxStep, Math.abs(step[j])); }
    if (maxStep < tol) { converged = true; break; }
  }
  return { intercept: intercept ? beta[0] : 0, coef: intercept ? beta.slice(1) : beta, converged };
}

export const ERROR_KINDS = ['fielding', 'throwing', 'missed_catch', 'shift_violation'];

/**
 * rows: [{id, gamePk, y (1 = changed to a hit), z0 (main-model logit), kind}]
 * Candidates (simplest first): none | shift | shift + error-type terms
 * (reference = fielding error). 5-fold CV grouped by game; the simplest
 * candidate within one paired standard error of the best wins.
 */
export function capturedAdjustment(rows, {
  minChangedShift = 8, minChangedKind = 15, minPlaysKind = 150, k = 5, lambdas = [1, 3, 10],
  kindTerms = ['kind:throwing', 'kind:missed_catch'],
} = {}) {
  const n = rows.length;
  const positives = rows.reduce((s, r) => s + r.y, 0);
  const byKind = new Map();
  for (const r of rows) {
    const key = r.kind || 'unknown';
    const c = byKind.get(key) || { kind: key, n: 0, changed: 0, expected: 0 };
    c.n += 1; c.changed += r.y; c.expected += sigmoid(r.z0);
    byKind.set(key, c);
  }
  const known = rows.filter((r) => r.kind);
  const termMeans = {};
  for (const t of kindTerms) {
    const kind = t.slice(5);
    termMeans[t] = known.length ? round(known.filter((r) => r.kind === kind).length / known.length, 4) : 0;
  }
  const out = {
    question: 'Adjustment to the error → hit model learned from rulings captured live before any change (error type included)',
    status: 'collecting',
    active: false,
    n, positives,
    gates: { minChangedShift, minChangedKind, minPlaysKind },
    byKind: [...byKind.values()].map((c) => ({ ...c, expected: round(c.expected, 2), rate: round(c.changed / c.n, 4) }))
      .sort((a, b) => b.n - a.n),
    terms: [], intercept: 0, coef: [], termMeans,
  };
  if (positives < minChangedShift || n - positives < minChangedShift) return out;

  const candidates = [{ name: 'none', terms: null }, { name: 'shift', terms: [] }];
  if (positives >= minChangedKind && n >= minPlaysKind) candidates.push({ name: 'shift+error_type', terms: kindTerms });
  const folds = rows.map((r) => foldOf(r.gamePk, k));
  const y = rows.map((r) => r.y);
  const off = rows.map((r) => r.z0);
  const design = (terms) => rows.map((r) => terms.map((t) => (r.kind ? (r.kind === t.slice(5) ? 1 : 0) : termMeans[t])));
  const evals = [];
  for (const c of candidates) {
    const X = c.terms ? design(c.terms) : null;
    for (const lambda of c.terms ? lambdas : [0]) {
      const oof = new Array(n);
      for (let f = 0; f < k; f += 1) {
        const tr = []; const te = [];
        for (let i = 0; i < n; i += 1) (folds[i] === f ? te : tr).push(i);
        if (!te.length) continue;
        if (!c.terms) { for (const i of te) oof[i] = sigmoid(off[i]); continue; }
        const fit = fitLogisticOffset(tr.map((i) => X[i]), tr.map((i) => y[i]), tr.map((i) => off[i]), { lambda });
        for (const i of te) {
          let z = off[i] + fit.intercept;
          for (let j = 0; j < fit.coef.length; j += 1) z += fit.coef[j] * X[i][j];
          oof[i] = sigmoid(z);
        }
      }
      const losses = oof.map((p, i) => lossOf(p, y[i]));
      evals.push({ c, lambda, X, oof, losses, logLoss: losses.reduce((s, v) => s + v, 0) / n, auc: auc(oof, y) });
    }
  }
  const best = evals.reduce((a, b) => (b.logLoss < a.logLoss ? b : a));
  for (const e of evals) {
    const d = e.losses.map((v, i) => v - best.losses[i]);
    const md = d.reduce((s, v) => s + v, 0) / n;
    const sd = Math.sqrt(d.reduce((s, v) => s + (v - md) ** 2, 0) / Math.max(1, n - 1));
    e.delta = md; e.se = sd / Math.sqrt(n);
  }
  const order = (e) => (e.c.terms ? 1 + e.c.terms.length : 0);
  const chosen = evals.filter((e) => e.delta <= e.se + 1e-12)
    .sort((a, b) => order(a) - order(b) || b.lambda - a.lambda || a.logLoss - b.logLoss)[0];
  out.cv = evals.map((e) => ({
    candidate: e.c.name, lambda: e.lambda, logLoss: round(e.logLoss), auc: round(e.auc, 4),
    deltaVsBest: round(e.delta, 6), pairedSE: round(e.se, 6),
  }));
  out.selectionRule = 'simplest candidate within one paired standard error of the best (5-fold cross-validation grouped by game)';
  if (!chosen.c.terms) { out.status = 'not_selected'; return out; }
  const fit = fitLogisticOffset(chosen.X, y, off, { lambda: chosen.lambda });
  Object.assign(out, {
    status: 'active', active: true, candidate: chosen.c.name, lambda: chosen.lambda,
    terms: chosen.c.terms.slice(), intercept: round(fit.intercept, 6), coef: fit.coef.map((v) => round(v, 6)),
  });
  return out;
}

/**
 * rows: [{probs: {outcome: p} (comparable-ball distribution, uncalibrated),
 *         outcome}] — one per captured pending ruling with a known resolution.
 * Weights w_o = (observed_o + a) / (expected_o + a): with little data they
 * stay near 1 (no change). Active only with ≥ minResolved rulings AND a
 * better leave-one-out log loss than the raw distribution.
 */
export function pendingCalibration(rows, outcomes, { a = 5, minResolved = 10 } = {}) {
  const n = rows.length;
  const obs = Object.fromEntries(outcomes.map((o) => [o, 0]));
  const exp = Object.fromEntries(outcomes.map((o) => [o, 0]));
  for (const r of rows) {
    obs[r.outcome] = (obs[r.outcome] || 0) + 1;
    for (const o of outcomes) exp[o] += r.probs[o] || 0;
  }
  const weightsFrom = (O, E) => Object.fromEntries(outcomes.map((o) => [o, (O[o] + a) / (E[o] + a)]));
  const apply = (probs, w) => {
    const v = outcomes.map((o) => (probs[o] || 0) * w[o]);
    const s = v.reduce((x, y) => x + y, 0);
    return Object.fromEntries(outcomes.map((o, i) => [o, s > 0 ? v[i] / s : probs[o] || 0]));
  };
  const metrics = (list) => {
    if (!list.length) return null;
    let ll = 0; let br = 0; let top = 0;
    for (const { p, outcome } of list) {
      ll += -Math.log(Math.max(1e-6, p[outcome] || 0));
      for (const o of outcomes) br += ((p[o] || 0) - (o === outcome ? 1 : 0)) ** 2;
      const best = outcomes.reduce((x, y) => ((p[y] || 0) > (p[x] || 0) ? y : x));
      if (best === outcome) top += 1;
    }
    return { logLoss: round(ll / list.length, 4), brier: round(br / list.length, 4), top1: round(top / list.length, 4) };
  };
  const weights = weightsFrom(obs, exp);
  const raw = metrics(rows.map((r) => ({ p: r.probs, outcome: r.outcome })));
  const loo = metrics(rows.map((r) => {
    const O = { ...obs }; const E = { ...exp };
    O[r.outcome] -= 1;
    for (const o of outcomes) E[o] -= r.probs[o] || 0;
    return { p: apply(r.probs, weightsFrom(O, E)), outcome: r.outcome };
  }));
  const active = n >= minResolved && !!raw && !!loo && loo.logLoss < raw.logLoss;
  return {
    status: n < minResolved ? 'collecting' : active ? 'active' : 'not_better',
    active,
    resolved: n,
    a, minResolved,
    observed: obs,
    expected: Object.fromEntries(outcomes.map((o) => [o, round(exp[o], 2)])),
    weights: Object.fromEntries(outcomes.map((o) => [o, round(weights[o], 4)])),
    metrics: { raw, calibratedLeaveOneOut: loo },
    rule: 'w = (observed + a) / (expected + a) per outcome; used only with ≥ minResolved resolved rulings and a lower leave-one-out log loss than the uncalibrated distribution',
  };
}
