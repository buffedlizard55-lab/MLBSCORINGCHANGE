#!/usr/bin/env node
/* ============================================================================
 * scoring-model-feed-test.mjs — the scoring-change model inside the live
 * Replay Feed (reviews.html), end to end, no network.
 *
 * Loads the REAL modules (reviews.js, scoring-model.js, reviews-feed.js) into
 * a VM with a recording DOM stub and drives the real boot path. All game
 * data here is SYNTHETIC (clearly constructed: team ids 901/902, gamePk
 * 990001) — it exercises the wiring, not baseball facts.
 *
 * Asserts:
 *   1. a field_error play appears on the 🎯 Error Watch tab with a 0–100
 *      score computed by MLBScoringModel from the lazily fetched hitData,
 *      its batted ball, and the official-log confirmation link;
 *   2. an Official Scorer Ruling Pending row shows the final-ruling
 *      distribution;
 *   3. when the error is rescored as a single, the scoring-change row shows
 *      the pre-change chance + final result, and the Error Watch row shows
 *      the new final ruling;
 *   4. Error Watch rows are NOT feed entries (the All count is unchanged), so
 *      they can never trigger the alert chime;
 *   5. hitData is requested lazily with its own projection, once per game.
 * ==========================================================================*/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function makeNode(tag) {
  const node = {
    tag, cls: '', text: '', attrs: {}, children: [], dataset: {}, title: null, hidden: false,
    classList: { _set: new Set(), add(...c) { c.forEach((x) => this._set.add(x)); }, remove(...c) { c.forEach((x) => this._set.delete(x)); }, toggle() {}, contains(c) { return this._set.has(c); } },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    appendChild(child) { this.children.push(child); return child; },
    prepend(child) { this.children.unshift(child); return child; },
    removeChild(child) { const i = this.children.indexOf(child); if (i >= 0) this.children.splice(i, 1); return child; },
    remove() {}, addEventListener() {},
    get firstChild() { return this.children[0] || null; },
    querySelector() { return null; },
  };
  return node;
}
const registry = {};
['#status-line', '#feed-stats', '#active-strip', '#feed-tabs', '#feed-list', '#date-picker', '#date-label',
  '#live-dot', '#banner', '#date-nav', '#countdown', '#refresh-btn'].forEach((id) => { registry[id] = makeNode('div'); });
let domReadyCb = null;
const documentStub = {
  hidden: false,
  createElement: (tag) => makeNode(tag),
  querySelector: (sel) => registry[sel] || null,
  addEventListener: (ev, cb) => { if (ev === 'DOMContentLoaded') domReadyCb = cb; },
};
const UIStub = {
  el: (tag, cls, text, attrs) => {
    const n = makeNode(tag);
    if (cls) n.cls = cls;
    if (text != null) n.text = String(text);
    if (attrs) Object.entries(attrs).forEach(([k, v]) => { if (v != null) n.setAttribute(k, v); });
    return n;
  },
  clear: (n) => { n.children.length = 0; return n; },
};

/* ------------------------------------------------ SYNTHETIC game fixtures */
const GAME_PK = 990001;
const today = new Date().toISOString().slice(0, 10);
const SCHEDULE = [{
  gamePk: GAME_PK, gameType: 'R', season: today.slice(0, 4), officialDate: today,
  status: { abstractGameState: 'Live', codedGameState: 'I', detailedState: 'In Progress' },
  teams: { away: { team: { id: 901, name: 'Synthetic Away Club' } }, home: { team: { id: 902, name: 'Synthetic Home Club' } } },
}];
const TEAMS = { 901: { id: 901, name: 'Synthetic Away Club', abbreviation: 'SYA' }, 902: { id: 902, name: 'Synthetic Home Club', abbreviation: 'SYH' } };

function errorPlay(eventType, event, description) {
  return {
    about: { atBatIndex: 0, inning: 1, halfInning: 'top', isTopInning: true, isComplete: true, startTime: `${today}T17:00:00Z`, endTime: `${today}T17:01:00Z` },
    result: { type: 'atBat', event, eventType, description, awayScore: 0, homeScore: 0, isOut: false },
    matchup: { batter: { id: 5001, fullName: 'Synthetic Batter' }, pitcher: { id: 6001, fullName: 'Synthetic Pitcher' } },
    playEvents: [{ index: 0, isPitch: true, details: { description: 'In play, no out' } }],
    runners: [{ movement: { originBase: null, start: null, end: '1B', isOut: false }, details: { event, eventType, runner: { id: 5001, fullName: 'Synthetic Batter' }, isScoringEvent: false, playIndex: 0 } }],
  };
}
const pendingPlay = {
  about: { atBatIndex: 1, inning: 1, halfInning: 'top', isTopInning: true, isComplete: false, startTime: `${today}T17:05:00Z` },
  result: { type: 'atBat' },
  matchup: { batter: { id: 5002, fullName: 'Second Batter' }, pitcher: { id: 6001, fullName: 'Synthetic Pitcher' } },
  playEvents: [
    { index: 0, isPitch: true, details: { description: 'In play, no out' } },
    { index: 1, isPitch: false, type: 'action', details: { description: 'Official Scorer Ruling Pending', event: 'Official Scorer Ruling Pending', eventType: 'os_ruling_pending_primary' } },
  ],
  runners: [{ movement: { originBase: null, start: null, end: '1B', isOut: false }, details: { runner: { id: 5002, fullName: 'Second Batter' } } }],
};
let pbp = {
  allPlays: [errorPlay('field_error', 'Field Error', 'Synthetic Batter reaches on a fielding error by shortstop Synthetic Fielder.'), pendingPlay],
  currentPlay: pendingPlay,
};
const HIT_DATA = {
  allPlays: [
    { about: { atBatIndex: 0 }, playEvents: [{ details: { isInPlay: true }, hitData: { launchSpeed: 95, launchAngle: 5, trajectory: 'ground_ball', location: '6' } }] },
    { about: { atBatIndex: 1 }, playEvents: [{ details: { isInPlay: true }, hitData: { launchSpeed: 70, launchAngle: 30, trajectory: 'popup', location: '4' } }] },
  ],
};
const calls = { pbp: 0, hitData: 0, fetch: [] };
const MLBStub = {
  getSchedule: async () => SCHEDULE,
  getTeams: async () => TEAMS,
  getPlayByPlay: async () => { calls.pbp += 1; return pbp; },
  getChallengeCounts: async () => ({ gameData: {} }),
  getPlayHitData: async (pk) => { calls.hitData += 1; assert.equal(pk, GAME_PK); return HIT_DATA; },
  ordinal: (n) => `${n}${['th', 'st', 'nd', 'rd'][n] || 'th'}`,
};
// SYNTHETIC model: one term, a 2×2 hit-probability surface.
const MODEL = {
  version: 1,
  hitProb: {
    surface: { evMin: 40, evStep: 40, nEv: 2, laMin: -60, laStep: 65, nLa: 2, rate: [0.05, 0.2, 0.3, 0.6] },
    fallback: { overall: 0.3, byTraj: {}, byTrajLoc: {} },
  },
  errorToHit: { terms: ['logit_hit_prob'], coef: [1], intercept: -2, baseRate: 0.05 },
  hitToError: { terms: ['logit_hit_prob'], coef: [-1], intercept: -6, baseRate: 0.001 },
  pending: { outcomes: ['hit', 'error', 'fc', 'out', 'sac', 'other'], evEdges: [85], laEdges: [10], minN: 1, table: { R: { n: 1000, p: [0.7, 0.2, 0.1, 0, 0, 0] } } },
};
const OFFICIAL = { entries: [{ seq: 7, raw: '7. (synthetic) SYA@SYH -- Synthetic Batter now has a single instead of an error.', cls: { kind: 'ruling_change', transition: 'error->hit' }, link: { gamePk: GAME_PK, atBatIndex: 0 } }] };
const fetchStub = async (url) => {
  calls.fetch.push(String(url));
  if (String(url) === 'data/model/scoring-model.json') return { ok: true, json: async () => MODEL };
  if (/^data\/official\/scoring-changes-\d{4}\.json$/.test(String(url))) return { ok: true, json: async () => OFFICIAL };
  return { ok: false, json: async () => ({}) };
};

/* ------------------------------------------------------------- run page */
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const windowStub = { location: { search: '' }, history: { replaceState() {} } };
const context = {
  console: { warn() {}, error: console.error.bind(console), log() {} },
  Map, Set, Date, Math, Number, String, Object, Array, URLSearchParams, Promise,
  CSS: { escape: (s) => s }, UI: UIStub, MLB: MLBStub, window: windowStub, document: documentStub,
  fetch: fetchStub,
  setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  module: { exports: {} },
};
vm.createContext(context);
vm.runInContext(read('assets/js/reviews.js'), context, { filename: 'reviews.js' });
vm.runInContext(read('assets/js/scoring-model.js'), context, { filename: 'scoring-model.js' });
context.module = { exports: {} };
vm.runInContext(read('assets/js/reviews-feed.js'), context, { filename: 'reviews-feed.js' });
assert.ok(windowStub.MLBScoringModel, 'scoring-model.js registers window.MLBScoringModel');

const settle = async () => { for (let i = 0; i < 12; i += 1) await new Promise((r) => setImmediate(r)); };
domReadyCb();
await settle();
windowStub.ReplayFeed.refresh();   // second poll: hitData + model are in by now
await settle();

function strings(node, out = []) {
  if (node.text) out.push(node.text);
  Object.values(node.attrs || {}).forEach((v) => out.push(v));
  if (node.title) out.push(node.title);
  (node.children || []).forEach((c) => strings(c, out));
  return out;
}
const tabText = () => strings(registry['#feed-tabs']).join(' | ');
const listText = () => strings(registry['#feed-list']).join(' | ');

// 1. Error Watch tab + row
assert.match(tabText(), /🎯 Error Watch \(1\)/);
assert.match(tabText(), /All \(1\)/, 'Error Watch items are not feed entries (All counts the pending row only)');
windowStub.ReplayFeed.setFilter('errorwatch');
let text = listText();
assert.match(text, /Chance this error becomes a hit/);
// surface cell (95 mph, 5°) = 0.6 → z = -2 + logit(0.6) → p ≈ 0.169 → 17/100
const expected = Math.round(100 / (1 + Math.exp(-(-2 + Math.log(0.6 / 0.4)))));
assert.ok(text.includes(`${expected}/100`), `score ${expected}/100 shown`);
assert.match(text, /Stands as error/);
assert.match(text, /95\.0 mph · 5° · ground ball · to shortstop/);
assert.match(text, /comparable batted balls became hits 60% of the time/);
assert.match(text, /✓ Official MLB log #7/);
assert.match(text, /https:\/\/www\.mlb\.com\/official-information\/scoring-changes/);
assert.equal(calls.hitData, 1, 'hitData requested once for the game');

// 2. Pending row distribution (All tab)
windowStub.ReplayFeed.setFilter('all');
text = listText();
assert.match(text, /Likely final ruling/);
assert.match(text, /Hit \(single or better\) 70/);
assert.match(text, /Error 20/);
assert.match(text, /Fielder's choice 10/);

// 3. The error is rescored as a single → scoring-change row + Error Watch final ruling
pbp = { ...pbp, allPlays: [errorPlay('single', 'Single', 'Synthetic Batter singles on a ground ball to shortstop Synthetic Fielder.'), pendingPlay] };
windowStub.ReplayFeed.refresh();
await settle();
windowStub.ReplayFeed.setFilter('scoring');
text = listText();
assert.match(text, /Field Error/);
assert.match(text, /Pre-change chance this error becomes a hit/);
assert.ok(text.includes(`${expected}/100`));
assert.match(text, /Final result: Single — the change the model scored/);
windowStub.ReplayFeed.setFilter('errorwatch');
text = listText();
assert.match(text, /✏️ Now: Single/);
assert.match(text, /Final ruling \(changed to a hit\): Synthetic Batter singles/);
assert.match(text, /Initial call: Synthetic Batter reaches on a fielding error/);

// 4/5. no Error Watch entry leaked into the feed; model/official fetched once
windowStub.ReplayFeed.setFilter('all');
assert.ok(!listText().includes('Error Watch'), 'All section never renders Error Watch rows');
assert.equal(calls.fetch.filter((u) => u === 'data/model/scoring-model.json').length, 1, 'model fetched once');
assert.equal(calls.fetch.filter((u) => u.startsWith('data/official/')).length, 1, 'official log fetched once (30-min cache)');

console.log('scoring-model-feed-test: OK');
