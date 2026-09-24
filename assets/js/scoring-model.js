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

  /**
   * Error type of a play scored as an error. StatsAPI states it in the
   * fielding credits of runners[] (credit codes seen in 2024–2026 data:
   * f_fielding_error, f_throwing_error, f_error_dropped_ball,
   * f_defensive_shift_violation_error) and in the description ("fielding
   * error", "throwing error", "missed catch error", ...). Credits on the
   * batter's own runner entry win; the description is the fallback.
   * IMPORTANT: this is the type of the ruling *as it currently stands*. A play
   * later changed to a hit no longer carries its original error type, so the
   * type is only a leakage-free model input when it was captured before any
   * change (data/capture, see pipeline/capture.mjs).
   */
  var ERROR_KIND_BY_CREDIT = {
    f_fielding_error: 'fielding',
    f_throwing_error: 'throwing',
    f_error_dropped_ball: 'missed_catch',
    f_defensive_shift_violation_error: 'shift_violation',
  };
  var ERROR_KIND_LABELS = {
    fielding: 'Fielding error',
    throwing: 'Throwing error',
    missed_catch: 'Missed-catch error',
    shift_violation: 'Shift-violation error',
  };
  function errorKindFromDescription(desc) {
    var d = String(desc || '').toLowerCase();
    if (!d) return null;
    if (d.indexOf('throwing error') >= 0) return 'throwing';
    if (d.indexOf('fielding error') >= 0) return 'fielding';
    if (d.indexOf('missed catch error') >= 0 || /dropped (throw|ball|fly)[^.]*error/.test(d)) return 'missed_catch';
    if (d.indexOf('shift violation') >= 0) return 'shift_violation';
    return null;
  }
  /** credits: [{credit, batter:boolean, pos}] → {kind, pos} or null. */
  function errorKindFromCredits(credits) {
    var list = credits || [];
    var pick = null;
    for (var pass = 0; pass < 2 && !pick; pass += 1) {
      for (var i = 0; i < list.length; i += 1) {
        var c = list[i] || {};
        if (!ERROR_KIND_BY_CREDIT[c.credit]) continue;
        if (pass === 0 && !c.batter) continue;
        pick = c;
        break;
      }
    }
    return pick ? { kind: ERROR_KIND_BY_CREDIT[pick.credit], pos: pick.pos || null } : null;
  }
  /** Error type of a StatsAPI allPlays element → {kind, pos} or null. */
  function errorKindOfStatsApiPlay(apiPlay) {
    var batterId = apiPlay && apiPlay.matchup && apiPlay.matchup.batter && apiPlay.matchup.batter.id;
    var credits = [];
    var runners = (apiPlay && apiPlay.runners) || [];
    for (var i = 0; i < runners.length; i += 1) {
      var r = runners[i] || {};
      var isBatter = !!(r.details && r.details.runner && batterId != null && r.details.runner.id === batterId);
      var cr = r.credits || [];
      for (var j = 0; j < cr.length; j += 1) {
        var c = cr[j] || {};
        credits.push({ credit: c.credit, batter: isBatter, pos: c.position ? (c.position.abbreviation || c.position.code || null) : null });
      }
    }
    var fromCredits = errorKindFromCredits(credits);
    if (fromCredits) return fromCredits;
    var kind = errorKindFromDescription(apiPlay && apiPlay.result && apiPlay.result.description);
    return kind ? { kind: kind, pos: null } : null;
  }
  /** Error type of a pipeline compact record (cr = "credit|pos|playerId|B/R"). */
  function errorKindOfRecord(rec) {
    var credits = [];
    var cr = (rec && rec.cr) || [];
    for (var i = 0; i < cr.length; i += 1) {
      var parts = String(cr[i]).split('|');
      credits.push({ credit: parts[0], pos: parts[1] || null, batter: parts[3] === 'B' });
    }
    var fromCredits = errorKindFromCredits(credits);
    if (fromCredits) return fromCredits;
    var kind = errorKindFromDescription(rec && rec.desc);
    return kind ? { kind: kind, pos: null } : null;
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
    // Official scorer of the game (StatsAPI gameData.officialScorer.id).
    if (term.indexOf('scorer:') === 0) return play.scorerId != null && String(play.scorerId) === term.slice(7) ? 1 : 0;
    // Error type of the ruling as first captured (only in the captured-data adjustment).
    if (term.indexOf('kind:') === 0) return play.errKind === term.slice(5) ? 1 : 0;
    throw new Error('Unknown model term: ' + term);
  }
  /**
   * Inputs that can be unknown at prediction time (the game's official scorer
   * before it is loaded, the error type of a play already changed to a hit)
   * use the term's training-data mean instead of 0, i.e. the average effect —
   * never silently the effect of the reference group.
   */
  function missingInput(term, play) {
    if (term.indexOf('scorer:') === 0) return play.scorerId == null;
    if (term.indexOf('kind:') === 0) return play.errKind == null;
    return false;
  }

  function featureVector(spec, hp, play) {
    var out = [];
    var means = spec.termMeans || null;
    for (var j = 0; j < spec.terms.length; j += 1) {
      var term = spec.terms[j];
      if (missingInput(term, play)) out.push(means && isFiniteNumber(means[term]) ? means[term] : 0);
      else out.push(featureValue(term, hp, play));
    }
    return out;
  }
  /**
   * Captured-data adjustment (spec.adjust, fitted by the pipeline on rulings
   * captured live before any change): a logit shift plus error-type terms on
   * top of the main model. Applied only when the pipeline marked it active
   * (enough captured changes AND a cross-validated improvement).
   */
  function adjustmentFor(spec, play) {
    var a = spec && spec.adjust;
    if (!a || !a.active || !a.terms) return null;
    var z = isFiniteNumber(a.intercept) ? a.intercept : 0;
    var x = featureVector(a, null, play);
    for (var j = 0; j < x.length; j += 1) z += a.coef[j] * x[j];
    return { logit: z, terms: a.terms.slice(), values: x };
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
    var adj = adjustmentFor(spec, play);
    if (adj) z += adj.logit;
    var p = sigmoid(z);
    var score = toScore(p);
    return {
      probability: p,
      score: score,
      scoreText: scoreText(p),
      // Per-question bands (derived from that question's base rate by the
      // pipeline) take precedence over the model-wide default bands.
      band: band(spec.bands ? { bands: spec.bands } : model, score),
      relativeToBase: spec.baseRate ? p / spec.baseRate : null,
      hitProbability: hp.p,
      hitProbabilitySource: hp.source,
      baseRate: spec.baseRate != null ? spec.baseRate : null,
      terms: spec.terms.slice(),
      values: x,
      contributions: contributions,
      adjustment: adj,
      errorKind: play.errKind || null,
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
        var probs = calibratePending(t, row.p);
        var dist = [];
        for (var o = 0; o < t.outcomes.length; o += 1) {
          var name = t.outcomes[o];
          var p = probs.p[o];
          if (!(p > 0)) continue;
          dist.push({
            outcome: name, label: OUTCOME_LABELS[name] || name, probability: p, score: toScore(p), scoreText: scoreText(p),
            rawProbability: row.p[o],
          });
        }
        dist.sort(function (a, b) { return b.probability - a.probability; });
        return { key: keys[k], level: k, n: row.n, distribution: dist, calibrated: probs.calibrated, calibrationN: probs.n };
      }
    }
    return null;
  }
  /**
   * Pending-ruling calibration (model.pending.calibration, fitted by the
   * pipeline on pending rulings captured live and their resolutions): the
   * comparable-ball distribution is re-weighted per outcome, w_o =
   * (observed_o + a) / (expected_o + a), then renormalised. Applied only when
   * the pipeline marked it active (enough resolved rulings AND a
   * leave-one-out improvement).
   */
  function calibratePending(table, p) {
    var c = table && table.calibration;
    if (!c || !c.active || !c.weights) return { p: p, calibrated: false, n: 0 };
    var out = [];
    var s = 0;
    for (var o = 0; o < table.outcomes.length; o += 1) {
      var w = c.weights[table.outcomes[o]];
      var v = (p[o] || 0) * (isFiniteNumber(w) && w > 0 ? w : 1);
      out.push(v);
      s += v;
    }
    if (!(s > 0)) return { p: p, calibrated: false, n: 0 };
    for (var i = 0; i < out.length; i += 1) out[i] /= s;
    return { p: out, calibrated: true, n: c.resolved || 0 };
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
    var ek = res.eventType === 'field_error' ? errorKindOfStatsApiPlay(apiPlay) : null;
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
      // Live, the ruling on screen IS the original call, so its error type
      // is a legitimate input (see errorKindOfStatsApiPlay).
      errKind: ek ? ek.kind : null,
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

  /**
   * The play a pending ruling is about: the marker's own plate appearance for
   * os_ruling_pending_primary; the previous one for os_ruling_pending_prior
   * (a base-running marker that refers to the prior play).
   */
  function pendingTarget(review) {
    var codes = (review && review.pendingCodes) || [];
    if (!review || review.atBatIndex == null) return null;
    if (codes.indexOf('os_ruling_pending_primary') >= 0 || codes.indexOf('os_ruling_pending_prior') < 0) {
      return review.atBatIndex;
    }
    return review.atBatIndex > 0 ? review.atBatIndex - 1 : null;
  }

  function assign(target, source) {
    if (source) for (var k in source) if (Object.prototype.hasOwnProperty.call(source, k)) target[k] = source[k];
    return target;
  }

  /**
   * Score a scoring-change or pending review row from StatsAPI plays.
   * lookupPlay(atBatIndex) → allPlays element (with playEvents / runners).
   * Returns {kind: 'errorToHit'|'hitToError'|'pending', result|distribution,
   * battedBall, target} or null when the model does not apply.
   */
  function scoreReview(model, review, lookupPlay, homeId, scorerId) {
    if (!model || !review || review.atBatIndex == null || typeof lookupPlay !== 'function') return null;
    var top = review.halfInning === 'top' ? true : review.halfInning === 'bottom' ? false : null;
    var sid = scorerId != null ? scorerId : null;
    if (review.typeKey === 'scoring_change') {
      var et = review.initial && review.initial.eventType;
      var fromError = et === 'field_error';
      var fromHit = !!HIT_EVENTS[et] && et !== 'home_run';
      if (!fromError && !fromHit) return null;
      var p = lookupPlay(review.atBatIndex);
      var bb = p ? battedBallFromEvents(p.playEvents) : null;
      // The tracked INITIAL call carries the original error type.
      var initialDesc = review.initialDescription || (review.initial && review.initial.description) || null;
      var play = assign({
        et: et, top: top, homeId: homeId != null ? homeId : null, scorerId: sid,
        errKind: fromError ? errorKindFromDescription(initialDesc) : null,
      }, bb);
      var res = fromError ? scoreErrorToHit(model, play) : scoreHitToError(model, play);
      return res ? { kind: fromError ? 'errorToHit' : 'hitToError', result: res, battedBall: bb, target: review.atBatIndex } : null;
    }
    if (review.typeKey === 'pending_scoring') {
      var target = pendingTarget(review);
      if (target == null) return null;
      var tp = lookupPlay(target);
      var tbb = tp ? battedBallFromEvents(tp.playEvents) : null;
      var dist = pendingDistribution(model, assign({ top: top, homeId: homeId != null ? homeId : null, scorerId: sid }, tbb), tp ? batterReached(tp) : null);
      return dist ? { kind: 'pending', distribution: dist, battedBall: tbb, target: target } : null;
    }
    return null;
  }

  var api = {
    OUTCOME_LABELS: OUTCOME_LABELS,
    DEFAULT_BANDS: DEFAULT_BANDS,
    ERROR_KIND_BY_CREDIT: ERROR_KIND_BY_CREDIT,
    ERROR_KIND_LABELS: ERROR_KIND_LABELS,
    errorKindFromDescription: errorKindFromDescription,
    errorKindFromCredits: errorKindFromCredits,
    errorKindOfStatsApiPlay: errorKindOfStatsApiPlay,
    errorKindOfRecord: errorKindOfRecord,
    adjustmentFor: adjustmentFor,
    calibratePending: calibratePending,
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
    pendingTarget: pendingTarget,
    scoreReview: scoreReview,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MLBScoringModel = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
