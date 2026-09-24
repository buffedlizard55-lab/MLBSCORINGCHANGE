// SYNTHETIC fetch stub for tools/capture-test.mjs (pipeline/capture.mjs end to
// end, offline). Nothing here is real baseball data. The play shapes follow
// the StatsAPI playByPlay fields the capture reads (verified live 2026-09-24);
// the pending markers use the registered event-type codes exactly as the
// site's own detector (assets/js/reviews.js) expects them.
//
// Timeline (poll = number of schedule requests so far):
//   game 900001 AAA@BBB (live on polls 1–2, final from poll 3)
//     ai 1  poll 1: throwing error by SS (batter credit)   → poll 2+: single
//     ai 2  poll 1: os_ruling_pending_primary              → poll 2+: fielding error by 2B
//     ai 3  single; ai 4 (in progress) carries os_ruling_pending_prior on poll 1 only
//   game 900002 CCC@DDD (final, started 5 h before CAPTURE_NOW)
//     ai 5  field error that ended 4 h ago  → captured (within 6 h)
//     ai 9  field error that ended 7 h ago  → NOT captured (too late to be "live")
'use strict';

const NOW = Date.parse(process.env.CAPTURE_NOW || '2026-09-24T21:00:00Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const MIN = 60000;
// STUB_START_POLL=3 serves the final state from the first poll (a later run
// in which nothing changes any more).
let schedulePolls = Number(process.env.STUB_START_POLL || 0);

function respond(body) {
  const text = JSON.stringify(body);
  return Promise.resolve({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => text, json: async () => JSON.parse(text) });
}

function pa(ai, { et, event, desc, credits = [], batterId = 1000 + ai, endMsAgo = 10 * MIN, complete = true, events = [], hit = true, inning = 3 }) {
  const playEvents = [];
  if (hit) {
    playEvents.push({ index: 0, isPitch: true, details: { isInPlay: true, description: 'In play, run(s)' }, hitData: { launchSpeed: 88.4, launchAngle: 4, trajectory: 'ground_ball', hardness: 'medium', location: '6', totalDistance: 120, coordinates: { coordX: 110, coordY: 150 } } });
  }
  playEvents.push(...events);
  return {
    result: complete ? { type: 'atBat', event, eventType: et, description: desc, isOut: false } : { type: 'atBat' },
    about: { atBatIndex: ai, inning, isTopInning: true, halfInning: 'top', isComplete: complete, endTime: iso(endMsAgo), startTime: iso(endMsAgo + 2 * MIN) },
    count: { outs: 1 },
    matchup: { batter: { id: batterId, fullName: `Batter ${ai}` }, pitcher: { id: 2000, fullName: 'Pitcher Z' }, splits: { menOnBase: 'Empty' } },
    playEvents,
    runners: [{ movement: { originBase: null, start: null, end: complete ? '1B' : null, isOut: false }, details: { eventType: et, runner: { id: batterId } }, credits }],
  };
}

function game1(poll) {
  const plays = [pa(0, { et: 'field_out', event: 'Groundout', desc: 'Batter 0 grounds out.', endMsAgo: 20 * MIN })];
  plays.push(poll === 1
    ? pa(1, { et: 'field_error', event: 'Field Error', desc: 'Batter 1 reaches on a throwing error by shortstop Sam Short.', credits: [{ player: { id: 3006 }, position: { code: '6', abbreviation: 'SS' }, credit: 'f_throwing_error' }], endMsAgo: 8 * MIN })
    : pa(1, { et: 'single', event: 'Single', desc: 'Batter 1 singles on a ground ball to shortstop Sam Short.', credits: [{ player: { id: 3006 }, position: { code: '6', abbreviation: 'SS' }, credit: 'f_fielded_ball' }], endMsAgo: 8 * MIN }));
  plays.push(poll === 1
    ? pa(2, { et: 'os_ruling_pending_primary', event: 'Official Scorer Ruling Pending', desc: 'Official Scorer Ruling Pending', endMsAgo: 5 * MIN })
    : pa(2, { et: 'field_error', event: 'Field Error', desc: 'Batter 2 reaches on a fielding error by second baseman Tom Second.', credits: [{ player: { id: 3004 }, position: { code: '4', abbreviation: '2B' }, credit: 'f_fielding_error' }], endMsAgo: 5 * MIN }));
  plays.push(pa(3, { et: 'single', event: 'Single', desc: 'Batter 3 singles on a line drive to left fielder.', endMsAgo: 3 * MIN }));
  const priorMarker = poll === 1
    ? [{ index: 1, type: 'action', details: { eventType: 'os_ruling_pending_prior', event: 'Official Scorer Ruling Pending', description: 'Official Scorer Ruling Pending' } }]
    : [];
  plays.push(pa(4, { complete: false, hit: false, events: priorMarker, endMsAgo: 1 * MIN }));
  return { allPlays: plays };
}

function game2() {
  return {
    allPlays: [
      pa(5, { et: 'field_error', event: 'Field Error', desc: 'Batter 5 reaches on a fielding error by third baseman Al Third.', credits: [{ player: { id: 4005 }, position: { code: '5', abbreviation: '3B' }, credit: 'f_fielding_error' }], endMsAgo: 240 * MIN }),
      pa(9, { et: 'field_error', event: 'Field Error', desc: 'Batter 9 reaches on a fielding error by third baseman Al Third.', credits: [{ player: { id: 4005 }, position: { code: '5', abbreviation: '3B' }, credit: 'f_fielding_error' }], endMsAgo: 420 * MIN }),
    ],
  };
}

globalThis.fetch = (input) => {
  const url = String(input && input.url ? input.url : input);
  let m;
  if (/\/api\/v1\/schedule\?sportId=1&startDate=/.test(url)) {
    schedulePolls += 1;
    const live = schedulePolls <= 2;
    const date = new Date(NOW).toISOString().slice(0, 10);
    return respond({ dates: [{ date, games: [
      { gamePk: 900001, gameType: 'R', season: '2026', officialDate: date, gameDate: iso(90 * MIN), status: live ? { abstractGameState: 'Live', codedGameState: 'I', detailedState: 'In Progress' } : { abstractGameState: 'Final', codedGameState: 'F', detailedState: 'Final' }, teams: { away: { team: { id: 901, abbreviation: 'AAA' } }, home: { team: { id: 902, abbreviation: 'BBB' } } } },
      { gamePk: 900002, gameType: 'R', season: '2026', officialDate: date, gameDate: iso(300 * MIN), status: { abstractGameState: 'Final', codedGameState: 'F', detailedState: 'Final' }, teams: { away: { team: { id: 903, abbreviation: 'CCC' } }, home: { team: { id: 904, abbreviation: 'DDD' } } } },
      { gamePk: 900003, gameType: 'S', season: '2026', officialDate: date, gameDate: iso(60 * MIN), status: { abstractGameState: 'Live', codedGameState: 'I', detailedState: 'In Progress' }, teams: { away: { team: { id: 905, abbreviation: 'EEE' } }, home: { team: { id: 906, abbreviation: 'FFF' } } } },
    ] }] });
  }
  if ((m = url.match(/\/api\/v1\/game\/(\d+)\/playByPlay\?fields=/))) {
    if (!url.includes('isComplete') || !url.includes('endTime')) return Promise.resolve({ ok: false, status: 400, text: async () => 'projection must include isComplete,endTime', json: async () => ({}) });
    const pk = Number(m[1]);
    if (pk === 900001) return respond(game1(Math.min(schedulePolls, 3)));
    if (pk === 900002) return respond(game2());
    if (pk === 900003) throw new Error('spring training games must not be polled');
  }
  return Promise.resolve({ ok: false, status: 404, text: async () => `unstubbed ${url}`, json: async () => ({}) });
};
