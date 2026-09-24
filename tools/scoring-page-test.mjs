#!/usr/bin/env node
/* ============================================================================
 * scoring-page-test.mjs — scoring.html renders the REAL published data.
 *
 * Loads assets/js/scoring-model.js + assets/js/scoring-page.js into a VM with
 * a small DOM stub; fetch() serves the repository's actual data/ files (the
 * pipeline's latest outputs). Every expected number is computed from those
 * same files, so the test stays valid as the data refreshes.
 * ==========================================================================*/
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';

const ROOT = new URL('../', import.meta.url);
const readJSON = (rel) => JSON.parse(readFileSync(new URL(rel, ROOT), 'utf8'));
if (!existsSync(new URL('data/model/scoring-model.json', ROOT))) {
  console.log('scoring-page-test: SKIP (no pipeline outputs in data/ yet)');
  process.exit(0);
}

/* ------------------------------------------------------------ DOM stub */
function makeNode(tag) {
  const node = {
    tagName: String(tag).toUpperCase(), className: '', attrs: {}, children: [], listeners: {},
    _text: '', selected: false, value: '', title: '', parentNode: null,
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); },
    set textContent(v) { this._text = String(v); this.children = []; },
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'value') this.value = String(v); },
    getAttribute(k) { return this.attrs[k]; },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
    get firstChild() { return this.children[0] || null; },
    get lastChild() { return this.children[this.children.length - 1] || null; },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    dispatch(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })); },
  };
  return node;
}
const registry = {};
['#sc-updated', '#sc-summary', '#sc-tabs', '#sc-panel'].forEach((id) => { registry[id] = makeNode('div'); });
const windowListeners = {};
const windowStub = {
  location: { hash: '' },
  history: { replaceState(_a, _b, h) { windowStub.location.hash = h; } },
  addEventListener(type, fn) { windowListeners[type] = fn; },
};
const documentStub = {
  readyState: 'complete',
  createElement: makeNode,
  querySelector: (sel) => registry[sel] || null,
  addEventListener() {},
};
// One deterministic Savant xBA value is injected into the served copies of the
// real files (pipeline outputs only carry it once Savant has answered for the
// play) so the rendering path is exercised by this test on every run — even
// while a fresh pipeline run has not asked Savant about these plays yet.
//
// The official list renders newest-first in pages of 100, so the fixtures go on
// rows the FIRST page shows: for 📋 Official Changes the last linked entry of
// the file, and for 📉 Hit → Error the last linked hit → error entry. That
// keeps the expected value deterministic however the data refreshes.
const SAVANT_FIXTURE = { xba: 0.329, ls: 95.1, la: -3, source: 'savant:estimated_ba_using_speedangle' };
const fetchStub = async (url) => {
  const u = new URL(String(url), ROOT);
  if (!existsSync(u)) return { ok: false, status: 404, json: async () => ({}) };
  const body = readFileSync(u, 'utf8');
  const data = JSON.parse(body);
  if (/error-watch\.json$/.test(u.pathname) && data.plays && data.plays[0]) data.plays[0].savant = { ...SAVANT_FIXTURE };
  if (/scoring-changes-\d{4}\.json$/.test(u.pathname) && data.entries) {
    const linked = data.entries.filter((x) => x.link && x.link.atBatIndex != null);
    const h2e = linked.filter((x) => ((x.cls && x.cls.flags) || []).includes('hitToError'));
    [linked[linked.length - 1], h2e[h2e.length - 1]].forEach((e) => {
      if (e) e.savant = { xba: SAVANT_FIXTURE.xba, ls: SAVANT_FIXTURE.ls, la: SAVANT_FIXTURE.la, gameDate: e.date, source: SAVANT_FIXTURE.source };
    });
  }
  if (/pipeline-report\.json$/.test(u.pathname) && data.savant) {
    data.savant.perPlay = { needed: 10, matched: 4, pending: 6, coverage: 0.4 };
  }
  return { ok: true, status: 200, json: async () => data };
};
const context = {
  window: windowStub, document: documentStub, fetch: fetchStub, console,
  setTimeout, clearTimeout, Promise, Map, Set, Date, Math, JSON, Number, String, Object, Array,
};
context.window.MLBScoringModel = undefined;
vm.createContext(context);
vm.runInContext(readFileSync(new URL('assets/js/scoring-model.js', ROOT), 'utf8'), context);
vm.runInContext(readFileSync(new URL('assets/js/scoring-page.js', ROOT), 'utf8'), context);
const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r)); };
await settle();

const text = (id) => registry[id].textContent;
function find(node, pred) {
  if (pred(node)) return node;
  for (const c of node.children) { const f = find(c, pred); if (f) return f; }
  return null;
}
function findAll(node, pred, out = []) {
  if (pred(node)) out.push(node);
  node.children.forEach((c) => findAll(c, pred, out));
  return out;
}
const noJunk = (s, where) => {
  assert.ok(!/\bundefined\b/.test(s), `${where}: no "undefined"`);
  assert.ok(!/\bNaN\b/.test(s), `${where}: no "NaN"`);
};

const model = readJSON('data/model/scoring-model.json');
const report = readJSON('data/model/pipeline-report.json');
const watch = readJSON('data/model/error-watch.json');
const off2026 = readJSON('data/official/scoring-changes-2026.json');
const irr = readJSON('data/official/irregularities.json');

// Header + summary
assert.match(text('#sc-updated'), /Updated .* refreshes every 3 hours/);
const summary = text('#sc-summary');
assert.ok(summary.includes(String(report.seasons['2026'].officialEntries)), 'summary: 2026 entry count');
assert.ok(summary.includes(watch.plays.length.toLocaleString()), 'summary: error count');
assert.ok(summary.includes(`AUC ${model.errorToHit.cv.auc.toFixed(2)}`), 'summary: model AUC');
assert.ok(summary.includes('plays have Savant xBA'), 'summary: per-play Savant xBA coverage is reported, not guessed');
noJunk(summary, 'summary');

// Tabs
assert.deepEqual(registry['#sc-tabs'].children.map((b) => b.textContent),
  ['🎯 Error Watch', '📋 Official Changes', '📉 Hit → Error', '📈 Model', '⚑ Irregularities']);

// Error Watch (default tab)
let panel = text('#sc-panel');
assert.ok(panel.includes(`of ${watch.plays.length.toLocaleString()} plays`), 'watch: total count');
const rows = findAll(registry['#sc-panel'], (n) => n.className.split(/\s+/).includes('sc-row'));
assert.equal(rows.length, Math.min(100, watch.plays.length), 'watch: first page of rows');
assert.ok(panel.includes('/100'), 'watch: scores rendered');
assert.ok(find(registry['#sc-panel'], (n) => n.attrs.href && n.attrs.href.startsWith('https://www.mlb.com/gameday/')), 'watch: Gameday links');
assert.ok(find(registry['#sc-panel'], (n) => n.attrs.href && n.attrs.href.startsWith('https://baseballsavant.mlb.com/gamefeed?gamePk=')), 'watch: Savant links');
// The watch panel pages from the front of the file, whose first row carries the
// injected fixture.
assert.ok(watch.plays.length > 0, 'watch: plays present');
assert.ok(panel.includes('Savant xBA 0.329'), 'watch: the true per-play xBA is shown next to the model number');
assert.ok(panel.includes('exit velocity 95.1 mph'), 'watch: the EV Savant saw is shown with its xBA');
noJunk(panel, 'watch');
const statusSelect = findAll(registry['#sc-panel'], (n) => n.tagName === 'SELECT')[0];
statusSelect.value = 'changed_to_hit';
statusSelect.dispatch('change');
await settle();
const changed = watch.plays.filter((p) => p.status === 'changed_to_hit').length;
assert.ok(text('#sc-panel').includes(`of ${changed.toLocaleString()} plays`), 'watch: status filter');
assert.ok(text('#sc-panel').includes('Official log #') || changed === 0, 'watch: changed plays show their official entry');
// Error-type filter (v2): only when the data carries error types.
if (watch.plays.some((p) => p.errKind)) {
  const kindSelect = find(registry['#sc-panel'], (n) => n.tagName === 'SELECT' && n.children.some((o) => o.attrs.value === 'throwing'));
  assert.ok(kindSelect, 'watch: error-type filter');
  kindSelect.value = 'throwing';
  kindSelect.dispatch('change');
  assert.ok(text('#sc-panel').includes('of 0 plays'), 'watch: changed-to-hit plays carry no error type (it is gone from the data)');
  const statusSelect = find(registry['#sc-panel'], (n) => n.tagName === 'SELECT' && n.children.some((o) => o.attrs.value === 'changed_to_hit'));
  statusSelect.value = 'all';
  statusSelect.dispatch('change');
  const nThrow = watch.plays.filter((p) => p.errKind === 'throwing').length;
  assert.ok(nThrow > 0 && text('#sc-panel').includes(`of ${nThrow.toLocaleString()} plays`), `watch: error-type filter (${nThrow} throwing errors)`);
}

// Official Changes
registry['#sc-tabs'].children[1].dispatch('click');
await settle();
panel = text('#sc-panel');
assert.ok(panel.includes(`of ${off2026.entries.length} entries`), 'official: all entries');
// Unconditional: the fetch stub injected the fixture into the entry the first
// page renders (asserted here so a change in the injection target is visible).
assert.ok(off2026.entries.some((e) => e.link && e.link.atBatIndex != null), 'official: there are linked entries');
assert.ok(panel.includes('Savant xBA 0.329'), 'official: Savant xBA shown for the linked play');
assert.ok(panel.includes('exit velocity 95.1 mph'), 'official: the EV Savant saw is shown with its xBA');
assert.match(windowStub.location.hash, /^#official\/2026$/);
const typeSelect = findAll(registry['#sc-panel'], (n) => n.tagName === 'SELECT')[1];
typeSelect.value = 'errorToHit';
typeSelect.dispatch('change');
await settle();
const e2h = off2026.entries.filter((e) => e.cls.flags.includes('errorToHit')).length;
assert.ok(text('#sc-panel').includes(`of ${e2h} entries`), 'official: error→hit filter');
assert.ok(text('#sc-panel').includes('Error → Hit'), 'official: classification label');
assert.ok(text('#sc-panel').includes('pre-change'), 'official: model score on error→hit entries');
noJunk(text('#sc-panel'), 'official');

// 📉 Hit → Error (session-3 charter): its own section — the same entries the
// official list flags hitToError, with pre-change chances and final rulings.
registry['#sc-tabs'].children[2].dispatch('click');
await settle();
panel = text('#sc-panel');
assert.match(windowStub.location.hash, /^#hiterror\/2026$/, 'hit→error: hash route');
const h2eEntries = off2026.entries.filter((e) => e.cls.flags.includes('hitToError'));
assert.ok(panel.includes(`of ${h2eEntries.length} entries`), `hit→error: all flagged entries (${h2eEntries.length})`);
assert.ok(panel.includes('Hit → Error'), 'hit→error: classification label');
assert.ok(panel.includes('first ruled a hit'), 'hit→error: section explains the segregation');
assert.ok(h2eEntries.some((e) => e.link && e.link.atBatIndex != null), 'hit→error: there are linked entries');
assert.ok(panel.includes('Savant xBA 0.329'), 'hit→error: the true per-play xBA is shown beside the model number');
assert.ok(!panel.includes('undefined') && !panel.includes('NaN'), 'hit→error: no junk');
const h2eRows = findAll(registry['#sc-panel'], (n) => n.className.split(/\s+/).includes('sc-row'));
assert.equal(h2eRows.length, Math.min(100, h2eEntries.length), 'hit→error: first page row count');
if (h2eEntries.some((e) => e.model && typeof e.model.p === 'number')) {
  assert.ok(panel.includes('/100'), 'hit→error: pre-change model scores rendered');
  assert.ok(panel.includes('pre-change'), 'hit→error: out-of-fold note rendered');
}
assert.ok(find(registry['#sc-panel'], (n) => n.attrs.href === 'https://www.mlb.com/official-information/scoring-changes'),
  'hit→error: MLB official log link');
// Season switch keeps working inside the section.
const h2eSeasonSelect = findAll(registry['#sc-panel'], (n) => n.tagName === 'SELECT')[0];
assert.ok(h2eSeasonSelect, 'hit→error: season selector');
h2eSeasonSelect.value = '2025';
h2eSeasonSelect.dispatch('change');
await settle();
const off2025 = readJSON('data/official/scoring-changes-2025.json');
const h2e2025 = off2025.entries.filter((e) => e.cls.flags.includes('hitToError')).length;
assert.ok(text('#sc-panel').includes(`of ${h2e2025} entries`), `hit→error: 2025 season (${h2e2025} entries)`);
h2eSeasonSelect.value = '2026';
findAll(registry['#sc-panel'], (n) => n.tagName === 'SELECT')[0].value = '2026';
findAll(registry['#sc-panel'], (n) => n.tagName === 'SELECT')[0].dispatch('change');
await settle();
noJunk(text('#sc-panel'), 'hit→error');

// Model card
registry['#sc-tabs'].children[3].dispatch('click');
await settle();
panel = text('#sc-panel');
assert.ok(panel.includes(model.errorToHit.cv.auc.toFixed(3)), 'model: CV AUC');
assert.ok(panel.includes('Limitations'), 'model: limitations');
assert.ok(panel.includes('Comparable-ball hit rate'), 'model: rate table');
// v2 sections render whenever the pipeline has published their data.
if (model.capture) {
  assert.ok(panel.includes('Live capture — rulings as first called'), 'model: live capture section');
  assert.ok(panel.includes(model.capture.plays.toLocaleString()), 'model: captured count');
  assert.ok(summary.includes('Live capture') || text('#sc-summary').includes('Live capture'), 'summary: live capture card');
}
if (model.errorToHit.adjust) {
  assert.ok(panel.includes('Error type (fielding / throwing / missed catch)'), 'model: error type section');
  assert.ok(/Status: (Collecting|Tested|Active)/.test(panel), 'model: adjustment status shown');
}
if (model.pending && model.pending.calibration) assert.ok(panel.includes('Pending rulings — calibration'), 'model: pending calibration section');
if (model.effects) {
  assert.ok(panel.includes('Official scorer & home park'), 'model: scorer section');
  for (const q of ['errorToHit', 'hitToError']) {
    const pv = model.effects[q].scorer.test.pValue;
    if (pv != null) assert.ok(panel.includes(String(pv)), `model: ${q} scorer p-value shown`);
  }
}
noJunk(panel, 'model');

// Irregularities
registry['#sc-tabs'].children[4].dispatch('click');
await settle();
panel = text('#sc-panel');
assert.ok(panel.includes(`${irr.items.length} flagged entries`), 'irregularities: count');
noJunk(panel, 'irregularities');

console.log(`scoring-page-test: OK (${watch.plays.length} errors, ${off2026.entries.length} official entries, ${irr.items.length} irregularities)`);
