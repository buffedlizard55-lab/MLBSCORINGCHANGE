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
function runPipeline(extraEnv = {}, extraArgs = [], expectFailure = false) {
  const r = spawnSync(process.execPath, ['--require', path.join(ROOT, 'tools/fixtures/pipeline-fetch-stub.cjs'), path.join(ROOT, 'pipeline/run.mjs'), ...extraArgs], {
    cwd: ROOT, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 180000,
  });
  if (expectFailure) {
    assert.notEqual(r.status, 0, 'pipeline must exit non-zero on a fatal error');
    return r;
  }
  if (r.status !== 0) {
    console.error(r.stdout);
    console.error(r.stderr);
    throw new Error(`pipeline exited with ${r.status}`);
  }
  return r;
}
// A SYNTHETIC live-capture ledger (as pipeline/capture.mjs writes it) that
// points at real plays of the stub's synthetic world: three errors captured
// 5 minutes after the play, and one resolved pending ruling.
const { createRequire } = await import('node:module');
createRequire(import.meta.url)(path.join(ROOT, 'tools/fixtures/pipeline-fetch-stub.cjs'));
const capEntries = [];
for (let i = 0; i < 24 && capEntries.length < 4; i += 1) {
  const pk = 2026 * 1000 + i;
  const pbp = await (await fetch(`https://statsapi.mlb.com/api/v1/game/${pk}/playByPlay`)).json();
  const sched = await (await fetch('https://statsapi.mlb.com/api/v1/schedule?sportId=1&season=2026&gameType=R')).json();
  const date = sched.dates.flatMap((d) => d.games).find((g) => g.gamePk === pk).officialDate;
  for (const p of pbp.allPlays) {
    const want = capEntries.filter((e) => e.why[0] === 'error').length < 3 ? 'field_error' : 'single';
    if (p.result.eventType !== want || capEntries.some((e) => e.g === pk)) continue;
    const st = (min, extra) => ({ at: `${date}T23:${String(min).padStart(2, '0')}:00.000Z`, et: p.result.eventType, ev: p.result.event, desc: p.result.description, kind: want === 'field_error' ? 'fielding' : null, pos: want === 'field_error' ? 'SS' : null, pend: null, gs: 'Live', ...extra });
    const pend = { codes: ['os_ruling_pending_prior'], onAi: p.about.atBatIndex + 1, atResult: false, marker: { eventType: 'os_ruling_pending_prior', event: null, description: 'Official Scorer Ruling Pending', type: 'action' } };
    capEntries.push({
      id: `${pk}:${p.about.atBatIndex}`, g: pk, ai: p.about.atBatIndex, date, gt: 'R', season: 2026, awayId: null, homeId: null,
      end: `${date}T23:05:00.000Z`, hd: null, br: 1,
      why: [want === 'field_error' ? 'error' : 'pending'],
      states: want === 'field_error' ? [st(10)] : [st(10, { pend }), st(14)],
      score: null,
    });
    break;
  }
}
assert.equal(capEntries.length, 4, 'synthetic capture fixture built');
fs.mkdirSync(path.join(tmp, 'data', 'capture'), { recursive: true });
const { serializeMonth } = await import('../pipeline/lib/capture-lib.mjs');
for (const month of new Set(capEntries.map((e) => e.date.slice(0, 7)))) {
  fs.writeFileSync(path.join(tmp, 'data', 'capture', `rulings-${month}.json`), serializeMonth(month, capEntries.filter((e) => e.date.startsWith(month)), '2026-09-24T00:00:00.000Z'));
}

runPipeline({}, ['--seasons=2024,2025,2026']);
const read = (rel) => JSON.parse(fs.readFileSync(path.join(tmp, 'data', rel), 'utf8'));
{
  // Live-capture join, scorer tests and error-type evidence (v2).
  const rep = read('model/pipeline-report.json');
  const mdl = read('model/scoring-model.json');
  assert.equal(rep.capture.errorsCaptured, 3, 'captured errors joined');
  assert.equal(rep.capture.capturedAsOriginal, 3, 'captured 5 min after the play = original call');
  assert.equal(rep.capture.settled, 3);
  assert.equal(rep.capture.pendingCaptured, 1);
  assert.equal(rep.capture.pendingResolved, 1);
  assert.equal(mdl.capture.pending[0].resolvedEt, 'single');
  assert.equal(mdl.errorToHit.adjust.status, 'collecting', 'adjustment waits for enough captured changes');
  assert.equal(mdl.errorToHit.adjust.n, 3);
  assert.equal(mdl.pending.calibration.status, 'collecting');
  assert.equal(mdl.pending.calibration.resolved, 1);
  for (const q of ['errorToHit', 'hitToError']) {
    for (const g of ['scorer', 'homeClub']) {
      const t = mdl.effects[q][g].test;
      assert.ok(t.groups >= 2 && t.pValue > 0 && t.pValue <= 1, `${q} ${g} test ran`);
      assert.ok(typeof mdl.effects[q][g].verdict === 'string');
    }
  }
  assert.ok(rep.seasons[2026].meta.withScorer === 24, 'official scorer looked up for every game');
  assert.ok(mdl.errorToHit.errorKind && mdl.errorToHit.errorKind.stoodByKind.fielding > 0);
  const w = read('model/error-watch.json');
  const capIds = new Set(capEntries.filter((e) => e.why[0] === 'error').map((e) => e.id));
  const rows = w.plays.filter((p2) => capIds.has(p2.id));
  assert.equal(rows.length, 3, 'captured errors appear on the Error Watch');
  assert.ok(rows.every((r) => r.captured && r.errKindSource === 'captured' && r.errKind === 'fielding'));
  assert.ok(w.plays.some((p2) => p2.errKindSource === 'current_ruling'), 'other standing errors show their current error type');
}

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

const watch = read('model/error-watch.json');
assert.ok(watch.plays.length > 0);
assert.ok(watch.plays.some((p) => p.status === 'changed_to_hit'), 'changed plays appear with final status');
assert.ok(watch.plays.every((p) => p.score == null || (p.score >= 0 && p.score <= 100)));
assert.ok(report.savant.matched > 0, 'savant cross-check matched rows');

// Run 2: archive captures are immutable — reused from the stored parse,
// never re-fetched from the Internet Archive.
const reqLog = path.join(tmp, 'requests.txt');
runPipeline({ STUB_REQUEST_LOG: reqLog }, ['--seasons=2024,2025,2026']);
const requested = fs.readFileSync(reqLog, 'utf8');
assert.ok(!requested.includes('web.archive.org'), 'second run makes no Internet Archive requests');
const report2 = read('model/pipeline-report.json');
assert.equal(report2.logs[2024].source, 'stored');
assert.equal(report2.logs[2026].source, 'live');
assert.equal(read('official/scoring-changes-2024.json').entries.length, read('official/scoring-changes-2024.json').entries.filter((e) => e.cls).length);

// Run 3: season rollover — the live page lists only "2027 Regular Season"
// (no entries yet). 2026 must come from the stored copy, with no warning.
runPipeline({ STUB_LIVE_SEASON: '2027' }, ['--seasons=2024,2025,2026']);
const report3 = read('model/pipeline-report.json');
assert.equal(report3.logs[2026].source, 'stored', '2026 served from the stored copy');
assert.equal(report3.currentSeason, 2026);
assert.ok(!report3.warnings.some((w) => /no season header/.test(w)), 'an empty new-season list is not a structure warning');
assert.equal(read('official/scoring-changes-2026.json').entries.length, official.entries.length, 'no 2026 entries lost');

// Run 4: StatsAPI fails → non-zero exit; the last good report is kept (the
// site keeps its summary) with the failure on top; data files untouched.
const modelBefore = fs.readFileSync(path.join(tmp, 'data', 'model/scoring-model.json'), 'utf8');
runPipeline({ STUB_FAIL_TEAMS: '1' }, ['--seasons=2024,2025,2026'], true);
const report4 = read('model/pipeline-report.json');
assert.ok(report4.fatal, 'failure recorded');
assert.ok(report4.failedAt);
assert.equal(report4.seasons['2026'].completed, 24, 'last good season data kept');
assert.equal(fs.readFileSync(path.join(tmp, 'data', 'model/scoring-model.json'), 'utf8'), modelBefore, 'model untouched by a failed run');
// Run 5: a second consecutive failure still keeps the good data.
runPipeline({ STUB_FAIL_TEAMS: '1' }, ['--seasons=2024,2025,2026'], true);
assert.equal(read('model/pipeline-report.json').seasons['2026'].completed, 24);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`pipeline-offline-smoke: OK (2026: ${official.entries.length} entries, ${e2h.length} error→hit; watch ${watch.plays.length} plays; errorToHit terms=${JSON.stringify(model.errorToHit.terms)})`);
