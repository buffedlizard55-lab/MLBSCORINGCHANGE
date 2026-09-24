/* ============================================================================
 * assets/js/scoring-page.js — scoring.html
 *
 * Renders the official-data pipeline's outputs (data/official/*.json,
 * data/model/*.json). Read-only: every number shown comes from those files,
 * which the GitHub Actions pipeline regenerates from official MLB sources
 * every 3 hours. DOM is built with textContent only (no innerHTML of data).
 * ==========================================================================*/
(function () {
  'use strict';

  const SM = window.MLBScoringModel || null;
  const OFFICIAL_PAGE = 'https://www.mlb.com/official-information/scoring-changes';
  const PAGE_SIZE = 100;
  // Seasons come from the published pipeline report (no yearly code edits).
  let SEASONS = [new Date().getFullYear()];
  const TABS = [
    ['watch', '🎯 Error Watch'],
    ['official', '📋 Official Changes'],
    // Session-3 charter: single → error changes get their own section. They
    // stay OUT of the live feed's primary alert system (All feed, ✏️ tab,
    // sounds); here they are a first-class, full-list section.
    ['hiterror', '📉 Hit → Error'],
    ['model', '📈 Model'],
    ['irregularities', '⚑ Irregularities'],
  ];

  const state = {
    tab: 'watch',
    model: null,
    watch: null,
    report: null,
    irregularities: null,
    official: {},
    errors: [],
    season: null,
    current: null,
    watchFilter: { q: '', status: 'all', kind: 'all', sort: 'newest', shown: PAGE_SIZE },
    officialFilter: { q: '', type: 'all', shown: PAGE_SIZE },
    hitErrorFilter: { q: '', shown: PAGE_SIZE },
  };

  /* ------------------------------------------------------------ helpers */
  function el(tag, cls, text, attrs) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    if (attrs) Object.entries(attrs).forEach(([k, v]) => { if (v != null) node.setAttribute(k, v); });
    return node;
  }
  function ext(text, href, cls) {
    return el('a', cls || 'sc-link', text, { href, target: '_blank', rel: 'noopener' });
  }
  function $(sel) { return document.querySelector(sel); }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }
  async function getJSON(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res.json();
  }
  const gamedayUrl = (pk) => `https://www.mlb.com/gameday/${pk}`;
  const savantUrl = (pk) => `https://baseballsavant.mlb.com/gamefeed?gamePk=${pk}`;
  const statsapiUrl = (pk) => `https://statsapi.mlb.com/api/v1/game/${pk}/playByPlay`;
  const scheduleUrl = (date) => `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}`;
  const pct = (x, d = 1) => (typeof x === 'number' ? `${(x * 100).toFixed(d)}%` : '—');
  const num = (x) => (typeof x === 'number' ? x.toLocaleString() : '—');
  function shortDate(iso) {
    if (!iso) return '—';
    const [, m, d] = iso.split('-').map(Number);
    return `${m}/${d}`;
  }
  function localDateTime(iso) {
    const t = new Date(iso);
    return Number.isNaN(t.getTime()) ? '—' : t.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  }
  function ago(iso) {
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms)) return '';
    const h = Math.floor(ms / 3600000);
    if (h < 1) return `${Math.max(1, Math.round(ms / 60000))} min ago`;
    if (h < 48) return `${h} h ago`;
    return `${Math.round(h / 24)} days ago`;
  }
  const CATEGORY = {
    hit: 'Hit', 'hit+error': 'Hit + error', error: 'Error', fc: "Fielder's choice",
    'fc+error': "Fielder's choice + error", sac: 'Sacrifice', 'sac+error': 'Sacrifice + error',
    out: 'Out', other_pa: 'Walk / HBP / interference', other: 'Other',
  };
  const KIND = {
    baserunning: 'Base running', wild_pitch_passed_ball: 'Wild pitch / passed ball',
    fielding_credit: 'Putouts / assists', rbi: 'RBI', earned_run: 'Earned / unearned runs',
    error_removed: 'Error removed', error_added: 'Error added', sacrifice_credit: 'Sacrifice credit',
    double_play_credit: 'Double-play credit', pitching_decision: 'Win / loss / save', unclassified: 'Other (needs review)',
  };
  function classificationLabel(cls) {
    if (!cls) return '—';
    if (cls.kind === 'ruling_change' && cls.transition) {
      const [a, b] = cls.transition.split('->');
      return `${CATEGORY[a] || a} → ${CATEGORY[b] || b}`;
    }
    return KIND[cls.kind] || cls.kind;
  }
  const FLAG_TEXT = {
    current_ruling_mismatch: 'The linked play\u2019s current StatsAPI ruling does not match the new ruling in the official log (StatsAPI not updated, or a different play).',
    current_ruling_compatible: 'StatsAPI codes this ruling differently but compatibly (e.g. a sacrifice fielder\u2019s choice is coded sac_bunt).',
    superseded_by: 'A later official entry changed this same play again; the later entry is the final ruling.',
    runner_error_change: 'The change concerns an error on a RUNNER (checked: the play carries a runner error in StatsAPI); the batter\u2019s own ruling is unchanged, so it is not a mismatch.',
    batter_not_found: 'No batter named in the entry batted in that half-inning of the game.',
    no_game_found: 'No game with these teams on (or near) this date exists in the official schedule.',
    unknown_team: 'A team code in the entry is not a valid MLB code.',
    team_code_corrected: 'A mistyped team code was matched to the only game that team played that day (verify).',
    team_alias: 'An alternate team code (e.g. CHW for CWS) was used.',
    team_code_via: 'Team matched through an official StatsAPI team code other than the abbreviation.',
    date_mismatch: 'The game was found within 3 days of the stated date, not on it.',
    date_mismatch_wide: 'The game was found within 10 days of the stated date, not on it.',
    date_inferred: 'The entry has no date; the game was inferred from the teams and the batter.',
    teams_swapped: 'Home and away appear to be swapped in the entry.',
    name_match: 'The player name matched only by last name or by a close spelling (typo in the log).',
    inning_mismatch: 'The batter was found in the game but not in the stated half-inning.',
    inning_missing_matched_game: 'The entry has no inning; the play was matched within the whole game.',
    ambiguous_plate_appearance: 'More than one plate appearance fits the entry equally well.',
    subject_not_first_mention: 'The matched batter is not the first player named in the entry.',
    chain_inconsistent: 'Consecutive entries for the same play do not connect (old ruling ≠ previous new ruling).',
    missing_inning: 'The entry states no inning.',
    missing_date: 'The entry states no date.',
    unparsed_head: 'The date/teams part of the entry could not be read.',
    team_separator: 'Teams are written with a separator other than "@".',
    unexpected_suffix: 'Unexpected characters after the team codes.',
  };
  function flagText(flag) {
    const key = String(flag).split(':')[0];
    return FLAG_TEXT[key] || flag;
  }

  function scoreChip(p, bands, label) {
    const score = typeof p === 'number' ? Math.max(0, Math.min(100, Math.round(p * 100))) : null;
    const text = score == null ? '—' : score === 0 && p > 0 ? '<1' : String(score);
    const band = SM && score != null ? SM.band(bands ? { bands } : null, score) : null;
    const chip = el('span', `model-score model-tone-${band ? band.tone : 'none'}`, `${text}/100`);
    chip.title = `${label || 'Model probability'}: ${typeof p === 'number' ? pct(p) : 'n/a'}${band ? ` — ${band.label}` : ''}`;
    return { chip, band };
  }

  /* -------------------------------------------------------------- boot */
  function readHash() {
    const h = (window.location.hash || '').replace(/^#/, '');
    const [tab, season] = h.split('/');
    if (TABS.some(([k]) => k === tab)) state.tab = tab;
    if (season && /^20\d\d$/.test(season)) state.season = Number(season);
  }
  function writeHash() {
    const h = (state.tab === 'official' || state.tab === 'hiterror')
      ? `#${state.tab}/${state.season}` : `#${state.tab}`;
    if (window.location.hash !== h) window.history.replaceState(null, '', h);
  }

  async function init() {
    readHash();
    renderTabs();
    const [model, watch, report, irr] = await Promise.allSettled([
      getJSON('data/model/scoring-model.json'),
      getJSON('data/model/error-watch.json'),
      getJSON('data/model/pipeline-report.json'),
      getJSON('data/official/irregularities.json'),
    ]);
    state.model = model.status === 'fulfilled' ? model.value : null;
    state.watch = watch.status === 'fulfilled' ? watch.value : null;
    state.report = report.status === 'fulfilled' ? report.value : null;
    state.irregularities = irr.status === 'fulfilled' ? irr.value : null;
    const reported = state.report && state.report.seasons ? Object.keys(state.report.seasons).map(Number) : [];
    if (reported.length) SEASONS = reported.sort((a, b) => b - a);
    state.current = (state.watch && state.watch.season) || (state.report && state.report.currentSeason) || SEASONS[0];
    if (!state.season || !SEASONS.includes(state.season)) state.season = state.current;
    [model, watch, report, irr].forEach((r) => { if (r.status === 'rejected') state.errors.push(String(r.reason && r.reason.message || r.reason)); });
    renderUpdated();
    renderSummary();
    await renderPanel();
  }

  async function loadSeason(season) {
    if (state.official[season]) return state.official[season];
    try {
      state.official[season] = await getJSON(`data/official/scoring-changes-${season}.json`);
    } catch (err) {
      state.official[season] = { error: String(err.message || err), entries: [] };
    }
    return state.official[season];
  }

  /* ----------------------------------------------------------- header */
  function renderUpdated() {
    const box = $('#sc-updated');
    clear(box);
    const gen = (state.model && state.model.generatedAt) || (state.report && state.report.generatedAt);
    if (!gen) {
      box.textContent = 'Official data is not available yet — the pipeline has not published it.';
      return;
    }
    box.appendChild(el('span', null, `Updated ${localDateTime(gen)} (${ago(gen)}) · refreshes every 3 hours · `));
    box.appendChild(ext('MLB official scoring changes', OFFICIAL_PAGE));
    const warnings = (state.report && state.report.warnings) || [];
    if (state.report && state.report.fatal) {
      warnings.unshift(`Last refresh failed${state.report.failedAt ? ` (${localDateTime(state.report.failedAt)})` : ''}: ${state.report.fatal} — showing the last good data`);
    }
    if (warnings.length || state.errors.length) {
      const w = el('div', 'sc-warning', `⚠ ${[...warnings, ...state.errors].join(' · ')}`);
      box.appendChild(w);
    }
  }

  function card(label, value, sub, cls) {
    const c = el('div', `review-stat-item sc-card ${cls || ''}`);
    c.appendChild(el('div', 'review-stat-label', label));
    c.appendChild(el('div', 'review-stat-value', value));
    if (sub) c.appendChild(el('div', 'sc-card-sub', sub));
    return c;
  }

  function renderSummary() {
    const wrap = clear($('#sc-summary'));
    const r = state.report;
    const cur = r && r.seasons && r.seasons[state.current];
    const plays = (state.watch && state.watch.plays) || [];
    const changed = plays.filter((p) => p.status === 'changed_to_hit').length;
    const e = state.model && state.model.errorToHit;
    wrap.appendChild(card(`Official changes ${state.current}`, cur ? num(cur.officialEntries) : '—',
      cur ? `${cur.errorToHitEntries} error → hit · ${cur.hitToErrorEntries} hit → error` : null));
    wrap.appendChild(card(`Errors ${state.current}`, num(plays.length),
      plays.length ? `${changed} changed to a hit (${pct(changed / plays.length)})` : null));
    wrap.appendChild(card('Error → hit model', e ? `AUC ${e.cv.auc.toFixed(2)}` : '—',
      e ? `out-of-time ${e.outOfTime ? e.outOfTime.auc.toFixed(2) : '—'} · base rate ${pct(e.baseRate)}` : null));
    const sv = r && r.savant;
    const svSub = [];
    if (sv && sv.matched != null) svSub.push('errors matched on Baseball Savant');
    if (sv && sv.perPlay) svSub.push(`${num(sv.perPlay.matched)} / ${num(sv.perPlay.needed)} plays have Savant xBA`);
    wrap.appendChild(card('Cross-check', sv && sv.matched != null ? `${num(sv.matched)} / ${num(sv.rows)}` : '—',
      svSub.length ? svSub.join(' · ') : null));
    const cap = state.model && state.model.capture;
    if (cap) {
      wrap.appendChild(card('Live capture', num(cap.plays),
        cap.plays ? `rulings recorded as first called · last ${ago(cap.lastCaptureAt)}` : 'starts with the next live game'));
    }
  }

  function renderTabs() {
    const wrap = clear($('#sc-tabs'));
    TABS.forEach(([key, label]) => {
      const b = el('button', `tab ${state.tab === key ? 'tab-on' : ''}`, label, { type: 'button' });
      b.addEventListener('click', () => { state.tab = key; writeHash(); renderTabs(); renderPanel(); });
      wrap.appendChild(b);
    });
  }

  async function renderPanel() {
    const wrap = clear($('#sc-panel'));
    writeHash();
    if (state.tab === 'watch') return renderWatch(wrap);
    if (state.tab === 'official') return renderOfficial(wrap);
    if (state.tab === 'hiterror') return renderHitError(wrap);
    if (state.tab === 'model') return renderModel(wrap);
    return renderIrregularities(wrap);
  }

  /* ------------------------------------------------------ error watch */
  function controls(items) {
    const bar = el('div', 'sc-controls');
    items.forEach((i) => bar.appendChild(i));
    return bar;
  }
  function select(options, value, onChange, label) {
    const s = el('select', 'sc-select', null, { 'aria-label': label });
    options.forEach(([v, t]) => {
      const o = el('option', null, t, { value: v });
      if (v === value) o.selected = true;
      s.appendChild(o);
    });
    s.addEventListener('change', () => onChange(s.value));
    return s;
  }
  function search(value, placeholder, onInput) {
    const i = el('input', 'sc-search', null, { type: 'search', placeholder, 'aria-label': placeholder });
    i.value = value;
    let t = null;
    i.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => onInput(i.value), 150); });
    return i;
  }
  /**
   * Baseball Savant's own expected batting average for this exact ball
   * (`estimated_ba_using_speedangle`, attached by the pipeline when it has
   * fetched it). Returns null when the pipeline has no value for the play —
   * the number is never estimated or inferred here.
   */
  function savantXbaText(s) {
    if (!s || typeof s.xba !== 'number') return null;
    const ev = typeof s.ls === 'number' ? ` · exit velocity ${s.ls.toFixed(1)} mph` : '';
    const la = typeof s.la === 'number' ? `, ${Math.round(s.la)}°` : '';
    return `Savant xBA ${s.xba.toFixed(3)} — expected batting average for this ball${ev}${la}`;
  }

  function battedBallText(p) {
    const parts = [];
    if (typeof p.ls === 'number') parts.push(`${p.ls.toFixed(1)} mph`);
    if (typeof p.la === 'number') parts.push(`${Math.round(p.la)}°`);
    if (p.traj) parts.push(String(p.traj).replace(/_/g, ' '));
    if (p.loc && SM) {
      const g = SM.locationGroup(p.loc);
      const names = { P: 'pitcher', C: 'catcher', '1B': 'first base', '2B': 'second base', '3B': 'third base', SS: 'shortstop', OF: 'outfield' };
      if (names[g]) parts.push(`to ${names[g]}`);
    }
    const hp = typeof p.hitProb === 'number' ? ` · comparable balls were hits ${Math.round(p.hitProb * 100)}% of the time` : '';
    return parts.length ? `${parts.join(' · ')}${hp}` : 'No Statcast batted-ball data';
  }

  function renderWatch(wrap) {
    const f = state.watchFilter;
    const all = (state.watch && state.watch.plays) || [];
    const bands = state.model && state.model.errorToHit && state.model.errorToHit.bands;
    const rerender = () => { f.shown = PAGE_SIZE; renderPanel(); };
    wrap.appendChild(el('p', 'sc-help',
      'Every play of the season first scored "reached on error" (as of the last refresh), with the model\u2019s chance it is changed to a hit and its final status. ' +
      'Scores for settled plays are out-of-fold (the play was not used to fit the model that scored it). Plays from the last 14 days may still change.'));
    wrap.appendChild(controls([
      search(f.q, 'Search player, team or play…', (v) => { f.q = v; rerender(); }),
      select([['all', 'All statuses'], ['stands', 'Stands as error'], ['changed_to_hit', 'Changed to a hit'], ['changed_other', 'Changed (other)']],
        f.status, (v) => { f.status = v; rerender(); }, 'Status'),
      select([['all', 'All error types'], ['fielding', 'Fielding errors'], ['throwing', 'Throwing errors'], ['missed_catch', 'Missed-catch errors'], ['unknown', 'Type unknown (changed plays)']],
        f.kind, (v) => { f.kind = v; rerender(); }, 'Error type'),
      select([['newest', 'Newest first'], ['score', 'Highest chance first']], f.sort, (v) => { f.sort = v; rerender(); }, 'Sort'),
    ]));
    if (!all.length) {
      wrap.appendChild(el('div', 'empty', state.watch ? 'No errors recorded yet this season.' : 'Error Watch data is not available yet.'));
      return;
    }
    const q = f.q.trim().toLowerCase();
    let rows = all.filter((p) => (f.status === 'all' || p.status === f.status) &&
      (f.kind === 'all' || (f.kind === 'unknown' ? !p.errKind : p.errKind === f.kind)) &&
      (!q || [p.batter, p.away, p.home, p.description, p.event].some((s) => String(s || '').toLowerCase().includes(q))));
    if (f.sort === 'score') rows = rows.slice().sort((a, b) => (b.p || 0) - (a.p || 0));
    wrap.appendChild(el('div', 'sc-count', `Showing ${Math.min(rows.length, f.shown).toLocaleString()} of ${rows.length.toLocaleString()} plays`));
    const list = el('div', 'sc-list');
    rows.slice(0, f.shown).forEach((p) => list.appendChild(watchRow(p, bands)));
    wrap.appendChild(list);
    if (rows.length > f.shown) {
      const more = el('button', 'btn sc-more', `Show ${Math.min(PAGE_SIZE, rows.length - f.shown)} more`, { type: 'button' });
      more.addEventListener('click', () => { f.shown += PAGE_SIZE; renderPanel(); });
      wrap.appendChild(more);
    }
  }

  function watchRow(p, bands) {
    const row = el('article', `sc-row sc-status-${p.status}`);
    const left = el('div', 'sc-row-score');
    const { chip, band } = scoreChip(p.p, bands, 'Chance this error is changed to a hit');
    left.appendChild(chip);
    if (band) left.appendChild(el('div', `sc-band model-tone-${band.tone}`, band.label));
    row.appendChild(left);
    const body = el('div', 'sc-row-body');
    const head = el('div', 'sc-row-head');
    head.appendChild(el('span', 'sc-date', shortDate(p.date)));
    head.appendChild(el('a', 'sc-matchup', `${p.away || '?'} @ ${p.home || '?'}`, { href: `game.html?gamePk=${p.gamePk}` }));
    head.appendChild(el('span', 'sc-inning', `${p.half === 'top' ? 'Top' : 'Bot'} ${p.inning}`));
    if (p.batter) head.appendChild(el('span', 'sc-player', p.batter));
    if (p.errKind) {
      const label = (SM && SM.ERROR_KIND_LABELS && SM.ERROR_KIND_LABELS[p.errKind]) || p.errKind;
      head.appendChild(el('span', 'sc-kind', label, {
        title: p.errKindSource === 'captured'
          ? 'Error type of the original call, recorded live before any change'
          : 'Error type of the current ruling (StatsAPI fielding credits)',
      }));
    }
    const statusText = p.status === 'changed_to_hit' ? `✏️ Changed to ${p.event || 'a hit'}`
      : p.status === 'changed_other' ? `✏️ Changed: ${p.event || p.final}` : 'Stands as error';
    head.appendChild(el('span', `review-outcome-pill ${p.status === 'stands' ? 'outcome-stands' : 'outcome-changed'}`, statusText));
    if (!p.labelFinal && p.status === 'stands') head.appendChild(el('span', 'sc-recent', 'recent — may still change'));
    body.appendChild(head);
    body.appendChild(el('div', 'sc-desc', p.description || ''));
    if (p.captured) {
      const c = p.captured;
      const parts = [`📡 Captured live ${localDateTime(c.firstAt)}${typeof c.lagMin === 'number' ? ` (${Math.max(0, Math.round(c.lagMin))} min after the play)` : ''}`];
      if (typeof c.scoreAtCapture === 'number') parts.push(`model said ${c.scoreAtCapture}/100 then`);
      (c.changes || []).forEach((ch) => parts.push(`→ ${ch.event || ch.eventType} at ${localDateTime(ch.at)} (seen live)`));
      body.appendChild(el('div', 'sc-captured', parts.join(' · ')));
      if (c.firstDescription && c.firstDescription !== p.description) {
        body.appendChild(el('div', 'sc-captured sc-captured-first', `First call: ${c.firstDescription}`));
      }
    }
    (p.official || []).forEach((o) => {
      body.appendChild(el('div', 'sc-official-text', `Official log #${o.seq}: ${o.raw.replace(/^\d+[.)]\s*/, '')}`));
    });
    body.appendChild(el('div', 'sc-bb', battedBallText(p)));
    const xba = savantXbaText(p.savant);
    if (xba) body.appendChild(el('div', 'sc-bb sc-savant-xba', xba));
    const links = el('div', 'sc-links');
    links.appendChild(ext('Gameday', gamedayUrl(p.gamePk)));
    links.appendChild(ext('Savant', savantUrl(p.gamePk)));
    links.appendChild(ext('StatsAPI', statsapiUrl(p.gamePk)));
    if ((p.official || []).length) links.appendChild(ext(`MLB log #${p.official.map((o) => o.seq).join(', #')}`, OFFICIAL_PAGE));
    body.appendChild(links);
    row.appendChild(body);
    return row;
  }

  /* --------------------------------------------------- official changes */
  /**
   * Entries worth a second look: pipeline parse issues, an unclassified
   * kind, or a ruling change whose linked-play check flagged something
   * (mismatch / no game / wrong inning / ambiguous / broken chain). Shared
   * by the Official Changes and Hit → Error sections.
   */
  function isFlagged(e) {
    const linkFlags = (e.link && e.link.flags) || [];
    return (e.issues || []).length || (e.cls && e.cls.kind === 'unclassified') ||
      (e.cls && e.cls.kind === 'ruling_change' && linkFlags.some((x) => /^(current_ruling_mismatch|batter_not_found|no_game_found|unknown_team|team_code_corrected|date_mismatch|inning_mismatch|ambiguous|chain)/.test(x)));
  }

  async function renderOfficial(wrap) {
    const f = state.officialFilter;
    const season = state.season;
    const rerender = () => { f.shown = PAGE_SIZE; renderPanel(); };
    const loading = el('div', 'empty', `Loading ${season} official scoring changes…`);
    wrap.appendChild(loading);
    const data = await loadSeason(season);
    if (state.tab !== 'official' || state.season !== season) return;
    wrap.removeChild(loading);
    const src = data.source || {};
    const help = el('p', 'sc-help');
    help.appendChild(el('span', null, `MLB\u2019s official list for ${season}, verbatim, with each entry classified, linked to its play and checked against the play\u2019s current StatsAPI ruling. Source: `));
    help.appendChild(ext(src.archivedAt ? `Internet Archive capture (${src.archivedAt.slice(0, 10)}) of the MLB page` : 'mlb.com official scoring changes', src.url || OFFICIAL_PAGE));
    if (src.fetchedAt) help.appendChild(el('span', null, ` · captured ${localDateTime(src.fetchedAt)}`));
    wrap.appendChild(help);
    wrap.appendChild(controls([
      select(SEASONS.map((s) => [String(s), `${s} season`]), String(season), (v) => { state.season = Number(v); rerender(); }, 'Season'),
      select([['all', 'All entries'], ['errorToHit', 'Error → hit'], ['hitToError', 'Hit → error'], ['ruling', 'Other ruling changes'], ['bookkeeping', 'Runs / credits / other'], ['flagged', 'Flagged for review']],
        f.type, (v) => { f.type = v; rerender(); }, 'Type'),
      search(f.q, 'Search player, team or text…', (v) => { f.q = v; rerender(); }),
    ]));
    if (data.error) {
      wrap.appendChild(el('div', 'empty', `This season\u2019s list is not available (${data.error}).`));
      return;
    }
    const q = f.q.trim().toLowerCase();
    const rows = (data.entries || []).filter((e) => {
      const flags = (e.cls && e.cls.flags) || [];
      if (f.type === 'errorToHit' && !flags.includes('errorToHit')) return false;
      if (f.type === 'hitToError' && !flags.includes('hitToError')) return false;
      if (f.type === 'ruling' && !(e.cls.kind === 'ruling_change' && !flags.includes('errorToHit') && !flags.includes('hitToError'))) return false;
      if (f.type === 'bookkeeping' && e.cls.kind === 'ruling_change') return false;
      if (f.type === 'flagged' && !isFlagged(e)) return false;
      return !q || String(e.raw).toLowerCase().includes(q);
    }).slice().reverse();
    wrap.appendChild(el('div', 'sc-count', `Showing ${Math.min(rows.length, f.shown)} of ${rows.length} entries (newest first)`));
    const list = el('div', 'sc-list');
    rows.slice(0, f.shown).forEach((e) => list.appendChild(officialRow(e, src, isFlagged(e))));
    wrap.appendChild(list);
    if (rows.length > f.shown) {
      const more = el('button', 'btn sc-more', `Show ${Math.min(PAGE_SIZE, rows.length - f.shown)} more`, { type: 'button' });
      more.addEventListener('click', () => { f.shown += PAGE_SIZE; renderPanel(); });
      wrap.appendChild(more);
    }
  }

  function officialRow(e, src, flagged) {
    const row = el('article', `sc-row sc-official ${flagged ? 'sc-flagged' : ''}`);
    const left = el('div', 'sc-row-score');
    if (e.model && typeof e.model.p === 'number') {
      const q = e.model.question === 'errorToHit' ? 'errorToHit' : 'hitToError';
      const bands = state.model && state.model[q] && state.model[q].bands;
      const { chip, band } = scoreChip(e.model.p, bands,
        q === 'errorToHit' ? 'Pre-change chance this error would become a hit' : 'Pre-change chance this hit would become an error');
      left.appendChild(chip);
      left.appendChild(el('div', 'sc-band', e.model.kind === 'out_of_fold' ? 'pre-change · out-of-fold' : 'pre-change'));
      if (band) left.lastChild.title = band.label;
    } else {
      left.appendChild(el('span', 'sc-seq', `#${e.seq}`));
    }
    row.appendChild(left);
    const body = el('div', 'sc-row-body');
    const head = el('div', 'sc-row-head');
    if (e.model) head.appendChild(el('span', 'sc-seq-inline', `#${e.seq}`));
    head.appendChild(el('span', 'sc-date', e.date ? shortDate(e.date) : '—'));
    const matchup = e.link && e.link.away && e.link.home ? `${e.link.away} @ ${e.link.home}` : `${e.away || '?'} @ ${e.home || '?'}`;
    if (e.link && e.link.gamePk) head.appendChild(el('a', 'sc-matchup', matchup, { href: `game.html?gamePk=${e.link.gamePk}` }));
    else head.appendChild(el('span', 'sc-matchup', matchup));
    if (e.section && !/regular season/i.test(e.section)) head.appendChild(el('span', 'sc-section', e.section));
    head.appendChild(el('span', `sc-class sc-class-${e.cls ? e.cls.kind : 'x'}`, classificationLabel(e.cls)));
    body.appendChild(head);
    body.appendChild(el('div', 'sc-desc', e.raw.replace(/^\d+[.)]\s*/, '')));
    const xba = savantXbaText(e.savant);
    if (xba) body.appendChild(el('div', 'sc-bb sc-savant-xba', xba));
    const v = el('div', 'sc-verify');
    const L = e.link || {};
    if (L.atBatIndex != null) {
      const agree = !(L.flags || []).includes('current_ruling_mismatch');
      v.appendChild(el('span', agree ? 'sc-ok' : 'sc-warn',
        `${agree ? '✓' : '⚑'} Play found: ${L.batterName || 'batter'}${L.currentEvent ? ` — StatsAPI now: ${L.currentEvent}` : ''}`));
    } else if (L.gamePk) {
      v.appendChild(el('span', 'sc-warn', '⚑ Game found; play not identified'));
    } else {
      v.appendChild(el('span', 'sc-warn', '⚑ Game not found'));
    }
    const shownFlags = (L.flags || []).filter((x) => !/^(team_code_via|team_alias)/.test(x));
    const issues = [...(e.issues || []), ...shownFlags];
    if (issues.length) {
      const fl = el('span', 'sc-flags', issues.map((x) => x.split(':')[0].replace(/_/g, ' ')).join(' · '));
      fl.title = issues.map(flagText).join('\n');
      v.appendChild(fl);
    }
    body.appendChild(v);
    const links = el('div', 'sc-links');
    links.appendChild(ext('MLB log', src.url || OFFICIAL_PAGE));
    if (L.gamePk) {
      links.appendChild(ext('Gameday', gamedayUrl(L.gamePk)));
      links.appendChild(ext('StatsAPI', statsapiUrl(L.gamePk)));
    } else if (e.date) {
      links.appendChild(ext('Schedule that day', scheduleUrl(e.date)));
    }
    body.appendChild(links);
    row.appendChild(body);
    return row;
  }

  /* ------------------------------------------- hit → error (own section)
   * Session-3 charter: "track anytime a final scoring decision would change
   * a single to an error … create a section for anything that changes a
   * single to an error and keep it from populating the main primary alert
   * system". These are the SAME entries the Official Changes list carries
   * with the hitToError flag (pipeline/lib/log-classifier.mjs — a ruling
   * change from a hit category to an error category), presented here as a
   * first-class section so the reverse direction never has to flood the
   * primary error → hit alert surfaces. Only confirmed, officially logged
   * changes are listed — no every-single tracking, so no bloat. */
  async function renderHitError(wrap) {
    const f = state.hitErrorFilter;
    const season = state.season;
    const rerender = () => { f.shown = PAGE_SIZE; renderPanel(); };
    const loading = el('div', 'empty', `Loading ${season} hit → error changes…`);
    wrap.appendChild(loading);
    const data = await loadSeason(season);
    if (state.tab !== 'hiterror' || state.season !== season) return;
    wrap.removeChild(loading);
    const src = data.source || {};
    const help = el('p', 'sc-help');
    help.appendChild(el('span', null,
      `Every play in ${season} first ruled a hit — usually a single — whose final official ruling is an error. ` +
      'Each row keeps the pre-change chance the hit would become an error (out of 100, out-of-fold) and the final result, ' +
      'linked to the exact play and checked against its current StatsAPI ruling. Where Baseball Savant has published ' +
      'the play, its own expected batting average (xBA) for that exact ball is shown beside the model number. ' +
      'By design these never appear in the live feed\u2019s All feed, ✏️ Scoring Changes tab or alert sounds — ' +
      'they live in the feed\u2019s own 📉 Hit → Error tab and in this section, so the primary alert system stays ' +
      'focused on error → hit and scoring-pending movement. Source: '));
    help.appendChild(ext(src.archivedAt ? `Internet Archive capture (${src.archivedAt.slice(0, 10)}) of the MLB page` : 'mlb.com official scoring changes', src.url || OFFICIAL_PAGE));
    if (src.fetchedAt) help.appendChild(el('span', null, ` · captured ${localDateTime(src.fetchedAt)}`));
    wrap.appendChild(help);
    wrap.appendChild(controls([
      select(SEASONS.map((s) => [String(s), `${s} season`]), String(season), (v) => { state.season = Number(v); rerender(); }, 'Season'),
      search(f.q, 'Search player, team or text…', (v) => { f.q = v; rerender(); }),
    ]));
    if (data.error) {
      wrap.appendChild(el('div', 'empty', `This season\u2019s list is not available (${data.error}).`));
      return;
    }
    const q = f.q.trim().toLowerCase();
    const rows = (data.entries || [])
      .filter((e) => e.cls && (e.cls.flags || []).includes('hitToError'))
      .filter((e) => !q || String(e.raw).toLowerCase().includes(q))
      .slice().reverse();
    wrap.appendChild(el('div', 'sc-count', `Showing ${Math.min(rows.length, f.shown)} of ${rows.length} entries (newest first)`));
    if (!rows.length) {
      wrap.appendChild(el('div', 'empty', `No hit → error changes on MLB\u2019s official ${season} list.`));
      return;
    }
    const list = el('div', 'sc-list');
    rows.slice(0, f.shown).forEach((e) => list.appendChild(officialRow(e, src, isFlagged(e))));
    wrap.appendChild(list);
    if (rows.length > f.shown) {
      const more = el('button', 'btn sc-more', `Show ${Math.min(PAGE_SIZE, rows.length - f.shown)} more`, { type: 'button' });
      more.addEventListener('click', () => { f.shown += PAGE_SIZE; renderPanel(); });
      wrap.appendChild(more);
    }
  }

  /* ----------------------------------------------------------- model */
  function table(headers, rows) {
    const t = el('table', 'sc-table');
    const thead = el('thead');
    const tr = el('tr');
    headers.forEach((h) => tr.appendChild(el('th', null, h)));
    thead.appendChild(tr);
    t.appendChild(thead);
    const tb = el('tbody');
    rows.forEach((r) => {
      const row = el('tr');
      r.forEach((c) => {
        if (c && typeof c === 'object') { const td = el('td'); td.appendChild(c); row.appendChild(td); return; }
        row.appendChild(el('td', null, c == null ? '—' : String(c)));
      });
      tb.appendChild(row);
    });
    t.appendChild(tb);
    return t;
  }
  function section(title, intro) {
    const s = el('section', 'sc-section-box');
    s.appendChild(el('h2', 'sc-h2', title));
    if (intro) s.appendChild(el('p', 'sc-help', intro));
    return s;
  }

  function renderModel(wrap) {
    const m = state.model;
    if (!m) { wrap.appendChild(el('div', 'empty', 'The model has not been published yet.')); return; }
    const e = m.errorToHit; const h = m.hitToError;
    const s0 = section('What the scores mean',
      'Each score is a probability expressed out of 100, learned from official MLB scoring changes. ' +
      '"Error → hit" is the chance a play scored as reached-on-error is later changed to a hit; ' +
      '"Hit → error" the reverse. For "Official Scorer Ruling Pending" plays, the live feed shows the ' +
      'chance of each final ruling (hit / error / fielder\u2019s choice / out), from how comparable batted balls were scored.');
    s0.appendChild(table(['Score band (error → hit)', 'Range'], (e.bands || []).map((b, i, a) => [b.label, i === 0 ? `${b.min}–100` : `${b.min}–${a[i - 1].min - 1}`])));
    wrap.appendChild(s0);

    const s1 = section('Accuracy (honest, out-of-sample)',
      'Cross-validation holds out whole games; the out-of-time test fits on earlier seasons and predicts the latest one. ' +
      'Log loss and Brier score are compared with always predicting the base rate (lower is better).');
    const acc = (x) => [
      num(x.n), num(x.positives), pct(x.baseRate, 2), x.cv.auc.toFixed(3),
      `${x.cv.logLoss} vs ${x.cv.baseLogLoss}`, `${x.cv.brier} vs ${x.cv.baseBrier}`,
      x.outOfTime ? `${x.outOfTime.auc.toFixed(3)} (n=${num(x.outOfTime.n)})` : '—',
    ];
    s1.appendChild(table(['Question', 'Plays', 'Changed', 'Base rate', 'CV AUC', 'CV log loss vs base', 'CV Brier vs base', 'Out-of-time AUC'],
      [['Error → hit', ...acc(e)], ['Hit → error', ...acc(h)]]));
    s1.appendChild(el('p', 'sc-help', 'Calibration (error → hit, cross-validated): predicted vs observed rate by score band.'));
    s1.appendChild(table(['Predicted band', 'Plays', 'Predicted', 'Observed'],
      e.cv.calibration.filter((c) => c.n).map((c) => [`${c.band}%`, num(c.n), pct(c.predicted), pct(c.observed)])));
    wrap.appendChild(s1);

    const s2 = section('What actually drives changes (training data)',
      'Raw rates from the official log — how often plays first scored as errors became hits, by how hittable the ball was ' +
      '(share of comparable batted balls that fell for hits, an xBA-style measure), by fielder and by trajectory.');
    const rateRows = (rows) => rows.map((r) => [r.key, num(r.n), num(r.positives), pct(r.rate)]);
    s2.appendChild(table(['Comparable-ball hit rate', 'Errors', 'Changed to hit', 'Rate'], rateRows(e.rates.byHitProbability)));
    s2.appendChild(table(['Fielder', 'Errors', 'Changed to hit', 'Rate'], rateRows(e.rates.byFielder.filter((r) => r.n >= 10))));
    s2.appendChild(table(['Trajectory', 'Errors', 'Changed to hit', 'Rate'], rateRows(e.rates.byTrajectory.filter((r) => r.n >= 10))));
    wrap.appendChild(s2);

    renderCaptureSection(wrap, m);
    renderErrorTypeSection(wrap, m);
    renderPendingSection(wrap, m);
    renderEffectsSection(wrap, m);

    const s3 = section('How it works',
      `Hit probability comes from ${num(m.hitProb.surface.nBalls)} batted balls (exit velocity × launch angle cells, smoothed); ` +
      `it correlates ${state.report && state.report.savant && state.report.savant.hitProbVsSavantXba ? state.report.savant.hitProbVsSavantXba.pearson : '—'} ` +
      'with Baseball Savant\u2019s expected batting average on the same plays. Where Savant has published a play the site can show, ' +
      'the pipeline attaches Savant\u2019s own xBA for that exact ball (`estimated_ba_using_speedangle`) and the rows show both numbers ' +
      'side by side — the model number is the comparable-balls rate, Savant\u2019s is the expected batting average for that one ball. ' +
      'Each question is a regularised logistic regression; ' +
      'the terms were chosen by cross-validation (simplest model within one standard error of the best).');
    const coefRows = (x) => [['intercept', x.intercept], ...x.terms.map((t, i) => [t, x.coef[i]])];
    s3.appendChild(table(['Error → hit term', 'Coefficient'], coefRows(e)));
    s3.appendChild(table(['Hit → error term', 'Coefficient'], coefRows(h)));
    wrap.appendChild(s3);

    const s4 = section('Limitations');
    const ul = el('ul', 'sc-ul');
    [
      'Discrimination for error → hit is modest (AUC ≈ 0.6): most errors, even on hard-hit balls, are never changed. Treat scores as a watch-list ranking, not a verdict.',
      'Labels come from MLB\u2019s official log. Changes made during a game may not appear in it; the live capture sees them directly (see Live capture).',
      'The original error type (fielding / throwing / missed catch) of past plays changed to a hit is not in MLB\u2019s data any more, and StatsAPI\u2019s snapshots are rewritten after a change. The live capture records it from September 2026 on; it enters the scores only once enough captured errors have settled and cross-validation shows it helps.',
      '"Official Scorer Ruling Pending" markers are not kept in final play-by-play (0 of ~550,000 plate appearances in 2024–2026), so pending-ruling chances start from comparable batted balls; captured pending rulings recalibrate them once enough are resolved.',
      'The live capture polls every 2 minutes for about 6 of every 10 minutes during game hours, and GitHub can delay scheduled runs: very short-lived pending markers can be missed, so captured pending rulings lean toward longer decisions.',
      'StatsAPI does not always reflect a logged change (flagged under Irregularities); such plays are kept out of the training labels.',
      'Hit probability uses exit velocity and launch angle only (no sprint speed or fielder positioning), so it approximates rather than reproduces Savant\u2019s xBA.',
      'Savant\u2019s per-play xBA is attached only where the pipeline has fetched it (a few requests per run, cached): plays are added over the runs after a change, and a play Savant does not publish simply shows no xBA rather than a substitute.',
    ].forEach((t) => ul.appendChild(el('li', null, t)));
    s4.appendChild(ul);
    wrap.appendChild(s4);

    const s5 = section('Sources');
    const ul2 = el('ul', 'sc-ul');
    (m.sources || []).forEach((src) => {
      const li = el('li');
      if (String(src.url).includes('{')) {
        li.appendChild(el('span', null, `${src.name}: `));
        li.appendChild(el('code', null, src.url));
      } else {
        li.appendChild(ext(src.name, src.url));
      }
      ul2.appendChild(li);
    });
    s5.appendChild(ul2);
    wrap.appendChild(s5);
  }

  /* ------------------------------------ live capture & model upgrades */
  const STATUS_TEXT = {
    collecting: 'Collecting data — not used in scores yet',
    not_selected: 'Tested — no out-of-sample improvement, not used',
    not_better: 'Tested — no leave-one-out improvement, not used',
    active: 'Active — used in scores',
  };
  function statusPill(status) {
    return el('span', `sc-status-pill sc-status-${status || 'collecting'}`, STATUS_TEXT[status] || status || '—');
  }
  function gameLink(pk, text) {
    return el('a', null, text || `Game ${pk}`, { href: `game.html?gamePk=${pk}` });
  }
  /** "Game page · Gameday" links for one play (official source + this site). */
  function playLinks(pk, ai) {
    const w = el('span', 'sc-cell-links');
    w.appendChild(gameLink(pk, `${pk} · PA ${ai}`));
    w.appendChild(el('span', null, ' · '));
    w.appendChild(ext('Gameday', gamedayUrl(pk)));
    return w;
  }

  function renderCaptureSection(wrap, m) {
    const c = m.capture;
    const s = section('Live capture — rulings as first called',
      'MLB Stats API rewrites its history: after a scoring change, even its time-stamped snapshots show the new ruling for moments before the change ' +
      '(checked on official log 2026 #3 and #6 — links below). So the original call of a play, and its error type, exist only if someone recorded them ' +
      'before they changed. Every 10 minutes during game hours a GitHub Actions job polls live games and records each "reached on error" call and each ' +
      '"Official Scorer Ruling Pending" marker as first seen, plus every later change.');
    if (!c) { s.appendChild(el('div', 'empty', 'Live capture data is not published yet.')); wrap.appendChild(s); return; }
    s.appendChild(table(['What', 'Count'], [
      ['Plays recorded', num(c.plays)],
      ['Errors captured', num(c.errorsCaptured)],
      [`…first seen within ${c.originalMaxLagMin} min of the play (count as the original call)`, num(c.capturedAsOriginal)],
      ['…settled (game ≥ 14 days old) — usable for training', num(c.settled)],
      ['…changed to a hit / changed to something else', `${num(c.changedToHit)} / ${num(c.changedOther)}`],
      ['…changes seen live by the capture', num(c.changesSeenLive)],
      ['…changes not (yet) in MLB\u2019s official log', num(c.unloggedChanges)],
      ['Pending rulings captured / resolved', `${num(c.pendingCaptured)} / ${num(c.pendingResolved)}`],
      ['First / latest capture', c.firstCaptureAt ? `${localDateTime(c.firstCaptureAt)} / ${localDateTime(c.lastCaptureAt)}` : '—'],
      ['Median minutes from play to capture (90th pct)', c.lagMinutes ? `${c.lagMinutes.median} (${c.lagMinutes.p90})` : '—'],
    ]));
    const links = el('div', 'sc-links');
    links.appendChild(ext('Check: game 824943 at-bat 36, 84 s after the play', 'https://statsapi.mlb.com/api/v1.1/game/824943/feed/live?timecode=20260331_003000&fields=liveData,plays,allPlays,result,eventType,description,atBatIndex'));
    links.appendChild(ext('Check: same moment via diffPatch', 'https://statsapi.mlb.com/api/v1.1/game/824943/feed/live/diffPatch?startTimecode=20260331_002822&endTimecode=20260331_002835'));
    links.appendChild(ext('Official log (2026 #3: "instead of … an error")', OFFICIAL_PAGE));
    s.appendChild(links);
    if ((c.recentErrors || []).length) {
      s.appendChild(el('p', 'sc-help', 'Most recent captured errors (score = what the model said when the play was captured):'));
      s.appendChild(table(['Captured', 'Game', 'Error type', 'Score then', 'Now'], c.recentErrors.slice(0, 15).map((r) => [
        localDateTime(r.firstAt), playLinks(r.g, r.ai), (SM && SM.ERROR_KIND_LABELS[r.kind]) || r.kind || '—',
        r.scoreAtCapture != null ? `${r.scoreAtCapture}/100` : '—', r.current || '—',
      ])));
    }
    wrap.appendChild(s);
  }

  function renderErrorTypeSection(wrap, m) {
    const e = m.errorToHit;
    const a = e.adjust || {};
    const k = e.errorKind || {};
    const s = section('Error type (fielding / throwing / missed catch)',
      'The error type of a play changed to a hit disappears from MLB\u2019s data, so it cannot be learned from past seasons without leaking the answer. ' +
      'The live capture records it before any change; once enough captured errors have settled, the pipeline tests an adjustment ' +
      '(a shift plus error-type terms on top of the main model) with cross-validation and uses it only if it predicts better.');
    const p = el('p', 'sc-help');
    p.appendChild(el('strong', null, 'Status: '));
    p.appendChild(statusPill(a.status));
    const g = a.gates || {};
    p.appendChild(el('span', null, ` — ${num(a.n || 0)} settled captured errors, ${num(a.positives || 0)} changed to a hit. ` +
      `Needs ≥ ${g.minChangedShift || 8} changes to test a shift and ≥ ${g.minChangedKind || 15} changes (≥ ${g.minPlaysKind || 150} errors) to test error-type terms.`));
    s.appendChild(p);
    if (a.active) {
      s.appendChild(table(['Adjustment term', 'Coefficient'], [['shift', a.intercept], ...a.terms.map((t, i) => [t, a.coef[i]])]));
    }
    if ((a.byKind || []).length) {
      s.appendChild(table(['Captured error type', 'Errors', 'Changed to hit', 'Rate', 'Expected (main model)'],
        a.byKind.map((r) => [(SM && SM.ERROR_KIND_LABELS[r.kind]) || r.kind, num(r.n), num(r.changed), pct(r.rate), r.expected])));
    }
    const rr = k.impliedRelativeRate;
    if (rr) {
      s.appendChild(el('p', 'sc-help', 'Early evidence from past seasons (descriptive only — not used in scores): the official log states the original error type for only some ' +
        'changes, in its own wording. Share of each type among those changes vs among errors that stood; a ratio above 1 means that type was changed to a hit more often.'));
      s.appendChild(table(['Error type', 'Changes stating it', 'Share of those changes', 'Share of errors that stood', 'Ratio'],
        Object.entries(rr).map(([kind, v]) => [(SM && SM.ERROR_KIND_LABELS[kind]) || kind, num(v.changedStated), pct(v.shareOfChangedWithStatedType), pct(v.shareOfErrorsThatStood), v.ratio])));
      const w = k.changedToHitLogWording || {};
      s.appendChild(el('p', 'sc-help', `Log wording of the changes: ${Object.entries(w).map(([kk, v]) => `${kk.replace(/_/g, ' ')} ${v}`).join(' · ')}. ${k.note || ''}`));
    }
    wrap.appendChild(s);
  }

  function renderPendingSection(wrap, m) {
    const c = (m.pending && m.pending.calibration) || {};
    const cap = m.capture || {};
    const s = section('Pending rulings — calibration',
      'Pending-ruling chances start from how comparable batted balls were scored. A pending ruling is a harder call than an average ball, so the captured ' +
      'pending rulings and their resolutions re-weight each outcome, w = (observed + 5) / (expected + 5). The weights are used only with ≥ ' +
      `${c.minResolved || 10} resolved rulings and a better leave-one-out log loss.`);
    const p = el('p', 'sc-help');
    p.appendChild(el('strong', null, 'Status: '));
    p.appendChild(statusPill(c.status));
    p.appendChild(el('span', null, ` — ${num(c.resolved || 0)} resolved pending rulings captured.`));
    s.appendChild(p);
    if (c.resolved) {
      const outs = Object.keys(c.observed || {});
      s.appendChild(table(['Outcome', 'Observed', 'Expected', 'Weight'], outs.map((o) => [
        (SM && SM.OUTCOME_LABELS[o]) || o, num(c.observed[o]), c.expected[o], c.weights[o]])));
      const mt = c.metrics || {};
      if (mt.raw) {
        s.appendChild(table(['Distribution', 'Log loss', 'Brier', 'Top pick right'], [
          ['Comparable balls (raw)', mt.raw.logLoss, mt.raw.brier, pct(mt.raw.top1)],
          ['Calibrated (leave-one-out)', mt.calibratedLeaveOneOut ? mt.calibratedLeaveOneOut.logLoss : '—', mt.calibratedLeaveOneOut ? mt.calibratedLeaveOneOut.brier : '—', mt.calibratedLeaveOneOut ? pct(mt.calibratedLeaveOneOut.top1) : '—'],
        ]));
      }
    }
    const rows = (cap.pending || []).slice(0, 20);
    if (rows.length) {
      s.appendChild(el('p', 'sc-help', 'Captured pending rulings — the chance shown live and the final result:'));
      s.appendChild(table(['Pending since', 'Game · PA', 'Marker', 'Chance shown then (top 2)', 'Final ruling', 'Resolved'], rows.map((r) => [
        localDateTime(r.pendingAt), playLinks(r.g, r.ai), (r.codes || []).join(' + '),
        (r.predictedAtCapture || []).slice(0, 2).map((d) => `${(SM && SM.OUTCOME_LABELS[d.o]) || d.o} ${Math.round(d.p * 100)}`).join(' · ') || '—',
        r.resolvedEt || 'still pending', r.resolvedAt ? localDateTime(r.resolvedAt) : (r.resolvedSource || '—'),
      ])));
    }
    wrap.appendChild(s);
  }

  function renderEffectsSection(wrap, m) {
    const fx = m.effects;
    if (!fx) return;
    const s = section('Official scorer & home park — do they matter?',
      'Re-tested on every refresh over all seasons, using the official scorer of each game (MLB Stats API gameData.officialScorer). ' +
      'Test: shuffle the scorer (or home club) labels across plays and compare how far each group\u2019s changes are from what the batted balls predict ' +
      '(dispersion ≈ 1 means no difference). Scorer or park terms enter the scores only if a cross-validated model with them predicts better.');
    const row = (q, g, v) => {
      const t = v.test || {};
      const cv = v.cv || {};
      return [q, g, num(t.groups), num(t.plays), num(t.positives), t.dispersion != null ? t.dispersion : '—',
        t.pValue != null ? t.pValue : '—',
        cv.tested ? `${cv.deltaVsBest != null ? `+${cv.deltaVsBest}` : '—'} (SE ${cv.pairedSE != null ? cv.pairedSE : '—'})` : 'not tested',
        v.verdict || '—'];
    };
    s.appendChild(table(['Question', 'Grouping', 'Groups', 'Plays', 'Changes', 'Dispersion', 'p-value', 'CV log loss vs best (paired SE)', 'Verdict'], [
      row('Error → hit', 'Official scorer', fx.errorToHit.scorer),
      row('Error → hit', 'Home club', fx.errorToHit.homeClub),
      row('Hit → error', 'Official scorer', fx.hitToError.scorer),
      row('Hit → error', 'Home club', fx.hitToError.homeClub),
    ]));
    s.appendChild(el('p', 'sc-help', `Seasons: ${(fx.errorToHit.seasons || []).join(', ')} · ${num(fx.errorToHit.scorer.playsWithScorer)} error plays with a known official scorer.`));
    const tbl = (fx.errorToHit.scorer.table || []).slice(0, 30);
    if (tbl.length) {
      s.appendChild(el('p', 'sc-help', 'Error → hit by official scorer (≥ 20 errors; O/E = changes ÷ changes the batted balls predict; "shrunk" pulls small samples toward 1). ' +
        'Read with the test above: when it finds no difference, the spread here is mostly chance.'));
      s.appendChild(table(['Official scorer', 'Errors', 'Changed to hit', 'Expected', 'O/E', 'O/E shrunk'], tbl.map((r) => [
        r.label, num(r.n), num(r.observed), r.expected, r.ratio, r.shrunkRatio])));
    }
    wrap.appendChild(s);
  }

  /* --------------------------------------------------- irregularities */
  function renderIrregularities(wrap) {
    const data = state.irregularities;
    wrap.appendChild(el('p', 'sc-help',
      'Official entries that could not be verified cleanly, shown exactly as published — never corrected silently. ' +
      'Hover a flag for its meaning; use the links to check the game and the official list yourself.'));
    const items = (data && data.items) || [];
    if (!items.length) {
      wrap.appendChild(el('div', 'empty', data ? 'No irregularities flagged.' : 'Irregularities data is not available yet.'));
      return;
    }
    const counts = items.reduce((m, it) => { m[it.season] = (m[it.season] || 0) + 1; return m; }, {});
    wrap.appendChild(el('div', 'sc-count', `${items.length} flagged entries — ${Object.entries(counts).sort((a, b) => b[0] - a[0]).map(([s, n]) => `${s}: ${n}`).join(' · ')}`));
    const list = el('div', 'sc-list');
    items.slice().sort((a, b) => b.season - a.season || b.seq - a.seq).forEach((it) => {
      const row = el('article', 'sc-row sc-flagged');
      const left = el('div', 'sc-row-score');
      left.appendChild(el('span', 'sc-seq', `#${it.seq}`));
      left.appendChild(el('div', 'sc-band', String(it.season)));
      row.appendChild(left);
      const body = el('div', 'sc-row-body');
      const head = el('div', 'sc-row-head');
      head.appendChild(el('span', 'sc-class', it.classification ? (it.classification.includes('->') ? classificationLabel({ kind: 'ruling_change', transition: it.classification }) : (KIND[it.classification] || it.classification)) : '—'));
      if (it.currentEventType) head.appendChild(el('span', 'sc-inning', `StatsAPI now: ${it.currentEventType}`));
      body.appendChild(head);
      body.appendChild(el('div', 'sc-desc', String(it.raw).replace(/^\d+[.)]\s*/, '')));
      const fl = el('ul', 'sc-flag-list');
      [...(it.parseIssues || []), ...(it.linkFlags || [])].filter((x) => !/^(team_code_via|team_alias)/.test(x)).forEach((x) => {
        fl.appendChild(el('li', null, `${x.replace(/_/g, ' ')} — ${flagText(x)}`));
      });
      body.appendChild(fl);
      const links = el('div', 'sc-links');
      const archived = it.sourceUrl && it.sourceUrl.includes('web.archive.org');
      links.appendChild(ext(archived ? `MLB log ${it.season} (archived)` : 'MLB log', it.sourceUrl || OFFICIAL_PAGE));
      if (it.gamePk) {
        links.appendChild(ext('Gameday', gamedayUrl(it.gamePk)));
        links.appendChild(ext('StatsAPI', statsapiUrl(it.gamePk)));
      }
      const dm = String(it.raw).match(/\b(\d{1,2})\/(\d{1,2})\b/);
      if (dm) {
        const date = `${it.season}-${String(dm[1]).padStart(2, '0')}-${String(dm[2]).padStart(2, '0')}`;
        links.appendChild(ext(`Schedule ${dm[1]}/${dm[2]}`, scheduleUrl(date)));
      }
      body.appendChild(links);
      row.appendChild(body);
      list.appendChild(row);
    });
    wrap.appendChild(list);
  }

  window.addEventListener('hashchange', () => { readHash(); renderTabs(); renderPanel(); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // Test seam (tools/scoring-page-test.mjs)
  window.ScoringPage = { state, classificationLabel, flagText, renderPanel };
})();
