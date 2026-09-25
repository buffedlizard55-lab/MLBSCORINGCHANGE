// Session 5 — error events + stat effects on REAL data (no network).
//
// Fixture: tools/fixtures/statsapi-823736-pbp-ab6-7.json — verbatim StatsAPI
// play-by-play of CIN @ MIL, 2026-09-11 (gamePk 823736), at-bats 6 and 7.
// Official log entry (2026 #249, verbatim from
// https://www.mlb.com/official-information/scoring-changes):
//   "In the bottom of the 1st, following the double for Andrew Vaughn, an
//    error has been charged to JJ Bleday for allowing Brice Turang to score.
//    As a result, Vaughn loses an RBI and 1 run is changed to unearned
//    against Andrew Abbott."
// This is the user's own example in the session-5 charter (README).
// Video evidence (manual review):
//   https://baseballsavant.mlb.com/sporty-videos?playId=8552c454-1f49-3d56-a8cc-b6fd75ccb380
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractGamePlays, ERROR_CREDIT_RE } from '../pipeline/lib/statsapi.mjs';
import {
  buildErrorEvents, errorScope, errorKindOfCredit, savantVideoUrl, gameScanRow,
} from '../pipeline/lib/error-events.mjs';
import { statEffects } from '../pipeline/lib/stat-effects.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pbp = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/fixtures/statsapi-823736-pbp-ab6-7.json'), 'utf8'));
let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log(`  ok  ${name}`); };

const plays = extractGamePlays(pbp, 823736);
const ab6 = plays.find((p) => p.ai === 6);
const ab7 = plays.find((p) => p.ai === 7);

t('extract: at-bat 6 (Contreras sac fly) — earned run, video id', () => {
  assert.ok(ab6);
  assert.equal(ab6.et, 'sac_fly');
  assert.equal(ab6.vid, '080ce3c7-9089-3fe6-b525-adccb3c4b4c5');
  assert.equal(ab6.er, 1);
  assert.equal(ab6.ur, undefined);
  assert.equal(ab6.errs, undefined, 'no error on the play → no errs field');
});

t('extract: at-bat 7 (Vaughn double) — Bleday error on Turang, unearned run', () => {
  assert.ok(ab7);
  assert.equal(ab7.et, 'double');
  assert.equal(ab7.bn, 'Andrew Vaughn');
  assert.equal(ab7.pn, 'Andrew Abbott');
  assert.equal(ab7.b, 683734);
  assert.equal(ab7.p, 671096);
  assert.equal(ab7.vid, '8552c454-1f49-3d56-a8cc-b6fd75ccb380');
  assert.equal(ab7.rbi, 0, 'StatsAPI now shows 0 RBI (Vaughn lost it)');
  assert.equal(ab7.ur, 1);
  assert.equal(ab7.tu, 1, 'Turang\'s run is also team-unearned');
  assert.equal(ab7.er, undefined);
  assert.equal(ab7.errs.length, 1);
  const x = ab7.errs[0];
  assert.equal(x.k, 'f_fielding_error');
  assert.equal(x.pos, 'LF');
  assert.equal(x.f, 668709, 'JJ Bleday');
  assert.equal(x.rn, 'Brice Turang');
  assert.equal(x.b, 0, 'the error was on a runner, not the batter');
});

t('ERROR_CREDIT_RE matches every error credit code seen in 3 seasons, and nothing else', () => {
  for (const c of ['f_throwing_error', 'f_fielding_error', 'f_error_dropped_ball', 'c_catcher_interf', 'f_defensive_shift_violation_error']) assert.ok(ERROR_CREDIT_RE.test(c), c);
  for (const c of ['f_putout', 'f_assist', 'f_fielded_ball', 'f_deflection', 'f_touch']) assert.ok(!ERROR_CREDIT_RE.test(c), c);
});

t('error kinds and scope', () => {
  assert.equal(errorKindOfCredit('f_throwing_error'), 'throwing');
  assert.equal(errorKindOfCredit('f_fielding_error'), 'fielding');
  assert.equal(errorScope(ab7), 'on_hit');
  assert.equal(errorScope({ et: 'field_error' }), 'batter_reached');
  assert.equal(errorScope({ et: 'single' }, true), 'batter_reached', 'a play originally ruled an error stays batter_reached after a change');
  assert.equal(errorScope({ et: 'strikeout' }), 'other');
  assert.equal(savantVideoUrl(ab7.vid), 'https://baseballsavant.mlb.com/sporty-videos?playId=8552c454-1f49-3d56-a8cc-b6fd75ccb380');
  assert.equal(savantVideoUrl(null), null);
});

const game = { gamePk: 823736, officialDate: '2026-09-11', gameType: 'R', awayId: 113, homeId: 158 };
const abbr = new Map([[113, 'CIN'], [158, 'MIL']]);
const raw249 = '249. 9/11 CIN@MIL -- In the bottom of the 1st, following the double for Andrew Vaughn, an error has been charged to JJ Bleday for allowing Brice Turang to score. As a result, Vaughn loses an RBI and 1 run is changed to unearned against Andrew Abbott.';

t('buildErrorEvents: the Bleday error is logged with its video, official entry and runs', () => {
  const officialByPlay = new Map([['823736:7', [{ seq: 249, kind: 'error_added', transition: null, flags: ['battingStat', 'pitchingStat'], raw: raw249 }]]]);
  const { games, events } = buildErrorEvents({ games: [game], playsByGame: new Map([[823736, plays]]), abbr, officialByPlay });
  assert.equal(games.length, 1);
  assert.deepEqual(games[0], { gamePk: 823736, date: '2026-09-11', gameType: 'R', away: 'CIN', home: 'MIL', scanned: true, pas: 2, errorPlays: 1, errors: 1 });
  assert.equal(events.length, 1, 'only the error play is an event');
  const ev = events[0];
  assert.equal(ev.id, '823736:7');
  assert.equal(ev.scope, 'on_hit');
  assert.equal(ev.vid, '8552c454-1f49-3d56-a8cc-b6fd75ccb380');
  assert.equal(ev.half, 'bottom');
  assert.equal(ev.inning, 1);
  assert.equal(ev.pitcher, 'Andrew Abbott');
  assert.equal(ev.ur, 1);
  assert.equal(ev.tu, 1);
  assert.equal(ev.rbi, 0);
  assert.equal(ev.errors[0].kind, 'fielding');
  assert.equal(ev.errors[0].runner, 'Brice Turang');
  assert.equal(ev.official[0].seq, 249);
  assert.equal(ev.model, null, 'on-hit errors are not scored by the batter-reached model');
  assert.equal(ev.status, null);
});

t('gameScanRow: a game whose play-by-play is missing is listed as NOT scanned', () => {
  const r = gameScanRow(game, null, abbr);
  assert.equal(r.scanned, false);
  assert.equal(r.pas, 0);
  const { games, events } = buildErrorEvents({ games: [game], playsByGame: new Map(), abbr });
  assert.equal(games[0].scanned, false);
  assert.equal(events.length, 0);
});

t('statEffects on 2026 #249 with the linked play: batting RBI −1 (Vaughn); pitching ER −1 / UER +1 (Abbott)', () => {
  const body = raw249.replace(/^249\. 9\/11 CIN@MIL -- /, '');
  const s = statEffects({ body, cls: { kind: 'error_added', flags: [] } }, {
    batterName: ab7.bn, batterId: ab7.b, pitcherName: ab7.pn, pitcherId: ab7.p, currentEventType: ab7.et,
  });
  assert.deepEqual(s.unparsed, []);
  assert.equal(s.battingChange, true);
  assert.equal(s.pitchingChange, true);
  const rbi = s.batting.filter((d) => d.stat === 'RBI');
  assert.equal(rbi.length, 1);
  assert.equal(rbi[0].delta, -1);
  assert.equal(rbi[0].player, 'Andrew Vaughn');
  assert.ok(!s.batting.some((d) => d.stat === 'H'), 'the double stands — no hit change');
  const er = s.pitching.find((d) => d.stat === 'ER');
  const uer = s.pitching.find((d) => d.stat === 'UER');
  assert.equal(er.delta, -1);
  assert.equal(uer.delta, 1);
  assert.equal(er.player, 'Andrew Abbott');
  assert.equal(uer.player, 'Andrew Abbott');
  assert.equal(ab7.rbi + 1, 1, 'consistent with StatsAPI: 0 RBI now, 1 before the change');
});

console.log(`error-events-test: ${passed} passed`);
