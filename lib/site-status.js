'use strict';
// One status line for the website: what donatelli.tech serves, what main holds, and where the
// latest preview or publish run is. Pure: lib/site-admin.js gathers the GitHub runs, jobs and the
// live build.json, and every sentence the admin shows about publishing comes from here.

const SITE_NAME = 'donatelli.tech';
const STEP_NAMES = ['Build', 'QA', 'Deploy', 'Live'];
const STEP_COUNT = STEP_NAMES.length;
// Job and step names are a contract with the website's .github/workflows/site.yml.
const VERIFY_JOB = 'Build and QA';
const DEPLOY_JOB = 'Deploy';
const QA_FIRST_STEP = 'QA checks';
const LIVE_FIRST_STEP = 'Verify live';
const FAILED_WORDING = {
  Test: 'the tests failed',
  'Build site': 'the build failed',
  'QA checks': 'the QA check failed',
  'Deploy to Cloudflare': 'the Cloudflare deploy failed',
  'Verify live': 'the live check failed',
};
// A push by the admin's PAT normally starts a run within seconds; after this, "no run" is a fault.
const START_GRACE_MS = 60 * 1000;
const ETA_SAMPLE = 5;

const toMs = (iso) => (iso ? Date.parse(iso) : NaN);
const shortSha = (sha) => (sha ? String(sha).slice(0, 7) : '');
const isMoving = (run) => Boolean(run) && run.status !== 'completed';
const succeeded = (run) => Boolean(run) && run.status === 'completed' && run.conclusion === 'success';

function dayKey(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

// "4:12 PM" today, "Sep 28, 4:12 PM" on another day, in the owner's time zone. ICU puts a narrow
// no-break space before AM/PM; the copy uses a plain space.
function formatTime(value, timeZone, now = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const time = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' })
    .format(date)
    .replace(/[  ]/g, ' ');
  if (dayKey(date, timeZone) === dayKey(now instanceof Date ? now : new Date(now), timeZone)) return time;
  const sameYear = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric' }).format(date)
    === new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric' }).format(now instanceof Date ? now : new Date(now));
  const day = new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) }).format(date);
  return `${day}, ${time}`;
}

// "Job title" → "job title", but "QR code" keeps its capitals.
const lowerFirst = (s) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);

function describePaths(paths, titlesByPath = {}) {
  const names = [...new Set((paths || []).map((p) => lowerFirst(titlesByPath[p] || p)))];
  if (names.length === 0) return null;
  if (names.length === 1) return names[0];
  if (names.length <= 3) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

function newestFor(runs, sha) {
  if (!sha) return null;
  return (runs || [])
    .filter((r) => r.headSha === sha && r.event !== 'pull_request')
    .sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt) || b.id - a.id)[0] || null;
}

const step = (index) => ({ index, count: STEP_COUNT, name: STEP_NAMES[index - 1] });

// Steps are placed by position: everything in the verify job before "QA checks" is Build (GitHub's
// own "Set up job" included), and everything in the deploy job before "Verify live" is Deploy.
function phasedSteps(jobs) {
  const out = [];
  const verify = (jobs || []).find((j) => j.name === VERIFY_JOB);
  const deploy = (jobs || []).find((j) => j.name === DEPLOY_JOB);
  const walk = (job, first, next, marker) => {
    let phase = first;
    for (const s of [...(job.steps || [])].sort((a, b) => a.number - b.number)) {
      if (s.name === marker) phase = next;
      out.push({ ...s, job: job.name, phase });
    }
  };
  if (verify) walk(verify, 1, 2, QA_FIRST_STEP);
  if (deploy) walk(deploy, 3, 4, LIVE_FIRST_STEP);
  return { verify, deploy, steps: out };
}

function progress(jobs) {
  const { verify, deploy, steps } = phasedSteps(jobs);
  const deploySkipped = Boolean(deploy && deploy.status === 'completed' && deploy.conclusion === 'skipped');

  const failedStep = steps.find((s) => s.conclusion === 'failure' || s.conclusion === 'timed_out');
  let failed = null;
  if (failedStep) {
    failed = { stepName: failedStep.name, phase: failedStep.phase, wording: FAILED_WORDING[failedStep.name] || `the "${failedStep.name}" step failed` };
  } else {
    const failedJob = [verify, deploy].find((j) => j && j.status === 'completed' && ['failure', 'timed_out'].includes(j.conclusion));
    if (failedJob) failed = { stepName: null, phase: failedJob === verify ? 1 : 3, wording: `the ${failedJob.name} job failed` };
  }

  let current = 1;
  if (verify && verify.status === 'completed') {
    if (!deploy || deploy.status !== 'completed') {
      const open = deploy && steps.find((s) => s.job === DEPLOY_JOB && s.status !== 'completed');
      current = open ? open.phase : 3;
    } else {
      current = 4;
    }
  } else if (verify) {
    const open = steps.find((s) => s.job === VERIFY_JOB && s.status !== 'completed');
    // Every named step done but the job still open: post-steps after Upload bundle.
    current = open ? open.phase : ((verify.steps || []).length ? 2 : 1);
  }
  return { step: step(current), failed, deploySkipped };
}

function etaSeconds(run, history, now) {
  if (!run) return null;
  const durations = (history || [])
    .filter((r) => r.id !== run.id && succeeded(r) && r.runStartedAt && r.updatedAt)
    .sort((a, b) => toMs(b.updatedAt) - toMs(a.updatedAt))
    .slice(0, ETA_SAMPLE)
    .map((r) => (toMs(r.updatedAt) - toMs(r.runStartedAt)) / 1000)
    .filter((d) => Number.isFinite(d) && d > 0)
    .sort((a, b) => a - b);
  if (durations.length === 0) return null;
  const mid = Math.floor(durations.length / 2);
  const median = durations.length % 2 ? durations[mid] : (durations[mid - 1] + durations[mid]) / 2;
  const started = toMs(run.runStartedAt || run.createdAt);
  const elapsed = Number.isFinite(started) ? (now.getTime() - started) / 1000 : 0;
  return Math.max(0, Math.round(median - elapsed));
}

const etaText = (eta) => (eta == null ? '' : ` About ${Math.max(1, Math.ceil(eta / 60))} min left.`);
const stepText = (s) => `Step ${s.index} of ${s.count}: ${s.name}.`;

function computeStatus(input) {
  const {
    configured = true,
    mainSha = null,
    mainCommittedAt = null,
    previewHead = null,
    previewParent = null,
    previewCommittedAt = null,
    mainRuns = [],
    previewRuns = [],
    jobsByRunId = {},
    buildJson = null,
    previewBuildJson = null,
    timeZone = 'America/Los_Angeles',
    titlesByPath = {},
    deploysSkipped,
    lastChangePaths = null,
    publishedAt = null,
    urls = {},
  } = input || {};
  const now = input && input.now ? new Date(input.now) : new Date();
  const at = (iso) => formatTime(iso, timeZone, now);
  const checkedAt = now.toISOString();

  if (!configured) {
    return {
      configured: false,
      state: 'off',
      headline: 'Publishing is off: SITE_GITHUB_TOKEN is not set on the admin server.',
      detail: null,
      step: null,
      etaSeconds: null,
      production: null,
      preview: null,
      checkedAt,
    };
  }

  const live = buildJson && typeof buildJson.commit === 'string' ? buildJson : null;
  const history = [...mainRuns, ...previewRuns];

  const mainRun = newestFor(mainRuns, mainSha);
  const prod = mainRun ? progress(jobsByRunId[mainRun.id]) : null;
  const production = {
    mainSha,
    liveSha: live ? live.commit : null,
    liveBuiltAt: live ? live.builtAt || null : null,
    liveSource: live ? live.source || null : null,
    run: mainRun,
    url: urls.production || null,
  };

  const previewOpen = Boolean(previewHead) && previewHead !== mainSha && previewParent === mainSha;
  const previewRun = previewHead ? newestFor(previewRuns, previewHead) : null;
  const prev = previewRun ? progress(jobsByRunId[previewRun.id]) : null;
  const preview = {
    headSha: previewHead,
    parentSha: previewParent,
    run: previewRun,
    url: urls.preview || null,
    publishable: previewOpen && succeeded(previewRun),
    liveSha: previewBuildJson && typeof previewBuildJson.commit === 'string' ? previewBuildJson.commit : null,
  };

  const result = (state, headline, extra = {}) => ({
    configured: true,
    state,
    headline,
    detail: extra.detail || null,
    step: extra.step || null,
    etaSeconds: extra.etaSeconds == null ? null : extra.etaSeconds,
    production,
    preview,
    checkedAt,
  });
  const liveVersion = production.liveBuiltAt ? `the ${at(production.liveBuiltAt)} version` : 'the previous version';
  const failedDetail = (p) => (p && p.failed && p.failed.stepName ? `The "${p.failed.stepName}" step failed.` : null);

  // 1. A publish in flight outranks everything: the owner is watching it.
  if (isMoving(mainRun)) {
    const eta = etaSeconds(mainRun, history, now);
    return result('publishing', `Publishing. ${stepText(prod.step)}${etaText(eta)}`, { step: prod.step, etaSeconds: eta });
  }
  if (!mainRun && !(live && live.commit === mainSha)) {
    const pushedAt = toMs(publishedAt || mainCommittedAt);
    if (Number.isFinite(pushedAt) && now.getTime() - pushedAt < START_GRACE_MS) {
      return result('publishing', 'Publishing. Waiting for GitHub to start the run.', { step: step(1) });
    }
  }

  // 2. An open preview built on the current main: the owner's next action is about it.
  if (previewOpen) {
    if (isMoving(previewRun)) {
      const eta = etaSeconds(previewRun, history, now);
      return result('preview_building', `Building preview. ${stepText(prev.step)}`, { step: prev.step, etaSeconds: eta });
    }
    if (!previewRun) {
      const createdAt = toMs(previewCommittedAt);
      if (!Number.isFinite(createdAt) || now.getTime() - createdAt < START_GRACE_MS) {
        return result('preview_building', `Building preview. ${stepText(step(1))}`, { step: step(1) });
      }
      return result('preview_failed', 'Preview not built: GitHub started no run for it. Build the preview again.');
    }
    if (succeeded(previewRun)) {
      if (deploysSkipped === true || prev.deploySkipped) return deploysOff();
      return result('preview_ready', `Preview ready at ${at(previewRun.updatedAt)}. QA passed.`);
    }
    if (previewRun.conclusion === 'cancelled') {
      return result('preview_failed', 'Preview not built: the run was cancelled. Build the preview again.');
    }
    const wording = prev.failed ? prev.failed.wording : 'the run failed';
    const next = prev.failed && prev.failed.phase <= 2
      ? 'Open the log, fix the field, and build the preview again.'
      : 'Open the log, then build the preview again.';
    return result('preview_failed', `Preview not built: ${wording}. ${next}`, { detail: failedDetail(prev) });
  }

  // 3. The last publish (or push) to main, when it did not end live.
  if (!mainRun) {
    if (live && live.commit === mainSha) return liveState(null);
    // Without build.json or an admin publish there is no evidence either way.
    const pushedAt = publishedAt || mainCommittedAt;
    if (live || publishedAt) {
      const when = pushedAt ? ` at ${at(pushedAt)}` : '';
      return result('stalled', `Published to main${when}, but no deploy started. Start the deploy.`);
    }
    return unknown();
  }
  if (mainRun.conclusion === 'cancelled') {
    return result('failed', `Not published: the run was cancelled. ${SITE_NAME} still shows ${liveVersion}. Redeploy to start it again.`);
  }
  if (mainRun.conclusion !== 'success') {
    const wording = prod.failed ? prod.failed.wording : 'the run failed';
    const next = prod.failed && prod.failed.phase <= 2
      ? 'Open the log, fix the field, and publish again.'
      : 'Open the log, then redeploy.';
    return result('failed', `Not published: ${wording}. ${SITE_NAME} still shows ${liveVersion}. ${next}`, { detail: failedDetail(prod) });
  }
  if (deploysSkipped === true || prod.deploySkipped) return deploysOff();
  if (!live) return unknown(mainRun);
  return liveState(mainRun);

  function deploysOff() {
    return result('deploys_off', 'Not published: deploys are off in GitHub. Add the Cloudflare secrets, then set PAGES_DEPLOY_ENABLED to true.');
  }

  function unknown(run) {
    const host = urls.production ? urls.production.replace(/^https?:\/\//, '').replace(/\/+$/, '') : SITE_NAME;
    const deployed = run ? `Deployed at ${at(run.updatedAt)}, but` : 'The live version is unknown:';
    return result('unknown', `${deployed} ${host}/build.json did not answer. Open ${SITE_NAME} to check it.`);
  }

  function liveState(run) {
    if (live.commit !== mainSha) {
      if (live.source === 'local') {
        const from = live.builtAt && at(live.builtAt) ? ` from ${at(live.builtAt)}` : '';
        return result('live', `Live: a laptop deploy${from} (commit ${shortSha(live.commit)}), not the latest main.`);
      }
      return result('rolled_back', `Live: an older deployment (commit ${shortSha(live.commit)}) after a rollback. main holds ${shortSha(mainSha)}.`);
    }
    const since = run ? at(run.updatedAt) : (live.builtAt ? at(live.builtAt) : null);
    const lead = since ? `Live since ${since}.` : 'Live.';
    const change = describePaths(lastChangePaths, titlesByPath);
    return result('live', change ? `${lead} Last change: ${change}.` : `${lead} Commit ${shortSha(mainSha)}.`);
  }
}

module.exports = { computeStatus, formatTime, describePaths, newestFor, progress, etaSeconds, STEP_NAMES, FAILED_WORDING };
