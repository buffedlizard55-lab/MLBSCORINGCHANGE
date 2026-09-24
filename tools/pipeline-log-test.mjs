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


// ---------------------------------------------------------------------------
// REAL fixtures added after the first GitHub Actions run (36041533035):
//  (a) 2024 entries 1-8, verbatim from the Internet Archive capture
//      https://web.archive.org/web/20250121083545/https://www.mlb.com/official-information/scoring-changes
//      — entries 1-7 use a single hyphen separator ("LAD@SD - In the ...").
//  (b) 2024 entry 84 (same capture): new ruling stated two sentences before
//      "originally ruled".
//  (c) The live 2026 page's markup (first 16 list items), byte-for-byte from
//      https://www.mlb.com/official-information/scoring-changes as fetched by
//      that run: an <ol> whose items carry NO number (the browser draws it).
// ---------------------------------------------------------------------------
const LOG_2024_FIRST = [
  "2024 Regular Season",
  "1) 3/20 LAD@SD - In the top of the 8th inning, pitcher Jhony Brito is now charged with two earned runs and pitcher Adrian Morejon is charged with no earned runs, instead of each pitcher being charged with one earned run.",
  "2) 3/21 SD@LAD - In the top of the 3rd inning, Fernando Tatis now has a single instead of an error charged to Max Muncy. As a result, one run in the inning is changed to earned against Michael Grove.",
  "3) 3/28 CLE@OAK - In the top of the 4th inning, after Austin Hedges' single, the missed catch error charged to Ryan Noda has been changed to a throwing error charged to Nick Allen.",
  "4) 3/28 CLE@OAK - In the bottom of the 4th inning, JJ Bleday now reaches on a throwing error charged to Brayan Rocchio instead of a missed catch error charged to Josh Naylor. Rocchio also loses an assist.",
  "5) 3/30 LAA@BAL - In the top of the 9th inning, after Nolan Schanuel's singe, the missed catch error charged to Mike Baumann has been changed to a throwing error charged to Ryan Mountcastle.",
  "6) 3/30 BOS@SEA - In the bottom of the 10th inning, the run scored by Josh Rojas has been changed to unearned against Joely Rodriguez.",
  "7) 3/31 CLE@OAK - In the bottom of the 6th inning, Ryan Noda is now credited with a sacrifice bunt and not charged a time at-bat.",
  "8) 3/30 MIL@NYM -- In the top of the 1st inning, the single for William Contreras has been changed to an error charged to Zack Short. As a result, 3 runs in the inning are changed to unearned against Luis Severino.",
].join('\n');

test('2024 single-hyphen entries parse (entries 1-8, verbatim)', () => {
  const [sec] = parseLogText(LOG_2024_FIRST);
  assert.equal(sec.season, 2024);
  assert.deepEqual(sec.entries.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(sec.issues, []);
  const e1 = sec.entries[0];
  assert.equal(e1.date, '2024-03-20');
  assert.equal(e1.away, 'LAD');
  assert.equal(e1.home, 'SD');
  assert.equal(e1.half, 'top');
  assert.equal(e1.inning, 8);
  assert.ok(e1.body.startsWith('In the top of the 8th inning, pitcher Jhony Brito'));
  const k = (i) => classifyEntry(sec.entries[i - 1].body);
  assert.equal(k(1).kind, 'earned_run');
  assert.equal(k(2).transition, 'error->hit');
  assert.equal(k(3).transition, 'error->error');
  assert.equal(k(4).transition, 'error->error');
  assert.equal(k(6).kind, 'earned_run');
  assert.equal(k(7).kind, 'sacrifice_credit', 'sacrifice credit (old ruling not stated) is bookkeeping');
  assert.equal(k(8).transition, 'hit->error');
});

test('2024 #84: new ruling found two sentences before "originally ruled"', () => {
  const c = classifyEntry("In the bottom of the 2nd inning, Jose Azocar is now safe at 1st on a dropped catch error by Josh Bell. An assist has been added for Otto Lopez. Azocar was originally ruled to have reached on a fielder's choice.");
  assert.equal(c.rule, 'T2');
  assert.equal(c.transition, 'fc->error');
});

const LIVE_2026_OL_HTML = "<p><strong>2026 Regular Season</strong></p><ol>\n<li><p>3/31 TB@MIL -- In the bottom of the 5th, assists have been added for Jake Fraley, Jonathan Aranda, Carson Williams, and Ben Williamson on the Brice Turang single.</p></li>\n<li><p>3/28 WSH@CHC -- In the bottom of the 6th, Dansby Swanson is now credited with a single instead of reaching on a fielders&#x27; choice.</p></li>\n<li><p>3/30 ATH@ATL -- In the bottom of the 4th, Ozzie Albies now has a single instead of a reaching on an error charged to Max Muncy.</p></li>\n<li><p>4/1 COL@TOR -- In the top of the 8th, Troy Johnston is now charged a caught stealing, safe on a throwing error charged to Tommy Nance. Johnston had been credited with a steal of 2nd.</p></li>\n<li><p>4/1 SF@SD -- In the bottom of the 1st, Manny Machado reaches on a missed catch by first baseman Casey Schmitt, instead of a throwing error on third baseman Matt Chapman.</p></li>\n<li><p>3/30 TEX@BAL -- In the top of the 6th, Brandon Nimmo now has a single, instead of reaching on an error charged to Gunnar Henderson.</p></li>\n<li><p>3/30 NYY@SEA -- In the top of the 2nd, Jazz Chisolm now has a double, instead of reaching a 2-base error charged to Leo Rivas.</p></li>\n<li><p>3/28 KC@ATL -- In the top of the 8th, Vinnie Pasquantino reaches on a fielder&#x27;s choice error charged to Matt Olson, instead of a straight error. As a result, Pasquantino gets no RBI and the run charged to Joel Payamps is now unearned.</p></li>\n<li><p>4/1 SF@SD -- In the bottom of the 1st, Manny Machado reaches on a missed catch error by Casey Schmitt, with an assist to Matt Chapman, instead of reaching via a single plus a throwing error by Chapman.</p></li>\n<li><p>4/5 CHC@CLE2 -- In the top of the 9th, Scott Kingery is now credited with a stolen base. The advance had been ruled as defensive indifference.</p></li>\n<li><p>4/5 MIA@NYY -- In the bottom of the 3rd, the missed catch error charged to Otto Lopez has been changed to a throwing error charged to Connor Nordby. As a result, Nordby loses an assist.</p></li>\n<li><p>4/7 LAD@TOR -- In the top of the 9th, the run scored by Alex Freeland has been changed to earned for pitcher Jeff Hoffman, instead of unearned.</p></li>\n<li><p>4/7 LAD@TOR -- In the top of the 3rd, Alex Freeland now is credited with reaching base on a single, instead of on a sacrifice fielders choice.</p></li>\n<li><p>4/7 CIN@MIA -- In the bottom of the 6th, Heriberto Hernandez now advances to 2nd base on a stolen base, instead of on an obstruction error by second baseman Matt McLain.</p></li>\n<li><p>4/4 BAL@PIT -- In the bottom of the 4th, Bryan Reynolds now reaches on a single, instead of an error by pitcher Shane Baz. As a result, the run scored by Reynolds later in the inning is now earned for Baz, instead of unearned.</p></li>\n<li><p>4/3 TB@MIN -- In the bottom of the 7th, Luke Keaschall now reaches on an error by third baseman Junior Caminero, instead of on a single.</p></li></ol>";

test('live 2026 <ol> markup: numbers come from list position', () => {
  const html = `<html><body><p>The below details all Official Scoring changes.</p>${LIVE_2026_OL_HTML}</body></html>`;
  const sections = parseLogHtml(html);
  assert.equal(sections.length, 1);
  const [sec] = sections;
  assert.equal(sec.label, '2026 Regular Season');
  assert.equal(sec.season, 2026);
  assert.deepEqual(sec.entries.map((e) => e.seq), Array.from({ length: 16 }, (_, i) => i + 1));
  const e = (n) => sec.entries[n - 1];
  assert.equal(e(1).date, '2026-03-31');
  assert.equal(e(1).away, 'TB');
  assert.equal(e(1).home, 'MIL');
  assert.equal(e(1).half, 'bottom');
  assert.equal(e(1).inning, 5);
  assert.equal(e(10).home, 'CLE');
  assert.equal(e(10).gameNumber, 2, 'CHC@CLE2 → game 2 of a doubleheader');
  assert.ok(!e(2).body.includes('&#x27;'), 'entities decoded');
  const k = (n) => classifyEntry(e(n).body);
  assert.equal(k(1).kind, 'fielding_credit');
  assert.equal(k(2).transition, 'fc->hit');
  assert.equal(k(3).transition, 'error->hit');
  assert.ok(transitionFlags(k(3)).errorToHit);
  assert.equal(k(4).kind, 'baserunning', 'caught stealing vs steal is not a play ruling');
  assert.equal(k(5).transition, 'error->error');
  assert.equal(k(6).transition, 'error->hit');
  assert.equal(k(7).transition, 'error->hit');
  assert.equal(k(7).finalHitType, 'double');
  assert.equal(k(8).transition, 'error->fc+error');
  assert.equal(k(9).transition, 'hit+error->error');
  assert.equal(k(10).kind, 'baserunning');
  assert.equal(k(12).kind, 'earned_run');
  assert.equal(k(13).transition, 'fc->hit');
  assert.equal(k(14).kind, 'baserunning', 'stolen base instead of obstruction error');
  assert.equal(k(15).transition, 'error->hit');
  assert.equal(k(16).transition, 'hit->error');
  assert.ok(transitionFlags(k(16)).hitToError);
});

test('<ol start> and reversed numbering follow browser rules', () => {
  const t1 = htmlToText('<ol start="5"><li>a</li><li>b</li></ol>');
  assert.equal(t1, '5. a\n6. b');
  const t2 = htmlToText('<ol reversed><li>a</li><li>b</li><li>c</li></ol>');
  assert.equal(t2, '3. a\n2. b\n1. c');
});

test('team separator variants (real lines: 2024 #77 "ARI-LAD", 2025 #157 "SD at SF")', () => {
  const a = parseEntryLine('77) 5/20 ARI-LAD -- In the bottom of the 1st inning, Shohei Ohtani reaches on a throwing error by pitcher Joe Mantiply, instead of a bunt single to Mantiply.', 2024);
  assert.equal(a.away, 'ARI');
  assert.equal(a.home, 'LAD');
  assert.equal(a.date, '2024-05-20');
  assert.ok(a.issues.includes('team_separator:-'));
  assert.equal(classifyEntry(a.body).transition, 'hit->error');
  const b = parseEntryLine('157) 8/11 SD at SF -- In the top of the 8th inning, Xander Bogaerts now reaches on a single, instead of an error by third baseman Matt Chapman.', 2025);
  assert.equal(b.away, 'SD');
  assert.equal(b.home, 'SF');
  assert.ok(b.issues.includes('team_separator:at'));
  assert.equal(classifyEntry(b.body).transition, 'error->hit');
  const c = parseEntryLine('8) 3/30 MIL@NYM -- In the top of the 1st inning, x.', 2024);
  assert.ok(!c.issues.some((i) => i.startsWith('team_separator')), '"@" is not flagged');
});


// Real official lines (verbatim from the 2024/2025 Internet Archive captures
// and the live 2026 page) covering classifier rules added after reviewing
// every "unclassified" entry. Entries still unclassified on purpose:
// 2025 #87 ("infield since" — official typo) and 2025 #187 ("He has been
// credited with…" — tense makes the old/new ruling ambiguous).
const CLASSIFIER_FIXTURES = [
  [2024, "59) 4/30 WSH@TEX -- In the bottom of the 7th inning, Nathaniel Lowe's single has been changed to a fielder's choice.", "hit->fc"],
  [2024, "48) 4/24 NYM@SF -- In the top of the 4th inning, Harrison Bader reaches on an infield single to third base Matt Chapman and advances to second on a throwing error by Chapman. It was originally a two-base throwing error.", "error->hit+error"],
  [2024, "106) 6/23 BOS@CIN -- The winning pitcher is Brennan Bernardino, not Greg Weissert.", "pitching_decision"],
  [2024, "181) 8/25 CHC@MIA -- In the bottom of the 8th inning, Jesus Sanchez is now out catcher Miguel Amaya unassisted, instead of an intentional walk. Sanchez failed to touch first base and was ruled out.", "other_pa->out"],
  [2024, "192) 8/31 STL@NYY -- In the bottom of the 8th inning, Juan Soto is now charged with grounding into a double play.", "double_play_credit"],
  [2024, "71) 5/16 NYM@PHI -- In the top of the 8th inning, a throwing error has been charged to Brandon Marsh for allowing Pete Alonso to advance to 3rd base following Harrison Bader's single.", "error_added"],
  [2025, "202) 9/16 SEA @ KC -- In the bottom of the 3rd inning, Vinnie Pasquantino reached on what was ruled a fielder's choice and an error. This has been changed to a base hit, removing the error for Jorge Polanco.", "fc+error->hit"],
  [2025, "159) 8/17 TB@SF -- In the bottom of the 6th inning, Dominic Smith is now credited with 2 RBIs on his single with the 3rd run scoring on a throw to 2nd base, instead of 3 RBIs.", "rbi"],
  [2025, "87) 6/14 CHW@TEX -- In the bottom of the 8th inning, Corey Seager reached on an infield since, instead of an error on Brooks Baldwin.", "unclassified"],
  [2025, "187) 9/8 WSH@MIA -- In the top of the 4th inning, Dylan Crews is now credited with a double. He has been credited with a single, advancing to 2nd base on the throw.", "unclassified"],
  [2026, "236. 8/30 COL@ATL -- In the bottom of the 6th, Ozzie Albies single has been changed to a double.", "hit->hit"],
  [2026, "210. 8/6 NYM@CLE -- In the top of the 7th A.J. Ewing's bunt groundout has been changed to a sacrifice bunt.", "out->sac"],
  [2026, "145. 6/23 MIL@CIN -- In the top of the 3rd, Blake Perkins reaches on a throwing error by second baseman Edwin Arroyo, instead of catcher's interference on Jose Trevino.", "other_pa->error"],
  [2026, "250. 9/17 DET@CWS -- In the top of the 8th, Brett Callahan is out on a play at third base, third baseman Miguel Vargas to first baseman Munetaka Murakami to third baseman Miguel Vargas, instead of Murakami to Vargas.", "fielding_credit"],
  [2026, "55. 4/24 LAA@KC -- In the bottom of the 4th, Starling Marte is now credited with a sacrifice fly.", "sacrifice_credit"],
];

test('classifier on real entries: possessive changes, "originally", other PA results, bookkeeping kinds', () => {
  for (const [season, raw, expected] of CLASSIFIER_FIXTURES) {
    const e = parseEntryLine(raw, season);
    const c = classifyEntry(e.body);
    const got = c.kind === 'ruling_change' ? c.transition : c.kind;
    assert.equal(got, expected, `${season} ${raw.slice(0, 60)}`);
  }
  const c202 = classifyEntry(parseEntryLine(CLASSIFIER_FIXTURES.find((f) => f[1].startsWith('202)'))[1], 2025).body);
  assert.equal(c202.final, 'hit', '"removing the error" does not make the new ruling hit+error');
});

test('runner / RBI changes on a hit are not error → hit (real 2024–2025 wording)', () => {
  // 2025 #55: the batter doubled either way; only the error on his advance was removed.
  const a = classifyEntry('In the bottom of the 6th inning, Austin Hays doubled and advanced to third base on the throw home, instead of doubling and advancing to third base on a throwing error by Jose Ramirez.');
  assert.equal(a.transition, 'hit+error->hit');
  assert.equal(transitionFlags(a).errorToHit, false);
  // 2025 #128: a runner's error reassigned; "on the Riley Adams single" is context.
  const b = classifyEntry('In the bottom of the 6th inning, on the Riley Adams single, Brady House now scores on a fielding error by catcher Tyler Stephenson, instead of a throwing error by right fielder Jake Fraley.');
  assert.equal(b.transition, 'error->error');
  assert.equal(transitionFlags(b).errorToHit, false);
  // 2024 #49: RBI credit on the same single.
  const c = classifyEntry('In the bottom of the 6th inning, Jonah Heim now has a two-run single and advances to third on error by right fielder Mitch Haniger, instead of one run batted in and one run scoring on the error.');
  assert.notEqual(c.kind, 'ruling_change');
  // Counter-examples that must keep their ruling change (2025 #101, #117, #191 — verbatim).
  assert.equal(classifyEntry('In the bottom of the 8th inning, Jose Trevino reaches on a throwing error by shortstop Anthony Volpe, instead of an RBI single. As a result, the run is unearned to Mark Leiter.').transition, 'hit->error');
  assert.equal(classifyEntry('In the bottom of the 9th inning, Noelvi Marte now reaches on a fielders choice and gets credit for a run batted in that scored Will Benson, instead of the run scoring on an error by second baseman Orlando Arcia and Marte not getting a run batted in. As a result, the run scored by Benson is now an earned run for pitcher Victor Vodnik, instead of unearned.').transition, 'error->fc');
  assert.equal(classifyEntry('In the top of the 8th inning, Royce Lewis now reaches base on a single, instead of on an error by third baseman Yoan Moncada., As a result, Lewis is now credited with a run batted in, and the run that scored is now earned for pitcher Sammy Peralta, instead of unearned.').transition, 'error->hit');
});

console.log(`pipeline-log-test: ${passed} passed`);
