'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeStatus, formatTime, describePaths, progress, etaSeconds } = require('../../lib/site-status');

// 2026-09-30 23:12 UTC is 4:12 PM in San Marcos (PDT).
const NOW = '2026-09-30T23:12:00Z';
const TZ = 'America/Los_Angeles';
const MAIN = '3f2a1c9' + '0'.repeat(33);
const OLD = '1a2b3c4' + '0'.repeat(33);
const PREVIEW = '9e8d7c6' + '0'.repeat(33);
const URLS = { production: 'https://donatelli.tech', preview: 'https://admin-preview.donatelli-services.pages.dev' };
const TITLES = { 'owner.jobTitle': 'Job title', tagline: 'Tagline', contactEmail: 'Public email', year: 'Copyright year', 'card.showQr': 'Show the QR code' };

// The job and step names of the website's site.yml (spec §5.4), with GitHub's own set-up and post steps.
const VERIFY_STEPS = ['Set up job', 'Checkout', 'Set up Node', 'Commit subject', 'Install', 'Test', 'Build site', 'QA checks', 'Upload bundle', 'Post Set up Node', 'Post Checkout', 'Complete job'];
const DEPLOY_STEPS = ['Set up job', 'Download bundle', 'Check bundle shape', 'Set up Node', 'Install wrangler', 'Deploy to Cloudflare', 'Verify live', 'Summary', 'Complete job'];

// Jobs as GitHub reports them with the run at `at` (in progress), finished, failed at a step, or
// with the deploy job skipped.
function jobs({ at = null, failAt = null, cancelAt = null, deploySkipped = false } = {}) {
  const all = [...VERIFY_STEPS.map((name) => ['Build and QA', name]), ...DEPLOY_STEPS.map((name) => ['Deploy', name])];
  const stopName = at || failAt || cancelAt;
  const stop = stopName ? all.findIndex(([job, name]) => name === stopName && (job === 'Build and QA' ? VERIFY_STEPS.includes(name) : true)) : all.length;
  const stepsOf = (jobName) => all
    .map(([job, name], i) => ({ job, name, i }))
    .filter((s) => s.job === jobName)
    .map((s, n) => {
      let status = 'completed';
      let conclusion = 'success';
      if (s.i === stop && at) { status = 'in_progress'; conclusion = null; }
      else if (s.i === stop && failAt) conclusion = 'failure';
      else if (s.i === stop && cancelAt) conclusion = 'cancelled';
      else if (s.i > stop) {
        status = at ? 'queued' : 'completed';
        conclusion = at ? null : 'skipped';
      }
      return { name: s.name, status, conclusion, number: n + 1 };
    });
  const job = (name) => {
    const steps = stepsOf(name);
    const open = steps.some((s) => s.status !== 'completed');
    const started = steps.some((s) => s.status !== 'queued');
    const bad = steps.find((s) => s.conclusion === 'failure' || s.conclusion === 'cancelled');
    return {
      name,
      status: open ? (started ? 'in_progress' : 'queued') : 'completed',
      conclusion: open ? null : bad ? bad.conclusion : steps.every((s) => s.conclusion === 'skipped') ? 'skipped' : 'success',
      steps,
    };
  };
  const verify = job('Build and QA');
  const deploy = deploySkipped ? { name: 'Deploy', status: 'completed', conclusion: 'skipped', steps: [] } : job('Deploy');
  return [verify, deploy];
}

let nextId = 100;
function run(headSha, { status = 'completed', conclusion = 'success', branch = 'main', event = 'push', createdAt = '2026-09-30T23:10:00Z', startedAt, updatedAt = '2026-09-30T23:12:00Z', id = nextId++ } = {}) {
  return {
    id, branch, headSha, event, status, conclusion: status === 'completed' ? conclusion : null,
    htmlUrl: `https://github.com/Njdonatelli/donatelli-website/actions/runs/${id}`,
    createdAt, updatedAt, runStartedAt: startedAt || createdAt,
  };
}

// Five earlier green runs lasting 90, 95, 100, 110 and 120 seconds: a median of 100.
const HISTORY = [90, 95, 100, 110, 120].map((secs, i) => {
  const start = Date.parse('2026-09-29T18:00:00Z') + i * 3600 * 1000;
  return run(OLD, { createdAt: new Date(start).toISOString(), updatedAt: new Date(start + secs * 1000).toISOString() });
});

const LIVE_OLD = { commit: OLD, builtAt: '2026-09-30T21:04:00Z', source: 'ci' };
const LIVE_MAIN = { commit: MAIN, builtAt: '2026-09-30T23:11:00Z', source: 'ci' };

function status(over = {}) {
  return computeStatus({
    mainSha: MAIN,
    mainCommittedAt: '2026-09-30T23:05:00Z',
    previewHead: null,
    previewParent: null,
    previewCommittedAt: null,
    mainRuns: [],
    previewRuns: [],
    jobsByRunId: {},
    buildJson: LIVE_MAIN,
    previewBuildJson: null,
    now: NOW,
    timeZone: TZ,
    titlesByPath: TITLES,
    lastChangePaths: ['owner.jobTitle'],
    publishedAt: null,
    urls: URLS,
    ...over,
  });
}

test('off: no token on the server', () => {
  const s = computeStatus({ configured: false, now: NOW });
  assert.equal(s.state, 'off');
  assert.equal(s.headline, 'Publishing is off: SITE_GITHUB_TOKEN is not set on the admin server.');
  assert.equal(s.configured, false);
  assert.equal(s.checkedAt, '2026-09-30T23:12:00.000Z');
});

test('live: the main run is green and build.json shows main', () => {
  const r = run(MAIN);
  const s = status({ mainRuns: [r], jobsByRunId: { [r.id]: jobs() } });
  assert.equal(s.state, 'live');
  assert.equal(s.headline, 'Live since 4:12 PM. Last change: job title.');
  assert.equal(s.step, null);
  assert.equal(s.etaSeconds, null);
  assert.deepEqual(s.production, { mainSha: MAIN, liveSha: MAIN, liveBuiltAt: LIVE_MAIN.builtAt, liveSource: 'ci', run: r, url: URLS.production });
  assert.equal(s.preview.publishable, false);
  assert.equal(s.preview.url, URLS.preview);
  assert.equal(s.checkedAt, '2026-09-30T23:12:00.000Z');
});

test('live: the change list names fields by their titles', () => {
  const r = run(MAIN);
  const headline = (paths) => status({ mainRuns: [r], lastChangePaths: paths }).headline;
  assert.equal(headline(['owner.jobTitle', 'tagline']), 'Live since 4:12 PM. Last change: job title and tagline.');
  assert.equal(headline(['owner.jobTitle', 'tagline', 'year']), 'Live since 4:12 PM. Last change: job title, tagline and copyright year.');
  assert.equal(headline(['owner.jobTitle', 'tagline', 'year', 'contactEmail']), 'Live since 4:12 PM. Last change: job title, tagline and 2 more.');
  assert.equal(headline(['card.showQr']), 'Live since 4:12 PM. Last change: show the QR code.');
  assert.equal(headline(['owner.unknownField']), 'Live since 4:12 PM. Last change: owner.unknownField.');
  assert.equal(headline(null), 'Live since 4:12 PM. Commit 3f2a1c9.');
});

test('live: a run from another day carries its date', () => {
  const r = run(MAIN, { createdAt: '2026-09-28T23:10:00Z', updatedAt: '2026-09-28T23:12:00Z' });
  assert.equal(status({ mainRuns: [r] }).headline, 'Live since Sep 28, 4:12 PM. Last change: job title.');
});

test('live: build.json already shows main even when the runs list has no run for it', () => {
  const s = status({ mainRuns: HISTORY });
  assert.equal(s.state, 'live');
  assert.equal(s.headline, 'Live since 4:11 PM. Last change: job title.');
});

test('publishing: step and ETA from the running job', () => {
  const r = run(MAIN, { status: 'in_progress', createdAt: '2026-09-30T23:11:10Z' });
  const s = status({ mainRuns: [r, ...HISTORY], jobsByRunId: { [r.id]: jobs({ at: 'QA checks' }) }, buildJson: LIVE_OLD });
  assert.equal(s.state, 'publishing');
  assert.equal(s.headline, 'Publishing. Step 2 of 4: QA. About 1 min left.');
  assert.deepEqual(s.step, { index: 2, count: 4, name: 'QA' });
  assert.equal(s.etaSeconds, 50);
  assert.equal(s.production.run, r);
});

test('publishing: longer waits round up to whole minutes; no history means no ETA', () => {
  const r = run(MAIN, { status: 'queued', createdAt: '2026-09-30T23:12:00Z' });
  const slow = HISTORY.map((h) => ({ ...h, updatedAt: new Date(Date.parse(h.runStartedAt) + 150 * 1000).toISOString() }));
  const s = status({ mainRuns: [r, ...slow], jobsByRunId: { [r.id]: [] }, buildJson: LIVE_OLD });
  assert.equal(s.headline, 'Publishing. Step 1 of 4: Build. About 3 min left.');
  assert.equal(s.etaSeconds, 150);
  const bare = status({ mainRuns: [r], buildJson: LIVE_OLD });
  assert.equal(bare.headline, 'Publishing. Step 1 of 4: Build.');
  assert.equal(bare.etaSeconds, null);
});

test('publishing: for a minute after the admin moved main, a missing run means waiting', () => {
  const s = status({ mainRuns: HISTORY, buildJson: LIVE_OLD, publishedAt: '2026-09-30T23:11:20Z' });
  assert.equal(s.state, 'publishing');
  assert.equal(s.headline, 'Publishing. Waiting for GitHub to start the run.');
  assert.deepEqual(s.step, { index: 1, count: 4, name: 'Build' });
});

test('stalled: a minute after the publish there is still no run', () => {
  const s = status({ mainRuns: HISTORY, buildJson: LIVE_OLD, publishedAt: '2026-09-30T23:10:00Z' });
  assert.equal(s.state, 'stalled');
  assert.equal(s.headline, 'Published to main at 4:10 PM, but no deploy started. Start the deploy.');
});

test('failed: each failing step has its own wording and next action', () => {
  const cases = [
    ['Test', 'the tests failed', 'Open the log, fix the field, and publish again.'],
    ['Build site', 'the build failed', 'Open the log, fix the field, and publish again.'],
    ['QA checks', 'the QA check failed', 'Open the log, fix the field, and publish again.'],
    ['Install', 'the "Install" step failed', 'Open the log, fix the field, and publish again.'],
    ['Deploy to Cloudflare', 'the Cloudflare deploy failed', 'Open the log, then redeploy.'],
    ['Verify live', 'the live check failed', 'Open the log, then redeploy.'],
  ];
  for (const [step, wording, next] of cases) {
    const r = run(MAIN, { conclusion: 'failure' });
    const s = status({ mainRuns: [r], jobsByRunId: { [r.id]: jobs({ failAt: step }) }, buildJson: LIVE_OLD });
    assert.equal(s.state, 'failed', step);
    assert.equal(s.headline, `Not published: ${wording}. donatelli.tech still shows the 2:04 PM version. ${next}`);
    assert.equal(s.detail, `The "${step}" step failed.`);
  }
});

test('failed: the spec example, word for word', () => {
  const r = run(MAIN, { conclusion: 'failure' });
  const s = status({ mainRuns: [r], jobsByRunId: { [r.id]: jobs({ failAt: 'QA checks' }) }, buildJson: LIVE_OLD });
  assert.equal(s.headline, 'Not published: the QA check failed. donatelli.tech still shows the 2:04 PM version. Open the log, fix the field, and publish again.');
});

test('failed: a cancelled run, and a failure with no jobs or no live build.json', () => {
  const cancelled = run(MAIN, { conclusion: 'cancelled' });
  assert.equal(status({ mainRuns: [cancelled], jobsByRunId: { [cancelled.id]: jobs({ cancelAt: 'Install' }) }, buildJson: LIVE_OLD }).headline,
    'Not published: the run was cancelled. donatelli.tech still shows the 2:04 PM version. Redeploy to start it again.');
  const bare = run(MAIN, { conclusion: 'failure' });
  const s = status({ mainRuns: [bare], buildJson: null });
  assert.equal(s.state, 'failed');
  assert.equal(s.headline, 'Not published: the run failed. donatelli.tech still shows the previous version. Open the log, then redeploy.');
  assert.equal(s.detail, null);
});

test('deploys_off: the run is green but GitHub skipped the deploy job', () => {
  const r = run(MAIN);
  const s = status({ mainRuns: [r], jobsByRunId: { [r.id]: jobs({ deploySkipped: true }) }, buildJson: LIVE_OLD });
  assert.equal(s.state, 'deploys_off');
  assert.equal(s.headline, 'Not published: deploys are off in GitHub. Add the Cloudflare secrets, then set PAGES_DEPLOY_ENABLED to true.');
  assert.equal(status({ mainRuns: [r], deploysSkipped: true, buildJson: LIVE_OLD }).state, 'deploys_off', 'the caller may also say so');
});

test('rolled_back: production serves an older CI deployment than main', () => {
  const r = run(MAIN);
  const s = status({ mainRuns: [r], jobsByRunId: { [r.id]: jobs() }, buildJson: LIVE_OLD });
  assert.equal(s.state, 'rolled_back');
  assert.equal(s.headline, 'Live: an older deployment (commit 1a2b3c4) after a rollback. main holds 3f2a1c9.');
  assert.equal(s.production.liveSha, OLD);
});

test('laptop deploy: build.json says local', () => {
  const r = run(MAIN);
  const s = status({ mainRuns: [r], buildJson: { commit: OLD, builtAt: '2026-09-30T22:58:00Z', source: 'local' } });
  assert.equal(s.state, 'live');
  assert.equal(s.headline, 'Live: a laptop deploy from 3:58 PM (commit 1a2b3c4), not the latest main.');
  assert.equal(status({ mainRuns: [r], buildJson: { ...LIVE_MAIN, source: 'local' } }).headline, 'Live since 4:12 PM. Last change: job title.',
    'a laptop deploy of main itself is simply live');
});

test('unknown: build.json did not answer', () => {
  const r = run(MAIN);
  const s = status({ mainRuns: [r], buildJson: null });
  assert.equal(s.state, 'unknown');
  assert.equal(s.headline, 'Deployed at 4:12 PM, but donatelli.tech/build.json did not answer. Open donatelli.tech to check it.');
  const none = status({ mainRuns: [], buildJson: null });
  assert.equal(none.state, 'unknown');
  assert.equal(none.headline, 'The live version is unknown: donatelli.tech/build.json did not answer. Open donatelli.tech to check it.');
});

const previewOver = (previewRun, extra = {}) => ({
  previewHead: PREVIEW,
  previewParent: MAIN,
  previewCommittedAt: '2026-09-30T23:08:00Z',
  mainRuns: [run(MAIN)],
  previewRuns: previewRun ? [previewRun, ...HISTORY.map((h) => ({ ...h, branch: 'admin-preview' }))] : [],
  ...extra,
});

test('preview_building: the step follows the preview run', () => {
  const table = [
    ['Set up job', { index: 1, count: 4, name: 'Build' }],
    ['Checkout', { index: 1, count: 4, name: 'Build' }],
    ['Build site', { index: 1, count: 4, name: 'Build' }],
    ['QA checks', { index: 2, count: 4, name: 'QA' }],
    ['Upload bundle', { index: 2, count: 4, name: 'QA' }],
    ['Download bundle', { index: 3, count: 4, name: 'Deploy' }],
    ['Deploy to Cloudflare', { index: 3, count: 4, name: 'Deploy' }],
    ['Verify live', { index: 4, count: 4, name: 'Live' }],
    ['Summary', { index: 4, count: 4, name: 'Live' }],
  ];
  for (const [at, want] of table) {
    const pr = run(PREVIEW, { status: 'in_progress', branch: 'admin-preview', createdAt: '2026-09-30T23:11:00Z' });
    const s = status({ ...previewOver(pr), jobsByRunId: { [pr.id]: jobs({ at }) } });
    assert.equal(s.state, 'preview_building', at);
    assert.deepEqual(s.step, want, at);
    assert.equal(s.headline, `Building preview. Step ${want.index} of 4: ${want.name}.`);
    assert.equal(s.preview.publishable, false);
  }
});

test('preview_building: the spec example, and before GitHub lists the run', () => {
  const pr = run(PREVIEW, { status: 'queued', branch: 'admin-preview', createdAt: '2026-09-30T23:11:50Z' });
  assert.equal(status({ ...previewOver(pr), jobsByRunId: { [pr.id]: [] } }).headline, 'Building preview. Step 1 of 4: Build.');
  const early = status(previewOver(null, { previewCommittedAt: '2026-09-30T23:11:40Z' }));
  assert.equal(early.state, 'preview_building');
  assert.equal(early.headline, 'Building preview. Step 1 of 4: Build.');
});

test('preview_ready: green, built on the current main, and publishable', () => {
  const pr = run(PREVIEW, { branch: 'admin-preview', updatedAt: '2026-09-30T23:09:00Z' });
  const s = status({ ...previewOver(pr), jobsByRunId: { [pr.id]: jobs() } });
  assert.equal(s.state, 'preview_ready');
  assert.equal(s.headline, 'Preview ready at 4:09 PM. QA passed.');
  assert.equal(s.preview.publishable, true);
  assert.equal(s.preview.headSha, PREVIEW);
  assert.equal(s.preview.run, pr);
});

test('preview_failed: a failing check, a cancel, and no run at all', () => {
  const failed = run(PREVIEW, { branch: 'admin-preview', conclusion: 'failure' });
  const s = status({ ...previewOver(failed), jobsByRunId: { [failed.id]: jobs({ failAt: 'QA checks' }) } });
  assert.equal(s.state, 'preview_failed');
  assert.equal(s.headline, 'Preview not built: the QA check failed. Open the log, fix the field, and build the preview again.');
  assert.equal(s.preview.publishable, false);

  const deployFailed = run(PREVIEW, { branch: 'admin-preview', conclusion: 'failure' });
  assert.equal(status({ ...previewOver(deployFailed), jobsByRunId: { [deployFailed.id]: jobs({ failAt: 'Deploy to Cloudflare' }) } }).headline,
    'Preview not built: the Cloudflare deploy failed. Open the log, then build the preview again.');

  const cancelled = run(PREVIEW, { branch: 'admin-preview', conclusion: 'cancelled' });
  assert.equal(status(previewOver(cancelled)).headline, 'Preview not built: the run was cancelled. Build the preview again.');

  const none = status(previewOver(null));
  assert.equal(none.state, 'preview_failed');
  assert.equal(none.headline, 'Preview not built: GitHub started no run for it. Build the preview again.');
});

test('a preview run that skipped its deploy reports deploys_off, and stays publishable', () => {
  const pr = run(PREVIEW, { branch: 'admin-preview' });
  const s = status({ ...previewOver(pr), jobsByRunId: { [pr.id]: jobs({ deploySkipped: true }) } });
  assert.equal(s.state, 'deploys_off');
  assert.equal(s.preview.publishable, true);
});

test('a preview built on an older main, or already published, is not the status and not publishable', () => {
  const pr = run(PREVIEW, { branch: 'admin-preview' });
  const stale = status({ ...previewOver(pr, { previewParent: OLD }), jobsByRunId: { [pr.id]: jobs() } });
  assert.equal(stale.state, 'live');
  assert.equal(stale.preview.publishable, false);
  const published = status({ previewHead: MAIN, previewParent: OLD, mainRuns: [run(MAIN)], previewRuns: [run(MAIN, { branch: 'admin-preview' })] });
  assert.equal(published.state, 'live');
  assert.equal(published.preview.publishable, false);
});

test('a publish in flight outranks an open preview; an open preview outranks an old failure', () => {
  const moving = run(MAIN, { status: 'in_progress' });
  const pr = run(PREVIEW, { branch: 'admin-preview' });
  assert.equal(status({ ...previewOver(pr), mainRuns: [moving], jobsByRunId: { [moving.id]: jobs({ at: 'Test' }) } }).state, 'publishing');
  const failedMain = run(MAIN, { conclusion: 'failure' });
  assert.equal(status({ ...previewOver(pr), mainRuns: [failedMain], jobsByRunId: { [pr.id]: jobs() } }).state, 'preview_ready');
});

test('pull_request runs never stand for a branch head', () => {
  const pr = run(MAIN, { event: 'pull_request', conclusion: 'failure', createdAt: '2026-09-30T23:11:59Z' });
  const push = run(MAIN);
  assert.equal(status({ mainRuns: [pr, push] }).state, 'live');
});

test('the newest run for a SHA wins (a redeploy after a failure)', () => {
  const failed = run(MAIN, { conclusion: 'failure', createdAt: '2026-09-30T23:00:00Z', updatedAt: '2026-09-30T23:02:00Z' });
  const redeploy = run(MAIN, { event: 'workflow_dispatch', createdAt: '2026-09-30T23:10:00Z' });
  assert.equal(status({ mainRuns: [failed, redeploy] }).state, 'live');
});

test('progress: steps map by position, failures and skipped deploys are found', () => {
  assert.deepEqual(progress([]).step, { index: 1, count: 4, name: 'Build' });
  assert.deepEqual(progress(undefined).step, { index: 1, count: 4, name: 'Build' });
  assert.deepEqual(progress(jobs({ at: 'Post Checkout' })).step, { index: 2, count: 4, name: 'QA' });
  assert.deepEqual(progress(jobs({ at: 'Check bundle shape' })).step, { index: 3, count: 4, name: 'Deploy' });
  assert.deepEqual(progress(jobs()).step, { index: 4, count: 4, name: 'Live' });
  assert.equal(progress(jobs({ deploySkipped: true })).deploySkipped, true);
  assert.equal(progress(jobs()).deploySkipped, false);
  assert.deepEqual(progress(jobs({ failAt: 'Build site' })).failed, { stepName: 'Build site', phase: 1, wording: 'the build failed' });
  const jobOnly = [{ name: 'Build and QA', status: 'completed', conclusion: 'failure', steps: [] }];
  assert.deepEqual(progress(jobOnly).failed, { stepName: null, phase: 1, wording: 'the Build and QA job failed' });
});

test('etaSeconds: median of the last five green runs, minus the time already spent', () => {
  const current = run(MAIN, { status: 'in_progress', createdAt: '2026-09-30T23:11:00Z' });
  const now = new Date(NOW);
  assert.equal(etaSeconds(current, HISTORY, now), 40);
  const noisy = [...HISTORY, run(OLD, { conclusion: 'failure', createdAt: '2026-09-30T20:00:00Z', updatedAt: '2026-09-30T21:00:00Z' })];
  assert.equal(etaSeconds(current, noisy, now), 40, 'failed runs are not samples');
  const six = [...HISTORY, run(OLD, { createdAt: '2026-09-30T22:00:00Z', updatedAt: '2026-09-30T22:05:00Z' })];
  assert.equal(etaSeconds(current, six, now), 50, 'only the five newest count: 95, 100, 110, 120, 300 → 110');
  assert.equal(etaSeconds(current, HISTORY.slice(0, 4), now), 38, 'an even count averages the middle pair: (95 + 100) / 2 - 60 = 37.5');
  const late = run(MAIN, { status: 'in_progress', createdAt: '2026-09-30T23:00:00Z' });
  assert.equal(etaSeconds(late, HISTORY, now), 0, 'an overdue run reports zero, never negative');
  assert.equal(etaSeconds(current, [], now), null);
});

test('formatTime: 12-hour clock with a plain space, dated when not today', () => {
  const now = new Date(NOW);
  assert.equal(formatTime('2026-09-30T23:12:00Z', TZ, now), '4:12 PM');
  assert.equal(formatTime('2026-09-30T16:05:00Z', TZ, now), '9:05 AM');
  assert.equal(formatTime('2026-09-29T23:12:00Z', TZ, now), 'Sep 29, 4:12 PM');
  assert.equal(formatTime('2025-12-31T20:00:00Z', TZ, now), 'Dec 31, 2025, 12:00 PM');
  assert.equal(formatTime('not a date', TZ, now), null);
});

test('describePaths: titles, lower-cased, joined as a person would', () => {
  assert.equal(describePaths([], TITLES), null);
  assert.equal(describePaths(['tagline', 'tagline'], TITLES), 'tagline');
  assert.equal(describePaths(['owner.jobTitle', 'contactEmail'], TITLES), 'job title and public email');
});
