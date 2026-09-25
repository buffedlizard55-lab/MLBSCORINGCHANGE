/* ============================================================================
 * pipeline/lib/official-feed-row.mjs — turn MLB's official scoring-changes
 * entries into feed-log rows (data/feed-log-<date>.json).
 *
 * WHY
 *   The live feed's rows are minted in the browser (assets/js/reviews-feed.js,
 *   mergeScoringChanges) while a game is being polled, and persisted through
 *   server.mjs (POST /api/feed-log). A visitor who only sees the static GitHub
 *   Pages site has no such server: they get whatever data/feed-log-<date>.json
 *   already holds. This module lets the official-data pipeline append the
 *   changes MLB itself has published, so a Pages-only visitor sees recent
 *   CONFIRMED changes without a server.
 *
 * WHAT IS APPENDED (and what never is)
 *   Only entries from data/official/scoring-changes-<season>.json that are
 *   ruling changes with a play the linker verified — `link.atBatIndex != null`
 *   and no `current_ruling_mismatch` flag. Nothing is inferred: every field
 *   below comes from either the official log entry (its own words, its seq,
 *   its URL) or the StatsAPI facts the pipeline linked it to
 *   (link.currentEventType / .currentEvent / .currentDescription /
 *   .batterName / .batterId / .officialDate). Fields we cannot state are left
 *   null rather than filled in (no invented scores, timestamps, or pitches).
 *
 * KEY AND SHAPE
 *   The row key is `${gamePk}:${review.id}` with `review.id = "scoring-" +
 *   atBatIndex` — EXACTLY the id the browser mints for the same play, so a
 *   visitor who later observes the change live merges onto the same row
 *   instead of creating a second one (assets/js/feed-log.js buildEventKey,
 *   server.mjs mergeFeedLogPayloads). Row shape mirrors mergeScoringChanges'
 *   output; tools/official-feed-log-test.mjs asserts the restored row
 *   classifies identically to the pipeline classifier (hit → error stays in
 *   its own section and never alerts).
 * ==========================================================================*/

/** Registry labels (StatsAPI /api/v1/eventTypes) for codes we state exactly. */
const EVENT_LABELS = {
  single: 'Single',
  double: 'Double',
  triple: 'Triple',
  home_run: 'Home Run',
  field_error: 'Field Error',
  fielders_choice: 'Fielders Choice',
  field_out: 'Field Out',
};
const HIT_EVENT_TYPES = new Set(['single', 'double', 'triple', 'home_run']);

/**
 * Event code for a classifier category, or null when the category does not
 * name one code (a "field_out" could be a groundout, flyout, …; a sacrifice
 * may be a fly or a bunt — stating either would be a guess).
 */
function eventTypeFor(category, hitType) {
  if (hitType) return hitType;
  if (category === 'error' || category === 'fc+error') return 'field_error';
  if (category === 'fc') return 'fielders_choice';
  if (category === 'out') return 'field_out';
  return null;
}

/** Mirrors scoringCategory() in assets/js/reviews-feed.js (pinned by test). */
function categoryFor(eventType, isOut) {
  if (HIT_EVENT_TYPES.has(eventType)) return 'hit';
  if (eventType === 'field_error') return 'error';
  if (isOut === true) return 'out';
  return 'other';
}

/**
 * One side of the change: the event the official log states, in its own words.
 * `preferredEventType` is an event code the pipeline already verified against
 * StatsAPI (the play's current ruling) — it wins over the code derived from the
 * category, and everything else (category, isOut, label) follows from it.
 */
function sideFor(category, hitType, eventText, extraError, preferredEventType = null) {
  const eventType = preferredEventType || eventTypeFor(category, hitType);
  const errorMovements = extraError || /\+error$/.test(String(category || '')) ? 1 : 0;
  const isOut = category === 'out' ? true : (eventType && eventType !== 'field_out' ? false : null);
  const label = eventText
    || (eventType ? `${EVENT_LABELS[eventType] || eventType}${errorMovements ? ' + Error' : ''}` : null);
  return {
    eventType,
    event: eventText || (eventType ? (EVENT_LABELS[eventType] || eventType) : null),
    label: label ? `${label}${errorMovements && eventText ? ' + Error' : ''}` : (category || 'Unknown'),
    category: categoryFor(eventType, isOut),
    isOut,
    errorMovements,
  };
}

/** Human wording for the link flags worth showing on a feed row. */
const FLAG_TEXT = {
  current_ruling_mismatch: 'StatsAPI still shows a different ruling for this play — flagged for review',
  batter_not_found: 'the batter named in the log was not found on the linked play — flagged for review',
  no_game_found: 'no matching game was found for the date in the log — flagged for review',
  date_mismatch: 'the log’s date differs from the game’s official date — flagged for review',
  date_recovered: 'the game was found on another date in the same season (the log’s date looks wrong) — flagged for review',
  inning_mismatch: 'the inning in the log differs from the play’s inning — flagged for review',
  team_code_corrected: 'the team code in the log was normalized from an alias',
  unknown_team: 'a team code in the log was not recognized — flagged for review',
};
/** Flags that belong on the row for a human to see (aliases/boilerplate do not). */
const SHOWN_FLAG = /^(current_ruling_mismatch|batter_not_found|no_game_found|date_mismatch|date_recovered|inning_mismatch|unknown_team|ambiguous|chain)/;

/**
 * The official log's stat effects (pipeline/lib/stat-effects.mjs, stored on
 * the entry as `stats`) in the feed row's shape: { batting, pitching,
 * source: 'official_log' }. Each delta keeps the log clause it came from.
 * Null when the entry was not parsed (older data) — the feed then classifies
 * the row from its registry event types (scoringStatImpact).
 */
function statsForRow(entry) {
  const st = entry && entry.stats;
  if (!st || !Array.isArray(st.batting) || !Array.isArray(st.pitching)) return null;
  const pick = (d) => ({
    stat: d.stat,
    delta: typeof d.delta === 'number' ? d.delta : null,
    ...(typeof d.old === 'number' ? { from: d.old } : {}),
    ...(typeof d.now === 'number' ? { to: d.now } : {}),
    player: d.player || null,
    playerId: d.playerId ?? null,
    evidence: d.evidence || null,
  });
  return { batting: st.batting.map(pick), pitching: st.pitching.map(pick), source: 'official_log' };
}

/** "RBI −1 · ER −1 · UER +1" from the log's deltas (pitching H is implied by batting H). */
function statSummary(stats) {
  const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `\u2212${Math.abs(n)}` : '0');
  const one = (d) => (typeof d.delta === 'number' ? `${d.stat} ${signed(d.delta)}` : `${d.stat} changed`);
  const seen = new Set(stats.batting.map((d) => d.stat));
  return [...stats.batting.map(one), ...stats.pitching.filter((d) => !(d.stat === 'H' && seen.has('H'))).map(one)].join(' · ');
}

/** Entry kinds that restate a ruling — everything else can be a stat row. */
const STAT_ROW_KINDS = new Set(['earned_run', 'rbi', 'error_added', 'error_removed', 'baserunning',
  'wild_pitch_passed_ball', 'sacrifice_credit', 'fielding_credit', 'double_play_credit', 'unclassified']);

/**
 * Session 5: a verified official entry that changes batting R/H/RBI or
 * pitching stats WITHOUT a hit/error/out reclassification (e.g. 2026 #249,
 * "Vaughn loses an RBI and 1 run is changed to unearned against Andrew
 * Abbott") becomes its own row, id `stat-<atBatIndex>` — the id the live
 * feed mints for a stat-only change on the same play, so the two merge.
 * The ruling shown is the play's CURRENT StatsAPI ruling on both sides.
 */
export function buildOfficialStatRow(entry, { season, sourceUrl = null, now = Date.now() } = {}) {
  const cls = entry && entry.cls;
  const link = entry && entry.link;
  if (!cls || !STAT_ROW_KINDS.has(cls.kind) || !link) return null;
  if (link.gamePk == null || link.atBatIndex == null) return null;
  if ((link.flags || []).includes('current_ruling_mismatch')) return null;
  const stats = statsForRow(entry);
  if (!stats || (!stats.batting.length && !stats.pitching.length)) return null;
  const base = buildOfficialFeedRow({
    ...entry,
    cls: { ...cls, kind: 'ruling_change', initial: 'stat', final: 'stat', initialHitType: null, finalHitType: null, flags: [] },
  }, { season, sourceUrl, now, statRow: true });
  if (!base) return null;
  const side = sideFor(null, null, link.currentEvent || null, false, link.currentEventType || null);
  base.review.id = `stat-${link.atBatIndex}`;
  base.review.initial = { ...side };
  base.review.final = { ...side };
  base.review.reason = `${side.label}: ${statSummary(stats)}`;
  base.review.outcomeLabel = 'Stat change';
  base.review.stats = stats;
  return base;
}

/**
 * Build one feed-log row for one official entry, or null when the entry is not
 * a verified ruling change (the caller counts and reports those).
 *
 * @param {object} entry    one entry of data/official/scoring-changes-<s>.json
 * @param {object} opts     { season, sourceUrl, now }
 */
export function buildOfficialFeedRow(entry, { season, sourceUrl = null, now = Date.now(), statRow = false } = {}) {
  const cls = entry && entry.cls;
  const link = entry && entry.link;
  if (!cls || cls.kind !== 'ruling_change' || !link) return null;
  if (link.gamePk == null || link.atBatIndex == null) return null;
  if ((link.flags || []).includes('current_ruling_mismatch')) return null;
  if (!cls.initial || !cls.final) return null;
  const gameDate = link.officialDate || entry.date || null;

  const initial = sideFor(cls.initial, cls.initialHitType, null, /\+error$/.test(cls.initial));
  // The final side is the play's CURRENT StatsAPI ruling — the same fact the
  // linker verified the entry against, with StatsAPI's own wording.
  const final = sideFor(cls.final, cls.finalHitType, link.currentEvent || null, /\+error$/.test(cls.final),
    link.currentEventType || null);

  const flags = [];
  // StatsAPI codes some "batter reaches on a fielding error" plays in the
  // fielder's-choice family when other fielding events share the play (verified
  // convention — pipeline/lib/link.mjs rulingAgreement). The official log's own
  // ruling is still an error, and the scoring.html Hit → Error section (which
  // reads the classifier) lists the entry; the feed's own hit → error rule
  // reads observed event types only, so the row says what the log ruled and
  // what StatsAPI coded instead of hiding either.
  if (!statRow && cls.flags.includes('hitToError') && final.eventType !== 'field_error') {
    flags.push(`MLB’s official log rules this a fielding error; StatsAPI codes the play as `
      + `${link.currentEvent || final.eventType || 'another event'} (compatible coding) — the log’s ruling puts it in the Hit → Error section`);
  }
  (entry.issues || []).forEach((issue) => flags.push(`${issue} — flagged for review`));
  (link.flags || []).forEach((raw) => {
    if (!SHOWN_FLAG.test(raw)) return;
    const key = raw.split(':')[0];
    const text = FLAG_TEXT[key] || `${key.replace(/_/g, ' ')} — flagged for review`;
    if (!flags.includes(text)) flags.push(text);
  });

  // The play's own inning/half wins over the log's printed one: this row is
  // about the linked play (the log's text stays quoted in `official.raw`, and a
  // differing inning is flagged). Before the session-4 interval fix the log's
  // text was used verbatim, which could label a 9th-inning play "Bot 8th".
  const statedHalf = entry.half === 'top' || entry.half === 'bottom' ? entry.half : null;
  const statedInning = typeof entry.inning === 'number' ? entry.inning : null;
  const halfInning = link.half || statedHalf;
  const inning = link.inning != null ? link.inning : statedInning;
  if (link.inning != null && statedInning != null && link.inning !== statedInning) {
    flags.push(`MLB’s log prints the ${statedInning}th inning; the play is in the ${inning}th — the play’s inning is shown`);
  }
  const sideName = halfInning === 'top' ? link.away : halfInning === 'bottom' ? link.home : null;
  const ordinal = (n) => {
    if (!Number.isFinite(n)) return '';
    const n10 = n % 100;
    const suffix = n10 >= 11 && n10 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] || 'th');
    return `${n}${suffix}`;
  };
  const review = {
    id: `scoring-${link.atBatIndex}`,
    atBatIndex: link.atBatIndex,
    inning,
    halfInning,
    inningLabel: inning != null && halfInning
      ? `${halfInning === 'top' ? '▲ Top' : '▼ Bot'} ${ordinal(inning)}`
      : '',
    reviewType: 'Scoring Change',
    typeKey: 'scoring_change',
    battingSide: halfInning === 'top' ? 'away' : halfInning === 'bottom' ? 'home' : null,
    battingTeamId: null,
    battingTeamName: null,
    battingTeamAbbrev: sideName || null,
    inProgress: false,
    isOverturned: null,
    outcome: 'changed',
    outcomeLabel: 'Rescored',
    reason: `${initial.label} → ${final.label}`,
    description: link.currentDescription || null,
    initialDescription: null,          // nobody observed this call — never fabricate one
    initial,
    final,
    changeCount: 1,
    changes: [],
    previousHeadline: null,
    mechanism: {
      key: 'official_log',
      label: 'Confirmed in MLB’s official scoring-changes log (pipeline)',
    },
    flags,
    initialScoreAfter: null,
    scoreAfter: null,
    timestamp: new Date(now).toISOString(),
    initialObservedAt: null,
    isPitch: false,
    pitchVelo: null,
    batter: link.batterName ? { id: link.batterId != null ? link.batterId : null, fullName: link.batterName } : null,
    // The linked play's pitcher (StatsAPI matchup.pitcher, set by the
    // pipeline on link.pitcherName) — a fact of the play, never inferred.
    pitcher: link.pitcherName ? { id: link.pitcherId != null ? link.pitcherId : null, fullName: link.pitcherName } : null,
    countBefore: null,
    countAfter: null,
    atBatCount: null,
    challenger: null,
    scoreImpact: null,
    // Session 5: the official log's stat effects (null for older data), and
    // the play's video evidence (Savant sporty-videos?playId=…).
    ...(statsForRow(entry) && !statRow ? { stats: statsForRow(entry) } : {}),
    ...(link.playId ? { video: `https://baseballsavant.mlb.com/sporty-videos?playId=${encodeURIComponent(link.playId)}` } : {}),
    // Provenance (additive): the official line this row was built from.
    official: {
      season,
      seq: entry.seq,
      date: entry.date || null,
      raw: entry.raw || null,
      url: sourceUrl,
    },
  };
  return {
    gamePk: link.gamePk,
    review,
    firstSeen: now,
    lastSeen: now,
    matchupLabel: link.away && link.home ? `${link.away} @ ${link.home}` : null,
    gameDate,
  };
}

/**
 * Rows for a whole season file. Returns { rows, skipped }, where `skipped`
 * counts the entries that were deliberately left out with a reason — the
 * caller prints them so a gap is visible in CI rather than silently missing.
 */
export function rowsFromOfficialSeason(data, { season, now = Date.now() } = {}) {
  const entries = (data && Array.isArray(data.entries)) ? data.entries : [];
  const sourceUrl = (data && data.source && data.source.url) || null;
  const rows = [];
  const skipped = {};
  const bump = (k) => { skipped[k] = (skipped[k] || 0) + 1; };
  for (const e of entries) {
    const row = buildOfficialFeedRow(e, { season, sourceUrl, now });
    if (row) { rows.push(row); continue; }
    const statRow = buildOfficialStatRow(e, { season, sourceUrl, now });
    if (statRow) { rows.push(statRow); continue; }
    if (!e || !e.cls) { bump('no classification'); continue; }
    if (e.cls.kind !== 'ruling_change') { bump(`${e.cls.kind} (not a ruling change)`); continue; }
    const flags = (e.link && e.link.flags) || [];
    if (flags.includes('current_ruling_mismatch')) { bump('StatsAPI ruling does not match the log yet'); continue; }
    if (!e.link || e.link.gamePk == null || e.link.atBatIndex == null) { bump('play not linked'); continue; }
    bump('missing initial/final ruling');
  }
  // Two official entries about the same play are ONE feed row (the feed keeps
  // one row per play with a change count), built from the latest entry.
  const byKey = new Map();
  for (const row of rows) {
    const key = `${row.gamePk}:${row.review.id}`;
    const prev = byKey.get(key);
    const seq = (row.review.official && row.review.official.seq) || 0;
    const prevSeq = prev && prev.review.official ? prev.review.official.seq : -1;
    // Two official entries on one play (e.g. an RBI entry and an earned-run
    // entry) each state part of the change: their stat deltas are unioned
    // (each keeps its own evidence clause), never one dropped for the other.
    const unionStats = (a, b) => (a && b
      ? { batting: [...a.batting, ...b.batting], pitching: [...a.pitching, ...b.pitching], source: 'official_log' }
      : a || b || null);
    if (!prev || seq >= prevSeq) {
      const changeCount = (prev ? prev.review.changeCount : 0) + 1;
      if (prev) {
        const u = unionStats(prev.review.stats, row.review.stats);
        if (u) row.review.stats = u;
        row.review.changeCount = changeCount;
        row.review.previousHeadline = prev.review.reason;
        row.review.flags = row.review.flags.concat(prev.review.flags)
          .filter((f, i, a) => a.indexOf(f) === i);
        row.review.flags.push(`Multiple official rulings on one play (${changeCount}) — flagged for review`);
        row.firstSeen = Math.min(prev.firstSeen, row.firstSeen);
      }
      byKey.set(key, row);
    } else {
      prev.review.changeCount += 1;
      prev.review.previousHeadline = row.review.reason;
      const u = unionStats(prev.review.stats, row.review.stats);
      if (u) prev.review.stats = u;
    }
  }
  return { rows: [...byKey.values()], skipped };
}

/* ------------------------------------------------------------------ merge */

function entryKey(entry) {
  const r = entry && entry.review;
  if (!r) return null;
  return `${entry.gamePk}:${r.id || r.atBatIndex || ''}`;
}

/** Fields an incoming row never claims when it cannot state them. */
const KEEP_EXISTING_WHEN_NULL = ['initial', 'final', 'description', 'initialDescription', 'official', 'previousHeadline',
  'batter', 'pitcher', 'stats', 'video'];
/** Fields a merge unions instead of replacing. */
const UNION_FIELDS = ['flags'];

/**
 * Merge rows into one date's feed-log payload with the SAME semantics as
 * server.mjs mergeFeedLogPayloads (and assets/js/feed-log.js mergePayloads):
 * dedupe by `${gamePk}:${review.id}`, keep the longer review.history, keep the
 * existing snapshot/irregularity/grace/settled data, never drop a field. The
 * existing entry (whatever a browser observed) wins every field the incoming
 * row cannot state — the live observer saw more than the log alone does —
 * while official-only facts (the log seq/raw, the clarified ruling pair) are
 * added to it.
 */
export function mergeRowsIntoFeedLog(existing, rows, dateStr, now = Date.now()) {
  const base = existing && typeof existing === 'object' && existing.v === 1 ? existing : null;
  const map = new Map();
  const order = [];
  const add = (entry) => {
    const key = entryKey(entry);
    if (!key) return;
    const prev = map.get(key);
    if (!prev) {
      // Normalise to the stored shape (the row builder also carries `gameDate`
      // for the caller's grouping — that is not part of a feed-log entry).
      map.set(key, {
        gamePk: entry.gamePk,
        review: entry.review,
        firstSeen: entry.firstSeen != null ? entry.firstSeen : now,
        lastSeen: entry.lastSeen != null ? entry.lastSeen : now,
        matchupLabel: entry.matchupLabel != null ? entry.matchupLabel : null,
      });
      order.push(key);
      return;
    }
    const mergedReview = { ...prev.review, ...entry.review };
    KEEP_EXISTING_WHEN_NULL.forEach((field) => {
      if (entry.review[field] == null && prev.review[field] != null) mergedReview[field] = prev.review[field];
    });
    UNION_FIELDS.forEach((field) => {
      mergedReview[field] = [...(prev.review[field] || []), ...(entry.review[field] || [])]
        .filter((f, i, a) => a.indexOf(f) === i);
    });
    mergedReview.changeCount = Math.max(prev.review.changeCount || 0, entry.review.changeCount || 0) || 1;
    const histories = [prev.review.history, entry.review.history].filter((h) => Array.isArray(h));
    const longest = histories.sort((a, b) => b.length - a.length)[0];
    if (longest) mergedReview.history = longest;
    // A row that already says exactly this must not get a new `lastSeen` or a
    // new `timestamp`: the sync runs every few hours and an unchanged file must
    // stay byte-identical (payloadEquals is what keeps the workflow from
    // committing noise). `timestamp` records when the row was first written,
    // so it is ignored when deciding whether anything actually changed.
    const stable = (r) => JSON.stringify({ ...r, timestamp: null });
    const changed = stable(mergedReview) !== stable(prev.review);
    if (!changed && prev.review.timestamp) mergedReview.timestamp = prev.review.timestamp;
    map.set(key, {
      gamePk: entry.gamePk != null ? entry.gamePk : prev.gamePk,
      review: mergedReview,
      firstSeen: Math.min(prev.firstSeen || entry.firstSeen || now, entry.firstSeen || prev.firstSeen || now),
      lastSeen: changed
        ? Math.max(prev.lastSeen || 0, entry.lastSeen || 0)
        : (prev.lastSeen || entry.lastSeen || now),
      // The existing label wins: a browser that observed the game writes full
      // club names ("Seattle Mariners @ Toronto Blue Jays"), and the official
      // row only carries abbreviations — never downgrade what was observed.
      matchupLabel: prev.matchupLabel || entry.matchupLabel || null,
    });
  };
  (base && Array.isArray(base.entries) ? base.entries : []).forEach(add);
  (rows || []).forEach(add);

  const all = order.map((k) => map.get(k)).filter(Boolean);
  // Same cap as the browser (serializeFeedLog: the most recent win, the rest is
  // counted in `trimmed`) so the file keeps its shape and its numbers stay
  // honest whichever writer touched it last.
  const trimmedEntries = Math.max(0, all.length - FEED_LOG_MAX_ENTRIES);
  const entries = all.slice(-FEED_LOG_MAX_ENTRIES);
  return {
    v: 1,
    date: dateStr,
    savedAt: now,
    entries,
    order: entries.map(entryKey),
    snapshots: (base && base.snapshots) || {},
    irregularities: (base && base.irregularities) || {},
    grace: (base && base.grace) || {},
    settled: (base && Array.isArray(base.settled)) ? base.settled : [],
    trimmed: {
      entries: trimmedEntries,
      snapshots: (base && base.trimmed && base.trimmed.snapshots) || 0,
    },
  };
}

export const FEED_LOG_MAX_ENTRIES = 500;

/** Does the payload already say exactly this? (skip pointless rewrites/commits) */
export function payloadEquals(a, b) {
  if (!a || !b) return false;
  const { savedAt: _a, ...ra } = a;
  const { savedAt: _b, ...rb } = b;
  return JSON.stringify(ra) === JSON.stringify(rb);
}

/** Index update: one entry per date, exactly like server.mjs writeLogToDisk. */
export function updateFeedLogIndex(index, dateStr, savedAt) {
  const next = index && typeof index === 'object' ? { ...index } : {};
  next[dateStr] = savedAt;
  return next;
}
