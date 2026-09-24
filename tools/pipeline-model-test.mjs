#!/usr/bin/env node
// Tests for the statistics toolkit, the shared scoring module, play
// extraction and entry linking. Uses SYNTHETIC inputs only (clearly
// constructed data), so it runs offline in CI and in the sandbox.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  fitLogistic, predictLogistic, auc, brier, logLoss, calibrationTable, foldOf, sigmoid,
} from '../pipeline/lib/stats.mjs';
import { extractGamePlays, PBP_FIELDS, isCompleted } from '../pipeline/lib/statsapi.mjs';
import {
  normalizeName, findNameInText, rulingAgrees, rulingAgreement, buildTeamIndex, candidateGames, linkEntry, levenshtein,
  isVerifiedRunnerErrorChange,
} from '../pipeline/lib/link.mjs';
import {
  buildHitProbSurface, buildHitProbFallback, buildPendingTable, selectAndFit,
} from '../pipeline/lib/model-build.mjs';
import { parseCSV } from '../pipeline/lib/csv.mjs';
import { fitLogisticOffset, capturedAdjustment, pendingCalibration } from '../pipeline/lib/adjust.mjs';
import { heterogeneityTest, groupTable } from '../pipeline/lib/effects.mjs';
import { originalErrorKindFromLog } from '../pipeline/lib/log-classifier.mjs';

const require = createRequire(import.meta.url);
const SM = require('../assets/js/scoring-model.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; } catch (err) { console.error(`FAIL: ${name}`); throw err; }
}

// Deterministic PRNG (mulberry32) for synthetic data.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------ stats
test('logistic regression recovers known coefficients (synthetic)', () => {
  const r = rng(7);
  const X = []; const y = [];
  for (let i = 0; i < 20000; i += 1) {
    const a = r() * 4 - 2; const b = r() < 0.3 ? 1 : 0;
    X.push([a, b]);
    y.push(r() < sigmoid(-2 + 1.5 * a + 0.8 * b) ? 1 : 0);
  }
  const fit = fitLogistic(X, y, { lambda: 0.01 });
  assert.ok(fit.converged);
  assert.ok(Math.abs(fit.intercept + 2) < 0.12, `intercept ${fit.intercept}`);
  assert.ok(Math.abs(fit.coef[0] - 1.5) < 0.1, `coef a ${fit.coef[0]}`);
  assert.ok(Math.abs(fit.coef[1] - 0.8) < 0.15, `coef b ${fit.coef[1]}`);
  const p = predictLogistic(fit, [0, 0]);
  assert.ok(Math.abs(p - sigmoid(fit.intercept)) < 1e-12);
});

test('auc / brier / logLoss / calibration on hand-checked values', () => {
  assert.equal(auc([0.1, 0.4, 0.35, 0.8], [0, 0, 1, 1]), 0.75);
  assert.equal(auc([0.5, 0.5], [0, 1]), 0.5);
  assert.equal(auc([0.2, 0.3], [0, 0]), null);
  assert.ok(Math.abs(brier([0.5, 0.5], [0, 1]) - 0.25) < 1e-12);
  assert.ok(Math.abs(logLoss([0.5, 0.5], [0, 1]) - Math.log(2)) < 1e-12);
  const cal = calibrationTable([0.01, 0.03, 0.6], [0, 1, 1]);
  assert.equal(cal[0].n, 1);
  assert.equal(cal[1].n, 1);
  assert.equal(cal[cal.length - 1].n, 1);
  assert.equal(foldOf(822769, 10), foldOf(822769, 10));
  const counts = new Array(10).fill(0);
  for (let g = 700000; g < 702000; g += 1) counts[foldOf(g, 10)] += 1;
  assert.ok(Math.min(...counts) > 150, `folds spread evenly: ${counts}`);
});

// ------------------------------------------------------------- CSV
test('CSV parser handles BOM, quotes, commas, CRLF', () => {
  const rows = parseCSV('\uFEFF"a","b"\r\n"1","x, ""y"""\r\n2,z\n');
  assert.deepEqual(rows, [{ a: '1', b: 'x, "y"' }, { a: '2', b: 'z' }]);
});

// ------------------------------------------------------- scoring model
test('location / trajectory groups', () => {
  assert.equal(SM.locationGroup('6'), 'SS');
  assert.equal(SM.locationGroup('8'), 'OF');
  assert.equal(SM.locationGroup(3), '1B');
  assert.equal(SM.locationGroup(null), 'UNK');
  assert.equal(SM.trajGroup('bunt_grounder'), 'bunt');
  assert.equal(SM.trajGroup('ground_ball'), 'ground_ball');
  assert.equal(SM.trajGroup(''), 'unknown');
});

test('surface lookup clamps to the grid and falls back without EV/LA', () => {
  const surface = { evMin: 40, evStep: 10, nEv: 2, laMin: 0, laStep: 10, nLa: 2, rate: [0.1, 0.2, 0.3, 0.4] };
  assert.equal(SM.surfaceRate(surface, 45, 5), 0.1);
  assert.equal(SM.surfaceRate(surface, 55, 15), 0.4);
  assert.equal(SM.surfaceRate(surface, 999, -50), 0.3, 'clamped to edge cells');
  const model = { hitProb: { surface, fallback: { overall: 0.3, byTraj: { ground_ball: 0.25 }, byTrajLoc: { 'ground_ball|SS': 0.2 } } } };
  assert.deepEqual(SM.hitProbability(model, { ls: 45, la: 15 }), { p: 0.2, source: 'ev_la' });
  assert.deepEqual(SM.hitProbability(model, { traj: 'ground_ball', loc: '6' }), { p: 0.2, source: 'traj_loc' });
  assert.deepEqual(SM.hitProbability(model, { traj: 'ground_ball', loc: '9' }), { p: 0.25, source: 'traj' });
  assert.deepEqual(SM.hitProbability(model, {}), { p: 0.3, source: 'overall' });
});

test('scoreWith computes the logistic score from named terms', () => {
  const surface = { evMin: 0, evStep: 200, nEv: 1, laMin: -90, laStep: 180, nLa: 1, rate: [0.5] };
  const model = {
    hitProb: { surface, fallback: { overall: 0.5 } },
    errorToHit: { terms: ['logit_hit_prob', 'loc:OF', 'batting_home'], coef: [1, 2, -1], intercept: -3, baseRate: 0.05 },
  };
  const play = { ls: 90, la: 10, loc: '8', top: false };
  const s = SM.scoreErrorToHit(model, play);
  // logit(0.5)=0 → z = -3 + 0 + 2 - 1 = -2
  assert.ok(Math.abs(s.probability - sigmoid(-2)) < 1e-12);
  assert.equal(s.score, Math.round(sigmoid(-2) * 100));
  assert.equal(s.hitProbabilitySource, 'ev_la');
  assert.equal(SM.scoreText(0.001), '<1');
  assert.equal(SM.band(model, 85).label, 'Very likely');
  assert.equal(SM.band(model, 3).label, 'Unlikely');
  assert.throws(() => SM.featureValue('nope', 0.5, play), /Unknown model term/);
  assert.equal(SM.featureValue('home:147', 0.5, { homeId: 147 }), 1);
  assert.equal(SM.featureValue('home:147', 0.5, { homeId: 121 }), 0);
  assert.equal(SM.featureValue('home:147', 0.5, {}), 0);
});

test('pendingDistribution picks the most specific adequately-sized cell', () => {
  const model = {
    pending: {
      outcomes: ['hit', 'error', 'fc', 'out', 'sac', 'other'], evEdges: [80], laEdges: [10], minN: 10,
      table: {
        'ground_ball|SS|1|0|R': { n: 5, p: [1, 0, 0, 0, 0, 0] },
        'ground_ball|SS|R': { n: 50, p: [0.6, 0.3, 0.1, 0, 0, 0] },
        R: { n: 1000, p: [0.8, 0.05, 0.1, 0.05, 0, 0] },
      },
    },
  };
  const d = SM.pendingDistribution(model, { traj: 'ground_ball', loc: '6', ls: 90, la: 5 }, true);
  assert.equal(d.key, 'ground_ball|SS|R', 'n=5 cell is skipped (minN=10)');
  assert.equal(d.distribution[0].outcome, 'hit');
  assert.equal(d.distribution.length, 3, 'zero-probability outcomes omitted');
  const d2 = SM.pendingDistribution(model, { traj: 'fly_ball', loc: '8' }, true);
  assert.equal(d2.key, 'R');
});

test('outcomeOf maps StatsAPI event types', () => {
  assert.equal(SM.outcomeOf('single'), 'hit');
  assert.equal(SM.outcomeOf('field_error'), 'error');
  assert.equal(SM.outcomeOf('fielders_choice_out'), 'fc');
  assert.equal(SM.outcomeOf('grounded_into_double_play'), 'out');
  assert.equal(SM.outcomeOf('force_out'), 'out');
  assert.equal(SM.outcomeOf('sac_bunt'), 'sac');
  assert.equal(SM.outcomeOf('catcher_interf'), 'other');
});

// --------------------------------------------- StatsAPI-shaped payloads
// SYNTHETIC payload in the StatsAPI playByPlay shape.
const syntheticPbp = {
  allPlays: [
    {
      result: { type: 'atBat', event: 'Field Error', eventType: 'field_error', description: 'A reaches on a fielding error by shortstop B.', rbi: 0, awayScore: 0, homeScore: 0, isOut: false },
      about: { atBatIndex: 0, inning: 1, isTopInning: true, hasReview: false, startTime: '2026-04-01T23:10:00Z' },
      matchup: { batter: { id: 1, fullName: 'Test Batter' }, pitcher: { id: 2, fullName: 'Test Pitcher' }, batSide: { code: 'R' }, pitchHand: { code: 'L' }, splits: { menOnBase: 'Empty' } },
      count: { outs: 0 },
      playEvents: [
        { index: 0, isPitch: true, details: { isInPlay: false }, hitData: { launchSpeed: 70, launchAngle: 40, trajectory: 'popup', location: '2' } },
        { index: 1, isPitch: true, details: { isInPlay: true }, hitData: { launchSpeed: 88.4, launchAngle: -3, totalDistance: 12, trajectory: 'ground_ball', hardness: 'medium', location: '6', coordinates: { coordX: 110.5, coordY: 150.2 } } },
      ],
      runners: [{ movement: { originBase: null, start: null, end: '1B', isOut: false }, details: { eventType: 'field_error', runner: { id: 1 } }, credits: [{ player: { id: 9 }, position: { abbreviation: 'SS' }, credit: 'f_fielding_error' }] }],
    },
    {
      result: { type: 'atBat', event: 'Strikeout', eventType: 'strikeout', description: 'C strikes out.', isOut: true },
      about: { atBatIndex: 1, inning: 1, isTopInning: true },
      matchup: { batter: { id: 3, fullName: 'Other Batter' } },
      playEvents: [
        { index: 0, details: { isInPlay: false } },
        { index: 1, details: { eventType: 'os_ruling_pending_prior', description: 'Official Scorer Ruling Pending' } },
      ],
      runners: [{ movement: { isOut: true }, details: { runner: { id: 3 } } }],
    },
  ],
};

test('extractGamePlays keeps the in-play batted ball, credits, markers, reach flag', () => {
  const recs = extractGamePlays(syntheticPbp, 555);
  assert.equal(recs.length, 2);
  const a = recs[0];
  assert.equal(a.g, 555);
  assert.equal(a.et, 'field_error');
  assert.equal(a.top, true);
  assert.equal(a.br, 1);
  assert.deepEqual(a.hd, { ls: 88.4, la: -3, dist: 12, traj: 'ground_ball', hard: 'medium', loc: '6', cx: 110.5, cy: 150.2 });
  assert.deepEqual(a.cr, ['f_fielding_error|SS|9|B']);
  assert.equal(a.re, 1);
  const b = recs[1];
  assert.equal(b.hd, null, 'no in-play event → no batted ball');
  assert.equal(b.br, 0);
  assert.equal(b.pend.length, 1);
  assert.equal(b.pend[0].et, 'os_ruling_pending_prior');
  for (const k of ['hitData', 'launchSpeed', 'credits', 'isInPlay', 'coordinates', 'coordX']) {
    assert.ok(PBP_FIELDS.split(',').includes(k), `PBP_FIELDS lists ${k}`);
  }
  assert.ok(isCompleted({ codedGameState: 'F' }) && !isCompleted({ codedGameState: 'D' }));
});

test('browser helpers read the same StatsAPI shape', () => {
  const p = SM.playFromStatsApi(syntheticPbp.allPlays[0]);
  assert.equal(p.ls, 88.4);
  assert.equal(p.loc, '6');
  assert.equal(p.traj, 'ground_ball');
  assert.equal(SM.batterReached(syntheticPbp.allPlays[0]), true);
  assert.equal(SM.batterReached(syntheticPbp.allPlays[1]), false);
  const rec = extractGamePlays(syntheticPbp, 555)[0];
  const q = SM.playFromRecord(rec);
  for (const k of ['et', 'top', 'inn', 'ai', 'ls', 'la', 'traj', 'loc', 'dist']) {
    assert.deepEqual(q[k], p[k], `record and API shapes agree on ${k}`);
  }
});

// ------------------------------------------------------------------ link
test('name normalisation, fuzzy match and ruling agreement', () => {
  assert.equal(normalizeName('Vladimir Guerrero Jr.'), 'vladimir guerrero');
  assert.equal(normalizeName('Isiah Kiner-Falefa'), 'isiah kiner falefa');
  assert.equal(normalizeName('José Ramírez'), 'jose ramirez');
  assert.equal(normalizeName("Ke'Bryan Hayes"), 'kebryan hayes');
  assert.equal(levenshtein('chisolm', 'chisholm'), 1);
  const text = normalizeName('In the top of the 5th inning, Jazz Chisolm Jr. reaches on a single, instead of an error.');
  const counts = new Map([['chisholm', 1]]);
  assert.equal(findNameInText('Jazz Chisholm Jr.', text, counts).method, 'fuzzy_last_name');
  assert.equal(rulingAgrees('hit', 'double', 'double'), true);
  assert.equal(rulingAgrees('hit', 'double', 'single'), false);
  assert.equal(rulingAgrees('error', null, 'field_error'), true);
  assert.equal(rulingAgrees('other', null, 'single'), null);
});

test('candidateGames: team codes, doubleheaders, date tolerance (synthetic)', () => {
  const teams = [
    { id: 145, abbreviation: 'CWS', teamCode: 'cha', fileCode: 'cws' },
    { id: 114, abbreviation: 'CLE', teamCode: 'cle', fileCode: 'cle' },
  ];
  const idx = buildTeamIndex(teams);
  assert.equal(idx.get('CHW').id, 145, 'documented alias');
  assert.equal(idx.get('CHA').id, 145, 'StatsAPI teamCode');
  const games = [
    { gamePk: 1, awayId: 145, homeId: 114, officialDate: '2026-05-03', gameNumber: 1 },
    { gamePk: 2, awayId: 145, homeId: 114, officialDate: '2026-05-03', gameNumber: 2 },
    { gamePk: 3, awayId: 145, homeId: 114, officialDate: '2026-05-10', gameNumber: 1 },
  ];
  assert.deepEqual(candidateGames({ away: 'CWS', home: 'CLE', date: '2026-05-03', gameNumber: 2 }, idx, games).games.map((g) => g.gamePk), [2]);
  assert.deepEqual(candidateGames({ away: 'CWS', home: 'CLE', date: '2026-05-03', gameNumber: null }, idx, games).games.map((g) => g.gamePk), [1, 2]);
  const off = candidateGames({ away: 'CHW', home: 'CLE', date: '2026-05-11' }, idx, games);
  assert.deepEqual(off.games.map((g) => g.gamePk), [3]);
  assert.ok(off.flags.includes('date_mismatch') && off.flags.includes('team_alias:CHW'));
  assert.ok(candidateGames({ away: 'XXX', home: 'CLE', date: '2026-05-03' }, idx, games).flags[0].startsWith('unknown_team'));
});

test('linkEntry finds the batter in the half-inning and checks the current ruling', () => {
  const teams = [{ id: 10, abbreviation: 'AAA' }, { id: 20, abbreviation: 'BBB' }];
  const games = [{ gamePk: 77, awayId: 10, homeId: 20, officialDate: '2026-06-01', gameNumber: 1 }];
  const plays = [
    { ty: 'atBat', g: 77, ai: 0, inn: 3, top: true, b: 1, bn: 'Runner Guy', et: 'walk' },
    { ty: 'atBat', g: 77, ai: 1, inn: 3, top: true, b: 2, bn: 'Hitter Person', et: 'single' },
    { ty: 'atBat', g: 77, ai: 2, inn: 3, top: false, b: 3, bn: 'Fielder Name', et: 'field_out' },
  ];
  const ctx = { teamIndex: buildTeamIndex(teams), games, playsByGame: new Map([[77, plays]]) };
  const entry = {
    away: 'AAA', home: 'BBB', date: '2026-06-01', inning: 3, half: 'top', gameNumber: null,
    body: 'In the top of the 3rd inning, Hitter Person now has a single instead of reaching on an error by shortstop Fielder Name, scoring Runner Guy.',
    cls: { final: 'hit', finalHitType: 'single' },
  };
  const link = linkEntry(entry, ctx);
  assert.equal(link.gamePk, 77);
  assert.equal(link.atBatIndex, 1);
  assert.equal(link.currentEventType, 'single');
  assert.ok(!link.flags.includes('current_ruling_mismatch'));
  const mismatch = linkEntry({ ...entry, cls: { final: 'error' } }, ctx);
  assert.ok(mismatch.flags.includes('current_ruling_mismatch'));
});

// ----------------------------------------------------------- model build
test('surface, fallback, pending table and selection on synthetic records', () => {
  const r = rng(11);
  const recs = [];
  for (let i = 0; i < 6000; i += 1) {
    const ls = 50 + r() * 60; const la = -30 + r() * 80;
    const pHit = sigmoid(-1.2 + (ls - 80) / 12 - Math.abs(la - 12) / 15);
    const hit = r() < pHit;
    recs.push({
      ty: 'atBat', g: 1000 + (i % 400), ai: i, br: hit ? 1 : (r() < 0.1 ? 1 : 0),
      et: hit ? 'single' : (r() < 0.05 ? 'field_error' : 'field_out'),
      hd: { ls, la, traj: la < 10 ? 'ground_ball' : 'fly_ball', loc: String(1 + Math.floor(r() * 9)) },
    });
  }
  const surface = buildHitProbSurface(recs);
  assert.equal(surface.rate.length, surface.nEv * surface.nLa);
  assert.ok(surface.rate.every((v) => v >= 0 && v <= 1));
  const lo = SM.surfaceRate(surface, 55, -25); const hi = SM.surfaceRate(surface, 105, 12);
  assert.ok(hi > lo, `hard line drives beat weak grounders (${hi} > ${lo})`);
  const fb = buildHitProbFallback(recs);
  assert.ok(fb.overall > 0 && fb.byTraj.ground_ball != null);
  const pend = buildPendingTable(recs);
  assert.ok(pend.table.R.n > 0);
  const sumP = pend.table.R.p.reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(sumP - 1) < 1e-3, `probabilities sum to 1 (${sumP})`);
  const model = { hitProb: { surface, fallback: fb } };
  const rows = recs.filter((x) => x.et === 'field_error' || x.et === 'single').map((x) => ({
    id: `${x.g}:${x.ai}`, gamePk: x.g, season: x.ai % 2 ? 2026 : 2025, y: x.et === 'single' ? 1 : 0, play: SM.playFromRecord(x),
  }));
  const { spec, oofById } = selectAndFit(rows, [[], ['logit_hit_prob']], model, { k: 5, lambdas: [1], ootSeason: 2026 });
  assert.deepEqual(spec.terms, ['logit_hit_prob'], 'informative feature beats intercept-only');
  assert.ok(spec.cv.auc > 0.6);
  assert.equal(oofById.size, rows.length);
  assert.ok(spec.outOfTime && spec.outOfTime.n > 0);
});

test('StatsAPI coding conventions: compatible vs mismatch', () => {
  assert.equal(rulingAgreement('fc', null, 'sac_bunt'), 'compatible', 'sacrifice fielder\'s choice is coded sac_bunt');
  assert.equal(rulingAgreement('error', null, 'fielders_choice'), 'compatible');
  assert.equal(rulingAgreement('error', null, 'force_out'), 'compatible');
  assert.equal(rulingAgreement('error', null, 'single'), 'mismatch');
  assert.equal(rulingAgreement('hit', 'double', 'field_out'), 'mismatch');
  assert.equal(rulingAgreement('fc+error', null, 'field_error'), 'exact');
  assert.equal(rulingAgreement('out', null, 'grounded_into_double_play'), 'exact');
  assert.equal(rulingAgrees('error', null, 'force_out'), true);
});

test('team-code correction on the same date and wide date window (synthetic)', () => {
  const teams = [
    { id: 139, abbreviation: 'TB', teamCode: 'tba', fileCode: 'tb' },
    { id: 141, abbreviation: 'TOR', teamCode: 'tor', fileCode: 'tor' },
    { id: 108, abbreviation: 'LAA', teamCode: 'ana', fileCode: 'ana' },
    { id: 119, abbreviation: 'LAD', teamCode: 'lan', fileCode: 'la' },
  ];
  const idx = buildTeamIndex(teams);
  const byId = new Map(teams.map((t) => [t.id, t]));
  const games = [
    { gamePk: 1, awayId: 139, homeId: 141, officialDate: '2026-05-12', gameNumber: 1 },
    { gamePk: 2, awayId: 141, homeId: 119, officialDate: '2025-08-10', gameNumber: 1 },
    { gamePk: 3, awayId: 139, homeId: 108, officialDate: '2025-08-20', gameNumber: 1 },
  ];
  const tbn = candidateGames({ away: 'TBN', home: 'TOR', date: '2026-05-12' }, idx, games, byId);
  assert.deepEqual(tbn.games.map((g) => g.gamePk), [1]);
  assert.deepEqual(tbn.flags, ['team_code_corrected:TBN->TB']);
  const laa = candidateGames({ away: 'TOR', home: 'LAA', date: '2025-08-10' }, idx, games, byId);
  assert.deepEqual(laa.games.map((g) => g.gamePk), [2], 'TOR played only at LAD that day');
  assert.deepEqual(laa.flags, ['team_code_corrected:LAA->LAD']);
  const wide = candidateGames({ away: 'TB', home: 'LAA', date: '2025-08-12' }, idx, games, byId);
  assert.deepEqual(wide.games.map((g) => g.gamePk), [3]);
  assert.ok(wide.flags.includes('date_mismatch_wide'));
  const none = candidateGames({ away: 'XYZ', home: 'QRS', date: '2025-08-12' }, idx, games, byId);
  assert.equal(none.games.length, 0);
  // A DATE typo must use the date fallback, never "correct" the opponent:
  // CHC@PIT was on 6/1; on 6/2 PIT hosted CWS (teamCode "cha" shares "CH").
  const t2 = [
    { id: 112, abbreviation: 'CHC', teamCode: 'chn', fileCode: 'chc' },
    { id: 145, abbreviation: 'CWS', teamCode: 'cha', fileCode: 'cws' },
    { id: 134, abbreviation: 'PIT', teamCode: 'pit', fileCode: 'pit' },
  ];
  const g2 = [
    { gamePk: 10, awayId: 112, homeId: 134, officialDate: '2026-06-01', gameNumber: 1 },
    { gamePk: 11, awayId: 145, homeId: 134, officialDate: '2026-06-02', gameNumber: 1 },
  ];
  const typo = candidateGames({ away: 'CHC', home: 'PIT', date: '2026-06-02' }, buildTeamIndex(t2), g2, new Map(t2.map((t) => [t.id, t])));
  assert.deepEqual(typo.games.map((g) => g.gamePk), [10], 'date fallback wins');
  assert.deepEqual(typo.flags, ['date_mismatch']);
});

test('scoreReview: scoring-change and pending rows from StatsAPI plays (synthetic)', () => {
  const surface = { evMin: 40, evStep: 40, nEv: 2, laMin: -60, laStep: 65, nLa: 2, rate: [0.05, 0.2, 0.3, 0.6] };
  const model = {
    hitProb: { surface, fallback: { overall: 0.3 } },
    errorToHit: { terms: ['logit_hit_prob'], coef: [1], intercept: -2, baseRate: 0.05 },
    hitToError: { terms: ['logit_hit_prob'], coef: [-1], intercept: -6, baseRate: 0.001 },
    pending: { outcomes: ['hit', 'error', 'fc', 'out', 'sac', 'other'], evEdges: [85], laEdges: [10], minN: 1,
      table: { R: { n: 100, p: [0.7, 0.2, 0.1, 0, 0, 0] }, O: { n: 100, p: [0, 0, 0, 1, 0, 0] } } },
  };
  const play = (ai, ls, la, batterOut) => ({
    about: { atBatIndex: ai }, matchup: { batter: { id: 10 + ai } },
    playEvents: [{ details: { isInPlay: true }, hitData: { launchSpeed: ls, launchAngle: la, trajectory: 'ground_ball', location: '6' } }],
    runners: [{ movement: { isOut: batterOut }, details: { runner: { id: 10 + ai } } }],
  });
  const plays = new Map([[4, play(4, 95, 5, false)], [5, play(5, 50, 30, true)]]);
  const lookup = (ai) => plays.get(ai) || null;
  const e = SM.scoreReview(model, { typeKey: 'scoring_change', atBatIndex: 4, halfInning: 'top', initial: { eventType: 'field_error' } }, lookup, 147);
  assert.equal(e.kind, 'errorToHit');
  assert.ok(Math.abs(e.result.probability - sigmoid(-2 + Math.log(0.6 / 0.4))) < 1e-12);
  assert.equal(e.battedBall.ls, 95);
  assert.equal(SM.scoreReview(model, { typeKey: 'scoring_change', atBatIndex: 4, initial: { eventType: 'home_run' } }, lookup), null, 'no model for home runs');
  assert.equal(SM.scoreReview(model, { typeKey: 'abs', atBatIndex: 4 }, lookup), null);
  // os_ruling_pending_prior refers to the PREVIOUS plate appearance (ai 4: batter reached)
  const prior = SM.scoreReview(model, { typeKey: 'pending_scoring', atBatIndex: 5, pendingCodes: ['os_ruling_pending_prior'] }, lookup);
  assert.equal(prior.target, 4);
  assert.equal(prior.distribution.key, 'R');
  const primary = SM.scoreReview(model, { typeKey: 'pending_scoring', atBatIndex: 5, pendingCodes: ['os_ruling_pending_primary'] }, lookup);
  assert.equal(primary.target, 5);
  assert.equal(primary.distribution.key, 'O', 'batter out on the marker play');
  assert.equal(SM.pendingTarget({ atBatIndex: 0, pendingCodes: ['os_ruling_pending_prior'] }), null);
});

test('linkEntry: date-fallback game without the batter → mistyped-code correction (synthetic)', () => {
  const teams = [
    { id: 141, abbreviation: 'TOR', teamCode: 'tor', fileCode: 'tor' },
    { id: 108, abbreviation: 'LAA', teamCode: 'ana', fileCode: 'ana' },
    { id: 119, abbreviation: 'LAD', teamCode: 'lan', fileCode: 'la' },
  ];
  const games = [
    { gamePk: 21, awayId: 141, homeId: 108, officialDate: '2025-08-05', gameNumber: 1 },  // TOR@LAA 5 days earlier
    { gamePk: 22, awayId: 141, homeId: 119, officialDate: '2025-08-10', gameNumber: 1 },  // TOR@LAD that day
  ];
  const playsByGame = new Map([
    [21, [{ ty: 'atBat', g: 21, ai: 30, inn: 7, top: false, b: 1, bn: 'Someone Else', et: 'single' }]],
    [22, [{ ty: 'atBat', g: 22, ai: 55, inn: 7, top: false, b: 2, bn: 'Teoscar Hernández', et: 'field_error' }]],
  ]);
  const entry = {
    away: 'TOR', home: 'LAA', date: '2025-08-10', inning: 7, half: 'bottom',
    body: 'In the bottom of the 7th inning, the single for Teoscar Hernandez has been changed to an error charged to Ernie Clement.',
    cls: { final: 'error' },
  };
  const link = linkEntry(entry, { teamIndex: buildTeamIndex(teams), games, playsByGame, teamsById: new Map(teams.map((t) => [t.id, t])) });
  assert.equal(link.gamePk, 22);
  assert.equal(link.atBatIndex, 55);
  assert.deepEqual(link.flags, ['team_code_corrected:LAA->LAD']);
});

/* ---------------- live-capture models, scorer effects, error type (v2) */

test('offset logistic fit recovers a known shift and error-type effect', () => {
  const r = rng(11);
  const X = []; const y = []; const off = [];
  for (let i = 0; i < 20000; i += 1) {
    const thr = r() < 0.4 ? 1 : 0;
    const o = -2.5 + (r() - 0.5);
    X.push([thr]); off.push(o);
    y.push(r() < sigmoid(o + 0.5 - 1.0 * thr) ? 1 : 0);
  }
  const fit = fitLogisticOffset(X, y, off, { lambda: 0.01 });
  assert.ok(Math.abs(fit.intercept - 0.5) < 0.12, `shift ${fit.intercept}`);
  assert.ok(Math.abs(fit.coef[0] + 1.0) < 0.15, `throwing ${fit.coef[0]}`);
  const shrunk = fitLogisticOffset(X, y, off, { lambda: 1e6 });
  assert.ok(Math.abs(shrunk.intercept) < 0.01 && Math.abs(shrunk.coef[0]) < 0.01, 'huge penalty → no adjustment');
});

function capturedRows(n, { throwEffect = 0, shift = 0, seed = 5 } = {}) {
  const r = rng(seed);
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    const kind = r() < 0.55 ? 'fielding' : r() < 0.85 ? 'throwing' : 'missed_catch';
    const z0 = -2.6 + 1.2 * (r() - 0.5);
    const y = r() < sigmoid(z0 + shift + (kind === 'throwing' ? throwEffect : 0)) ? 1 : 0;
    rows.push({ id: `g${i}`, gamePk: 700000 + i, y, z0, kind });
  }
  return rows;
}

test('captured adjustment stays off below its data gate', () => {
  const a = capturedAdjustment(capturedRows(40));
  assert.equal(a.status, 'collecting');
  assert.equal(a.active, false);
  assert.ok(a.byKind.length > 0 && a.byKind.every((k) => k.n > 0));
  const b = capturedAdjustment([]);
  assert.equal(b.status, 'collecting');
  assert.equal(b.n, 0);
});

test('captured adjustment finds a real error-type effect and ignores a null one', () => {
  const strong = capturedAdjustment(capturedRows(6000, { throwEffect: -1.6, seed: 7 }));
  assert.equal(strong.status, 'active', JSON.stringify(strong.cv));
  assert.ok(strong.terms.includes('kind:throwing'));
  assert.ok(strong.coef[strong.terms.indexOf('kind:throwing')] < -0.5);
  const nullFx = capturedAdjustment(capturedRows(3000, { seed: 9 }));
  assert.ok(nullFx.status === 'not_selected' || (nullFx.status === 'active' && nullFx.terms.length === 0),
    `no effect → no error-type terms (${nullFx.status} ${nullFx.terms})`);
  // Browser application: active adjustment moves the score the right way.
  const spec = { terms: [], coef: [], intercept: -2.6, adjust: strong };
  const thr = SM.scoreWith(spec, {}, { errKind: 'throwing' });
  const fld = SM.scoreWith(spec, {}, { errKind: 'fielding' });
  const unk = SM.scoreWith(spec, {}, { errKind: null });
  assert.ok(thr.probability < unk.probability && unk.probability < fld.probability, 'unknown type = average effect');
  assert.ok(thr.adjustment && thr.adjustment.terms.includes('kind:throwing'));
});

test('pending calibration: collecting → leave-one-out-validated weights', () => {
  const outcomes = ['hit', 'error', 'fc', 'out', 'sac', 'other'];
  const probs = { hit: 0.4, error: 0.1, fc: 0.1, out: 0.4, sac: 0, other: 0 };
  const few = pendingCalibration([{ probs, outcome: 'error' }], outcomes);
  assert.equal(few.status, 'collecting');
  assert.equal(few.active, false);
  // Pending rulings are really hit-vs-error decisions: errors far more often
  // than comparable balls suggest → weight on "error" rises, LOO improves.
  const rows = [];
  for (let i = 0; i < 60; i += 1) rows.push({ probs, outcome: i % 2 ? 'error' : 'hit' });
  const cal = pendingCalibration(rows, outcomes);
  assert.equal(cal.status, 'active');
  assert.ok(cal.weights.error > 2 && cal.weights.out < 0.5, JSON.stringify(cal.weights));
  assert.ok(cal.metrics.calibratedLeaveOneOut.logLoss < cal.metrics.raw.logLoss);
  const t = { outcomes, calibration: cal };
  const c = SM.calibratePending(t, outcomes.map((o) => probs[o]));
  assert.equal(c.calibrated, true);
  assert.ok(Math.abs(c.p.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.ok(c.p[1] > 0.1, 'error share raised');
  // Calibration that does not help is not used.
  const fine = pendingCalibration(Array.from({ length: 50 }, (_, i) => ({ probs, outcome: ['hit', 'out', 'hit', 'out', 'error', 'fc', 'hit', 'out', 'hit', 'out'][i % 10] })), outcomes);
  assert.equal(fine.active, false, 'already calibrated → not_better');
});

test('scorer heterogeneity test: reproducible, calm under the null, sensitive to a real effect', () => {
  const make = (effect, seed) => {
    const r = rng(seed);
    const rows = [];
    for (let i = 0; i < 4000; i += 1) {
      const g = `s${Math.floor(r() * 40)}`;
      const p = 0.06;
      const bump = effect && Number(g.slice(1)) < 8 ? effect : 0;
      rows.push({ g, p, y: r() < Math.min(0.9, p * (1 + bump)) ? 1 : 0 });
    }
    return rows;
  };
  const nul = heterogeneityTest(make(0, 3), { permutations: 400 });
  const again = heterogeneityTest(make(0, 3), { permutations: 400 });
  assert.deepEqual(nul, again, 'same data + seed → same p-value');
  assert.ok(nul.pValue > 0.01, `null p ${nul.pValue}`);
  const fx = heterogeneityTest(make(2.5, 3), { permutations: 400 });
  assert.ok(fx.pValue < 0.01, `effect p ${fx.pValue}`);
  assert.ok(fx.dispersion > nul.dispersion);
  const tbl = groupTable(make(2.5, 3), (k) => `Scorer ${k}`);
  assert.ok(tbl[0].n >= tbl[tbl.length - 1].n);
  assert.ok(tbl.every((t) => t.shrunkRatio > 0));
  assert.equal(heterogeneityTest([{ g: 'a', y: 1, p: 0.1 }]).pValue, null, 'one group → no test');
});

test('scorer / error-type terms use training means when the input is unknown', () => {
  const spec = { terms: ['scorer:42'], coef: [2], intercept: -3, termMeans: { 'scorer:42': 0.25 } };
  const known = SM.scoreWith(spec, {}, { scorerId: 42 });
  const other = SM.scoreWith(spec, {}, { scorerId: 7 });
  const unknown = SM.scoreWith(spec, {}, { scorerId: null });
  assert.deepEqual([known.values[0], other.values[0], unknown.values[0]], [1, 0, 0.25]);
  assert.ok(other.probability < unknown.probability && unknown.probability < known.probability);
});

test('original error type from the official log wording (clause after "instead of" / "originally")', () => {
  // Real wording from MLB's official scoring-change log (2024 #48, 2024 #40, 2025 #189, 2026 #3).
  assert.equal(originalErrorKindFromLog('In the top of the 4th inning, Harrison Bader reaches on an infield single to third base Matt Chapman and advances to second on a throwing error by Chapman. It was originally a two-base throwing error.'), 'throwing');
  assert.equal(originalErrorKindFromLog('In the top of the 1st inning, Jurickson Profar singles on a bunt ground ball to pitcher Wade Miley, instead of reaching on a dropped throw error by first baseman Jake Bauers. As a result, the run scored by Profar is now earned to Miley.'), 'missed_catch');
  assert.equal(originalErrorKindFromLog('In the top of the 8th inning, Matt Shaw singled to center fielder Michael Harris II and advanced to second on a throwing error by Harris II, instead of a fielding error by third baseman Nacho Alvarez Jr.'), 'fielding');
  assert.equal(originalErrorKindFromLog('In the bottom of the 4th, Ozzie Albies now has a single instead of a reaching on an error charged to Max Muncy.'), 'unspecified');
  assert.equal(originalErrorKindFromLog('In the top of the 5th, the run is now unearned.'), null);
});

test('live StatsAPI play → error type flows into the model play', () => {
  const p = SM.playFromStatsApi({
    result: { eventType: 'field_error', description: 'X reaches on a fielding error by shortstop Y.' },
    about: { atBatIndex: 3, isTopInning: true },
    matchup: { batter: { id: 1 } },
    runners: [{ details: { runner: { id: 1 } }, credits: [{ credit: 'f_throwing_error', position: { abbreviation: 'SS' } }] }],
  });
  assert.equal(p.errKind, 'throwing', 'credits win over the description');
  assert.equal(SM.playFromStatsApi({ result: { eventType: 'single' } }).errKind, null);
});

test('runner-level error → error changes are recognised only with a runner error on the play', () => {
  const entry = { cls: { transition: 'error->error' } };
  assert.equal(isVerifiedRunnerErrorChange(entry, { et: 'single', cr: ['f_fielded_ball|RF|1|B', 'f_throwing_error|C|2|R'] }), true);
  assert.equal(isVerifiedRunnerErrorChange(entry, { et: 'double', cr: [], re: 1 }), true);
  assert.equal(isVerifiedRunnerErrorChange(entry, { et: 'single', cr: ['f_fielded_ball|RF|1|B'] }), false, 'no runner error → stays a mismatch');
  assert.equal(isVerifiedRunnerErrorChange(entry, { et: 'field_error', cr: ['f_throwing_error|C|2|R'] }), false, 'plate-appearance error: not this case');
  assert.equal(isVerifiedRunnerErrorChange({ cls: { transition: 'error->hit' } }, { et: 'single', re: 1 }), false);
});

console.log(`pipeline-model-test: ${passed} passed`);
