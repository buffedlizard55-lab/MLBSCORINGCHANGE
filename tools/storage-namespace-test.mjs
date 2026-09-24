#!/usr/bin/env node
/* ============================================================================
 * storage-namespace-test.mjs — this copy must never share browser storage
 * with the original MLB-Live-PBP site.
 *
 * Both sites are served from the same origin (https://buffedlizard55-lab.github.io)
 * and localStorage is per-origin, so identical keys would let this copy read
 * and overwrite the original site's saved feed logs and preferences.
 *
 * Checks:
 *   1. every storage-key constant exported by feed-log.js / reviews-feed.js
 *      starts with 'mlbScoringChange.' (runtime values, not source regexes);
 *   2. every string-literal key passed to getItem/setItem/removeItem in any
 *      browser script or page starts with 'mlbScoringChange.';
 *   3. the original site's key names never appear in executable code
 *      (comments explaining the rename are allowed).
 * ==========================================================================*/
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const NS = 'mlbScoringChange.';
const ORIGINAL_KEYS = ['mlbReplayFeedLog', 'replayFeedSoundEnabled', 'replayFeedNotifyEnabled'];

// 1. runtime constants
const feedLog = require(path.join(ROOT, 'assets/js/feed-log.js'));
for (const k of ['FEED_LOG_KEY_PREFIX', 'FEED_LOG_INDEX_KEY']) {
  assert.ok(String(feedLog[k]).startsWith(NS), `feed-log.js ${k}=${feedLog[k]}`);
}
assert.ok(feedLog.feedLogStorageKey('2026-09-24').startsWith(NS));

// reviews-feed.js exports its pure helpers through module.exports at file end.
const vm = await import('node:vm');
const feedSrc = readFileSync(path.join(ROOT, 'assets/js/reviews-feed.js'), 'utf8');
const ctx = {
  console: { log() {}, warn() {}, error() {} },
  setTimeout, clearTimeout, setInterval, clearInterval, Promise, Map, Set, Date, Math, JSON,
  window: {}, document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; } },
  module: { exports: {} },
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(feedSrc, ctx);
const exported = ctx.module.exports;
for (const k of ['FEED_LOG_KEY_PREFIX', 'FEED_LOG_INDEX_KEY', 'SOUND_PREF_KEY', 'NOTIFY_PREF_KEY']) {
  assert.ok(typeof exported[k] === 'string' && exported[k].startsWith(NS), `reviews-feed.js ${k}=${exported[k]}`);
}

// 2 + 3. source scan
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1').replace(/<!--[\s\S]*?-->/g, '');
}
const files = [
  ...readdirSync(path.join(ROOT, 'assets/js')).filter((f) => f.endsWith('.js')).map((f) => path.join(ROOT, 'assets/js', f)),
  ...readdirSync(ROOT).filter((f) => f.endsWith('.html')).map((f) => path.join(ROOT, f)),
];
let literalKeys = 0;
for (const file of files) {
  const code = stripComments(readFileSync(file, 'utf8'));
  for (const m of code.matchAll(/\.(?:getItem|setItem|removeItem)\(\s*(['"`])([^'"`]*)\1/g)) {
    literalKeys += 1;
    assert.ok(m[2].startsWith(NS), `${path.relative(ROOT, file)} uses storage key '${m[2]}'`);
  }
  for (const key of ORIGINAL_KEYS) {
    assert.ok(!code.includes(key), `${path.relative(ROOT, file)} still references original key ${key}`);
  }
}

console.log(`storage-namespace-test: OK (${files.length} files scanned, ${literalKeys} literal keys, all under '${NS}')`);
