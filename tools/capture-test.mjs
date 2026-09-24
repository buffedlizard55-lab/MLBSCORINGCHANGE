#!/usr/bin/env node
/* ============================================================================
 * capture-test.mjs — live ruling capture (pipeline/capture.mjs +
 * pipeline/lib/capture-lib.mjs), fully offline.
 *   1. Unit tests of the ledger logic (states, pending targets, error type,
 *      wording-only edits, late plays, serialisation, heartbeat, game choice).
 *   2. End to end: capture.mjs against tools/fixtures/capture-fetch-stub.cjs
 *      (SYNTHETIC games whose rulings change between polls), then a second
 *      run that must change nothing (no commit churn).
 * ==========================================================================*/
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  updateLedger, stateSig, serializeMonth, parseMonth, statusDue, selectGames, pendingByTarget, CAPTURE_FIELDS,
} from '../pipeline/lib/capture-lib.mjs';

const require = createRequire(import.meta.url);
const SM = require('../assets/js/scoring-model.js');
const R = require('../assets/js/reviews.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
const test = (name, fn) => { fn(); passed += 1; };

const T0 = Date.parse('2026-09-24T20:00:00Z');
const at = (min) => new Date(T0 + min * 60000).toISOString();
const game = { gamePk: 1, officialDate: '2026-09-24', gameType: 'R', season: 2026, awayId: 10, homeId: 20, away: 'AAA', home: 'BBB', abstractGameState: 'Live' };
function play(ai, { et, desc = `${et} desc`, credits = [], complete = true, events = [], endMin = 0 } = {}) {
  return {
    result: complete ? { type: 'atBat', eventType: et, event: et, description: desc } : { type: 'atBat' },
    about: { atBatIndex: ai, isComplete: complete, inning: 2, isTopInning: false, endTime: at(endMin) },
    matchup: { batter: { id: 500 + ai, fullName: `B${ai}` } },
    playEvents: [{ details: { isInPlay: true }, hitData: { launchSpeed: 90, launchAngle: 5, trajectory: 'ground_ball', location: '6' } }, ...events],
    runners: [{ movement: { end: '1B', isOut: false }, details: { eventType: et, runner: { id: 500 + ai } }, credits }],
  };
}
const throwErr = [{ credit: 'f_throwing_error', position: { abbreviation: 'SS' }, player: { id: 9 } }];
const fieldErr2B = [{ credit: 'f_fielding_error', position: { abbreviation: '2B' }, player: { id: 8 } }];
const priorMarker = [{ type: 'action', details: { eventType: 'os_ruling_pending_prior', description: 'Official Scorer Ruling Pending' } }];

test('capture projection keeps completion flags and end times', () => {
  assert.ok(CAPTURE_FIELDS.split(',').includes('isComplete'));
  assert.ok(CAPTURE_FIELDS.split(',').includes('endTime'));
  assert.ok(CAPTURE_FIELDS.split(',').includes('credits'));
});

test('error type from credits (batter first) and from the description', () => {
  assert.deepEqual(SM.errorKindOfStatsApiPlay(play(1, { et: 'field_error', credits: throwErr })), { kind: 'throwing', pos: 'SS' });
  assert.equal(SM.errorKindFromDescription('X reaches on a missed catch error by first baseman Y.'), 'missed_catch');
  assert.equal(SM.errorKindFromDescription('X reaches on a fielding error by shortstop Y.'), 'fielding');
  assert.equal(SM.errorKindFromDescription('X singles.'), null);
  // The batter's own error is described first: the earliest phrase wins.
  assert.equal(SM.errorKindFromDescription('X reaches on a fielding error by shortstop Y. X to 2nd on a throwing error by catcher Z.'), 'fielding');
  assert.deepEqual(SM.errorKindOfRecord({ cr: ['f_assist|3B|1|R', 'f_error_dropped_ball|1B|2|B'] }), { kind: 'missed_catch', pos: '1B' });
});

test('new error is captured once; identical polls change nothing', () => {
  const L = new Map();
  let c = updateLedger(L, game, [play(1, { et: 'field_error', credits: throwErr, endMin: -2 })], { nowIso: at(0), SM, R });
  assert.deepEqual(c, { added: 1, changed: 0, filled: 0 });
  const e = L.get('1:1');
  assert.equal(e.states[0].kind, 'throwing');
  assert.equal(e.states[0].pos, 'SS');
  assert.deepEqual(e.why, ['error']);
  c = updateLedger(L, game, [play(1, { et: 'field_error', credits: throwErr, endMin: -2 })], { nowIso: at(2), SM, R });
  assert.deepEqual(c, { added: 0, changed: 0, filled: 0 });
  assert.equal(L.get('1:1').states.length, 1);
});

test('a wording-only edit is not a new ruling; a change to a hit is', () => {
  const L = new Map();
  updateLedger(L, game, [play(1, { et: 'field_error', credits: throwErr, desc: 'a', endMin: -2 })], { nowIso: at(0), SM, R });
  let c = updateLedger(L, game, [play(1, { et: 'field_error', credits: throwErr, desc: 'a (edited)', endMin: -2 })], { nowIso: at(3), SM, R });
  assert.equal(c.changed, 0);
  c = updateLedger(L, game, [play(1, { et: 'single', credits: [], desc: 'single', endMin: -2 })], { nowIso: at(9), SM, R });
  assert.equal(c.changed, 1);
  const e = L.get('1:1');
  assert.equal(e.states.length, 2);
  assert.equal(e.states[0].et, 'field_error');
  assert.equal(e.states[1].et, 'single');
  assert.equal(e.states[1].at, at(9));
});

test('pending markers: primary targets its own play, prior targets the previous one', () => {
  const plays = [
    play(2, { et: 'os_ruling_pending_primary', desc: 'Official Scorer Ruling Pending' }),
    play(3, { et: 'single' }),
    play(4, { complete: false, events: priorMarker }),
  ];
  const m = pendingByTarget(plays, R, SM);
  assert.deepEqual([...m.keys()].sort(), [2, 3]);
  assert.deepEqual(m.get(3).codes, ['os_ruling_pending_prior']);
  assert.equal(m.get(3).onAi, 4);
  assert.equal(m.get(3).marker.eventType, 'os_ruling_pending_prior');
  const L = new Map();
  updateLedger(L, game, plays, { nowIso: at(0), SM, R });
  assert.ok(L.get('1:2').why.includes('pending'));
  assert.equal(L.get('1:3').states[0].pend.onAi, 4);
  assert.ok(!L.has('1:4'), 'the in-progress plate appearance itself is not an entry');
  // Resolution: the marker disappears and the primary play gets its ruling.
  updateLedger(L, game, [play(2, { et: 'field_error', credits: fieldErr2B }), play(3, { et: 'single' }), play(4, { complete: false })], { nowIso: at(4), SM, R });
  const e2 = L.get('1:2');
  assert.equal(e2.states.length, 2);
  assert.equal(e2.states[1].et, 'field_error');
  assert.equal(e2.states[1].kind, 'fielding');
  assert.equal(e2.states[1].pend, null);
  assert.deepEqual(e2.why.sort(), ['error', 'pending']);
  assert.equal(L.get('1:3').states[1].pend, null, 'prior-marker target resolved (ruling confirmed)');
});

test('plays first seen long after they ended are not "captured live"', () => {
  const L = new Map();
  const c = updateLedger(L, game, [play(7, { et: 'field_error', endMin: -400 })], { nowIso: at(0), SM, R });
  assert.equal(c.added, 0);
});

test('month files round-trip and are stable', () => {
  const L = new Map();
  updateLedger(L, game, [play(1, { et: 'field_error', credits: throwErr, endMin: -2 }), play(3, { et: 'field_error', endMin: -1 })], { nowIso: at(0), SM, R });
  const text = serializeMonth('2026-09', [...L.values()].reverse(), at(0));
  const back = parseMonth(text);
  assert.deepEqual(back.map((e) => e.id), ['1:1', '1:3'], 'ordered by game then plate appearance');
  assert.equal(serializeMonth('2026-09', back, at(0)), text, 'byte-stable');
  assert.equal(JSON.parse(text).count, 2);
  assert.deepEqual(parseMonth('{broken'), []);
});

test('heartbeat is rewritten on change or every 3 hours only', () => {
  const now = T0;
  assert.equal(statusDue(null, now, false), true);
  assert.equal(statusDue({ lastRunAt: new Date(now - 3600e3).toISOString() }, now, false), false);
  assert.equal(statusDue({ lastRunAt: new Date(now - 3600e3).toISOString() }, now, true), true);
  assert.equal(statusDue({ lastRunAt: new Date(now - 3 * 3600e3).toISOString() }, now, false), true);
});

test('game selection: live regular/postseason games + recently started finals', () => {
  const g = (pk, gameType, abs, coded, hoursAgo) => ({ gamePk: pk, gameType, abstractGameState: abs, codedGameState: coded, gameDate: new Date(T0 - hoursAgo * 3600e3).toISOString() });
  const { live, finals } = selectGames([
    g(1, 'R', 'Live', 'I', 1), g(2, 'S', 'Live', 'I', 1), g(3, 'R', 'Final', 'F', 5), g(4, 'R', 'Final', 'F', 20),
    g(5, 'R', 'Final', 'D', 2), g(6, 'D', 'Live', 'I', 1), g(7, 'R', 'Preview', 'P', -2),
  ], T0);
  assert.deepEqual(live.map((x) => x.gamePk), [1, 6]);
  assert.deepEqual(finals.map((x) => x.gamePk), [3], 'postponed (D) and old finals excluded');
});

test('scores recorded at capture use the published model and the error type', () => {
  const model = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/model/scoring-model.json'), 'utf8'));
  const L = new Map();
  updateLedger(L, game, [play(1, { et: 'field_error', credits: throwErr, endMin: -2 }), play(2, { et: 'os_ruling_pending_primary' })], { nowIso: at(0), SM, R, model });
  const e1 = L.get('1:1');
  assert.ok(Number.isInteger(e1.score.e2h.score) && e1.score.e2h.score >= 0 && e1.score.e2h.score <= 100);
  assert.equal(e1.score.e2h.modelAt, model.generatedAt);
  const e2 = L.get('1:2');
  assert.ok(Array.isArray(e2.score.pending.dist) && e2.score.pending.dist.length > 0);
  const total = e2.score.pending.dist.reduce((s, x) => s + x.p, 0);
  assert.ok(Math.abs(total - 1) < 0.01, 'pending distribution sums to 1');
});

/* ------------------------------------------------------------ end to end */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-test-'));
const env = {
  ...process.env,
  CAPTURE_OUT_DIR: path.join(tmp, 'capture'),
  CAPTURE_MODEL_FILE: path.join(ROOT, 'data/model/scoring-model.json'),
  CAPTURE_NOW: '2026-09-24T21:00:00Z',
};
const runCapture = (extraEnv = {}) => {
  const r = spawnSync(process.execPath, ['--require', path.join(ROOT, 'tools/fixtures/capture-fetch-stub.cjs'), path.join(ROOT, 'pipeline/capture.mjs'), '--polls=3', '--interval=0'], {
    cwd: ROOT, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 60000,
  });
  if (r.status !== 0) { console.error(r.stdout, r.stderr); throw new Error(`capture exited ${r.status}`); }
  return r;
};

test('end to end: rulings as first called, their changes, and the heartbeat', () => {
  const r = runCapture();
  assert.match(r.stdout, /::notice title=capture::/);
  const file = path.join(tmp, 'capture', 'rulings-2026-09.json');
  const plays = parseMonth(fs.readFileSync(file, 'utf8'));
  const byId = new Map(plays.map((e) => [e.id, e]));
  assert.deepEqual([...byId.keys()].sort(), ['900001:1', '900001:2', '900001:3', '900002:5']);
  const e1 = byId.get('900001:1');
  assert.deepEqual(e1.states.map((s) => s.et), ['field_error', 'single'], 'in-game error → single seen live');
  assert.equal(e1.states[0].kind, 'throwing');
  assert.equal(e1.away, 'AAA');
  assert.equal(e1.homeId, 902);
  assert.ok(e1.score && e1.score.e2h, 'model score recorded at capture');
  const e2 = byId.get('900001:2');
  assert.equal(e2.states[0].et, 'os_ruling_pending_primary');
  assert.deepEqual(e2.states[0].pend.codes, ['os_ruling_pending_primary']);
  assert.equal(e2.states[1].et, 'field_error');
  assert.equal(e2.states[1].kind, 'fielding');
  assert.ok(e2.score.pending.dist.length > 0);
  const e3 = byId.get('900001:3');
  assert.equal(e3.states[0].pend.codes[0], 'os_ruling_pending_prior');
  assert.equal(e3.states.at(-1).pend, null);
  assert.ok(!byId.has('900002:9'), 'a play that ended 7 h earlier is not captured');
  const status = JSON.parse(fs.readFileSync(path.join(tmp, 'capture', 'status.json'), 'utf8'));
  assert.equal(status.lastRun.warnings.length, 0, `no warnings (spring game not polled): ${status.lastRun.warnings}`);
  assert.equal(status.lastChangeAt, status.lastRunAt);
});

test('end to end: a repeat run with nothing new changes no file (no commit churn)', () => {
  const file = path.join(tmp, 'capture', 'rulings-2026-09.json');
  const before = fs.readFileSync(file, 'utf8');
  const statusBefore = fs.readFileSync(path.join(tmp, 'capture', 'status.json'), 'utf8');
  runCapture({ STUB_START_POLL: '3' });
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.readFileSync(path.join(tmp, 'capture', 'status.json'), 'utf8'), statusBefore);
});

console.log(`capture-test: ${passed} passed`);
