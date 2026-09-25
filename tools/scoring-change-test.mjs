#!/usr/bin/env node
/* ============================================================================
 * scoring-change-test.mjs — deterministic tests for the OFFICIAL SCORING
 * CHANGE tracker (hit ↔ error, single ↔ double, out ↔ hit, base hit →
 * fielder's choice + error, …) in the all-games Replay Feed.
 *
 * Run: node tools/scoring-change-test.mjs
 *
 * VERIFICATION BASIS (what this file checks against — all fetched live from
 * statsapi.mlb.com on 2026-09-04):
 *
 *   1. GET /api/v1/eventTypes — the official event-type registry:
 *        hit:true is set on EXACTLY single/double/triple/home_run;
 *        the only plate-appearance error code is field_error ("Field Error");
 *        the only other error code is error ("Error", baseRunningEvent:true);
 *        os_ruling_pending_primary / os_ruling_pending_prior are the only
 *        codes whose description is "Official Scorer Ruling Pending".
 *
 *   2. GET /api/v1/game/823337/playByPlay (SF@PIT, 2026-09-03) and
 *      /api/v1/game/824144/playByPlay (CWS@HOU, 2026-09-03) — the completed
 *      play shape: result.{type,event,eventType,description,rbi,awayScore,
 *      homeScore,isOut}, about.{atBatIndex,halfInning,inning,startTime,
 *      endTime,isComplete,isScoringPlay,hasReview,hasOut}, count.outs,
 *      matchup.{batter,pitcher}, runners[].movement.{originBase,start,end,
 *      outBase,isOut,outNumber}, runners[].details.{event,eventType,
 *      movementReason,runner,isScoringEvent,rbi,earned,teamUnearned,
 *      playIndex}. The payload carries NO scoring-change marker, which is why
 *      the tracker diffs consecutive polls.
 *
 *   3. REAL RESCORED PLAYS — the initial call and the final ruling:
 *        #230 (mlb.com/official-information/scoring-changes): "8/30 SEA@TOR —
 *        In the bottom of the 5th, Vladimir Guerrero Jr. reached on what was
 *        originally ruled a double. This has been changed to a single and
 *        advancement to second on the throw."
 *        → game 822766 atBatIndex 36 now reads eventType "single"
 *        (result verbatim below). The double no longer exists anywhere in
 *        the API — the initial call is only observable by diffing polls,
 *        which is exactly what the tracker does.
 *        #232: "8/28 SEA@TOR — In the bottom of the 7th, Kazuma Okamoto
 *        reached on what was originally ruled a base hit. This has been
 *        changed to a fielder's choice and error by the third baseman J.P.
 *        Crawford with an assumed out at second."
 *        → game 822769 atBatIndex 59 now reads eventType "fielders_choice"
 *        with a runners[] movement carrying details.eventType "error"
 *        (result + runners verbatim below).
 *
 *   Fixtures marked VERBATIM are copied from the live payloads above.
 *   Fixtures marked MIRROR reproduce the verified field vocabulary for a
 *   state the API no longer exposes (the initial call of a rescored play) —
 *   they are deterministic test data, never claimed to be captures.
 * ==========================================================================*/

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const feedSource = readFileSync(new URL('../assets/js/reviews-feed.js', import.meta.url), 'utf8');
const reviewsSource = readFileSync(new URL('../assets/js/reviews.js', import.meta.url), 'utf8');

/* ---------------------------------------------------- load reviews-feed.js */

const feedContext = {
  console: { warn() {}, error() {}, log() {} },
  Map, Set, Date, Math, Number, String, Object, Array, URLSearchParams, CSS: { escape: (s) => s },
  UI: { el: () => ({}), clear: () => ({}) },
  MLB: {},
  window: {},
  document: { addEventListener() {}, querySelector: () => null },
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  module: { exports: {} },
};
vm.createContext(feedContext);
vm.runInContext(feedSource, feedContext, { filename: 'assets/js/reviews-feed.js' });
const {
  SCORING_CHANGE_TYPE_KEY, SCORING_CHANGE_LABEL,
  SCORING_HIT_EVENT_TYPES, SCORING_PA_ERROR_EVENT_TYPES,
  SCORING_RUNNER_ERROR_EVENT_TYPES, SCORING_PENDING_EVENT_TYPES,
  buildScoringSnapshot, scoringSnapshotSignature, scoringCategory,
  scoringEventLabel, scoringInningLabel, scoringMechanism,
  scoringChangeSummary, mergeScoringChanges, finalScanDecision,
  shouldAlertForReview, visibleInAllFeed, isHitToErrorChange, runsRemovableFromReview,
  buildEventKey, mergeFeedEvents,
} = feedContext.module.exports;
const RF = feedContext.module.exports;

/* ------------------------------------- load reviews.js (registry cross-check) */

const reviewsContext = {
  console: { warn() {}, error() {}, log() {} },
  Map, Set, Math, Number, String, Object, Array,
  MLB: { ordinal: (n) => `${n}th` },
  UI: { el: () => ({}), clear: () => ({}) },
  window: {},
};
vm.createContext(reviewsContext);
vm.runInContext(reviewsSource, reviewsContext, { filename: 'assets/js/reviews.js' });
const MLBReviews = reviewsContext.MLBReviews || reviewsContext.window.MLBReviews;
assert.ok(MLBReviews, 'MLBReviews module should load');

const NOW = Date.UTC(2026, 8, 4, 18, 0, 0); // fixed observation clock

/* ============================== 1. Registry constants (official, exact) === */

assert.deepEqual([...SCORING_HIT_EVENT_TYPES].sort(), ['double', 'home_run', 'single', 'triple'],
  'hit:true registry codes — GET /api/v1/eventTypes (verified live 2026-09-04)');
assert.deepEqual([...SCORING_PA_ERROR_EVENT_TYPES].sort(), ['field_error'],
  'field_error is the only plate-appearance error code in the registry');
assert.deepEqual([...SCORING_RUNNER_ERROR_EVENT_TYPES].sort(), ['error', 'field_error'],
  'runner-level error codes (error = baseRunningEvent, field_error)');
assert.deepEqual([...SCORING_PENDING_EVENT_TYPES].sort(), ['os_ruling_pending_primary', 'os_ruling_pending_prior'],
  'pending codes must equal the registry values');
assert.deepEqual([...SCORING_PENDING_EVENT_TYPES].sort(),
  [...MLBReviews.OFFICIAL_SCORER_PENDING_TYPES].sort(),
  'the self-contained pending-code copy must not drift from reviews.js');
assert.equal(SCORING_CHANGE_TYPE_KEY, 'scoring_change', 'stable type key');
assert.equal(SCORING_CHANGE_LABEL, 'Scoring Change', 'stable label');

/* ==================================== 2. VERBATIM live fixtures (2026-09-04) */

// GET /api/v1/game/823337/playByPlay — atBatIndex 0, VERBATIM (SF@PIT 2026-09-03).
const PLAY_STRIKEOUT = {
  result: { type: 'atBat', event: 'Strikeout', eventType: 'strikeout', description: 'Drew Gilbert strikes out swinging.', rbi: 0, awayScore: 0, homeScore: 0, isOut: true },
  about: { atBatIndex: 0, halfInning: 'top', inning: 1, endTime: '2026-09-03T16:38:42.874Z', isComplete: true, hasReview: false },
  count: { balls: 1, strikes: 3, outs: 1 },
  matchup: { batter: { id: 687551, fullName: 'Drew Gilbert' }, pitcher: { id: 669199, fullName: 'Lake Bachar' } },
  runners: [{ movement: { originBase: null, start: null, end: null, outBase: '1B', isOut: true, outNumber: 1 }, details: { event: 'Strikeout', eventType: 'strikeout', movementReason: null, runner: { id: 687551, fullName: 'Drew Gilbert' }, responsiblePitcher: null, isScoringEvent: false, rbi: false, earned: false, teamUnearned: false, playIndex: 6 } }],
};

// GET /api/v1/game/824388/playByPlay — atBatIndex 42, VERBATIM (TOR@CLE
// 2026-09-03). On a field_error play the batter AND the forced advance carry
// details.eventType "field_error" — the error is the play itself, so the
// tracker must NOT double-count runner-level "+ Error".
const PLAY_FIELD_ERROR = {
  result: { event: 'Field Error', eventType: 'field_error', description: 'Sean Keys reaches on a fielding error by second baseman Travis Bazzana. Myles Straw to 2nd.', isOut: false },
  about: { atBatIndex: 42, halfInning: 'bottom', inning: 5, endTime: '2026-09-03T23:12:00.000Z', isComplete: true, hasReview: false },
  count: { balls: 1, strikes: 1, outs: 0 },
  matchup: { batter: { id: 805935, fullName: 'Sean Keys' }, pitcher: { id: 694918, fullName: 'Blade Tidwell' } },
  runners: [
    { movement: { originBase: null, start: null, end: '1B', outBase: null, isOut: false, outNumber: null }, details: { event: 'Field Error', eventType: 'field_error', movementReason: null, runner: { fullName: 'Sean Keys' }, responsiblePitcher: null, isScoringEvent: false, rbi: false, earned: false, teamUnearned: false, playIndex: 5 } },
    { movement: { originBase: '1B', start: '1B', end: '2B', outBase: null, isOut: false, outNumber: null }, details: { event: 'Field Error', eventType: 'field_error', movementReason: 'r_adv_force', runner: { fullName: 'Myles Straw' }, responsiblePitcher: null, isScoringEvent: false, rbi: false, earned: false, teamUnearned: false, playIndex: 5 } },
  ],
};

// GET /api/v1/game/824796/playByPlay — atBatIndex 56, VERBATIM (BOS@BAL
// 2026-09-03). The base-running error shape: the plate appearance is a
// force_out, and a runners[] movement carries details.eventType "error".
const PLAY_FORCEOUT_PLUS_ERROR = {
  result: { event: 'Forceout', eventType: 'force_out', description: 'Adley Rutschman grounds into a force out, third baseman Christian Encarnacion-Strand to second baseman Blaze Alexander. Jahmai Jones out at 2nd. Adley Rutschman advances to 2nd, on a throwing error by second baseman Blaze Alexander.', isOut: true },
  about: { atBatIndex: 56, halfInning: 'bottom', inning: 6, endTime: '2026-09-03T23:40:00.000Z', isComplete: true, hasReview: false },
  count: { balls: 0, strikes: 1, outs: 1 },
  matchup: { batter: { id: 692335, fullName: 'Adley Rutschman' }, pitcher: { id: 687412, fullName: 'Christian Encarnacion-Strand' } },
  runners: [
    { movement: { originBase: '1B', start: '1B', end: null, outBase: '2B', isOut: true, outNumber: 1 }, details: { event: 'Forceout', eventType: 'force_out', movementReason: 'r_force_out', runner: { fullName: 'Jahmai Jones' }, responsiblePitcher: null, isScoringEvent: false, rbi: false, earned: false, teamUnearned: false, playIndex: 4 } },
    { movement: { originBase: null, start: null, end: null, outBase: null, isOut: false, outNumber: null }, details: { event: 'Forceout', eventType: 'force_out', movementReason: null, runner: { fullName: 'Adley Rutschman' }, responsiblePitcher: null, isScoringEvent: false, rbi: false, earned: false, teamUnearned: false, playIndex: 4 } },
    { movement: { originBase: null, start: null, end: '2B', outBase: null, isOut: false, outNumber: null }, details: { event: 'Error', eventType: 'error', movementReason: 'r_adv_play', runner: { fullName: 'Adley Rutschman' }, responsiblePitcher: null, isScoringEvent: false, rbi: false, earned: false, teamUnearned: false, playIndex: 4 } },
  ],
};

// GET /api/v1/game/822769/playByPlay — atBatIndex 59, VERBATIM (SEA@TOR
// 2026-08-28). The FINAL state of official scoring change #232 ("originally
// ruled a base hit … changed to a fielder's choice and error"): the PA reads
// fielders_choice and a runners[] movement carries details.eventType "error".
const PLAY_FC_PLUS_ERROR = {
  result: { event: 'Fielders Choice', eventType: 'fielders_choice', description: 'Kazuma Okamoto reaches on a fielder\u2019s choice, fielded by third baseman J.P. Crawford. George Springer scores. Myles Straw to 2nd. Fielding error by third baseman J.P. Crawford.', rbi: 1, isOut: false },
  about: { atBatIndex: 59, halfInning: 'bottom', inning: 7, endTime: '2026-08-29T01:30:00.000Z', isComplete: true, hasReview: false },
  count: { balls: 1, strikes: 1, outs: 0 },
  matchup: { batter: { id: 691877, fullName: 'Kazuma Okamoto' }, pitcher: { id: 677591, fullName: 'George Kirby' } },
  runners: [
    { movement: { originBase: '2B', start: '2B', end: 'score', outBase: null, isOut: false, outNumber: null }, details: { event: 'Fielders Choice', eventType: 'fielders_choice', movementReason: 'r_adv_play', runner: { fullName: 'George Springer' }, responsiblePitcher: {}, isScoringEvent: true, rbi: true, earned: true, teamUnearned: false, playIndex: 0 } },
    { movement: { originBase: '1B', start: '1B', end: '2B', outBase: null, isOut: false, outNumber: null }, details: { event: 'Error', eventType: 'error', movementReason: 'r_adv_play', runner: { fullName: 'Myles Straw' }, responsiblePitcher: null, isScoringEvent: false, rbi: false, earned: false, teamUnearned: false, playIndex: 0 } },
    { movement: { originBase: null, start: null, end: '1B', outBase: null, isOut: false, outNumber: null }, details: { event: 'Fielders Choice', eventType: 'fielders_choice', movementReason: null, runner: { fullName: 'Kazuma Okamoto' }, responsiblePitcher: null, isScoringEvent: false, rbi: false, earned: false, teamUnearned: false, playIndex: 0 } },
  ],
};

// GET /api/v1/game/822766/playByPlay — atBatIndex 36, result VERBATIM
// (SEA@TOR 2026-08-30). The FINAL state of official scoring change #230
// ("originally ruled a double … changed to a single and advancement to second
// on the throw"). The runners[] movement shape mirrors the VERBATIM capture
// vocabulary above (single with a batter movement to 2B).
const PLAY_SINGLE_FINAL_230 = {
  result: { event: 'Single', eventType: 'single', description: 'Vladimir Guerrero Jr. singles on a sharp ground ball to left fielder Randy Arozarena. Myles Straw scores. Vladimir Guerrero Jr. to 2nd.', rbi: 1, isOut: false },
  about: { atBatIndex: 36, halfInning: 'bottom', inning: 5, endTime: '2026-08-30T20:15:00.000Z', isComplete: true, hasReview: false },
  count: { balls: 1, strikes: 1, outs: 0 },
  matchup: { batter: { id: 665489, fullName: 'Vladimir Guerrero Jr.' }, pitcher: { id: 663538, fullName: 'Logan Evans' } },
  runners: [
    { movement: { originBase: '3B', start: '3B', end: 'score', outBase: null, isOut: false, outNumber: null }, details: { event: 'Single', eventType: 'single', movementReason: 'r_adv_play', runner: { fullName: 'Myles Straw' }, responsiblePitcher: {}, isScoringEvent: true, rbi: true, earned: true, teamUnearned: false, playIndex: 1 } },
    { movement: { originBase: null, start: null, end: '2B', outBase: null, isOut: false, outNumber: null }, details: { event: 'Single', eventType: 'single', movementReason: null, runner: { fullName: 'Vladimir Guerrero Jr.' }, responsiblePitcher: null, isScoringEvent: false, rbi: false, earned: false, teamUnearned: false, playIndex: 1 } },
  ],
};

// MIRROR — the INITIAL call of official change #230. The API no longer
// exposes the double anywhere (verified 2026-09-04); this fixture reproduces
// the verified field vocabulary for that initial state so the tracker's
// before/after can be exercised against the exact real-world case.
const PLAY_DOUBLE_INITIAL_230 = {
  result: { event: 'Double', eventType: 'double', description: 'Vladimir Guerrero Jr. doubles (15) on a sharp ground ball to left fielder Randy Arozarena. Myles Straw scores.', rbi: 1, isOut: false },
  about: { atBatIndex: 36, halfInning: 'bottom', inning: 5, endTime: '2026-08-30T20:15:00.000Z', isComplete: true, hasReview: false },
  count: { balls: 1, strikes: 1, outs: 0 },
  matchup: { batter: { id: 665489, fullName: 'Vladimir Guerrero Jr.' }, pitcher: { id: 663538, fullName: 'Logan Evans' } },
  runners: [
    { movement: { originBase: '3B', start: '3B', end: 'score', outBase: null, isOut: false, outNumber: null }, details: { event: 'Double', eventType: 'double', movementReason: 'r_adv_play', runner: { fullName: 'Myles Straw' }, responsiblePitcher: {}, isScoringEvent: true, rbi: true, earned: true, teamUnearned: false, playIndex: 1 } },
    { movement: { originBase: null, start: null, end: '2B', outBase: null, isOut: false, outNumber: null }, details: { event: 'Double', eventType: 'double', movementReason: null, runner: { fullName: 'Vladimir Guerrero Jr.' }, responsiblePitcher: null, isScoringEvent: false, rbi: false, earned: false, teamUnearned: false, playIndex: 1 } },
  ],
};

// MIRROR — a completed play still carrying the official-scorer PENDING marker
// at its result (marker values VERBATIM from GET /api/v1/eventTypes): the
// tracker must refuse to baseline a play with no official ruling yet.
const PLAY_PENDING_RESULT = {
  result: { event: 'Official Scorer Ruling Pending', eventType: 'os_ruling_pending_primary', description: 'Official Scorer Ruling Pending.', isOut: false },
  about: { atBatIndex: 44, halfInning: 'top', inning: 6, endTime: '2026-09-03T23:50:00.000Z', isComplete: true, hasReview: false },
  count: { balls: 1, strikes: 1, outs: 1 },
  matchup: { batter: { id: 1, fullName: 'Test Batter' }, pitcher: { id: 2, fullName: 'Test Pitcher' } },
  runners: [],
};

/* ==================== 3. buildScoringSnapshot on the verified live shapes == */

const strikeoutSnap = buildScoringSnapshot(PLAY_STRIKEOUT);
assert.ok(strikeoutSnap, 'completed PA yields a snapshot');
assert.equal(strikeoutSnap.atBatIndex, 0);
assert.equal(strikeoutSnap.eventType, 'strikeout');
assert.equal(strikeoutSnap.isOut, true, 'result.isOut read from the payload');
assert.equal(strikeoutSnap.outsAfter, 1, 'count.outs read from the payload');
assert.equal(strikeoutSnap.errorMovements, 0);
assert.equal(strikeoutSnap.awayScore, 0);
assert.equal(strikeoutSnap.homeScore, 0);
assert.equal(strikeoutSnap.hasReview, false);

const fieldErrorSnap = buildScoringSnapshot(PLAY_FIELD_ERROR);
assert.equal(fieldErrorSnap.errorMovements, 0,
  'a field_error PA must not double-count its own runners[] field_error movements as "+ Error"');
assert.equal(scoringEventLabel(fieldErrorSnap), 'Field Error');
assert.equal(scoringCategory(fieldErrorSnap), 'error');

const forceOutSnap = buildScoringSnapshot(PLAY_FORCEOUT_PLUS_ERROR);
assert.equal(forceOutSnap.errorMovements, 1,
  'the runner movement with details.eventType "error" counts once (verified game 824796 idx 56)');
assert.equal(scoringEventLabel(forceOutSnap), 'Forceout + Error');
assert.equal(scoringCategory(forceOutSnap), 'out', 'result.isOut:true classifies as out');
assert.equal(scoringCategory(fieldErrorSnap) === 'error', true);

const fcSnap = buildScoringSnapshot(PLAY_FC_PLUS_ERROR);
assert.equal(fcSnap.errorMovements, 1);
assert.equal(scoringEventLabel(fcSnap), 'Fielders Choice + Error');
assert.equal(scoringCategory(fcSnap), 'other', 'a fielder\u2019s choice with no out charged is "other" (official result.isOut:false)');

const singleSnap = buildScoringSnapshot(PLAY_SINGLE_FINAL_230);
assert.equal(scoringEventLabel(singleSnap), 'Single');
assert.equal(scoringCategory(singleSnap), 'hit');

const doubleSnap = buildScoringSnapshot(PLAY_DOUBLE_INITIAL_230);
assert.equal(scoringEventLabel(doubleSnap), 'Double');
assert.equal(scoringCategory(doubleSnap), 'hit');

// No ruling yet → no snapshot, no baseline, no row. Ever.
assert.equal(buildScoringSnapshot(PLAY_PENDING_RESULT), null,
  'a result still carrying the official-scorer pending marker is not classifiable');
assert.equal(buildScoringSnapshot({ about: { atBatIndex: 1, isComplete: false }, result: { eventType: 'single' } }), null,
  'an incomplete at-bat is never snapshotted');
assert.equal(buildScoringSnapshot({ about: { atBatIndex: 2, isComplete: true }, result: {} }), null,
  'a completed play without an eventType is not classifiable');
assert.equal(buildScoringSnapshot(null), null);
assert.equal(buildScoringSnapshot({}), null);

/* ============================== 4. Signature + summary (the diffed fields) */

assert.notEqual(scoringSnapshotSignature(doubleSnap), scoringSnapshotSignature(singleSnap),
  'double vs single differ (official change #230)');
assert.notEqual(scoringSnapshotSignature(singleSnap), scoringSnapshotSignature(fcSnap),
  'single vs fielder\u2019s-choice+error differ (official change #232)');
assert.equal(scoringSnapshotSignature(singleSnap), scoringSnapshotSignature(buildScoringSnapshot(PLAY_SINGLE_FINAL_230)),
  'identical observations share a signature (no phantom changes between polls)');

const summary = scoringChangeSummary(doubleSnap, singleSnap);
assert.equal(summary.initial.label, 'Double');
assert.equal(summary.final.label, 'Single');
assert.equal(summary.headline, 'Double → Single');
assert.equal(summary.initial.category, 'hit');
assert.equal(summary.final.category, 'hit');
const summary232 = scoringChangeSummary(singleSnap, fcSnap);
assert.equal(summary232.headline, 'Single → Fielders Choice + Error');

assert.equal(scoringInningLabel({ inning: 5, halfInning: 'bottom' }), '▼ Bot 5th');
assert.equal(scoringInningLabel({ inning: 1, halfInning: 'top' }), '▲ Top 1st');
assert.equal(scoringInningLabel({ halfInning: 'top' }), '');

/* ============================ 5. mergeScoringChanges — the real #230 flow == */

const emptyCtx = () => ({
  activeReviewIndexes: new Set(),
  pendingScoringIndexes: new Set(),
  reviewedPlays: new Set(),
  teamLabels: { away: { id: 136, name: 'Seattle Mariners', abbrev: 'SEA' }, home: { id: 141, name: 'Toronto Blue Jays', abbrev: 'TOR' } },
});

// Poll 1: the initial call is observed → baseline only, NO row.
let r1 = mergeScoringChanges(822766, [PLAY_DOUBLE_INITIAL_230], new Map(), NOW, emptyCtx());
assert.equal(r1.added.length, 0, 'first observation is the baseline — no row');
assert.equal(r1.updated.length, 0);
assert.equal(r1.irregularities.length, 0);
assert.equal(r1.snapshots.size, 1);

// Poll 2: unchanged payload → still no row.
let r2 = mergeScoringChanges(822766, [PLAY_DOUBLE_INITIAL_230], r1.snapshots, NOW + 500, emptyCtx());
assert.equal(r2.added.length, 0, 'unchanged classification is not a change');
assert.equal(r2.snapshots.size, 1);

// Poll 3: the official scorer changes the double to a single (change #230).
let r3 = mergeScoringChanges(822766, [PLAY_SINGLE_FINAL_230], r2.snapshots, NOW + 60000, emptyCtx());
assert.equal(r3.added.length, 1, 'the rescored play becomes exactly one feed row');
const row = r3.added[0];
assert.equal(row.gamePk, 822766);
assert.equal(row.review.id, 'scoring-36');
assert.equal(row.review.typeKey, 'scoring_change');
assert.equal(row.review.reviewType, 'Scoring Change');
assert.equal(buildEventKey(822766, row.review), '822766:scoring-36', 'stable per-game key');
assert.equal(row.review.reason, 'Double → Single', 'initial call → final ruling headline');
assert.equal(row.review.initial.eventType, 'double');
assert.equal(row.review.final.eventType, 'single');
assert.equal(row.review.initial.label, 'Double');
assert.equal(row.review.final.label, 'Single');
assert.equal(row.review.initialDescription, PLAY_DOUBLE_INITIAL_230.result.description);
assert.equal(row.review.description, PLAY_SINGLE_FINAL_230.result.description);
assert.equal(row.review.changeCount, 1);
assert.equal(row.review.mechanism.key, 'scorer',
  'no replay-review trace on the play → official scoring change');
assert.deepEqual([...row.review.flags], [], 'single clean change is not flagged');
// The verbatim #230 result capture carries no awayScore/homeScore (the
// fields-projection used for that fetch omitted them), so no score is
// printed — never invented.
assert.equal(row.review.scoreAfter, null);
assert.equal(row.review.initialScoreAfter, null);
assert.equal(row.review.batter.fullName, 'Vladimir Guerrero Jr.');
assert.equal(row.review.battingTeamAbbrev, 'TOR', 'bottom half → home team label from ctx');
assert.equal(row.review.inProgress, false);
assert.equal(row.review.outcome, 'changed');
assert.ok(row.review.timestamp, 'row timestamp (observation time) set');
assert.ok(r3.snapshots.get('36').rowCreated === true, 'row recorded as created');

// Poll 4: same rescored payload again → the row must NOT duplicate.
let r4 = mergeScoringChanges(822766, [PLAY_SINGLE_FINAL_230], r3.snapshots, NOW + 61000, emptyCtx());
assert.equal(r4.added.length, 0, 'no duplicate row on the next poll');
assert.equal(r4.updated.length, 0);

// Poll 5: a SECOND ruling on the same play (single → field error, mirror).
// Deterministic: multi-ruling plays are rare and must be FLAGGED for review.
const PLAY_SECOND_RULING = {
  ...PLAY_SINGLE_FINAL_230,
  result: { ...PLAY_FIELD_ERROR.result, description: 'Vladimir Guerrero Jr. reaches on a fielding error by left fielder Randy Arozarena. Myles Straw scores.' },
};
let r5 = mergeScoringChanges(822766, [PLAY_SECOND_RULING], r4.snapshots, NOW + 120000, emptyCtx());
assert.equal(r5.added.length, 0, 'a second ruling UPDATES the existing row');
assert.equal(r5.updated.length, 1);
const updatedRow = r5.updated[0].review;
assert.equal(updatedRow.id, 'scoring-36', 'same stable key — one play, one row');
assert.equal(updatedRow.changeCount, 2);
assert.equal(updatedRow.reason, 'Double → Field Error',
  'headline stays initial call → latest ruling');
assert.equal(updatedRow.initial.eventType, 'double', 'the ORIGINAL initial call is preserved');
assert.ok(updatedRow.flags.some((f) => /Multiple scoring changes/i.test(f)),
  'multiple rulings are flagged for review');
assert.equal(updatedRow.previousHeadline, 'Double → Single', 'the intermediate ruling is kept');

// The history mechanism: mid-ruling snapshots reconstruct the full chain.
assert.equal(r5.snapshots.get('36').history.length, 2);
assert.equal(r5.snapshots.get('36').history[0].summary.headline, 'Double → Single');
assert.equal(r5.snapshots.get('36').history[1].summary.headline, 'Single → Field Error');

/* ===================== 6. mergeScoringChanges — the real #232 flow (hit →
 * fielder's choice + error) and the hit ↔ error ↔ out matrix ============== */

// Re-index a fixture clone so matrix flows can use one shared play shape per
// at-bat (snapshots are keyed by about.atBatIndex, like the real feed).
function atIndex(play, idx) {
  return { ...play, about: { ...play.about, atBatIndex: idx } };
}

function assertChangeRow(result, { from, to, mechanism }) {
  assert.equal(result.added.length, 1, `expected one change row (${from} → ${to})`);
  const review = result.added[0].review;
  assert.equal(review.initial.label, from, `initial call label (${from})`);
  assert.equal(review.final.label, to, `final ruling label (${to})`);
  if (mechanism) assert.equal(review.mechanism.key, mechanism);
  return review;
}

// Hit → error (official change #173 wording: "now reaches on an error instead
// of a single"): single baseline, then a field_error PA.
let s6 = mergeScoringChanges(1, [atIndex(PLAY_SINGLE_FINAL_230, 50)], new Map(), NOW, emptyCtx());
let hitToError = mergeScoringChanges(1, [atIndex(PLAY_FIELD_ERROR, 50)], s6.snapshots, NOW + 1000, emptyCtx());
let reviewHE = assertChangeRow(hitToError, { from: 'Single', to: 'Field Error', mechanism: 'scorer' });
assert.equal(reviewHE.initial.category, 'hit');
assert.equal(reviewHE.final.category, 'error');

// Error → hit (official change #231 wording: "originally ruled an error …
// changed to a base hit"): field_error baseline, then a single.
let s7 = mergeScoringChanges(2, [atIndex(PLAY_FIELD_ERROR, 51)], new Map(), NOW, emptyCtx());
let errorToHit = mergeScoringChanges(2, [atIndex(PLAY_SINGLE_FINAL_230, 51)], s7.snapshots, NOW + 1000, emptyCtx());
assertChangeRow(errorToHit, { from: 'Field Error', to: 'Single', mechanism: 'scorer' });

// Out → error: strikeout/field_out baseline, then a field_error.
let s8 = mergeScoringChanges(3, [atIndex(PLAY_STRIKEOUT, 52)], new Map(), NOW, emptyCtx());
let outToError = mergeScoringChanges(3, [atIndex(PLAY_FIELD_ERROR, 52)], s8.snapshots, NOW + 1000, emptyCtx());
assertChangeRow(outToError, { from: 'Strikeout', to: 'Field Error', mechanism: 'scorer' });

// Hit → fielder's choice + error = official change #232 exactly.
let s9 = mergeScoringChanges(4, [atIndex(PLAY_SINGLE_FINAL_230, 53)], new Map(), NOW, emptyCtx());
let hitToFc = mergeScoringChanges(4, [atIndex(PLAY_FC_PLUS_ERROR, 53)], s9.snapshots, NOW + 1000, emptyCtx());
let reviewFC = assertChangeRow(hitToFc, { from: 'Single', to: 'Fielders Choice + Error', mechanism: 'scorer' });
assert.equal(reviewFC.final.errorMovements, 1, 'the error movement is part of the final ruling');

// Out → hit: strikeout baseline, then a single.
let s10 = mergeScoringChanges(5, [atIndex(PLAY_STRIKEOUT, 54)], new Map(), NOW, emptyCtx());
assertChangeRow(mergeScoringChanges(5, [atIndex(PLAY_SINGLE_FINAL_230, 54)], s10.snapshots, NOW + 1000, emptyCtx()),
  { from: 'Strikeout', to: 'Single', mechanism: 'scorer' });

/* ================== 7. Attribution: replay review / pending ruling / scorer */

// The play itself carries about.hasReview AND the feed already tracks a
// replay-review row for this exact at-bat → the rescore belongs to that
// review row; minting a second row would double-count one fact.
const REVIEWED_CTX = () => ({
  activeReviewIndexes: new Set([42]),
  pendingScoringIndexes: new Set(),
  reviewedPlays: new Set([42]),
  teamLabels: emptyCtx().teamLabels,
});
let s11 = mergeScoringChanges(9, [atIndex(PLAY_FIELD_ERROR, 42)], new Map(), NOW, REVIEWED_CTX());
let reviewed = mergeScoringChanges(9, [atIndex(PLAY_SINGLE_FINAL_230, 42)], s11.snapshots, NOW + 1000, REVIEWED_CTX());
assert.equal(reviewed.added.length, 0,
  'a rescore covered by an existing replay-review row is not double-tracked');
assert.equal(reviewed.snapshots.get('42').history.length, 1,
  'the change is still recorded in the play\u2019s history');

// hasReview on the play but NO review row was ever observed (e.g. the page
// opened mid-review): the change IS surfaced, labelled as review-attributed.
const HAS_REVIEW_PLAY = {
  ...PLAY_SINGLE_FINAL_230,
  about: { ...PLAY_SINGLE_FINAL_230.about, hasReview: true },
};
let s12 = mergeScoringChanges(10, [atIndex(PLAY_DOUBLE_INITIAL_230, 55)], new Map(), NOW, emptyCtx());
let orphanReview = mergeScoringChanges(10, [atIndex(HAS_REVIEW_PLAY, 55)], s12.snapshots, NOW + 1000, emptyCtx());
assertChangeRow(orphanReview, { from: 'Double', to: 'Single', mechanism: 'replay_review' });

// An active review for a DIFFERENT at-bat does not capture this play's change.
const OTHER_INDEX_CTX = () => ({
  activeReviewIndexes: new Set([99]),
  pendingScoringIndexes: new Set(),
  reviewedPlays: new Set([99]),
  teamLabels: emptyCtx().teamLabels,
});
let s13 = mergeScoringChanges(11, [atIndex(PLAY_SINGLE_FINAL_230, 56)], new Map(), NOW, OTHER_INDEX_CTX());
let otherIdx = mergeScoringChanges(11, [atIndex(PLAY_FIELD_ERROR, 56)], s13.snapshots, NOW + 1000, OTHER_INDEX_CTX());
assertChangeRow(otherIdx, { from: 'Single', to: 'Field Error', mechanism: 'scorer' },
  'an unrelated active review does not hijack attribution');

// The play carried the official-scorer PENDING marker (tracked by the ⚖️
// Scoring Pending feature) before the ruling landed.
const PENDING_CTX = () => ({
  activeReviewIndexes: new Set(),
  pendingScoringIndexes: new Set([57]),
  reviewedPlays: new Set(),
  teamLabels: emptyCtx().teamLabels,
});
let s14 = mergeScoringChanges(12, [atIndex(PLAY_FIELD_ERROR, 57)], new Map(), NOW, PENDING_CTX());
let pendingRuling = mergeScoringChanges(12, [atIndex(PLAY_SINGLE_FINAL_230, 57)], s14.snapshots, NOW + 1000, PENDING_CTX());
let reviewPR = assertChangeRow(pendingRuling, { from: 'Field Error', to: 'Single', mechanism: 'pending_ruling' });
assert.match(reviewPR.mechanism.label, /pending ruling/i);

/* ================== 8. Pending/blank initial states are never baselined === */

// Poll 1 sees the play while the official scorer is still deciding (result
// carries the pending marker) → no baseline. Poll 2 sees the first REAL
// classification → that becomes the baseline, still no row. Poll 3 sees a
// change → row between the two REAL classifications only.
let p1 = mergeScoringChanges(13, [PLAY_PENDING_RESULT], new Map(), NOW, emptyCtx());
assert.equal(p1.added.length, 0);
assert.equal(p1.snapshots.size, 0, 'a pending-result play is not baselined');
let p2 = mergeScoringChanges(13, [atIndex(PLAY_FIELD_ERROR, 44)], p1.snapshots, NOW + 1000, emptyCtx());
assert.equal(p2.added.length, 0, 'the first real ruling is the baseline, not a change');
assert.equal(p2.snapshots.size, 1);
let p3 = mergeScoringChanges(13, [atIndex(PLAY_SINGLE_FINAL_230, 44)], p2.snapshots, NOW + 2000, emptyCtx());
assertChangeRow(p3, { from: 'Field Error', to: 'Single', mechanism: 'scorer' });

// Same for a completed play with a blank result (no eventType yet).
let b1 = mergeScoringChanges(14, [{ about: { atBatIndex: 7, isComplete: true }, result: { description: 'x' } }], new Map(), NOW, emptyCtx());
assert.equal(b1.snapshots.size, 0);
let b2 = mergeScoringChanges(14, [PLAY_STRIKEOUT], b1.snapshots, NOW + 1000, emptyCtx());
assert.equal(b2.snapshots.size, 1, 'the first classified observation is the baseline');
assert.equal(b2.added.length, 0);

/* ============================ 9. Irregularities flagged for review, always */

// Description edited WITHOUT a reclassification → irregularity, not a row.
const RETITLED = {
  ...PLAY_SINGLE_FINAL_230,
  result: { ...PLAY_SINGLE_FINAL_230.result, description: 'Vladimir Guerrero Jr. singles on a line drive to left fielder Randy Arozarena. Myles Straw scores. Vladimir Guerrero Jr. to 2nd.' },
};
let i1 = mergeScoringChanges(15, [PLAY_SINGLE_FINAL_230], new Map(), NOW, emptyCtx());
let i2 = mergeScoringChanges(15, [RETITLED], i1.snapshots, NOW + 1000, emptyCtx());
assert.equal(i2.added.length, 0, 'description-only edit is not a hit/error/out row');
assert.equal(i2.irregularities.length, 1, '…but it IS flagged for review');
assert.match(i2.irregularities[0], /play 36: official description edited without a hit\/error\/out reclassification/);
assert.ok(!i2.irregularities.some((n) => /disappeared/.test(n)), 'no phantom vanish note');

// RBI changed without reclassification (real-world example: official change
// #204 removed an RBI). Before session 5 this was only an irregularity note;
// the session-5 charter makes it a MAIN-alert scoring change (batting RBI):
// a `stat-<ai>` row with the observed delta, and no irregularity note.
const RBI_REMOVED = {
  ...PLAY_SINGLE_FINAL_230,
  result: { ...PLAY_SINGLE_FINAL_230.result, rbi: 0 },
};
let i3 = mergeScoringChanges(16, [PLAY_SINGLE_FINAL_230], new Map(), NOW, emptyCtx());
let i4 = mergeScoringChanges(16, [RBI_REMOVED], i3.snapshots, NOW + 1000, emptyCtx());
assert.equal(i4.added.length, 1, 'an RBI-only change is a scoring-change row');
assert.equal(i4.irregularities.length, 0, '…not an irregularity');
{
  const r = i4.added[0].review;
  assert.equal(r.id, 'stat-36');
  assert.equal(r.typeKey, 'scoring_change');
  const plain = (v) => JSON.parse(JSON.stringify(v)); // vm cross-realm objects
  assert.deepEqual(plain(r.stats.batting), [{ stat: 'RBI', from: 1, to: 0, delta: -1 }]);
  assert.deepEqual(plain(r.stats.pitching), []);
  assert.equal(r.stats.source, 'observed');
  assert.equal(r.reason, 'Single: RBI 1 → 0');
  assert.equal(r.initial.eventType, 'single');
  assert.equal(r.final.eventType, 'single');
  assert.equal(RF.isBattingStatChange(r), true);
  assert.equal(RF.shouldAlertForReview(r), true, 'batting RBI change → main alert');
  assert.equal(RF.visibleInAllFeed(r), true);
}

// Score after the play changed without reclassification → irregularity
// (a retroactive score fix must never be silently swallowed).
const SCORE_FIXED = {
  ...PLAY_SINGLE_FINAL_230,
  result: { ...PLAY_SINGLE_FINAL_230.result, awayScore: 2, homeScore: 3 },
};
let i5 = mergeScoringChanges(17, [PLAY_SINGLE_FINAL_230], new Map(), NOW, emptyCtx());
let i6 = mergeScoringChanges(17, [SCORE_FIXED], i5.snapshots, NOW + 1000, emptyCtx());
assert.equal(i6.added.length, 0);
assert.equal(i6.irregularities.length, 1);
assert.match(i6.irregularities[0], /score after play .* → 2-3 without a hit\/error\/out reclassification/);

// Irregularities dedupe across polls (the same note is not re-added forever).
let i7 = mergeScoringChanges(17, [SCORE_FIXED], i6.snapshots, NOW + 2000, emptyCtx());
assert.equal(i7.irregularities.length, 0, 'no repeat of an already-flagged note');
// …and a stat-only row is not re-minted on the next identical poll.
let i8 = mergeScoringChanges(16, [RBI_REMOVED], i4.snapshots, NOW + 2000, emptyCtx());
assert.equal(i8.added.length + i8.updated.length, 0, 'unchanged poll → no new row');

// A tracked play VANISHING from the payload is an irregularity, never a
// silent deletion.
let v1 = mergeScoringChanges(18, [PLAY_SINGLE_FINAL_230], new Map(), NOW, emptyCtx());
let v2 = mergeScoringChanges(18, [PLAY_FIELD_ERROR], v1.snapshots, NOW + 1000, emptyCtx());
assert.ok(v2.irregularities.some((n) => /play 36 disappeared from the official play-by-play payload/.test(n)),
  'vanished play flagged with its last observed call');
assert.equal(v2.snapshots.get('36').snapshot.eventType, 'single',
  'the vanished play\u2019s history is kept, not destroyed');

// An EMPTY payload (pre-game blip) must not mass-flag vanished plays.
let v3 = mergeScoringChanges(18, [], v2.snapshots, NOW + 2000, emptyCtx());
assert.deepEqual([...v3.irregularities], [], 'empty payload is treated as a blip, not deletions');
assert.equal(v3.snapshots.get('36').snapshot.eventType, 'single', 'state preserved through the blip');

// The currentPlay twin of an allPlays entry must not double-process.
let d1 = mergeScoringChanges(19, [PLAY_DOUBLE_INITIAL_230], new Map(), NOW, emptyCtx());
let d2 = mergeScoringChanges(19, [PLAY_SINGLE_FINAL_230, PLAY_SINGLE_FINAL_230], d1.snapshots, NOW + 1000, emptyCtx());
assert.equal(d2.added.length, 1, 'duplicated play (allPlays + currentPlay) yields one row');

/* ================================= 10. Post-Final re-scan policy (bounded) */

const GRACE_MS = 30 * 60 * 1000;
const RESCAN_MS = 30 * 1000;
assert.equal(finalScanDecision(null, false, 1000, GRACE_MS, RESCAN_MS), 'scan',
  'a live game follows the ordinary cadence');
assert.equal(finalScanDecision(null, true, 1000, GRACE_MS, RESCAN_MS), 'scan',
  'first Final observation is always fetched (and starts the grace window)');
assert.equal(finalScanDecision({ firstFinalObservedAt: 0, lastScanAt: 1000 }, true, 2000, GRACE_MS, RESCAN_MS), 'skip',
  'within grace but inside the rescan gap → skip');
assert.equal(finalScanDecision({ firstFinalObservedAt: 0, lastScanAt: 0 }, true, RESCAN_MS + 1, GRACE_MS, RESCAN_MS), 'scan',
  'within grace and past the rescan gap → scan (catch rulings published after Final)');
assert.equal(finalScanDecision({ firstFinalObservedAt: 0, lastScanAt: 0 }, true, GRACE_MS + 1, GRACE_MS, RESCAN_MS), 'skip',
  'beyond the grace window the final is settled for good (bounded polling)');
assert.equal(finalScanDecision({ firstFinalObservedAt: 0 }, true, 1000, GRACE_MS, RESCAN_MS), 'scan',
  'grace entry without a scan stamp yet → scan');

/* ----- recency-tiered fast window (default off when not supplied) ----- */
const FAST_MS = 5 * 1000;
const FAST_WINDOW = 5 * 60 * 1000;
// Uniform-gap callers (no fast params) are untouched.
assert.equal(finalScanDecision({ firstFinalObservedAt: 0, lastScanAt: 30000 }, true, 31000, GRACE_MS, RESCAN_MS, FAST_MS, FAST_WINDOW), 'skip',
  'recently Final: a rescan 30s ago is still inside the 5s fast gap → skip');
assert.equal(finalScanDecision({ firstFinalObservedAt: 0, lastScanAt: 0 }, true, FAST_MS + 1, GRACE_MS, RESCAN_MS, FAST_MS, FAST_WINDOW), 'scan',
  'recently Final: past the 5s fast gap → scan (post-Final ruling caught ~6x sooner)');
// Once past the fast window, the explicit base gap applies again.
const BASE_MS = 15 * 1000;
const mid = FAST_WINDOW + 20000;
assert.equal(finalScanDecision({ firstFinalObservedAt: 0, lastScanAt: mid - 14000 }, true, mid, GRACE_MS, BASE_MS, FAST_MS, FAST_WINDOW), 'skip',
  'older Final: 14s since last scan is inside the 15s base gap → skip');
assert.equal(finalScanDecision({ firstFinalObservedAt: 0, lastScanAt: mid - 16000 }, true, mid, GRACE_MS, BASE_MS, FAST_MS, FAST_WINDOW), 'scan',
  'older Final: past the 15s base gap → scan');
assert.equal(finalScanDecision({ firstFinalObservedAt: 0, lastScanAt: 0 }, true, GRACE_MS + 1, GRACE_MS, BASE_MS, FAST_MS, FAST_WINDOW), 'skip',
  'recency tiers never extend polling past the grace window');

/* ===================== 11. Feed integration contracts (All feed, alerts) == */

// Session-5 charter: "The alert system must track scoring changes that alter
// batting Runs, Hits, RBI ONLY in the main alert system"; pitching stat
// changes live in a separate section and must not populate main alerts.
const scoringReview = r3.added[0].review;
{
  const plain = (v) => JSON.parse(JSON.stringify(v));
  // Real #230 (double → single): a hit either way, same run and RBI — no
  // batting R/H/RBI change and no pitching change → 🗂️ Other Rulings, silent.
  assert.deepEqual(plain(scoringReview.stats), { batting: [], pitching: [], source: 'observed' });
  assert.equal(RF.isOtherScoringChange(scoringReview), true);
  assert.equal(visibleInAllFeed(scoringReview), false, 'double → single is not an R/H/RBI change');
  assert.equal(shouldAlertForReview(scoringReview), false);
  // Error → single: batting H +1 → main alerts (All, ✏️, chime).
  const e2h = { typeKey: 'scoring_change', initial: { eventType: 'field_error' }, final: { eventType: 'single' } };
  assert.equal(RF.isBattingStatChange(e2h), true);
  assert.equal(visibleInAllFeed(e2h), true);
  assert.equal(shouldAlertForReview(e2h), true);
  // Single → error stays in 📉 Hit → Error (session 3), even though H changes.
  const h2e = { typeKey: 'scoring_change', initial: { eventType: 'single' }, final: { eventType: 'field_error' } };
  assert.equal(isHitToErrorChange(h2e), true);
  assert.equal(RF.isBattingStatChange(h2e), false);
  assert.equal(shouldAlertForReview(h2e), false);
  assert.equal(visibleInAllFeed(h2e), false);
  // Strikeout → reached on error: pitching K −1 only → 🧮, silent.
  const k2e = { typeKey: 'scoring_change', initial: { eventType: 'strikeout' }, final: { eventType: 'field_error' } };
  assert.equal(RF.isPitchingOnlyStatChange(k2e), true);
  assert.equal(shouldAlertForReview(k2e), false, 'pitching stat changes never populate the main alerts');
  assert.equal(visibleInAllFeed(k2e), false);
  // Walk → hit by pitch: pitching BB −1 → 🧮.
  assert.equal(RF.isPitchingOnlyStatChange({ typeKey: 'scoring_change', initial: { eventType: 'walk' }, final: { eventType: 'hit_by_pitch' } }), true);
  // Official-log rows carry the log's parsed stats, which win over event types.
  const erOnly = { typeKey: 'scoring_change', initial: { eventType: 'double' }, final: { eventType: 'double' },
    stats: { batting: [], pitching: [{ stat: 'ER', delta: -1 }, { stat: 'UER', delta: 1 }], source: 'official_log' } };
  assert.equal(RF.isPitchingOnlyStatChange(erOnly), true);
  assert.equal(shouldAlertForReview(erOnly), false);
  // A malformed scoring row fails OPEN (never silently hidden).
  assert.equal(visibleInAllFeed({ typeKey: 'scoring_change' }), true, 'unknown scoring row stays visible');
  assert.equal(shouldAlertForReview({ typeKey: 'scoring_change' }), true);
}

// The user's own example (2026 #249, CIN @ MIL 9/11, at-bat 7). AFTER is the
// REAL StatsAPI play (tools/fixtures/statsapi-823736-pbp-ab6-7.json: rbi 0,
// Turang scores on JJ Bleday's error, earned:false). BEFORE is SYNTHETIC —
// the same play as the official log says it stood before the change (no
// error: Turang scored on the double, Vaughn had the RBI, the run was earned)
// — because StatsAPI rewrites history and no pre-change copy exists.
{
  const plain = (v) => JSON.parse(JSON.stringify(v));
  const fx = JSON.parse(readFileSync(new URL('./fixtures/statsapi-823736-pbp-ab6-7.json', import.meta.url), 'utf8'));
  const after = { ...fx.allPlays.find((p) => p.about.atBatIndex === 7) };
  after.about = { ...after.about, isComplete: true };
  const before = JSON.parse(JSON.stringify(after));
  before.result.rbi = 1;
  before.runners.forEach((r) => {
    if (r.movement && r.movement.end === 'score') {
      Object.assign(r.details, { earned: true, eventType: 'double', event: 'Double' });
      r.credits = [];
    }
  });
  const snapA = buildScoringSnapshot(after);
  assert.equal(snapA.rbi, 0);
  assert.equal(snapA.runsScored, 1);
  assert.equal(snapA.earnedRuns, 0);
  assert.equal(snapA.unearnedRuns, 1);
  const v1 = mergeScoringChanges(823736, [before], new Map(), NOW, emptyCtx());
  const v2 = mergeScoringChanges(823736, [after], v1.snapshots, NOW + 60000, emptyCtx());
  assert.equal(v2.added.length, 1, 'the RBI / earned-run change is one row');
  const r = v2.added[0].review;
  assert.equal(r.id, 'scoring-7', 'a runner-error reclassification (Double → Double + Error)');
  assert.deepEqual(plain(r.stats.batting), [{ stat: 'RBI', from: 1, to: 0, delta: -1 }]);
  assert.deepEqual(plain(r.stats.pitching), [{ stat: 'ER', from: 1, to: 0, delta: -1 }, { stat: 'UER', from: 0, to: 1, delta: 1 }]);
  assert.equal(r.reason, 'Double → Double + Error');
  assert.equal(r.pitcher.fullName, 'Andrew Abbott');
  assert.equal(RF.isBattingStatChange(r), true, 'Vaughn loses an RBI → main alert');
  assert.equal(shouldAlertForReview(r), true);
  // RBI-only change on the REAL play (no reclassification) → stat row.
  const rbiBack = JSON.parse(JSON.stringify(after));
  rbiBack.result.rbi = 1;
  const s1 = mergeScoringChanges(823736, [rbiBack], new Map(), NOW, emptyCtx());
  const s2 = mergeScoringChanges(823736, [after], s1.snapshots, NOW + 60000, emptyCtx());
  assert.equal(s2.added[0].review.id, 'stat-7', 'stat-only row id (the pipeline\u2019s official stat row uses the same id)');
  assert.equal(s2.added[0].review.reason, 'Double + Error: RBI 1 → 0');
  // ONLY the earned-run change on the real play → pitching section only.
  const erBack = JSON.parse(JSON.stringify(after));
  erBack.runners.forEach((x) => { if (x.movement && x.movement.end === 'score') x.details.earned = true; });
  const w1 = mergeScoringChanges(823736, [erBack], new Map(), NOW, emptyCtx());
  const w2 = mergeScoringChanges(823736, [after], w1.snapshots, NOW + 60000, emptyCtx());
  const rp = w2.added[0].review;
  assert.equal(rp.reason, 'Double + Error: ER 1 → 0 · UER 0 → 1');
  assert.deepEqual(plain(rp.stats.batting), []);
  assert.equal(RF.isPitchingOnlyStatChange(rp), true);
  assert.equal(shouldAlertForReview(rp), false, '1 run changed to unearned alone never alerts');
  assert.equal(visibleInAllFeed(rp), false);
  // A payload without the `earned` flag never invents ER/UER counts.
  const noFlag = JSON.parse(JSON.stringify(after));
  noFlag.runners.forEach((x) => { delete x.details.earned; });
  assert.equal(buildScoringSnapshot(noFlag).earnedRuns, null);
}
assert.equal(runsRemovableFromReview(scoringReview), 0,
  'a scoring change never claims runs at risk (not a replay review)');
assert.equal(runsRemovableFromReview({ typeKey: 'scoring_change', inProgress: false }), 0);

/* ============ 12. mergeFeedEvents must never delete scoring-change rows === */

// mergeFeedEvents prunes this game's keys that extractReviews() no longer
// emits — scoring rows are NOT produced by extractReviews(), so pruning them
// would wipe the tracker every poll. This pins the protection.
const state = { seen: new Map(), order: [] };
const scoringEntry = { gamePk: 822766, review: scoringReview, firstSeen: NOW, lastSeen: NOW };
const scoringKey = buildEventKey(822766, scoringReview);
state.seen.set(scoringKey, scoringEntry);
state.order.push(scoringKey);
const staleReview = {
  id: 'play-15-main', atBatIndex: 15, inProgress: false, typeKey: 'manager',
  outcome: 'stands', outcomeLabel: 'Call Stands', scoreImpact: null,
};
const staleKey = buildEventKey(822766, staleReview);
const staleEntry = { gamePk: 822766, review: staleReview, firstSeen: NOW, lastSeen: NOW };
state.seen.set(staleKey, staleEntry);
state.order.push(staleKey);

// This poll's extractReviews() output no longer contains the stale review
// (empty list) but the tracker's scoring row is not the extractor's concern.
const merged = mergeFeedEvents(state, 822766, [], null);
assert.ok(state.seen.has(scoringKey),
  'the scoring-change row survives mergeFeedEvents\u2019 cleanup');
assert.ok(!state.seen.has(staleKey),
  'a genuinely stale review row is still pruned (control)');
assert.deepEqual([...merged.ended], [staleKey]);

/* ===================== 13. Mechanism helper contract (pure, no guessing) == */

assert.equal(scoringMechanism({ about: { atBatIndex: 1, hasReview: true } }, emptyCtx()).key, 'replay_review');
assert.equal(scoringMechanism({ about: { atBatIndex: 2, hasReview: false } },
  { activeReviewIndexes: new Set([2]), pendingScoringIndexes: new Set(), teamLabels: {} }).key, 'replay_review');
assert.equal(scoringMechanism({ about: { atBatIndex: 3, hasReview: false } },
  { activeReviewIndexes: new Set(), pendingScoringIndexes: new Set([3]), teamLabels: {} }).key, 'pending_ruling');
assert.equal(scoringMechanism({ about: { atBatIndex: 4, hasReview: false } },
  { activeReviewIndexes: new Set(), pendingScoringIndexes: new Set(), teamLabels: {} }).key, 'scorer');
assert.equal(scoringMechanism(null, null).key, 'scorer', 'malformed input degrades to the honest default');

/* ==== 14. Hit → error segregation — the session-3 charter requirement ====
 * "Track anytime a final scoring decision would change a single to an
 * error … create a section for anything that changes a single to an error
 * and keep it from populating the main primary alert system." The primary
 * alert system = the All feed + the ✏️ Scoring Changes tab + the alert
 * chime (error → hit and scoring-pending movement). Hit → error changes
 * are still tracked, logged and persisted — segregation is display- and
 * alert-level only (isHitToErrorChange in assets/js/reviews-feed.js). */

// reviewHE (§6): Single → Field Error — exactly the charter direction.
assert.equal(isHitToErrorChange(reviewHE), true, 'single → field error is a hit→error change');
assert.equal(visibleInAllFeed(reviewHE), false, 'hit→error changes are kept OUT of the All feed');
assert.equal(shouldAlertForReview(reviewHE), false, 'hit→error changes never trigger the alert chime');
assert.equal(runsRemovableFromReview(reviewHE), 0, '…and never claim runs at risk');

// Doubles/triples ruled errors are the same direction (a hit removed, an
// error charged): the section covers them too.
assert.equal(isHitToErrorChange({ ...reviewHE, initial: { ...reviewHE.initial, eventType: 'double' } }), true,
  'double → error belongs to the section');
assert.equal(isHitToErrorChange({ ...reviewHE, initial: { ...reviewHE.initial, eventType: 'triple' } }), true,
  'triple → error belongs to the section');

// The primary direction stays primary: reviewEH = Field Error → Single (§6).
const reviewEH = errorToHit.added[0].review;
assert.equal(isHitToErrorChange(reviewEH), false, 'error → hit is NOT a hit→error change');
assert.equal(visibleInAllFeed(reviewEH), true, 'error → hit stays in the All feed');
assert.equal(shouldAlertForReview(reviewEH), true, 'error → hit still chimes');

// reviewFC (§6): Single → Fielders Choice + Error — official log #232. The
// final ruling is a fielder's choice, NOT a plate-appearance error, so the
// row stays in the primary surface — matching the pipeline's hitToFc flag
// (the live feed and the official list must section the same play
// identically; scoring.html's 📉 Hit → Error section uses the same
// definition via transitionFlags().hitToError).
assert.equal(isHitToErrorChange(reviewFC), false, 'hit → FC + error is not the single→error section');
assert.equal(visibleInAllFeed(reviewFC), true, 'hit → FC + error stays in the All feed');
assert.equal(shouldAlertForReview(reviewFC), true, 'hit → FC + error still chimes');

// A home run → error change is outside the definition (the model's
// scoreHitToError scores only non-home-run hits): it keeps the old
// primary-surface behavior rather than carrying no model score.
assert.equal(isHitToErrorChange({ ...reviewHE, initial: { ...reviewHE.initial, eventType: 'home_run' } }), false,
  'home run → error is outside the hit→error definition');

// Out → error (§6): not a hit → error change. Session-5 charter: it alters
// no batting Runs / Hits / RBI (an at-bat, no hit, either way), so it is NOT
// in the main alert system — it is listed under 🗂️ Other Rulings (or
// 🧮 Pitching Stats when an earned run moved).
assert.equal(JSON.stringify(outToError.added[0].review.stats),
  JSON.stringify({ batting: [], pitching: [{ stat: 'K', from: 1, to: 0, delta: -1 }], source: 'observed' }),
  'strikeout → error: pitching K −1 only');
assert.equal(RF.isPitchingOnlyStatChange(outToError.added[0].review), true, '→ 🧮 Pitching Stats');
assert.equal(isHitToErrorChange(outToError.added[0].review), false, 'out → error is not a hit→error change');
assert.equal(RF.isBattingStatChange(outToError.added[0].review), false, 'out → error alters no batting R/H/RBI');
assert.equal(visibleInAllFeed(outToError.added[0].review), false, 'out → error is not in the main feed');
assert.equal(shouldAlertForReview(outToError.added[0].review), false, '…and does not chime');

// Malformed / legacy rows (e.g. a restored log row without snapshots) fail
// open: visible, alertable, never silently hidden.
assert.equal(isHitToErrorChange(null), false);
assert.equal(isHitToErrorChange({}), false);
assert.equal(isHitToErrorChange({ typeKey: 'scoring_change' }), false, 'no snapshots → not a hit→error change');
assert.equal(visibleInAllFeed({ typeKey: 'scoring_change' }), true, 'a snapshot-less scoring change stays visible');
assert.equal(shouldAlertForReview({ typeKey: 'scoring_change' }), true, '…and alertable');
assert.equal(visibleInAllFeed(null), true, 'malformed entries fail open');

/* ================ 14. Error Watch integrates observed / captured / logged */
{
  const live = [{ gamePk: 823736, atBatIndex: 7, timestamp: '2026-09-11T23:40:00Z' }, { gamePk: 1, atBatIndex: 2 }];
  const pipe = [
    { gamePk: 823736, ai: 7, date: '2026-09-11', captured: { lagMin: 4 }, official: [{ seq: 249 }], vid: 'x' },
    { gamePk: 823736, ai: 30, date: '2026-09-11', official: [] },
    { gamePk: 9, ai: 1, date: '2026-09-10' },
  ];
  const rows = RF.mergeErrorWatchSources(live, pipe, '2026-09-11');
  assert.equal(rows.length, 3, 'one row per play: live ∪ pipeline plays of this date');
  const a = rows.find((r) => r.key === '823736:7');
  assert.equal(JSON.stringify(a.sources), JSON.stringify({ observed: true, captured: true, logged: [249], scanned: true }));
  const b = rows.find((r) => r.key === '823736:30');
  assert.equal(b.live, null);
  assert.equal(JSON.stringify(b.sources), JSON.stringify({ observed: false, captured: false, logged: [], scanned: true }));
  const c = rows.find((r) => r.key === '1:2');
  assert.equal(c.sources.observed, true);
  assert.equal(c.sources.scanned, false, 'observed live, not yet in the pipeline');
  assert.ok(!rows.some((r) => r.key === '9:1'), 'other dates are not mixed in');
  assert.equal(RF.mergeErrorWatchSources(null, null, '2026-09-11').length, 0);
}

console.log('Official scoring change tests passed successfully!');
