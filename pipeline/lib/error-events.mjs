/* ============================================================================
 * pipeline/lib/error-events.mjs — every ERROR of every completed game, play by
 * play, with the video evidence (session-5 charter: "a complete and thorough
 * game by game play by play scan for all games … look at all events with a
 * link to the video evidence").
 *
 * Input is the pipeline's compact per-plate-appearance records
 * (statsapi.mjs extractGamePlays — StatsAPI playByPlay, final state):
 *   rec.et / ev / desc      the play's current ruling
 *   rec.errs[]              every error credit on the play
 *                           (runners[].credits: f_fielding_error,
 *                           f_throwing_error, f_error_dropped_ball,
 *                           c_catcher_interf, …) with the runner, the fielder,
 *                           and the playId of the event it happened on
 *   rec.vid                 playId of the play's final pitch/event
 *   rec.rbi / er / ur       RBI, earned and unearned runs scored on the play
 * An event is minted for a plate appearance when it carries at least one
 * error credit NOW, or when its ORIGINAL ruling was a batter-reached-on-error
 * (an error the official log later changed to a hit carries no error credit
 * any more — `initialErrorIds`). Nothing is inferred: fields the data does not
 * carry are null.
 *
 * Video evidence: https://baseballsavant.mlb.com/sporty-videos?playId=<vid>
 * (verified 2026-09-24 for playId 8552c454-1f49-3d56-a8cc-b6fd75ccb380 →
 * Savant's video page for Andrew Vaughn vs Andrew Abbott, CIN @ MIL,
 * 2026-09-11 — the play of official log 2026 #249).
 * ==========================================================================*/

export const ERROR_KIND_BY_CREDIT = {
  f_fielding_error: 'fielding',
  f_throwing_error: 'throwing',
  f_error_dropped_ball: 'missed_catch',
  c_catcher_interf: 'catcher_interference',
  f_defensive_shift_violation_error: 'shift_violation',
};
const HIT_EVENTS = new Set(['single', 'double', 'triple', 'home_run']);

export function errorKindOfCredit(credit) {
  return ERROR_KIND_BY_CREDIT[credit] || (/error/.test(String(credit || '')) ? 'other_error' : null);
}

export function savantVideoUrl(playId) {
  return playId ? `https://baseballsavant.mlb.com/sporty-videos?playId=${encodeURIComponent(playId)}` : null;
}

/** Scope of an error play: the batter reached on it, it rode on a hit, or other. */
export function errorScope(rec, initiallyError = false) {
  if (!rec) return null;
  if (rec.et === 'field_error' || initiallyError) return 'batter_reached';
  if (HIT_EVENTS.has(rec.et)) return 'on_hit';
  return 'other';
}

/** Scan-coverage row for one completed game. */
export function gameScanRow(g, plays, abbr) {
  const list = Array.isArray(plays) ? plays : null;
  const pas = list ? list.filter((r) => r.ty === 'atBat').length : 0;
  const errorPlays = list ? list.filter((r) => r.ty === 'atBat' && ((r.errs && r.errs.length) || r.et === 'field_error')).length : 0;
  const errors = list ? list.reduce((n, r) => n + (r.errs ? r.errs.length : 0), 0) : 0;
  return {
    gamePk: g.gamePk,
    date: g.officialDate || null,
    gameType: g.gameType || null,
    away: (abbr && abbr.get(g.awayId)) || null,
    home: (abbr && abbr.get(g.homeId)) || null,
    scanned: !!list,
    pas,
    errorPlays,
    errors,
  };
}

/**
 * @param {object} o
 *   games            completed games of the season (schedule rows)
 *   playsByGame      Map gamePk → compact records
 *   abbr             Map teamId → abbreviation
 *   officialByPlay   Map "gamePk:ai" → [{seq, kind, transition, flags, raw}]
 *   errorRowById     Map "gamePk:ai" → { y, final, chain } (model population:
 *                    plays whose ORIGINAL ruling was a batter-reached error)
 *   scoreById        (id) → { p, score, kind } | null   (error → hit model)
 *   savantById       Map id → { xba, ls, la }
 * @returns {{ games: object[], events: object[] }}
 */
export function buildErrorEvents({
  games, playsByGame, abbr, officialByPlay = new Map(), errorRowById = new Map(),
  scoreById = () => null, savantById = new Map(),
}) {
  const gameRows = [];
  const events = [];
  const gameById = new Map(games.map((g) => [g.gamePk, g]));
  for (const g of games) {
    const plays = playsByGame.get(g.gamePk) || null;
    gameRows.push(gameScanRow(g, plays, abbr));
    if (!plays) continue;
    for (const rec of plays) {
      if (rec.ty !== 'atBat') continue;
      const id = `${g.gamePk}:${rec.ai}`;
      const errRow = errorRowById.get(id) || null;
      const errs = Array.isArray(rec.errs) ? rec.errs : [];
      if (!errs.length && !errRow && rec.et !== 'field_error') continue;
      const scope = errorScope(rec, !!errRow);
      const official = officialByPlay.get(id) || [];
      let status = null; let final = null;
      if (errRow) {
        final = errRow.final || null;
        status = errRow.y === 1 ? 'changed_to_hit'
          : (errRow.chain && errRow.chain.length && errRow.final !== 'error') ? 'changed_other' : 'stands';
      }
      const sc = scope === 'batter_reached' && errRow ? scoreById(errRow) : null;
      const sv = savantById.get(id);
      const gg = gameById.get(g.gamePk) || g;
      events.push({
        id,
        gamePk: g.gamePk,
        date: gg.officialDate || null,
        gameType: gg.gameType || null,
        away: (abbr && abbr.get(gg.awayId)) || null,
        home: (abbr && abbr.get(gg.homeId)) || null,
        ai: rec.ai,
        inning: rec.inn ?? null,
        half: rec.top ? 'top' : 'bottom',
        batter: rec.bn || null,
        batterId: rec.b ?? null,
        pitcher: rec.pn || null,
        pitcherId: rec.p ?? null,
        eventType: rec.et || null,
        event: rec.ev || null,
        description: rec.desc || null,
        vid: rec.vid || null,
        rbi: rec.rbi ?? null,
        er: rec.er || 0,
        ur: rec.ur || 0,
        tu: rec.tu || 0,
        scope,
        errors: errs.map((x) => ({
          kind: errorKindOfCredit(x.k),
          credit: x.k,
          pos: x.pos || null,
          fielderId: x.f ?? null,
          runner: x.rn || null,
          runnerId: x.r ?? null,
          onBatter: x.b === 1,
          vid: x.vid || null,
        })),
        model: sc ? { p: sc.p, score: sc.score, kind: sc.kind } : null,
        status,
        final,
        official: official.map((o) => ({ seq: o.seq, kind: o.kind, transition: o.transition || null, flags: o.flags || [], raw: o.raw })),
        ...(sv ? { savant: { xba: sv.xba, ls: sv.ls, la: sv.la } } : {}),
      });
    }
  }
  events.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || b.gamePk - a.gamePk || b.ai - a.ai);
  gameRows.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || b.gamePk - a.gamePk);
  return { games: gameRows, events };
}
