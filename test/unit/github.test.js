'use strict';
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  createGitHubClient, parseExpiry, GitHubError, AuthError, NotFoundError, StaleError, RateLimitError, TimeoutError,
} = require('../../lib/github');
const { writeTree, assertAllowedPath, ALLOWED_PATHS, PathNotAllowedError } = require('../../lib/site-admin');

const TOKEN = 'test-token-unit-0123456789abcdefghijklmnopqrstuvwxyz';
const REPO = 'Njdonatelli/donatelli-website';
const API = 'https://api.github.example.com';
const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);

// A fetch that answers from a list of handlers in order and records every call.
function fakeFetch(...handlers) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const call = { url: new URL(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined, signal: init.signal };
    calls.push(call);
    const handler = handlers[Math.min(calls.length - 1, handlers.length - 1)];
    if (!handler) throw new Error(`Unexpected call ${call.method} ${url}`);
    return handler(call);
  };
  fn.calls = calls;
  return fn;
}

const json = (status, payload, headers = {}) => new Response(payload === undefined ? null : JSON.stringify(payload), {
  status,
  headers: { 'Content-Type': 'application/json', ...headers },
});

function client(fetch, extra = {}) {
  const sleeps = [];
  const gh = createGitHubClient({ token: TOKEN, repo: REPO, baseUrl: API, fetch, sleep: async (ms) => { sleeps.push(ms); }, ...extra });
  gh.sleeps = sleeps;
  return gh;
}

const errorOf = async (promise) => {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
};

describe('request basics', () => {
  test('every call sends the token, the pinned API version, JSON accept and the user agent', async () => {
    const fetch = fakeFetch(() => json(200, { object: { sha: SHA } }));
    const gh = client(fetch);
    assert.deepEqual(await gh.getRef('main'), { sha: SHA });
    const [call] = fetch.calls;
    assert.equal(call.url.toString(), `${API}/repos/${REPO}/git/ref/heads/main`);
    assert.equal(call.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(call.headers['X-GitHub-Api-Version'], '2026-03-10');
    assert.equal(call.headers.Accept, 'application/vnd.github+json');
    assert.equal(call.headers['User-Agent'], 'donatelli-admin');
    assert.ok(call.signal instanceof AbortSignal, 'every call carries a timeout signal');
  });

  test('the client refuses to start without a token or with a malformed repo', () => {
    assert.throws(() => createGitHubClient({ repo: REPO }), /needs a token/);
    assert.throws(() => createGitHubClient({ token: TOKEN, repo: 'no-slash' }), /owner\/name/);
  });

  test('getCommit, getFile, listRuns, getRunJobs and listCommits map GitHub shapes to the contract', async () => {
    const content = Buffer.from('{\n  "tagline": "Remote operations & automation"\n}\n').toString('base64').replace(/.{1,60}/g, '$&\n');
    const run = { id: 7, head_branch: 'admin-preview', head_sha: SHA, event: 'push', status: 'in_progress', conclusion: null, html_url: 'https://github.com/x/actions/runs/7', created_at: '2026-09-30T20:00:00Z', updated_at: '2026-09-30T20:01:00Z', run_started_at: '2026-09-30T20:00:05Z', extra: 1 };
    const fetch = fakeFetch(
      () => json(200, { sha: SHA, tree: { sha: SHA2 }, parents: [{ sha: SHA2 }], message: 'site: tagline (admin)', author: { date: '2026-09-30T19:00:00Z' }, committer: { date: '2026-09-30T19:00:01Z' } }),
      () => json(200, { type: 'file', encoding: 'base64', content, sha: SHA2 }),
      () => json(404, { message: 'Not Found' }),
      () => json(200, { total_count: 1, workflow_runs: [run] }),
      () => json(200, { jobs: [{ name: 'Build and QA', status: 'in_progress', conclusion: null, id: 1, steps: [{ name: 'Checkout', status: 'completed', conclusion: 'success', number: 2, started_at: 'x' }] }] }),
      () => json(200, [{ sha: SHA, commit: { message: 'site: tagline (admin)\n\nAdmin-Audit-Id: x', author: { name: 'Nick', date: '2026-09-30T19:00:00Z' }, committer: { date: '2026-09-30T19:00:01Z' } } }]),
    );
    const gh = client(fetch);
    assert.deepEqual(await gh.getCommit(SHA), { sha: SHA, treeSha: SHA2, parents: [SHA2], message: 'site: tagline (admin)', date: '2026-09-30T19:00:01Z' });
    assert.deepEqual(await gh.getFile('data/site.json', 'main'), { content: '{\n  "tagline": "Remote operations & automation"\n}\n', sha: SHA2 });
    assert.equal(await gh.getFile('data/missing.json', 'main'), null);
    assert.deepEqual(await gh.listRuns({ workflow: 'site.yml', branch: 'admin-preview', headSha: SHA, perPage: 5 }), [{
      id: 7, branch: 'admin-preview', headSha: SHA, event: 'push', status: 'in_progress', conclusion: null,
      htmlUrl: 'https://github.com/x/actions/runs/7', createdAt: '2026-09-30T20:00:00Z', updatedAt: '2026-09-30T20:01:00Z', runStartedAt: '2026-09-30T20:00:05Z',
    }]);
    assert.deepEqual(await gh.getRunJobs(7), [{ name: 'Build and QA', status: 'in_progress', conclusion: null, steps: [{ name: 'Checkout', status: 'completed', conclusion: 'success', number: 2 }] }]);
    assert.deepEqual(await gh.listCommits({ path: 'data/site.json', sha: 'main' }), [{ sha: SHA, message: 'site: tagline (admin)\n\nAdmin-Audit-Id: x', date: '2026-09-30T19:00:01Z', author: 'Nick' }]);

    const urls = fetch.calls.map((c) => c.url.pathname + c.url.search);
    assert.deepEqual(urls, [
      `/repos/${REPO}/git/commits/${SHA}`,
      `/repos/${REPO}/contents/data/site.json?ref=main`,
      `/repos/${REPO}/contents/data/missing.json?ref=main`,
      `/repos/${REPO}/actions/workflows/site.yml/runs?branch=admin-preview&head_sha=${SHA}&per_page=5`,
      `/repos/${REPO}/actions/runs/7/jobs?per_page=100`,
      `/repos/${REPO}/commits?path=data%2Fsite.json&sha=main&per_page=20`,
    ]);
  });
});

describe('writes', () => {
  test('createTree refuses to run without baseTree, before any request', async () => {
    const fetch = fakeFetch(() => json(201, { sha: SHA }));
    const gh = client(fetch);
    await assert.rejects(gh.createTree({ files: [{ path: 'data/site.json', content: '{}' }] }), /needs baseTree/);
    await assert.rejects(gh.createTree({ baseTree: '', files: [] }), /needs baseTree/);
    assert.equal(fetch.calls.length, 0);
  });

  test('createTree always sends base_tree with blob entries', async () => {
    const fetch = fakeFetch(() => json(201, { sha: SHA2 }));
    const gh = client(fetch);
    assert.deepEqual(await gh.createTree({ baseTree: SHA, files: [{ path: 'data/site.json', content: '{}\n' }] }), { sha: SHA2 });
    assert.equal(fetch.calls[0].method, 'POST');
    assert.deepEqual(fetch.calls[0].body, { base_tree: SHA, tree: [{ path: 'data/site.json', mode: '100644', type: 'blob', content: '{}\n' }] });
  });

  test('createCommit sends the tree and parents', async () => {
    const fetch = fakeFetch(() => json(201, { sha: SHA2 }));
    const gh = client(fetch);
    assert.deepEqual(await gh.createCommit({ message: 'm', treeSha: SHA, parents: [SHA2] }), { sha: SHA2 });
    assert.deepEqual(fetch.calls[0].body, { message: 'm', tree: SHA, parents: [SHA2] });
  });

  test('updateRef sends force:false unless force is exactly true', async () => {
    const fetch = fakeFetch(() => json(200, { object: { sha: SHA } }));
    const gh = client(fetch);
    await gh.updateRef('main', SHA);
    await gh.updateRef('main', SHA, { force: false });
    await gh.updateRef('main', SHA, { force: 'yes' });
    await gh.updateRef('admin-preview', SHA, { force: true });
    assert.deepEqual(fetch.calls.map((c) => [c.method, c.url.pathname, c.body]), [
      ['PATCH', `/repos/${REPO}/git/refs/heads/main`, { sha: SHA, force: false }],
      ['PATCH', `/repos/${REPO}/git/refs/heads/main`, { sha: SHA, force: false }],
      ['PATCH', `/repos/${REPO}/git/refs/heads/main`, { sha: SHA, force: false }],
      ['PATCH', `/repos/${REPO}/git/refs/heads/admin-preview`, { sha: SHA, force: true }],
    ]);
  });

  test('a refused fast-forward (422 or 409) is a StaleError', async () => {
    for (const status of [422, 409]) {
      const gh = client(fakeFetch(() => json(status, { message: 'Update is not a fast forward' })));
      const err = await errorOf(gh.updateRef('main', SHA));
      assert.ok(err instanceof StaleError, `status ${status}`);
      assert.ok(err instanceof GitHubError);
      assert.equal(err.status, status);
      assert.equal(err.code, 'STALE');
    }
  });

  test('setBranch creates the branch when GitHub says the reference does not exist', async () => {
    const fetch = fakeFetch(
      () => json(422, { message: 'Reference does not exist' }),
      () => json(201, { ref: 'refs/heads/admin-preview', object: { sha: SHA } }),
    );
    const gh = client(fetch);
    assert.deepEqual(await gh.setBranch('admin-preview', SHA, { force: true }), { sha: SHA });
    assert.deepEqual(fetch.calls.map((c) => [c.method, c.url.pathname, c.body]), [
      ['PATCH', `/repos/${REPO}/git/refs/heads/admin-preview`, { sha: SHA, force: true }],
      ['POST', `/repos/${REPO}/git/refs`, { ref: 'refs/heads/admin-preview', sha: SHA }],
    ]);
  });

  test('setBranch does not create a branch when the update was merely stale', async () => {
    const fetch = fakeFetch(() => json(422, { message: 'Update is not a fast forward' }));
    await assert.rejects(client(fetch).setBranch('main', SHA), StaleError);
    assert.equal(fetch.calls.length, 1);
  });

  test('getRef on a missing branch is a NotFoundError naming the branch', async () => {
    const err = await errorOf(client(fakeFetch(() => json(404, { message: 'Not Found' }))).getRef('admin-preview'));
    assert.ok(err instanceof NotFoundError);
    assert.equal(err.message, 'GitHub has no branch admin-preview.');
  });
});

describe('Actions', () => {
  test('dispatch returns the run from a 200 (API 2026-03-10)', async () => {
    const fetch = fakeFetch(() => json(200, { workflow_run_id: 99, run_url: `${API}/repos/${REPO}/actions/runs/99`, html_url: 'https://github.com/x/actions/runs/99' }));
    const out = await client(fetch).dispatch('rollback.yml', 'main', { dry_run: 'true', deployment_id: '' });
    assert.deepEqual(out, { runId: 99, htmlUrl: 'https://github.com/x/actions/runs/99' });
    assert.equal(fetch.calls[0].url.pathname, `/repos/${REPO}/actions/workflows/rollback.yml/dispatches`);
    assert.deepEqual(fetch.calls[0].body, { ref: 'main', inputs: { dry_run: 'true', deployment_id: '' } });
  });

  test('dispatch falls back to nulls on a 204, and findDispatchedRun looks the run up', async () => {
    const run = { id: 12, head_branch: 'main', head_sha: SHA, event: 'workflow_dispatch', status: 'queued', conclusion: null, html_url: 'h', created_at: 'c', updated_at: 'u' };
    const fetch = fakeFetch(() => new Response(null, { status: 204 }), () => json(200, { workflow_runs: [run] }));
    const gh = client(fetch);
    assert.deepEqual(await gh.dispatch('site.yml', 'main'), { runId: null, htmlUrl: null });
    assert.deepEqual(fetch.calls[0].body, { ref: 'main', inputs: {} });
    const found = await gh.findDispatchedRun('site.yml', 'main', '2026-09-30T20:00:00Z');
    assert.equal(found.id, 12);
    assert.equal(found.runStartedAt, null);
    const q = fetch.calls[1].url.searchParams;
    assert.deepEqual([q.get('event'), q.get('branch'), q.get('created')], ['workflow_dispatch', 'main', '>=2026-09-30T20:00:00Z']);
  });

  test('rerun and cancel post to the run', async () => {
    const fetch = fakeFetch(() => json(201, {}), () => json(202, {}));
    const gh = client(fetch);
    await gh.rerunFailedJobs(5);
    await gh.cancelRun(5);
    assert.deepEqual(fetch.calls.map((c) => [c.method, c.url.pathname]), [
      ['POST', `/repos/${REPO}/actions/runs/5/rerun-failed-jobs`],
      ['POST', `/repos/${REPO}/actions/runs/5/cancel`],
    ]);
  });
});

describe('failures', () => {
  test('401 and a non-rate-limit 403 are AuthErrors that never contain the token', async () => {
    for (const [status, message] of [[401, 'Bad credentials'], [403, 'Resource not accessible by personal access token']]) {
      const err = await errorOf(client(fakeFetch(() => json(status, { message }))).getRef('main'));
      assert.ok(err instanceof AuthError, `status ${status}`);
      assert.equal(err.message, `GitHub refused the token (status ${status}). Replace SITE_GITHUB_TOKEN on the admin server.`);
      assert.equal(err.code, 'GITHUB_AUTH');
      assert.ok(!JSON.stringify({ ...err, message: err.message, stack: err.stack }).includes(TOKEN));
    }
  });

  test('a rate limit with a short Retry-After waits and retries once', async () => {
    const fetch = fakeFetch(() => json(429, { message: 'slow down' }, { 'Retry-After': '2' }), () => json(200, { object: { sha: SHA } }));
    const gh = client(fetch);
    assert.deepEqual(await gh.getRef('main'), { sha: SHA });
    assert.deepEqual(gh.sleeps, [2000]);
    assert.equal(fetch.calls.length, 2);
  });

  test('a 403 secondary rate limit with a short Retry-After also retries once', async () => {
    const fetch = fakeFetch(() => json(403, { message: 'You have exceeded a secondary rate limit.' }, { 'Retry-After': '1' }), () => json(200, { object: { sha: SHA } }));
    const gh = client(fetch);
    assert.deepEqual(await gh.getRef('main'), { sha: SHA });
    assert.deepEqual(gh.sleeps, [1000]);
  });

  test('a long rate limit is a RateLimitError with the wait, and is not retried', async () => {
    const fetch = fakeFetch(() => json(429, { message: 'slow down' }, { 'Retry-After': '120' }));
    const err = await errorOf(client(fetch).getRef('main'));
    assert.ok(err instanceof RateLimitError);
    assert.equal(err.retryAfterSeconds, 120);
    assert.equal(err.message, "GitHub's rate limit for the token was reached. Try again in 2 min.");
    assert.equal(fetch.calls.length, 1);

    const reset = String(Math.floor(Date.now() / 1000) + 600);
    const primary = await errorOf(client(fakeFetch(() => json(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }))).getRef('main'));
    assert.ok(primary instanceof RateLimitError);
    assert.ok(primary.retryAfterSeconds > 590 && primary.retryAfterSeconds <= 600);
  });

  test('a rate limit after the one retry is reported, not retried again', async () => {
    const fetch = fakeFetch(() => json(429, {}, { 'Retry-After': '1' }));
    await assert.rejects(client(fetch).getRef('main'), RateLimitError);
    assert.equal(fetch.calls.length, 2);
  });

  test('a 5xx is retried once; a second 5xx is reported', async () => {
    const ok = fakeFetch(() => json(502, { message: 'Bad gateway' }), () => json(200, { object: { sha: SHA } }));
    assert.deepEqual(await client(ok).getRef('main'), { sha: SHA });
    assert.equal(ok.calls.length, 2);

    const bad = fakeFetch(() => json(503, { message: 'Service unavailable.' }));
    const err = await errorOf(client(bad).getRef('main'));
    assert.equal(bad.calls.length, 2);
    assert.ok(err instanceof GitHubError);
    assert.equal(err.status, 503);
    assert.equal(err.message, 'GitHub answered 503 to GET /git/ref/heads/main: Service unavailable.');
  });

  test('a request that outlives timeoutMs is a TimeoutError', async () => {
    const fetch = fakeFetch((call) => new Promise((resolve, reject) => {
      call.signal.addEventListener('abort', () => reject(call.signal.reason));
    }));
    // AbortSignal.timeout's timer does not hold the event loop open; the server's listener does.
    const keepAlive = setTimeout(() => {}, 5000);
    const err = await errorOf(client(fetch, { timeoutMs: 20 }).getRef('main'));
    clearTimeout(keepAlive);
    assert.ok(err instanceof TimeoutError);
    assert.equal(err.code, 'TIMEOUT');
    assert.equal(fetch.calls.length, 1, 'a timeout is not retried');
  });

  test('a network failure is an UNREACHABLE GitHubError', async () => {
    const fetch = fakeFetch(() => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); });
    const err = await errorOf(client(fetch).getRef('main'));
    assert.ok(err instanceof GitHubError);
    assert.equal(err.code, 'UNREACHABLE');
    assert.match(err.message, /ECONNREFUSED/);
  });

  test('no error message or property carries the token', async () => {
    const cases = [
      () => json(401, { message: 'Bad credentials' }),
      () => json(404, { message: 'Not Found' }),
      () => json(422, { message: 'Validation Failed' }),
      () => json(500, { message: 'boom' }),
      () => json(429, {}, { 'Retry-After': '999' }),
      () => { throw new TypeError('fetch failed'); },
    ];
    for (const handler of cases) {
      const err = await errorOf(client(fakeFetch(handler)).updateRef('main', SHA));
      const seen = [err.message, err.stack, JSON.stringify(err), String(err.githubMessage)].join('\n');
      assert.ok(!seen.includes(TOKEN), `${err.name}: ${err.message}`);
    }
  });
});

describe('token expiry', () => {
  test('parseExpiry reads the GitHub header forms', () => {
    assert.equal(parseExpiry('2026-12-29 17:00:00 UTC').toISOString(), '2026-12-29T17:00:00.000Z');
    assert.equal(parseExpiry('2026-12-29 09:00:00 -0800').toISOString(), '2026-12-29T17:00:00.000Z');
    assert.equal(parseExpiry('2026-12-29T17:00:00+01:00').toISOString(), '2026-12-29T16:00:00.000Z');
    assert.equal(parseExpiry(''), null);
    assert.equal(parseExpiry('soon'), null);
  });

  test('tokenExpiresAt is null until GitHub sends the header, then the last value seen', async () => {
    const fetch = fakeFetch(
      () => json(200, { object: { sha: SHA } }),
      () => json(200, { object: { sha: SHA } }, { 'github-authentication-token-expiration': '2026-12-29 17:00:00 UTC' }),
      () => json(200, { object: { sha: SHA } }),
      () => json(200, { object: { sha: SHA } }, { 'github-authentication-token-expiration': '2027-03-29 17:00:00 UTC' }),
    );
    const gh = client(fetch);
    await gh.getRef('main');
    assert.equal(gh.tokenExpiresAt, null);
    await gh.getRef('main');
    assert.equal(gh.tokenExpiresAt.toISOString(), '2026-12-29T17:00:00.000Z');
    await gh.getRef('main');
    assert.equal(gh.tokenExpiresAt.toISOString(), '2026-12-29T17:00:00.000Z', 'a response without the header keeps the last value');
    await gh.getRef('main');
    assert.equal(gh.tokenExpiresAt.toISOString(), '2027-03-29T17:00:00.000Z');
  });
});

describe('the admin write allowlist', () => {
  test('ALLOWED_PATHS is exactly site.json and the credentials registry', () => {
    assert.deepEqual(ALLOWED_PATHS, ['data/site.json', 'outputs/data/credentials.json']);
    for (const p of ALLOWED_PATHS) assert.doesNotThrow(() => assertAllowedPath(p));
  });

  test('a tree that writes build.mjs is refused before any request is sent', async () => {
    const fetch = fakeFetch(() => json(201, { sha: SHA2 }));
    const gh = client(fetch);
    for (const bad of ['build.mjs', '.github/workflows/site.yml', 'data/site.json/../../build.mjs', './data/site.json', 'DATA/site.json']) {
      const err = await errorOf(writeTree(gh, { baseTree: SHA, files: [{ path: 'data/site.json', content: '{}\n' }, { path: bad, content: 'x' }] }));
      assert.ok(err instanceof PathNotAllowedError, bad);
      assert.equal(err.code, 'PATH_NOT_ALLOWED');
    }
    assert.equal(fetch.calls.length, 0);

    await writeTree(gh, { baseTree: SHA, files: ALLOWED_PATHS.map((p) => ({ path: p, content: '{}\n' })) });
    assert.equal(fetch.calls.length, 1);
    assert.deepEqual(fetch.calls[0].body.tree.map((t) => t.path), ALLOWED_PATHS);
  });
});

// The site-admin routes on a plain express app, with GitHub replaced by the in-process mock and
// every GitHub request passing through a spy.
describe('site-admin routes through a fetch spy', () => {
  const express = require('express');
  const rateLimit = require('express-rate-limit');
  const { validationResult } = require('express-validator');
  const { createTestDb } = require('../helpers/db');
  const { startMockGitHub } = require('../../scripts/mock-github');
  const siteAdmin = require('../../lib/site-admin');

  let mock;
  let tdb;
  let server;
  let base;
  const spied = [];

  before(async () => {
    mock = await startMockGitHub({ autoProgress: false, token: TOKEN });
    tdb = await createTestDb();
    await tdb.dbRun("INSERT INTO organisations (id, name, slug) VALUES ('org-1', 'donatelli.tech', 'donatelli-tech')");
    await tdb.dbRun("INSERT INTO users (id, email, password_hash, organisation_id, role) VALUES ('user-1', 'owner@example.com', 'x', 'org-1', 'owner')");
    const spy = async (url, init = {}) => {
      spied.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers || {} });
      return fetch(url, init);
    };
    const app = express();
    app.use(express.json());
    const deps = {
      express,
      db: tdb.db,
      dbRun: tdb.dbRun,
      dbGet: tdb.dbGet,
      dbAll: tdb.dbAll,
      dbRunInfo: tdb.dbRunInfo,
      logAudit: (eventType, entityType, entityId, data, by, org) => tdb.dbRun(
        'INSERT INTO audit_log (id, event_type, entity_type, entity_id, entity_data, performed_by, organisation_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [require('crypto').randomUUID(), eventType, entityType, entityId, JSON.stringify(data), by, org],
      ),
      log: () => {},
      requireAuth: (req, res, next) => { req.user = { id: 'user-1', organisationId: 'org-1', role: 'owner' }; next(); },
      requireRole: () => (req, res, next) => next(),
      csrfProtection: (req, res, next) => next(),
      handleValidationErrors: (req, res, next) => {
        const errors = validationResult(req);
        return errors.isEmpty() ? next() : res.status(400).json({ error: errors.array()[0].msg });
      },
      rateLimit,
      keyByUser: (req) => (req.user?.id ? 'u:' + req.user.id : req.ip),
      config: {
        timeZone: 'America/Los_Angeles',
        mailConfigured: false,
        setupToken: null,
        connect: { ingestSecret: null },
        backup: { intervalHours: 0 },
        site: {
          enabled: true, token: TOKEN, repo: REPO, branch: 'main', previewBranch: 'admin-preview', workflow: 'site.yml', rollbackWorkflow: 'rollback.yml',
          configPath: 'data/site.json', schemaPath: 'data/site.schema.json', credentialsPath: 'outputs/data/credentials.json',
          liveUrl: mock.liveUrl('main'), previewUrl: mock.liveUrl('admin-preview'), apiUrl: mock.url,
        },
      },
      emailTransporter: null,
      escapeXml: (s) => s,
      fetch: spy,
      now: () => new Date(),
    };
    siteAdmin.register(app, deps);
    app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await mock.close();
    await tdb.close();
  });

  const call = async (method, path, payload) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: payload === undefined ? undefined : JSON.stringify(payload) });
    return { status: res.status, json: await res.json() };
  };

  test('preview, publish and a refused publish never send force:true for main', async () => {
    const site = await call('GET', '/api/admin/site');
    assert.equal(site.status, 200);
    const config = structuredClone(site.json.config);
    config.tagline = 'Remote operations and automation';

    const preview = await call('POST', '/api/admin/site/preview', { config, baseSha: site.json.main.sha });
    assert.equal(preview.status, 202, JSON.stringify(preview.json));
    const [run] = mock.runsFor(preview.json.commitSha);
    mock.completeRun(run.id, 'success');
    const published = await call('POST', '/api/admin/site/publish', { commitSha: preview.json.commitSha });
    assert.equal(published.status, 202, JSON.stringify(published.json));

    // A second preview, then main moves underneath it: the publish is refused as MAIN_MOVED.
    const again = structuredClone(config);
    again.owner.jobTitle = 'Operations consultant';
    const second = await call('POST', '/api/admin/site/preview', { config: again, baseSha: published.json.mainSha });
    assert.equal(second.status, 202, JSON.stringify(second.json));
    mock.completeRun(mock.runsFor(second.json.commitSha)[0].id, 'success');
    mock.pushCommit({ files: { 'README.md': 'moved\n' } });
    const refused = await call('POST', '/api/admin/site/publish', { commitSha: second.json.commitSha });
    assert.equal(refused.status, 409);
    assert.equal(refused.json.code, 'MAIN_MOVED');

    const refMoves = spied.filter((c) => c.method === 'PATCH' && /\/git\/refs\/heads\//.test(c.url));
    const toMain = refMoves.filter((c) => c.url.endsWith('/git/refs/heads/main'));
    assert.equal(toMain.length, 1, 'exactly one publish reached GitHub');
    for (const c of toMain) assert.equal(c.body.force, false);
    for (const c of refMoves.filter((m) => m.body.force === true)) assert.ok(c.url.endsWith('/git/refs/heads/admin-preview'), c.url);
    assert.ok(spied.every((c) => c.url.startsWith(mock.url) ? c.headers.Authorization === `Bearer ${TOKEN}` : !JSON.stringify(c).includes(TOKEN)),
      'the token goes to GitHub only, in the Authorization header');
    const trees = spied.filter((c) => c.method === 'POST' && c.url.endsWith('/git/trees'));
    assert.equal(trees.length, 2);
    for (const t of trees) {
      assert.ok(t.body.base_tree, 'base_tree is always sent');
      for (const item of t.body.tree) assert.ok(ALLOWED_PATHS.includes(item.path), item.path);
    }
  });
});
