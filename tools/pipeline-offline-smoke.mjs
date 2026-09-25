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
  const r = spawnSync(process.execPath, ['--require', path.join(ROOT, 'tools/fixtures/pipeline-fetch-stub.cjs'), path.join(ROOT, 'pipeline/run.mjs'), '--savant-delay-ms=1', ...extraArgs], {
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
// 5 minutes after the play, one resolved pending ruling, and one error whose
// ruling was seen being made after a pending marker (45 minutes later).
const { createRequire } = await import('node:module');
createRequire(import.meta.url)(path.join(ROOT, 'tools/fixtures/pipeline-fetch-stub.cjs'));
const capEntries = [];
for (let i = 0; i < 24 && capEntries.length < 5; i += 1) {
  const pk = 2026 * 1000 + i;
  const pbp = await (await fetch(`https://statsapi.mlb.com/api/v1/game/${pk}/playByPlay`)).json();
  const sched = await (await fetch('https://statsapi.mlb.com/api/v1/schedule?sportId=1&season=2026&gameType=R')).json();
  const date = sched.dates.flatMap((d) => d.games).find((g) => g.gamePk === pk).officialDate;
  for (const p of pbp.allPlays) {
    const nErr = capEntries.filter((e) => e.why[0] === 'error').length;
    const nPend = capEntries.filter((e) => e.why[0] === 'pending').length;
    const want = nErr < 3 ? 'field_error' : nPend < 1 ? 'single' : 'field_error';
    const afterPending = nErr >= 3 && nPend >= 1;
    if (p.result.eventType !== want || capEntries.some((e) => e.g === pk)) continue;
    const st = (min, extra) => ({ at: `${date}T23:${String(min).padStart(2, '0')}:00.000Z`, et: p.result.eventType, ev: p.result.event, desc: p.result.description, kind: want === 'field_error' ? 'fielding' : null, pos: want === 'field_error' ? 'SS' : null, pend: null, gs: 'Live', ...extra });
    const pend = { codes: ['os_ruling_pending_prior'], onAi: p.about.atBatIndex + 1, atResult: false, marker: { eventType: 'os_ruling_pending_prior', event: null, description: 'Official Scorer Ruling Pending', type: 'action' } };
    capEntries.push({
      id: `${pk}:${p.about.atBatIndex}`, g: pk, ai: p.about.atBatIndex, date, gt: 'R', season: 2026, awayId: null, homeId: null,
      end: `${date}T23:05:00.000Z`, hd: null, br: 1,
      why: afterPending ? ['pending', 'error'] : [want === 'field_error' ? 'error' : 'pending'],
      states: afterPending
        ? [st(8, { et: 'os_ruling_pending_primary', ev: 'Official Scorer Ruling Pending', kind: null, pos: null, pend: { ...pend, codes: ['os_ruling_pending_primary'], onAi: p.about.atBatIndex, atResult: true } }), st(50)]
        : want === 'field_error' ? [st(10)] : [st(10, { pend }), st(14)],
      score: null,
    });
    break;
  }
}
assert.equal(capEntries.length, 5, 'synthetic capture fixture built');
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
  assert.equal(rep.capture.errorsCaptured, 4, 'captured errors joined (incl. one ruled after a pending marker)');
  assert.equal(rep.capture.capturedAsOriginal, 4, 'within 30 min, or seen being made after a pending marker = original call');
  assert.equal(rep.capture.settled, 4);
  assert.equal(rep.capture.pendingCaptured, 2);
  assert.equal(rep.capture.pendingResolved, 2);
  assert.ok(mdl.capture.pending.some((x) => x.resolvedEt === 'single' && x.resolvedSource === 'live capture'));
  assert.ok(mdl.capture.pending.some((x) => x.resolvedEt === 'field_error' && x.codes[0] === 'os_ruling_pending_primary'));
  assert.ok(mdl.capture.recentErrors.some((x) => x.afterPending && x.lagMin === 45), 'error ruled 45 min after the play, after a pending marker');
  assert.equal(mdl.errorToHit.adjust.status, 'collecting', 'adjustment waits for enough captured changes');
  assert.equal(mdl.errorToHit.adjust.n, 4);
  assert.equal(mdl.pending.calibration.status, 'collecting');
  assert.equal(mdl.pending.calibration.resolved, 2);
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
  const capIds = new Set(capEntries.filter((e) => e.why.includes('error')).map((e) => e.id));
  const rows = w.plays.filter((p2) => capIds.has(p2.id));
  assert.equal(rows.length, 4, 'captured errors appear on the Error Watch');
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
assert.equal(report.savant.fetchedThisRun, true, 'the cross-check ran on this run\'s fetch of the season error list');

// Session 5: the game-by-game error scan. Every completed game is listed
// with its scan coverage; every error credit of every play is an event;
// Error Watch rows (batter reached on error) are all among them, with the
// same status/score and the Savant video link built from the play's playId.
{
  const ee = read('model/error-events-2026.json');
  assert.equal(ee.season, 2026);
  assert.equal(ee.games.length, report.seasons['2026'].completed, 'every completed game is listed');
  assert.ok(ee.games.every((g) => g.scanned && g.pas > 0), 'every game scanned play by play');
  assert.equal(report.errorEvents['2026'].events, ee.events.length);
  assert.ok(ee.events.length > 0);
  const byId = new Map(ee.events.map((ev) => [ev.id, ev]));
  const watch26 = watch.plays.filter((p) => p.season === 2026);
  for (const w of watch26) {
    const ev = byId.get(w.id);
    assert.ok(ev, `watch play ${w.id} is in the error-events log`);
    assert.equal(ev.status, w.status === 'changed_to_hit' ? 'changed_to_hit' : ev.status);
    if (w.score != null) assert.equal(ev.model && ev.model.score, w.score, 'same /100 score as Error Watch');
    assert.equal(ev.scope, 'batter_reached');
  }
  // A play since changed to a hit no longer carries the credit in StatsAPI;
  // it is still logged (from the model population) with its final status.
  assert.ok(ee.events.every((ev) => ev.errors.length > 0 || ev.status === 'changed_to_hit' || ev.status === 'changed_other'), 'every standing event carries its error credits');
  assert.ok(ee.events.some((ev) => ev.status === 'changed_to_hit' && ev.errors.length === 0), 'changed plays are kept in the historical log');
  assert.ok(ee.events.filter((ev) => ev.eventType === 'field_error').every((ev) => ev.errors.some((x) => x.onBatter && x.kind === 'fielding')), 'batter-reached credit parsed');
  const withVid = ee.events.filter((ev) => ev.vid);
  assert.ok(withVid.length > 0 && withVid.every((ev) => /^syn-\d+-\d+$/.test(ev.vid) && ev.vid === `syn-${ev.gamePk}-${ev.ai}`), 'video id is the play\'s own playId');
  assert.ok(watch.plays.some((p) => p.vid), 'Error Watch rows carry the playId too');
}

// Per-play Savant xBA (session 4, item 3): the pipeline attaches true
// estimated_ba_using_speedangle values to the plays the site can surface —
// linked official entries and Error Watch rows. Requests are budgeted (4 per
// run by default), cached, and coverage accumulates across runs without ever
// inventing a value for a play Savant has not answered for.
{
  const pp = report.savant.perPlay;
  assert.ok(pp && pp.needed > 0, 'per-play xBA pass ran');
  assert.equal(pp.requests, 4, 'Savant budget respected (4 requests in the first run)');
  assert.ok(pp.matched > 0, 'plays on the season error list got their xBA in run 1');
  assert.ok(pp.pending > 0, 'month windows are filled in lazily, not in one run');
  assert.equal(pp.coverage, Math.round((pp.matched / pp.needed) * 1e4) / 1e4);
  assert.equal(pp.failures.length, 0, `no Savant failures (${JSON.stringify(pp.failures)})`);
  assert.ok(pp.queries.some((q) => q.kind === 'month' && q.integrity && q.integrity.kept > 0), 'a date-range window was used');
  assert.ok(pp.queries.every((q) => q.kind !== 'month' || q.integrity.outsideRange === 0), 'date-range responses are self-checked against the requested dates');
  const watch0 = read('model/error-watch.json').plays;
  const withXba = watch0.filter((p2) => p2.savant);
  assert.ok(withXba.length > 0, 'Error Watch rows carry Savant xBA');
  assert.ok(withXba.every((p2) => p2.savant.xba == null || (p2.savant.xba >= 0 && p2.savant.xba <= 1)), 'xBA is a probability');
  // Neither invented nor approximated: the number equals what Savant served
  // for that exact gamePk:atBatIndex.
  {
    // Plays still ruled errors come from the season error list; plays changed
    // to a hit only appear in a date-range query. Both sources are checked.
    const { parseSavantRows, seasonErrorsUrl, dateRangeUrl } = await import('../pipeline/lib/savant.mjs');
    const served = new Map([
      ...parseSavantRows(await (await fetch(seasonErrorsUrl(2026))).text()),
      ...parseSavantRows(await (await fetch(dateRangeUrl('2026-04-01', '2026-07-31'))).text()),
    ].map((r) => [`${r.gamePk}:${r.ai}`, r]));
    assert.ok(withXba.every((p2) => served.has(p2.id) && served.get(p2.id).xba === p2.savant.xba), 'xBA equals the value Savant served for that play');
    assert.ok(withXba.every((p2) => p2.savant.ls == null || served.get(p2.id).ls === p2.savant.ls), 'the EV Savant saw is carried with the xBA');
  }
  const entries0 = read('official/scoring-changes-2026.json').entries.filter((e) => e.savant);
  assert.ok(entries0.length > 0, 'linked official entries carry Savant xBA');
  assert.ok(entries0.every((e) => e.savant.xba == null || Number.isFinite(e.savant.ls)), 'the EV/LA Savant saw for the ball is kept with it');
}

// Run 2 also checks the cache: the season error list stays inside its TTL, and
// the remaining month windows keep filling in.
const pp1 = report.savant.perPlay;
const reportRun2 = (() => { const before = fs.readFileSync(path.join(tmp, 'data', 'model/pipeline-report.json'), 'utf8'); return JSON.parse(before); })();

// Date recovery (session 4): two SYNTHETIC mis-dated 2026 entries about the
// same unique play — one 3 months out (nothing within ±10 days: the
// season-wide pass), one inside a game window where the pairing played but the
// named batter did not (the batter-check pass). Both must link, stay flagged,
// and come out with a model score, exactly like the real 2026 #140/#173.
{
  const rec = report.seasons[2026].dateRecoveries || [];
  assert.equal(rec.length, 2, `both mis-dated entries recovered (${JSON.stringify(rec)})`);
  assert.ok(rec.every((x) => x.verifiedBy === 'batter + ruling'), 'recovered only on the batter + ruling check');
  assert.ok(rec.every((x) => x.kind === 'month'), 'both are same-day-of-month month typos');
  assert.ok(rec.every((x) => x.decidedBy === 'only game verified'),
    `each recovery reports what decided it (${JSON.stringify(rec.map((x) => x.decidedBy))})`);
  assert.ok(rec.every((x) => x.gameDate === '2026-05-05'), 'both point at the game actually played');
  const seqs = new Set(rec.map((x) => x.seq));
  const recEntries = official.entries.filter((e) => seqs.has(e.seq));
  assert.equal(recEntries.length, 2);
  for (const e of recEntries) {
    assert.ok(e.link.flags.some((f) => /^date_recovered:/.test(f)), `date_recovered flag on #${e.seq}`);
    assert.ok(e.link.flags.includes('date_typo:month'), `date_typo:month on #${e.seq}`);
    assert.ok(!e.link.flags.includes('no_game_found'), `#${e.seq} is no longer unlinked`);
    assert.ok(e.cls.flags.includes('hitToError'), `#${e.seq} is a hit → error change`);
    assert.ok(e.model && Number.isInteger(e.model.score), `model score on recovered #${e.seq}`);
    assert.equal(e.model.question, 'hitToError');
  }
  // The recovered plays also make it into the training labels now.
  assert.ok(model.hitToError.n > 0);
  assert.ok(report.seasons[2026].linkFlags.date_recovered >= 2, 'recoveries are counted in the report');
  assert.equal(report.seasons[2026].unlinkedHitToError, 0,
    'after the recovery pass no 2026 hit → error entry is left without a play');
  // A wrong date in MLB's own log is an irregularity: the recovered entries are
  // listed for manual review even though their text parsed cleanly.
  const irr = read('official/irregularities.json');
  const recIrr = irr.items.filter((x) => x.season === 2026
    && (x.linkFlags || []).some((f) => /^date_recover/.test(f)));
  const recSeqs = new Set(recIrr.map((x) => x.seq));
  assert.ok([...seqs].every((s) => recSeqs.has(s)),
    `both recovered entries are listed as irregularities (got seqs ${[...recSeqs].join(',')})`);
  assert.ok(recIrr.filter((x) => seqs.has(x.seq)).every((x) => x.gamePk && x.atBatIndex != null),
    'a review entry names the play the entry was linked to');
  assert.ok(recIrr.some((x) => (x.linkFlags || []).some((f) => /^date_recovery_/.test(f))),
    'a stated date that could NOT be verified is listed too — never silently dropped');
}

// Run 2: archive captures are immutable — reused from the stored parse,
// never re-fetched from the Internet Archive.
const reqLog = path.join(tmp, 'requests.txt');
runPipeline({ STUB_REQUEST_LOG: reqLog }, ['--seasons=2024,2025,2026']);
const requested = fs.readFileSync(reqLog, 'utf8');
assert.ok(!requested.includes('web.archive.org'), 'second run makes no Internet Archive requests');
const report2 = read('model/pipeline-report.json');
assert.equal(report2.logs[2024].source, 'stored');
assert.equal(report2.savant.fetchedThisRun, false, 'the season error list came from the cache inside its TTL');
assert.ok(report2.savant.perPlay.requests === 4, 'run 2 spends its budget on the months still missing');
assert.ok(report2.savant.perPlay.matched > pp1.matched, `coverage grows across runs (${pp1.matched} → ${report2.savant.perPlay.matched})`);
assert.ok(report2.savant.perPlay.pending < pp1.pending, 'fewer plays left pending');
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
