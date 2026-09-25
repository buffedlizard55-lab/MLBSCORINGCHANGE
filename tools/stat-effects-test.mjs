#!/usr/bin/env node
/* tools/stat-effects-test.mjs — pins pipeline/lib/stat-effects.mjs against
 * VERBATIM entries of MLB's official scoring-changes log (the season and
 * entry number are given for each, so every case can be checked by hand at
 * https://www.mlb.com/official-information/scoring-changes or in
 * data/official/raw/scoring-changes-<season>.txt). No synthetic text except
 * where labelled SYNTHETIC. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyEntry } from '../pipeline/lib/log-classifier.mjs';
import { statEffects, parseRbi, parseEarned, deltaText } from '../pipeline/lib/stat-effects.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
function t(name, fn) {
  try { fn(); passed += 1; } catch (err) { console.error(`FAIL ${name}`); throw err; }
}
const eff = (body, play = {}) => statEffects({ body, cls: classifyEntry(body) }, play);
const find = (list, stat) => list.filter((d) => d.stat === stat);

// 2026 #249 — the session-5 example (CIN@MIL 9/11).
t('2026 #249 Vaughn loses an RBI; 1 run unearned against Abbott', () => {
  const body = 'In the bottom of the 1st, following the double for Andrew Vaughn, an error has been charged to JJ Bleday for allowing Brice Turang to score. As a result, Vaughn loses an RBI and 1 run is changed to unearned against Andrew Abbott.';
  const r = eff(body, { batterName: 'Andrew Vaughn', batterId: 683734, pitcherName: 'Andrew Abbott', currentEventType: 'double' });
  assert.equal(r.battingChange, true);
  assert.equal(r.pitchingChange, true);
  const rbi = find(r.batting, 'RBI');
  assert.equal(rbi.length, 1);
  assert.equal(rbi[0].delta, -1);
  assert.equal(rbi[0].player, 'Andrew Vaughn');
  assert.equal(find(r.batting, 'H').length, 0, 'the double stands: no hit change');
  const er = find(r.pitching, 'ER')[0];
  const uer = find(r.pitching, 'UER')[0];
  assert.equal(er.delta, -1); assert.equal(uer.delta, 1);
  assert.equal(er.player, 'Andrew Abbott');
  assert.equal(er.playerSource, 'official_text');
  assert.match(er.evidence, /1 run is changed to unearned against Andrew Abbott/);
});

// 2026 #211 — hit → error with RBI + earned-run effects.
t('2026 #211 double → error: H −1, RBI −1, ER −1 / UER +1', () => {
  const body = 'In the top of the 8th, the double for Vaughn Grissom has been changed to an error charged to Christian Encarnacion-Strand. As a result, Grissom loses an RBI and 1 run is changed to unearned against Andrew Kittredge.';
  const r = eff(body, { batterName: 'Vaughn Grissom', pitcherName: 'Andrew Kittredge', currentEventType: 'field_error' });
  assert.equal(find(r.batting, 'H')[0].delta, -1);
  assert.equal(find(r.pitching, 'H')[0].delta, -1);
  assert.equal(find(r.pitching, 'H')[0].playerSource, 'linked_play_pitcher');
  assert.equal(find(r.batting, 'RBI')[0].delta, -1);
  assert.equal(find(r.pitching, 'ER')[0].player, 'Andrew Kittredge');
});

// 2024 #34 — both counts stated.
t('2024 #34 "1 run batted in … instead of 2" → RBI −1', () => {
  const r = parseRbi('In the top of the 5th inning, Jonatan Clase is now credited with 1 run batted in on his single, instead of 2 runs batted in.');
  assert.equal(r.delta, -1);
});

// 2024 #49 — "two-run single … instead of one run batted in" → +1.
t('2024 #49 two-run single instead of one RBI → RBI +1', () => {
  const r = parseRbi('In the bottom of the 6th inning, Jonah Heim now has a two-run single and advances to third on error by right fielder Mitch Haniger, instead of one run batted in and one run scoring on the error.');
  assert.equal(r.delta, 1);
});

// 2026 #165 — original state in one sentence, new state in the next.
t('2026 #165 2-RBI double changed to only one RBI → RBI −1, no hit change', () => {
  const body = 'In the top of the 5th, Wilyer Abreu hit what was originally ruled a 2-RBI double. This has been changed to only one RBI as the second runner stopped as he rounded third and only attempted to score when the throw from the cutoff man went to second base.';
  const r = eff(body, { batterName: 'Wilyer Abreu', currentEventType: 'double' });
  assert.equal(find(r.batting, 'RBI')[0].delta, -1);
  assert.equal(find(r.batting, 'H').length, 0);
});

// 2025 #101 — RBI named only in the original ruling: direction not stated.
t('2025 #101 "instead of an RBI single" → RBI direction not stated (was 1)', () => {
  const body = 'In the bottom of the 8th inning, Jose Trevino reaches on a throwing error by shortstop Anthony Volpe, instead of an RBI single. As a result, the run is unearned to Mark Leiter.';
  const r = eff(body, { batterName: 'Jose Trevino' });
  const rbi = find(r.batting, 'RBI')[0];
  assert.equal(rbi.sign, null);
  assert.equal(rbi.old, 1);
  assert.match(deltaText(rbi), /direction not stated/);
  assert.equal(find(r.pitching, 'ER')[0].player, 'Mark Leiter');
});

// 2025 #196 — MLB's own typo "uneanred" and "3 of the 4 … instead of just 1 of 4".
t('2025 #196 typo + new-minus-old count → ER −2 / UER +2', () => {
  const effs = parseEarned('As a result, 3 of the 4 runs scored that inning are uneanred to Pallante, instead of just 1 of 4 being unearned.');
  const er = effs.find((e) => e.stat === 'ER');
  assert.equal(er.delta, -2);
  assert.equal(er.pitcher, 'Pallante');
  assert.equal(er.typo, 'uneanred');
});

// 2024 #50 — noun use + additional / one less.
t('2024 #50 one additional earned run to Turnbull, one less to Marte', () => {
  const body = "In the bottom of the 6th inning, the assigning of earned runs on Luis Rengifo's single have been reversed. One additional earned run has been charged to Spencer Turnbull and one less to Yunior Marte.";
  const r = eff(body);
  assert.deepEqual(r.pitching.map((p) => [p.stat, p.delta, p.player]), [['ER', 1, 'Spencer Turnbull'], ['ER', -1, 'Yunior Marte']]);
  assert.equal(r.unparsed.length, 0);
});

// 2024 #196 (NYY@TEX 9/3) — team unearned: no pitcher stat change.
t('team unearned is not a pitcher stat change', () => {
  const body = 'In the bottom of the 8th inning, the run scored by Marcus Semien has been changed from earned to team unearned. No player stats are affected.';
  const r = eff(body);
  assert.equal(r.pitchingChange, false);
  assert.equal(r.noPlayerStats, true);
});

// 2024 #93 — hit → FC/error with one run unearned.
t('2024 #93 single → FC/error: H −1, ER −1 against Stroman', () => {
  const body = "In the bottom of the 2nd inning, the single for Patrick Bailey has been changed to a fielder's choice/error charged to Gleyber Torres. As a result, one run in the inning is changed to unearned against Marcus Stroman.";
  const r = eff(body, { batterName: 'Patrick Bailey' });
  assert.equal(find(r.batting, 'H')[0].delta, -1);
  assert.equal(find(r.pitching, 'ER')[0].delta, -1);
  assert.equal(find(r.pitching, 'ER')[0].player, 'Marcus Stroman');
});

// "all runs in the inning" — count not stated → null, never guessed.
t('2026 #242 "all runs in the inning now earned" → count null', () => {
  const effs = parseEarned('This now gives Young 1 RBI on the play and makes all runs in the inning now earned to Griffin Jax.');
  const er = effs.find((e) => e.stat === 'ER');
  assert.equal(er.delta, null);
  assert.equal(er.sign, 1);
  assert.equal(er.pitcher, 'Griffin Jax');
});

// 2026 #90 (LAA@CLE 5/13) — names with particle-like prefixes ("De"tmers)
// must not be truncated to "Reid De".
t('2026 #90 pitcher "Reid Detmers" is read whole', () => {
  const effs = parseEarned('This now makes the run scored by Hoskins later in the inning unearned for pitcher Reid Detmers.');
  assert.equal(effs[0].pitcher, 'Reid Detmers');
  assert.equal(effs.find((e) => e.stat === 'ER').delta, -1);
});

// Walk → out (2024 #181): pitcher BB −1.
t('2024 #181 intentional walk → out: BB −1', () => {
  const body = 'In the bottom of the 8th inning, Jesus Sanchez is now out catcher Miguel Amaya unassisted, instead of an intentional walk. Sanchez failed to touch first base and was ruled out.';
  const r = eff(body, { pitcherName: 'P' });
  assert.equal(find(r.pitching, 'BB')[0].delta, -1);
});

// A hit change StatsAPI contradicts is flagged, not emitted (2026 #84 style).
t('hit change contradicted by StatsAPI is flagged', () => {
  const body = 'In the top of the 2nd, Jordan Walker now has a double instead of an error charged to Zack Gelof.';
  const r = eff(body, { currentEventType: 'field_out' });
  assert.equal(find(r.batting, 'H').length, 0);
  assert.deepEqual(r.flags, ['hit_change_contradicted_by_statsapi']);
});

// Whole-log sweep: every committed official entry parses without leftovers.
t('every committed official entry (2024–2026) has no unparsed stat sentence', () => {
  let n = 0;
  for (const f of fs.readdirSync(path.join(ROOT, 'data/official')).filter((x) => /^scoring-changes-\d{4}\.json$/.test(x))) {
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/official', f), 'utf8'));
    for (const e of d.entries) {
      const r = statEffects({ body: e.body, cls: e.cls }, {});
      assert.deepEqual(r.unparsed, [], `${f} #${e.seq}: ${r.unparsed.join(' | ')}`);
      n += 1;
    }
  }
  assert.ok(n > 600, `swept ${n} entries`);
});

console.log(`stat-effects-test: ${passed} passed`);
