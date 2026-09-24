/* ============================================================================
 * pipeline/lib/savant.mjs — true per-play xBA from Baseball Savant
 * (`estimated_ba_using_speedangle`), attached to the plays the site shows.
 *
 * WHY A SEPARATE MODULE
 *   The pipeline fits its own xBA-style hit-probability surface from exit
 *   velocity + launch angle (370k batted balls; it correlates 0.974 with
 *   Savant's value on the same plays). Those are two different things and the
 *   site should say so: a row can carry BOTH the model's comparable-balls
 *   rate and Savant's own expected batting average for that exact ball.
 *
 * HOW IT IS POLITE
 *   Baseball Savant is a public site with no API key; the pipeline runs every
 *   3 hours and must never hammer it. Every request therefore goes through
 *   this client, which:
 *     - fetches at most `budget` URLs per run, strictly sequentially, with a
 *       `delayMs` pause between them (default 2.5 s);
 *     - caches every response in the Actions cache (pipeline-cache/), keyed by
 *       URL, with a per-kind TTL — a repeat question inside the TTL costs zero
 *       requests (a season-wide query is asked once, not every run);
 *     - stops the whole queue on 429/403/5xx and reports it, leaving the work
 *       for the next run instead of retrying in a loop (no retries at all:
 *       the pipeline runs every 3 hours, so waiting is cheaper than hammering);
 *     - treats Savant's 404 ("no rows match") as an empty answer, not a
 *       failure — that is what the endpoint returns for a range with no plays;
 *     - never invents a value: a play with no row is reported as pending or
 *       unavailable, never filled with a guess.
 *
 * WHAT "PER-PLAY xBA" MEANS HERE
 *   `collectPlayXba()` attaches Savant's xBA to the specific plays the site can
 *   show (every linked official entry, every Error Watch row). Plays whose
 *   current ruling is an error come from the season error list; plays whose
 *   current ruling is a hit (error → hit changes) come from one month-window
 *   query per calendar month, filled in lazily a few queries per run. Each
 *   play is asked for at most once per TTL and the run reports exactly how many
 *   are known / still pending, so a gap is never papered over with a guess.
 *
 * WHAT IS ASKED FOR
 *   1. `seasonErrorsUrl(season)` — the query the pipeline already used and
 *      verified live: every play scored a field error in that season. This
 *      covers Error Watch and, because a hit → error change's FINAL ruling is
 *      the error, every hit → error entry too.
 *   2. `dateRangeUrl(from, to)` — all batted balls of a date range, used for
 *      the remaining official entries (plays whose current ruling is a hit,
 *      i.e. error → hit changes). Savant's rows are joined to the pipeline's
 *      plays by `game_pk` + `at_bat_number - 1`, and a response is only used
 *      when its own `game_date` column proves the rows are inside the range
 *      that was asked for (see `rowsInRange`) — an unexpected payload is
 *      flagged and dropped rather than attached to the wrong play.
 * ==========================================================================*/

import fs from 'node:fs';
import path from 'node:path';
import { parseCSV } from './csv.mjs';
import { fetchText } from './http.mjs';

export const SAVANT_SEARCH_URL = 'https://baseballsavant.mlb.com/statcast_search/csv';
export const CACHE_VERSION = 2;

// TTLs (ms) for cached Savant answers — the pipeline runs every 3 hours and
// must not re-ask the same question every run. A live season's error list is
// refreshed twice a day; a finished season's list and a finished date's batted
// balls never change (a re-ruling rewrites a row, hence the monthly re-ask).
export const SAVANT_TTL_CURRENT_SEASON = 6 * 3600 * 1000;
export const SAVANT_TTL_PAST_SEASON = 30 * 24 * 3600 * 1000;
export const SAVANT_TTL_PAST_DATE = 30 * 24 * 3600 * 1000;
export const SAVANT_TTL_TODAY = 3 * 3600 * 1000;
// A play StatsAPI shows but Savant has no row for may simply be unindexed yet:
// only call it unavailable once its game is at least this old.
export const SAVANT_UNAVAILABLE_AFTER_DAYS = 2;

/** Verified query (live pipeline runs): all field errors of one season. */
export function seasonErrorsUrl(season) {
  return `${SAVANT_SEARCH_URL}?all=true&hfAB=field%5C.%5C.error%7C&hfSea=${season}%7C&player_type=batter&type=details`;
}

/**
 * All batted balls between two dates (inclusive), same endpoint/param family
 * as the query above plus Savant's documented date bounds. The response is
 * self-checked against the requested range before any row is used.
 */
export function dateRangeUrl(from, to) {
  return `${SAVANT_SEARCH_URL}?all=true&player_type=batter&type=details`
    + `&game_date_gt=${encodeURIComponent(from)}&game_date_lt=${encodeURIComponent(to)}`;
}

const numOrNull = (v) => {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Parse a Savant statcast-search CSV into one compact row per batted ball.
 * The join key is `game_pk` + `at_bat_number`; the pipeline's atBatIndex is
 * `at_bat_number - 1` (verified against real linked plays).
 */
export function parseSavantRows(csvText) {
  const rows = parseCSV(String(csvText || ''));
  const out = [];
  for (const r of rows) {
    const gamePk = numOrNull(r.game_pk);
    const atBat = numOrNull(r.at_bat_number);
    if (!Number.isFinite(gamePk) || !Number.isFinite(atBat)) continue;
    out.push({
      gamePk,
      ai: atBat - 1,
      gameDate: r.game_date || null,
      events: r.events || null,
      ls: numOrNull(r.launch_speed),
      la: numOrNull(r.launch_angle),
      xba: numOrNull(r.estimated_ba_using_speedangle),
      batterId: numOrNull(r.batter) != null ? numOrNull(r.batter) : null,
    });
  }
  return out;
}

/**
 * Integrity check for ONE date-scoped response: keep only rows whose own
 * `game_date` is inside the requested range. Returns { rows, missingDate,
 * outsideRange } — a non-zero `missingDate` means the response has no usable
 * date evidence and must NOT be attached (the caller flags it instead).
 */
export function rowsInRange(rows, from, to) {
  let missingDate = 0; let outsideRange = 0;
  const kept = [];
  for (const r of rows) {
    if (!r.gameDate) { missingDate += 1; continue; }
    if (r.gameDate < from || r.gameDate > to) { outsideRange += 1; continue; }
    kept.push(r);
  }
  return { rows: kept, missingDate, outsideRange };
}

/** `${gamePk}:${atBatIndex}` → row. Later rows never overwrite earlier ones. */
export function indexByPlay(rows) {
  const map = new Map();
  for (const r of rows || []) {
    const key = `${r.gamePk}:${r.ai}`;
    if (!map.has(key)) map.set(key, r);
  }
  return map;
}

function readCache(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && j.version === CACHE_VERSION && j.queries && typeof j.queries === 'object') return j;
  } catch { /* fresh cache */ }
  return { version: CACHE_VERSION, queries: {} };
}

function writeCache(file, cache) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cache));
    return true;
  } catch {
    return false;
  }
}

/**
 * Create the polite Savant client.
 *
 * @param {object} opts
 *   cacheFile   path to the JSON cache (lives in the Actions cache)
 *   budget      max NETWORK fetches this run (cache hits are free); default 4
 *   delayMs     pause between network fetches; default 2500
 *   timeoutMs   per-request timeout; default 120000
 *   log         logging callback
 *   now         () => ISO string (testable)
 */
export function createSavantClient({
  cacheFile, budget = 4, delayMs = 2500, timeoutMs = 120000, log = () => {}, now = () => new Date().toISOString(),
} = {}) {
  const cache = readCache(cacheFile);
  if (!cache.plays || typeof cache.plays !== 'object') cache.plays = {};
  if (!cache.misses || typeof cache.misses !== 'object') cache.misses = {};
  const state = {
    requests: 0, cacheHits: 0, budget, exhausted: false, rateLimited: false, failures: [], notes: [],
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function recordFailure(reason, url) {
    state.failures.push({ url, reason });
    if (/HTTP 429|HTTP 403/.test(reason)) {
      state.rateLimited = true;
      state.exhausted = true;
      state.notes.push(`savant: ${reason} — stopping Savant requests for this run (retry next run)`);
      log(`savant: ${reason} — stopping Savant requests for this run`);
    }
  }

  /**
   * The Savant answer for one URL, from cache when fresh.
   * Returns { text, rows, fromCache, fetchedAt, error } — `rows` is null when
   * the value is not known (an empty array is a real "no rows" answer and is
   * never used to stand in for "unknown").
   */
  async function fetchRows(url, { ttlMs = 6 * 3600 * 1000, cacheText = true } = {}) {
    const hit = cache.queries[url];
    if (hit && Number.isFinite(Date.parse(hit.fetchedAt))
      && Date.parse(now()) - Date.parse(hit.fetchedAt) < ttlMs && typeof hit.text === 'string') {
      state.cacheHits += 1;
      return { text: hit.text, rows: parseSavantRows(hit.text), fromCache: true, fetchedAt: hit.fetchedAt, error: null };
    }
    if (state.exhausted) return { text: null, rows: null, fromCache: false, fetchedAt: null, error: 'budget' };
    if (state.requests >= budget) {
      state.exhausted = true;
      return { text: null, rows: null, fromCache: false, fetchedAt: null, error: 'budget' };
    }
    if (state.requests > 0) await sleep(delayMs);   // one at a time, politely spaced
    state.requests += 1;
    try {
      const text = await fetchText(url, { timeoutMs, retries: 0 });
      const fetchedAt = now();
      // Only text that will be reused is cached: a month window's rows are
      // absorbed into `cache.plays` by collectPlayXba and the raw CSV (several
      // MB) is deliberately thrown away.
      if (cacheText) cache.queries[url] = { fetchedAt, bytes: text.length, text };
      else delete cache.queries[url];
      writeCache(cacheFile, cache);
      return { text, rows: parseSavantRows(text), fromCache: false, fetchedAt, error: null };
    } catch (err) {
      // Savant answers 404 when a query matches nothing (a date range with no
      // games, say). That is a real "no rows", not a failure to fetch.
      if (err && err.status === 404) {
        return { text: '', rows: [], fromCache: false, fetchedAt: now(), error: null, empty: true };
      }
      const reason = String((err && err.message) || err);
      recordFailure(reason, url);
      return { text: null, rows: null, fromCache: false, fetchedAt: null, error: reason };
    }
  }

  /** May another NETWORK request be made this run? (cache hits are always free) */
  function canRequest() {
    return !state.exhausted && state.requests < budget;
  }

  /** Persist per-play answers collected by the caller (see collectPlayXba). */
  function save() { return writeCache(cacheFile, cache); }

  function summary() {
    return {
      requests: state.requests, cacheHits: state.cacheHits, budget,
      budgetExhausted: state.exhausted, rateLimited: state.rateLimited,
      failures: state.failures.slice(0, 10), notes: state.notes,
      cachedQueries: Object.keys(cache.queries).length,
    };
  }

  return { fetchRows, canRequest, save, summary, cache };
}

/* ------------------------------------------------- per-play xBA collection */

const dayMs = 24 * 3600 * 1000;
const isoDay = (t) => new Date(t).toISOString().slice(0, 10);

/** Last calendar day of `YYYY-MM` (UTC — Savant's game_date is a date only). */
export function monthEnd(month) {
  const [y, m] = month.split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return null;
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/**
 * Attach Savant's per-play xBA to the plays the site surfaces.
 *
 * @param {object} opts
 *   client        from createSavantClient
 *   needed        [{ season, gamePk, ai, gameDate, finalError, hasBattedBall }]
 *                 `finalError` = the play's current ruling is field_error (it is
 *                 in Savant's season error list); `hasBattedBall === false`
 *                 means there is no batted ball to expect an xBA for.
 *   currentSeason the season being tracked live (its error list is refreshed
 *                 more often and its CSV text is kept for the cross-check)
 *   today         YYYY-MM-DD of this run (passed in so it is testable)
 * @returns {{ byKey: Map<string, object>, plays: object, report: object,
 *             currentSeasonErrorList: object|null }}
 *   `byKey` maps `${gamePk}:${ai}` to { xba, ls, la, gameDate, events, at } —
 *   only for plays Savant answered for. Everything else is counted in
 *   `report` (pending / notIndexedYet / unavailable / matchedNoXba).
 */
export async function collectPlayXba({
  client, needed = [], currentSeason = null, today, now = () => new Date().toISOString(), log = () => {},
}) {
  const cache = client.cache;
  const plays = cache.plays;
  const misses = cache.misses;
  const keyOf = (p) => `${p.gamePk}:${p.ai}`;
  const at = now();
  const todayMs = Date.parse(today);
  const askedAt = (k) => Math.max(Date.parse((plays[k] && plays[k].at) || 0) || 0, Date.parse(misses[k] || 0) || 0);
  const fresh = (p) => {
    const t = askedAt(keyOf(p));
    if (!Number.isFinite(t) || !t) return false;
    const ttl = p.gameDate && p.gameDate < today ? SAVANT_TTL_PAST_DATE : SAVANT_TTL_TODAY;
    return Date.parse(at) - t < ttl;
  };

  const wellFormed = needed.filter((p) => p && Number.isFinite(p.gamePk) && Number.isFinite(p.ai) && p.gameDate);
  // A play with no batted ball (no EV/LA at all) can never have an xBA: it is
  // left out of the work and reported as such, never filled with a guess.
  const wanted = wellFormed.filter((p) => p.hasBattedBall !== false);
  const keys = new Set(wanted.map(keyOf));
  const bySeason = new Map();
  for (const p of wanted) {
    if (!bySeason.has(p.season)) bySeason.set(p.season, []);
    bySeason.get(p.season).push(p);
  }
  // Live season first (that is what visitors are looking at), then newest past
  // season. Within a season: the error list (one request for many plays), then
  // month windows newest-month-first so recent games fill in first.
  const seasons = [...bySeason.keys()].sort((a, b) => ((a === currentSeason ? 0 : 1) - (b === currentSeason ? 0 : 1)) || b - a);
  const queries = [];
  for (const season of seasons) {
    const errPlays = bySeason.get(season).filter((p) => p.finalError);
    if (errPlays.length) {
      queries.push({ kind: 'season_errors', season, url: seasonErrorsUrl(season), plays: errPlays, keepText: season === currentSeason });
    }
  }
  for (const season of seasons) {
    const months = new Map();
    for (const p of bySeason.get(season)) {
      if (p.finalError) continue;
      const month = p.gameDate.slice(0, 7);
      if (!months.has(month)) months.set(month, { month, plays: [] });
      months.get(month).plays.push(p);
    }
    for (const w of [...months.values()].sort((a, b) => b.month.localeCompare(a.month))) {
      const from = `${w.month}-01`;
      const to = monthEnd(w.month);
      queries.push({ kind: 'month', season, month: w.month, from, to, url: dateRangeUrl(from, to), plays: w.plays });
    }
  }

  const report = {
    needed: wanted.length,
    excludedNoBattedBall: wellFormed.length - wanted.length,
    matched: 0, matchedNoXba: 0, unavailable: 0, notIndexedYet: 0, pending: 0, coverage: null,
    queries: [], queriesDeferred: 0, failures: [], requests: client.summary().requests, cacheHits: 0, budgetExhausted: false,
  };
  const currentSeasonErrorList = { url: null, text: null, fromCache: false, fetchedAt: null, error: null };

  const absorb = (rows) => {
    let found = 0;
    for (const r of rows) {
      const k = `${r.gamePk}:${r.ai}`;
      if (!keys.has(k)) continue;                       // keep only what the site can show
      plays[k] = { xba: r.xba, ls: r.ls, la: r.la, gameDate: r.gameDate, events: r.events, at };
      delete misses[k];
      found += 1;
    }
    return found;
  };

  for (const q of queries) {
    const pendingPlays = q.plays.filter((p) => !fresh(p));
    if (!pendingPlays.length && !q.keepText) continue;
    const ttl = q.kind === 'season_errors'
      ? (q.season === currentSeason ? SAVANT_TTL_CURRENT_SEASON : SAVANT_TTL_PAST_SEASON)
      : (q.to < today ? SAVANT_TTL_PAST_DATE : SAVANT_TTL_TODAY);
    const res = await client.fetchRows(q.url, { ttlMs: ttl, cacheText: q.keepText });
    if (res.fromCache) report.cacheHits += 1;
    if (q.kind === 'season_errors' && q.season === currentSeason) {
      Object.assign(currentSeasonErrorList, {
        url: q.url, text: res.text, fromCache: res.fromCache, fetchedThisRun: !res.fromCache,
        fetchedAt: res.fetchedAt, error: res.error,
      });
    }
    if (res.rows == null) {
      // A budget refusal is not an error: the plays simply stay pending for a
      // later run (that is the whole point of the budget).
      if (res.error === 'budget') report.queriesDeferred = (report.queriesDeferred || 0) + 1;
      else report.failures.push({ url: q.url, error: res.error });
      continue;
    }
    let rows = res.rows;
    let integrity = null;
    if (q.kind === 'month') {
      const r = rowsInRange(rows, q.from, q.to);
      integrity = { kept: r.rows.length, outsideRange: r.outsideRange, missingDate: r.missingDate };
      rows = r.rows;
    }
    const found = absorb(rows);
    const foundKeys = new Set(rows.map((r) => `${r.gamePk}:${r.ai}`));
    let missed = 0;
    for (const p of pendingPlays) {
      const k = keyOf(p);
      if (foundKeys.has(k) || plays[k]) continue;
      if (!misses[k] || Date.parse(misses[k]) < Date.parse(at)) { misses[k] = at; missed += 1; }
    }
    report.queries.push({
      url: q.url, kind: q.kind, season: q.season, month: q.month || null,
      rows: rows.length, fromCache: !!res.fromCache, asked: pendingPlays.length, found, missed, integrity,
    });
    if (integrity && integrity.outsideRange > integrity.kept) {
      report.failures.push({ url: q.url, error: `date range not honored (${integrity.outsideRange} rows outside ${q.from}..${q.to} were ignored)` });
    }
  }
  await client.save();

  const byKey = new Map();
  for (const p of wanted) {
    const k = keyOf(p);
    if (plays[k]) byKey.set(k, plays[k]);
  }
  for (const p of wanted) {
    const k = keyOf(p);
    const rec = plays[k];
    if (rec && rec.xba != null) report.matched += 1;
    else if (rec) report.matchedNoXba += 1;
    else if (misses[k]) {
      const old = Number.isFinite(todayMs) && Number.isFinite(Date.parse(p.gameDate))
        && Math.abs(todayMs - Date.parse(p.gameDate)) >= SAVANT_UNAVAILABLE_AFTER_DAYS * dayMs;
      if (old) report.unavailable += 1; else report.notIndexedYet += 1;
    } else report.pending += 1;
  }
  report.coverage = wanted.length ? Math.round((report.matched / wanted.length) * 1e4) / 1e4 : null;
  report.requests = client.summary().requests;
  report.budgetExhausted = client.summary().budgetExhausted;
  if (report.pending) log(`savant per-play xBA: ${report.matched}/${wanted.length} known, ${report.pending} still to ask for`);
  return { byKey, plays, report, currentSeasonErrorList };
}
