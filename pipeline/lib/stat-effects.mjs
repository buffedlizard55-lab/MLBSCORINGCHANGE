/* ============================================================================
 * pipeline/lib/stat-effects.mjs — which player STATISTICS an official
 * scoring-change entry moves (session-5 charter).
 *
 *   Batting  (primary alert system): R, H, RBI
 *   Pitching (own section, never the primary alerts): H allowed, BB, K,
 *            ER (earned runs), UER (unearned runs)
 *
 * Every delta is read from ONE of two places, and nothing else:
 *   1. the classifier's ruling transition (log-classifier.mjs): a hit that
 *      became a non-hit (or back) moves the batter's H and the pitcher's H
 *      allowed; a walk / strikeout named on one side only moves BB / K;
 *   2. the entry's own words ("Vaughn loses an RBI", "1 run is changed to
 *      unearned against Andrew Abbott").
 * Each delta carries the exact clause (`evidence`) and the rule that read it,
 * so a human can check it against the official text. When the log does not
 * state a count ("all the runs in the inning are now earned"), the delta is
 * `null` with the direction kept in `sign` — never a guessed number. The
 * player is named only from the text or from the play the linker verified in
 * StatsAPI (the batter / pitcher of that plate appearance), and the source of
 * the name is recorded (`playerSource`).
 *
 * Sentences that mention RBIs or (un)earned runs but yield no delta are
 * returned in `unparsed`; the pipeline lists them as irregularities.
 * Pure: no I/O.
 * ==========================================================================*/

import { splitSentences } from './log-classifier.mjs';

const NUM_WORDS = {
  a: 1, an: 1, one: 1, single: 1, two: 2, both: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};
function toNum(tok) {
  if (tok == null) return null;
  const t = String(tok).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (/^\d+$/.test(t)) return Number(t);
  return Object.prototype.hasOwnProperty.call(NUM_WORDS, t) ? NUM_WORDS[t] : null;
}

const HIT_CATS = new Set(['hit', 'hit+error']);
const WALK_RE = /\b(intentional walk|intentionally walked|walk|walks|walked|base on balls)\b/i;
const K_RE = /\b(strike ?out|strikes out|struck out|strikeout)\b/i;
const RBI_RE = /\b(rbi'?s?|runs? batted in)\b/i;
const EARNED_RE = /\b(un)?earned\b/i;
const NO_PLAYER_STATS_RE = /no player stats are affected/i;
// A capitalised name (allows particles and initials already de-dotted by the
// sentence splitter, e.g. "Enyel De Los Santos", "LaMonte Wade Jr").
const NAME = "[A-Z][A-Za-z.'\u2019-]*(?:\\s+(?:(?:de|De|del|Del|la|La|Los|los|Se|Jr|Sr|II|III)\\b|[A-Z][A-Za-z.'\u2019-]*))*";

/** Clauses for (un)earned parsing: split on ';' and ', and ' only. */
function earnedClauses(sentence) {
  return String(sentence).split(/\s*;\s*|,\s+and\s+/).map((s) => s.trim()).filter(Boolean);
}

/** Part of a clause before "instead of" — the NEW state. */
function headOf(text) {
  const i = String(text).search(/\binstead of\b/i);
  return i >= 0 ? String(text).slice(0, i) : String(text);
}

/* ------------------------------------------------------------------ RBI */
/**
 * RBI delta in one sentence. Returns null when the sentence has no RBI
 * mention; otherwise { delta, sign, now, rule } (delta/now may be null).
 */
export function parseRbi(sentence) {
  const s = String(sentence || '');
  if (!RBI_RE.test(s)) return null;
  // Remove "run(s) batted in" → "RBI" so number look-behind is uniform.
  const norm = s.replace(/\bruns batted in\b/gi, 'RBIs').replace(/\brun batted in\b/gi, 'RBI')
    .replace(/\bRBI'?s\b/gi, 'RBIs').replace(/\b(\d+|one|two|three|four)-RBI\b/gi, '$1 RBI');
  const numBefore = (text) => {
    // "2 RBIs", "two RBI", "an RBI", "the RBI", "a RBI", "one RBI",
    // "1 additional RBI", "no RBI"
    const m = /\b(no|an|a|the|one|two|three|four|five|six|\d+)\s+(?:additional\s+|more\s+)?RBIs?\b/i.exec(text);
    if (!m) return undefined;
    if (/^no$/i.test(m[1])) return 0;
    if (/^the$/i.test(m[1])) return 1;
    return toNum(m[1]);
  };
  const lower = norm.toLowerCase();
  // "has 2 RBI's on the play instead of 1" / "a double and two RBI …, instead
  // of a triple and three RBI": both sides stated → exact delta.
  const io = lower.search(/\binstead of\b/);
  if (io >= 0) {
    const newer = norm.slice(0, io);
    const older = norm.slice(io);
    let nNew = numBefore(newer);
    // "now has a two-run single … instead of one run batted in" (2024 #49)
    const nRun = /\b(two|three|four|\d)-run\s+(?:single|double|triple|home run|homer)\b/i.exec(newer);
    if (nNew === undefined && nRun) nNew = toNum(nRun[1]);
    let nOld = numBefore(older);
    if (nOld === undefined) {
      const m = /instead of\s+(\d+|one|two|three|four)\b/i.exec(older);
      if (m) nOld = toNum(m[1]);
    }
    if (typeof nNew === 'number' && typeof nOld === 'number' && nNew !== nOld) {
      return { delta: nNew - nOld, sign: Math.sign(nNew - nOld), now: nNew, rule: 'rbi:new_instead_of_old' };
    }
  }
  const n = numBefore(norm);
  // The RBI is named only in the ORIGINAL ruling ("originally ruled a 2-RBI
  // double", "instead of an RBI single"): the old state, not a stated change.
  if (/\boriginally\b/i.test(norm) && !/\b(loses?|removes?|removed|no longer|gets?|credited|changed)\b/i.test(norm)) {
    return { delta: null, sign: null, now: null, old: typeof n === 'number' ? n : null, rule: 'rbi:original_state' };
  }
  if (io >= 0 && !RBI_RE.test(s.slice(0, s.toLowerCase().search(/\binstead of\b/))) &&
      !/\b(loses?|removes?|removed|no longer|gets?|credited)\b/i.test(norm)) {
    // Direction NOT stated by the log (a reach on an error can still carry an
    // RBI): sign null; the pipeline may settle it from StatsAPI's current RBI.
    return { delta: null, sign: null, now: null, old: typeof n === 'number' ? n : null, rule: 'rbi:only_in_original_ruling' };
  }
  // "changed to only one RBI"
  if (/\bonly\s+(?:one|two|three|\d+)\s+RBIs?\b/i.test(norm) && typeof n === 'number') {
    return { delta: null, sign: -1, now: n, rule: 'rbi:only_now' };
  }
  // Negative wording first ("no longer is credited" contains "credited").
  if (/\b(loses?|lost|removes?|removed|removing|no longer|gets no|not credited|without)\b/i.test(norm) ||
      /\bno\s+(?:credit|RBIs?)\b/i.test(norm)) {
    if (/\bno RBIs?\b|there is now no RBI|gets no RBI/i.test(norm)) {
      return { delta: null, sign: -1, now: 0, rule: 'rbi:none_now' };
    }
    if (/\bonly\b/i.test(norm) && typeof n === 'number') {
      return { delta: null, sign: -1, now: n, rule: 'rbi:only_now' };
    }
    return { delta: typeof n === 'number' && n > 0 ? -n : null, sign: -1, now: null, rule: 'rbi:loses' };
  }
  // Absolute wording ("now has an RBI", "has 2 RBIs", "gives Young 1 RBI on
  // the play"): the play's RBI total now, not a stated change.
  if (/\b(now has|has(?!\s+been)|gives|now gives)\b/i.test(norm) && !/\badditional\b/i.test(norm)) {
    return { delta: null, sign: 1, now: typeof n === 'number' ? n : null, rule: 'rbi:now_has' };
  }
  if (/\b(gets?|credited|credit|additional|adds?|added|awarded)\b/i.test(norm)) {
    return { delta: typeof n === 'number' && n > 0 ? n : null, sign: 1, now: null, rule: 'rbi:gets' };
  }
  return { delta: null, sign: null, now: null, rule: 'rbi:unparsed' };
}

/* -------------------------------------------------------- earned runs */
/** How many runs a clause talks about, or null when the log does not say. */
function runCount(head) {
  // Ignore "run(s) batted in" — those are RBIs.
  const text = head.replace(/\bruns? batted in\b/gi, 'RBI');
  const m = /\bruns?\b/i.exec(text);
  if (!m) return { n: null, found: false };
  const before = text.slice(0, m.index).trim().split(/\s+/).slice(-5);
  const plural = /runs/i.test(m[0]);
  const lw = before.map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, ''));
  // "one of the (2) runs" / "two of the runs"
  const ofIdx = lw.lastIndexOf('of');
  if (ofIdx > 0 && toNum(lw[ofIdx - 1]) != null && lw[ofIdx - 1] !== 'a' && lw[ofIdx - 1] !== 'an') {
    return { n: toNum(lw[ofIdx - 1]), found: true };
  }
  for (let i = lw.length - 1; i >= 0; i -= 1) {
    const w = lw[i];
    if (w === 'all' || w === 'the' || w === 'this' || w === 'that' || w === 'last' || w === 'final' ||
        w === 'first' || w === 'additional' || w === 'earned' || w === 'unearned' || w === 'more') continue;
    const n = toNum(w);
    if (n != null) return { n, found: true };
    break;
  }
  if (!plural) return { n: 1, found: true };
  // "the runs scored by Enrique Hernandez and Miguel Rojas": count the names.
  const by = new RegExp(`\\bruns\\s+scored\\s+by\\s+(${NAME}(?:\\s*,\\s*${NAME})*\\s+and\\s+${NAME})`).exec(head);
  if (by) return { n: by[1].split(/\s*,\s*|\s+and\s+/).length, found: true };
  return { n: null, found: true };
}

/** Pitcher named in an earned-run clause (head only), or null. */
function cleanName(n) { return String(n || '').replace(/[.\s]+$/, '').trim() || null; }
function pitcherIn(head) {
  const re = new RegExp(`\\b(?:against|to|for|charged to|charged against)\\s+(?:pitchers?\\s+|P\\s+)?(${NAME})`, 'g');
  let m; let last = null;
  while ((m = re.exec(head))) {
    const name = m[1].trim();
    // Skip non-names the pattern can catch ("to Earned", "for The").
    if (/^(Earned|Unearned|The|This|That|One|Two|Three|All|Both)$/i.test(name)) continue;
    last = name;
  }
  return cleanName(last);
}

/** Several pitchers in one clause: "one to X and one to Y" / "X (one run) and Y (two runs)". */
function multiPitchers(head) {
  const out = [];
  const re1 = new RegExp(`\\b(one|two|three|four|\\d+)\\s+(?:runs?\\s+)?(?:to|for)\\s+(${NAME})`, 'g');
  let m;
  while ((m = re1.exec(head))) out.push({ n: toNum(m[1]), pitcher: cleanName(m[2]) });
  if (out.length >= 2) return out;
  const re2 = new RegExp(`(${NAME})\\s*\\((one|two|three|four|\\d+)\\s+runs?\\)`, 'g');
  const out2 = [];
  while ((m = re2.exec(head))) out2.push({ n: toNum(m[2]), pitcher: cleanName(m[1].replace(/^(?:pitchers?|and)\s+/i, '')) });
  return out2.length >= 2 ? out2 : null;
}

/**
 * Earned-run effects of one clause → [{ stat, delta, sign, pitcher, rule, teamOnly }]
 * (empty when the clause is not about earned runs).
 */
// Misspellings seen in MLB's own log (2025 #196 "uneanred"); normalised so
// the clause parses, and reported through `typo` on the delta.
const EARNED_TYPOS = [[/\buneanred\b/gi, 'unearned'], [/\bunerned\b/gi, 'unearned'], [/\bearend\b/gi, 'earned']];
export function normalizeEarnedTypos(text) {
  let out = String(text || '');
  let typo = null;
  for (const [re, fix] of EARNED_TYPOS) {
    if (re.test(out)) { typo = (typo ? `${typo}, ` : '') + out.match(re)[0]; out = out.replace(re, fix); }
    re.lastIndex = 0;
  }
  return { text: out, typo };
}

export function parseEarned(clauseIn) {
  const { text: c, typo } = normalizeEarnedTypos(clauseIn);
  const effs = parseEarnedInner(c);
  return typo ? effs.map((e) => ({ ...e, typo })) : effs;
}

function parseEarnedInner(clause) {
  const c = String(clause || '');
  if (!EARNED_RE.test(c)) return [];
  const head = headOf(c);
  const hl = head.toLowerCase();
  // Team-unearned: the pitcher's own line is unchanged (official wording:
  // "changed from earned to team unearned. No player stats are affected.").
  if (/\bteam unearned\b/.test(hl)) return [{ stat: 'UER', delta: null, sign: 0, pitcher: pitcherIn(head), rule: 'earned:team_unearned', teamOnly: true }];
  // "One additional earned run has been charged to X and one less to Y"
  const addLess = new RegExp(`\\b(one|two|\\d+)\\s+additional\\s+earned\\s+runs?\\s+(?:has|have)\\s+been\\s+charged\\s+to\\s+(${NAME})\\s+and\\s+(one|two|\\d+)\\s+less\\s+to\\s+(${NAME})`, 'i').exec(head);
  if (addLess) {
    return [
      { stat: 'ER', delta: toNum(addLess[1]), sign: 1, pitcher: cleanName(addLess[2]), rule: 'earned:additional' },
      { stat: 'ER', delta: -toNum(addLess[3]), sign: -1, pitcher: cleanName(addLess[4]), rule: 'earned:one_less' },
    ];
  }
  // "The earned run is now charged to X" / "The unearned run is now charged to X": moved between pitchers.
  const moved = new RegExp(`\\bthe\\s+(un)?earned\\s+run\\s+is\\s+now\\s+charged\\s+to\\s+(${NAME})`, 'i').exec(head);
  if (moved) {
    return [{ stat: moved[1] ? 'UER' : 'ER', delta: 1, sign: 1, pitcher: cleanName(moved[2]), rule: 'earned:reassigned' }];
  }
  // "one additional earned run" (no "one less" part)
  const add = /\b(one|two|three|\d+)\s+additional\s+earned\s+runs?\b/i.exec(head);
  let target = null;
  const fromTo = /\bfrom\s+(un)?earned\s+to\s+(un)?earned\b/i.exec(head);
  if (fromTo) target = fromTo[2] ? 'unearned' : 'earned';
  else if (/\bunearned\b/i.test(head)) target = 'unearned';
  else if (/\bearned\b/i.test(head)) target = 'earned';
  if (!target) return [];
  // "the assigning of earned runs … have been reversed" (2024 #50): the word
  // is a noun here, not the runs' new state — no delta from this clause.
  if (/\b(?:un)?earned\s+runs?\b/i.test(head) &&
      !/\b(?:charged|changed to|is now|are now|now an?|now|become|becomes|makes?|making|to be)\b/i.test(head)) return [];
  const multi = multiPitchers(head);
  const mk = (n, pitcher, rule) => (target === 'unearned'
    ? [{ stat: 'ER', delta: n != null ? -n : null, sign: -1, pitcher, rule }, { stat: 'UER', delta: n, sign: 1, pitcher, rule }]
    : [{ stat: 'ER', delta: n, sign: 1, pitcher, rule }, { stat: 'UER', delta: n != null ? -n : null, sign: -1, pitcher, rule }]);
  if (multi) return multi.flatMap((x) => mk(x.n, x.pitcher, `earned:${target}:split`));
  if (add) return mk(toNum(add[1]), pitcherIn(head), 'earned:additional');
  const { n } = runCount(head);
  // "3 of the 4 runs … are unearned, instead of just 1 of 4 being unearned"
  const tail = c.slice(head.length);
  const old = /\binstead of\s+(?:just\s+|only\s+)?(one|two|three|four|five|\d+)\s+of\b/i.exec(tail);
  if (old && n != null && toNum(old[1]) != null) return mk(n - toNum(old[1]), pitcherIn(head), `earned:${target}:new_minus_old`);
  return mk(n, pitcherIn(head), `earned:${target}`);
}

/* ---------------------------------------------------------------- main */
/**
 * @param {object} entry   official entry ({ body, cls })
 * @param {object} play    facts from the linked StatsAPI play (optional):
 *                         { batterName, batterId, pitcherName, pitcherId }
 * @returns {{ batting: object[], pitching: object[], unparsed: string[],
 *             noPlayerStats: boolean, battingChange: boolean, pitchingChange: boolean }}
 */
export function statEffects(entry, play = {}) {
  const body = String((entry && entry.body) || '');
  const cls = (entry && entry.cls) || {};
  const batting = [];
  const pitching = [];
  const unparsed = [];
  const flags = [];
  const batter = play.batterName || null;
  const pitcher = play.pitcherName || null;
  const batterSrc = batter ? 'linked_play_batter' : null;
  const pitcherSrc = pitcher ? 'linked_play_pitcher' : null;

  // 1. Ruling transition → H (batter + pitcher), BB, K.
  if (cls.kind === 'ruling_change' && cls.initial && cls.final) {
    const evidence = `${cls.oldPhrase || cls.initial} → ${cls.newPhrase || cls.final}`;
    const wasHit = HIT_CATS.has(cls.initial);
    const isHit = HIT_CATS.has(cls.final);
    // A side the classifier could not name ('other') is not a ruling: no H
    // delta (2026 #165 — "changed to only one RBI" is not a new ruling).
    const known = cls.initial !== 'other' && cls.final !== 'other';
    // Cross-check with the linked play's CURRENT StatsAPI event when known.
    const cur = play.currentEventType || null;
    const curIsHit = cur ? ['single', 'double', 'triple', 'home_run'].includes(cur) : null;
    if (wasHit !== isHit && known && curIsHit !== null && curIsHit !== isHit) {
      flags.push('hit_change_contradicted_by_statsapi');
    } else if (wasHit !== isHit && known) {
      const d = isHit ? 1 : -1;
      batting.push({ stat: 'H', delta: d, sign: d, player: batter, playerId: play.batterId ?? null, playerSource: batterSrc, evidence, rule: 'transition:hit' });
      pitching.push({ stat: 'H', delta: d, sign: d, player: pitcher, playerId: play.pitcherId ?? null, playerSource: pitcherSrc, evidence, rule: 'transition:hit' });
    }
    const oldP = String(cls.oldPhrase || '');
    const newP = String(cls.newPhrase || '');
    const bb = (WALK_RE.test(newP) ? 1 : 0) - (WALK_RE.test(oldP) ? 1 : 0);
    if (bb) pitching.push({ stat: 'BB', delta: bb, sign: bb, player: pitcher, playerId: play.pitcherId ?? null, playerSource: pitcherSrc, evidence, rule: 'transition:walk' });
    const k = (K_RE.test(newP) ? 1 : 0) - (K_RE.test(oldP) ? 1 : 0);
    if (k) pitching.push({ stat: 'K', delta: k, sign: k, player: pitcher, playerId: play.pitcherId ?? null, playerSource: pitcherSrc, evidence, rule: 'transition:strikeout' });
  }

  // 2. The entry's own words: RBI, earned / unearned runs, runs scored.
  const noPlayerStats = NO_PLAYER_STATS_RE.test(body);
  let rbiOld = null;
  const unparsedCand = [];
  for (const sentence of splitSentences(body)) {
    let produced = false;
    const rbi = parseRbi(sentence);
    if (rbi && rbi.rule === 'rbi:original_state') { rbiOld = rbi.old; produced = true; }
    else if (rbi && (rbi.sign != null || rbi.rule === 'rbi:only_in_original_ruling')) {
      if (rbi.delta == null && rbi.now != null && rbiOld != null && rbi.now !== rbiOld) {
        rbi.delta = rbi.now - rbiOld; rbi.sign = Math.sign(rbi.delta); rbi.rule += '+original_state';
      }
      if (rbi.delta == null && rbi.rule === 'rbi:only_in_original_ruling' && rbi.old != null) {
        // Old state N RBI, new state never names an RBI: stated count of the
        // original only — kept as a direction with the original count.
        rbi.now = null;
      }
      if (rbi.old == null && rbiOld != null) rbi.old = rbiOld;
      batting.push({
        stat: 'RBI', delta: rbi.delta, sign: rbi.sign, now: rbi.now, ...(rbi.old != null ? { old: rbi.old } : {}),
        player: batter, playerId: play.batterId ?? null, playerSource: batterSrc,
        evidence: sentence, rule: rbi.rule,
      });
      produced = true;
    }
    for (const clause of earnedClauses(sentence)) {
      for (const eff of parseEarned(clause)) {
        pitching.push({
          stat: eff.stat, delta: eff.delta, sign: eff.sign,
          player: eff.pitcher || null, playerId: null,
          playerSource: eff.pitcher ? 'official_text' : null,
          evidence: clause, rule: eff.rule, ...(eff.teamOnly ? { teamOnly: true } : {}),
        });
        produced = true;
      }
    }
    // Runs scored credited / removed ("credited with a run scored").
    const r = /\b(?:is now credited with|credited with|loses|no longer credited with)\s+(a|an|one|two|\d+)\s+runs?\s+scored\b/i.exec(sentence);
    if (r) {
      const n = toNum(r[1]);
      const neg = /\b(loses|no longer)\b/i.test(r[0]);
      batting.push({ stat: 'R', delta: neg ? -n : n, sign: neg ? -1 : 1, player: null, playerId: null, playerSource: null, evidence: sentence, rule: 'runs:credited' });
      produced = true;
    }
    if (!produced && (RBI_RE.test(sentence) || EARNED_RE.test(normalizeEarnedTypos(sentence).text)) && !noPlayerStats) unparsedCand.push(sentence);
  }
  // A sentence counts as unparsed only if the entry produced nothing of its
  // family (RBI vs earned runs) anywhere else.
  for (const sentence of unparsedCand) {
    const isRbi = RBI_RE.test(sentence);
    const covered = isRbi ? batting.some((b) => b.stat === 'RBI') : pitching.some((p) => p.stat === 'ER' || p.stat === 'UER');
    if (!covered) unparsed.push(sentence);
  }
  // Team-unearned-only notes are recorded but are not a pitcher stat change.
  const realPitching = pitching.filter((p) => !p.teamOnly && p.sign !== 0);
  return {
    batting,
    pitching,
    unparsed,
    noPlayerStats,
    flags,
    battingChange: batting.length > 0,
    pitchingChange: realPitching.length > 0,
  };
}

/** Compact one-line text for a delta ("RBI −1", "ER −1 / UER +1", "RBI ↓ (now 0)"). */
export function deltaText(d) {
  if (!d) return '';
  if (typeof d.delta === 'number') return `${d.stat} ${d.delta > 0 ? '+' : '−'}${Math.abs(d.delta)}`;
  if (d.sign == null) return `${d.stat} ? (direction not stated${d.old != null ? `; was ${d.old}` : ''})`;
  const arrow = d.sign > 0 ? '↑' : d.sign < 0 ? '↓' : '·';
  return `${d.stat} ${arrow}${d.now != null ? ` (now ${d.now})` : ' (count not stated)'}`;
}
