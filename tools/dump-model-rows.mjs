#!/usr/bin/env node
/* ============================================================================
 * tools/dump-model-rows.mjs — one row per error→hit population play, with the
 * full compact play record and game metadata, written to
 * analysis/model-rows.json.gz (+ a small provenance sidecar).
 *
 * WHY: the dev sandbox has no route to MLB hosts, so the exact per-play
 * features the model trains on (Statcast hitData: exit velocity, launch
 * angle, trajectory, location; runners, outs, score, bat side) cannot be
 * re-derived there. This tool runs on GitHub Actions (like the pipeline),
 * reuses the pipeline's own fetch/extract/cache code, and commits a
 * regenerable analysis dump so the model can be studied offline.
 *
 * The population is taken from the committed data/model/error-events files
 * (scope "batter_reached": every play whose ORIGINAL ruling was a
 * batter-reached-on-error — the model's training population, changed plays
 * included). Labels: y = 1 when the final ruling is a hit (status
 * "changed_to_hit"). Nothing here feeds the published model; it is a study
 * artifact (see docs/model-improvement-2026.md).
 *
 * The play-by-play cache (pipeline-cache/plays-<season>.json.gz) is read and
 * written in the pipeline's own format — {version, season, games:
 * {gamePk: {fetchedAt, plays}}} — so a warm cache from the official-data
 * workflow is reused and anything this tool fetches is reusable by it.
 *
 * Flags: --seasons=2024,2025,2026  --out-dir=analysis  --no-meta
 *        --limit-games=N  --concurrency=N  --skip-fetch
 * ========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { getSeasonSchedule, isCompleted, getPlayByPlay, extractGamePlays, getGameMeta } from '../pipeline/lib/statsapi.mjs';
import { pool } from '../pipeline/lib/http.mjs';
import { originalErrorKindFromLog } from '../pipeline/lib/log-classifier.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = process.env.PIPELINE_CACHE_DIR || path.join(ROOT, 'pipeline-cache');
const PLAYS_CACHE_VERSION = 3;   // pipeline/run.mjs compact-record format
const META_CACHE_VERSION = 1;

const arg = (name, dflt) => {
  const m = process.argv.find((a) => a.startsWith(`--${name}=`));
  return m ? m.slice(name.length + 3) : dflt;
};
const seasons = String(arg('seasons', '2024,2025,2026')).split(',').map(Number).filter(Boolean);
const outDir = path.resolve(ROOT, arg('out-dir', 'analysis'));
const noMeta = process.argv.includes('--no-meta');
const skipFetch = process.argv.includes('--skip-fetch');
const limitGames = Number(arg('limit-games', 0)) || 0;
const concurrency = Number(arg('concurrency', 6)) || 6;

const log = (s) => console.log(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readGzipJson(file) {
  try {
    return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
  } catch { /* missing or unreadable */ }
  return null;
}
function writeGzipJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(obj)));
}

function playsCacheFile(season) { return path.join(CACHE_DIR, `plays-${season}.json.gz`); }
function metaCacheFile(season) { return path.join(CACHE_DIR, `meta-${season}.json.gz`); }

const START = Date.now();
const meta = {
  generatedAt: new Date().toISOString(),
  tool: 'tools/dump-model-rows.mjs',
  population: 'data/model/error-events-<season>.json events with scope "batter_reached" (plays whose ORIGINAL ruling was a batter-reached error — the error→hit model population; changed plays included via the official-log link)',
  sources: [
    'MLB StatsAPI /api/v1/schedule (game types R, F, D, L, W)',
    'MLB StatsAPI /api/v1/game/{gamePk}/playByPlay (PBP_FIELDS projection; extractGamePlays compact records)',
    'MLB StatsAPI /api/v1.1/game/{gamePk}/feed/live?fields=gameData,officialScorer,id,fullName,venue,name (unless --no-meta)',
    'data/model/error-events-<season>.json (population, labels, out-of-fold model p)',
    'data/model/error-watch.json (current season: hitProb, error kind + source, scorer, capture state)',
  ],
  note: 'Derived, regenerable study artifact — safe to delete and re-dump. NOT an input to the published model.',
  seasons: {},
};

const rows = [];

async function main() {
  for (const season of seasons) {
    const evFile = path.join(ROOT, 'data', 'model', `error-events-${season}.json`);
    if (!fs.existsSync(evFile)) { log(`no error-events file for ${season}, skipping`); continue; }
    const events = JSON.parse(fs.readFileSync(evFile, 'utf8')).events || [];
    const pop = events.filter((e) => e.scope === 'batter_reached' && e.status);
    log(`${season}: ${pop.length} population plays (${pop.filter((e) => e.status === 'changed_to_hit').length} changed to hit)`);

    // Current-season Error Watch join (exact features, error kind + source).
    let watch = null; let watchSeason = null; let labelCutoff = null;
    const watchFile = path.join(ROOT, 'data', 'model', 'error-watch.json');
    if (fs.existsSync(watchFile)) {
      const w = JSON.parse(fs.readFileSync(watchFile, 'utf8'));
      if (w.season === season && Array.isArray(w.plays)) {
        watch = new Map(w.plays.map((p) => [p.id, p]));
        watchSeason = w.season;
        labelCutoff = w.labelCutoff || null;
      }
    }

    const { games } = await getSeasonSchedule(season);
    const gameByPk = new Map(games.filter(isCompleted).map((g) => [g.gamePk, g]));
    const needed = [...new Set(pop.map((e) => e.gamePk))].filter((pk) => gameByPk.has(pk));
    const limited = limitGames ? needed.slice(0, limitGames) : needed;
    const limitedSet = new Set(limited);
    log(`${season}: ${needed.length} completed games in the population${limitGames ? ` (limited to ${limited.length})` : ''}`);

    // Play records: pipeline cache first (format {gamePk: {fetchedAt, plays}}),
    // then fetch the rest politely and store it back the same way.
    const playsCache = readGzipJson(playsCacheFile(season));
    const plays = playsCache && playsCache.version === PLAYS_CACHE_VERSION ? playsCache : { version: PLAYS_CACHE_VERSION, season, games: {} };
    const recsOf = (pk) => {
      const c = plays.games[pk];
      if (!c) return null;
      return Array.isArray(c) ? c : (Array.isArray(c.plays) ? c.plays : null);
    };
    let fetched = 0; const failures = [];
    const missing = skipFetch ? [] : limited.filter((pk) => !recsOf(pk));
    if (missing.length) {
      log(`${season}: fetching playByPlay for ${missing.length} games (concurrency ${concurrency})`);
      await pool(missing, concurrency, async (pk, i) => {
        try {
          const pbp = await getPlayByPlay(pk);
          plays.games[pk] = { fetchedAt: new Date().toISOString(), plays: extractGamePlays(pbp, pk) };
          fetched += 1;
        } catch (err) {
          failures.push({ gamePk: pk, error: String(err && err.message || err) });
        }
        if ((i + 1) % 200 === 0) log(`  … ${i + 1}/${missing.length} (${fetched} ok, ${failures.length} failed)`);
        await sleep(250);
      });
      // One sequential retry pass for anything that failed.
      const retry = failures.splice(0).map((f) => f.gamePk);
      for (const pk of retry) {
        try {
          await sleep(500);
          const pbp = await getPlayByPlay(pk);
          plays.games[pk] = { fetchedAt: new Date().toISOString(), plays: extractGamePlays(pbp, pk) };
          fetched += 1;
        } catch (err) {
          failures.push({ gamePk: pk, error: String(err && err.message || err) });
        }
      }
      writeGzipJson(playsCacheFile(season), plays);
    }
    log(`${season}: ${limited.filter((pk) => recsOf(pk)).length}/${limited.length} games available (${fetched} fetched, ${failures.length} failures)`);

    // Official scorer / venue meta (tiny feed/live projection), cached the same way.
    const gameMeta = {};
    let metaFetched = 0; const metaFailures = [];
    if (!noMeta) {
      const metaCache = readGzipJson(metaCacheFile(season));
      const mc = metaCache && metaCache.version === META_CACHE_VERSION ? metaCache : { version: META_CACHE_VERSION, season, games: {} };
      const metaMissing = skipFetch ? [] : limited.filter((pk) => !mc.games[pk]);
      if (metaMissing.length) {
        log(`${season}: fetching scorer meta for ${metaMissing.length} games`);
        await pool(metaMissing, Math.max(2, Math.min(8, concurrency)), async (pk) => {
          try {
            mc.games[pk] = { ...(await getGameMeta(pk)), fetchedAt: new Date().toISOString() };
            metaFetched += 1;
          } catch (err) {
            metaFailures.push({ gamePk: pk, error: String(err && err.message || err) });
          }
          await sleep(100);
        });
        writeGzipJson(metaCacheFile(season), mc);
      }
      for (const pk of limited) if (mc.games[pk]) gameMeta[pk] = mc.games[pk];
      log(`${season}: scorer meta for ${limited.filter((pk) => gameMeta[pk]).length}/${limited.length} games (${metaFetched} fetched, ${metaFailures.length} failures)`);
    }

    let noRec = 0;
    for (const e of pop) {
      const g = gameByPk.get(e.gamePk);
      if (!g || !limitedSet.has(e.gamePk)) continue;
      const recs = recsOf(e.gamePk) || null;
      const rec = recs ? (recs.find((r) => r.ai === e.ai) || null) : null;
      if (!rec) noRec += 1;
      const w = watch ? (watch.get(e.id) || null) : null;
      // Original error type, from the official log's own wording of the OLD
      // ruling (only exists for plays the log changed; descriptive context —
      // the model itself may use the error type only as captured live).
      const firstErrorEntry = (e.official || [])
        .filter((o) => o.raw && (o.transition || '').startsWith('error'))
        .sort((a, b) => a.seq - b.seq)[0] || null;
      const logKind = firstErrorEntry ? originalErrorKindFromLog(firstErrorEntry.raw) : null;
      const settled = season < 2026
        ? true
        : (w && w.labelFinal != null ? w.labelFinal : (labelCutoff ? String(e.date || '') < labelCutoff : null));
      rows.push({
        id: e.id, season, gamePk: e.gamePk, ai: e.ai, date: e.date || (g && g.officialDate) || null,
        gameType: g ? g.gameType : null, homeId: g ? g.homeId : null, awayId: g ? g.awayId : null,
        y: e.status === 'changed_to_hit' ? 1 : 0, status: e.status, final: e.final || null, settled,
        oof: e.model ? { p: e.model.p, kind: e.model.kind } : null,
        logKind: logKind || null,
        watch: w ? {
          hitProb: w.hitProb ?? null, hitProbSource: w.hitProbSource || null,
          errKind: w.errKind || null, errKindSource: w.errKindSource || null,
          scorer: w.scorer || null, score: w.score ?? null, scoreKind: w.scoreKind || null,
          captured: !!w.captured,
        } : null,
        scorerId: (gameMeta[e.gamePk] && gameMeta[e.gamePk].scorerId) ?? null,
        scorerName: (gameMeta[e.gamePk] && gameMeta[e.gamePk].scorerName) || null,
        venueName: (gameMeta[e.gamePk] && gameMeta[e.gamePk].venueName) || null,
        rec,
      });
    }
    meta.seasons[season] = {
      population: pop.length,
      changedToHit: pop.filter((e) => e.status === 'changed_to_hit').length,
      rows: rows.filter((r) => r.season === season).length,
      settledRows: rows.filter((r) => r.season === season && r.settled).length,
      gamesNeeded: needed.length,
      gamesFetched: fetched,
      playFetchFailures: failures,
      metaFetchFailures: metaFailures,
      rowsWithoutPlayRecord: noRec,
      watchJoined: watchSeason === season,
    };
  }

  fs.mkdirSync(outDir, { recursive: true });
  meta.rows = rows.length;
  meta.elapsedSeconds = Math.round((Date.now() - START) / 1000);
  writeGzipJson(path.join(outDir, 'model-rows.json.gz'), rows);
  fs.writeFileSync(path.join(outDir, 'model-rows.meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  log(`wrote ${rows.length} rows in ${meta.elapsedSeconds}s`);
  const missingRec = rows.filter((r) => !r.rec).length;
  meta.missingPlayRecords = missingRec;
  fs.writeFileSync(path.join(outDir, 'model-rows.meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  if (rows.length && missingRec / rows.length > 0.2) {
    console.error(`::error::${missingRec}/${rows.length} rows have no play record`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  meta.fatal = String(err && err.stack || err);
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'model-rows.meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  } catch { /* best effort */ }
  console.error('::error::' + meta.fatal.split('\n')[0].slice(0, 500));
  process.exit(1);
});
