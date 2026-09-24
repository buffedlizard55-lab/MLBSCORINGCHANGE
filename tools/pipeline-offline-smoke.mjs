#!/usr/bin/env node
// End-to-end offline run of pipeline/run.mjs against the SYNTHETIC fetch stub
// (tools/fixtures/pipeline-fetch-stub.cjs). Outputs go to a temp directory,
// so the repository's real data/ files are never touched.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-smoke-'));
const env = {
  ...process.env,
  PIPELINE_OUT_DIR: path.join(tmp, 'data'),
  PIPELINE_CACHE_DIR: path.join(tmp, 'cache'),
  PIPELINE_PROBE_DIR: path.join(tmp, 'probe'),
};
const run = spawnSync(process.execPath, ['--require', path.join(ROOT, 'tools/fixtures/pipeline-fetch-stub.cjs'), path.join(ROOT, 'pipeline/run.mjs')], {
  cwd: ROOT, env, encoding: 'utf8', timeout: 180000,
});
if (run.status !== 0) {
  console.error(run.stdout);
  console.error(run.stderr);
  throw new Error(`pipeline exited with ${run.status}`);
}
const read = (rel) => JSON.parse(fs.readFileSync(path.join(tmp, 'data', rel), 'utf8'));

const report = read('model/pipeline-report.json');
assert.equal(report.fatal, undefined, 'no fatal error');
for (const s of [2024, 2025, 2026]) {
  assert.equal(report.logs[s].ok, true, `log ${s} parsed`);
  assert.equal(report.seasons[s].selfCheck.equal, true, `projection self-check ${s}`);
  assert.equal(report.seasons[s].completed, 24);
  assert.ok(report.seasons[s].linked >= report.seasons[s].officialEntries - 1, `entries linked ${s}`);
}
assert.ok(report.discovery.pendingMarkerCounts.os_ruling_pending_prior > 0, 'pending markers discovered');

const official = read('official/scoring-changes-2026.json');
const e2h = official.entries.filter((e) => e.cls.flags.includes('errorToHit'));
assert.ok(e2h.length > 0, 'error→hit entries classified');
for (const e of e2h) {
  assert.ok(e.link.gamePk && e.link.atBatIndex != null, `linked #${e.seq}`);
  assert.equal(e.link.currentEventType, 'single', `verified against current ruling #${e.seq}`);
  assert.ok(!e.link.flags.includes('current_ruling_mismatch'));
  assert.ok(e.model && Number.isInteger(e.model.score), `model score on #${e.seq}`);
}
assert.ok(fs.readFileSync(path.join(tmp, 'data', 'official/raw/scoring-changes-2026.txt'), 'utf8').includes('now has a single instead of'));

const model = read('model/scoring-model.json');
assert.ok(Array.isArray(model.errorToHit.terms));
assert.equal(model.hitProb.surface.rate.length, model.hitProb.surface.nEv * model.hitProb.surface.nLa);
assert.ok(model.pending.table.R.n > 0);
assert.ok(model.errorToHit.cv && model.errorToHit.cv.folds === 10);

const watch = read('model/error-watch-2026.json');
assert.ok(watch.plays.length > 0);
assert.ok(watch.plays.some((p) => p.status === 'changed_to_hit'), 'changed plays appear with final status');
assert.ok(watch.plays.every((p) => p.score == null || (p.score >= 0 && p.score <= 100)));
assert.ok(report.savant.matched > 0, 'savant cross-check matched rows');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`pipeline-offline-smoke: OK (2026: ${official.entries.length} entries, ${e2h.length} error→hit; watch ${watch.plays.length} plays; errorToHit terms=${JSON.stringify(model.errorToHit.terms)})`);
