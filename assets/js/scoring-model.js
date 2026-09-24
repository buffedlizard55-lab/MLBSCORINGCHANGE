/* ============================================================================
 * assets/js/scoring-model.js — MLBScoringModel
 *
 * Pure scoring functions shared by the browser (live feed, scoring page) and
 * the Node pipeline (pipeline/run.mjs), so a play gets the same score
 * everywhere. No network, no DOM. Parameters come from
 * data/model/scoring-model.json, which the pipeline fits from official MLB
 * data (see docs/MODEL.md for methodology, metrics and limitations).
 *
 * Questions answered:
 *   errorToHit  P(a play scored "reached on error" is officially changed to a
 *               hit)  → score 0–100
 *   hitToError  P(a play scored as a hit is officially changed to an error)
 *   pending     for "Official Scorer Ruling Pending" plays: probability of
 *               each final ruling (hit / error / fielder's choice / out / ...)
 * ==========================================================================*/
(function (root) {
  'use strict';

  var HIT_EVENTS = { single: 1, double: 1, triple: 1, home_run: 1 };

  var OUTCOME_LABELS = {
    hit: 'Hit (single or better)',
    error: 'Error',
    fc: "Fielder's choice",
    out: 'Out',
    sac: 'Sacrifice',
    other: 'Other',
  };

  function isFiniteNumber(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function sigmoid(z) {
    return z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
  }

  function logit(p) {
    var q = clamp(p, 0.005, 0.995);
    return Math.log(q / (1 - q));
  }

  /** StatsAPI hitData.location (fielder number) → position group. */
  function locationGroup(loc) {
    var s = loc == null ? '' : String(loc).trim();
    var c = s.charAt(0);
    switch (c) {
      case '1': return 'P';
      case '2': return 'C';
      case '3': return '1B';
      case '4': return '2B';
      case '5': return '3B';
      case '6': return 'SS';
      case '7': case '8': case '9': return 'OF';
      default: return 'UNK';
    }
  }

  /** StatsAPI hitData.trajectory → trajectory group. */
  function trajGroup(traj) {
    var t = String(traj || '').toLowerCase();
    if (!t) return 'unknown';
    if (t.indexOf('bunt') === 0) return 'bunt';
    if (t === 'ground_ball' || t === 'line_drive' || t === 'fly_ball' || t === 'popup') return t;
    return 'unknown';
  }

  function surfaceRate(surface, ls, la) {
    if (!surface || !isFiniteNumber(ls) || !isFiniteNumber(la)) return null;
    var i = clamp(Math.floor((ls - surface.evMin) / surface.evStep), 0, surface.nEv - 1);
    var j = clamp(Math.floor((la - surface.laMin) / surface.laStep), 0, surface.nLa - 1);
    var r = surface.rate[i * surface.nLa + j];
    return isFiniteNumber(r) ? r : null;
  }

  /**
   * Empirical hit probability of comparable batted balls (xBA-style):
   * exit velocity × launch angle cell rate, else trajectory × fielder rate.
   */
  function hitProbability(model, play) {
    var hp = model && model.hitProb;
    if (!hp) return { p: null, source: 'none' };
    var r = surfaceRate(hp.surface, play.ls, play.la);
    if (r != null) return { p: r, source: 'ev_la' };
    var fb = hp.fallback || {};
    var tg = trajGroup(play.traj);
    var key = tg + '|' + locationGroup(play.loc);
    if (fb.byTrajLoc && isFiniteNumber(fb.byTrajLoc[key])) return { p: fb.byTrajLoc[key], source: 'traj_loc' };
    if (fb.byTraj && isFiniteNumber(fb.byTraj[tg])) return { p: fb.byTraj[tg], source: 'traj' };
    return { p: isFiniteNumber(fb.overall) ? fb.overall : null, source: 'overall' };
  }

  var INFIELD = { P: 1, C: 1, '1B': 1, '2B': 1, '3B': 1, SS: 1 };

  function featureValue(term, hp, play) {
    if (term === 'logit_hit_prob') return logit(isFiniteNumber(hp) ? hp : 0.3);
    if (term === 'ev_z') return isFiniteNumber(play.ls) ? (play.ls - 88) / 15 : 0;
    if (term === 'la_z') return isFiniteNumber(play.la) ? (play.la - 12) / 25 : 0;
    if (term === 'ev_missing') return isFiniteNumber(play.ls) && isFiniteNumber(play.la) ? 0 : 1;
    if (term === 'batting_home') return play.top === false ? 1 : 0;
    if (term === 'infield') return INFIELD[locationGroup(play.loc)] ? 1 : 0;
    if (term.indexOf('loc:') === 0) return locationGroup(play.loc) === term.slice(4) ? 1 : 0;
    if (term.indexOf('traj:') === 0) return trajGroup(play.traj) === term.slice(5) ? 1 : 0;
    // Home club (the official scorer is assigned by the home park).
    if (term.indexOf('home:') === 0) return play.homeId != null && String(play.homeId) === term.slice(5) ? 1 : 0;
    throw new Error('Unknown model term: ' + term);
  }

  function featureVector(spec, hp, play) {
    var out = [];
    for (var j = 0; j < spec.terms.length; j += 1) out.push(featureValue(spec.terms[j], hp, play));
    return out;
  }

  /** 0–100 integer score from a probability. */
  function toScore(p) {
    if (!isFiniteNumber(p)) return null;
    return clamp(Math.round(p * 100), 0, 100);
  }

  /** Display string: "<1" for tiny non-zero probabilities. */
  function scoreText(p) {
    var s = toScore(p);
    if (s == null) return '—';
    if (s === 0 && p > 0) return '<1';
    return String(s);
  }

  var DEFAULT_BANDS = [
    { min: 80, label: 'Very likely', tone: 'high' },
    { min: 50, label: 'Likely', tone: 'high' },
    { min: 20, label: 'Watch closely', tone: 'mid' },
    { min: 5, label: 'Possible', tone: 'low' },
    { min: 0, label: 'Unlikely', tone: 'none' },
  ];

  function band(model, score) {
    var bands = (model && model.bands) || DEFAULT_BANDS;
    for (var i = 0; i < bands.length; i += 1) {
      if (score >= bands[i].min) return bands[i];
    }
    return bands[bands.length - 1];
  }

  function scoreWith(spec, model, play) {
    if (!spec || !spec.terms) return null;
    var hp = hitProbability(model, play);
    var x = featureVector(spec, hp.p, play);
    var z = spec.intercept;
    var contributions = [];
    for (var j = 0; j < x.length; j += 1) {
      z += spec.coef[j] * x[j];
      contributions.push(spec.coef[j] * x[j]);
    }
    var p = sigmoid(z);
    var score = toScore(p);
    return {
      probability: p,
      score: score,
      scoreText: scoreText(p),
      band: band(model, score),
      hitProbability: hp.p,
      hitProbabilitySource: hp.source,
      baseRate: spec.baseRate != null ? spec.baseRate : null,
      terms: spec.terms.slice(),
      values: x,
      contributions: contributions,
    };
  }

  function scoreErrorToHit(model, play) {
    return scoreWith(model && model.errorToHit, model, play);
  }

  function scoreHitToError(model, play) {
    return scoreWith(model && model.hitToError, model, play);
  }

  function binIndex(edges, v) {
    if (!edges || !isFiniteNumber(v)) return 'x';
    for (var i = 0; i < edges.length; i += 1) if (v < edges[i]) return String(i);
    return String(edges.length);
  }

  /**
   * Final-ruling distribution for a pending play, from comparable plays.
   * `reached` = batter reached base safely (true / false / unknown).
   * Returns [{outcome, label, probability, score}] sorted high → low.
   */
  function pendingDistribution(model, play, reached) {
    var t = model && model.pending;
    if (!t || !t.table) return null;
    var r = reached === true ? 'R' : reached === false ? 'O' : 'A';
    var tg = trajGroup(play.traj);
    var lg = locationGroup(play.loc);
    var keys = [
      [tg, lg, binIndex(t.evEdges, play.ls), binIndex(t.laEdges, play.la), r].join('|'),
      [tg, lg, r].join('|'),
      [tg, r].join('|'),
      r,
    ];
    for (var k = 0; k < keys.length; k += 1) {
      var row = t.table[keys[k]];
      if (row && row.n >= (t.minN || 1)) {
        var dist = [];
        for (var o = 0; o < t.outcomes.length; o += 1) {
          var name = t.outcomes[o];
          var p = row.p[o];
          if (!(p > 0)) continue;
          dist.push({ outcome: name, label: OUTCOME_LABELS[name] || name, probability: p, score: toScore(p), scoreText: scoreText(p) });
        }
        dist.sort(function (a, b) { return b.probability - a.probability; });
        return { key: keys[k], level: k, n: row.n, distribution: dist };
      }
    }
    return null;
  }

  /** Map a ruling eventType to a pending-outcome category. */
  function outcomeOf(eventType) {
    var et = String(eventType || '');
    if (HIT_EVENTS[et]) return 'hit';
    if (et === 'field_error') return 'error';
    if (et === 'fielders_choice' || et === 'fielders_choice_out') return 'fc';
    if (et.indexOf('sac_') === 0) return 'sac';
    if (/(_out|double_play|triple_play|^field_out$|^force_out$|strikeout)/.test(et)) return 'out';
    return 'other';
  }

  function battedBallFromEvents(events) {
    if (!events || !events.length) return null;
    for (var k = events.length - 1; k >= 0; k -= 1) {
      var ev = events[k];
      if (!ev || !ev.hitData) continue;
      if (ev.details && ev.details.isInPlay === false) continue;
      var h = ev.hitData;
      var c = h.coordinates || {};
      return {
        ls: isFiniteNumber(h.launchSpeed) ? h.launchSpeed : null,
        la: isFiniteNumber(h.launchAngle) ? h.launchAngle : null,
        dist: isFiniteNumber(h.totalDistance) ? h.totalDistance : null,
        traj: h.trajectory || null,
        hard: h.hardness || null,
        loc: h.location != null ? String(h.location) : null,
        cx: isFiniteNumber(c.coordX) ? c.coordX : null,
        cy: isFiniteNumber(c.coordY) ? c.coordY : null,
      };
    }
    return null;
  }

  /** Did the batter reach safely on this play? (true/false/null=unknown) */
  function batterReached(apiPlay) {
    var batterId = apiPlay && apiPlay.matchup && apiPlay.matchup.batter && apiPlay.matchup.batter.id;
    var runners = (apiPlay && apiPlay.runners) || [];
    if (!batterId || !runners.length) return null;
    var seen = false;
    for (var i = 0; i < runners.length; i += 1) {
      var r = runners[i] || {};
      var id = r.details && r.details.runner && r.details.runner.id;
      if (id !== batterId) continue;
      seen = true;
      var mv = r.movement || {};
      if (mv.isOut) return false;
    }
    return seen ? true : null;
  }

  /** Normalise a StatsAPI allPlays element (+ optional hitData override). */
  function playFromStatsApi(apiPlay, hitDataOverride) {
    var res = (apiPlay && apiPlay.result) || {};
    var about = (apiPlay && apiPlay.about) || {};
    var bb = hitDataOverride || battedBallFromEvents(apiPlay && apiPlay.playEvents) || {};
    return {
      et: res.eventType || null,
      ev: res.event || null,
      top: about.isTopInning === true ? true : about.isTopInning === false ? false : null,
      inn: about.inning != null ? about.inning : null,
      ai: about.atBatIndex != null ? about.atBatIndex : null,
      ls: bb.ls != null ? bb.ls : null,
      la: bb.la != null ? bb.la : null,
      traj: bb.traj || null,
      loc: bb.loc || null,
      dist: bb.dist != null ? bb.dist : null,
    };
  }

  /** Normalise a pipeline compact record (pipeline/lib/statsapi.mjs). */
  function playFromRecord(rec) {
    var hd = (rec && rec.hd) || {};
    return {
      et: rec.et || null,
      ev: rec.ev || null,
      top: rec.top === true ? true : rec.top === false ? false : null,
      inn: rec.inn != null ? rec.inn : null,
      ai: rec.ai != null ? rec.ai : null,
      ls: hd.ls != null ? hd.ls : null,
      la: hd.la != null ? hd.la : null,
      traj: hd.traj || null,
      loc: hd.loc || null,
      dist: hd.dist != null ? hd.dist : null,
    };
  }

  var api = {
    OUTCOME_LABELS: OUTCOME_LABELS,
    DEFAULT_BANDS: DEFAULT_BANDS,
    sigmoid: sigmoid,
    logit: logit,
    locationGroup: locationGroup,
    trajGroup: trajGroup,
    surfaceRate: surfaceRate,
    hitProbability: hitProbability,
    featureValue: featureValue,
    featureVector: featureVector,
    toScore: toScore,
    scoreText: scoreText,
    band: band,
    scoreWith: scoreWith,
    scoreErrorToHit: scoreErrorToHit,
    scoreHitToError: scoreHitToError,
    binIndex: binIndex,
    pendingDistribution: pendingDistribution,
    outcomeOf: outcomeOf,
    battedBallFromEvents: battedBallFromEvents,
    batterReached: batterReached,
    playFromStatsApi: playFromStatsApi,
    playFromRecord: playFromRecord,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MLBScoringModel = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
