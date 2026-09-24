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
const fetchStub = async (url) => {
  const u = new URL(String(url), ROOT);
  if (!existsSync(u)) return { ok: false, status: 404, json: async () => ({}) };
  const body = readFileSync(u, 'utf8');
  return { ok: true, status: 200, json: async () => JSON.parse(body) };
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
const watch = readJSON('data/model/error-watch-2026.json');
const off2026 = readJSON('data/official/scoring-changes-2026.json');
const irr = readJSON('data/official/irregularities.json');

// Header + summary
assert.match(text('#sc-updated'), /Updated .* refreshes every 3 hours/);
const summary = text('#sc-summary');
assert.ok(summary.includes(String(report.seasons['2026'].officialEntries)), 'summary: 2026 entry count');
assert.ok(summary.includes(watch.plays.length.toLocaleString()), 'summary: error count');
assert.ok(summary.includes(`AUC ${model.errorToHit.cv.auc.toFixed(2)}`), 'summary: model AUC');
noJunk(summary, 'summary');

// Tabs
assert.deepEqual(registry['#sc-tabs'].children.map((b) => b.textContent),
  ['🎯 Error Watch', '📋 Official Changes', '📈 Model', '⚑ Irregularities']);

// Error Watch (default tab)
let panel = text('#sc-panel');
assert.ok(panel.includes(`of ${watch.plays.length.toLocaleString()} plays`), 'watch: total count');
const rows = findAll(registry['#sc-panel'], (n) => n.className.split(/\s+/).includes('sc-row'));
assert.equal(rows.length, Math.min(100, watch.plays.length), 'watch: first page of rows');
assert.ok(panel.includes('/100'), 'watch: scores rendered');
assert.ok(find(registry['#sc-panel'], (n) => n.attrs.href && n.attrs.href.startsWith('https://www.mlb.com/gameday/')), 'watch: Gameday links');
assert.ok(find(registry['#sc-panel'], (n) => n.attrs.href && n.attrs.href.startsWith('https://baseballsavant.mlb.com/gamefeed?gamePk=')), 'watch: Savant links');
noJunk(panel, 'watch');
const statusSelect = findAll(registry['#sc-panel'], (n) => n.tagName === 'SELECT')[0];
statusSelect.value = 'changed_to_hit';
statusSelect.dispatch('change');
await settle();
const changed = watch.plays.filter((p) => p.status === 'changed_to_hit').length;
assert.ok(text('#sc-panel').includes(`of ${changed.toLocaleString()} plays`), 'watch: status filter');
assert.ok(text('#sc-panel').includes('Official log #') || changed === 0, 'watch: changed plays show their official entry');

// Official Changes
registry['#sc-tabs'].children[1].dispatch('click');
await settle();
panel = text('#sc-panel');
assert.ok(panel.includes(`of ${off2026.entries.length} entries`), 'official: all entries');
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

// Model card
registry['#sc-tabs'].children[2].dispatch('click');
await settle();
panel = text('#sc-panel');
assert.ok(panel.includes(model.errorToHit.cv.auc.toFixed(3)), 'model: CV AUC');
assert.ok(panel.includes('Limitations'), 'model: limitations');
assert.ok(panel.includes('Comparable-ball hit rate'), 'model: rate table');
noJunk(panel, 'model');

// Irregularities
registry['#sc-tabs'].children[3].dispatch('click');
await settle();
panel = text('#sc-panel');
assert.ok(panel.includes(`${irr.items.length} flagged entries`), 'irregularities: count');
noJunk(panel, 'irregularities');

console.log(`scoring-page-test: OK (${watch.plays.length} errors, ${off2026.entries.length} official entries, ${irr.items.length} irregularities)`);
