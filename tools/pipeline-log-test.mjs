#!/usr/bin/env node
// Tests for pipeline/lib/log-parser.mjs + pipeline/lib/log-classifier.mjs.
//
// REAL fixtures: every line tagged `real2024` is copied verbatim from MLB's
// official scoring-changes page as archived by the Internet Archive:
//   https://web.archive.org/web/20250121083545id_/https://www.mlb.com/official-information/scoring-changes
// (2024 season list, entries 210-229). The SYNTHETIC line only exercises the
// 2026 "NNN." numbering format and is marked as such.
import assert from 'node:assert/strict';
import {
  parseEntryLine, parseLogText, parseLogHtml, parseSuffix, parseInning, htmlToText,
} from '../pipeline/lib/log-parser.mjs';
import { classifyEntry, transitionFlags, splitSentences } from '../pipeline/lib/log-classifier.mjs';

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; } catch (err) { console.error(`FAIL: ${name}`); throw err; }
}

const real2024 = {
  210: '210) 9/9 KC@NYY -- In the top of the 5th inning, Salvador Perez reaches on an error by second baseman Gleyber Torres instead of a single. This removes the RBI for Perez and makes the run scored in the inning unearned against Carlos Rodon.',
  211: '211) 9/11 MIA@PIT -- In the top of the 9th inning, Jake Burger reaches on a single, instead of an error by shortstop Isiah Kiner Falefa. This makes the run scored in the inning earned against David Bednar.',
  212: '212) 9/10 CHC@LAD -- In the top of the 2nd inning, Pete Crow-Armstrong reaches on an error by first baseman Freddie Freeman, instead of a single. This removes the RBI for Crow-Armstrong and makes the run scored on the play unearned to Yoshinobu Yamamoto.',
  213: '213) 9/11 MIL@SF -- In the top of the 7th inning, Garrett Mitchell reaches on a double, instead of an error by first baseman LaMonte Wade Jr. As a result, the run scored by Mitchell is now earned against Austin Warren.',
  214: "214) 9/15 MIL@AZ -- In the bottom of the 5th inning, the error charged to catcher Eric Haase has been removed, following Jake McCarthy's single.",
  215: '215) 9/15 HOU@LAA -- In the top of the 4th inning, the run scored by Jason Heyward is now unearned against Caden Dana.',
  216: '216) 9/14 NYM@PHI -- In the top of the 3rd inning, Pete Alonso now has a single. The error charged to third baseman Koby Clemens remains for allowing Mark Vientos to score and Brandon Nimmo to advance to third. As a result, one run in the inning is now earned against Kolby Allard.',
  218: '218) 9/14 SD@SF -- In the top of the 1st inning, Manny Machado now has an RBI double scoring Jurickson Profar, instead of a double and Profar scoring on a throwing error by center fielder Heliot Ramos. As a result, the run in the inning is now earned against Mason Black.',
  219: "219) 9/18 AZ@COL -- In the top of the 9th inning, the RBI on Pavin Smith's double has been removed. The run now scores on the fielding error by right fielder Jordan Beck.",
  220: '220) 9/17 PIT@STL -- In the bottom of the 8th inning, the single for Masyn Winn has been changed to an error charged to Isiah Kiner-Falefa. As a result, 1 run in the inning is now unearned against Dennis Santana.',
  221: "221) 9/22 ATL@MIA -- In the bottom of the 7th inning, play at 3rd base during the Nick Fortes plate appearance is now a missed catch error charged to Gio Urshela with an assist to Aaron Bummer. The original ruling was the runner safe on a fielder's choice. As a result, Fortes no longer has a SAC bunt and is charged a turn at bat.",
  222: '222) 9/18 ATL@CIN -- In the top of the 9th inning, Orlando Arcia now has a single, advancing to 2nd base on the throwing error by pitcher Casey Legumina . The play was originally scored a straight two-base error on Legumina.',
  224: '224) 9/26 STL@COL -- In the top of the 2nd inning, Masyn Winn now has a double, instead of an error charged to left fielder Nolan Jones. As a result, Winn gets an RBI and all the runs in the inning are earned against Kyle Freeland.',
  226: '226) 9/27 CWS@DET -- In the bottom of the 5th inning, Jake Rogers now scores on a passed ball by Korey Lee, instead of a wild pitch on Jared Shuster. As a result, the last run of the inning is unearned to Shuster.',
  227: '227) 10/5 DET@CLE -- In the bottom of the 1st inning, Jose Ramirez now reaches on a double, instead of reaching on a fielders choice and an error by third baseman Zach McKinstry. As a result, Ramirez gets credit for a run batted in, and Tyler Holton is now charged with one additional earned run.',
  228: '228) 10/14 NYM@LAD -- In the top of the 6th inning, Francisco Lindor now reaches on a single, instead of a fielding error by third baseman Max Muncy.',
  229: '229) 10/17 NYY@CLE -- In the bottom of the 9th inning, Jose Ramirez reaches on an infield single to first baseman Anthony Rizzo, instead of a fielding error by Rizzo.',
};

// ---------------------------------------------------------------- parser
test('parses 2024 "N)" format head', () => {
  const e = parseEntryLine(real2024[210], 2024);
  assert.equal(e.seq, 210);
  assert.equal(e.date, '2024-09-09');
  assert.equal(e.away, 'KC');
  assert.equal(e.home, 'NYY');
  assert.equal(e.gameNumber, null);
  assert.equal(e.half, 'top');
  assert.equal(e.inning, 5);
  assert.deepEqual(e.issues, []);
  assert.ok(e.body.startsWith('In the top of the 5th inning, Salvador Perez'));
});

test('parses 2026 "NNN." format (SYNTHETIC line, format only)', () => {
  const e = parseEntryLine('007. 4/2 SEA@TOR -- In the bottom of the 4th inning, Test Player now has a single instead of reaching on an error.', 2026);
  assert.equal(e.seq, 7);
  assert.equal(e.date, '2026-04-02');
  assert.equal(e.away, 'SEA');
  assert.equal(e.home, 'TOR');
});

test('doubleheader suffixes and irregular heads are flagged, not guessed', () => {
  assert.deepEqual(parseSuffix('2'), { gameNumber: 2, flags: [] });
  assert.deepEqual(parseSuffix(' GM2'), { gameNumber: 2, flags: [] });
  assert.deepEqual(parseSuffix(' (GM1)'), { gameNumber: 1, flags: [] });
  assert.deepEqual(parseSuffix('!'), { gameNumber: null, flags: ['unexpected_suffix:!'] });
  const dh = parseEntryLine('12. 5/3 DET@CLE2 -- In the top of the 2nd inning, X now has a single instead of an error.', 2026);
  assert.equal(dh.home, 'CLE');
  assert.equal(dh.gameNumber, 2);
  const bang = parseEntryLine('239. 9/1 BOS@NYY! -- In the top of the 2nd inning, X now has a single instead of an error.', 2026);
  assert.equal(bang.home, 'NYY');
  assert.ok(bang.issues.includes('unexpected_suffix:!'));
  const nodate = parseEntryLine('11) LAA@HOU -- In the top of the 2nd inning, X now has a single instead of an error.', 2025);
  assert.equal(nodate.date, null);
  assert.ok(nodate.issues.includes('missing_date'));
});

test('inning parsing: digits, words, missing', () => {
  assert.deepEqual(parseInning('In the bottom of the first inning, x'), { half: 'bottom', inning: 1 });
  assert.deepEqual(parseInning('In the top of the 10th inning, x'), { half: 'top', inning: 10 });
  assert.deepEqual(parseInning('x reaches on a single'), { half: null, inning: null });
  const e = parseEntryLine('226. 8/20 AZ@NYM -- Somebody now has a single instead of an error.', 2026);
  assert.ok(e.issues.includes('missing_inning'));
});

test('parseLogText sections, numbering checks and stray numbered text', () => {
  const text = [
    'Menu', '1. Home', '2026 Regular Season',
    '001. 3/26 PIT@NYM -- In the bottom of the 3rd inning, A now has a single instead of an error.',
    '002. 3/27 CLE@KC -- In the top of the 1st inning, B now has a single instead of an error.',
    '004. 3/28 CLE@KC -- In the top of the 1st inning, C now has a single instead of an error.',
  ].join('\n');
  const secs = parseLogText(text);
  assert.equal(secs.length, 1);
  assert.equal(secs[0].season, 2026);
  assert.equal(secs[0].entries.length, 3, 'numbered nav text without "@ --" is ignored');
  assert.deepEqual(secs[0].issues, ['seq_gap:2->4']);
});

test('htmlToText + parseLogHtml handle <p>, <br>, entities', () => {
  const html = '<html><script>var x="1) 3/3 A@B -- no";</script><h2>2025 Regular Season</h2>'
    + '<p>1) 3/27 CLE@KC -- In the top of the 1st inning, Jos&eacute; Ram&iacute;rez reaches on a single, instead of an error.<br>'
    + '2) 3/28 CLE@KC &ndash; In the top of the 2nd inning, B reaches on a single, instead of an error.</p>';
  assert.ok(!htmlToText(html).includes('var x'), 'scripts are dropped');
  const secs = parseLogHtml(html);
  assert.equal(secs.length, 1);
  assert.equal(secs[0].entries.length, 2);
  assert.ok(secs[0].entries[0].body.includes('José Ramírez'));
  assert.equal(secs[0].entries[1].away, 'CLE');
});

// ------------------------------------------------------------ classifier
function cls(n) {
  const e = parseEntryLine(real2024[n], 2024);
  return classifyEntry(e.body);
}

test('sentence splitting keeps initials/Jr. but ends on "Jr. As a result"', () => {
  const s = splitSentences('X reaches on a double, instead of an error by first baseman LaMonte Wade Jr. As a result, the run is earned.');
  assert.equal(s.length, 2);
  const t = splitSentences('J.P. Crawford reaches on a single, instead of an error by Vladimir Guerrero Jr. at first.');
  assert.equal(t.length, 1);
});

test('error -> hit (T1, several phrasings)', () => {
  for (const n of [211, 213, 224, 228, 229]) {
    const c = cls(n);
    assert.equal(c.rule, 'T1', `#${n} rule`);
    assert.equal(c.initial, 'error', `#${n} initial`);
    assert.equal(c.final, 'hit', `#${n} final`);
    assert.ok(transitionFlags(c).errorToHit, `#${n} errorToHit`);
  }
  assert.equal(cls(213).finalHitType, 'double');
  assert.equal(cls(224).finalHitType, 'double');
  assert.equal(cls(229).finalHitType, 'single');
});

test('hit -> error (T1 and T3)', () => {
  for (const n of [210, 212, 220]) {
    const c = cls(n);
    assert.ok(transitionFlags(c).hitToError, `#${n} hitToError (${c.transition})`);
    assert.ok(!transitionFlags(c).errorToHit, `#${n} not errorToHit`);
  }
  assert.equal(cls(220).rule, 'T3');
});

test('error -> hit + error (T2 "originally scored") and T4 "error remains"', () => {
  const c222 = cls(222);
  assert.equal(c222.rule, 'T2');
  assert.equal(c222.initial, 'error');
  assert.equal(c222.final, 'hit+error');
  assert.ok(transitionFlags(c222).errorToHit);
  const c216 = cls(216);
  assert.equal(c216.rule, 'T4');
  assert.ok(transitionFlags(c216).errorToHit);
});

test('other ruling changes are not mistaken for error -> hit', () => {
  const c218 = cls(218);
  assert.equal(c218.transition, 'hit+error->hit');
  assert.ok(!transitionFlags(c218).errorToHit);
  const c227 = cls(227);
  assert.equal(c227.transition, 'fc+error->hit');
  assert.ok(transitionFlags(c227).fcToHit);
  assert.ok(!transitionFlags(c227).errorToHit);
  const c221 = cls(221);
  assert.equal(c221.rule, 'T2');
  assert.equal(c221.transition, 'fc->error');
});

test('bookkeeping-only entries', () => {
  assert.equal(cls(214).kind, 'error_removed');
  assert.equal(cls(215).kind, 'earned_run');
  assert.equal(cls(219).kind, 'rbi');
  assert.equal(cls(226).kind, 'wild_pitch_passed_ball');
});

console.log(`pipeline-log-test: ${passed} passed`);
