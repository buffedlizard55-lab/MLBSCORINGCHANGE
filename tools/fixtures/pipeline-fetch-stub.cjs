// SYNTHETIC fetch stub for tools/pipeline-offline-smoke.mjs.
// Replaces globalThis.fetch with a tiny fake MLB: 4 teams, 24 games per
// season, generated play-by-play, an official-log page whose entries refer
// to real (synthetic) plays, and a Savant-style CSV. Nothing here is real
// baseball data — it only exercises the pipeline end to end offline.
'use strict';

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const sig = (z) => 1 / (1 + Math.exp(-z));
const TEAMS = [
  { id: 901, name: 'Alpha Club', abbreviation: 'AAA', teamCode: 'aaa', fileCode: 'aaa' },
  { id: 902, name: 'Bravo Club', abbreviation: 'BBB', teamCode: 'bbb', fileCode: 'bbb' },
  { id: 903, name: 'Charlie Club', abbreviation: 'CCC', teamCode: 'ccc', fileCode: 'ccc' },
  { id: 904, name: 'Delta Club', abbreviation: 'DDD', teamCode: 'ddd', fileCode: 'ddd' },
];
const SEASONS = [2024, 2025, 2026];
const GAMES_PER_SEASON = 24;
const world = { games: new Map(), schedule: new Map(), log: new Map(), savant: new Map() };

for (const season of SEASONS) {
  const r = rng(season);
  const games = [];
  const logLines = [];
  const savantRows = [];
  for (let i = 0; i < GAMES_PER_SEASON; i += 1) {
    const away = TEAMS[i % 4];
    const home = TEAMS[(i + 1) % 4];
    const month = 4 + Math.floor(i / 6);
    const day = 1 + (i % 6) * 4;
    const officialDate = `${season}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const gamePk = season * 1000 + i;
    games.push({ gamePk, gameType: 'R', officialDate, gameNumber: 1, doubleHeader: 'N', status: { codedGameState: 'F', detailedState: 'Final', abstractGameState: 'Final' }, teams: { away: { team: { id: away.id, name: away.name } }, home: { team: { id: home.id, name: home.name } } } });
    const allPlays = [];
    for (let ai = 0; ai < 72; ai += 1) {
      const top = Math.floor(ai / 4) % 2 === 0;
      const inning = 1 + Math.floor(ai / 8);
      const bat = top ? away : home;
      const fld = top ? home : away;
      const batterId = bat.id * 100 + (ai % 9);
      const batterName = `${bat.abbreviation}bat Number${ai % 9}x${bat.abbreviation}`;
      const ls = 45 + r() * 70; const la = -40 + r() * 90;
      const pHit = sig(-1.4 + (ls - 85) / 10 - Math.abs(la - 12) / 14);
      let et = r() < pHit ? 'single' : (r() < 0.05 ? 'field_error' : 'field_out');
      if (r() < 0.2) et = 'strikeout';
      const inPlay = et !== 'strikeout';
      let desc = `${batterName} ${et}.`;
      // Official-log entries: some singles "were errors", some errors "were singles".
      if (et === 'single' && pHit > 0.45 && r() < 0.35) {
        logLines.push({ date: officialDate, away, home, top, inning, text: `${batterName} now has a single instead of reaching on an error by shortstop ${fld.abbreviation}ss Fielder.` });
      } else if (et === 'field_error' && r() < 0.25) {
        logLines.push({ date: officialDate, away, home, top, inning, text: `${batterName} reaches on an error by shortstop ${fld.abbreviation}ss Fielder, instead of a single.` });
      }
      const events = inPlay ? [{ index: 0, isPitch: true, details: { isInPlay: true }, hitData: { launchSpeed: Number(ls.toFixed(1)), launchAngle: Math.round(la), totalDistance: 100, trajectory: la < 8 ? 'ground_ball' : la < 25 ? 'line_drive' : 'fly_ball', hardness: 'medium', location: String(1 + Math.floor(r() * 9)), coordinates: { coordX: 100, coordY: 120 } } }] : [{ index: 0, isPitch: true, details: { isInPlay: false } }];
      if (ai === 5 && season === 2026) events.push({ index: 1, details: { eventType: 'os_ruling_pending_prior', description: 'Official Scorer Ruling Pending' } });
      const reached = et === 'single' || et === 'field_error';
      allPlays.push({
        result: { type: 'atBat', event: et, eventType: et, description: desc, rbi: 0, awayScore: 0, homeScore: 0, isOut: !reached },
        about: { atBatIndex: ai, inning, isTopInning: top, halfInning: top ? 'top' : 'bottom', hasReview: false, startTime: `${officialDate}T23:00:00Z` },
        matchup: { batter: { id: batterId, fullName: batterName }, pitcher: { id: fld.id * 100 + 50, fullName: `${fld.abbreviation} Pitcher` }, batSide: { code: 'R' }, pitchHand: { code: 'R' }, splits: { menOnBase: 'Empty' } },
        count: { outs: 1 },
        playEvents: events,
        runners: [{ movement: { originBase: null, start: null, end: reached ? '1B' : null, outBase: reached ? null : '1B', isOut: !reached }, details: { eventType: et, runner: { id: batterId }, isScoringEvent: false }, credits: et === 'field_error' ? [{ player: { id: fld.id * 100 + 6 }, position: { code: '6', abbreviation: 'SS' }, credit: 'f_fielding_error' }] : [] }],
      });
      if (et === 'field_error' && season === 2026) {
        savantRows.push({ game_pk: gamePk, at_bat_number: ai + 1, launch_speed: ls.toFixed(1), launch_angle: Math.round(la), estimated_ba_using_speedangle: pHit.toFixed(3), events: 'field_error' });
      }
    }
    world.games.set(gamePk, { allPlays });
  }
  world.schedule.set(season, games);
  const header = season === 2026 ? '2026 Regular Season' : `${season} Regular Season`;
  const lines = logLines.map((l, idx) => {
    const n = season === 2026 ? `${String(idx + 1).padStart(3, '0')}.` : `${idx + 1})`;
    const [, mm, dd] = l.date.split('-').map(Number);
    const ord = l.inning === 1 ? '1st' : l.inning === 2 ? '2nd' : l.inning === 3 ? '3rd' : `${l.inning}th`;
    return `${n} ${mm}/${dd} ${l.away.abbreviation}@${l.home.abbreviation} -- In the ${l.top ? 'top' : 'bottom'} of the ${ord} inning, ${l.text}`;
  });
  lines.push(`${season === 2026 ? String(lines.length + 1).padStart(3, '0') + '.' : `${lines.length + 1})`} 5/1 AAA@BBB -- In the top of the 2nd inning, the run scored by Nobody is now unearned against Someone.`);
  // 2026 mirrors the live page: <ol><li><p>…</p></li></ol> with NO numbers in
  // the markup; 2024/2025 mirror the archived "N) …" text paragraphs.
  const listHtml = season === 2026
    ? `<p><strong>${header}</strong></p><ol>${lines.map((l) => `<li><p>${l.replace(/^\S+\s/, '').replace(/'/g, '&#x27;')}</p></li>`).join('\n')}</ol>`
    : `<h2>${header}</h2><p>${lines.join('<br>')}</p>`;
  world.log.set(season, `<html><head><script>var junk = "1) 1/1 X@Y -- no";</script></head><body>${listHtml}</body></html>`);
  world.savant.set(season, `\uFEFF"game_pk","at_bat_number","launch_speed","launch_angle","estimated_ba_using_speedangle","events"\n${savantRows.map((x) => [x.game_pk, x.at_bat_number, x.launch_speed, x.launch_angle, x.estimated_ba_using_speedangle, x.events].map((v) => `"${v}"`).join(',')).join('\n')}\n`);
}

// Test controls: STUB_REQUEST_LOG = file to append requested URLs to;
// STUB_LIVE_SEASON = season the live page lists (2027 simulates rollover:
// a new header with no entries yet).
const REQUEST_LOG = process.env.STUB_REQUEST_LOG || null;
const LIVE_SEASON = Number(process.env.STUB_LIVE_SEASON || 2026);
const fsNode = require('node:fs');

function respond(body, type) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return Promise.resolve({ ok: true, status: 200, headers: { get: () => type }, text: async () => text, json: async () => JSON.parse(text) });
}

globalThis.fetch = (input) => {
  const url = String(input && input.url ? input.url : input);
  if (REQUEST_LOG) fsNode.appendFileSync(REQUEST_LOG, `${url}\n`);
  let m;
  if ((m = url.match(/\/api\/v1\/teams\?sportId=1&season=(\d{4})/))) {
    if (process.env.STUB_FAIL_TEAMS) return Promise.resolve({ ok: false, status: 404, headers: { get: () => null }, text: async () => 'not found', json: async () => ({}) });
    return respond({ teams: TEAMS });
  }
  if ((m = url.match(/\/api\/v1\/schedule\?.*season=(\d{4}).*gameType=([A-Z])/))) {
    const games = m[2] === 'R' ? world.schedule.get(Number(m[1])) || [] : [];
    const byDate = new Map();
    for (const g of games) { if (!byDate.has(g.officialDate)) byDate.set(g.officialDate, []); byDate.get(g.officialDate).push(g); }
    return respond({ dates: [...byDate.entries()].map(([date, gs]) => ({ date, games: gs })) });
  }
  if ((m = url.match(/\/api\/v1\/game\/(\d+)\/playByPlay/))) {
    const g = world.games.get(Number(m[1]));
    return g ? respond(g) : Promise.resolve({ ok: false, status: 404, text: async () => 'nf', json: async () => ({}) });
  }
  if (url.includes('web.archive.org/web/20260210034254id_')) return respond(world.log.get(2025), 'text/html');
  if (url.includes('web.archive.org/web/20250121083545id_')) return respond(world.log.get(2024), 'text/html');
  if (url.startsWith('https://www.mlb.com/official-information/scoring-changes')) {
    if (LIVE_SEASON !== 2026) return respond(`<html><body><p><strong>${LIVE_SEASON} Regular Season</strong></p><ol></ol></body></html>`, 'text/html');
    return respond(world.log.get(2026), 'text/html');
  }
  if ((m = url.match(/baseballsavant\.mlb\.com\/statcast_search\/csv\?.*hfSea=(\d{4})/))) return respond(world.savant.get(Number(m[1])) || '', 'text/csv');
  return Promise.resolve({ ok: false, status: 599, text: async () => `unstubbed ${url}`, json: async () => ({}) });
};
