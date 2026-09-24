/* ============================================================================
 * pipeline/lib/capture-lib.mjs — the live ruling ledger (pure, no network).
 *
 * WHY THIS EXISTS (verified 2026-09-24, see docs/MODEL.md §14): MLB StatsAPI
 * rewrites history. Timecode snapshots (feed/live?timecode=…) and diffPatch
 * return the CURRENT ruling even for moments before a scoring change — e.g.
 * 2026 official log #3 (game 824943, atBatIndex 36, "Ozzie Albies now has a
 * single instead of … an error charged to Max Muncy"): the diffPatch that
 * completed the play at 00:28:35 UTC already says "single". So a play's
 * ORIGINAL call (and its error type) can only be known if it was recorded
 * before it changed. pipeline/capture.mjs polls live games and keeps that
 * record here; the pipeline trains and calibrates on it.
 *
 * Ledger entry (one per plate appearance worth tracking):
 *   id "gamePk:atBatIndex", g, ai, date (officialDate), gt (gameType), season,
 *   awayId, homeId, away, home, inn, top, b, bn, end (about.endTime),
 *   hd {ls, la, traj, loc} batted ball, br (batter reached 1/0/null),
 *   why ["error"|"pending"...],
 *   states [{at, et, ev, desc, kind, pos, pend, gs}]  — states[0] is the call
 *     as FIRST SEEN; a new state is appended only when the ruling itself
 *     changes (eventType / error type / charged position / pending marker),
 *     never for wording-only edits,
 *   score {e2h:{p, score, modelAt}, pending:{dist, n, level, modelAt}} — what
 *     the published model said when the play was first captured.
 * ==========================================================================*/

import { PBP_FIELDS } from './statsapi.mjs';

export const CAPTURE_SCHEMA = 1;
// Same projection as the pipeline, plus completion flags and play end times.
export const CAPTURE_FIELDS = `${PBP_FIELDS},endTime,isComplete`;
// A play first seen more than this long after it ended is not "captured
// live" (its call may already have changed); such plays are not added.
export const MAX_NEW_LAG_MIN = 360;
export const STATUS_HEARTBEAT_MS = 3 * 3600 * 1000;

const round = (v, d = 4) => (typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(d)) : null);

/** Pending markers of a whole game → Map(targetAtBatIndex → marker info). */
export function pendingByTarget(allPlays, R, SM) {
  const out = new Map();
  for (const play of allPlays || []) {
    const ai = play && play.about ? play.about.atBatIndex : null;
    if (ai == null) continue;
    const found = R.findOfficialScoringPendingPlay(play);
    if (!found) continue;
    const target = SM.pendingTarget({ atBatIndex: ai, pendingCodes: found.pendingCodes });
    if (target == null) continue;
    const ev = found.pendingEvents[0] || null;
    const d = (ev && ev.details) || {};
    const res = play.result || {};
    const info = {
      codes: found.pendingCodes.slice().sort(),
      onAi: ai,
      atResult: !!found.atResult,
      // Raw marker fields, kept verbatim: no real pending payload had been
      // documented when this was written, so the ledger records its shape.
      marker: ev
        ? { eventType: d.eventType || null, event: d.event || null, description: d.description || null, type: ev.type || null }
        : { eventType: res.eventType || null, event: res.event || null, description: res.description || null, type: null },
    };
    const prev = out.get(target);
    if (prev) {
      prev.codes = [...new Set([...prev.codes, ...info.codes])].sort();
    } else {
      out.set(target, info);
    }
  }
  return out;
}

/** The ruling of one plate appearance at one poll. */
export function paState(play, pend, SM, at, gameState) {
  const res = (play && play.result) || {};
  const ek = play ? SM.errorKindOfStatsApiPlay(play) : null;
  return {
    at,
    et: res.eventType || null,
    ev: res.event || null,
    desc: res.description || null,
    kind: ek ? ek.kind : null,
    pos: ek ? ek.pos : null,
    pend: pend || null,
    gs: gameState || null,
  };
}

/** What makes two states different rulings (wording-only edits excluded). */
export function stateSig(s) {
  if (!s) return '';
  return [s.et || '-', s.kind || '-', s.pos || '-', s.pend ? s.pend.codes.join('+') : ''].join('|');
}

function battedBall(play, SM) {
  const bb = SM.battedBallFromEvents(play && play.playEvents);
  if (!bb) return null;
  return { ls: bb.ls, la: bb.la, traj: bb.traj, loc: bb.loc };
}

function scoreAtCapture(entry, play, model, SM) {
  if (!model) return null;
  const base = SM.playFromStatsApi(play);
  const p = Object.assign(base, { homeId: entry.homeId });
  const out = {};
  const last = entry.states[entry.states.length - 1];
  if (entry.states.some((s) => s.et === 'field_error')) {
    // Score the error call as first seen (its error type included).
    const first = entry.states.find((s) => s.et === 'field_error');
    const r = SM.scoreErrorToHit(model, Object.assign({}, p, { et: 'field_error', errKind: first.kind }));
    if (r) out.e2h = { p: round(r.probability), score: r.score, modelAt: model.generatedAt || null };
  }
  if (entry.states.some((s) => s.pend) || (last && last.pend)) {
    const d = SM.pendingDistribution(model, p, SM.batterReached(play));
    if (d) {
      out.pending = {
        dist: d.distribution.map((x) => ({ o: x.outcome, p: round(x.probability) })),
        n: d.n, level: d.level, calibrated: !!d.calibrated, modelAt: model.generatedAt || null,
      };
    }
  }
  return Object.keys(out).length ? out : null;
}

function lagMinutes(endIso, atIso) {
  const a = Date.parse(atIso); const e = Date.parse(endIso);
  return Number.isFinite(a) && Number.isFinite(e) ? (a - e) / 60000 : null;
}

/**
 * Apply one poll of one game to the ledger (Map id → entry). Returns counts
 * {added, changed, filled}. Pure apart from mutating `ledger`.
 * game: {gamePk, officialDate, gameType, season, awayId, homeId, away, home,
 *        abstractGameState}
 */
export function updateLedger(ledger, game, allPlays, { nowIso, model = null, SM, R, maxNewLagMin = MAX_NEW_LAG_MIN } = {}) {
  const counts = { added: 0, changed: 0, filled: 0 };
  const plays = Array.isArray(allPlays) ? allPlays : [];
  const byAi = new Map();
  for (const p of plays) if (p && p.about && p.about.atBatIndex != null) byAi.set(p.about.atBatIndex, p);
  const pend = pendingByTarget(plays, R, SM);
  const candidates = new Set();
  for (const [ai, p] of byAi) {
    const res = p.result || {};
    if (res.eventType === 'field_error' && p.about.isComplete !== false) candidates.add(ai);
    if (ledger.has(`${game.gamePk}:${ai}`)) candidates.add(ai);
  }
  for (const ai of pend.keys()) if (byAi.has(ai)) candidates.add(ai);

  for (const ai of [...candidates].sort((a, b) => a - b)) {
    const play = byAi.get(ai);
    const id = `${game.gamePk}:${ai}`;
    const state = paState(play, pend.get(ai) || null, SM, nowIso, game.abstractGameState);
    let entry = ledger.get(id);
    if (!entry) {
      const about = play.about || {};
      const lag = lagMinutes(about.endTime, nowIso);
      if (lag != null && lag > maxNewLagMin) continue; // not captured live
      if (!state.et && !state.pend) continue;
      const m = play.matchup || {};
      entry = {
        id, g: game.gamePk, ai, date: game.officialDate || null, gt: game.gameType || null,
        season: game.season || (game.officialDate ? Number(game.officialDate.slice(0, 4)) : null),
        awayId: game.awayId ?? null, homeId: game.homeId ?? null, away: game.away || null, home: game.home || null,
        inn: about.inning ?? null, top: about.isTopInning === true ? true : about.isTopInning === false ? false : null,
        b: (m.batter && m.batter.id) ?? null, bn: (m.batter && m.batter.fullName) || null,
        end: about.endTime || null,
        hd: battedBall(play, SM),
        br: (() => { const r = SM.batterReached(play); return r === true ? 1 : r === false ? 0 : null; })(),
        why: [],
        states: [state],
        score: null,
      };
      if (state.et === 'field_error') entry.why.push('error');
      if (state.pend) entry.why.push('pending');
      entry.score = scoreAtCapture(entry, play, model, SM);
      ledger.set(id, entry);
      counts.added += 1;
      continue;
    }
    const last = entry.states[entry.states.length - 1];
    let touched = false;
    if (stateSig(state) !== stateSig(last)) {
      entry.states.push(state);
      if (state.et === 'field_error' && !entry.why.includes('error')) entry.why.push('error');
      if (state.pend && !entry.why.includes('pending')) entry.why.push('pending');
      counts.changed += 1;
      touched = true;
    }
    // Statcast data can arrive a little after the play: fill it in once.
    if (!entry.hd || (entry.hd.ls == null && entry.hd.traj == null)) {
      const hd = battedBall(play, SM);
      if (hd && (hd.ls != null || hd.traj != null)) {
        entry.hd = hd;
        counts.filled += 1;
        touched = true;
      }
    }
    if (touched || !entry.score) {
      const s = scoreAtCapture(entry, play, model, SM);
      if (s && JSON.stringify(s) !== JSON.stringify(entry.score)) {
        // Keep the model's first word on a pending play; only fill gaps.
        entry.score = Object.assign({}, s, entry.score && entry.score.pending ? { pending: entry.score.pending } : {});
        if (!touched) { counts.filled += 1; touched = true; }
      }
    }
  }
  return counts;
}

/** Month file for a play ("2026-09"). */
export function monthOf(entry) {
  return entry.date ? entry.date.slice(0, 7) : 'unknown';
}

/** Stable, diff-friendly JSON: one play per line, ordered by game then PA. */
export function serializeMonth(month, entries, updatedAt) {
  const sorted = entries.slice().sort((a, b) => a.g - b.g || a.ai - b.ai);
  const head = {
    schema: CAPTURE_SCHEMA,
    month,
    source: 'MLB StatsAPI /api/v1/game/{gamePk}/playByPlay polled during live games by pipeline/capture.mjs',
    updatedAt,
    count: sorted.length,
  };
  const lines = sorted.map((e) => JSON.stringify(e));
  const headJson = JSON.stringify(head, null, 1).replace(/\n}$/, '');
  return `${headJson},\n "plays": [\n${lines.join(',\n')}\n ]\n}\n`;
}

/** Parse a month file → entries (tolerant of a missing/corrupt file). */
export function parseMonth(text) {
  try {
    const j = JSON.parse(text);
    return Array.isArray(j.plays) ? j.plays : [];
  } catch {
    return [];
  }
}

/** Should the status heartbeat be rewritten this run? */
export function statusDue(prevStatus, now, changed) {
  if (changed) return true;
  const last = prevStatus && Date.parse(prevStatus.lastRunAt);
  return !Number.isFinite(last) || now - last >= STATUS_HEARTBEAT_MS;
}

/** Games worth polling: live ones, plus recently started finished ones. */
export function selectGames(games, nowMs, { finalHours = 14, includeFinals = true } = {}) {
  const OK_TYPES = new Set(['R', 'F', 'D', 'L', 'W']);
  const live = []; const finals = [];
  for (const g of games) {
    if (!OK_TYPES.has(g.gameType)) continue;
    if (g.abstractGameState === 'Live') live.push(g);
    else if (includeFinals && (g.codedGameState === 'F' || g.codedGameState === 'O')) {
      const start = Date.parse(g.gameDate);
      if (Number.isFinite(start) && nowMs - start <= finalHours * 3600 * 1000) finals.push(g);
    }
  }
  return { live, finals };
}
