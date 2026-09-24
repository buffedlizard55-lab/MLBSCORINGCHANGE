#!/usr/bin/env node
/* ============================================================================
 * pipeline/sync-feed-log.mjs — append official-log-confirmed scoring changes
 * to the static feed logs (data/feed-log-<date>.json) so a visitor reading the
 * site from GitHub Pages (no server.mjs) still sees recent confirmed changes.
 *
 * Run: node pipeline/sync-feed-log.mjs [--days=14] [--dry-run] [--data-dir=…]
 *
 * It reads only committed pipeline outputs (data/official/scoring-changes-*.json,
 * which the 3-hourly official-data workflow refreshes) and writes with the same
 * idempotent merge the local server uses — re-running it changes nothing unless
 * MLB has actually published a new confirmed change. A row is appended only for
 * a ruling change whose play the linker verified (link.atBatIndex != null, no
 * current_ruling_mismatch); everything else is counted and reported, never
 * guessed.
 * ==========================================================================*/

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mergeRowsIntoFeedLog, payloadEquals, rowsFromOfficialSeason, updateFeedLogIndex,
} from './lib/official-feed-row.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));
const DAYS = Number(args.days || 14);
const DATA_DIR = path.resolve(String(args['data-dir'] || path.join(ROOT, 'data')));
const DRY_RUN = !!args['dry-run'];
const NOW = Date.now();
const TODAY = new Date(NOW).toISOString().slice(0, 10);
const FLOOR = new Date(NOW - DAYS * 86400000).toISOString().slice(0, 10);

const readJSON = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};
const writeJSON = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
};
const feedLogFile = (dateStr) => path.join(DATA_DIR, `feed-log-${dateStr}.json`);
const log = (...a) => console.log('[feed-log]', ...a);

/* ------------------------------------------------------- collect the rows */

const officialDir = path.join(DATA_DIR, 'official');
if (!fs.existsSync(officialDir)) {
  log(`no ${path.relative(ROOT, officialDir)} — nothing to do (the official-data workflow writes it)`);
  process.exit(0);
}
const seasonFiles = fs.readdirSync(officialDir)
  .map((f) => /^scoring-changes-(\d{4})\.json$/.exec(f))
  .filter(Boolean)
  .map((m) => ({ season: Number(m[1]), file: path.join(officialDir, m[0]) }))
  .sort((a, b) => b.season - a.season);

const skippedTotals = {};
const byDate = new Map();
for (const { season, file } of seasonFiles) {
  const data = readJSON(file);
  if (!data) { log(`could not read ${path.relative(ROOT, file)} — skipped`); continue; }
  const { rows, skipped } = rowsFromOfficialSeason(data, { season, now: NOW });
  Object.entries(skipped).forEach(([k, n]) => { skippedTotals[k] = (skippedTotals[k] || 0) + n; });
  let inWindow = 0;
  for (const row of rows) {
    if (!row.gameDate || row.gameDate < FLOOR || row.gameDate > TODAY) continue;
    inWindow += 1;
    if (!byDate.has(row.gameDate)) byDate.set(row.gameDate, []);
    byDate.get(row.gameDate).push(row);
  }
  log(`${season}: ${rows.length} confirmed ruling changes, ${inWindow} inside the last ${DAYS} days`);
}
if (Object.keys(skippedTotals).length) {
  const parts = Object.entries(skippedTotals).map(([k, n]) => `${n} × ${k}`);
  log(`not appended (kept out of the static feed on purpose): ${parts.join(', ')}`);
}

/* -------------------------------------------------------- merge and write */

const indexPath = path.join(DATA_DIR, 'feed-log-index.json');
let index = readJSON(indexPath) || {};
let wrote = 0; let unchanged = 0; let addedRows = 0; let mergedRows = 0;
for (const dateStr of [...byDate.keys()].sort()) {
  const rows = byDate.get(dateStr);
  const file = feedLogFile(dateStr);
  const existing = readJSON(file);
  const merged = mergeRowsIntoFeedLog(existing, rows, dateStr, NOW);
  const existingKeys = new Set((existing && Array.isArray(existing.entries) ? existing.entries : [])
    .map((e) => `${e.gamePk}:${e.review && (e.review.id || e.review.atBatIndex)}`));
  const newOnes = rows.filter((r) => !existingKeys.has(`${r.gamePk}:${r.review.id}`)).length;
  addedRows += newOnes;
  mergedRows += rows.length - newOnes;
  if (existing && payloadEquals(existing, merged)) {
    unchanged += 1;
    log(`${dateStr}: already up to date (${merged.entries.length} rows)`);
    continue;
  }
  if (DRY_RUN) {
    log(`${dateStr}: WOULD write ${merged.entries.length} rows (${newOnes} new, ${rows.length - newOnes} merged) — dry run`);
    continue;
  }
  writeJSON(file, merged);
  index = updateFeedLogIndex(index, dateStr, merged.savedAt);
  wrote += 1;
  log(`${dateStr}: wrote ${merged.entries.length} rows (${newOnes} new, ${rows.length - newOnes} merged from the official log)`);
}
if (wrote && !DRY_RUN) writeJSON(indexPath, index);

log(`done: ${wrote} file(s) written, ${unchanged} already current, `
  + `${addedRows} new row(s), ${mergedRows} row(s) enriched`
  + (DRY_RUN ? ' (dry run — nothing written)' : ''));
if (wrote || addedRows || mergedRows) {
  // The summary line is what the workflow's commit step keys on.
  console.log(`[feed-log] summary changed=${wrote} new=${addedRows} merged=${mergedRows}`);
}
