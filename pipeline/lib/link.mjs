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

/** Candidate games for an entry. Returns {games, flags}. */
export function candidateGames(entry, teamIndex, games) {
  const flags = [];
  const away = teamIndex.get(entry.away || '');
  const home = teamIndex.get(entry.home || '');
  if (!away || !home) {
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
  } else {
    list = pair.slice();
    if (list.length) flags.push('date_inferred');
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

/** Does a current eventType agree with a classified final ruling category? */
export function rulingAgrees(finalCategory, finalHitType, eventType) {
  if (!finalCategory || !eventType) return null;
  switch (finalCategory) {
    case 'hit':
    case 'hit+error':
      if (!HIT_EVENTS.has(eventType)) return false;
      return finalHitType ? finalHitType === eventType : true;
    case 'error':
      return eventType === 'field_error';
    case 'fc':
    case 'fc+error':
      return eventType === 'fielders_choice' || eventType === 'fielders_choice_out';
    case 'sac':
    case 'sac+error':
      return eventType === 'sac_bunt' || eventType === 'sac_fly'
        || eventType === 'sac_bunt_double_play' || eventType === 'sac_fly_double_play';
    default:
      return null;
  }
}

/**
 * Link one parsed + classified entry.
 * @param {object} entry   parsed entry (+ .cls classification)
 * @param {object} ctx     {teamIndex, games, playsByGame: Map<gamePk, rec[]>}
 */
export function linkEntry(entry, ctx) {
  const { games, flags } = candidateGames(entry, ctx.teamIndex, ctx.games);
  const link = { gamePk: null, atBatIndex: null, batterName: null, currentEventType: null, method: null, flags: [...flags] };
  if (!games.length) {
    link.flags.push('no_game_found');
    return link;
  }
  const normText = normalizeName(entry.body);
  const cls = entry.cls || {};
  const candidates = [];
  for (const g of games) {
    const plays = (ctx.playsByGame.get(g.gamePk) || []).filter((r) => r.ty === 'atBat');
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
  link.method = best.method;
  if (best.method !== 'full_name') link.flags.push(`name_match:${best.method}`);
  if (best.scope === 'whole_game') link.flags.push(entry.inning == null ? 'inning_missing_matched_game' : 'inning_mismatch');
  if (best !== firstMention && best.rec !== firstMention.rec) link.flags.push('subject_not_first_mention');
  const samePaCount = new Set(scored.filter((c) => c.agrees === best.agrees && c.pos === best.pos).map((c) => `${c.game.gamePk}:${c.rec.ai}`)).size;
  if (samePaCount > 1) link.flags.push('ambiguous_plate_appearance');
  if (best.agrees === false) link.flags.push('current_ruling_mismatch');
  return link;
}
