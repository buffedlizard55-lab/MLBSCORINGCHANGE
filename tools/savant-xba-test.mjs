#!/usr/bin/env node
/* ============================================================================
 * savant-xba-test.mjs — deterministic checks for the polite Savant client and
 * the per-play xBA collection (pipeline/lib/savant.mjs, item 3 of the session
 * brief).
 *
 * Run: node tools/savant-xba-test.mjs
 *
 * No network: global fetch is replaced by a scripted stub that records every
 * URL and can be told to rate-limit, to ignore the date-range parameters
 * (which is the failure mode the self-check exists for), or to fail.
 * ==========================================================================*/

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CACHE_VERSION, collectPlayXba, createSavantClient, dateRangeUrl, monthEnd,
  parseSavantRows, rowsInRange, seasonErrorsUrl,
} from '../pipeline/lib/savant.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'savant-test-'));
let failures = 0;
const section = (name) => console.log(`- ${name}`);
const test = (name, fn) => {
  try { fn(); console.log(`  ok ${name}`); } catch (err) { failures += 1; console.error(`  FAIL ${name}: ${err.message}`); }
};
const testAsync = async (name, fn) => {
  try { await fn(); console.log(`  ok ${name}`); } catch (err) { failures += 1; console.error(`  FAIL ${name}: ${err.message}`); }
};

/* --------------------------------------------------------------- fetch stub */

const realFetch = globalThis.fetch;
const calls = [];
let handler = () => ({ ok: true, status: 200, text: async () => '' });
globalThis.fetch = async (url, opts) => {
  calls.push(String(url));
  const r = handler(String(url), opts);
  if (typeof r === 'string') return { ok: true, status: 200, text: async () => r };
  return r;
};

const CSV_HEAD = '\uFEFF"game_pk","at_bat_number","game_date","launch_speed","launch_angle","estimated_ba_using_speedangle","events"\n';
const csvFor = (rows) => CSV_HEAD + rows.map((r) => [r.gamePk, r.ai + 1, r.gameDate, r.ls, r.la, r.xba, r.events]
  .map((v) => `"${v}"`).join(',')).join('\n') + '\n';
const csvText = (rows) => CSV_HEAD + rows.map((r) => `"${r[0]}","${r[1]}","${r[2]}","${r[3]}","${r[4]}","${r[5]}","${r[6]}"`).join('\n') + '\n';

/* ------------------------------------------------------------------ parsing */

section('parsing and self-checks');
test('monthEnd is the last UTC day of the month', () => {
  assert.equal(monthEnd('2026-02'), '2026-02-28');
  assert.equal(monthEnd('2024-02'), '2024-02-29');
  assert.equal(monthEnd('2026-07'), '2026-07-31');
  assert.equal(monthEnd('2026-12'), '2026-12-31');
  assert.equal(monthEnd('nope'), null);
});
test('parseSavantRows joins on gamePk + atBatNumber-1 and keeps every column we use', () => {
  const rows = parseSavantRows(csvFor([
    { gamePk: 824983, ai: 76, gameDate: '2026-07-04', ls: 95.1, la: -3, xba: 0.329, events: 'field_error' },
    { gamePk: 823448, ai: 76, gameDate: '2026-06-18', ls: 88, la: 15, xba: 0.244, events: 'single' },
  ]));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    gamePk: 824983, ai: 76, gameDate: '2026-07-04', events: 'field_error', ls: 95.1, la: -3, xba: 0.329, batterId: null,
  });
  assert.equal(rows[1].ai, 76);
});
test('parseSavantRows drops rows without a usable gamePk/atBatNumber and tolerates an empty answer', () => {
  const rows = parseSavantRows('\uFEFF"game_pk","at_bat_number","estimated_ba_using_speedangle"\n"","",""\n"824983","77","0.3"\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].xba, 0.3);
  assert.deepEqual(parseSavantRows(''), []);
});
test('rowsInRange only keeps rows whose own game_date proves they are inside the window', () => {
  const rows = parseSavantRows(csvFor([
    { gamePk: 1, ai: 0, gameDate: '2026-07-01', ls: 90, la: 10, xba: 0.3, events: 'single' },
    { gamePk: 2, ai: 0, gameDate: '2026-06-30', ls: 90, la: 10, xba: 0.3, events: 'single' },
    { gamePk: 3, ai: 0, gameDate: '', ls: 90, la: 10, xba: 0.3, events: 'single' },
  ]));
  const r = rowsInRange(rows, '2026-07-01', '2026-07-31');
  assert.equal(r.rows.length, 1);
  assert.equal(r.outsideRange, 1);
  assert.equal(r.missingDate, 1);
});

/* ------------------------------------------------------- client politeness */

section('client politeness');
await testAsync('requests are sequential, spaced, cached by TTL, and a 429 stops the queue', async () => {
  calls.length = 0;
  const cacheFile = path.join(tmp, 'polite.json');
  const delayMs = 150;
  const client = createSavantClient({
    cacheFile, budget: 3, delayMs, timeoutMs: 1000,
    log: () => {}, now: () => new Date().toISOString(),
  });
  handler = (url) => {
    if (/rate_limited/.test(url)) return { ok: false, status: 429, text: async () => 'slow down' };
    return csvFor([{ gamePk: 1, ai: 0, gameDate: '2026-07-01', ls: 90, la: 10, xba: 0.3, events: 'single' }]);
  };
  const t0 = Date.now();
  const a = await client.fetchRows('https://baseballsavant.mlb.com/x?1', { ttlMs: 60000 });
  assert.equal(a.rows.length, 1);
  assert.equal(a.fromCache, false);
  const b = await client.fetchRows('https://baseballsavant.mlb.com/x?1', { ttlMs: 60000 });
  assert.equal(b.fromCache, true, 'a repeat question inside the TTL costs no request');
  assert.equal(client.summary().requests, 1);
  const c = await client.fetchRows('https://baseballsavant.mlb.com/rate_limited', { ttlMs: 60000 });
  assert.ok(Date.now() - t0 >= delayMs, 'requests are spaced out, not fired back to back');
  assert.equal(c.rows, null);
  assert.match(c.error, /429/);
  assert.equal(client.summary().rateLimited, true);
  assert.equal(client.summary().budgetExhausted, true, 'a 429 stops the queue instead of retrying');
  const d = await client.fetchRows('https://baseballsavant.mlb.com/x?2', { ttlMs: 60000 });
  assert.equal(d.error, 'budget', 'nothing else is requested after a 429');
  // A fresh client reading the same file keeps the cached answer (this is what
  // the Actions cache gives the pipeline between runs).
  const client2 = createSavantClient({ cacheFile, budget: 3, delayMs: 1, timeoutMs: 1000, log: () => {} });
  const e = await client2.fetchRows('https://baseballsavant.mlb.com/x?1', { ttlMs: 60000 });
  assert.equal(e.fromCache, true);
  assert.equal(client2.summary().requests, 0);
});

await testAsync('a non-text answer is not stored, so a month window never bloats the cache', async () => {
  calls.length = 0;
  const cacheFile = path.join(tmp, 'nocache.json');
  const client = createSavantClient({ cacheFile, budget: 4, delayMs: 1, timeoutMs: 1000, log: () => {} });
  handler = () => csvFor([{ gamePk: 42, ai: 7, gameDate: '2026-07-04', ls: 91, la: 12, xba: 0.4, events: 'single' }]);
  await client.fetchRows('https://baseballsavant.mlb.com/window', { ttlMs: 60000, cacheText: false });
  await client.save();
  const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  assert.equal(raw.version, CACHE_VERSION);
  assert.deepEqual(Object.keys(raw.queries), [], 'a window CSV is thrown away, not cached');
  assert.equal(calls.length, 1);
});

/* -------------------------------------------------------- collectPlayXba */

section('per-play collection');
const play = (gamePk, ai, gameDate, finalError = true) => ({ season: Number(gameDate.slice(0, 4)), gamePk, ai, gameDate, finalError, hasBattedBall: true });

await testAsync('a month window fills in plays the season error list cannot answer, and the window is asked only once', async () => {
  calls.length = 0;
  const cacheFile = path.join(tmp, 'collect1.json');
  const client = createSavantClient({ cacheFile, budget: 4, delayMs: 1, timeoutMs: 1000, log: () => {} });
  handler = (url) => {
    if (/hfSea=/.test(url)) return csvText([[824000, 11, '2026-07-04', '95.0', '-3', '0.329', 'field_error']]);
    return csvText([
      [824001, 21, '2026-07-04', '88.0', '15', '0.244', 'single'],
      [824002, 31, '2026-06-02', '77.0', '40', '0.111', 'single'],
    ]);
  };
  const needed = [
    play(824000, 10, '2026-07-04', true),    // season error list
    play(824001, 20, '2026-07-04', false),   // changed to a hit — month window
    play(824002, 30, '2026-07-02', false),   // month window, but the play is not there
  ];
  const r1 = await collectPlayXba({ client, needed, currentSeason: 2026, today: '2026-09-24' });
  assert.equal(r1.report.needed, 3);
  assert.equal(r1.report.matched, 2);
  assert.equal(r1.byKey.get('824000:10').xba, 0.329);
  assert.equal(r1.byKey.get('824001:20').xba, 0.244);
  assert.equal(r1.byKey.has('824002:30'), false, 'a play Savant did not answer for is left without a value');
  assert.equal(r1.report.unavailable, 1, 'asked for and not on Savant (its game is old enough)');
  assert.equal(r1.report.pending, 0);
  assert.equal(r1.report.coverage, 0.6667);
  assert.equal(r1.report.failures.length, 0);
  const firstCalls = calls.length;
  assert.equal(firstCalls, 2, 'one error list + one month window');
  assert.ok(/game_date_gt=2026-07-01&game_date_lt=2026-07-31/.test(calls[1]), 'the window is the calendar month');

  // Second run: everything is inside its TTL, so nothing at all is requested.
  const client2 = createSavantClient({ cacheFile, budget: 4, delayMs: 1, timeoutMs: 1000, log: () => {} });
  const r2 = await collectPlayXba({ client: client2, needed, currentSeason: 2026, today: '2026-09-24' });
  assert.equal(calls.length, firstCalls, 'no play is asked for twice inside its TTL');
  assert.equal(r2.report.matched, 2);
  assert.equal(r2.report.requests, 0);
});

await testAsync('the budget is respected across queries and the rest stays pending', async () => {
  calls.length = 0;
  const cacheFile = path.join(tmp, 'collect2.json');
  const client = createSavantClient({ cacheFile, budget: 2, delayMs: 1, timeoutMs: 1000, log: () => {} });
  handler = (url) => (/(hfSea|game_date_gt)/.test(url) ? csvText([[5000, 2, '2026-05-05', '90.0', '10', '0.3', 'field_error']]) : '');
  const needed = [play(5000, 1, '2026-05-05', true), play(5002, 3, '2026-05-05', false), play(5003, 4, '2026-02-02', false)];
  const r = await collectPlayXba({ client, needed, currentSeason: 2026, today: '2026-09-24' });
  assert.equal(r.report.requests, 2);
  assert.equal(r.report.queriesDeferred, 1, 'the query that did not fit waits for the next run');
  assert.equal(r.report.pending, 1);
  assert.equal(r.report.matched, 1);
});

await testAsync('a response that ignores the date range is flagged and never used for the wrong play', async () => {
  calls.length = 0;
  const cacheFile = path.join(tmp, 'collect3.json');
  const client = createSavantClient({ cacheFile, budget: 4, delayMs: 1, timeoutMs: 1000, log: () => {} });
  // The server ignores game_date_gt/lt and answers every query with the whole
  // season — the failure mode the game_date self-check exists for. The June
  // row it returns for the JULY window carries a decoy xBA (0.999): if the
  // self-check were missing, the June play would take that value.
  handler = (url) => {
    const june = [6002, 2, '2026-06-10', '90.0', '10', '0.333', 'single'];
    const july = [6003, 3, '2026-07-10', '91.0', '11', '0.222', 'single'];
    if (/game_date_gt=2026-07/.test(url)) return csvText([july, [6002, 2, '2026-06-10', '90.0', '10', '0.999', 'single']]);
    return csvText([june, july]);
  };
  const needed = [
    play(6002, 1, '2026-06-10', false),   // ai 1 → the June row above
    play(6003, 2, '2026-07-10', false),   // ai 2 → the July row above
    play(6004, 3, '2026-09-10', false),   // nothing serves it
  ];
  const r = await collectPlayXba({ client, needed, currentSeason: 2023, today: '2026-09-24' });
  assert.equal(r.byKey.get('6002:1').xba, 0.333, 'the June play takes its own row, not the decoy in the July window');
  assert.equal(r.byKey.get('6003:2').xba, 0.222);
  assert.equal(r.byKey.has('6004:3'), false, 'a play no in-range row covers stays unanswered');
  assert.ok(r.report.failures.some((f) => /date range not honored/.test(f.error)), 'the misbehaving response is reported');
  assert.ok(r.report.queries.filter((q) => q.kind === 'month').every((q) => q.integrity.outsideRange >= 1), 'out-of-range rows are counted');
  assert.equal(r.report.unavailable, 1);
});

section('value discipline');
await testAsync('nothing is invented for a play with no batted ball', async () => {
  const cacheFile = path.join(tmp, 'collect4.json');
  const client = createSavantClient({ cacheFile, budget: 4, delayMs: 1, timeoutMs: 1000, log: () => {} });
  const r = await collectPlayXba({
    client,
    needed: [{ season: 2026, gamePk: 7000, ai: 5, gameDate: '2026-07-01', finalError: true, hasBattedBall: false }],
    currentSeason: 2026, today: '2026-09-24',
  });
  assert.equal(r.report.needed, 0);
  assert.equal(r.report.excludedNoBattedBall, 1);
  assert.equal(r.byKey.size, 0);
});

globalThis.fetch = realFetch;
if (failures) {
  console.error(`savant-xba-test: ${failures} failure(s)`);
  process.exit(1);
}
console.log('savant-xba-test: OK');
