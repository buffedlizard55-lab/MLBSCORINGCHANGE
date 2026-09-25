#!/usr/bin/env node
/* ============================================================================
 * pipeline/run.mjs — official-data pipeline (runs on GitHub Actions).
 *
 *  1. Official scoring-change logs  (MLB page; prior seasons via Internet
 *     Archive snapshots of the same page) → parse → classify.
 *  2. Every completed game of each season from MLB StatsAPI playByPlay →
 *     compact per-plate-appearance records (cached between runs).
 *  3. Link each official entry to its game + plate appearance and verify it
 *     against the play's current official ruling.
 *  4. Build the scoring model (hit-probability surface, error→hit and
 *     hit→error logistic models, pending-ruling outcome tables).
 *  5. Write data/official/*.json, data/model/*.json with provenance, a
 *     pipeline report and an irregularities list. Every play a row links to
 *     also carries Baseball Savant's own per-play xBA
 *     (`estimated_ba_using_speedangle`) when Savant has it — attached through
 *     a rate-limit-respectful, cached client (pipeline/lib/savant.mjs).
 *  6. Join the live-captured rulings (data/capture, pipeline/capture.mjs)
 *     with the final rulings: error-type adjustment, pending calibration.
 *  7. Re-test official-scorer and home-park effects (gameData.officialScorer).
 *
 * Flags: --seasons=2024,2025,2026  --max-games=N  --skip-fetch  --no-savant
 *        --no-meta (skip the per-game official-scorer lookups)
 *        --savant-budget=N (Savant requests per run, default 4)
 *        --savant-delay-ms=N (pause between Savant requests, default 2500)
 * ==========================================================================*/

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fetchText, pool } from './lib/http.mjs';
import { parseLogHtml } from './lib/log-parser.mjs';
import { classifyEntry, transitionFlags, originalErrorKindFromLog } from './lib/log-classifier.mjs';
import {
  getTeams, getSeasonSchedule, isCompleted, getPlayByPlay, extractGamePlays, samePlays,
  HIT_EVENTS, playByPlayUrl, getGameMeta, gameMetaUrl,
} from './lib/statsapi.mjs';
import { parseMonth } from './lib/capture-lib.mjs';
import { capturedAdjustment, pendingCalibration } from './lib/adjust.mjs';
import { heterogeneityTest, groupTable } from './lib/effects.mjs';
import { buildTeamIndex, linkEntry, rulingAgrees, isVerifiedRunnerErrorChange } from './lib/link.mjs';
import {
  buildHitProbSurface, buildHitProbFallback, buildPendingTable, selectAndFit, SM, isBattedBall,
} from './lib/model-build.mjs';
import { parseCSV } from './lib/csv.mjs';
import {
  collectPlayXba, createSavantClient, SAVANT_SEARCH_URL,
} from './lib/savant.mjs';
import { LINKER_VERSION } from './lib/link.mjs';
import { statEffects } from './lib/stat-effects.mjs';
import { buildErrorEvents, gameScanRow } from './lib/error-events.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = process.env.PIPELINE_CACHE_DIR || path.join(ROOT, 'pipeline-cache');
const OUT_BASE = process.env.PIPELINE_OUT_DIR || path.join(ROOT, 'data');
const OUT_OFFICIAL = path.join(OUT_BASE, 'official');
const OUT_MODEL = path.join(OUT_BASE, 'model');
const PROBE_DIR = process.env.PIPELINE_PROBE_DIR || path.join(ROOT, '_probe');
const CACHE_VERSION = 3;   // v3 (session 5): + vid / errs / er / ur / tu per play
const META_CACHE_VERSION = 1;
// A captured call counts as the ORIGINAL call only if it was first seen
// within this many minutes of the end of the play.
const ORIGINAL_MAX_LAG_MIN = 30;
const REFRESH_DAYS = 21;      // re-fetch recent games: rulings can still change
const LABEL_LAG_DAYS = 14;    // training uses games at least this old
const FETCH_CONCURRENCY = 8;
const MODEL_VERSION = 1;

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));
// Default: every season from 2024 through the current year, so the pipeline
// keeps working across season rollovers without code changes.
const FIRST_SEASON = 2024;
const THIS_YEAR = new Date().getUTCFullYear();
const SEASONS = String(args.seasons || Array.from({ length: THIS_YEAR - FIRST_SEASON + 1 }, (_, i) => FIRST_SEASON + i).join(','))
  .split(',').map(Number).filter(Boolean);
const MAX_GAMES = args['max-games'] ? Number(args['max-games']) : Infinity;

const LOG_PAGE = 'https://www.mlb.com/official-information/scoring-changes';
// The live page lists the current season. Seasons it no longer lists come
// from (a) an Internet Archive capture taken after the season ended (found via
// https://web.archive.org/cdx/search/cdx?url=mlb.com/official-information/scoring-changes)
// or (b) this repo's stored copy from when the live page still listed them.
const ARCHIVE_SOURCES = {
  2025: {
    kind: 'archive',
    url: `https://web.archive.org/web/20260210034254id_/${LOG_PAGE}`,
    page: `https://web.archive.org/web/20260210034254/${LOG_PAGE}`,
    archivedAt: '2026-02-10T03:42:54Z',
  },
  2024: {
    kind: 'archive',
    url: `https://web.archive.org/web/20250121083545id_/${LOG_PAGE}`,
    page: `https://web.archive.org/web/20250121083545/${LOG_PAGE}`,
    archivedAt: '2025-01-21T08:35:45Z',
  },
};
const LOG_SOURCES = ARCHIVE_SOURCES; // (name kept for the sources list below)
const NOW = new Date();
const TODAY = NOW.toISOString().slice(0, 10);
const addDays = (iso, d) => new Date(Date.parse(`${iso}T12:00:00Z`) + d * 86400000).toISOString().slice(0, 10);
const LABEL_CUTOFF = addDays(TODAY, -LABEL_LAG_DAYS);
const REFRESH_CUTOFF = addDays(TODAY, -REFRESH_DAYS);
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const log = (...a) => console.log(`[pipeline ${new Date().toISOString().slice(11, 19)}]`, ...a);
const round = (v, d = 4) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);

function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 1)}\n`);
}
/**
 * Large generated lists (data/model/error-events-<season>.json): compact JSON
 * with ONE array item per line, so git stores small line deltas between runs
 * instead of a new multi-MB line. The file is left untouched when nothing but
 * `generatedAt` changed (past seasons are stable), so a run commits nothing
 * for them.
 */
function writeJSONLines(file, data, arrayKeys) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const prev = readJSON(file, null);
  if (prev) {
    const strip = (o) => JSON.stringify({ ...o, generatedAt: null });
    if (strip(prev) === strip(data)) return false;
  }
  const head = Object.fromEntries(Object.entries(data).filter(([k]) => !arrayKeys.includes(k)));
  const parts = Object.entries(head).map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`);
  for (const k of arrayKeys) {
    const list = Array.isArray(data[k]) ? data[k] : [];
    parts.push(`${JSON.stringify(k)}:[${list.length ? `\n${list.map((x) => JSON.stringify(x)).join(',\n')}\n` : ''}]`);
  }
  fs.writeFileSync(file, `{${parts.join(',\n')}}\n`);
  return true;
}
function readJSON(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
const hist = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by);
const histObj = (map, limit = 60) => Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit));

const report = {
  generatedAt: NOW.toISOString(),
  pipelineVersion: MODEL_VERSION,
  settings: { seasons: SEASONS, refreshDays: REFRESH_DAYS, labelLagDays: LABEL_LAG_DAYS, labelCutoff: LABEL_CUTOFF },
  logs: {},
  seasons: {},
  discovery: {},
  savant: {},
  model: {},
  warnings: [],
};
const irregularities = [];

// Savant client: every request is cached on disk (pipeline-cache/savant.json,
// restored by the Actions cache) and capped per run — see pipeline/lib/savant.mjs.
const savant = args['no-savant'] ? null : createSavantClient({
  cacheFile: path.join(CACHE_DIR, 'savant.json'),
  budget: Number(args['savant-budget'] || 4),
  delayMs: Number(args['savant-delay-ms'] || 2500),
  log,
});

/* ------------------------------------------------------------------ 1 logs */
let livePage = null;
async function getLivePage() {
  if (livePage) return livePage;
  try {
    const html = await fetchText(LOG_PAGE, { timeoutMs: 90000 });
    const sections = parseLogHtml(html);
    livePage = { html, sections, sha256: sha256(html), bytes: html.length };
    if (!sections.some((sec) => sec.label)) {
      // No season header at all: the page structure changed. Keep an excerpt
      // for diagnosis, never fail silently. (A header with no entries yet is
      // normal at the start of a season.)
      fs.mkdirSync(PROBE_DIR, { recursive: true });
      const at = html.indexOf(' -- In the ');
      fs.writeFileSync(path.join(PROBE_DIR, 'live-log-excerpt.txt'),
        `bytes=${html.length}\nfirst " -- In the " at ${at}\n\n${html.slice(Math.max(0, at - 3000), at + 3000)}`);
      report.warnings.push('official log: no season header found on the live page (excerpt written to _probe/)');
    }
  } catch (err) {
    livePage = { error: String(err && err.message || err), sections: [] };
    report.warnings.push(`official log: live page unavailable (${livePage.error})`);
  }
  return livePage;
}

function stripDerived(entries) {
  return (entries || []).map(({ cls, link, model, ...rest }) => rest);
}

function buildLogInfo(season, sections, source) {
  const entries = sections.flatMap((sec, si) => sec.entries.map((e) => ({ ...e, section: sec.label, sectionIndex: si })));
  fs.mkdirSync(path.join(OUT_OFFICIAL, 'raw'), { recursive: true });
  fs.writeFileSync(path.join(OUT_OFFICIAL, 'raw', `scoring-changes-${season}.txt`),
    `# Official MLB scoring changes — ${season}\n# Source: ${source.url}\n# Fetched: ${source.fetchedAt}  sha256(html)=${source.sha256}\n`
    + '# Verbatim entry lines as extracted from the page (one per line).\n\n'
    + entries.map((e) => e.raw).join('\n') + '\n');
  return {
    season,
    source,
    sections: sections.map((sec) => ({ label: sec.label, entries: sec.entries.length, issues: sec.issues })),
    entries,
  };
}

async function loadOfficialLog(season) {
  const outFile = path.join(OUT_OFFICIAL, `scoring-changes-${season}.json`);
  const previous = readJSON(outFile);
  const fromPrevious = (why) => {
    report.logs[season] = { ok: true, source: 'stored', note: why, entries: previous.entries.length };
    return {
      season: previous.season, source: previous.source, sections: previous.sections,
      entries: stripDerived(previous.entries), fromPrevious: true,
    };
  };
  // 1. The live page, when it lists this season.
  const live = await getLivePage();
  const liveSections = (live.sections || []).filter((sec) => sec.season === season && sec.entries.length);
  if (liveSections.length) {
    const info = buildLogInfo(season, liveSections, {
      kind: 'live', url: LOG_PAGE, fetchedUrl: LOG_PAGE, archivedAt: null,
      fetchedAt: NOW.toISOString(), sha256: live.sha256, bytes: live.bytes,
    });
    report.logs[season] = { ok: true, source: 'live', entries: info.entries.length, sections: info.sections };
    return info;
  }
  // 2. An Internet Archive capture (immutable: reuse the stored parse).
  const src = ARCHIVE_SOURCES[season];
  if (src) {
    if (previous && previous.source && previous.source.fetchedUrl === src.url && (previous.entries || []).length) {
      return fromPrevious(`archive capture ${src.archivedAt} already stored`);
    }
    try {
      const html = await fetchText(src.url, { timeoutMs: 90000 });
      const sections = parseLogHtml(html).filter((sec) => sec.season === season && sec.entries.length);
      if (!sections.length) throw new Error(`archive capture has no ${season} entries`);
      const info = buildLogInfo(season, sections, {
        kind: 'archive', url: src.page, fetchedUrl: src.url, archivedAt: src.archivedAt,
        fetchedAt: NOW.toISOString(), sha256: sha256(html), bytes: html.length,
      });
      report.logs[season] = { ok: true, source: 'archive', entries: info.entries.length, sections: info.sections };
      return info;
    } catch (err) {
      report.warnings.push(`official log ${season}: ${err && err.message}`);
      if (previous) return fromPrevious('archive fetch failed; stored copy used');
      report.logs[season] = { ok: false, error: String(err && err.message || err) };
      return null;
    }
  }
  // 3. This repo's stored copy (e.g. last season, no longer on the live page).
  if (previous && (previous.entries || []).length) return fromPrevious('not on the live page; stored copy used');
  report.logs[season] = { ok: !live.error, source: 'none', entries: 0,
    note: live.error ? 'live page unavailable' : 'no entries published for this season yet' };
  return null;
}

/* --------------------------------------------------------------- 2 plays */
function cacheFile(season) { return path.join(CACHE_DIR, `plays-${season}.json.gz`); }
function metaFile(season) { return path.join(CACHE_DIR, `meta-${season}.json.gz`); }
function loadMeta(season) {
  try {
    const j = JSON.parse(zlib.gunzipSync(fs.readFileSync(metaFile(season))).toString('utf8'));
    if (j.version === META_CACHE_VERSION) return j;
  } catch { /* fresh */ }
  return { version: META_CACHE_VERSION, season, games: {} };
}
function saveMeta(season, meta) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(metaFile(season), zlib.gzipSync(JSON.stringify(meta)));
}
function loadCache(season) {
  try {
    const j = JSON.parse(zlib.gunzipSync(fs.readFileSync(cacheFile(season))).toString('utf8'));
    if (j.version === CACHE_VERSION) return j;
  } catch { /* fresh cache */ }
  return { version: CACHE_VERSION, season, games: {} };
}
function saveCache(season, cache) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cacheFile(season), zlib.gzipSync(JSON.stringify(cache)));
}

async function loadSeasonPlays(season) {
  const { teams, url: teamsUrl } = await getTeams(season);
  const sched = await getSeasonSchedule(season);
  const completed = sched.games.filter(isCompleted);
  const cache = loadCache(season);
  const isCurrent = season === Math.max(...SEASONS);
  const need = completed.filter((g) => {
    const c = cache.games[g.gamePk];
    if (!c) return true;
    return isCurrent && g.officialDate >= REFRESH_CUTOFF;
  }).slice(0, Number.isFinite(MAX_GAMES) ? MAX_GAMES : undefined);
  log(`${season}: ${sched.games.length} scheduled, ${completed.length} completed, fetching ${args['skip-fetch'] ? 0 : need.length}`);
  let fetched = 0; let failed = 0;
  const failures = [];
  if (!args['skip-fetch']) {
    await pool(need, FETCH_CONCURRENCY, async (g) => {
      try {
        const pbp = await getPlayByPlay(g.gamePk);
        cache.games[g.gamePk] = { fetchedAt: new Date().toISOString(), plays: extractGamePlays(pbp, g.gamePk) };
        fetched += 1;
        if (fetched % 250 === 0) log(`${season}: fetched ${fetched}/${need.length}`);
      } catch (err) {
        failed += 1;
        if (failures.length < 20) failures.push({ gamePk: g.gamePk, error: String(err.message || err) });
      }
    });
  }
  // Self-check: projected extraction must equal full-payload extraction.
  const probeGame = need.find((g) => cache.games[g.gamePk]) || completed.find((g) => cache.games[g.gamePk]);
  let selfCheck = null;
  if (probeGame && !args['skip-fetch']) {
    const [proj, full] = await Promise.all([
      getPlayByPlay(probeGame.gamePk, { projected: true }),
      getPlayByPlay(probeGame.gamePk, { projected: false }),
    ]);
    const a = extractGamePlays(proj, probeGame.gamePk);
    const b = extractGamePlays(full, probeGame.gamePk);
    selfCheck = { gamePk: probeGame.gamePk, projectedUrl: playByPlayUrl(probeGame.gamePk, true), equal: samePlays(a, b), plays: a.length };
    if (!selfCheck.equal) {
      const firstDiff = a.findIndex((r, i) => JSON.stringify(r) !== JSON.stringify(b[i]));
      selfCheck.firstDiff = { projected: a[firstDiff], full: b[firstDiff] };
      throw new Error(`projection self-check failed for ${probeGame.gamePk}: ${JSON.stringify(selfCheck.firstDiff).slice(0, 800)}`);
    }
  }
  saveCache(season, cache);
  // Official scorer + venue per game (tiny feed/live projection, cached for
  // good; a missing scorer on a recent game is looked up again).
  const meta = loadMeta(season);
  const needMeta = args['no-meta'] || args['skip-fetch'] ? [] : completed.filter((g) => {
    const c = meta.games[g.gamePk];
    return !c || (c.scorerId == null && g.officialDate >= REFRESH_CUTOFF);
  }).slice(0, Number.isFinite(MAX_GAMES) ? MAX_GAMES : undefined);
  let metaFetched = 0; let metaFailed = 0;
  await pool(needMeta, 12, async (g) => {
    try {
      meta.games[g.gamePk] = { ...(await getGameMeta(g.gamePk)), fetchedAt: new Date().toISOString() };
      metaFetched += 1;
    } catch { metaFailed += 1; }
  });
  saveMeta(season, meta);
  const metaByGame = new Map(completed.map((g) => [g.gamePk, meta.games[g.gamePk] || null]));
  const playsByGame = new Map();
  for (const g of completed) {
    const c = cache.games[g.gamePk];
    if (c) playsByGame.set(g.gamePk, c.plays);
  }
  report.seasons[season] = {
    teamsUrl, scheduleUrls: sched.urls,
    scheduled: sched.games.length, completed: completed.length,
    gamesWithPlays: playsByGame.size, fetched, failed, failures, selfCheck,
    meta: {
      url: completed[0] ? gameMetaUrl(completed[0].gamePk) : null,
      fetched: metaFetched, failed: metaFailed,
      withScorer: completed.filter((g) => meta.games[g.gamePk] && meta.games[g.gamePk].scorerId != null).length,
      scorers: new Set(completed.map((g) => meta.games[g.gamePk] && meta.games[g.gamePk].scorerId).filter((v) => v != null)).size,
    },
    byGameType: histObj(completed.reduce((m, g) => hist(m, g.gameType), new Map())),
  };
  if (playsByGame.size < completed.length) {
    report.warnings.push(`${season}: ${completed.length - playsByGame.size} completed games have no play data`);
  }
  return { teams, games: completed, playsByGame, metaByGame };
}

/* ----------------------------------------------------------- helpers */
function categoryOfEvent(et) {
  if (HIT_EVENTS.has(et)) return 'hit';
  if (et === 'field_error') return 'error';
  if (et === 'fielders_choice' || et === 'fielders_choice_out') return 'fc';
  if (/^sac_/.test(et || '')) return 'sac';
  return 'other';
}
const isHitCat = (c) => c === 'hit' || c === 'hit+error';

/**
 * Savant cross-check for one season. The CSV is fetched through the polite,
 * cached client by the caller (`preFetched.text`) so the season-wide query is
 * asked at most once per TTL instead of on every run; when the caller has no
 * text (no Savant this run) the check reports that honestly instead of
 * fetching behind its back.
 */
async function savantCrossCheck(season, fieldErrorRecs, model, preFetched = null) {
  try {
    const csv = preFetched && typeof preFetched.text === 'string' ? preFetched.text : null;
    if (csv == null) {
      return {
        url: SAVANT_SEARCH_URL, skipped: true,
        reason: preFetched && preFetched.error ? `no Savant response this run (${preFetched.error})`
          : 'Savant not queried this run',
      };
    }
    const allRows = parseCSV(csv);
    // Savant's default search includes Spring Training (verified: gamePks
    // 831545 / 832077 are gameType "S" in StatsAPI /schedule). Compare only
    // the game types this pipeline scans.
    const KEEP = new Set(['R', 'F', 'D', 'L', 'W']);
    const byType = allRows.reduce((m, r) => hist(m, r.game_type || '?'), new Map());
    const rows = allRows.some((r) => r.game_type) ? allRows.filter((r) => KEEP.has(r.game_type)) : allRows;
    const byKey = new Map(rows.map((r) => [`${r.game_pk}:${Number(r.at_bat_number) - 1}`, r]));
    let matched = 0; let evAgree = 0; let laAgree = 0; let bothEv = 0;
    const onlyOurs = []; const pairs = [];
    for (const rec of fieldErrorRecs) {
      const r = byKey.get(`${rec.g}:${rec.ai}`);
      if (!r) { if (onlyOurs.length < 15) onlyOurs.push(`${rec.g}:${rec.ai}`); continue; }
      matched += 1;
      byKey.delete(`${rec.g}:${rec.ai}`);
      const ls = parseFloat(r.launch_speed); const la = parseFloat(r.launch_angle);
      if (rec.hd && Number.isFinite(rec.hd.ls) && Number.isFinite(ls)) {
        bothEv += 1;
        if (Math.abs(rec.hd.ls - ls) < 0.15) evAgree += 1;
        if (Number.isFinite(rec.hd.la) && Number.isFinite(la) && Math.abs(rec.hd.la - la) < 0.6) laAgree += 1;
      }
      const xba = parseFloat(r.estimated_ba_using_speedangle);
      const hp = SM.hitProbability(model, SM.playFromRecord(rec));
      if (Number.isFinite(xba) && hp.source === 'ev_la') pairs.push([hp.p, xba]);
    }
    const pearson = (() => {
      if (pairs.length < 3) return null;
      const n = pairs.length;
      const mx = pairs.reduce((s, p) => s + p[0], 0) / n; const my = pairs.reduce((s, p) => s + p[1], 0) / n;
      let sxy = 0; let sxx = 0; let syy = 0;
      for (const [x, y] of pairs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
      return sxy / Math.sqrt(sxx * syy);
    })();
    const mad = pairs.length ? pairs.reduce((s, [x, y]) => s + Math.abs(x - y), 0) / pairs.length : null;
    return {
      url: SAVANT_SEARCH_URL,
      cached: !!(preFetched && preFetched.fromCache),
      fetchedThisRun: preFetched ? !!preFetched.fetchedThisRun : null,
      fetchedAt: (preFetched && preFetched.fetchedAt) || null,
      rowsAllGameTypes: allRows.length, rowsByGameType: histObj(byType),
      rows: rows.length, statsapiFieldErrors: fieldErrorRecs.length,
      matched, onlySavant: byKey.size, onlySavantExamples: [...byKey.keys()].slice(0, 15), onlyStatsApiExamples: onlyOurs,
      exitVelocityAgreement: bothEv ? round(evAgree / bothEv, 4) : null,
      launchAngleAgreement: bothEv ? round(laAgree / bothEv, 4) : null,
      hitProbVsSavantXba: { n: pairs.length, pearson: round(pearson, 4), meanAbsDiff: round(mad, 4) },
    };
  } catch (err) {
    report.warnings.push(`savant cross-check ${season}: ${err.message}`);
    return { url: SAVANT_SEARCH_URL, error: String(err.message || err) };
  }
}

/* ---------------------------------------------------------------- main */
async function main() {
  log(`start; seasons=${SEASONS.join(',')} today=${TODAY} labelCutoff=${LABEL_CUTOFF}`);
  let currentSeason = Math.max(...SEASONS);   // refined below: latest season with completed games
  const perSeason = new Map();
  const allBatted = [];
  const errorRows = []; const hitRows = [];
  const disc = {
    creditCodes: new Map(), fieldErrorBatterCredits: new Map(), pendingExamples: [], pendingCounts: new Map(),
    pendingPairs: [], advisories: [], locations: new Map(), trajectories: new Map(), unresolvedPendingResults: [],
    fieldErrorCoverage: { total: 0, withEvLa: 0, withTraj: 0, withLoc: 0 },
    errorKindCheck: new Map(),
  };
  // Cross-season lookups for the live-capture join and the scorer tests.
  const gameInfoAll = new Map();   // gamePk → {officialDate, season, gameType, homeId, away, home}
  const chainsAll = new Map();     // "gamePk:ai" → official log entries (ruling changes)
  const playsByGameAll = new Map();
  const metaAll = new Map();       // gamePk → {scorerId, scorerName, venueId, venueName}

  for (const season of SEASONS) {
    const logInfo = await loadOfficialLog(season);
    const { teams, games, playsByGame, metaByGame } = await loadSeasonPlays(season);
    const teamIndex = buildTeamIndex(teams);
    const teamsById = new Map(teams.map((t) => [t.id, t]));
    const abbr = new Map(teams.map((t) => [t.id, t.abbreviation]));
    const gameById = new Map(games.map((g) => [g.gamePk, g]));
    const entries = logInfo ? logInfo.entries : [];

    // 3. classify + link + verify
    const linkFlags = new Map(); const kinds = new Map(); const transitions = new Map();
    const dateRecoveries = [];
    // Order hint for the date-recovery pass: the official list is published in
    // order, so the dates of the neighbouring entries bound where this one's
    // game can be. Used only to break a tie between two games that BOTH pass
    // the batter + ruling checks — never to pick a game on its own.
    const orderHintFor = (i) => {
      let prevDate = null; let nextDate = null;
      for (let j = i - 1; j >= 0 && !prevDate; j -= 1) prevDate = entries[j].date || null;
      for (let j = i + 1; j < entries.length && !nextDate; j += 1) nextDate = entries[j].date || null;
      return { prevDate, nextDate };
    };
    for (let ei = 0; ei < entries.length; ei += 1) {
      const e = entries[ei];
      e.cls = classifyEntry(e.body);
      e.cls.flags = Object.entries(transitionFlags(e.cls)).filter(([, v]) => v).map(([k]) => k);
      e.link = linkEntry(e, { teamIndex, games, playsByGame, teamsById, orderHint: orderHintFor(ei) });
      const g = gameById.get(e.link.gamePk);
      if (g) {
        e.link.officialDate = g.officialDate;
        e.link.gameType = g.gameType;
        e.link.away = abbr.get(g.awayId) || null;
        e.link.home = abbr.get(g.homeId) || null;
      }
      // Runner-level error reassignments: not a plate-appearance mismatch.
      const mi = e.link.flags.indexOf('current_ruling_mismatch');
      const linkedRec = e.link.gamePk != null && e.link.atBatIndex != null
        ? (playsByGame.get(e.link.gamePk) || []).find((p) => p.ai === e.link.atBatIndex) || null
        : null;
      if (mi >= 0 && linkedRec) {
        if (isVerifiedRunnerErrorChange(e, linkedRec)) e.link.flags[mi] = 'runner_error_change:verified';
      }
      // Session 5: facts of the linked play (StatsAPI, current state) — the
      // pitcher, the video evidence and the play's CURRENT RBI / earned /
      // unearned runs — so each stat change can be checked by hand.
      if (linkedRec) {
        e.link.pitcherName = linkedRec.pn || null;
        e.link.pitcherId = linkedRec.p ?? null;
        e.link.playId = linkedRec.vid || null;
        e.link.currentRbi = linkedRec.rbi ?? null;
        e.link.currentEarnedRuns = linkedRec.er || 0;
        e.link.currentUnearnedRuns = linkedRec.ur || 0;
      }
      const trusted = linkedRec && !e.link.flags.includes('current_ruling_mismatch');
      e.stats = statEffects(e, trusted ? {
        batterName: e.link.batterName || null, batterId: e.link.batterId ?? null,
        pitcherName: e.link.pitcherName, pitcherId: e.link.pitcherId,
        currentEventType: e.link.currentEventType || null,
      } : { currentEventType: linkedRec ? e.link.currentEventType || null : null });
      // RBI stated only as a total ("now has an RBI") or only on the original
      // ruling: compare with / settle from the play's CURRENT StatsAPI RBI.
      if (trusted && typeof e.link.currentRbi === 'number') {
        for (const d of e.stats.batting) {
          if (d.stat !== 'RBI') continue;
          if (d.now != null) d.statsapiAgrees = d.now === e.link.currentRbi;
          if (d.delta == null && d.old != null && d.rule === 'rbi:only_in_original_ruling' && d.old !== e.link.currentRbi) {
            d.delta = e.link.currentRbi - d.old;
            d.sign = Math.sign(d.delta);
            d.now = e.link.currentRbi;
            d.nowSource = 'statsapi';
            d.rule += '+statsapi_now';
          }
        }
      }
      if (e.stats.battingChange) e.cls.flags.push('battingStat');
      if (e.stats.pitchingChange) e.cls.flags.push('pitchingStat');
      if (e.stats.unparsed.length) {
        irregularities.push({
          season, seq: e.seq, section: e.section, raw: e.raw, parseIssues: [], linkFlags: ['stat_effect_unparsed'],
          sourceUrl: logInfo && logInfo.source ? logInfo.source.url : null,
          classification: e.cls.kind === 'ruling_change' ? e.cls.transition : e.cls.kind,
          gamePk: e.link.gamePk, atBatIndex: e.link.atBatIndex, currentEventType: e.link.currentEventType || null,
          note: `stat wording not understood: ${e.stats.unparsed.join(' | ')}`,
        });
      }
      hist(kinds, e.cls.kind);
      if (e.cls.transition) hist(transitions, e.cls.transition);
      // Date recoveries: the official log's date was wrong and the entry was
      // placed in another game of the same season, verified by the batter +
      // ruling check. Reported per season (and as an irregularity) so a wrong
      // date in MLB's list is visible, never silently corrected.
      const recovered = e.link.flags.find((f) => f.startsWith('date_recovered:'));
      if (recovered) {
        dateRecoveries.push({
          seq: e.seq, statedDate: e.date, gameDate: e.link.officialDate || null,
          gamePk: e.link.gamePk, atBatIndex: e.link.atBatIndex,
          kind: (e.link.flags.find((f) => f.startsWith('date_typo:')) || '').split(':')[1] || null,
          verifiedBy: e.link.flags.includes('date_recovered_game_only') ? 'unique pairing' : 'batter + ruling',
          // What separated the games when the entry's own text could not:
          // 'only game verified' | 'exact ruling' | 'log order' (see
          // pipeline/lib/link.mjs recoverGameForEntry).
          decidedBy: (e.link.flags.find((f) => f.startsWith('date_recovery_decided_by:')) || '').split(':')[1] || 'only game verified',
          daysOff: e.date && e.link.officialDate
            ? Math.round((Date.parse(`${e.link.officialDate}T12:00:00Z`) - Date.parse(`${e.date}T12:00:00Z`)) / 86400000)
            : null,
          transition: e.cls.transition || e.cls.kind,
        });
      }
    }

    // 4a. reconstruct initial vs final ruling for every plate appearance
    const chains = new Map();
    for (const e of entries) {
      if (e.cls.kind !== 'ruling_change' || e.link.gamePk == null || e.link.atBatIndex == null) continue;
      const key = `${e.link.gamePk}:${e.link.atBatIndex}`;
      if (!chains.has(key)) chains.set(key, []);
      chains.get(key).push(e);
    }
    for (const list of chains.values()) list.sort((a, b) => a.seq - b.seq);
    for (const [key, list] of chains) chainsAll.set(key, list);
    for (const g of games) {
      gameInfoAll.set(g.gamePk, {
        officialDate: g.officialDate, season, gameType: g.gameType, homeId: g.homeId,
        away: abbr.get(g.awayId) || null, home: abbr.get(g.homeId) || null,
      });
      if (metaByGame.get(g.gamePk)) metaAll.set(g.gamePk, metaByGame.get(g.gamePk));
    }
    for (const [pk, plays] of playsByGame) playsByGameAll.set(pk, plays);
    // An earlier entry whose ruling a later entry on the same play replaced
    // is not a mismatch: annotate it (the chain's last entry is what counts).
    for (const list of chains.values()) {
      const last = list[list.length - 1];
      if (list.length < 2 || last.link.flags.includes('current_ruling_mismatch')) continue;
      for (const e of list.slice(0, -1)) {
        const i = e.link.flags.indexOf('current_ruling_mismatch');
        if (i >= 0) e.link.flags[i] = `superseded_by:${last.seq}`;
      }
    }
    for (const e of entries) {
      for (const f of e.link.flags) hist(linkFlags, f.split(':')[0]);
      // Link flags matter for ruling changes (they feed the model); for
      // bookkeeping-only entries (earned runs, RBIs, WP/PB) flag parse issues.
      // A date recovery is always an irregularity: the official log's stated
      // date differs from the game the play is in (or could not be verified at
      // a date at all), and that has to be reviewable by hand even when the
      // entry's own text parsed cleanly.
      const important = e.issues.length
        || e.link.flags.some((f) => /^date_recover/.test(f))
        || (e.cls.kind === 'ruling_change'
        && e.link.flags.some((f) => !/^team_alias|^team_code_via|^name_match:last_name|^superseded_by|^current_ruling_compatible|^runner_error_change:verified/.test(f)));
      if (important || e.cls.kind === 'unclassified') {
        irregularities.push({
          season, seq: e.seq, section: e.section, raw: e.raw, parseIssues: e.issues, linkFlags: e.link.flags,
          sourceUrl: logInfo && logInfo.source ? logInfo.source.url : null,
          classification: e.cls.kind === 'ruling_change' ? e.cls.transition : e.cls.kind,
          gamePk: e.link.gamePk, atBatIndex: e.link.atBatIndex, currentEventType: e.link.currentEventType || null,
        });
      }
    }

    let seasonFieldErrors = 0; let seasonPAs = 0; let chainsDropped = 0;
    const fieldErrorRecs = [];
    // Entries the linker could not place on a play: no model score is possible
    // for them, so the count is reported per season for both directions.
    const unlinkedErrorToHit = entries.filter((e) => e.cls.flags.includes('errorToHit') && e.link.atBatIndex == null).length;
    const unlinkedHitToError = entries.filter((e) => e.cls.flags.includes('hitToError') && e.link.atBatIndex == null).length;
    for (const [gamePk, plays] of playsByGame) {
      const g = gameById.get(gamePk);
      for (let idx = 0; idx < plays.length; idx += 1) {
        const rec = plays[idx];
        if (rec.ty !== 'atBat') continue;
        seasonPAs += 1;
        if (rec.et === 'field_error') {
          seasonFieldErrors += 1;
          fieldErrorRecs.push(rec);
          disc.fieldErrorCoverage.total += 1;
          if (rec.hd && Number.isFinite(rec.hd.ls) && Number.isFinite(rec.hd.la)) disc.fieldErrorCoverage.withEvLa += 1;
          if (rec.hd && rec.hd.traj) disc.fieldErrorCoverage.withTraj += 1;
          if (rec.hd && rec.hd.loc) disc.fieldErrorCoverage.withLoc += 1;
          for (const c of rec.cr || []) if (c.endsWith('|B')) hist(disc.fieldErrorBatterCredits, c.split('|')[0]);
          // Error type from credits vs from the description (verification of
          // SM.errorKindOfRecord's two sources).
          const fromCredits = SM.errorKindFromCredits((rec.cr || []).map((c) => { const [credit, pos, , who] = c.split('|'); return { credit, pos, batter: who === 'B' }; }));
          hist(disc.errorKindCheck, `${fromCredits ? fromCredits.kind : 'none'}|${SM.errorKindFromDescription(rec.desc) || 'none'}`);
        }
        for (const c of rec.cr || []) hist(disc.creditCodes, c.split('|')[0]);
        if (rec.pend) {
          for (const p of rec.pend) hist(disc.pendingCounts, p.et);
          if (disc.pendingExamples.length < 40) disc.pendingExamples.push({ season, gamePk, ai: rec.ai, et: rec.et, pend: rec.pend, desc: rec.desc });
          if (rec.pend.some((p) => p.et === 'os_ruling_pending_prior') && idx > 0) {
            const prev = plays[idx - 1];
            disc.pendingPairs.push({ season, gamePk, pendingAt: rec.ai, priorAi: prev.ai, priorFinal: prev.et, priorDesc: prev.desc });
          }
        }
        if (/^os_ruling_pending/.test(rec.et || '')) disc.unresolvedPendingResults.push({ season, gamePk, ai: rec.ai, desc: rec.desc });
        if (rec.adv && disc.advisories.length < 40) disc.advisories.push({ season, gamePk, ai: rec.ai, text: rec.adv });
        if (isBattedBall(rec)) {
          allBatted.push(rec);
          hist(disc.locations, String(rec.hd.loc));
          hist(disc.trajectories, String(rec.hd.traj));
        }

        const key = `${gamePk}:${rec.ai}`;
        let chain = chains.get(key);
        // Use an official chain for labels only when its LAST entry agrees
        // with the play's current StatsAPI ruling. A disagreement means a
        // wrong link or a change StatsAPI never applied — it is already in
        // irregularities (link flag current_ruling_mismatch) and is kept out
        // of the training labels.
        if (chain) {
          const last = chain[chain.length - 1];
          if (rulingAgrees(last.cls.final, last.cls.finalHitType, rec.et) === false) {
            chainsDropped += 1;
            chain = null;
          } else if (chain[0].cls.initial === 'error' && last.cls.final === 'error' && rec.et !== 'field_error') {
            // An error → error entry on a play that is not itself scored an
            // error concerns a runner's error (e.g. 2025 #128): it says nothing
            // about this plate appearance's ruling, so it gives no label.
            chain = null;
          }
        }
        let initial; let final; let initialHitType;
        if (chain) {
          initial = chain[0].cls.initial;
          final = chain[chain.length - 1].cls.final;
          initialHitType = chain[0].cls.initialHitType;
          for (let i = 1; i < chain.length; i += 1) {
            if (chain[i].cls.initial !== chain[i - 1].cls.final) {
              irregularities.push({ season, seq: chain[i].seq, raw: chain[i].raw, linkFlags: ['chain_inconsistent'], classification: chain[i].cls.transition });
            }
          }
        } else {
          initial = categoryOfEvent(rec.et);
          final = initial;
          initialHitType = HIT_EVENTS.has(rec.et) ? rec.et : null;
        }
        const labelFinal = !!g && g.officialDate <= LABEL_CUTOFF;
        const gm = metaByGame.get(gamePk) || null;
        const base = {
          id: key, gamePk, season, rec, chain: chain || null, labelFinal,
          date: g ? g.officialDate : null,
          away: g ? abbr.get(g.awayId) : null,
          home: g ? abbr.get(g.homeId) : null,
          homeId: g ? g.homeId : null,
          gameType: g ? g.gameType : null,
          scorerId: gm ? gm.scorerId : null,
          scorerName: gm ? gm.scorerName : null,
        };
        if (initial === 'error') errorRows.push({ ...base, y: isHitCat(final) ? 1 : 0, final });
        if (isHitCat(initial) && initialHitType !== 'home_run' && rec.et !== 'home_run') {
          hitRows.push({ ...base, y: final === 'error' ? 1 : 0, final });
        }
      }
    }
    perSeason.set(season, { logInfo, entries, fieldErrorRecs, abbr, gameById, completedGames: games.length, games, playsByGame });
    report.seasons[season] = {
      ...report.seasons[season],
      plateAppearances: seasonPAs,
      fieldErrorPlateAppearances: seasonFieldErrors,
      officialEntries: entries.length,
      entryKinds: histObj(kinds),
      transitions: histObj(transitions),
      linked: entries.filter((e) => e.link.atBatIndex != null).length,
      linkFlags: histObj(linkFlags),
      dateRecoveries,
      errorToHitEntries: entries.filter((e) => e.cls.flags.includes('errorToHit')).length,
      battingStatEntries: entries.filter((e) => e.cls.flags.includes('battingStat')).length,
      pitchingStatEntries: entries.filter((e) => e.cls.flags.includes('pitchingStat')).length,
      statUnparsedEntries: entries.filter((e) => e.stats && e.stats.unparsed.length).length,
      hitToErrorEntries: entries.filter((e) => e.cls.flags.includes('hitToError')).length,
      unlinkedErrorToHit,
      unlinkedHitToError,
      chainsDroppedForDisagreement: chainsDropped,
      initialErrorPopulation: errorRows.filter((r) => r.season === season).length,
      initialErrorToHit: errorRows.filter((r) => r.season === season && r.y === 1).length,
    };
    log(`${season}: ${entries.length} official entries, ${seasonFieldErrors} field_error PAs, linked ${report.seasons[season].linked}`);
  }

  // The "current" season: the latest one with completed games (in the
  // off-season before opening day, that is still last season).
  currentSeason = Math.max(...[...perSeason.entries()].filter(([, v]) => v.completedGames > 0).map(([k]) => k), SEASONS[0]);
  report.currentSeason = currentSeason;
  // Which linking rules produced this file — see pipeline/lib/link.mjs.
  report.linker = { version: LINKER_VERSION };

  // 4c. per-play Savant xBA (`estimated_ba_using_speedangle`) for every play
  // this run can surface — each linked official entry and every Error Watch
  // row. It is attached to the generated JSON only; the site loads model data
  // lazily and never fetches Savant itself. Requests are budgeted and cached
  // (item 3 of the session brief), and coverage is reported honestly: a play
  // Savant has not answered for yet is simply left without the field.
  let savantXbaPlays = new Map();
  let savantPerPlayReport = null;
  let savantCurrentErrorList = null;
  if (savant) {
    const needed = new Map();   // `${gamePk}:${ai}` -> play request
    const addNeeded = (season, gamePk, ai, gameDate, rec) => {
      if (gamePk == null || ai == null || !gameDate) return;
      const key = `${gamePk}:${ai}`;
      if (needed.has(key)) return;
      needed.set(key, {
        season, gamePk, ai, gameDate,
        finalError: !!rec && rec.et === 'field_error',
        hasBattedBall: !!(rec && rec.hd && Number.isFinite(rec.hd.ls) && Number.isFinite(rec.hd.la)),
      });
    };
    for (const [season, info] of perSeason) {
      for (const e of info.entries) {
        if (e.link.gamePk == null || e.link.atBatIndex == null) continue;
        const rec = (playsByGameAll.get(e.link.gamePk) || [])[e.link.atBatIndex] || null;
        const gi = gameInfoAll.get(e.link.gamePk);
        addNeeded(season, e.link.gamePk, e.link.atBatIndex, gi && gi.officialDate, rec);
      }
    }
    for (const r of errorRows) {
      if (r.season !== currentSeason) continue;
      addNeeded(r.season, r.gamePk, r.rec.ai, r.date, r.rec);
    }
    const res = await collectPlayXba({
      client: savant, needed: [...needed.values()], currentSeason, today: TODAY, log,
    });
    savantXbaPlays = res.byKey;
    savantPerPlayReport = res.report;
    savantCurrentErrorList = res.currentSeasonErrorList;
    log(`savant per-play xBA: ${res.report.matched}/${res.report.needed} plays known`
      + ` (${res.report.pending} pending, ${res.report.unavailable} not on Savant,`
      + ` ${savant.summary().requests} request(s) this run)`);
  }

  // 4b. model tables (surface excludes the plays the overturn models learn from)
  const excluded = new Set([...errorRows, ...hitRows].filter((r) => r.y === 1).map((r) => r.id));
  for (const r of errorRows) excluded.add(r.id);
  const model = {
    version: MODEL_VERSION,
    generatedAt: NOW.toISOString(),
    hitProb: {
      surface: buildHitProbSurface(allBatted, { exclude: excluded }),
      fallback: buildHitProbFallback(allBatted, { exclude: excluded }),
    },
  };
  model.pending = buildPendingTable(allBatted);

  // NOTE: no error type here — for plays already changed to a hit it is gone
  // from the data, so using it on historical rows would leak the label.
  const playOf = (r) => ({ ...SM.playFromRecord(r.rec), homeId: r.homeId, scorerId: r.scorerId });
  const toRow = (r) => ({
    id: r.id, gamePk: r.gamePk, season: r.season, y: r.y, play: playOf(r), home: r.home,
    scorerId: r.scorerId, scorerName: r.scorerName,
  });
  const eTrain = errorRows.filter((r) => r.labelFinal).map(toRow);
  const hTrain = hitRows.filter((r) => r.labelFinal).map(toRow);
  const E_SETS = [
    [],
    ['logit_hit_prob'],
    ['logit_hit_prob', 'infield'],
    ['logit_hit_prob', 'loc:P', 'loc:C', 'loc:1B', 'loc:3B', 'loc:OF'],
    ['logit_hit_prob', 'loc:P', 'loc:C', 'loc:1B', 'loc:3B', 'loc:OF', 'traj:line_drive', 'traj:fly_ball', 'traj:popup', 'traj:bunt'],
    ['logit_hit_prob', 'loc:P', 'loc:C', 'loc:1B', 'loc:3B', 'loc:OF', 'traj:line_drive', 'traj:fly_ball', 'traj:popup', 'traj:bunt', 'ev_z', 'ev_missing'],
    ['logit_hit_prob', 'loc:P', 'loc:C', 'loc:1B', 'loc:3B', 'loc:OF', 'traj:line_drive', 'traj:fly_ball', 'traj:popup', 'traj:bunt', 'ev_z', 'ev_missing', 'batting_home'],
  ];
  // Home-club terms (official scorers are assigned per home park) for clubs
  // with enough plays; tested as an extra candidate — kept only if CV says so.
  const homeCounts = eTrain.reduce((m, r) => hist(m, r.play.homeId), new Map());
  const HOME_TERMS = [...homeCounts.entries()].filter(([id, n]) => id != null && n >= 40).map(([id]) => `home:${id}`).sort();
  if (HOME_TERMS.length) E_SETS.push([...E_SETS[4], ...HOME_TERMS]);
  // Official-scorer terms (StatsAPI gameData.officialScorer) for scorers
  // with enough plays — the same test, at the level where rulings are made.
  const scorerCounts = eTrain.reduce((m, r) => hist(m, r.play.scorerId), new Map());
  const SCORER_TERMS = [...scorerCounts.entries()].filter(([id, n]) => id != null && n >= 40).map(([id]) => `scorer:${id}`).sort();
  if (SCORER_TERMS.length) E_SETS.push([...E_SETS[4], ...SCORER_TERMS]);
  const H_SETS = [
    [],
    ['logit_hit_prob'],
    ['logit_hit_prob', 'infield'],
    ['logit_hit_prob', 'infield', 'traj:line_drive', 'traj:fly_ball', 'traj:popup', 'traj:bunt'],
    ['logit_hit_prob', 'loc:P', 'loc:C', 'loc:1B', 'loc:3B', 'loc:OF', 'traj:line_drive', 'traj:fly_ball', 'traj:popup', 'traj:bunt', 'ev_z'],
  ];
  log(`fitting errorToHit on ${eTrain.length} plays (${eTrain.filter((r) => r.y).length} changed to hit)`);
  const eFit = selectAndFit(eTrain, E_SETS, model, { ootSeason: currentSeason });
  model.errorToHit = { question: 'P(play scored as reached-on-error is officially changed to a hit)', ...eFit.spec };
  log(`fitting hitToError on ${hTrain.length} plays (${hTrain.filter((r) => r.y).length} changed to error)`);
  const hFit = selectAndFit(hTrain, H_SETS, model, { ootSeason: currentSeason, lambdas: [1, 10] });
  model.hitToError = { question: 'P(play scored as a hit, not a home run, is officially changed to an error)', ...hFit.spec };
  // Transparent empirical rates (training plays) for the model card.
  const rateTable = (rows, keyFn, order = null) => {
    const m = new Map();
    for (const r of rows) {
      const k = keyFn(r);
      const c = m.get(k) || { key: k, n: 0, positives: 0 };
      c.n += 1; c.positives += r.y; m.set(k, c);
    }
    const out = [...m.values()].map((c) => ({ ...c, rate: round(c.positives / c.n, 4) }));
    return order ? out.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key)) : out.sort((a, b) => b.n - a.n);
  };
  const HP_BANDS = [[0, 0.1], [0.1, 0.2], [0.2, 0.35], [0.35, 0.5], [0.5, 0.7], [0.7, 1.01]];
  const hpBand = (r) => {
    const p = SM.hitProbability(model, r.play).p;
    const b = HP_BANDS.find(([lo, hi]) => p >= lo && p < hi);
    return b ? `${b[0].toFixed(2)}–${Math.min(1, b[1]).toFixed(2)}` : 'unknown';
  };
  const HP_ORDER = HP_BANDS.map(([lo, hi]) => `${lo.toFixed(2)}–${Math.min(1, hi).toFixed(2)}`);
  for (const [name, rows] of [['errorToHit', eTrain], ['hitToError', hTrain]]) {
    model[name].rates = {
      byHitProbability: rateTable(rows, hpBand, HP_ORDER),
      byFielder: rateTable(rows, (r) => SM.locationGroup(r.play.loc)),
      byTrajectory: rateTable(rows, (r) => SM.trajGroup(r.play.traj)),
      bySeason: rateTable(rows, (r) => r.season),
    };
  }
  model.errorToHit.rates.byHomeClub = rateTable(eTrain, (r) => r.home || String(r.play.homeId));
  // Bands relative to each question's league base rate (score = 0–100 %):
  // "Elevated" ≈ 1.5× typical, "High" ≈ 3× typical, "Likely" = 50%+.
  const bandsFor = (base) => {
    // Rare events (base < 1%): integer scores cannot express multiples of
    // the base rate, so use absolute cuts.
    if (base < 0.01) {
      return [
        { min: 50, label: 'Likely', tone: 'high' },
        { min: 5, label: 'High', tone: 'high' },
        { min: 1, label: 'Elevated', tone: 'mid' },
        { min: 0, label: 'Low', tone: 'none' },
      ];
    }
    const pct = (k) => Math.max(1, Math.round(k * base * 100));
    const cuts = [
      { min: 50, label: 'Likely', tone: 'high' },
      { min: pct(3), label: 'High', tone: 'high' },
      { min: pct(1.5), label: 'Elevated', tone: 'mid' },
      { min: pct(0.75), label: 'Typical', tone: 'low' },
      { min: 0, label: 'Low', tone: 'none' },
    ];
    return cuts.filter((c, i) => i === 0 || c.min < cuts[i - 1].min || c.min === 0)
      .filter((c, i, a) => a.findIndex((d) => d.min === c.min) === i);
  };
  model.errorToHit.bands = bandsFor(model.errorToHit.baseRate);
  model.hitToError.bands = bandsFor(model.hitToError.baseRate);
  model.bands = SM.DEFAULT_BANDS;
  model.training = {
    seasons: SEASONS,
    labelCutoff: LABEL_CUTOFF,
    note: 'Labels come from MLB\'s official scoring-change log. Changes made during a game may not appear in it; the live capture (data/capture) records them directly.',
  };
  model.sources = [
    { name: 'MLB Official Scoring Changes', url: LOG_PAGE },
    ...SEASONS.filter((s) => LOG_SOURCES[s] && LOG_SOURCES[s].kind === 'archive').map((s) => ({ name: `MLB Official Scoring Changes ${s} (Internet Archive capture ${LOG_SOURCES[s].archivedAt})`, url: LOG_SOURCES[s].page })),
    { name: 'MLB Stats API play-by-play', url: 'https://statsapi.mlb.com/api/v1/game/{gamePk}/playByPlay' },
    { name: 'Baseball Savant Statcast search (cross-check + per-play xBA)', url: SAVANT_SEARCH_URL },
  ];

  // 6. Official-scorer and home-park effects — re-tested on every run over all
  //    seasons, so the verdict updates itself as seasons accumulate.
  const hasGroupTerm = (terms) => terms.some((t) => /^(home|scorer):/.test(t));
  const baseOof = (fit) => {
    const sets = fit.oofBySet.filter(Boolean).filter((x) => !hasGroupTerm(x.terms));
    const own = sets.find((x) => x.setIndex === fit.spec.selectedSetIndex);
    return own || sets.reduce((a, b) => (b.logLoss < a.logLoss ? b : a));
  };
  const effectsFor = (question, fit, rows, permutations) => {
    const base = baseOof(fit);
    const names = new Map();
    for (const r of rows) if (r.scorerId != null && r.scorerName) names.set(String(r.scorerId), r.scorerName);
    const mk = (groupOf) => rows.map((r, i) => ({ g: groupOf(r), y: r.y, p: base.oof[i] }));
    const scorerRows = mk((r) => (r.scorerId != null ? r.scorerId : null));
    const homeRows = mk((r) => r.home || (r.play.homeId != null ? String(r.play.homeId) : null));
    const cvFor = (prefix) => {
      const ev = (fit.spec.selection || []).filter((e) => e.terms.some((t) => t.startsWith(prefix)));
      if (!ev.length) return { tested: false, selected: false };
      const b = ev.reduce((a, c) => (c.logLoss < a.logLoss ? c : a));
      return {
        tested: true,
        groupsInCandidate: b.terms.filter((t) => t.startsWith(prefix)).length,
        logLoss: b.logLoss, deltaVsBest: b.deltaVsBest, pairedSE: b.pairedSE,
        selected: fit.spec.terms.some((t) => t.startsWith(prefix)),
      };
    };
    const verdict = (test, cv) => {
      if (!test || test.pValue == null) return 'not enough data';
      if (cv && cv.selected) return 'used in scores (selected by cross-validation)';
      return test.pValue < 0.05
        ? 'groups differ (p < 0.05) but adding them does not improve out-of-sample predictions — not used'
        : 'no detectable difference — not used';
    };
    const sTest = heterogeneityTest(scorerRows, { permutations });
    const hTest = heterogeneityTest(homeRows, { permutations });
    const sCv = cvFor('scorer:'); const hCv = cvFor('home:');
    return {
      question,
      seasons: [...new Set(rows.map((r) => r.season))].sort(),
      baseModelTerms: base.terms,
      method: 'permutation test (group labels shuffled across plays) of Σ (observed − expected)² / variance, expected from out-of-fold model probabilities; plus a cross-validated candidate model with one term per group (≥ 40 plays)',
      scorer: {
        playsWithScorer: scorerRows.filter((r) => r.g != null).length,
        test: sTest, cv: sCv, verdict: verdict(sTest, sCv),
        table: groupTable(scorerRows, (k) => names.get(k) || `Scorer ${k}`).filter((r) => r.n >= 20).slice(0, 80),
      },
      homeClub: {
        test: hTest, cv: hCv, verdict: verdict(hTest, hCv),
        table: groupTable(homeRows).slice(0, 40),
      },
    };
  };
  log('testing official-scorer and home-park effects');
  model.effects = {
    errorToHit: effectsFor('errorToHit', eFit, eTrain, 2000),
    hitToError: effectsFor('hitToError', hFit, hTrain, 500),
  };
  // The hit → error scorer table is large and very sparse (120 changes in
  // ~100,000 hits): publish its test only.
  model.effects.hitToError.scorer.table = [];
  model.effects.hitToError.homeClub.table = [];

  // 7. Error type — what the data can say today (descriptive; not in scores).
  const stood = new Map();
  for (const r of errorRows) {
    if (!r.labelFinal || r.y !== 0 || r.final !== 'error') continue;
    const ek = SM.errorKindOfRecord(r.rec);
    hist(stood, ek ? ek.kind : 'unknown');
  }
  const wording = new Map();
  for (const r of errorRows) {
    if (r.y !== 1 || !r.chain || !r.labelFinal) continue;
    hist(wording, originalErrorKindFromLog(r.chain[0].body) || 'no_clause');
  }
  const KINDS = ['fielding', 'throwing', 'missed_catch'];
  const statedTotal = KINDS.reduce((acc, k) => acc + (wording.get(k) || 0), 0);
  const stoodTotal = KINDS.reduce((acc, k) => acc + (stood.get(k) || 0), 0);
  model.errorToHit.errorKind = {
    stoodByKind: histObj(stood),
    changedToHitLogWording: histObj(wording),
    impliedRelativeRate: statedTotal && stoodTotal ? Object.fromEntries(KINDS.map((k) => {
      const a = (wording.get(k) || 0) / statedTotal; const b = (stood.get(k) || 0) / stoodTotal;
      return [k, { shareOfChangedWithStatedType: round(a, 3), shareOfErrorsThatStood: round(b, 3), ratio: b ? round(a / b, 2) : null, changedStated: wording.get(k) || 0 }];
    })) : null,
    note: 'Early evidence only: the original error type of a play changed to a hit is not in StatsAPI any more (verified), and the official log names it for only part of the changes. The ratio compares the share of each type among changes whose log wording states it with the share among errors that stood — it assumes the wording does not depend on the type. Not used in scores; the live capture measures it properly.',
  };

  // 8. Live-captured rulings (data/capture, written by pipeline/capture.mjs).
  const captureDir = path.join(OUT_BASE, 'capture');
  const captured = [];
  const captureFiles = [];
  if (fs.existsSync(captureDir)) {
    for (const f of fs.readdirSync(captureDir).filter((x) => /^rulings-\d{4}-\d{2}\.json$/.test(x)).sort()) {
      const list = parseMonth(fs.readFileSync(path.join(captureDir, f), 'utf8'));
      captureFiles.push({ file: `data/capture/${f}`, plays: list.length });
      captured.push(...list);
    }
  }
  const recIndex = new Map();
  const recFor = (g, ai) => {
    if (!recIndex.has(g)) {
      const m = new Map();
      for (const rec of playsByGameAll.get(g) || []) m.set(rec.ai, rec);
      recIndex.set(g, m);
    }
    return recIndex.get(g).get(ai) || null;
  };
  const isPendingEt = (et) => /^os_ruling_pending/.test(et || '');
  const lagOf = (e, st) => {
    const a = Date.parse(st && st.at); const b = Date.parse(e.end);
    return Number.isFinite(a) && Number.isFinite(b) ? (a - b) / 60000 : null;
  };
  const capErrors = []; const capPending = []; const adjustRows = [];
  const capSummary = {
    files: captureFiles, plays: captured.length, errorsCaptured: 0, capturedAsOriginal: 0, settled: 0,
    changedToHit: 0, changedOther: 0, changesSeenLive: 0, unloggedChanges: 0, pendingCaptured: 0, pendingResolved: 0,
    firstCaptureAt: null, lastCaptureAt: null, lagMinutes: null, originalMaxLagMin: ORIGINAL_MAX_LAG_MIN,
  };
  const lags = [];
  for (const e of captured) {
    if (!e || !Array.isArray(e.states) || !e.states.length) continue;
    if (!capSummary.firstCaptureAt || e.states[0].at < capSummary.firstCaptureAt) capSummary.firstCaptureAt = e.states[0].at;
    for (const st of e.states) if (!capSummary.lastCaptureAt || st.at > capSummary.lastCaptureAt) capSummary.lastCaptureAt = st.at;
    // The first actual RULING (a play can be captured while its primary
    // ruling is still pending: then the ruling seen as it was made counts).
    const firstRuledIdx = e.states.findIndex((st) => st.et && !isPendingEt(st.et));
    const first = firstRuledIdx >= 0 ? e.states[firstRuledIdx] : e.states[0];
    const lag = lagOf(e, first);
    const seenBeingMade = firstRuledIdx > 0;
    const rec = recFor(e.g, e.ai);
    const last = e.states[e.states.length - 1];
    const current = rec ? { et: rec.et, desc: rec.desc, source: 'final play-by-play' } : { et: last.et, desc: last.desc, source: 'last capture' };
    if (first.et === 'field_error') {
      capSummary.errorsCaptured += 1;
      if (lag != null) lags.push(lag);
      const original = seenBeingMade || (lag != null && lag <= ORIGINAL_MAX_LAG_MIN);
      if (original) capSummary.capturedAsOriginal += 1;
      const settled = !!e.date && e.date <= LABEL_CUTOFF && !!rec;
      const toHit = HIT_EVENTS.has(current.et);
      const changedOther = !toHit && current.et && current.et !== 'field_error' && !isPendingEt(current.et);
      const seen = e.states.find((st, i) => i > firstRuledIdx && st.et !== 'field_error' && !isPendingEt(st.et));
      if (toHit) capSummary.changedToHit += 1;
      if (changedOther) capSummary.changedOther += 1;
      if (seen) capSummary.changesSeenLive += 1;
      const logged = chainsAll.has(e.id);
      if ((toHit || changedOther) && !logged) capSummary.unloggedChanges += 1;
      if (settled) capSummary.settled += 1;
      capErrors.push({
        id: e.id, g: e.g, ai: e.ai, date: e.date, kind: first.kind, pos: first.pos, firstAt: first.at, lagMin: lag != null ? round(lag, 1) : null,
        afterPending: seenBeingMade,
        original, settled, current: current.et, currentSource: current.source, changeSeenAt: seen ? seen.at : null, logged,
        scoreAtCapture: e.score && e.score.e2h ? e.score.e2h.score : null,
      });
      if (original && settled) {
        const gi = gameInfoAll.get(e.g) || {};
        const gm = metaAll.get(e.g) || {};
        const play = { ...SM.playFromRecord({ ...rec, et: 'field_error' }), homeId: gi.homeId ?? e.homeId, scorerId: gm.scorerId ?? null };
        const oof = eFit.oofById.get(e.id);
        const p0 = oof != null ? oof : (SM.scoreWith(model.errorToHit, model, play) || {}).probability;
        if (Number.isFinite(p0)) adjustRows.push({ id: e.id, gamePk: e.g, y: toHit ? 1 : 0, z0: SM.logit(p0), kind: first.kind || null });
      }
    }
    const pi = e.states.findIndex((st) => st.pend);
    if (pi >= 0) {
      capSummary.pendingCaptured += 1;
      const after = e.states.slice(pi + 1).find((st) => !st.pend && st.et && !isPendingEt(st.et));
      const resolvedEt = after ? after.et : (rec && rec.et && !isPendingEt(rec.et) ? rec.et : null);
      const row = {
        id: e.id, g: e.g, ai: e.ai, date: e.date, codes: e.states[pi].pend.codes, marker: e.states[pi].pend.marker || null,
        pendingAt: e.states[pi].at, rulingWhenPending: e.states[pi].et, resolvedEt, resolvedAt: after ? after.at : null,
        resolvedSource: after ? 'live capture' : resolvedEt ? 'final play-by-play' : null,
        predictedAtCapture: e.score && e.score.pending ? e.score.pending.dist : null,
      };
      if (resolvedEt) {
        capSummary.pendingResolved += 1;
        const bb = rec && rec.hd ? rec.hd : e.hd || {};
        const d = SM.pendingDistribution(model, { ls: bb.ls, la: bb.la, traj: bb.traj, loc: bb.loc }, e.br === 1 ? true : e.br === 0 ? false : null);
        if (d) {
          row.probs = Object.fromEntries(d.distribution.map((x) => [x.outcome, x.probability]));
          row.outcome = SM.outcomeOf(resolvedEt);
        }
      }
      capPending.push(row);
    }
  }
  lags.sort((a, b) => a - b);
  capSummary.lagMinutes = lags.length ? { median: round(lags[Math.floor(lags.length / 2)], 1), p90: round(lags[Math.floor(lags.length * 0.9)], 1), n: lags.length } : null;
  capSummary.byKind = histObj(capErrors.reduce((m, r) => hist(m, r.kind || 'unknown'), new Map()));
  model.capture = {
    ...capSummary,
    source: 'data/capture/rulings-YYYY-MM.json — pipeline/capture.mjs polls MLB StatsAPI playByPlay during live games (GitHub Actions, every 10 minutes during game hours)',
    whyNeeded: 'StatsAPI rewrites history: timecode snapshots and diffPatch show the current ruling even for moments before a change (verified on 2026 official log #3 and #6), so an original call can only be known if it was recorded before it changed.',
    recentErrors: capErrors.slice().sort((a, b) => String(b.firstAt).localeCompare(String(a.firstAt))).slice(0, 40),
    pending: capPending.slice().sort((a, b) => String(b.pendingAt).localeCompare(String(a.pendingAt))).slice(0, 60)
      .map(({ probs, ...rest }) => rest),
  };
  model.errorToHit.adjust = capturedAdjustment(adjustRows);
  model.pending.calibration = pendingCalibration(capPending.filter((r) => r.probs && r.outcome), model.pending.outcomes);
  report.capture = {
    ...capSummary,
    adjust: { status: model.errorToHit.adjust.status, n: model.errorToHit.adjust.n, positives: model.errorToHit.adjust.positives },
    pendingCalibration: { status: model.pending.calibration.status, resolved: model.pending.calibration.resolved },
  };
  report.effects = Object.fromEntries(Object.entries(model.effects).map(([q, v]) => [q, {
    seasons: v.seasons,
    scorer: { test: v.scorer.test, cv: v.scorer.cv, verdict: v.scorer.verdict, playsWithScorer: v.scorer.playsWithScorer },
    homeClub: { test: v.homeClub.test, cv: v.homeClub.cv, verdict: v.homeClub.verdict },
  }]));
  model.sources.push(
    { name: 'MLB Stats API game feed (official scorer, venue)', url: 'https://statsapi.mlb.com/api/v1.1/game/{gamePk}/feed/live?fields=gameData,officialScorer,id,fullName,venue,name' },
    { name: 'Live ruling capture (this project, from MLB Stats API playByPlay)', url: 'data/capture/' },
  );
  const capById = new Map(captured.map((e) => [e.id, e]));

  // 5. outputs — official lists with links + out-of-fold model scores
  const scoreFor = (fitResult, spec, row, extra = null) => {
    if (!row) return null;
    const oof = fitResult.oofById.get(row.id);
    if (oof != null) return { p: round(oof, 4), score: SM.toScore(oof), kind: 'out_of_fold' };
    const s = SM.scoreWith(spec, model, extra ? { ...playOf(row), ...extra } : playOf(row));
    return s ? { p: round(s.probability, 4), score: s.score, kind: 'model' } : null;
  };
  const errById = new Map(errorRows.map((r) => [r.id, r]));
  const hitById = new Map(hitRows.map((r) => [r.id, r]));
  for (const [season, info] of perSeason) {
    for (const e of info.entries) {
      const key = e.link.atBatIndex != null ? `${e.link.gamePk}:${e.link.atBatIndex}` : null;
      if (key && e.cls.flags.includes('errorToHit')) e.model = { question: 'errorToHit', ...scoreFor(eFit, model.errorToHit, errById.get(key)) };
      if (key && e.cls.flags.includes('hitToError')) e.model = { question: 'hitToError', ...scoreFor(hFit, model.hitToError, hitById.get(key)) };
      // Savant's own xBA for this exact ball (baseballsavant.mlb.com,
      // estimated_ba_using_speedangle) — present only once the pipeline has
      // fetched it; never a stand-in for the model's comparable-balls rate.
      if (key && savantXbaPlays.has(key)) {
        const sv = savantXbaPlays.get(key);
        e.savant = { xba: sv.xba, ls: sv.ls, la: sv.la, gameDate: sv.gameDate, source: 'savant:estimated_ba_using_speedangle' };
      }
    }
    if (info.logInfo) {
      writeJSON(path.join(OUT_OFFICIAL, `scoring-changes-${season}.json`), {
        season,
        source: info.logInfo.source,
        sections: info.logInfo.sections,
        fromPrevious: !!info.logInfo.fromPrevious,
        generatedAt: NOW.toISOString(),
        entries: info.entries,
      });
    }
  }

  // Error watch: every current-season play that was scored reached-on-error.
  const watch = errorRows.filter((r) => r.season === currentSeason).map((r) => {
    // Error type: as captured live (the original call) when available; else
    // from the current ruling — valid only while the play still stands as an
    // error (a play changed to a hit no longer carries it).
    const cap = capById.get(r.id) || null;
    const capRuled = cap && cap.states ? cap.states.find((st) => st.et && !/^os_ruling_pending/.test(st.et)) : null;
    const capFirst = capRuled && capRuled.et === 'field_error' ? capRuled : null;
    const curKind = r.rec.et === 'field_error' ? SM.errorKindOfRecord(r.rec) : null;
    const errKind = capFirst ? capFirst.kind : curKind ? curKind.kind : null;
    const s = scoreFor(eFit, model.errorToHit, r, { errKind });
    const hp = SM.hitProbability(model, SM.playFromRecord(r.rec));
    const official = (r.chain || []).map((e) => ({ seq: e.seq, transition: e.cls.transition, raw: e.raw }));
    const sv = savantXbaPlays.get(r.id);
    return {
      id: r.id, date: r.date, gamePk: r.gamePk, ai: r.rec.ai, gameType: r.gameType,
      savant: sv ? { xba: sv.xba, ls: sv.ls, la: sv.la, source: 'savant:estimated_ba_using_speedangle' } : undefined,
      away: r.away, home: r.home, inning: r.rec.inn, half: r.rec.top ? 'top' : 'bottom',
      batter: r.rec.bn, batterId: r.rec.b, eventType: r.rec.et, event: r.rec.ev, description: r.rec.desc,
      // Session 5: pitcher of the play and the video evidence (Savant
      // sporty-videos?playId=…) — facts of the StatsAPI play, never inferred.
      pitcher: r.rec.pn || null, pitcherId: r.rec.p ?? null, vid: r.rec.vid || null,
      ls: r.rec.hd ? r.rec.hd.ls : null, la: r.rec.hd ? r.rec.hd.la : null,
      traj: r.rec.hd ? r.rec.hd.traj : null, loc: r.rec.hd ? r.rec.hd.loc : null,
      hitProb: round(hp.p, 4), hitProbSource: hp.source,
      p: s ? s.p : null, score: s ? s.score : null, scoreKind: s ? s.kind : null,
      labelFinal: r.labelFinal,
      // An error → error correction (e.g. fielding → throwing) still stands
      // as an error; 'changed_other' = changed to FC / sacrifice / out.
      status: r.y === 1 ? 'changed_to_hit' : (official.length && r.final !== 'error') ? 'changed_other' : 'stands',
      final: r.final, official,
      errKind, errKindSource: capFirst ? 'captured' : curKind ? 'current_ruling' : null,
      scorer: r.scorerName || null,
      captured: capFirst ? {
        firstAt: capFirst.at,
        lagMin: (() => { const a = Date.parse(capFirst.at); const b = Date.parse(cap.end); return Number.isFinite(a) && Number.isFinite(b) ? round((a - b) / 60000, 1) : null; })(),
        firstDescription: capFirst.desc,
        changes: cap.states.slice(cap.states.indexOf(capFirst) + 1).map((st) => ({ at: st.at, eventType: st.et, event: st.ev })),
        scoreAtCapture: cap.score && cap.score.e2h ? cap.score.e2h.score : null,
      } : null,
    };
  }).sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.gamePk - a.gamePk || b.ai - a.ai);
  // Stable filename (the season is inside) so the site needs no yearly edit.
  writeJSON(path.join(OUT_MODEL, 'error-watch.json'), {
    season: currentSeason, generatedAt: NOW.toISOString(), labelCutoff: LABEL_CUTOFF, plays: watch,
  });

  // Session 5: every error of every completed game, per season, with scan
  // coverage for each game and the video evidence of each play
  // (data/model/error-events-<season>.json; pipeline/lib/error-events.mjs).
  report.errorEvents = {};
  const watchScoreById = new Map(watch.filter((w) => w.score != null).map((w) => [w.id, { p: w.p, score: w.score, kind: w.scoreKind }]));
  for (const [season, info] of perSeason) {
    if (!info.games || !info.playsByGame) continue;
    const officialByPlay = new Map();
    for (const e of info.entries) {
      if (!e.link || e.link.gamePk == null || e.link.atBatIndex == null) continue;
      const key = `${e.link.gamePk}:${e.link.atBatIndex}`;
      if (!officialByPlay.has(key)) officialByPlay.set(key, []);
      officialByPlay.get(key).push({ seq: e.seq, kind: e.cls.kind, transition: e.cls.transition, flags: e.cls.flags, raw: e.raw });
    }
    const errorRowById = new Map(errorRows.filter((r) => r.season === season).map((r) => [r.id, r]));
    const built = buildErrorEvents({
      games: info.games, playsByGame: info.playsByGame, abbr: info.abbr, officialByPlay, errorRowById,
      // Same score as the Error Watch row when there is one (it uses the
      // live-captured error type); otherwise the error type of the current
      // ruling, exactly as Error Watch does for an uncaptured play.
      scoreById: (row) => {
        if (watchScoreById.has(row.id)) return watchScoreById.get(row.id);
        const curKind = row.rec.et === 'field_error' ? SM.errorKindOfRecord(row.rec) : null;
        return scoreFor(eFit, model.errorToHit, row, { errKind: curKind ? curKind.kind : null });
      },
      savantById: savantXbaPlays,
    });
    const byScope = built.events.reduce((m, ev) => { m[ev.scope] = (m[ev.scope] || 0) + 1; return m; }, {});
    report.errorEvents[season] = {
      games: built.games.length,
      gamesScanned: built.games.filter((g) => g.scanned).length,
      plateAppearances: built.games.reduce((n, g) => n + g.pas, 0),
      events: built.events.length,
      byScope,
      withVideo: built.events.filter((ev) => ev.vid).length,
      errorCredits: built.events.reduce((n, ev) => n + ev.errors.length, 0),
    };
    // One game / event per line (a few thousand events a season).
    writeJSONLines(path.join(OUT_MODEL, `error-events-${season}.json`), {
      season, generatedAt: NOW.toISOString(),
      source: 'MLB StatsAPI /api/v1/game/{gamePk}/playByPlay (final state), every completed game; video: baseballsavant.mlb.com/sporty-videos?playId=',
      summary: report.errorEvents[season],
      games: built.games,
      events: built.events,
    }, ['games', 'events']);
  }

  // Savant cross-check (current season, field_error plays).
  if (!args['no-savant']) {
    const cur = perSeason.get(currentSeason);
    report.savant = await savantCrossCheck(currentSeason, cur ? cur.fieldErrorRecs : [], model, savantCurrentErrorList);
    report.savant.perPlay = savantPerPlayReport;
    report.savant.client = savant ? savant.summary() : null;
  }

  // Discovery + report
  report.discovery = {
    creditCodes: histObj(disc.creditCodes),
    fieldErrorBatterCredits: histObj(disc.fieldErrorBatterCredits),
    pendingMarkerCounts: histObj(disc.pendingCounts),
    pendingExamples: disc.pendingExamples,
    pendingPriorPairs: disc.pendingPairs.slice(0, 200),
    pendingPriorPairOutcomes: histObj(disc.pendingPairs.reduce((m, p) => hist(m, p.priorFinal), new Map())),
    unresolvedPendingResults: disc.unresolvedPendingResults.slice(0, 50),
    scoringAdvisories: disc.advisories,
    battedBallLocations: histObj(disc.locations),
    battedBallTrajectories: histObj(disc.trajectories),
    fieldErrorCoverage: disc.fieldErrorCoverage,
    battedBalls: allBatted.length,
    // "creditKind|descriptionKind" counts on field_error plays: checks that the
    // fielding-credit codes and the description agree on the error type.
    errorKindCheck: histObj(disc.errorKindCheck),
  };
  report.model = {
    errorToHit: {
      terms: model.errorToHit.terms, n: model.errorToHit.n, positives: model.errorToHit.positives, cv: model.errorToHit.cv, outOfTime: model.errorToHit.outOfTime || null,
      adjust: { status: model.errorToHit.adjust.status, active: model.errorToHit.adjust.active },
    },
    hitToError: { terms: model.hitToError.terms, n: model.hitToError.n, positives: model.hitToError.positives, cv: model.hitToError.cv, outOfTime: model.hitToError.outOfTime || null },
    surfaceBalls: model.hitProb.surface.nBalls,
  };
  model.metricsSummary = report.model;
  writeJSON(path.join(OUT_MODEL, 'scoring-model.json'), model);
  writeJSON(path.join(OUT_MODEL, 'pipeline-report.json'), report);
  writeJSON(path.join(OUT_OFFICIAL, 'irregularities.json'), { generatedAt: NOW.toISOString(), count: irregularities.length, items: irregularities });
  log('done', JSON.stringify(report.model).slice(0, 600));
  if (report.warnings.length) log('warnings:', report.warnings.join(' | '));
}

main().catch((err) => {
  console.error(err && err.stack || err);
  try {
    // Keep the last good report (the site's summary reads it) and add the
    // failure on top, so a failed run is visible without blanking the page.
    const file = path.join(OUT_MODEL, 'pipeline-report.json');
    const previous = readJSON(file);
    const failure = { fatal: String(err && err.message || err), failedAt: NOW.toISOString() };
    writeJSON(file, previous && previous.seasons && Object.keys(previous.seasons).length
      ? { ...previous, ...failure, warnings: report.warnings.length ? report.warnings : (previous.warnings || []) }
      : { ...report, ...failure });
  } catch { /* ignore */ }
  process.exit(1);
});
