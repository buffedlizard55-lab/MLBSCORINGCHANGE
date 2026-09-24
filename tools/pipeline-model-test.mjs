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
  normalizeName, findNameInText, rulingAgrees, buildTeamIndex, candidateGames, linkEntry, levenshtein,
} from '../pipeline/lib/link.mjs';
import {
  buildHitProbSurface, buildHitProbFallback, buildPendingTable, selectAndFit,
} from '../pipeline/lib/model-build.mjs';
import { parseCSV } from '../pipeline/lib/csv.mjs';

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

console.log(`pipeline-model-test: ${passed} passed`);
