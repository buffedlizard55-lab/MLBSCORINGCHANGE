#!/usr/bin/env node
/* ============================================================================
 * pipeline-link-test.mjs — the official-entry → StatsAPI play linker
 * (pipeline/lib/link.mjs), including the session-4 date-recovery pass.
 *
 * Run: node tools/pipeline-link-test.mjs
 *
 * WHY THE RECOVERY EXISTS (real, in-repo evidence — not a hypothetical)
 *   Two 2026 official-log entries could not be placed by the ±10-day rule and
 *   therefore carried no model score:
 *     #140  "6/6 NYM@PHI — … the single for Gabriel Rincones Jr has been
 *            changed to a throwing error charged to Bo Bichette …"
 *     #173  "9/4 MIA@ATH — … Henry Bolte now reaches on an error instead of a
 *            single, advancing to 2nd on the error …"
 *   The play #140 is about exists in this repo's own pipeline output —
 *   data/model/error-watch.json row id 823448:76: game 823448 whose StatsAPI
 *   officialDate is 2026-06-18 (12 days after the stated 6/6), batter "Gabriel
 *   Rincones Jr.", eventType field_error, error type throwing, description
 *   "Gabriel Rincones Jr. reaches on a throwing error by third baseman Bo
 *   Bichette. J.T. Realmuto to 3rd."
 *   The play #173 is about is the MIA@ATH game of 2026-07-04 (game 824983,
 *   row 824983:76: bottom 9th, "Henry Bolte reaches on a throwing error by
 *   shortstop Otto Lopez. Carlos Cortes scores. Henry Bolte to 2nd.") — the
 *   log printed "9/4", and the neighbouring entries (#172 dated 7/4, #174
 *   dated 7/7) show the list is otherwise in date order.
 *
 *   Those rows are REAL pipeline output, read from data/model/error-watch.json
 *   when the file still carries them; the same facts are embedded below as a
 *   fallback so the test stays deterministic across pipeline runs. Nothing
 *   synthetic is claimed to be real: every embedded description is the verbatim
 *   StatsAPI play description from that row.
 *
 * SECTIONS
 *   1. dateTypoKind / textMentionsName (pure helpers)
 *   2. Rule-2 behaviour that must NOT regress (same date, aliases, swaps,
 *      ±3-day window, batter_not_found)
 *   3. Date recovery: #140 (day typo), #173 (month typo, inning also wrong)
 *   4. Recovery refuses ambiguity and refuses an unverified date
 * ==========================================================================*/

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LINKER_VERSION, buildTeamIndex, dateTypoKind, linkEntry, recoverGameForEntry, textMentionsName, rulingAgrees,
} from '../pipeline/lib/link.mjs';
import { classifyEntry, transitionFlags } from '../pipeline/lib/log-classifier.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; } catch (err) { console.error(`FAIL: ${name}`); throw err; }
}

/* ------------------------------------------------------------- world setup */

// The four clubs these fixtures need, as StatsAPI /teams reports them (real
// ids: NYM 121, PHI 143, MIA 146, ATH 133 — the pipeline reads the season's
// /teams payload; ATH is also reachable through the documented OAK alias).
const TEAMS = [
  { id: 121, name: 'New York Mets', abbreviation: 'NYM', teamCode: 'nyn', fileCode: 'nym' },
  { id: 143, name: 'Philadelphia Phillies', abbreviation: 'PHI', teamCode: 'phi', fileCode: 'phi' },
  { id: 146, name: 'Miami Marlins', abbreviation: 'MIA', teamCode: 'mia', fileCode: 'mia' },
  { id: 133, name: 'Athletics', abbreviation: 'ATH', teamCode: 'ath', fileCode: 'oak' },
];
const teamIndex = buildTeamIndex(TEAMS);
const games = [
  { gamePk: 823440, officialDate: '2026-06-05', awayId: 121, homeId: 143, gameType: 'R' },
  { gamePk: 823448, officialDate: '2026-06-18', awayId: 121, homeId: 143, gameType: 'R' },
  { gamePk: 824982, officialDate: '2026-07-03', awayId: 146, homeId: 133, gameType: 'R' },
  { gamePk: 824983, officialDate: '2026-07-04', awayId: 146, homeId: 133, gameType: 'R' },
  { gamePk: 824990, officialDate: '2026-06-15', awayId: 133, homeId: 146, gameType: 'R' },
];

const play = (g, ai, inn, top, b, bn, et, ev, desc) => ({ g, ai, inn, top, b, bn, ty: 'atBat', et, ev, desc });

// Verbatim StatsAPI play descriptions (see the header): the batter's play and
// the two plays around it, enough for the half-inning scope to be exercised.
const PLAYS = {
  823440: [
    play(823440, 60, 8, false, 601, 'Nick Castellanos', 'field_out', 'Field Out', 'Nick Castellanos grounds out to shortstop.'),
  ],
  823448: [
    play(823448, 70, 9, false, 700, 'Bryson Stott', 'single', 'Single', 'Bryson Stott singles on a line drive to left fielder.'),
    play(823448, 76, 9, false, 805, 'Gabriel Rincones Jr.', 'field_error', 'Field Error',
      'Gabriel Rincones Jr. reaches on a throwing error by third baseman Bo Bichette. J.T. Realmuto to 3rd.'),
  ],
  824982: [
    play(824982, 35, 4, true, 806, 'Heriberto Hernández', 'field_error', 'Field Error', 'Heriberto Hernández reaches on a fielding error by third baseman.'),
  ],
  824983: [
    play(824983, 70, 8, false, 807, 'Carlos Cortes', 'field_out', 'Field Out', 'Carlos Cortes flies out to center fielder.'),
    play(824983, 76, 9, false, 808, 'Henry Bolte', 'field_error', 'Field Error',
      'Henry Bolte reaches on a throwing error by shortstop Otto Lopez. Carlos Cortes scores. Henry Bolte to 2nd.'),
  ],
  824990: [
    play(824990, 20, 3, false, 809, 'Henry Bolte', 'single', 'Single', 'Henry Bolte singles on a ground ball to left fielder.'),
  ],
};
const playsByGame = new Map(Object.entries(PLAYS).map(([pk, list]) => [Number(pk), list]));

// The rows in this repo's own pipeline output must still agree with the
// fixture (they are the evidence for the gamePk/atBatIndex/batter facts). If a
// future pipeline run drops a row (e.g. the play changes again), the fixture
// keeps testing the linked behaviour and this check reports that it could not
// re-verify — it never silently passes off stale data as current.
/**
 * The real published pipeline output must place 2026 #140 and #173 on the plays
 * this test's own fixtures describe: game 823448 at-bat 76 (Rincones Jr., a
 * `field_error`) and game 824983 at-bat 76 (Bolte, a `field_error`, bottom 9th).
 * #173 is the harder one: the same batter (Henry Bolte) has plate appearances in
 * BOTH MIA@ATH games of 7/3 and 7/4, so the linker must prefer the play whose
 * current ruling IS the entry's new ruling over a `compatible` one.
 *
 * Reads the committed outputs only (no network). If a row is missing — a later
 * pipeline run, or a play that changed again — it reports SKIPPED instead of
 * silently passing stale facts off as current.
 */
function verifyRecoveredLinksInRepoData() {
  const file = path.join(ROOT, 'data', 'official', 'scoring-changes-2026.json');
  if (!fs.existsSync(file)) return { checked: 0, skipped: 'scoring-changes-2026.json not present' };
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entries = data.entries || [];
  const bySeq = new Map(entries.map((e) => [e.seq, e]));
  // The play-level expectations below only hold for data produced by the
  // current linking rules, and the pipeline publishes which version produced a
  // file (`report.linker.version`, see pipeline/lib/link.mjs). Older data is
  // reported as skipped — never quietly treated as a pass, and never a failure
  // the code cannot control (the 3-hourly run regenerates it).
  const reportFile = path.join(ROOT, 'data', 'model', 'pipeline-report.json');
  let printed = null;
  try { printed = JSON.parse(fs.readFileSync(reportFile, 'utf8')).linker; } catch { /* no report yet */ }
  if (!printed || !(printed.version >= LINKER_VERSION)) {
    return { checked: 0, skipped: `committed data was produced by linker v${printed ? printed.version : '?'} (needs v${LINKER_VERSION}) — the pipeline run on this push regenerates it` };
  }
  const want = [
    [140, 823448, 76, 'Gabriel Rincones Jr.'],
    [173, 824983, 76, 'Henry Bolte'],
  ];
  let checked = 0;
  const misses = [];
  for (const [seq, gamePk, ai, batter] of want) {
    const e = bySeq.get(seq);
    if (!e || !e.link) { misses.push(`#${seq} entry missing`); continue; }
    // Before the session-4 recovery these were `no_game_found`: if the data still
    // says so, that is a real failure, not a skip.
    if (e.link.gamePk == null || e.link.atBatIndex == null) {
      misses.push(`#${seq} unlinked (${(e.link.flags || []).join(', ')})`);
      continue;
    }
    assert.equal(e.link.gamePk, gamePk, `#${seq} gamePk`);
    assert.equal(e.link.atBatIndex, ai, `#${seq} atBatIndex`);
    assert.equal(e.link.batterName, batter, `#${seq} batter`);
    assert.equal(e.link.currentEventType, 'field_error', `#${seq} current ruling`);
    assert.ok((e.link.flags || []).some((f) => /^date_recovered:/.test(f)), `#${seq} stays flagged as a recovery`);
    assert.ok(!(e.link.flags || []).includes('no_game_found'), `#${seq} is not reported as no_game_found`);
    assert.ok(e.model && e.model.question === 'hitToError' && Number.isInteger(e.model.score),
      `#${seq} carries its hit → error model score (the point of the recovery)`);
    checked += 1;
  }
  assert.equal(misses.length, 0, `real recovered links (${misses.join('; ')})`);
  return { checked, skipped: null };
}

function verifyAgainstRepoData() {
  const file = path.join(ROOT, 'data', 'model', 'error-watch.json');
  if (!fs.existsSync(file)) return { checked: 0, skipped: 'error-watch.json not present' };
  const w = JSON.parse(fs.readFileSync(file, 'utf8'));
  const want = [['823448:76', 'Gabriel Rincones Jr.', 'throwing'],
    ['824983:76', 'Henry Bolte', 'throwing']];
  let checked = 0;
  for (const [id, batter, errKind] of want) {
    const row = (w.plays || []).find((p) => p.id === id);
    if (!row) continue;
    assert.equal(row.batter, batter, `error-watch row ${id} batter`);
    assert.equal(row.eventType, 'field_error', `error-watch row ${id} eventType`);
    assert.equal(row.errKind, errKind, `error-watch row ${id} error type`);
    checked += 1;
  }
  return { checked, skipped: null };
}

const ctx = { teamIndex, games, playsByGame, teamsById: new Map(TEAMS.map((t) => [t.id, t])) };
const entryFor = (raw) => {
  const line = raw.replace(/^\d+\.\s*/, '');
  const m = line.match(/^(\d+)\/(\d+)\s+([A-Z]+)@([A-Z]+)\s+--\s+([\s\S]*)$/);
  assert.ok(m, `entry line parsed: ${raw.slice(0, 40)}`);
  const year = 2026;
  const date = `${year}-${String(Number(m[1])).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
  const body = m[5];
  const halfM = body.match(/In the (top|bottom) of the (\w+)/i);
  const ordinal = { '1st': 1, '2nd': 2, '3rd': 3 };
  const e = {
    date, away: m[3], home: m[4], body,
    half: halfM ? halfM[1].toLowerCase() : null,
    inning: halfM ? (ordinal[halfM[2]] || parseInt(halfM[2], 10)) : null,
  };
  e.cls = classifyEntry(e.body);
  e.cls.flags = Object.entries(transitionFlags(e.cls)).filter(([, v]) => v).map(([k]) => k);
  return e;
};

/* ------------------------------------------------------------------ 1 pure */

test('dateTypoKind names the relation the calendar shows, and nothing else', () => {
  assert.equal(dateTypoKind('2026-09-04', '2026-07-04'), 'month');
  assert.equal(dateTypoKind('2026-06-06', '2026-06-18'), 'day');
  assert.equal(dateTypoKind('2026-09-04', '2026-04-09'), 'transposed');
  assert.equal(dateTypoKind('2026-06-06', '2026-06-06'), null, 'same date is not a typo');
  assert.equal(dateTypoKind('2026-06-06', '2025-06-06'), null, 'another year is never claimed as a typo');
  assert.equal(dateTypoKind('2026-06-06', '2026-05-17'), null, 'two different fields is not a single-field typo');
  assert.equal(dateTypoKind(null, '2026-06-06'), null);
  assert.equal(dateTypoKind('2026-06-06', null), null);
});

test('textMentionsName is a cheap pre-filter (full name, last name, no name)', () => {
  assert.equal(textMentionsName('the single for gabriel rincones jr has been changed', 'Gabriel Rincones Jr.'), true);
  assert.equal(textMentionsName('henry bolte now reaches on an error', 'Henry Bolte'), true);
  assert.equal(textMentionsName('the winning pitcher has been changed', 'Henry Bolte'), false);
  // A last name inside a longer word is not a mention (word boundaries).
  assert.equal(textMentionsName('bolted the door', 'Henry Bolte'), false);
  assert.equal(textMentionsName('', 'Henry Bolte'), false);
});

/* ------------------------------------------------- 2 rule 2 must not regress */

test('same-date entries still link exactly as before (no recovery flag)', () => {
  const e = entryFor('1. 6/18 NYM@PHI -- In the bottom of the 9th, Gabriel Rincones Jr. reaches on a throwing error by third baseman Bo Bichette.');
  const link = linkEntry(e, ctx);
  assert.equal(link.gamePk, 823448);
  assert.equal(link.atBatIndex, 76);
  assert.equal(link.method, 'full_name');
  assert.ok(!link.flags.some((f) => /date_recovered|date_typo/.test(f)), 'no recovery on an exact date');
});

test('team aliases, swapped sides and the ±3-day window are unchanged', () => {
  const swap = entryFor('2. 6/18 PHI@NYM -- In the bottom of the 9th, Gabriel Rincones Jr. reaches on a throwing error by third baseman Bo Bichette.');
  const l1 = linkEntry(swap, ctx);
  assert.equal(l1.gamePk, 823448);
  assert.ok(l1.flags.includes('teams_swapped'));

  const near = entryFor('3. 6/16 NYM@PHI -- In the bottom of the 9th, Gabriel Rincones Jr. reaches on a throwing error by third baseman Bo Bichette.');
  const l2 = linkEntry(near, ctx);
  assert.equal(l2.gamePk, 823448, 'within ±3 days of 6/16');
  assert.ok(l2.flags.some((f) => /^date_mismatch/.test(f)), 'the wrong date stays flagged');
});

test('a batter who is in none of the games is still batter_not_found', () => {
  const e = entryFor('4. 6/18 NYM@PHI -- In the bottom of the 9th, Nobody Atall now has a single instead of reaching on an error.');
  const link = linkEntry(e, ctx);
  assert.equal(link.atBatIndex, null);
  assert.ok(link.flags.includes('batter_not_found'));
});

test('unknown teams and a pairing with no game anywhere in the season are reported, not invented', () => {
  const bad = entryFor('5. 6/18 XYZ@PHI -- In the bottom of the 9th, the single for Someone has been changed to an error.');
  assert.ok(linkEntry(bad, ctx).flags.some((f) => /unknown_team/.test(f)));
  // Valid codes, but this pairing never played (no game in ctx.games): the
  // season-wide pass has nothing to scan, so the honest outcome is unchanged.
  const e = entryFor('6. 4/2 MIA@ATH -- In the bottom of the 3rd, the single for Gabriel Rincones Jr has been changed to an error.');
  const l = linkEntry(e, { ...ctx, games: [games[0]] });
  assert.equal(l.gamePk, null);
  assert.ok(l.flags.includes('no_game_found'));
  assert.ok(!l.flags.some((f) => /date_recovered/.test(f)));
});

/* ------------------------------------------------------ 3 the two real cases */

// Verbatim from data/official/raw/scoring-changes-2026.txt (MLB's own page).
const RAW_140 = '140. 6/6 NYM@PHI -- In the bottom of the 9th, the single for Gabriel Rincones Jr has been changed to a throwing error charged to Bo Bichette. As a result, 1 run in the inning is hanged to unearned against Devin Williams.';
const RAW_173 = '173. 9/4 MIA@ATH -- In the bottom of the 8th, Henry Bolte now reaches on an error instead of a single, advancing to 2nd on the error. As a result, 1 run is changed to unearned against Tyler Zuber.';

test('#140 (log date 6/6, game played 6/18) recovers to 823448:76 and stays flagged', () => {
  const e = entryFor(RAW_140);
  assert.equal(e.date, '2026-06-06');
  assert.ok(e.cls.flags.includes('hitToError'), 'classified as a hit → error change');
  const link = linkEntry(e, ctx);
  assert.equal(link.gamePk, 823448, 'game 823448 (2026-06-18)');
  assert.equal(link.atBatIndex, 76, 'the only Gabriel Rincones Jr. play in that game');
  assert.equal(link.batterName, 'Gabriel Rincones Jr.');
  assert.equal(link.currentEventType, 'field_error');
  assert.ok(link.flags.includes('date_recovered:6/6->6/18'), `date_recovered flag (${link.flags.join(', ')})`);
  assert.ok(link.flags.includes('date_typo:day'));
  assert.equal(link.inning, 9, 'the play’s own inning is reported');
  assert.equal(link.half, 'bottom');
  assert.ok(!link.flags.includes('no_game_found'));
  assert.ok(!link.flags.includes('current_ruling_mismatch'), 'StatsAPI already carries the error ruling');
  // The label chain is now usable: the entry's final ruling agrees with the play.
  assert.equal(rulingAgrees(e.cls.final, e.cls.finalHitType, link.currentEventType), true);
});

test('#173 (log date 9/4, game played 7/4, log inning also wrong) recovers to 824983:76', () => {
  const e = entryFor(RAW_173);
  assert.equal(e.date, '2026-09-04');
  assert.ok(e.cls.flags.includes('hitToError'));
  const link = linkEntry(e, ctx);
  assert.equal(link.gamePk, 824983, 'the 2026-07-04 MIA@ATH game (the 7/3 game has no Bolte play)');
  assert.equal(link.atBatIndex, 76);
  assert.equal(link.batterName, 'Henry Bolte');
  assert.ok(link.flags.includes('date_recovered:9/4->7/4'), `date_recovered flag (${link.flags.join(', ')})`);
  assert.ok(link.flags.includes('date_typo:month'), 'same day of month, different month');
  assert.ok(link.flags.includes('inning_mismatch'), 'the stated 8th inning does not hold the play — flagged');
  // …and the link says where the play really is, not what the log printed.
  assert.equal(link.inning, 9, 'the play is in the 9th');
  assert.equal(link.half, 'bottom');
  assert.equal(e.inning, 8, 'the log itself still says the 8th (flagged, never rewritten)');
});

test('the log-order hint is what separates two games that both verify', () => {
  // Synthetic twin of the real shape: the same batter + agreeing ruling in two
  // games of the pairing, 12 days apart. Without an order hint the recovery
  // must refuse; with the neighbours' dates it may place it.
  const twinGames = [
    { gamePk: 900001, officialDate: '2026-05-01', awayId: 121, homeId: 143, gameType: 'R' },
    { gamePk: 900002, officialDate: '2026-05-13', awayId: 121, homeId: 143, gameType: 'R' },
  ];
  const twinPlays = new Map(twinGames.map((g) => [g.gamePk, [
    play(g.gamePk, 30, 4, false, 999, 'Twin Batter', 'field_error', 'Field Error', 'Twin Batter reaches on a fielding error by shortstop.'),
  ]]));
  const twinCtx = { ...ctx, games: twinGames, playsByGame: twinPlays };
  const e = entryFor('7. 4/1 NYM@PHI -- In the bottom of the 4th, Twin Batter reaches on a fielding error by shortstop, instead of a single.');
  assert.equal(linkEntry(e, twinCtx).gamePk, null, 'no order hint → ambiguous → not linked');
  assert.ok(linkEntry(e, twinCtx).flags.includes('date_recovery_ambiguous:2'));
  const withHint = linkEntry(e, { ...twinCtx, orderHint: { prevDate: '2026-05-12', nextDate: '2026-05-14' } });
  assert.equal(withHint.gamePk, 900002, 'the game inside the neighbours’ date window wins');
  assert.ok(withHint.flags.includes('date_recovered:4/1->5/13'));
});

test('an exact ruling beats a merely compatible one — and beats a misleading log order', () => {
  // The shape of the REAL 2026 #173 ambiguity, which the log-order hint alone
  // could not resolve: the stated 9/4 MIA@ATH pairing played on 7/3 and 7/4,
  // the batter has a play in BOTH games, and only the 7/4 play (an exact
  // field_error) is the entry's subject — the 7/3 play is coded
  // `fielders_choice`, which agrees only "compatibly" (link.mjs
  // rulingAgreement: StatsAPI's documented coding for a reached-on-error play).
  const g = [
    { gamePk: 900020, officialDate: '2026-07-03', awayId: 121, homeId: 143, gameType: 'R' },
    { gamePk: 900021, officialDate: '2026-07-04', awayId: 121, homeId: 143, gameType: 'R' },
  ];
  const plays = new Map([
    [900020, [play(900020, 50, 8, false, 997, 'Twin Batter', 'fielders_choice', 'Fielders Choice',
      'Twin Batter reaches on a fielder\u2019s choice. A run scores. Fielding error by third baseman.')]],
    [900021, [play(900021, 60, 9, false, 997, 'Twin Batter', 'field_error', 'Field Error',
      'Twin Batter reaches on a fielding error by third baseman.')]],
  ]);
  const e = entryFor('10. 9/4 NYM@PHI -- In the bottom of the 8th, Twin Batter now reaches on an error instead of a single.');
  const strict = linkEntry(e, { ...ctx, games: g, playsByGame: plays });
  assert.equal(strict.gamePk, 900021, 'the game whose play IS the error the entry describes');
  assert.equal(strict.atBatIndex, 60);
  assert.ok(strict.flags.includes('date_recovery_decided_by:exact_ruling'), `decider reported (${strict.flags.join(', ')})`);
  assert.ok(strict.flags.includes('date_recovered:9/4->7/4'));
  assert.ok(strict.flags.includes('inning_mismatch'), 'the stated 8th inning is not the play’s inning');
  // Even an order hint that points at the compatible game cannot override it:
  // the log's order is weaker evidence than the ruling itself.
  const hinted = linkEntry(e, {
    ...ctx, games: g, playsByGame: plays,
    orderHint: { prevDate: '2026-07-03', nextDate: '2026-07-03' },
  });
  assert.equal(hinted.gamePk, 900021, 'the log order does not outvote an exact ruling match');
  assert.ok(hinted.flags.includes('date_recovery_decided_by:exact_ruling'));
  // Two exact matches are still ambiguous — the tie-break never guesses.
  const twoExact = new Map([[900020, plays.get(900021).map((p) => ({ ...p, g: 900020 }))], [900021, plays.get(900021)]]);
  const both = linkEntry(e, { ...ctx, games: g, playsByGame: twoExact });
  assert.equal(both.gamePk, null, 'two exact matches → nothing linked');
  assert.ok(both.flags.includes('date_recovery_ambiguous:2'), `ambiguous (${both.flags.join(', ')})`);
});

test('the recovery never links a game whose current ruling contradicts the entry', () => {
  // Same teams, same batter, but the play is a single, not the error the entry
  // claims: the ruling check refuses it (the ±10-day pass would have flagged
  // current_ruling_mismatch — the season-wide pass must not sneak past that).
  const g = [{ gamePk: 900010, officialDate: '2026-08-20', awayId: 121, homeId: 143, gameType: 'R' }];
  const p = new Map([[900010, [play(900010, 40, 7, false, 998, 'Mismatch Batter', 'single', 'Single', 'Mismatch Batter singles.')]]]);
  const e = entryFor('8. 3/1 NYM@PHI -- In the bottom of the 7th, the single for Mismatch Batter has been changed to an error charged to the shortstop.');
  const link = linkEntry(e, { ...ctx, games: g, playsByGame: p });
  assert.equal(link.gamePk, null, 'a contradicting ruling is not a recovery');
  assert.ok(link.flags.includes('date_recovery_unverified:1'), `flagged as unverified (${link.flags.join(', ')})`);
  assert.ok(link.flags.includes('no_game_found'));
});

test('a bookkeeping entry (no batter named) recovers only an unambiguous game', () => {
  const e = entryFor('9. 6/11 MIA@ATH -- The winning pitcher has been changed from One Guy to Another Guy. A save is now being credited to One Guy.');
  // The pairing played twice in the season → ambiguous → nothing linked.
  const l1 = linkEntry(e, ctx);
  assert.equal(l1.gamePk, null);
  assert.ok(l1.flags.includes('date_recovery_ambiguous:3'), `three games of the pairing (${l1.flags.join(', ')})`);
  // Exactly one game of the pairing in the whole season → linked, flagged.
  const single = { ...ctx, games: [games[2]] };
  const l2 = linkEntry(e, single);
  assert.equal(l2.gamePk, 824982);
  assert.equal(l2.atBatIndex, null, 'no play claimed for a bookkeeping entry');
  assert.ok(l2.flags.includes('date_recovered_game_only'));
  assert.ok(l2.flags.includes('date_recovered:6/11->7/3'));
});

/* --------------------------------------------------------- 4 repo cross-check */

// The two plays' facts, re-read from the repo's own Error Watch output. A play
// that the recovery pass reclassified (game 823448 at-bat 76 now begins as a
// single, so it belongs to the hit → error population rather than Error Watch)
// is reported as not re-verifiable here — the recovered-links check below is
// what pins it.
const repoCheck = verifyAgainstRepoData();
const recCheck = verifyRecoveredLinksInRepoData();

console.log(`pipeline-link-test: OK (${passed} sections; repo cross-check: ` +
  `${repoCheck.skipped ? repoCheck.skipped : `${repoCheck.checked}/2 Error Watch rows re-verified (a recovered play starts as a hit, so it leaves Error Watch — see the recovered-links check)`}; ` +
  `real recovered links: ${recCheck.skipped || `${recCheck.checked}/2 verified`})`);
