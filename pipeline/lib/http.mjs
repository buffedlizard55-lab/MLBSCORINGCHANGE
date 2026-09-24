/* ============================================================================
 * pipeline/lib/http.mjs — polite HTTP helpers for the official-data pipeline.
 *
 * Runs on GitHub Actions runners (the dev sandbox has no route to MLB hosts).
 * Every request identifies the project, is retried with exponential backoff
 * on network errors / 429 / 5xx, and is bounded by a timeout. Nothing here
 * transforms data — callers get the exact bytes the source served.
 * ==========================================================================*/

export const USER_AGENT =
  'Mozilla/5.0 (compatible; MLBSCORINGCHANGE-pipeline/1.0; ' +
  '+https://github.com/buffedlizard55-lab/MLBSCORINGCHANGE)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch() with timeout + retries. Returns the Response for 2xx; throws an
 * Error carrying `.status` otherwise (4xx other than 429 are not retried).
 */
export async function fetchWithRetry(url, {
  retries = 4, timeoutMs = 45000, accept = '*/*', minDelayMs = 0,
} = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (minDelayMs) await sleep(minDelayMs);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': USER_AGENT, Accept: accept },
        redirect: 'follow',
      });
      if (res.ok) return res;
      const err = new Error(`HTTP ${res.status} for ${url}`);
      err.status = res.status;
      if (res.status !== 429 && res.status < 500) throw err;
      lastErr = err;
    } catch (err) {
      if (err && err.status && err.status !== 429 && err.status < 500) throw err;
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries) await sleep(1000 * (2 ** attempt));
  }
  throw lastErr;
}

export async function fetchText(url, opts = {}) {
  const res = await fetchWithRetry(url, { accept: 'text/html,text/plain,*/*', ...opts });
  return res.text();
}

export async function fetchJSON(url, opts = {}) {
  const res = await fetchWithRetry(url, { accept: 'application/json', ...opts });
  return res.json();
}

/** Run `fn` over `items` with at most `limit` in flight. Resolves to results[]. */
export async function pool(items, limit, fn) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  let cursor = 0;
  async function worker() {
    while (cursor < list.length) {
      const idx = cursor;
      cursor += 1;
      results[idx] = await fn(list[idx], idx);
    }
  }
  const n = Math.max(1, Math.min(limit, list.length));
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}
