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
 *     pipeline report and an irregularities list.
 *
 * Flags: --seasons=2024,2025,2026  --max-games=N  --skip-fetch  --no-savant
 * ==========================================================================*/

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fetchText, pool } from './lib/http.mjs';
import { parseLogHtml } from './lib/log-parser.mjs';
import { classifyEntry, transitionFlags } from './lib/log-classifier.mjs';
import {
  getTeams, getSeasonSchedule, isCompleted, getPlayByPlay, extractGamePlays, samePlays,
  HIT_EVENTS, playByPlayUrl,
} from './lib/statsapi.mjs';
import { buildTeamIndex, linkEntry, rulingAgrees } from './lib/link.mjs';
import {
  buildHitProbSurface, buildHitProbFallback, buildPendingTable, selectAndFit, SM, isBattedBall,
} from './lib/model-build.mjs';
import { parseCSV } from './lib/csv.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = process.env.PIPELINE_CACHE_DIR || path.join(ROOT, 'pipeline-cache');
const OUT_BASE = process.env.PIPELINE_OUT_DIR || path.join(ROOT, 'data');
const OUT_OFFICIAL = path.join(OUT_BASE, 'official');
const OUT_MODEL = path.join(OUT_BASE, 'model');
const PROBE_DIR = process.env.PIPELINE_PROBE_DIR || path.join(ROOT, '_probe');
const CACHE_VERSION = 2;
const REFRESH_DAYS = 21;      // re-fetch recent games: rulings can still change
const LABEL_LAG_DAYS = 14;    // training uses games at least this old
const FETCH_CONCURRENCY = 8;
const MODEL_VERSION = 1;

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));
const SEASONS = String(args.seasons || '2024,2025,2026').split(',').map(Number).filter(Boolean);
const MAX_GAMES = args['max-games'] ? Number(args['max-games']) : Infinity;

const LOG_PAGE = 'https://www.mlb.com/official-information/scoring-changes';
// Prior seasons: the last Internet Archive capture after each season ended,
// found via https://web.archive.org/cdx/search/cdx?url=mlb.com/official-information/scoring-changes
const LOG_SOURCES = {
  2026: { kind: 'live', url: LOG_PAGE, page: LOG_PAGE },
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
const SAVANT_ERRORS_CSV = (season) => 'https://baseballsavant.mlb.com/statcast_search/csv?all=true'
  + `&hfAB=field%5C.%5C.error%7C&hfSea=${season}%7C&player_type=batter&type=details`;

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

/* ------------------------------------------------------------------ 1 logs */
async function loadOfficialLog(season) {
  const src = LOG_SOURCES[season];
  const outFile = path.join(OUT_OFFICIAL, `scoring-changes-${season}.json`);
  const previous = readJSON(outFile);
  if (!src) return previous ? { fromPrevious: true, ...previous } : null;
  try {
    const html = await fetchText(src.url, { timeoutMs: 90000 });
    const sections = parseLogHtml(html).filter((s) => s.season === season);
    const entries = sections.flatMap((s, si) => s.entries.map((e) => ({ ...e, section: s.label, sectionIndex: si })));
    if (!entries.length) {
      fs.mkdirSync(PROBE_DIR, { recursive: true });
      const at = html.indexOf(' -- In the ');
      fs.writeFileSync(path.join(PROBE_DIR, `log-${season}-excerpt.txt`),
        `bytes=${html.length}\nfirst " -- In the " at ${at}\n\n${html.slice(Math.max(0, at - 3000), at + 3000)}`);
      throw new Error(`no entries parsed for ${season} (excerpt written to _probe/)`);
    }
    const info = {
      season,
      source: {
        kind: src.kind, url: src.page, fetchedUrl: src.url, archivedAt: src.archivedAt || null,
        fetchedAt: NOW.toISOString(), sha256: sha256(html), bytes: html.length,
      },
      sections: sections.map((s) => ({ label: s.label, entries: s.entries.length, issues: s.issues })),
      entries,
    };
    fs.mkdirSync(path.join(OUT_OFFICIAL, 'raw'), { recursive: true });
    fs.writeFileSync(path.join(OUT_OFFICIAL, 'raw', `scoring-changes-${season}.txt`),
      `# Official MLB scoring changes — ${season}\n# Source: ${src.page}\n# Fetched: ${info.source.fetchedAt}  sha256(html)=${info.source.sha256}\n`
      + '# Verbatim entry lines as extracted from the page (one per line).\n\n'
      + entries.map((e) => e.raw).join('\n') + '\n');
    report.logs[season] = { ok: true, entries: entries.length, sections: info.sections, bytes: html.length };
    return info;
  } catch (err) {
    report.logs[season] = { ok: false, error: String(err && err.message || err), usedPrevious: !!previous };
    report.warnings.push(`official log ${season}: ${err && err.message}`);
    if (!previous) return null;
    return {
      season: previous.season, source: previous.source, sections: previous.sections,
      entries: previous.entries.map(({ cls, link, model, ...rest }) => rest),
      fromPrevious: true,
    };
  }
}

/* --------------------------------------------------------------- 2 plays */
function cacheFile(season) { return path.join(CACHE_DIR, `plays-${season}.json.gz`); }
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
  const playsByGame = new Map();
  for (const g of completed) {
    const c = cache.games[g.gamePk];
    if (c) playsByGame.set(g.gamePk, c.plays);
  }
  report.seasons[season] = {
    teamsUrl, scheduleUrls: sched.urls,
    scheduled: sched.games.length, completed: completed.length,
    gamesWithPlays: playsByGame.size, fetched, failed, failures, selfCheck,
    byGameType: histObj(completed.reduce((m, g) => hist(m, g.gameType), new Map())),
  };
  if (playsByGame.size < completed.length) {
    report.warnings.push(`${season}: ${completed.length - playsByGame.size} completed games have no play data`);
  }
  return { teams, games: completed, playsByGame };
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

async function savantCrossCheck(season, fieldErrorRecs, model) {
  try {
    const csv = await fetchText(SAVANT_ERRORS_CSV(season), { timeoutMs: 120000 });
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
      url: SAVANT_ERRORS_CSV(season), rowsAllGameTypes: allRows.length, rowsByGameType: histObj(byType),
      rows: rows.length, statsapiFieldErrors: fieldErrorRecs.length,
      matched, onlySavant: byKey.size, onlySavantExamples: [...byKey.keys()].slice(0, 15), onlyStatsApiExamples: onlyOurs,
      exitVelocityAgreement: bothEv ? round(evAgree / bothEv, 4) : null,
      launchAngleAgreement: bothEv ? round(laAgree / bothEv, 4) : null,
      hitProbVsSavantXba: { n: pairs.length, pearson: round(pearson, 4), meanAbsDiff: round(mad, 4) },
    };
  } catch (err) {
    report.warnings.push(`savant cross-check ${season}: ${err.message}`);
    return { url: SAVANT_ERRORS_CSV(season), error: String(err.message || err) };
  }
}

/* ---------------------------------------------------------------- main */
async function main() {
  log(`start; seasons=${SEASONS.join(',')} today=${TODAY} labelCutoff=${LABEL_CUTOFF}`);
  const currentSeason = Math.max(...SEASONS);
  const perSeason = new Map();
  const allBatted = [];
  const errorRows = []; const hitRows = [];
  const disc = {
    creditCodes: new Map(), fieldErrorBatterCredits: new Map(), pendingExamples: [], pendingCounts: new Map(),
    pendingPairs: [], advisories: [], locations: new Map(), trajectories: new Map(), unresolvedPendingResults: [],
    fieldErrorCoverage: { total: 0, withEvLa: 0, withTraj: 0, withLoc: 0 },
  };

  for (const season of SEASONS) {
    const logInfo = await loadOfficialLog(season);
    const { teams, games, playsByGame } = await loadSeasonPlays(season);
    const teamIndex = buildTeamIndex(teams);
    const abbr = new Map(teams.map((t) => [t.id, t.abbreviation]));
    const gameById = new Map(games.map((g) => [g.gamePk, g]));
    const entries = logInfo ? logInfo.entries : [];

    // 3. classify + link + verify
    const linkFlags = new Map(); const kinds = new Map(); const transitions = new Map();
    for (const e of entries) {
      e.cls = classifyEntry(e.body);
      e.cls.flags = Object.entries(transitionFlags(e.cls)).filter(([, v]) => v).map(([k]) => k);
      e.link = linkEntry(e, { teamIndex, games, playsByGame });
      const g = gameById.get(e.link.gamePk);
      if (g) {
        e.link.officialDate = g.officialDate;
        e.link.gameType = g.gameType;
        e.link.away = abbr.get(g.awayId) || null;
        e.link.home = abbr.get(g.homeId) || null;
      }
      hist(kinds, e.cls.kind);
      if (e.cls.transition) hist(transitions, e.cls.transition);
      for (const f of e.link.flags) hist(linkFlags, f.split(':')[0]);
      // Link flags matter for ruling changes (they feed the model); for
      // bookkeeping-only entries (earned runs, RBIs, WP/PB) flag parse issues.
      const important = e.issues.length || (e.cls.kind === 'ruling_change'
        && e.link.flags.some((f) => !/^team_alias|^team_code_via|^name_match:last_name/.test(f)));
      if (important || e.cls.kind === 'unclassified') {
        irregularities.push({
          season, seq: e.seq, raw: e.raw, parseIssues: e.issues, linkFlags: e.link.flags,
          classification: e.cls.kind === 'ruling_change' ? e.cls.transition : e.cls.kind,
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

    let seasonFieldErrors = 0; let seasonPAs = 0; let chainsDropped = 0;
    const fieldErrorRecs = [];
    const unlinkedErrorToHit = entries.filter((e) => e.cls.flags.includes('errorToHit') && e.link.atBatIndex == null).length;
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
        const base = {
          id: key, gamePk, season, rec, chain: chain || null, labelFinal,
          date: g ? g.officialDate : null,
          away: g ? abbr.get(g.awayId) : null,
          home: g ? abbr.get(g.homeId) : null,
          homeId: g ? g.homeId : null,
          gameType: g ? g.gameType : null,
        };
        if (initial === 'error') errorRows.push({ ...base, y: isHitCat(final) ? 1 : 0, final });
        if (isHitCat(initial) && initialHitType !== 'home_run' && rec.et !== 'home_run') {
          hitRows.push({ ...base, y: final === 'error' ? 1 : 0, final });
        }
      }
    }
    perSeason.set(season, { logInfo, entries, fieldErrorRecs, abbr, gameById });
    report.seasons[season] = {
      ...report.seasons[season],
      plateAppearances: seasonPAs,
      fieldErrorPlateAppearances: seasonFieldErrors,
      officialEntries: entries.length,
      entryKinds: histObj(kinds),
      transitions: histObj(transitions),
      linked: entries.filter((e) => e.link.atBatIndex != null).length,
      linkFlags: histObj(linkFlags),
      errorToHitEntries: entries.filter((e) => e.cls.flags.includes('errorToHit')).length,
      hitToErrorEntries: entries.filter((e) => e.cls.flags.includes('hitToError')).length,
      unlinkedErrorToHit,
      chainsDroppedForDisagreement: chainsDropped,
      initialErrorPopulation: errorRows.filter((r) => r.season === season).length,
      initialErrorToHit: errorRows.filter((r) => r.season === season && r.y === 1).length,
    };
    log(`${season}: ${entries.length} official entries, ${seasonFieldErrors} field_error PAs, linked ${report.seasons[season].linked}`);
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

  const playOf = (r) => ({ ...SM.playFromRecord(r.rec), homeId: r.homeId });
  const toRow = (r) => ({ id: r.id, gamePk: r.gamePk, season: r.season, y: r.y, play: playOf(r), home: r.home });
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
  model.bands = SM.DEFAULT_BANDS;
  model.training = {
    seasons: SEASONS,
    labelCutoff: LABEL_CUTOFF,
    note: 'Labels come from the official post-game scoring-change log. In-game changes are not in the log; the live site observes those directly.',
  };
  model.sources = [
    { name: 'MLB Official Scoring Changes', url: LOG_PAGE },
    ...SEASONS.filter((s) => LOG_SOURCES[s] && LOG_SOURCES[s].kind === 'archive').map((s) => ({ name: `MLB Official Scoring Changes ${s} (Internet Archive capture ${LOG_SOURCES[s].archivedAt})`, url: LOG_SOURCES[s].page })),
    { name: 'MLB Stats API play-by-play', url: 'https://statsapi.mlb.com/api/v1/game/{gamePk}/playByPlay' },
    { name: 'Baseball Savant Statcast search (cross-check)', url: SAVANT_ERRORS_CSV(currentSeason) },
  ];

  // 5. outputs — official lists with links + out-of-fold model scores
  const scoreFor = (fitResult, spec, row) => {
    if (!row) return null;
    const oof = fitResult.oofById.get(row.id);
    if (oof != null) return { p: round(oof, 4), score: SM.toScore(oof), kind: 'out_of_fold' };
    const s = SM.scoreWith(spec, model, playOf(row));
    return s ? { p: round(s.probability, 4), score: s.score, kind: 'model' } : null;
  };
  const errById = new Map(errorRows.map((r) => [r.id, r]));
  const hitById = new Map(hitRows.map((r) => [r.id, r]));
  for (const [season, info] of perSeason) {
    for (const e of info.entries) {
      const key = e.link.atBatIndex != null ? `${e.link.gamePk}:${e.link.atBatIndex}` : null;
      if (key && e.cls.flags.includes('errorToHit')) e.model = { question: 'errorToHit', ...scoreFor(eFit, model.errorToHit, errById.get(key)) };
      if (key && e.cls.flags.includes('hitToError')) e.model = { question: 'hitToError', ...scoreFor(hFit, model.hitToError, hitById.get(key)) };
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
    const s = scoreFor(eFit, model.errorToHit, r);
    const hp = SM.hitProbability(model, SM.playFromRecord(r.rec));
    const official = (r.chain || []).map((e) => ({ seq: e.seq, transition: e.cls.transition, raw: e.raw }));
    return {
      id: r.id, date: r.date, gamePk: r.gamePk, ai: r.rec.ai, gameType: r.gameType,
      away: r.away, home: r.home, inning: r.rec.inn, half: r.rec.top ? 'top' : 'bottom',
      batter: r.rec.bn, batterId: r.rec.b, eventType: r.rec.et, event: r.rec.ev, description: r.rec.desc,
      ls: r.rec.hd ? r.rec.hd.ls : null, la: r.rec.hd ? r.rec.hd.la : null,
      traj: r.rec.hd ? r.rec.hd.traj : null, loc: r.rec.hd ? r.rec.hd.loc : null,
      hitProb: round(hp.p, 4), hitProbSource: hp.source,
      p: s ? s.p : null, score: s ? s.score : null, scoreKind: s ? s.kind : null,
      labelFinal: r.labelFinal,
      status: r.y === 1 ? 'changed_to_hit' : official.length ? 'changed_other' : 'stands',
      final: r.final, official,
    };
  }).sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.gamePk - a.gamePk || b.ai - a.ai);
  writeJSON(path.join(OUT_MODEL, `error-watch-${currentSeason}.json`), {
    season: currentSeason, generatedAt: NOW.toISOString(), labelCutoff: LABEL_CUTOFF, plays: watch,
  });

  // Savant cross-check (current season, field_error plays).
  if (!args['no-savant']) {
    const cur = perSeason.get(currentSeason);
    report.savant = await savantCrossCheck(currentSeason, cur ? cur.fieldErrorRecs : [], model);
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
  };
  report.model = {
    errorToHit: { terms: model.errorToHit.terms, n: model.errorToHit.n, positives: model.errorToHit.positives, cv: model.errorToHit.cv, outOfTime: model.errorToHit.outOfTime || null },
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
    report.fatal = String(err && err.message || err);
    writeJSON(path.join(OUT_MODEL, 'pipeline-report.json'), report);
  } catch { /* ignore */ }
  process.exit(1);
});
