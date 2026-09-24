/* ============================================================================
 * pipeline/lib/stats.mjs — small, dependency-free statistics toolkit.
 *   fitLogistic   L2-regularised logistic regression (Newton–Raphson; the
 *                 intercept is not penalised)
 *   predictLogistic, auc, brier, logLoss, calibrationTable, foldOf
 * ==========================================================================*/

export const sigmoid = (z) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

export function solve(A, b) {
  // Gaussian elimination with partial pivoting (A is small and SPD-ish).
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c += 1) {
    let piv = c;
    for (let r = c + 1; r < n; r += 1) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) throw new Error('singular system');
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r += 1) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      if (f === 0) continue;
      for (let k = c; k <= n; k += 1) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/**
 * @param {number[][]} X rows of features (no intercept column)
 * @param {number[]} y   0/1 labels
 * @returns {{intercept:number, coef:number[], iterations:number, converged:boolean}}
 */
export function fitLogistic(X, y, { lambda = 1, maxIter = 100, tol = 1e-9 } = {}) {
  const n = y.length;
  const d = n ? X[0].length : 0;
  const mean = y.reduce((s, v) => s + v, 0) / Math.max(1, n);
  const beta = new Array(d + 1).fill(0);
  beta[0] = Math.log(Math.max(1e-6, mean) / Math.max(1e-6, 1 - mean));
  let converged = false;
  let it = 0;
  for (; it < maxIter; it += 1) {
    const g = new Array(d + 1).fill(0);
    const H = Array.from({ length: d + 1 }, () => new Array(d + 1).fill(0));
    for (let i = 0; i < n; i += 1) {
      const row = X[i];
      let z = beta[0];
      for (let j = 0; j < d; j += 1) z += beta[j + 1] * row[j];
      const p = sigmoid(z);
      const r = y[i] - p;
      const w = Math.max(p * (1 - p), 1e-10);
      g[0] += r;
      for (let j = 0; j < d; j += 1) g[j + 1] += r * row[j];
      H[0][0] += w;
      for (let j = 0; j < d; j += 1) {
        const wj = w * row[j];
        H[0][j + 1] += wj;
        H[j + 1][0] += wj;
        for (let k = j; k < d; k += 1) {
          const v = wj * row[k];
          H[j + 1][k + 1] += v;
          if (k !== j) H[k + 1][j + 1] += v;
        }
      }
    }
    for (let j = 1; j <= d; j += 1) {
      g[j] -= lambda * beta[j];
      H[j][j] += lambda;
    }
    const step = solve(H, g);
    let maxStep = 0;
    for (let j = 0; j <= d; j += 1) {
      beta[j] += step[j];
      maxStep = Math.max(maxStep, Math.abs(step[j]));
    }
    if (maxStep < tol) { converged = true; it += 1; break; }
  }
  return { intercept: beta[0], coef: beta.slice(1), iterations: it, converged };
}

export function predictLogistic(model, row) {
  let z = model.intercept;
  for (let j = 0; j < model.coef.length; j += 1) z += model.coef[j] * row[j];
  return sigmoid(z);
}

/** Area under the ROC curve (Mann–Whitney U with average ranks for ties). */
export function auc(p, y) {
  const idx = p.map((v, i) => i).sort((a, b) => p[a] - p[b]);
  const ranks = new Array(p.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && p[idx[j + 1]] === p[idx[i]]) j += 1;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) ranks[idx[k]] = avg;
    i = j + 1;
  }
  let nPos = 0;
  let sumPos = 0;
  for (let k = 0; k < y.length; k += 1) if (y[k] === 1) { nPos += 1; sumPos += ranks[k]; }
  const nNeg = y.length - nPos;
  if (!nPos || !nNeg) return null;
  return (sumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

export function brier(p, y) {
  if (!p.length) return null;
  return p.reduce((s, v, i) => s + (v - y[i]) ** 2, 0) / p.length;
}

export function logLoss(p, y) {
  if (!p.length) return null;
  const eps = 1e-12;
  return -p.reduce((s, v, i) => {
    const q = Math.min(1 - eps, Math.max(eps, v));
    return s + (y[i] ? Math.log(q) : Math.log(1 - q));
  }, 0) / p.length;
}

/** Calibration by fixed probability bands. */
export function calibrationTable(p, y, edges = [0, 0.02, 0.05, 0.1, 0.2, 0.35, 0.5, 1.0001]) {
  const rows = [];
  for (let b = 0; b < edges.length - 1; b += 1) {
    let n = 0; let pos = 0; let sp = 0;
    for (let i = 0; i < p.length; i += 1) {
      if (p[i] >= edges[b] && p[i] < edges[b + 1]) { n += 1; pos += y[i]; sp += p[i]; }
    }
    rows.push({
      band: `${Math.round(edges[b] * 100)}–${Math.min(100, Math.round(edges[b + 1] * 100))}`,
      n,
      predicted: n ? sp / n : null,
      observed: n ? pos / n : null,
      positives: pos,
    });
  }
  return rows;
}

/** Deterministic fold assignment by game (keeps a game's plays together). */
export function foldOf(gamePk, k) {
  // Knuth multiplicative hash for an even spread of sequential gamePks.
  return Number((BigInt(gamePk) * 2654435761n) % 4294967296n) % k;
}
