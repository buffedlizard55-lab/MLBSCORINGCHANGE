#!/usr/bin/env node
/* ============================================================================
 * official-feed-log-test.mjs — the static feed-log sync (item 2 of the session
 * brief) end to end:
 *
 *   1. rows built from MLB's official log carry exactly the facts the log and
 *      the linked play state — nothing invented;
 *   2. the pipeline's own classification and the browser's hit → error
 *      definition agree row by row (session-3 charter rule: one definition
 *      everywhere — the feed's ✏️ surface and chime must never see a hit →
 *      error reversal);
 *   3. the merge matches the browser's own merge (assets/js/feed-log.js
 *      mergePayloads) and is idempotent, so the 3-hourly Action commits only
 *      real changes;
 *   4. the CLI writes valid v1 feed logs + index and re-runs to a no-op.
 *
 * Run: node tools/official-feed-log-test.mjs
 * ==========================================================================*/

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import {
  buildOfficialFeedRow, buildOfficialStatRow, mergeRowsIntoFeedLog, payloadEquals, rowsFromOfficialSeason,
} from '../pipeline/lib/official-feed-row.mjs';
import { extractGamePlays } from '../pipeline/lib/statsapi.mjs';
import { statEffects } from '../pipeline/lib/stat-effects.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJSON = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const section = (t) => console.log(`- ${t}`);

/* --------------------------------------------------- load the browser code */

const vmContext = () => ({
  console: { warn() {}, error() {}, log() {} },
  Map, Set, Date, Math, Number, String, Object, Array, URLSearchParams, JSON,
  CSS: { escape: (s) => s },
  UI: { el: () => ({}), clear: () => ({}) },
  MLB: {}, window: {}, document: { addEventListener() {}, querySelector: () => null },
  setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  module: { exports: {} },
});
const loadModule = (rel) => {
  const ctx = vmContext();
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), ctx);
  return ctx.module.exports;
};
const feed = loadModule('assets/js/reviews-feed.js');
const feedLog = loadModule('assets/js/feed-log.js');
// The browser modules run in a VM realm: their objects/arrays fail prototype
// checks against host values, so cross-realm comparisons go through JSON.
const canonical = (v) => JSON.stringify(v, (_k, val) => (val && typeof val === 'object' && !Array.isArray(val)
  ? Object.fromEntries(Object.keys(val).sort().map((k) => [k, val[k]]))
  : val));

/* --------------------------------------------- 1. rows from official data */

section('rows carry only the facts the log and the linked play state');
const official2026 = readJSON('data/official/scoring-changes-2026.json');
const { rows, skipped } = rowsFromOfficialSeason(official2026, { season: 2026, now: Date.UTC(2026, 8, 24) });
assert.ok(rows.length > 100, `rows built (${rows.length})`);
assert.ok(Object.keys(skipped).length > 0, 'entries deliberately left out are counted, not silently dropped');
for (const row of rows) {
  assert.equal(typeof row.review.id, 'string');
  assert.ok(/^(scoring|stat)-/.test(row.review.id), 'id matches the browser’s own scheme');
  assert.ok(row.review.id === `scoring-${row.review.atBatIndex}` || row.review.id === `stat-${row.review.atBatIndex}`,
    'id is derived from the at-bat index (scoring- = reclassification, stat- = stat-only change)');
  assert.equal(row.review.typeKey, 'scoring_change');
  assert.equal(row.gamePk, row.review.official && row.gamePk, 'the row belongs to the linked game');
  assert.ok(row.gameDate && /^\d{4}-\d{2}-\d{2}$/.test(row.gameDate), 'game date present');
  {
    const src = official2026.entries.find((x) => x.seq === row.review.official.seq);
    assert.equal(row.review.pitcher ? row.review.pitcher.fullName : null, (src && src.link.pitcherName) || null,
      'the pitcher is the linked play’s StatsAPI pitcher or nothing — never invented');
  }
  assert.equal(row.review.scoreAfter, null, 'no score is invented');
  assert.equal(row.review.initialScoreAfter, null);
  assert.equal(row.review.initialDescription, null, 'no initial-call description is invented');
  assert.equal(row.review.initialObservedAt, null, 'no observation timestamp is invented');
  assert.ok(row.review.official && row.review.official.seq != null, 'the official entry is carried for review');
  assert.equal(row.review.initial.category, feed.scoringCategory({ eventType: row.review.initial.eventType, isOut: row.review.initial.isOut }),
    'category matches the browser’s own scoringCategory');
  assert.equal(row.review.final.category, feed.scoringCategory({ eventType: row.review.final.eventType, isOut: row.review.final.isOut }));
}
const bySeq = new Map(rows.map((r) => [r.review.official.seq, r]));
const entriesBySeq = new Map(official2026.entries.map((e) => [e.seq, e]));
for (const [seq, row] of bySeq) {
  const e = entriesBySeq.get(seq);
  assert.ok(e, `row ${seq} has an official entry`);
  if (row.review.final.eventType != null && e.link.currentEventType) {
    assert.equal(row.review.final.eventType, e.link.currentEventType,
      `final ruling #${seq} is the play’s current StatsAPI ruling`);
    assert.equal(row.review.description, e.link.currentDescription || row.review.description);
  }
}

section('hit → error rows exist and stay in their own section (charter rule 13)');
const h2eRows = rows.filter((r) => feed.isHitToErrorChange(r.review));
const e2hRows = rows.filter((r) => r.review.initial.eventType === 'field_error'
  && feed.SCORING_HIT_EVENT_TYPES.has(r.review.final.eventType));
assert.ok(h2eRows.length > 0, `hit → error rows built (${h2eRows.length})`);
assert.ok(e2hRows.length > 0, `error → hit rows built (${e2hRows.length})`);
// The browser's rule is deliberately narrower than the log classifier in two
// documented, bounded ways, and this test pins exactly that relationship:
//   - a HOME RUN that became an error keeps the primary ✏️ surface (there is no
//     hit → error model for home runs — see isHitToErrorChange's doc comment);
//   - a play StatsAPI recodes into the fielder's-choice family although the log
//     rules the batter reached on a fielding error ("compatible coding" — see
//     link.mjs rulingAgreement) cannot be recognised from observed event types
//     alone, so the row carries a flag saying so.
let homeRunCases = 0;
let compatibleCodings = 0;
for (const row of rows) {
  const entry = entriesBySeq.get(row.review.official.seq);
  const flagged = entry.cls.flags.includes('hitToError');
  const compatible = row.review.flags.some((f) => /compatible coding/.test(f));
  const isHomeRunInitial = row.review.initial.eventType === 'home_run';
  if (isHomeRunInitial) homeRunCases += 1;
  if (compatible) {
    compatibleCodings += 1;
    assert.ok(flagged, `#${entry.seq}: a compatible coding is only excused on a hit → error entry`);
    assert.notEqual(row.review.final.eventType, 'field_error');
  }
  const expected = flagged && !isHomeRunInitial && row.review.final.eventType === 'field_error';
  assert.equal(feed.isHitToErrorChange(row.review), expected,
    `#${entry.seq}: browser hit → error rule = log hitToError, minus the documented home-run and compatible-coding cases`);
}
assert.ok(compatibleCodings <= 3, `the compatible-coding exception stays tiny and visible (${compatibleCodings} row(s))`);
assert.ok(homeRunCases <= 3, `home-run initial calls are rare (${homeRunCases} row(s))`);
for (const row of h2eRows) {
  assert.equal(feed.visibleInAllFeed(row.review), false, 'a hit → error row never enters the All feed');
  assert.equal(feed.shouldAlertForReview(row.review), false, 'a hit → error row never plays the alert chime');
}
for (const row of e2hRows) {
  assert.equal(feed.visibleInAllFeed(row.review), true, 'an error → hit row stays in the All feed');
  assert.equal(feed.shouldAlertForReview(row.review), true, 'error → hit keeps the primary alert');
}

section('session 5: stat changes — batting R/H/RBI in the main alerts, pitching in 🧮 only');
{
  // REAL: official 2026 #249 (the user's own example) + the REAL linked play
  // (tools/fixtures/statsapi-823736-pbp-ab6-7.json, at-bat 7). The link
  // facts the session-5 pipeline adds are taken from that play verbatim.
  const fx = readJSON('tools/fixtures/statsapi-823736-pbp-ab6-7.json');
  const [rec] = extractGamePlays(fx, 823736).filter((p) => p.ai === 7);
  const e249 = JSON.parse(JSON.stringify(official2026.entries.find((e) => e.seq === 249)));
  Object.assign(e249.link, {
    pitcherName: rec.pn, pitcherId: rec.p, playId: rec.vid,
    currentRbi: rec.rbi, currentEarnedRuns: rec.er || 0, currentUnearnedRuns: rec.ur || 0,
  });
  e249.stats = statEffects(e249, {
    batterName: e249.link.batterName, batterId: e249.link.batterId,
    pitcherName: rec.pn, pitcherId: rec.p, currentEventType: e249.link.currentEventType,
  });
  assert.equal(e249.cls.kind, 'error_added');
  assert.equal(buildOfficialFeedRow(e249, { season: 2026 }), null, 'not a ruling change → no scoring- row');
  const row = buildOfficialStatRow(e249, { season: 2026, sourceUrl: official2026.source.url, now: Date.UTC(2026, 8, 24) });
  assert.ok(row, 'a verified stat-changing entry becomes a stat row');
  assert.equal(row.review.id, 'stat-7');
  assert.equal(row.gamePk, 823736);
  assert.equal(row.review.reason, 'Double: RBI \u22121 · ER \u22121 · UER +1');
  assert.equal(row.review.batter.fullName, 'Andrew Vaughn');
  assert.equal(row.review.pitcher.fullName, 'Andrew Abbott', 'the linked play\u2019s StatsAPI pitcher');
  assert.equal(row.review.video, 'https://baseballsavant.mlb.com/sporty-videos?playId=8552c454-1f49-3d56-a8cc-b6fd75ccb380');
  assert.equal(row.review.official.seq, 249);
  assert.equal(row.review.stats.source, 'official_log');
  assert.deepEqual(row.review.stats.batting.map((d) => [d.stat, d.delta, d.player]), [['RBI', -1, 'Andrew Vaughn']]);
  assert.deepEqual(row.review.stats.pitching.map((d) => [d.stat, d.delta, d.player]), [['ER', -1, 'Andrew Abbott'], ['UER', 1, 'Andrew Abbott']]);
  assert.ok(row.review.stats.batting[0].evidence, 'each delta keeps the log clause it came from');
  // The browser (restored from the static log) classifies it exactly as the
  // pipeline flagged it: battingStat → main alerts.
  const payload = mergeRowsIntoFeedLog(null, [row], '2026-09-11', Date.UTC(2026, 8, 24));
  const restored = feed.restoreFeedLog(payload, '2026-09-11');
  assert.equal(restored.entries.length, 1);
  const rr = restored.entries[0].review;
  assert.equal(e249.stats.battingChange, true);
  assert.equal(feed.isBattingStatChange(rr), true, 'Vaughn loses an RBI → main alert system');
  assert.equal(feed.shouldAlertForReview(rr), true);
  assert.equal(feed.visibleInAllFeed(rr), true);
  assert.equal(feed.scoringStatLines(rr).batting, 'Andrew Vaughn: RBI \u22121');
  assert.equal(feed.scoringStatLines(rr).pitching, 'Andrew Abbott: ER \u22121 · UER +1');
  // The same entry reduced to its pitching clause → 🧮 only, silent.
  const pOnly = JSON.parse(JSON.stringify(e249));
  pOnly.stats = { ...pOnly.stats, batting: [], battingChange: false };
  const prow = buildOfficialStatRow(pOnly, { season: 2026 });
  const pr = feed.restoreFeedLog(mergeRowsIntoFeedLog(null, [prow], '2026-09-11', 1), '2026-09-11').entries[0].review;
  assert.equal(feed.isPitchingOnlyStatChange(pr), true);
  assert.equal(feed.shouldAlertForReview(pr), false, 'pitching stat changes never populate the main alerts');
  assert.equal(feed.visibleInAllFeed(pr), false);
  // A second official entry on the same play unions its deltas.
  const again = JSON.parse(JSON.stringify(e249));
  again.seq = 250; again.stats.batting = [{ stat: 'R', delta: -1, player: 'Brice Turang' }]; again.stats.pitching = [];
  const both = rowsFromOfficialSeason({ entries: [e249, again], source: official2026.source }, { season: 2026 }).rows;
  assert.equal(both.length, 1, 'one row per play');
  assert.deepEqual(both[0].review.stats.batting.map((d) => d.stat), ['RBI', 'R'], 'deltas of both entries kept');
  // An entry whose play did not verify never becomes a stat row.
  const unverified = JSON.parse(JSON.stringify(e249));
  unverified.link.flags = ['current_ruling_mismatch'];
  assert.equal(buildOfficialStatRow(unverified, { season: 2026 }), null);
}

section('the browser restores every appended row');
{
  const dateStr = rows[0].gameDate;
  const dayRows = rows.filter((r) => r.gameDate === dateStr);
  const payload = mergeRowsIntoFeedLog(null, dayRows, dateStr, Date.UTC(2026, 8, 24));
  assert.equal(payload.v, 1);
  assert.equal(payload.date, dateStr);
  assert.equal(payload.entries.length, new Set(payload.order).size, 'one row per key');
  const restored = feed.restoreFeedLog(payload, dateStr);
  assert.equal(restored.dropped, 0, 'nothing malformed');
  assert.equal(restored.entries.length, dayRows.length, 'every row comes back');
  // (join() rather than deepEqual: the browser module runs in a VM realm, so
  // its arrays have a different prototype than the host's.)
  assert.equal([...restored.order].join(','), payload.order.join(','), 'order restored');
  for (const entry of restored.entries) {
    assert.equal(entry.review.typeKey, 'scoring_change');
    assert.ok(feed.isUsableName(entry.review.reason), 'the row headline is usable text');
    assert.ok(feed.isUsableName(entry.review.final.label), 'the final ruling is labelled');
    assert.ok(feed.isUsableName(entry.review.initial.label), 'the initial ruling is labelled');
  }
}

section('the merge matches the browser’s merge and is idempotent');
{
  const dateStr = rows.find((r) => r.gameDate === '2026-04-01') ? '2026-04-01' : rows[0].gameDate;
  const dayRows = rows.filter((r) => r.gameDate === dateStr);
  const live = dayRows[0];
  const key = feed.buildEventKey(live.gamePk, live.review);
  // An existing row the browser observed live: longer history, snapshots, a
  // grace window and a settled game must all survive the pipeline append.
  const existing = {
    v: 1,
    date: dateStr,
    savedAt: 111,
    entries: [{
      gamePk: live.gamePk,
      review: { ...live.review, id: live.review.id, changeCount: 2, history: [{ at: 1 }, { at: 2 }], timestamp: '2026-04-01T00:00:00.000Z' },
      firstSeen: 5, lastSeen: 7, matchupLabel: 'observed live',
    }],
    order: [key],
    snapshots: { [live.gamePk]: { 3: { snapshot: { atBatIndex: 3, eventType: 'single' }, signature: 'sig' } } },
    irregularities: { [live.gamePk]: ['kept note'] },
    grace: { [live.gamePk]: { firstFinalObservedAt: 1, lastScanAt: 2 } },
    settled: [live.gamePk],
  };
  const merged = mergeRowsIntoFeedLog(existing, dayRows, dateStr, 222);
  assert.equal(merged.entries.length, dayRows.length, 'all rows present');
  const kept = merged.entries.find((e) => feed.buildEventKey(e.gamePk, e.review) === key);
  assert.equal(kept.review.history.length, 2, 'the longer observed history wins');
  assert.equal(kept.review.changeCount, 2, 'the higher observed change count wins');
  assert.equal(kept.matchupLabel, 'observed live', 'observed label kept');
  assert.equal(canonical(merged.snapshots), canonical(existing.snapshots), 'snapshots preserved');
  assert.equal(canonical(merged.irregularities), canonical(existing.irregularities), 'irregularities preserved');
  assert.equal(canonical(merged.grace), canonical(existing.grace), 'grace preserved');
  assert.equal(canonical(merged.settled), canonical(existing.settled), 'settled preserved');
  // The browser's own merge agrees on keys, snapshots, grace and settled.
  const clientMerged = feedLog.mergePayloads(existing, mergeRowsIntoFeedLog(null, dayRows, dateStr, 222), dateStr);
  assert.deepEqual(new Set(clientMerged.order), new Set(merged.order), 'same row keys as assets/js/feed-log.js');
  assert.equal(canonical(clientMerged.snapshots), canonical(merged.snapshots));
  assert.equal(canonical(clientMerged.grace), canonical(merged.grace));
  assert.equal([...clientMerged.settled].sort().join(','), [...merged.settled].sort().join(','));
  assert.equal([...clientMerged.irregularities[String(live.gamePk)]].sort().join(','),
    [...merged.irregularities[String(live.gamePk)]].sort().join(','));
  // Idempotent: re-merging the same official rows changes nothing.
  const again = mergeRowsIntoFeedLog(merged, dayRows, dateStr, 999);
  assert.ok(payloadEquals(merged, again), 'a second sync of the same rows is a no-op');
  assert.equal(again.entries.find((e) => feed.buildEventKey(e.gamePk, e.review) === key).lastSeen, kept.lastSeen,
    'an unchanged row keeps its lastSeen (no commit noise)');
}

/* ------------------------------------------------------------- 4. the CLI */

section('the CLI writes valid feed logs, updates the index once, and re-runs as a no-op');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-log-sync-'));
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(path.join(dataDir, 'official'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'data/official/scoring-changes-2026.json'), path.join(dataDir, 'official/scoring-changes-2026.json'));
  const indexBefore = { '2026-01-01': 1 };
  fs.writeFileSync(path.join(dataDir, 'feed-log-index.json'), JSON.stringify(indexBefore));
  const run = (extra = []) => execFileSync(process.execPath,
    [path.join(ROOT, 'pipeline/sync-feed-log.mjs'), `--data-dir=${dataDir}`, '--days=14', ...extra],
    { encoding: 'utf8' });
  const out1 = run();
  const written = fs.readdirSync(dataDir).filter((f) => /^feed-log-\d{4}-\d{2}-\d{2}\.json$/.test(f));
  assert.ok(written.length > 0, 'at least one date file written');
  const index = JSON.parse(fs.readFileSync(path.join(dataDir, 'feed-log-index.json'), 'utf8'));
  assert.equal(index['2026-01-01'], 1, 'existing index entries kept');
  for (const f of written) {
    const dateStr = /feed-log-(\d{4}-\d{2}-\d{2})\.json/.exec(f)[1];
    const payload = JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8'));
    assert.equal(payload.v, 1);
    assert.equal(payload.date, dateStr);
    assert.ok(Array.isArray(payload.entries) && payload.entries.length > 0);
    assert.deepEqual(payload.order, payload.entries.map((e) => `${e.gamePk}:${e.review.id}`));
    assert.equal(typeof index[dateStr], 'number', 'the index lists the date');
    assert.ok(payload.entries.every((e) => e.review.typeKey === 'scoring_change'));
  }
  assert.match(out1, /summary changed=\d+/, 'the run prints a summary the workflow can key on');
  const before = written.map((f) => fs.statSync(path.join(dataDir, f)).mtimeMs);
  const out2 = run();
  const after = written.map((f) => fs.statSync(path.join(dataDir, f)).mtimeMs);
  assert.deepEqual(after, before, 'a second run does not rewrite unchanged files');
  assert.match(out2, /summary changed=0 new=0/);
  // Dry run writes nothing at all.
  const out3 = run(['--dry-run']);
  assert.deepEqual(written.map((f) => fs.statSync(path.join(dataDir, f)).mtimeMs), before, 'dry run writes nothing');
  assert.match(out3, /dry run/);
}

console.log('official-feed-log-test: OK');
