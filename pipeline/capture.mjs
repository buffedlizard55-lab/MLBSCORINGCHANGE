#!/usr/bin/env node
/* ============================================================================
 * pipeline/capture.mjs — live ruling capture (runs every 10 minutes during
 * game hours via .github/workflows/live-capture.yml).
 *
 * Polls MLB StatsAPI for games in progress (and games finished in the last
 * few hours), and records into data/capture/rulings-YYYY-MM.json:
 *   - every play scored "reached on error", as first called — with its error
 *     type (fielding / throwing / missed catch …) from the fielding credits,
 *   - every "Official Scorer Ruling Pending" marker and how it was resolved,
 *   - every later change to those rulings, with the time it was seen.
 * The official-data pipeline (pipeline/run.mjs) joins this ledger with the
 * final rulings to train the error-type adjustment and calibrate the pending
 * chances. This script is the ONLY writer of data/capture/.
 *
 * Flags: --polls=4 --interval=120 (seconds) --final-hours=14
 * Env:   CAPTURE_OUT_DIR (default data/capture), CAPTURE_MODEL_FILE
 *        (default data/model/scoring-model.json), CAPTURE_NOW (ISO, tests)
 * Exit code is 0 unless the script itself is broken: a network failure only
 * skips that poll (logged as a GitHub warning annotation).
 * ==========================================================================*/

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { fetchJSON, pool } from './lib/http.mjs';
import { API } from './lib/statsapi.mjs';
import {
  CAPTURE_FIELDS, updateLedger, monthOf, serializeMonth, parseMonth, statusDue, selectGames,
} from './lib/capture-lib.mjs';

const require = createRequire(import.meta.url);
const SM = require('../assets/js/scoring-model.js');
const R = require('../assets/js/reviews.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = process.env.CAPTURE_OUT_DIR || path.join(ROOT, 'data', 'capture');
const MODEL_FILE = process.env.CAPTURE_MODEL_FILE || path.join(ROOT, 'data', 'model', 'scoring-model.json');
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));
const POLLS = Math.max(1, Number(args.polls || 4));
const INTERVAL_S = Math.max(0, Number(args.interval ?? 120));
const FINAL_HOURS = Number(args['final-hours'] || 14);
const fixedNow = process.env.CAPTURE_NOW ? Date.parse(process.env.CAPTURE_NOW) : null;
const now = () => (fixedNow != null ? fixedNow + (Date.now() - START) : Date.now());
const START = Date.now();
const log = (...a) => console.log(`[capture ${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

function readJSON(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

async function getGames() {
  const t = now();
  // Projection verified live 2026-09-24 (abbreviations come from hydrate=team).
  const fields = 'dates,date,games,gamePk,gameType,season,officialDate,gameDate,teams,away,home,team,id,abbreviation,name,status,abstractGameState,codedGameState,detailedState';
  const url = `${API}/schedule?sportId=1&startDate=${isoDate(t - 86400000)}&endDate=${isoDate(t)}&hydrate=team&fields=${fields}`;
  const data = await fetchJSON(url, { timeoutMs: 20000 });
  const games = [];
  for (const d of data.dates || []) {
    for (const g of d.games || []) {
      const away = g.teams && g.teams.away && g.teams.away.team;
      const home = g.teams && g.teams.home && g.teams.home.team;
      games.push({
        gamePk: g.gamePk,
        gameType: g.gameType,
        season: Number(g.season) || Number(String(g.officialDate || d.date).slice(0, 4)),
        officialDate: g.officialDate || d.date,
        gameDate: g.gameDate,
        abstractGameState: g.status && g.status.abstractGameState,
        codedGameState: g.status && g.status.codedGameState,
        detailedState: g.status && g.status.detailedState,
        awayId: away ? away.id : null,
        homeId: home ? home.id : null,
        away: away ? (away.abbreviation || away.name) : null,
        home: home ? (home.abbreviation || home.name) : null,
      });
    }
  }
  return { url, games };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const model = readJSON(MODEL_FILE);
  if (!model) log('no published model found — plays are captured without scores');
  const ledger = new Map();
  const loadedMonths = new Set();
  const dirtyMonths = new Set();
  const loadMonth = (month) => {
    if (loadedMonths.has(month)) return;
    loadedMonths.add(month);
    const file = path.join(OUT_DIR, `rulings-${month}.json`);
    if (fs.existsSync(file)) for (const e of parseMonth(fs.readFileSync(file, 'utf8'))) ledger.set(e.id, e);
  };
  const totals = { added: 0, changed: 0, filled: 0 };
  const polled = new Set();
  const warnings = [];
  let polls = 0;

  for (let poll = 1; poll <= POLLS; poll += 1) {
    let sched;
    try {
      sched = await getGames();
    } catch (err) {
      warnings.push(`schedule: ${err.message || err}`);
      log('schedule fetch failed:', err.message || err);
      if (poll < POLLS) await sleep(INTERVAL_S * 1000);
      continue;
    }
    const { live, finals } = selectGames(sched.games, now(), { finalHours: FINAL_HOURS, includeFinals: poll === 1 });
    const targets = [...live, ...finals];
    if (poll === 1) log(`${sched.games.length} games in window; ${live.length} live, ${finals.length} recently finished`);
    for (const g of targets) loadMonth(g.officialDate.slice(0, 7));
    polls += 1;
    await pool(targets, 6, async (g) => {
      try {
        const pbp = await fetchJSON(`${API}/game/${g.gamePk}/playByPlay?fields=${CAPTURE_FIELDS}`, { timeoutMs: 30000 });
        const c = updateLedger(ledger, g, pbp.allPlays, { nowIso: new Date(now()).toISOString(), model, SM, R });
        polled.add(g.gamePk);
        if (c.added || c.changed || c.filled) {
          dirtyMonths.add(g.officialDate.slice(0, 7));
          totals.added += c.added; totals.changed += c.changed; totals.filled += c.filled;
          log(`game ${g.gamePk} ${g.away}@${g.home}: +${c.added} new, ${c.changed} ruling changes, ${c.filled} filled`);
        }
      } catch (err) {
        warnings.push(`game ${g.gamePk}: ${err.message || err}`);
      }
    });
    if (!live.length) break; // nothing in progress: no reason to wait
    if (poll < POLLS) await sleep(INTERVAL_S * 1000);
  }

  const nowIso = new Date(now()).toISOString();
  for (const month of dirtyMonths) {
    const entries = [...ledger.values()].filter((e) => monthOf(e) === month);
    fs.writeFileSync(path.join(OUT_DIR, `rulings-${month}.json`), serializeMonth(month, entries, nowIso));
  }
  const statusFile = path.join(OUT_DIR, 'status.json');
  const prevStatus = readJSON(statusFile);
  const changed = dirtyMonths.size > 0;
  if (statusDue(prevStatus, now(), changed)) {
    fs.writeFileSync(statusFile, `${JSON.stringify({
      schema: 1,
      lastRunAt: nowIso,
      lastChangeAt: changed ? nowIso : (prevStatus && prevStatus.lastChangeAt) || null,
      lastRun: { polls, gamesPolled: polled.size, ...totals, warnings: warnings.slice(0, 10) },
      note: 'Rewritten when a ruling is captured or changes, otherwise at most every 3 hours (so idle runs do not create commits).',
    }, null, 1)}\n`);
  }
  log(`done: ${polls} polls, ${polled.size} games, +${totals.added} new, ${totals.changed} changes, ${totals.filled} filled; months written: ${[...dirtyMonths].join(', ') || 'none'}`);
  console.log(`::notice title=capture::${JSON.stringify({ polls, games: polled.size, ...totals, months: [...dirtyMonths], warnings: warnings.length })}`);
  for (const w of warnings.slice(0, 5)) console.log(`::warning title=capture::${w}`);
}

main().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
