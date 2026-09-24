/* ============================================================================
 * pipeline/lib/link.mjs — link official scoring-change entries to StatsAPI
 * games (gamePk) and plate appearances (atBatIndex). Pure functions.
 *
 * Verification rules (each failure is recorded as a flag, never hidden):
 *   1. team codes resolve through the season's official /teams data
 *      (abbreviation, teamCode, fileCode) or a documented alias list;
 *   2. a completed game with those teams exists on that date (else ±3 days
 *      → flag `date_mismatch`; no date → flag `date_inferred`);
 *   3. a batter named in the text batted in that half-inning
 *      (full name → unique last name → fuzzy last name, flagged);
 *   4. the play's CURRENT StatsAPI ruling agrees with the entry's NEW ruling
 *      (else flag `current_ruling_mismatch`).
 *
 * Date recovery (added 2026-09-24, session 4): the official log's date is a
 * *stated* fact and is occasionally wrong — two 2026 entries were verifiably
 * about a different date (6/18 played, "6/6" printed; 7/4 played, "9/4"
 * printed). Rule 2's widest window is ±10 days, so such entries used to come
 * out `no_game_found` with no play and therefore no model score. The
 * recovery pass below searches the whole season for the same team pairing,
 * but a recovered game is only accepted when an INDEPENDENT check passes:
 * the named batter appears in the play-by-play of the stated half-inning of
 * that game, and the play's current ruling does not contradict the entry's
 * new ruling (the same rules 3 and 4). Everything is flagged
 * (`date_recovered:MM/DD->MM/DD`, `date_typo:month|day|transposed`, or
 * `date_recovery_ambiguous`) so a wrong log date is surfaced for review,
 * never silently fixed. Nothing is guessed when the check cannot decide.
 * ==========================================================================*/

import { HIT_EVENTS } from './statsapi.mjs';

export function normalizeName(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[\u2019'`.]/g, '')
    .replace(/[-\u2010\u2011\u2013\u2014]/g, ' ')
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function levenshtein(a, b) {
  const s = String(a);
  const t = String(b);
  const dp = Array.from({ length: t.length + 1 }, (_, j) => j);
  for (let i = 1; i <= s.length; i += 1) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= t.length; j += 1) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (s[i - 1] === t[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[t.length];
}

// Alternates seen in official-log text that are not StatsAPI codes. Every
// use is flagged `team_alias:<code>` and still has to pass rules 2–4.
export const TEAM_ALIASES = {
  CHW: 'CWS', WAS: 'WSH', ARI: 'AZ', KCR: 'KC', SDP: 'SD', SFG: 'SF',
  TBR: 'TB', ANA: 'LAA', OAK: 'ATH',
};

export function buildTeamIndex(teams) {
  const map = new Map();
  const add = (code, team, how) => {
    if (!code) return;
    const key = String(code).toUpperCase();
    if (!map.has(key)) map.set(key, { id: team.id, how });
  };
  for (const t of teams) add(t.abbreviation, t, 'abbreviation');
  for (const t of teams) add(t.teamCode, t, 'teamCode');
  for (const t of teams) add(t.fileCode, t, 'fileCode');
  for (const [alias, target] of Object.entries(TEAM_ALIASES)) {
    const hit = map.get(target);
    if (hit && !map.has(alias)) map.set(alias, { id: hit.id, how: `team_alias:${alias}` });
  }
  // OAK -> ATH works for 2025+; for 2024 the official abbreviation is OAK
  // (added above as 'abbreviation'), so ATH may need the reverse alias.
  const ath = map.get('OAK');
  if (ath && !map.has('ATH')) map.set('ATH', { id: ath.id, how: 'team_alias:ATH' });
  return map;
}

function dayDiff(a, b) {
  return Math.round((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86400000);
}

/**
 * Same-date correction for a mistyped team code (flagged, never silent):
 * the correctly-coded side played exactly ONE game that date in the stated
 * home/away slot, and its opponent's code shares the first two letters with
 * the mistyped code (observed: "TBN@TOR" for TB@TOR, "TOR@LAA" for TOR@LAD).
 */
function correctTeamCode(entry, teamIndex, games, teamsById) {
  if (!entry.date) return null;
  const away = teamIndex.get(entry.away || '');
  const home = teamIndex.get(entry.home || '');
  const codesOf = (id) => {
    const t = teamsById.get(id) || {};
    return [t.abbreviation, t.teamCode, t.fileCode].filter(Boolean).map((c) => String(c).toUpperCase());
  };
  const similar = (a, b) => a && b && a.slice(0, 2) === b.slice(0, 2);
  const out = [];
  if (home) {
    const list = games.filter((g) => g.homeId === home.id && g.officialDate === entry.date);
    if (list.length === 1 && codesOf(list[0].awayId).some((c) => similar(c, entry.away))) {
      out.push({ game: list[0], flag: `team_code_corrected:${entry.away}->${codesOf(list[0].awayId)[0]}` });
    }
  }
  if (away) {
    const list = games.filter((g) => g.awayId === away.id && g.officialDate === entry.date);
    if (list.length === 1 && codesOf(list[0].homeId).some((c) => similar(c, entry.home))) {
      out.push({ game: list[0], flag: `team_code_corrected:${entry.home}->${codesOf(list[0].homeId)[0]}` });
    }
  }
  return out.length === 1 ? out[0] : null;
}

/** Candidate games for an entry. Returns {games, flags}. */
export function candidateGames(entry, teamIndex, games, teamsById = new Map()) {
  const flags = [];
  const away = teamIndex.get(entry.away || '');
  const home = teamIndex.get(entry.home || '');
  if (!away || !home) {
    // An invalid code: try the same-date correction, else give up (flagged).
    const fix = correctTeamCode(entry, teamIndex, games, teamsById);
    if (fix) return { games: [fix.game], flags: [fix.flag] };
    return { games: [], flags: [`unknown_team:${!away ? entry.away : entry.home}`] };
  }
  if (away.how !== 'abbreviation') flags.push(away.how.startsWith('team_alias') ? away.how : `team_code_via:${away.how}:${entry.away}`);
  if (home.how !== 'abbreviation') flags.push(home.how.startsWith('team_alias') ? home.how : `team_code_via:${home.how}:${entry.home}`);
  const pair = games.filter((g) => g.awayId === away.id && g.homeId === home.id);
  let list = [];
  if (entry.date) {
    list = pair.filter((g) => g.officialDate === entry.date);
    if (!list.length) {
      list = pair.filter((g) => Math.abs(dayDiff(g.officialDate, entry.date)) <= 3);
      if (list.length) flags.push('date_mismatch');
    }
    if (!list.length) {
      const swapped = games.filter((g) => g.awayId === home.id && g.homeId === away.id && g.officialDate === entry.date);
      if (swapped.length) { list = swapped; flags.push('teams_swapped'); }
    }
    if (!list.length) {
      // Wider window for a wrong date; the batter check still has to pass.
      list = pair.filter((g) => Math.abs(dayDiff(g.officialDate, entry.date)) <= 10);
      if (list.length) flags.push('date_mismatch_wide');
    }
  } else {
    list = pair.slice();
    if (list.length) flags.push('date_inferred');
  }
  if (!list.length && entry.date) {
    // Both codes valid but no such game anywhere near the date: last resort,
    // a mistyped (valid-looking) code — e.g. "TOR@LAA" for TOR@LAD. Tried
    // only after every date fallback, so a date typo is never "corrected"
    // into a different opponent.
    const fix = correctTeamCode(entry, teamIndex, games, teamsById);
    if (fix) return { games: [fix.game], flags: [fix.flag] };
  }
  if (entry.gameNumber && list.length > 1) {
    const byNum = list.filter((g) => g.gameNumber === entry.gameNumber);
    if (byNum.length) list = byNum;
  }
  return { games: list, flags };
}

/** Where in the text does this batter's name appear? → {pos, method} | null */
export function findNameInText(fullName, normText, lastNameCounts) {
  const n = normalizeName(fullName);
  if (!n) return null;
  const wordRe = (w) => new RegExp(`(^|\\s)${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`);
  let m = normText.match(wordRe(n));
  if (m) return { pos: m.index, method: 'full_name' };
  const parts = n.split(' ');
  const last = parts.slice(1).join(' ') || parts[0];
  if (last && (lastNameCounts.get(last) || 0) === 1) {
    m = normText.match(wordRe(last));
    if (m) return { pos: m.index, method: 'last_name' };
  }
  // fuzzy: compare last name against every text token window of same size
  if (last && last.length >= 5 && (lastNameCounts.get(last) || 0) === 1) {
    const tokens = normText.split(' ');
    const k = last.split(' ').length;
    let offset = 0;
    for (let i = 0; i + k <= tokens.length; i += 1) {
      const win = tokens.slice(i, i + k).join(' ');
      if (Math.abs(win.length - last.length) <= 2 && levenshtein(win, last) <= 2) {
        return { pos: offset, method: 'fuzzy_last_name' };
      }
      offset += tokens[i].length + 1;
    }
  }
  return null;
}

const FC_EVENTS = new Set(['fielders_choice', 'fielders_choice_out']);
const SAC_EVENTS = new Set(['sac_bunt', 'sac_fly', 'sac_bunt_double_play', 'sac_fly_double_play']);
const OUT_EVENT_RE = /(_out$|double_play|triple_play|^strikeout)/;

/**
 * How does a play's CURRENT StatsAPI eventType relate to a classified final
 * ruling? 'exact' | 'compatible' | 'mismatch' | null (not checkable).
 * 'compatible' encodes StatsAPI conventions verified on real linked plays:
 *   - a sacrifice fielder's choice is coded sac_bunt / sac_fly
 *     (2026 log #123, #186; 2025 #102);
 *   - a batter reaching on an error on a play with another fielding event is
 *     coded in the fielder's-choice family (fielders_choice / force_out)
 *     (2024 #28, #141; 2025 #44; 2026 #56).
 */
export function rulingAgreement(finalCategory, finalHitType, eventType) {
  if (!finalCategory || !eventType) return null;
  const et = eventType;
  switch (finalCategory) {
    case 'hit':
    case 'hit+error':
      if (!HIT_EVENTS.has(et)) return 'mismatch';
      return !finalHitType || finalHitType === et ? 'exact' : 'mismatch';
    case 'error':
      if (et === 'field_error') return 'exact';
      return FC_EVENTS.has(et) || et === 'force_out' ? 'compatible' : 'mismatch';
    case 'fc':
      if (FC_EVENTS.has(et)) return 'exact';
      return et === 'force_out' || SAC_EVENTS.has(et) ? 'compatible' : 'mismatch';
    case 'fc+error':
      if (FC_EVENTS.has(et) || et === 'field_error') return 'exact';
      return et === 'force_out' || SAC_EVENTS.has(et) ? 'compatible' : 'mismatch';
    case 'sac':
      return SAC_EVENTS.has(et) ? 'exact' : 'mismatch';
    case 'sac+error':
      if (SAC_EVENTS.has(et)) return 'exact';
      return et === 'field_error' ? 'compatible' : 'mismatch';
    case 'out':
      return OUT_EVENT_RE.test(et) ? 'exact' : 'mismatch';
    default:
      return null;
  }
}

/** true (exact/compatible) / false (mismatch) / null (not checkable). */
export function rulingAgrees(finalCategory, finalHitType, eventType) {
  const a = rulingAgreement(finalCategory, finalHitType, eventType);
  return a === null ? null : a !== 'mismatch';
}

/* ------------------------------------------------------------ date recovery */

/**
 * Cheap pre-filter for the season-wide recovery scan: could this entry's text
 * name this batter at all? Full normalized name, else the last name as a
 * whole word (`findNameInText` then re-checks precisely, so a cheap true
 * positive is fine and a cheap false negative only means "not a candidate").
 */
export function textMentionsName(normText, fullName) {
  const n = normalizeName(fullName);
  if (!n || !normText) return false;
  if (normText.includes(n)) return true;
  const parts = n.split(' ');
  const last = parts.slice(1).join(' ') || parts[0];
  if (!last) return false;
  return new RegExp(`(^|\\s)${last.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(normText);
}

/**
 * What kind of wrong date does a recovered game look like? Describes the two
 * dates only — it never claims a cause the calendar cannot show:
 *   'month'      same day of the month, different month (7/4 for 9/4);
 *   'day'        same month, different day (6/6 for 6/18);
 *   'transposed' month and day swapped (4/9 for 9/4);
 *   null         anything else (or a different year — never claimed as a typo).
 */
export function dateTypoKind(statedDate, foundDate) {
  if (!statedDate || !foundDate) return null;
  const [sy, sm, sd] = String(statedDate).split('-').map(Number);
  const [fy, fm, fd] = String(foundDate).split('-').map(Number);
  if (![sy, sm, sd, fy, fm, fd].every(Number.isFinite)) return null;
  if (sy !== fy || (sm === fm && sd === fd)) return null;
  if (sm !== fm && sd === fd) return 'month';
  if (sm === fm && sd !== fd) return 'day';
  if (sm === fd && sd === fm) return 'transposed';
  return null;
}

const mmdd = (iso) => (iso ? `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}` : '?');

/**
 * Season-wide date recovery for an entry that rule 2 could not place.
 *
 * Candidates are every game of the season between the entry's two teams (in
 * either home/away order). A game is accepted only when the batter named in
 * the entry batted in the stated half-inning of THAT game (rule 3) and the
 * play's current ruling does not contradict the entry's new ruling (rule 4);
 * `orderHint` (the dates of the neighbouring log entries) breaks a tie
 * between two games that both pass, because the official list is posted in
 * order. If nothing passes, the caller keeps its existing flags.
 *
 * Returns { game, candidates, flags }: `game` is the accepted game or null;
 * `flags` are the flags to attach (empty when nothing was recovered and the
 * ambiguous case is reported by `candidates.length`).
 */
export function recoverGameForEntry(entry, ctx, { orderHint = null } = {}) {
  const teamIndex = ctx && ctx.teamIndex;
  const games = (ctx && ctx.games) || [];
  const playsByGame = (ctx && ctx.playsByGame) || new Map();
  const away = teamIndex && teamIndex.get(entry.away || '');
  const home = teamIndex && teamIndex.get(entry.home || '');
  if (!away || !home || !entry.date) return { game: null, candidates: [], flags: [] };
  const pairAll = games.filter((g) => (g.awayId === away.id && g.homeId === home.id)
    || (g.awayId === home.id && g.homeId === away.id));
  if (!pairAll.length) return { game: null, candidates: [], flags: [] };
  const normText = normalizeName(entry.body);
  // Only games whose play-by-play actually names a player from the entry can
  // be candidates — the rest cannot pass rule 3.
  const mentioning = pairAll.filter((g) => (playsByGame.get(g.gamePk) || [])
    .some((r) => r.ty === 'atBat' && textMentionsName(normText, r.bn)));
  const scored = [];
  for (const g of mentioning) {
    const cands = findCandidates(entry, [g], playsByGame)
      .filter((c) => rulingAgrees(entry.cls && entry.cls.final, entry.cls && entry.cls.finalHitType, c.rec.et) !== false);
    if (cands.length) scored.push({ game: g, cands });
  }
  const inOrder = (g) => {
    if (!orderHint || !orderHint.prevDate || !orderHint.nextDate) return true;
    const from = addDaysIso(orderHint.prevDate, -3);
    const to = addDaysIso(orderHint.nextDate, 3);
    return g.officialDate >= from && g.officialDate <= to;
  };
  const pickFrom = (list) => (list.length === 1 ? list[0] : (list.filter((x) => inOrder(x.game)).length === 1
    ? list.filter((x) => inOrder(x.game))[0] : null));
  let chosen = pickFrom(scored);
  let gameOnly = false;
  if (!chosen && !scored.length && !mentioning.length) {
    // No batter named anywhere in the season for this pairing (bookkeeping
    // entries such as "the winning pitcher has been changed to …"): accept a
    // game only when it cannot be ambiguous — the pairing occurs exactly once
    // in the whole season, or exactly one game of the pairing has a date that
    // is a STRONG typo of the stated one (the same day of another month, or
    // the month and day swapped). A merely different DAY inside the same
    // month is NOT accepted: a series spans consecutive days, so that is not
    // evidence of a typo. Both accepted cases stay flagged
    // `date_recovered_game_only`.
    const STRONG_TYPOS = new Set(['month', 'transposed']);
    const typoMatches = pairAll.filter((g) => STRONG_TYPOS.has(dateTypoKind(entry.date, g.officialDate)));
    if (pairAll.length === 1) chosen = { game: pairAll[0], cands: [] };
    else if (typoMatches.length === 1) chosen = { game: typoMatches[0], cands: [] };
    if (chosen) gameOnly = true;
  }
  const flags = [];
  if (chosen) {
    flags.push(`date_recovered:${mmdd(entry.date)}->${mmdd(chosen.game.officialDate)}`);
    const kind = dateTypoKind(entry.date, chosen.game.officialDate);
    if (kind) flags.push(`date_typo:${kind}`);
    if (gameOnly) flags.push('date_recovered_game_only');
    return { game: chosen.game, candidates: scored.map((s) => s.game), flags };
  }
  // Nothing verified. Report WHY so the entry can be reviewed by hand:
  //   ambiguous  — more than one game passed the batter + ruling check (they
  //                are listed in `candidates`), or a batter-less entry had
  //                several games of the pairing to choose from;
  //   unverified — the pairing’s games were scanned and the named batter did
  //                not match the entry's new ruling anywhere (a contradicting
  //                current ruling is deliberately NOT a recovery: the ±10-day
  //                pass is where a `current_ruling_mismatch` is reported).
  if (scored.length > 1) return { game: null, candidates: scored.map((s) => s.game), flags: [`date_recovery_ambiguous:${scored.length}`] };
  if (mentioning.length) return { game: null, candidates: mentioning, flags: [`date_recovery_unverified:${mentioning.length}`] };
  return {
    game: null,
    candidates: pairAll,
    flags: pairAll.length ? [`date_recovery_ambiguous:${pairAll.length}`] : [],
  };
}

/** ISO date + n days (local to link.mjs, no dependency on run.mjs helpers). */
function addDaysIso(iso, days) {
  return new Date(Date.parse(`${iso}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

/**
 * Link one parsed + classified entry.
 * @param {object} entry   parsed entry (+ .cls classification)
 * @param {object} ctx     {teamIndex, games, playsByGame: Map<gamePk, rec[]>,
 *                          teamsById, orderHint?}
 */
/** Batters named in the entry text, per candidate game (see linkEntry). */
function findCandidates(entry, games, playsByGame) {
  const normText = normalizeName(entry.body);
  const candidates = [];
  for (const g of games) {
    const plays = (playsByGame.get(g.gamePk) || []).filter((r) => r.ty === 'atBat');
    const halfPlays = entry.inning != null
      ? plays.filter((r) => r.inn === entry.inning && (entry.half == null || r.top === (entry.half === 'top')))
      : plays;
    const scan = (pool, scope) => {
      const lastCounts = new Map();
      const seenBatters = new Set();
      for (const r of pool) {
        if (seenBatters.has(r.b)) continue;
        seenBatters.add(r.b);
        const parts = normalizeName(r.bn).split(' ');
        const last = parts.slice(1).join(' ') || parts[0];
        lastCounts.set(last, (lastCounts.get(last) || 0) + 1);
      }
      for (const r of pool) {
        const hit = findNameInText(r.bn, normText, lastCounts);
        if (hit) candidates.push({ game: g, rec: r, pos: hit.pos, method: hit.method, scope });
      }
    };
    if (entry.inning != null) {
      scan(halfPlays, 'half_inning');
      if (!candidates.some((c) => c.game === g)) scan(plays, 'whole_game');
    } else {
      scan(plays, 'whole_game');
    }
  }
  return candidates;
}

export function linkEntry(entry, ctx) {
  let { games, flags } = candidateGames(entry, ctx.teamIndex, ctx.games, ctx.teamsById);
  const link = { gamePk: null, atBatIndex: null, batterName: null, currentEventType: null, method: null, flags: [...flags] };
  const cls = entry.cls || {};
  if (!games.length) {
    // Rule 2 failed outright (no game with these teams within ±10 days).
    // Try the season-wide date recovery; it only ever accepts a game whose
    // play-by-play independently verifies the entry (batter + ruling).
    const rec = recoverGameForEntry(entry, ctx, { orderHint: ctx.orderHint });
    if (rec.game) {
      games = [rec.game];
      flags = [...flags, ...rec.flags];
      link.flags = [...flags];
    } else {
      rec.flags.forEach((f) => link.flags.push(f));
      link.flags.push('no_game_found');
      return link;
    }
  }
  let candidates = findCandidates(entry, games, ctx.playsByGame);
  if (!candidates.length) {
    // Games were found near the stated date but the named batter is not in
    // them: the date itself may be wrong (the two verified 2026 cases were
    // off by 12 and 62 days). A recovered game replaces the near-date
    // candidates only when the batter+ruling check passes — the
    // `batter_not_found` fallback below stays the weaker, honest outcome.
    const rec = recoverGameForEntry(entry, ctx, { orderHint: ctx.orderHint });
    if (rec.game) {
      const retry = findCandidates(entry, [rec.game], ctx.playsByGame);
      if (retry.length) {
        games = [rec.game];
        candidates = retry;
        flags = [...flags, ...rec.flags];
        link.flags = [...flags];
      }
    } else if (rec.flags.length && !link.flags.includes(rec.flags[0])) {
      rec.flags.forEach((f) => link.flags.push(f));
    }
  }
  if (!candidates.length && entry.date && flags.some((f) => /^date_mismatch/.test(f))) {
    // The date fallback found the stated teams on another day, but the named
    // batter is not there: try a mistyped-code correction on the stated
    // date, kept only if the batter IS found in that game.
    const fix = correctTeamCode(entry, ctx.teamIndex, ctx.games, ctx.teamsById || new Map());
    if (fix) {
      const retry = findCandidates(entry, [fix.game], ctx.playsByGame);
      if (retry.length) {
        games = [fix.game];
        candidates = retry;
        link.flags = [fix.flag];
      }
    }
  }
  if (!candidates.length) {
    link.flags.push('batter_not_found');
    if (games.length === 1) link.gamePk = games[0].gamePk;
    return link;
  }
  // Prefer: current ruling agrees with the new ruling, then earliest mention,
  // then half-inning scope over whole-game scope.
  const scored = candidates.map((c) => ({
    ...c,
    agrees: rulingAgrees(cls.final, cls.finalHitType, c.rec.et),
  }));
  scored.sort((a, b) => {
    const ag = (x) => (x.agrees === true ? 0 : x.agrees === null ? 1 : 2);
    return ag(a) - ag(b)
      || (a.scope === b.scope ? 0 : a.scope === 'half_inning' ? -1 : 1)
      || a.pos - b.pos
      || a.rec.ai - b.rec.ai;
  });
  const best = scored[0];
  const firstMention = [...scored].sort((a, b) => a.pos - b.pos || a.rec.ai - b.rec.ai)[0];
  link.gamePk = best.game.gamePk;
  link.atBatIndex = best.rec.ai;
  link.batterId = best.rec.b;
  link.batterName = best.rec.bn;
  link.currentEventType = best.rec.et;
  link.currentEvent = best.rec.ev;
  link.currentDescription = best.rec.desc;
  // The play's OWN inning and half (the log's printed inning is a stated fact
  // and can be wrong — 2026 #173 says the 8th while the play is in the 9th —
  // so a consumer that needs the play's position takes it from here).
  link.inning = best.rec.inn != null ? best.rec.inn : null;
  link.half = typeof best.rec.top === 'boolean' ? (best.rec.top ? 'top' : 'bottom') : null;
  link.method = best.method;
  if (best.method !== 'full_name') link.flags.push(`name_match:${best.method}`);
  if (best.scope === 'whole_game') link.flags.push(entry.inning == null ? 'inning_missing_matched_game' : 'inning_mismatch');
  if (best !== firstMention && best.rec !== firstMention.rec) link.flags.push('subject_not_first_mention');
  const samePaCount = new Set(scored.filter((c) => c.agrees === best.agrees && c.pos === best.pos).map((c) => `${c.game.gamePk}:${c.rec.ai}`)).size;
  if (samePaCount > 1) link.flags.push('ambiguous_plate_appearance');
  if (best.agrees === false) link.flags.push('current_ruling_mismatch');
  if (rulingAgreement(cls.final, cls.finalHitType, best.rec.et) === 'compatible') {
    link.flags.push(`current_ruling_compatible:${best.rec.et}`);
  }
  return link;
}

/**
 * An error → error entry (e.g. "Kody Clemens … scores on a throwing error by
 * catcher Salvador Perez, instead of a two-base throwing error …") often
 * concerns a RUNNER's error, while the plate appearance keeps its own ruling
 * (a single, a double …) — a plate-appearance "mismatch" that is not an
 * irregularity. Verified independently: the linked play must carry an error
 * charged on a runner (fielding credit "*_error" on a runner entry, or a
 * runner movement coded as an error).
 */
export function isVerifiedRunnerErrorChange(entry, rec) {
  if (!entry || !entry.cls || entry.cls.transition !== 'error->error' || !rec) return false;
  if (rec.et === 'field_error') return false;
  const runnerErrorCredit = (rec.cr || []).some((c) => /_error\|/.test(c) && c.endsWith('|R'));
  return runnerErrorCredit || (rec.re || 0) > 0;
}
