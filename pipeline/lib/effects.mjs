/* ============================================================================
 * pipeline/lib/effects.mjs — do official scorers (or home parks) differ in
 * how often their rulings are changed, beyond what the batted ball explains?
 * Pure functions, no I/O. Re-run on every pipeline run, so the answer is
 * refreshed automatically as seasons accumulate.
 *
 *   heterogeneityTest  permutation test of T = Σ_groups (O − E)² / V, where
 *                      O = changes in the group, E = Σ p and V = Σ p(1 − p)
 *                      from out-of-fold model probabilities. Shuffling group
 *                      labels across plays gives T's null distribution
 *                      without large-sample assumptions (most groups are
 *                      small). dispersion = T / groups (≈ 1 when groups do
 *                      not differ).
 *   groupTable         per group: plays, observed, expected, O/E, and O/E
 *                      shrunk toward 1 ((O + k) / (E + k)).
 * ==========================================================================*/

const round = (v, d = 4) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);

/** Small deterministic PRNG (mulberry32) so p-values are reproducible. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * rows: [{g: group key (null = unknown), y: 0/1, p: out-of-fold probability}]
 */
export function heterogeneityTest(rows, { permutations = 2000, seed = 20260924 } = {}) {
  const use = rows.filter((r) => r.g != null && Number.isFinite(r.p));
  const keys = [...new Set(use.map((r) => String(r.g)))].sort();
  const index = new Map(keys.map((k, i) => [k, i]));
  const G = keys.length;
  const n = use.length;
  if (G < 2 || !n) return { groups: G, plays: n, positives: use.reduce((s, r) => s + r.y, 0), statistic: null, pValue: null };
  const y = Float64Array.from(use, (r) => r.y);
  const p = Float64Array.from(use, (r) => r.p);
  const v = Float64Array.from(use, (r) => r.p * (1 - r.p));
  const labels = Int32Array.from(use, (r) => index.get(String(r.g)));
  const O = new Float64Array(G); const E = new Float64Array(G); const V = new Float64Array(G);
  const stat = (lab) => {
    O.fill(0); E.fill(0); V.fill(0);
    for (let i = 0; i < n; i += 1) { const g = lab[i]; O[g] += y[i]; E[g] += p[i]; V[g] += v[i]; }
    let T = 0;
    for (let g = 0; g < G; g += 1) if (V[g] > 1e-12) T += (O[g] - E[g]) ** 2 / V[g];
    return T;
  };
  const T0 = stat(labels);
  const rng = mulberry32(seed);
  const perm = Int32Array.from(labels);
  let atLeast = 0;
  for (let b = 0; b < permutations; b += 1) {
    for (let i = n - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
    }
    if (stat(perm) >= T0 - 1e-9) atLeast += 1;
  }
  return {
    groups: G,
    plays: n,
    positives: use.reduce((s, r) => s + r.y, 0),
    statistic: round(T0, 3),
    dispersion: round(T0 / G, 3),
    pValue: round((1 + atLeast) / (1 + permutations), 4),
    permutations,
    seed,
  };
}

/** Per-group observed vs expected (sorted by plays, then name). */
export function groupTable(rows, labelOf = (g) => String(g), { k = 10 } = {}) {
  const m = new Map();
  for (const r of rows) {
    if (r.g == null || !Number.isFinite(r.p)) continue;
    const key = String(r.g);
    const c = m.get(key) || { key, n: 0, observed: 0, expected: 0 };
    c.n += 1; c.observed += r.y; c.expected += r.p;
    m.set(key, c);
  }
  return [...m.values()].map((c) => ({
    key: c.key,
    label: labelOf(c.key),
    n: c.n,
    observed: c.observed,
    expected: round(c.expected, 2),
    ratio: c.expected > 0 ? round(c.observed / c.expected, 3) : null,
    shrunkRatio: round((c.observed + k) / (c.expected + k), 3),
  })).sort((a, b) => b.n - a.n || String(a.label).localeCompare(String(b.label)));
}
