/* ============================================================================
 * pipeline/lib/statsapi.mjs — MLB StatsAPI access + pure play extraction.
 *
 * Endpoints (official MLB Stats API, same host the live site uses):
 *   /api/v1/teams?sportId=1&season=YYYY
 *   /api/v1/schedule?sportId=1&season=YYYY&gameType=T
 *   /api/v1/game/{gamePk}/playByPlay[?fields=...]
 *
 * `extractGamePlays` is pure and reduces a playByPlay payload to one compact
 * record per plate appearance, keeping exactly what the scoring model and the
 * official-log linker need. The pipeline verifies (per season) that the
 * projected (`fields=`) payload extracts identically to the full payload.
 * ==========================================================================*/

import { fetchJSON } from './http.mjs';

export const API = 'https://statsapi.mlb.com/api/v1';

export const HIT_EVENTS = new Set(['single', 'double', 'triple', 'home_run']);

// Every key read by extractGamePlays (StatsAPI `fields` keeps listed keys at
// any depth, so each nested leaf we need must be listed explicitly).
export const PBP_FIELDS = [
  'allPlays', 'result', 'type', 'event', 'eventType', 'description', 'rbi',
  'awayScore', 'homeScore', 'isOut', 'about', 'atBatIndex', 'inning',
  'isTopInning', 'halfInning', 'hasReview', 'startTime', 'matchup', 'batter',
  'pitcher', 'id', 'fullName', 'batSide', 'pitchHand', 'code', 'splits',
  'menOnBase', 'count', 'outs', 'playEvents', 'details', 'isInPlay', 'index',
  'hitData', 'launchSpeed', 'launchAngle', 'totalDistance', 'trajectory',
  'hardness', 'location', 'coordinates', 'coordX', 'coordY', 'runners',
  'movement', 'originBase', 'start', 'end', 'outBase', 'runner', 'credits',
  'credit', 'player', 'position', 'abbreviation', 'isScoringEvent',
].join(',');

export function playByPlayUrl(gamePk, projected = true) {
  return `${API}/game/${gamePk}/playByPlay${projected ? `?fields=${PBP_FIELDS}` : ''}`;
}

export async function getTeams(season) {
  const url = `${API}/teams?sportId=1&season=${season}`;
  const data = await fetchJSON(url);
  return {
    url,
    teams: (data.teams || []).map((t) => ({
      id: t.id,
      name: t.name,
      abbreviation: t.abbreviation || null,
      teamCode: t.teamCode || null,
      fileCode: t.fileCode || null,
      teamName: t.teamName || null,
      clubName: t.clubName || null,
    })),
  };
}

const GAME_TYPES = ['R', 'F', 'D', 'L', 'W'];

/** All regular-season + postseason games for a season (one call per type). */
export async function getSeasonSchedule(season) {
  const games = [];
  const urls = [];
  for (const gt of GAME_TYPES) {
    const url = `${API}/schedule?sportId=1&season=${season}&gameType=${gt}`;
    urls.push(url);
    const data = await fetchJSON(url);
    for (const d of data.dates || []) {
      for (const g of d.games || []) {
        games.push({
          gamePk: g.gamePk,
          gameType: g.gameType || gt,
          officialDate: g.officialDate || d.date,
          gameDate: g.gameDate || null,
          gameNumber: g.gameNumber || 1,
          doubleHeader: g.doubleHeader || 'N',
          codedGameState: g.status && g.status.codedGameState,
          detailedState: g.status && g.status.detailedState,
          abstractGameState: g.status && g.status.abstractGameState,
          awayId: g.teams && g.teams.away && g.teams.away.team && g.teams.away.team.id,
          homeId: g.teams && g.teams.home && g.teams.home.team && g.teams.home.team.id,
          awayName: g.teams && g.teams.away && g.teams.away.team && g.teams.away.team.name,
          homeName: g.teams && g.teams.home && g.teams.home.team && g.teams.home.team.name,
        });
      }
    }
  }
  // The same gamePk can appear on two dates (suspended/resumed); keep the last.
  const byPk = new Map();
  for (const g of games) byPk.set(g.gamePk, g);
  return { urls, games: [...byPk.values()] };
}

/** Completed games only ("F" final / "O" game over). */
export function isCompleted(g) {
  return g && (g.codedGameState === 'F' || g.codedGameState === 'O');
}

export async function getPlayByPlay(gamePk, { projected = true } = {}) {
  return fetchJSON(playByPlayUrl(gamePk, projected), { timeoutMs: 60000 });
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Pick the batted-ball data of the in-play pitch (last event with hitData). */
function battedBall(events) {
  for (let k = events.length - 1; k >= 0; k -= 1) {
    const ev = events[k];
    if (!ev || !ev.hitData) continue;
    const inPlay = ev.details && ev.details.isInPlay;
    if (inPlay === false) continue;
    const h = ev.hitData;
    const c = h.coordinates || {};
    return {
      ls: num(h.launchSpeed),
      la: num(h.launchAngle),
      dist: num(h.totalDistance),
      traj: h.trajectory || null,
      hard: h.hardness || null,
      loc: h.location != null ? String(h.location) : null,
      cx: num(c.coordX),
      cy: num(c.coordY),
    };
  }
  return null;
}

/**
 * Reduce a playByPlay payload to compact per-PA records.
 * @param {object} pbp  StatsAPI playByPlay JSON
 * @param {number} gamePk
 */
export function extractGamePlays(pbp, gamePk) {
  const out = [];
  const plays = (pbp && pbp.allPlays) || [];
  for (const p of plays) {
    const res = p.result || {};
    const about = p.about || {};
    const m = p.matchup || {};
    const events = Array.isArray(p.playEvents) ? p.playEvents : [];
    const batterId = m.batter && m.batter.id;

    const pend = [];
    const adv = [];
    for (const ev of events) {
      const d = ev && ev.details;
      const et = d && d.eventType;
      if (et && /^os_ruling_pending/.test(et)) {
        pend.push({ et, i: ev.index ?? null, d: d.description || null, t: ev.startTime || null });
      }
      if (et === 'game_advisory' && /scor/i.test(d.description || '')) adv.push(d.description);
    }

    const cr = [];
    let re = 0;
    let batterSeen = false;
    let batterOut = false;
    for (const r of Array.isArray(p.runners) ? p.runners : []) {
      const det = r.details || {};
      const isBatter = det.runner && det.runner.id === batterId;
      if (isBatter) {
        batterSeen = true;
        if (r.movement && r.movement.isOut) batterOut = true;
      }
      if (/error/i.test(det.eventType || '')) re += 1;
      for (const c of Array.isArray(r.credits) ? r.credits : []) {
        const pos = (c.position && (c.position.abbreviation || c.position.code)) || '?';
        cr.push(`${c.credit}|${pos}|${(c.player && c.player.id) || ''}|${isBatter ? 'B' : 'R'}`);
      }
    }

    const rec = {
      g: gamePk,
      ai: about.atBatIndex,
      inn: about.inning ?? null,
      top: about.isTopInning === true,
      b: batterId ?? null,
      bn: (m.batter && m.batter.fullName) || null,
      bs: (m.batSide && m.batSide.code) || null,
      p: (m.pitcher && m.pitcher.id) ?? null,
      pn: (m.pitcher && m.pitcher.fullName) || null,
      ty: res.type || null,
      et: res.eventType || null,
      ev: res.event || null,
      desc: res.description || null,
      out: res.isOut === true,
      outs: (p.count && p.count.outs) ?? null,
      rbi: res.rbi ?? null,
      as: res.awayScore ?? null,
      hs: res.homeScore ?? null,
      men: (m.splits && m.splits.menOnBase) || null,
      rev: about.hasReview === true,
      t: about.startTime || null,
      // batter reached safely: 1 / 0 / null (batter absent from runners[])
      br: batterSeen ? (batterOut ? 0 : 1) : null,
      hd: battedBall(events),
    };
    if (cr.length) rec.cr = cr;
    if (re) rec.re = re;
    if (pend.length) rec.pend = pend;
    if (adv.length) rec.adv = adv;
    out.push(rec);
  }
  return out;
}

/** Deep-equality used by the projected-vs-full self check. */
export function samePlays(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
