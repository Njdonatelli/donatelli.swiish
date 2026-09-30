'use strict';
// GitHub REST client for the website tools: the Git data API (refs, commits, trees, contents) and
// the Actions API (runs, jobs, dispatch). It holds the fine-grained PAT, so no message, error or
// return value it builds ever contains the token.

const DEFAULT_API_VERSION = '2026-03-10';

class GitHubError extends Error {
  constructor(message, { status = 0, code = 'GITHUB_ERROR', githubMessage = null } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.code = code;
    this.githubMessage = githubMessage;
  }
}

class AuthError extends GitHubError {
  constructor(status, githubMessage) {
    super(`GitHub refused the token (status ${status}). Replace SITE_GITHUB_TOKEN on the admin server.`, { status, code: 'GITHUB_AUTH', githubMessage });
    this.name = 'AuthError';
  }
}

class NotFoundError extends GitHubError {
  constructor(what, githubMessage, status = 404) {
    super(`GitHub has no ${what}.`, { status, code: 'NOT_FOUND', githubMessage });
    this.name = 'NotFoundError';
  }
}

class StaleError extends GitHubError {
  constructor(branch, status, githubMessage) {
    super(`GitHub did not move ${branch}: it changed since it was read.`, { status, code: 'STALE', githubMessage });
    this.name = 'StaleError';
  }
}

class RateLimitError extends GitHubError {
  constructor(status, retryAfterSeconds, githubMessage) {
    const wait = retryAfterSeconds == null ? 'in a few minutes' : `in ${Math.max(1, Math.ceil(retryAfterSeconds / 60))} min`;
    super(`GitHub's rate limit for the token was reached. Try again ${wait}.`, { status, code: 'RATE_LIMITED', githubMessage });
    this.name = 'RateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

class TimeoutError extends GitHubError {
  constructor(timeoutMs) {
    super(`GitHub did not answer within ${Math.round(timeoutMs / 1000)} s. Try again.`, { status: 0, code: 'TIMEOUT' });
    this.name = 'TimeoutError';
  }
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const encodePath = (p) => String(p).split('/').map(encodeURIComponent).join('/');
const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fine-grained PATs report their expiry as "2026-12-29 17:00:00 UTC" (or with a numeric offset).
function parseExpiry(value) {
  if (!value) return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)\s*(UTC|GMT|Z|[+-]\d{2}:?\d{2})?$/i.exec(String(value).trim());
  let date;
  if (m) {
    let zone = m[3] ? m[3].toUpperCase() : 'Z';
    if (zone === 'UTC' || zone === 'GMT') zone = 'Z';
    else if (/^[+-]\d{4}$/.test(zone)) zone = `${zone.slice(0, 3)}:${zone.slice(3)}`;
    date = new Date(`${m[1]}T${m[2]}${zone}`);
  } else {
    date = new Date(value);
  }
  return Number.isNaN(date.getTime()) ? null : date;
}

function retryAfterSeconds(headers) {
  const retryAfter = headers.get('retry-after');
  if (retryAfter !== null && /^\d+$/.test(retryAfter.trim())) return Number(retryAfter.trim());
  if (headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(headers.get('x-ratelimit-reset'));
    if (Number.isFinite(reset) && reset > 0) return Math.max(0, Math.ceil(reset - Date.now() / 1000));
  }
  return null;
}

const toRun = (r) => ({
  id: r.id,
  branch: r.head_branch,
  headSha: r.head_sha,
  event: r.event,
  status: r.status,
  conclusion: r.conclusion,
  htmlUrl: r.html_url,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  runStartedAt: r.run_started_at || null,
});

function createGitHubClient({
  token,
  repo,
  baseUrl = 'https://api.github.com',
  apiVersion = DEFAULT_API_VERSION,
  fetch = globalThis.fetch,
  timeoutMs = 10000,
  userAgent = 'donatelli-admin',
  sleep = sleepFor,
} = {}) {
  if (!token) throw new Error('createGitHubClient needs a token.');
  if (!REPO_RE.test(String(repo || ''))) throw new Error('createGitHubClient needs repo as owner/name.');
  const root = `${String(baseUrl).replace(/\/+$/, '')}/repos/${repo}`;
  let tokenExpiresAt = null;

  async function send(method, path, { query, body } = {}) {
    const url = new URL(root + path);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': apiVersion,
      'User-Agent': userAgent,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    for (let attempt = 0; ; attempt++) {
      let res;
      let text;
      try {
        res = await fetch(url.toString(), {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        // The timeout also covers a body that stalls after the headers arrive.
        text = await res.text();
      } catch (err) {
        if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) throw new TimeoutError(timeoutMs);
        const cause = (err && err.cause && err.cause.code) || (err && err.code) || 'network error';
        throw new GitHubError(`GitHub did not answer (${cause}). Check the admin server's network, then try again.`, { code: 'UNREACHABLE' });
      }

      const expiry = parseExpiry(res.headers.get('github-authentication-token-expiration'));
      if (expiry) tokenExpiresAt = expiry;

      let json = null;
      if (text) {
        try { json = JSON.parse(text); } catch { json = null; }
      }
      if (res.ok) return { status: res.status, json };

      const githubMessage = json && typeof json.message === 'string' ? json.message : null;
      const { status } = res;
      if (status >= 500 && attempt === 0) {
        await sleep(500);
        continue;
      }
      if (status === 403 || status === 429) {
        const wait = retryAfterSeconds(res.headers);
        const limited = status === 429 || wait !== null || /rate limit/i.test(githubMessage || '');
        if (limited) {
          if (attempt === 0 && wait !== null && wait <= 10) {
            await sleep(wait * 1000);
            continue;
          }
          throw new RateLimitError(status, wait, githubMessage);
        }
      }
      if (status === 401 || status === 403) throw new AuthError(status, githubMessage);
      if (status === 404) throw new NotFoundError(`${method} ${path.split('?')[0]}`, githubMessage);
      const said = githubMessage ? `: ${githubMessage.replace(/[.\s]+$/, '')}` : '';
      throw new GitHubError(
        `GitHub answered ${status} to ${method} ${path.split('?')[0]}${said}.`,
        { status, githubMessage },
      );
    }
  }

  async function getRef(branch) {
    try {
      const { json } = await send('GET', `/git/ref/heads/${encodePath(branch)}`);
      return { sha: json.object.sha };
    } catch (err) {
      if (err instanceof NotFoundError) throw new NotFoundError(`branch ${branch}`, err.githubMessage);
      throw err;
    }
  }

  async function getCommit(sha) {
    const { json } = await send('GET', `/git/commits/${encodeURIComponent(sha)}`);
    return {
      sha: json.sha,
      treeSha: json.tree.sha,
      parents: (json.parents || []).map((p) => p.sha),
      message: json.message,
      date: (json.committer && json.committer.date) || (json.author && json.author.date) || null,
    };
  }

  async function getFile(path, ref) {
    let json;
    try {
      ({ json } = await send('GET', `/contents/${encodePath(path)}`, { query: { ref } }));
    } catch (err) {
      if (err instanceof NotFoundError) return null;
      throw err;
    }
    if (!json || json.type !== 'file') throw new GitHubError(`GitHub returned ${path} as a ${json ? json.type : 'blank'}, not a file.`);
    // The contents API leaves content empty for files over 1 MB; the website's data files are a few KB.
    if (json.encoding !== 'base64') throw new GitHubError(`GitHub did not return the text of ${path}: it is larger than 1 MB.`);
    return { content: Buffer.from(json.content, 'base64').toString('utf8'), sha: json.sha };
  }

  async function createTree({ baseTree, files }) {
    // Without base_tree GitHub builds a tree of only the listed files: every other file is deleted.
    if (!baseTree) throw new Error('createTree needs baseTree; without it the commit would delete every other file.');
    const tree = files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.content }));
    const { json } = await send('POST', '/git/trees', { body: { base_tree: baseTree, tree } });
    return { sha: json.sha };
  }

  async function createCommit({ message, treeSha, parents }) {
    const { json } = await send('POST', '/git/commits', { body: { message, tree: treeSha, parents } });
    return { sha: json.sha };
  }

  async function updateRef(branch, sha, { force = false } = {}) {
    try {
      const { json } = await send('PATCH', `/git/refs/heads/${encodePath(branch)}`, { body: { sha, force: force === true } });
      return { sha: json.object.sha };
    } catch (err) {
      if (err instanceof NotFoundError || /reference does not exist/i.test(err.githubMessage || '')) {
        throw new NotFoundError(`branch ${branch}`, err.githubMessage, err.status);
      }
      if (err.status === 409 || err.status === 422) throw new StaleError(branch, err.status, err.githubMessage);
      throw err;
    }
  }

  async function createRef(branch, sha) {
    const { json } = await send('POST', '/git/refs', { body: { ref: `refs/heads/${branch}`, sha } });
    return { sha: json.object.sha };
  }

  async function setBranch(branch, sha, { force = false } = {}) {
    try {
      return await updateRef(branch, sha, { force });
    } catch (err) {
      if (err instanceof NotFoundError) return createRef(branch, sha);
      throw err;
    }
  }

  async function listRuns({ workflow, branch, headSha, event, created, perPage = 10 } = {}) {
    const { json } = await send('GET', `/actions/workflows/${encodeURIComponent(workflow)}/runs`, {
      query: { branch, head_sha: headSha, event, created, per_page: perPage },
    });
    return (json.workflow_runs || []).map(toRun);
  }

  async function getRun(id) {
    const { json } = await send('GET', `/actions/runs/${encodeURIComponent(id)}`);
    return toRun(json);
  }

  async function getRunJobs(id) {
    const { json } = await send('GET', `/actions/runs/${encodeURIComponent(id)}/jobs`, { query: { per_page: 100 } });
    return (json.jobs || []).map((j) => ({
      name: j.name,
      status: j.status,
      conclusion: j.conclusion,
      steps: (j.steps || []).map((s) => ({ name: s.name, status: s.status, conclusion: s.conclusion, number: s.number })),
    }));
  }

  async function rerunFailedJobs(id) {
    await send('POST', `/actions/runs/${encodeURIComponent(id)}/rerun-failed-jobs`);
  }

  async function cancelRun(id) {
    await send('POST', `/actions/runs/${encodeURIComponent(id)}/cancel`);
  }

  // API version 2026-03-10 answers 200 with the new run; older versions (or a proxy) answer 204.
  async function dispatch(workflow, ref, inputs = {}) {
    const { status, json } = await send('POST', `/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, { body: { ref, inputs } });
    if (status === 200 && json && json.workflow_run_id) {
      return { runId: json.workflow_run_id, htmlUrl: json.html_url || null };
    }
    return { runId: null, htmlUrl: null };
  }

  async function findDispatchedRun(workflow, ref, sinceIso) {
    const runs = await listRuns({ workflow, branch: ref, event: 'workflow_dispatch', created: `>=${sinceIso}`, perPage: 5 });
    return runs[0] || null;
  }

  async function listCommits({ path, sha, perPage = 20 } = {}) {
    const { json } = await send('GET', '/commits', { query: { path, sha, per_page: perPage } });
    return (json || []).map((c) => ({
      sha: c.sha,
      message: c.commit.message,
      date: (c.commit.committer && c.commit.committer.date) || (c.commit.author && c.commit.author.date) || null,
      author: (c.commit.author && c.commit.author.name) || null,
    }));
  }

  return {
    getRef,
    getCommit,
    getFile,
    createTree,
    createCommit,
    updateRef,
    createRef,
    setBranch,
    listRuns,
    getRun,
    getRunJobs,
    rerunFailedJobs,
    cancelRun,
    dispatch,
    findDispatchedRun,
    listCommits,
    get tokenExpiresAt() {
      return tokenExpiresAt;
    },
  };
}

module.exports = {
  createGitHubClient,
  parseExpiry,
  GitHubError,
  AuthError,
  NotFoundError,
  StaleError,
  RateLimitError,
  TimeoutError,
  DEFAULT_API_VERSION,
};
