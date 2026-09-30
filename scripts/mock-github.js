#!/usr/bin/env node
'use strict';
// An in-memory stand-in for the parts of the GitHub REST API that lib/github.js calls, plus the two
// Cloudflare Pages sites the website tools watch (/live/<branch>/build.json). Tests, the e2e
// screenshots and a local admin run against it, so nothing here ever touches the real repo.
//
//   node scripts/mock-github.js --port 4010 --seed-from /home/user/donatelli-website
//
// A branch update on main or admin-preview starts a site.yml run whose jobs and steps carry the
// names the website's site.yml uses (the contract lib/site-status.js reads). Runs move queued →
// in_progress → completed on a timer, or wait for completeRun() / POST /_mock/runs/:id/complete.

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_REPO = 'Njdonatelli/donatelli-website';
const FIXTURES = path.join(__dirname, '..', 'test', 'fixtures', 'site');
const SEED_FILES = ['data/site.json', 'data/site.schema.json', 'outputs/data/credentials.json', '.github/workflows/site.yml', '.github/workflows/rollback.yml'];
const FIXTURE_NAMES = {
  'data/site.json': 'site.json',
  'data/site.schema.json': 'site.schema.json',
  'outputs/data/credentials.json': 'credentials.json',
};

// Job and step names copied from the website's .github/workflows/site.yml (spec §5.4), with the
// "Set up job" / "Post …" / "Complete job" steps GitHub adds around them.
const SITE_JOBS = [
  {
    name: 'Build and QA',
    steps: ['Set up job', 'Checkout', 'Set up Node', 'Commit subject', 'Install', 'Test', 'Build site', 'QA checks', 'Upload bundle', 'Post Set up Node', 'Post Checkout', 'Complete job'],
  },
  {
    name: 'Deploy',
    deploy: true,
    steps: ['Set up job', 'Download bundle', 'Check bundle shape', 'Set up Node', 'Install wrangler', 'Deploy to Cloudflare', 'Verify live', 'Summary', 'Complete job'],
  },
];
const ROLLBACK_JOBS = [{ name: 'Roll back production', steps: ['Set up job', 'Roll back', 'Complete job'] }];
const WORKFLOW_NAMES = { 'site.yml': 'site', 'rollback.yml': 'rollback' };

const sha1 = (data) => crypto.createHash('sha1').update(data).digest('hex');
const iso = (ms = Date.now()) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

function readSeed(seedFrom) {
  const files = {};
  if (seedFrom) {
    for (const rel of SEED_FILES) {
      const file = path.join(seedFrom, rel);
      if (fs.existsSync(file)) files[rel] = fs.readFileSync(file, 'utf8');
    }
  } else {
    for (const [rel, name] of Object.entries(FIXTURE_NAMES)) files[rel] = fs.readFileSync(path.join(FIXTURES, name), 'utf8');
  }
  return files;
}

async function startMockGitHub({
  port = 0,
  host = '127.0.0.1',
  repo = DEFAULT_REPO,
  files,
  seedFrom = null,
  autoProgress = true,
  stepDelayMs = 200,
  token = null,
  tokenExpiresAt = null,
  dispatch204 = process.env.MOCK_DISPATCH_204 === '1',
  deploysEnabled = true,
  workflows = Object.keys(WORKFLOW_NAMES),
  branches = { production: 'main', preview: 'admin-preview' },
} = {}) {
  const seed = files || readSeed(seedFrom);
  const portraitDir = seedFrom ? path.join(seedFrom, 'src') : null;

  const state = {
    repo,
    refs: new Map(),
    commits: new Map(),
    trees: new Map(),
    blobs: new Map(),
    runs: [],
    requests: [],
    live: new Map(),
    deployments: new Map(),
    dispatch204,
    deploysEnabled,
    workflows: new Set(workflows),
  };
  const timers = new Set();
  let nextRunId = 1000;
  let nextJobId = 5000;
  let commitCounter = 0;
  let url = '';

  // --- git objects: flat trees (path → blob sha) are all the Git data API calls here need ---

  function putBlob(content) {
    const buf = Buffer.from(content, 'utf8');
    const sha = sha1(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf]));
    state.blobs.set(sha, buf);
    return sha;
  }

  function putTree(entries) {
    const sorted = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const sha = sha1('tree\0' + JSON.stringify(sorted));
    state.trees.set(sha, new Map(sorted));
    return sha;
  }

  function putCommit({ tree, parents, message, date = iso(), author = { name: 'Mock Owner', email: 'owner@example.com' } }) {
    commitCounter += 1;
    const sha = sha1(`commit\0${JSON.stringify({ tree, parents, message, date, n: commitCounter })}`);
    const who = { ...author, date };
    state.commits.set(sha, { sha, tree, parents, message, author: who, committer: who });
    return sha;
  }

  function resolve(ref) {
    if (!ref) return null;
    if (state.refs.has(ref)) return state.refs.get(ref);
    return state.commits.has(ref) ? ref : null;
  }

  function fileAt(ref, filePath) {
    const sha = resolve(ref);
    if (!sha) return null;
    const blob = state.trees.get(state.commits.get(sha).tree).get(filePath);
    return blob ? state.blobs.get(blob).toString('utf8') : null;
  }

  function isAncestor(ancestor, sha) {
    const seen = new Set();
    const queue = [sha];
    while (queue.length) {
      const cur = queue.shift();
      if (cur === ancestor) return true;
      if (seen.has(cur) || !state.commits.has(cur)) continue;
      seen.add(cur);
      queue.push(...state.commits.get(cur).parents);
    }
    return false;
  }

  // --- runs ---

  function jobTemplates(workflow) {
    return workflow === 'rollback.yml' ? ROLLBACK_JOBS : SITE_JOBS;
  }

  function createRun({ workflow, branch, headSha, event, inputs = null }) {
    const id = nextRunId++;
    const now = iso();
    const run = {
      id,
      name: WORKFLOW_NAMES[workflow] || workflow,
      workflow,
      path: `.github/workflows/${workflow}`,
      head_branch: branch,
      head_sha: headSha,
      event,
      status: 'queued',
      conclusion: null,
      html_url: `https://github.com/${repo}/actions/runs/${id}`,
      created_at: now,
      updated_at: now,
      run_started_at: now,
      run_attempt: 1,
      display_title: (state.commits.get(headSha) || { message: '' }).message.split('\n')[0],
      inputs,
      jobs: jobTemplates(workflow).map((t) => ({
        id: nextJobId++,
        name: t.name,
        deploy: Boolean(t.deploy),
        skipped: false,
        steps: t.steps.map((name, i) => ({ name, number: i + 1, status: 'queued', conclusion: null, started_at: null, completed_at: null })),
      })),
    };
    state.runs.unshift(run);
    if (autoProgress) schedule(run);
    return run;
  }

  function schedule(run) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (run.status === 'completed') return;
      if (!stepForward(run)) finish(run, 'success');
      else schedule(run);
    }, stepDelayMs);
    timers.add(timer);
  }

  const allSteps = (run) => run.jobs.filter((j) => !j.skipped).flatMap((j) => j.steps);

  // Completes the running step and starts the next; false when nothing was left to start.
  function stepForward(run) {
    const now = iso();
    const steps = allSteps(run);
    const current = steps.find((s) => s.status === 'in_progress');
    if (current) Object.assign(current, { status: 'completed', conclusion: 'success', completed_at: now });
    const verifyDone = run.jobs[0].steps.every((s) => s.status === 'completed');
    const deployJob = run.jobs.find((j) => j.deploy);
    if (verifyDone && deployJob && !deployJob.skipped && !state.deploysEnabled && deployJob.steps.every((s) => s.status === 'queued')) {
      deployJob.skipped = true;
    }
    const next = allSteps(run).find((s) => s.status === 'queued');
    run.status = 'in_progress';
    run.updated_at = now;
    if (!next) return false;
    Object.assign(next, { status: 'in_progress', started_at: now });
    return true;
  }

  // Puts the run at the start of the named step, everything before it passed.
  function advanceRun(id, stepName) {
    const run = findRun(id);
    const steps = allSteps(run);
    const target = steps.findIndex((s) => s.name === stepName);
    if (target === -1) throw new Error(`Run ${id} has no step named ${stepName}.`);
    const now = iso();
    steps.forEach((s, i) => {
      if (i < target) Object.assign(s, { status: 'completed', conclusion: 'success', started_at: s.started_at || now, completed_at: s.completed_at || now });
      else if (i === target) Object.assign(s, { status: 'in_progress', conclusion: null, started_at: now, completed_at: null });
      else Object.assign(s, { status: 'queued', conclusion: null, started_at: null, completed_at: null });
    });
    run.status = 'in_progress';
    run.updated_at = now;
    return run;
  }

  function finish(run, conclusion, { failedStep } = {}) {
    const now = iso();
    const steps = allSteps(run);
    if (conclusion === 'success') {
      // With PAGES_DEPLOY_ENABLED unset the deploy job's `if:` is false and GitHub skips it.
      const deployJob = run.jobs.find((j) => j.deploy);
      if (deployJob && !state.deploysEnabled && deployJob.steps.every((s) => s.status === 'queued')) deployJob.skipped = true;
      for (const s of allSteps(run)) {
        if (s.status !== 'completed') Object.assign(s, { status: 'completed', conclusion: 'success', started_at: s.started_at || now, completed_at: now });
      }
    } else {
      const failing = failedStep || (run.workflow === 'rollback.yml' ? 'Roll back' : 'QA checks');
      const stopAt = conclusion === 'cancelled'
        ? Math.max(0, steps.findIndex((s) => s.status !== 'completed'))
        : steps.findIndex((s) => s.name === failing);
      if (stopAt === -1) throw new Error(`Run ${run.id} has no step named ${failing}.`);
      steps.forEach((s, i) => {
        if (i < stopAt) Object.assign(s, { status: 'completed', conclusion: 'success', started_at: s.started_at || now, completed_at: s.completed_at || now });
        else if (i === stopAt) Object.assign(s, { status: 'completed', conclusion: conclusion === 'cancelled' ? 'cancelled' : 'failure', started_at: s.started_at || now, completed_at: now });
        else Object.assign(s, { status: 'completed', conclusion: 'skipped', completed_at: now });
      });
    }
    run.status = 'completed';
    run.conclusion = conclusion;
    run.updated_at = now;
    if (conclusion === 'success') afterSuccess(run);
    return run;
  }

  function deploy(branch, commit) {
    const siteJson = fileAt(commit, 'data/site.json') || '';
    const build = { commit, builtAt: iso(), source: 'ci', vcard: '/card/nick-donatelli.vcf', siteHash: sha1(siteJson).slice(0, 8) };
    state.live.set(branch, build);
    const list = state.deployments.get(branch) || [];
    list.push({ id: crypto.randomUUID(), ...build });
    state.deployments.set(branch, list);
  }

  function afterSuccess(run) {
    if (run.workflow === 'rollback.yml') {
      if (!run.inputs || run.inputs.dry_run !== 'false') return;
      const list = state.deployments.get(branches.production) || [];
      const current = state.live.get(branches.production);
      const target = run.inputs.deployment_id
        ? list.find((d) => d.id === run.inputs.deployment_id)
        : [...list].reverse().find((d) => !current || d.commit !== current.commit);
      if (target) state.live.set(branches.production, { commit: target.commit, builtAt: target.builtAt, source: 'ci', vcard: target.vcard, siteHash: target.siteHash });
      return;
    }
    const deployJob = run.jobs.find((j) => j.deploy);
    if (deployJob && deployJob.skipped) return;
    if (run.head_branch === branches.production || run.head_branch === branches.preview) deploy(run.head_branch, run.head_sha);
  }

  function findRun(id) {
    const run = state.runs.find((r) => r.id === Number(id));
    if (!run) throw new Error(`No run ${id}.`);
    return run;
  }

  // Moving a watched branch is a push: site.yml runs for it.
  function pushed(branch, sha) {
    if (branch === branches.production || branch === branches.preview) {
      createRun({ workflow: 'site.yml', branch, headSha: sha, event: 'push' });
    }
  }

  // --- seed: main holds the given files and is live from one earlier green run ---

  const seedEntries = Object.entries(seed).map(([p, content]) => [p, putBlob(content)]);
  const seedSha = putCommit({ tree: putTree(seedEntries), parents: [], message: 'Seed the website repo', date: iso(Date.now() - 10 * 60 * 1000) });
  state.refs.set(branches.production, seedSha);
  const seedRun = createRun({ workflow: 'site.yml', branch: branches.production, headSha: seedSha, event: 'push' });
  timers.forEach(clearTimeout);
  timers.clear();
  const seedStart = Date.now() - 5 * 60 * 1000;
  Object.assign(seedRun, { created_at: iso(seedStart), run_started_at: iso(seedStart), updated_at: iso(seedStart + 90 * 1000) });
  // The site was live before the admin existed, whatever the deploy switch says now.
  const deploysSetting = state.deploysEnabled;
  state.deploysEnabled = true;
  finish(seedRun, 'success');
  state.deploysEnabled = deploysSetting;
  seedRun.updated_at = iso(seedStart + 90 * 1000);
  state.live.get(branches.production).builtAt = iso(seedStart + 30 * 1000);

  // --- HTTP ---

  function toRunJson(r) {
    const { jobs, inputs, workflow, ...rest } = r;
    return rest;
  }

  function jobsJson(run) {
    return run.jobs.map((j) => {
      if (j.skipped) {
        return { id: j.id, run_id: run.id, name: j.name, status: 'completed', conclusion: 'skipped', started_at: run.updated_at, completed_at: run.updated_at, steps: [] };
      }
      const done = j.steps.every((s) => s.status === 'completed');
      const started = j.steps.some((s) => s.status !== 'queued');
      const bad = j.steps.find((s) => s.conclusion === 'failure' || s.conclusion === 'cancelled');
      const status = done ? 'completed' : started ? 'in_progress' : 'queued';
      return {
        id: j.id,
        run_id: run.id,
        name: j.name,
        status,
        conclusion: done ? (bad ? bad.conclusion : (j.steps.every((s) => s.conclusion === 'skipped') ? 'skipped' : 'success')) : null,
        started_at: started ? j.steps.find((s) => s.started_at)?.started_at || null : null,
        completed_at: done ? j.steps[j.steps.length - 1].completed_at : null,
        steps: j.steps.map(({ name, status: st, conclusion, number, started_at: sa, completed_at: ca }) => ({ name, status: st, conclusion, number, started_at: sa, completed_at: ca })),
      };
    });
  }

  function commitJson(sha) {
    const c = state.commits.get(sha);
    return {
      sha,
      tree: { sha: c.tree },
      parents: c.parents.map((p) => ({ sha: p })),
      message: c.message,
      author: c.author,
      committer: c.committer,
      html_url: `https://github.com/${repo}/commit/${sha}`,
    };
  }

  function send(res, status, payload, headers = {}) {
    const extra = tokenExpiresAt ? { 'github-authentication-token-expiration': tokenExpiresAt } : {};
    if (payload === undefined) {
      res.writeHead(status, { ...extra, ...headers });
      return res.end();
    }
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
    res.writeHead(status, { 'Content-Type': Buffer.isBuffer(payload) ? 'application/octet-stream' : 'application/json; charset=utf-8', ...extra, ...headers });
    res.end(body);
  }

  const notFound = (res) => send(res, 404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' });
  const unprocessable = (res, message) => send(res, 422, { message, documentation_url: 'https://docs.github.com/rest' });

  function listRuns(res, workflow, q) {
    if (!state.workflows.has(workflow)) return notFound(res);
    let runs = state.runs.filter((r) => r.workflow === workflow);
    if (q.get('branch')) runs = runs.filter((r) => r.head_branch === q.get('branch'));
    if (q.get('event')) runs = runs.filter((r) => r.event === q.get('event'));
    if (q.get('head_sha')) runs = runs.filter((r) => r.head_sha === q.get('head_sha'));
    const created = q.get('created');
    if (created && created.startsWith('>=')) runs = runs.filter((r) => Date.parse(r.created_at) >= Date.parse(created.slice(2)));
    const perPage = Math.min(100, Number(q.get('per_page')) || 30);
    return send(res, 200, { total_count: runs.length, workflow_runs: runs.slice(0, perPage).map(toRunJson) });
  }

  function listCommits(res, q) {
    let sha = resolve(q.get('sha') || branches.production);
    if (!sha) return notFound(res);
    const filePath = q.get('path');
    const perPage = Math.min(100, Number(q.get('per_page')) || 30);
    const out = [];
    while (sha && out.length < perPage) {
      const c = state.commits.get(sha);
      const parent = c.parents[0] || null;
      const touched = !filePath || fileAt(sha, filePath) !== (parent ? fileAt(parent, filePath) : null);
      if (touched) {
        out.push({ sha, commit: { message: c.message, author: c.author, committer: c.committer, tree: { sha: c.tree } }, html_url: `https://github.com/${repo}/commit/${sha}`, author: null, parents: c.parents.map((p) => ({ sha: p })) });
      }
      sha = parent;
    }
    return send(res, 200, out);
  }

  function handleRepo(req, res, rest, q, body) {
    let m;
    if (req.method === 'GET' && (m = /^\/git\/ref\/heads\/(.+)$/.exec(rest))) {
      const sha = state.refs.get(decodeURIComponent(m[1]));
      return sha ? send(res, 200, { ref: `refs/heads/${decodeURIComponent(m[1])}`, object: { sha, type: 'commit' } }) : notFound(res);
    }
    if (req.method === 'GET' && (m = /^\/git\/commits\/([0-9a-f]{40})$/.exec(rest))) {
      return state.commits.has(m[1]) ? send(res, 200, commitJson(m[1])) : notFound(res);
    }
    if (req.method === 'GET' && (m = /^\/contents\/(.+)$/.exec(rest))) {
      const filePath = m[1].split('/').map(decodeURIComponent).join('/');
      const sha = resolve(q.get('ref') || branches.production);
      const blob = sha ? state.trees.get(state.commits.get(sha).tree).get(filePath) : null;
      if (!blob) return notFound(res);
      const buf = state.blobs.get(blob);
      const b64 = buf.toString('base64').replace(/.{1,60}/g, '$&\n');
      return send(res, 200, { type: 'file', encoding: 'base64', size: buf.length, name: path.posix.basename(filePath), path: filePath, content: b64, sha: blob });
    }
    if (req.method === 'POST' && rest === '/git/trees') {
      if (!body || !Array.isArray(body.tree)) return unprocessable(res, 'Invalid request.');
      // Like GitHub: without base_tree the new tree holds only the listed files.
      let entries = new Map();
      if (body.base_tree) {
        if (!state.trees.has(body.base_tree)) return unprocessable(res, 'Invalid tree info');
        entries = new Map(state.trees.get(body.base_tree));
      }
      for (const item of body.tree) {
        if (item.sha === null) entries.delete(item.path);
        else if (typeof item.content === 'string') entries.set(item.path, putBlob(item.content));
        else if (item.sha && state.blobs.has(item.sha)) entries.set(item.path, item.sha);
        else return unprocessable(res, 'Invalid tree info');
      }
      const sha = putTree([...entries]);
      return send(res, 201, { sha, truncated: false, tree: [...entries].map(([p, s]) => ({ path: p, mode: '100644', type: 'blob', sha: s })) });
    }
    if (req.method === 'POST' && rest === '/git/commits') {
      if (!body || !state.trees.has(body.tree) || !(body.parents || []).every((p) => state.commits.has(p))) return unprocessable(res, 'Invalid request.');
      const sha = putCommit({ tree: body.tree, parents: body.parents || [], message: String(body.message || '') });
      return send(res, 201, commitJson(sha));
    }
    if (req.method === 'PATCH' && (m = /^\/git\/refs\/heads\/(.+)$/.exec(rest))) {
      const branch = decodeURIComponent(m[1]);
      if (!state.refs.has(branch)) return unprocessable(res, 'Reference does not exist');
      if (!body || !state.commits.has(body.sha)) return unprocessable(res, 'Object does not exist');
      if (body.force !== true && !isAncestor(state.refs.get(branch), body.sha)) return unprocessable(res, 'Update is not a fast forward');
      state.refs.set(branch, body.sha);
      pushed(branch, body.sha);
      return send(res, 200, { ref: `refs/heads/${branch}`, object: { sha: body.sha, type: 'commit' } });
    }
    if (req.method === 'POST' && rest === '/git/refs') {
      const branch = body && typeof body.ref === 'string' && body.ref.startsWith('refs/heads/') ? body.ref.slice('refs/heads/'.length) : null;
      if (!branch || !state.commits.has(body.sha)) return unprocessable(res, 'Invalid request.');
      if (state.refs.has(branch)) return unprocessable(res, 'Reference already exists');
      state.refs.set(branch, body.sha);
      pushed(branch, body.sha);
      return send(res, 201, { ref: body.ref, object: { sha: body.sha, type: 'commit' } });
    }
    if (req.method === 'GET' && (m = /^\/actions\/workflows\/([^/]+)\/runs$/.exec(rest))) {
      return listRuns(res, decodeURIComponent(m[1]), q);
    }
    if (req.method === 'POST' && (m = /^\/actions\/workflows\/([^/]+)\/dispatches$/.exec(rest))) {
      const workflow = decodeURIComponent(m[1]);
      if (!state.workflows.has(workflow)) return notFound(res);
      const ref = body && body.ref;
      if (!state.refs.has(ref)) return unprocessable(res, `No ref found for: ${ref}`);
      const run = createRun({ workflow, branch: ref, headSha: state.refs.get(ref), event: 'workflow_dispatch', inputs: (body && body.inputs) || {} });
      if (state.dispatch204) return send(res, 204);
      return send(res, 200, { workflow_run_id: run.id, run_url: `${url}/repos/${repo}/actions/runs/${run.id}`, html_url: run.html_url });
    }
    if ((m = /^\/actions\/runs\/(\d+)(\/jobs|\/rerun-failed-jobs|\/cancel)?$/.exec(rest))) {
      const run = state.runs.find((r) => r.id === Number(m[1]));
      if (!run) return notFound(res);
      if (req.method === 'GET' && !m[2]) return send(res, 200, toRunJson(run));
      if (req.method === 'GET' && m[2] === '/jobs') {
        const jobs = jobsJson(run);
        return send(res, 200, { total_count: jobs.length, jobs });
      }
      if (req.method === 'POST' && m[2] === '/cancel') {
        if (run.status === 'completed') return send(res, 409, { message: 'Cannot cancel a workflow run that is completed.' });
        finish(run, 'cancelled');
        return send(res, 202, {});
      }
      if (req.method === 'POST' && m[2] === '/rerun-failed-jobs') {
        if (run.status !== 'completed') return send(res, 403, { message: 'This workflow is already running' });
        for (const job of run.jobs) {
          job.skipped = false;
          for (const s of job.steps) Object.assign(s, { status: 'queued', conclusion: null, started_at: null, completed_at: null });
        }
        Object.assign(run, { status: 'queued', conclusion: null, run_attempt: run.run_attempt + 1, updated_at: iso(), run_started_at: iso() });
        if (autoProgress) schedule(run);
        return send(res, 201, {});
      }
    }
    if (req.method === 'GET' && rest === '/commits') return listCommits(res, q);
    return notFound(res);
  }

  function handleLive(req, res, branch, file) {
    if (file === 'build.json') {
      const build = state.live.get(branch);
      if (!build) return send(res, 404, { message: 'Not Found' });
      return send(res, 200, build, { 'Cache-Control': 'no-store' });
    }
    // Portraits for the admin's card preview, straight from the seed's src/.
    if (portraitDir && /^[a-z0-9-]+\.webp$/.test(file) && fs.existsSync(path.join(portraitDir, file))) {
      res.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(portraitDir, file)));
    }
    return send(res, 404, { message: 'Not Found' });
  }

  function handleControl(req, res, rest, body) {
    let m;
    if (req.method === 'GET' && rest === '/state') {
      return send(res, 200, {
        refs: Object.fromEntries(state.refs),
        runs: state.runs.map(toRunJson),
        live: Object.fromEntries(state.live),
      });
    }
    if (req.method === 'POST' && (m = /^\/runs\/(\d+)\/complete$/.exec(rest))) {
      try {
        return send(res, 200, toRunJson(finish(findRun(m[1]), (body && body.conclusion) || 'success', { failedStep: body && body.failedStep })));
      } catch (err) {
        return send(res, 404, { message: err.message });
      }
    }
    return notFound(res);
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const u = new URL(req.url, 'http://mock.invalid');
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      if (raw) {
        try { body = JSON.parse(raw); } catch { return send(res, 400, { message: 'Problems parsing JSON' }); }
      }
      let m;
      if ((m = /^\/live\/([^/]+)\/([^/]+)$/.exec(u.pathname))) return handleLive(req, res, decodeURIComponent(m[1]), m[2]);
      if ((m = /^\/_mock(\/.*)$/.exec(u.pathname))) return handleControl(req, res, m[1], body);

      const prefix = `/repos/${repo}`;
      if (!u.pathname.startsWith(prefix + '/')) return notFound(res);
      state.requests.push({
        method: req.method,
        path: u.pathname.slice(prefix.length),
        query: Object.fromEntries(u.searchParams),
        body,
        headers: { authorization: req.headers.authorization || null, 'x-github-api-version': req.headers['x-github-api-version'] || null, 'user-agent': req.headers['user-agent'] || null },
      });
      const auth = req.headers.authorization || '';
      if (!/^Bearer \S+$/.test(auth) || (token && auth !== `Bearer ${token}`)) {
        return send(res, 401, { message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest' });
      }
      return handleRepo(req, res, u.pathname.slice(prefix.length), u.searchParams, body);
    });
  });

  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolveListen);
  });
  url = `http://${host}:${server.address().port}`;

  return {
    url,
    liveUrl: (branch) => `${url}/live/${branch}`,
    state,
    completeRun: (id, conclusion = 'success', opts) => finish(findRun(id), conclusion, opts),
    advanceRun,
    // A commit pushed straight to a branch, as the owner's laptop or a merged PR would.
    pushCommit: ({ branch = branches.production, files: changed, message = 'Edit from git' }) => {
      const parent = state.refs.get(branch);
      const entries = new Map(state.trees.get(state.commits.get(parent).tree));
      for (const [p, content] of Object.entries(changed)) entries.set(p, putBlob(content));
      const sha = putCommit({ tree: putTree([...entries]), parents: [parent], message });
      state.refs.set(branch, sha);
      pushed(branch, sha);
      return sha;
    },
    fileAt,
    runsFor: (headSha) => state.runs.filter((r) => r.head_sha === headSha),
    close: () => new Promise((resolveClose) => {
      timers.forEach(clearTimeout);
      timers.clear();
      server.closeAllConnections();
      server.close(() => resolveClose());
    }),
  };
}

function parseArgs(argv) {
  const args = { port: 4010, seedFrom: null, manual: false, stepDelayMs: 200 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--seed-from') args.seedFrom = path.resolve(argv[++i]);
    else if (a === '--manual') args.manual = true;
    else if (a === '--step-delay') args.stepDelayMs = Number(argv[++i]);
    else throw new Error(`Unknown option ${a}. Use --port <n> --seed-from <website checkout> [--manual] [--step-delay <ms>].`);
  }
  if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) throw new Error('--port must be a whole number from 0 to 65535.');
  if (args.seedFrom && !fs.existsSync(path.join(args.seedFrom, 'data', 'site.json'))) {
    throw new Error(`--seed-from ${args.seedFrom} has no data/site.json. Point it at a donatelli-website checkout.`);
  }
  return args;
}

if (require.main === module) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  startMockGitHub({ port: args.port, seedFrom: args.seedFrom, autoProgress: !args.manual, stepDelayMs: args.stepDelayMs }).then((mock) => {
    console.log(`Mock GitHub for ${mock.state.repo} listening on ${mock.url}`);
    console.log(`  SITE_GITHUB_API_URL=${mock.url}`);
    console.log(`  SITE_LIVE_URL=${mock.liveUrl('main')}`);
    console.log(`  SITE_PREVIEW_URL=${mock.liveUrl('admin-preview')}`);
    console.log(args.manual
      ? `Runs wait until POST ${mock.url}/_mock/runs/<id>/complete with {"conclusion":"success"}.`
      : `Runs finish on their own, one step every ${args.stepDelayMs} ms.`);
    const stop = () => mock.close().then(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }, (err) => {
    console.error(`Mock GitHub did not start: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { startMockGitHub, SITE_JOBS, ROLLBACK_JOBS };
