'use strict';
// Website tools: the admin edits data/site.json in the website repo through the GitHub API, builds a
// preview commit on the preview branch, and publishes by fast-forwarding main to that exact commit
// once its preview run is green. GitHub Actions does every build and deploy; this server holds only
// the fine-grained PAT and never a Cloudflare credential.

const crypto = require('crypto');
const QRCode = require('qrcode');
const { body, param, query } = require('express-validator');
const {
  createGitHubClient,
  GitHubError,
  AuthError,
  NotFoundError,
  StaleError,
  RateLimitError,
  TimeoutError,
} = require('./github');
const siteSchema = require('./site-schema');
const { diff, apply, paths: pathsOf, overlaps, deepEqual } = require('./site-diff');
const { syncCredentials } = require('./credentials-sync');
const { computeStatus, formatTime, describePaths, newestFor } = require('./site-status');
const { createMutex } = require('./mutex');

// The only files an admin commit may write. The PAT can write the whole repo, so this list in code,
// not the configured paths, is what keeps a bad setting or a bug from rewriting build.mjs.
const ALLOWED_PATHS = ['data/site.json', 'outputs/data/credentials.json'];
const SITE_NAME = 'donatelli.tech';
const DRAFT_KEY = 'site_draft';
const CACHE_MS = 4000;
const LIVE_TIMEOUT_MS = 5000;
const MAX_DRAFT_BYTES = 64 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRY_WARNING_DAYS = 14;
const SHA_RE = /^[0-9a-f]{40}$/;
const TRAILER_RE = /^Admin-Audit-Id: ([0-9a-f-]{36})\s*$/m;
const NOT_CONFIGURED = { code: 'NOT_CONFIGURED', error: 'Publishing is off: SITE_GITHUB_TOKEN is not set on the admin server.' };

class PathNotAllowedError extends Error {
  constructor(path) {
    super(`Not written: ${path} is outside the files the admin may change (${ALLOWED_PATHS.join(', ')}). Check SITE_CONFIG_PATH and SITE_CREDENTIALS_PATH on the admin server.`);
    this.name = 'PathNotAllowedError';
    this.code = 'PATH_NOT_ALLOWED';
    this.path = path;
  }
}

// An expected refusal with its HTTP status and admin-facing copy.
class RouteError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function assertAllowedPath(path) {
  if (!ALLOWED_PATHS.includes(path)) throw new PathNotAllowedError(path);
}

// Every tree the admin writes goes through here, and the check runs before anything is sent.
async function writeTree(gh, { baseTree, files }) {
  for (const file of files) assertAllowedPath(file.path);
  return gh.createTree({ baseTree, files });
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const shortSha = (sha) => String(sha || '').slice(0, 7);
const sqliteUtcToIso = (value) => (value ? new Date(String(value).replace(' ', 'T') + 'Z').toISOString() : null);
const auditRefOf = (message) => {
  const m = TRAILER_RE.exec(message || '');
  return m ? m[1] : null;
};
const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

function sendError(res, err, next) {
  if (err instanceof RouteError) return res.status(err.status).json({ ok: false, code: err.code, error: err.message, ...err.extra });
  if (err instanceof PathNotAllowedError) return res.status(500).json({ ok: false, code: err.code, error: err.message });
  if (err instanceof RateLimitError) {
    if (err.retryAfterSeconds != null) res.set('Retry-After', String(err.retryAfterSeconds));
    return res.status(503).json({ ok: false, code: 'GITHUB_RATE_LIMITED', error: err.message, retryAfterSeconds: err.retryAfterSeconds });
  }
  if (err instanceof TimeoutError) return res.status(504).json({ ok: false, code: 'GITHUB_TIMEOUT', error: err.message });
  if (err instanceof AuthError) return res.status(502).json({ ok: false, code: 'GITHUB_AUTH', error: err.message });
  if (err instanceof NotFoundError) return res.status(502).json({ ok: false, code: 'GITHUB_NOT_FOUND', error: err.message });
  if (err instanceof GitHubError) return res.status(502).json({ ok: false, code: err.code === 'UNREACHABLE' ? 'GITHUB_UNREACHABLE' : 'GITHUB_ERROR', error: err.message });
  return next(err);
}

const route = (fn) => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch((err) => sendError(res, err, next));

// owner.name is derived from the two name parts (rule R1), so the three paths are one value.
const NAME_PATHS = ['owner.givenName', 'owner.familyName', 'owner.name'];

// The draft's own edits (base → draft) and which of them collide with what upstream changed (base →
// head). An edit head already holds is no longer the draft's, so it is neither a change nor a clash.
function rebaseDraft(baseValue, headValue, draftConfig) {
  const upstream = diff(baseValue, headValue);
  const mine = diff(baseValue, draftConfig).filter((c) => diff(apply(headValue, [c]), headValue).length > 0);
  let conflicts = pathsOf(mine).filter((p) => upstream.some((u) => overlaps(p, u.path)));
  // Dropping only the clashing owner.name would keep the other side's name part and break R1 in a
  // field the owner cannot type in, so a clash on any name path takes the whole name from head.
  if (conflicts.some((p) => NAME_PATHS.includes(p))) {
    conflicts = [...new Set([...conflicts, ...pathsOf(mine).filter((p) => NAME_PATHS.includes(p))])];
  }
  return { mine, conflicts };
}

// Strictly increasing, and time-based so a draft created after a delete never reuses an old number.
const nextRev = (prev, nowMs) => Math.max(nowMs, (Number.isInteger(prev) ? prev : 0) + 1);

function register(app, deps) {
  const {
    dbRun, dbGet, dbAll, logAudit, log, requireAuth, requireRole, csrfProtection, handleValidationErrors,
    rateLimit, keyByUser, config,
  } = deps;
  const fetchImpl = deps.fetch || globalThis.fetch;
  const clock = deps.now || (() => new Date());
  const site = config.site;
  const timeZone = config.timeZone;
  // lib/config.js already refuses to boot on this; the force-update below must never reach main.
  if (site.previewBranch === site.branch) throw new Error('SITE_PREVIEW_BRANCH must differ from SITE_GITHUB_BRANCH.');

  const gh = site.enabled
    ? createGitHubClient({ token: site.token, repo: site.repo, baseUrl: site.apiUrl, fetch: fetchImpl })
    : null;
  const serial = createMutex();
  // Every read-compare-write of the stored draft runs here, so two devices cannot interleave one.
  const draftSerial = createMutex();

  // GitHub reads are cached briefly so the status poll of several open tabs costs one set of calls.
  // Objects addressed by a commit SHA never change and are kept; everything else expires or is
  // dropped by the next write.
  const cache = new Map();
  function cached(key, fn, ttl = CACHE_MS) {
    const hit = cache.get(key);
    if (hit && (hit.ttl === Infinity || Date.now() - hit.at < hit.ttl)) return hit.promise;
    if (cache.size > 500) for (const [k, v] of cache) if (v.ttl === Infinity) cache.delete(k);
    const promise = Promise.resolve().then(fn);
    cache.set(key, { at: Date.now(), ttl, promise });
    promise.catch(() => cache.delete(key));
    return promise;
  }
  const forever = (key, fn) => cached(key, fn, Infinity);
  const invalidate = () => {
    for (const [key, value] of cache) if (value.ttl !== Infinity) cache.delete(key);
  };

  const commitAt = (sha) => forever(`commit:${sha}`, () => gh.getCommit(sha));
  const fileAt = (path, sha) => forever(`file:${path}@${sha}`, async () => {
    const file = await gh.getFile(path, sha);
    if (!file) return null;
    const value = parseJson(file.content);
    if (value === null) {
      throw new RouteError(502, 'SITE_FILE_INVALID', `${path} at commit ${shortSha(sha)} is not valid JSON. Fix it in the website repo, then reload.`);
    }
    return { text: file.content, sha: file.sha, value };
  });
  const previewRef = () => gh.getRef(site.previewBranch).catch((err) => {
    if (err instanceof NotFoundError) return null;
    throw err;
  });

  async function snapshot(sha) {
    const [commit, siteFile, schemaFile, credentials] = await Promise.all([
      commitAt(sha),
      fileAt(site.configPath, sha),
      fileAt(site.schemaPath, sha),
      fileAt(site.credentialsPath, sha),
    ]);
    if (!siteFile) {
      throw new RouteError(502, 'SITE_FILE_MISSING', `GitHub has no ${site.configPath} on ${site.branch}. Check SITE_GITHUB_REPO and SITE_CONFIG_PATH on the admin server.`);
    }
    if (!schemaFile) {
      throw new RouteError(502, 'SITE_FILE_MISSING', `GitHub has no ${site.schemaPath} on ${site.branch}. Check SITE_GITHUB_REPO and SITE_SCHEMA_PATH on the admin server.`);
    }
    return { sha, commit, site: siteFile, schema: schemaFile.value, credentials };
  }

  // Writes always start from the branch head as GitHub has it now, never from the cache.
  async function headSnapshot() {
    const { sha } = await gh.getRef(site.branch);
    return snapshot(sha);
  }

  const titlesFor = (schema) => Object.fromEntries(siteSchema.listFields(schema).filter((f) => f.title).map((f) => [f.path, f.title]));
  const todayIso = () => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(clock());

  function invalid(errors) {
    const n = errors.length;
    return new RouteError(422, 'INVALID', `Preview not built: ${n === 1 ? 'one field needs' : `${n} fields need`} a fix.`, { errors });
  }

  // --- Drafts (user_settings, one per owner, so the edit resumes on any device) ---

  async function loadDraft(userId) {
    const row = await dbGet('SELECT value FROM user_settings WHERE user_id = ? AND key = ?', [userId, DRAFT_KEY]);
    const draft = row && row.value ? parseJson(row.value) : null;
    if (!draft || !isPlainObject(draft.config)) return null;
    return {
      config: draft.config,
      baseSha: draft.baseSha || null,
      savedAt: draft.savedAt || null,
      previewSha: draft.previewSha || null,
      rev: Number.isInteger(draft.rev) ? draft.rev : 0,
    };
  }

  // previewSha names the preview commit built from exactly this draft, so a device that did not build it
  // can still tell that preview apart from one holding other changes. rev changes on every write, so a
  // page that loaded an older draft cannot overwrite a newer one without noticing.
  async function saveDraft(userId, { config: draftConfig, baseSha, previewSha = null, rev }) {
    const savedAt = clock().toISOString();
    await dbRun(
      `INSERT INTO user_settings (user_id, key, value, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
      [userId, DRAFT_KEY, JSON.stringify({ config: draftConfig, baseSha, savedAt, previewSha, rev })],
    );
    return savedAt;
  }

  const deleteDraft = (userId) => dbRun('DELETE FROM user_settings WHERE user_id = ? AND key = ?', [userId, DRAFT_KEY]);

  // Whether the stored draft is the one a request was made from: the same revision, or the same content.
  // A request with no rev (an older page) is taken as made from the stored draft, as before revisions.
  const madeFrom = (stored, { config: draftConfig, baseSha, rev }) => !stored
    || rev === undefined
    || stored.rev === rev
    || (stored.baseSha === baseSha && deepEqual(stored.config, draftConfig));

  // The draft's edits on top of the head commit. base is null when GitHub no longer has the draft's
  // base commit; target is null when an edit clashes with an upstream change.
  async function rebaseOnto(headSha, headValue, draftConfig, baseSha) {
    if (baseSha === headSha) return { base: { value: headValue }, mine: diff(headValue, draftConfig), conflicts: [], target: draftConfig };
    const base = baseSha ? await fileAt(site.configPath, baseSha).catch((err) => {
      if (err instanceof NotFoundError) return null;
      throw err;
    }) : null;
    if (!base) return { base: null, mine: [], conflicts: [], target: null };
    const { mine, conflicts } = rebaseDraft(base.value, headValue, draftConfig);
    return { base, mine, conflicts, target: conflicts.length ? null : apply(headValue, mine) };
  }

  // --- Preview, publish, revert ---

  async function buildPreview(req, { config: draftConfig, baseSha, rev, kind = 'preview', head: givenHead = null }) {
    const head = givenHead || await headSnapshot();
    const H = head.sha;
    const titles = titlesFor(head.schema);

    const rebased = await rebaseOnto(H, head.site.value, draftConfig, baseSha);
    const { base } = rebased;
    if (!base) {
      throw new RouteError(409, 'STALE', `Preview not built: this draft started from commit ${shortSha(baseSha)}, which GitHub no longer has. Discard the draft, then make the change again.`, { conflicts: [], mainSha: H });
    }

    // Read-only fields are judged against what the draft started from, so an upstream edit to one
    // of them is not blamed on the draft.
    const errors = [
      ...siteSchema.validate(head.schema, draftConfig),
      ...siteSchema.crossFieldErrors(draftConfig),
      ...siteSchema.readOnlyViolations(head.schema, base.value, draftConfig),
    ];
    if (errors.length) throw invalid(errors);

    let target = draftConfig;
    if (baseSha !== H) {
      const { mine, conflicts } = rebased;
      if (conflicts.length) {
        // Reloading then shows the upstream value in the clashing fields and keeps every other edit,
        // so the owner re-checks only what collided. A newer draft saved meanwhile is left alone.
        await draftSerial(async () => {
          const stored = await loadDraft(req.user.id);
          if (!madeFrom(stored, { config: draftConfig, baseSha, rev })) return;
          await saveDraft(req.user.id, {
            config: apply(head.site.value, mine.filter((c) => !conflicts.includes(c.path))),
            baseSha: H,
            rev: nextRev(stored && stored.rev, clock().getTime()),
          });
        });
        const when = formatTime(head.commit.date, timeZone, clock());
        throw new RouteError(409, 'STALE', `${SITE_NAME} changed on GitHub${when ? ` at ${when}` : ''} (commit ${shortSha(H)}) in the same fields: ${describePaths(conflicts, titles)}. Reload to get that change, then build the preview again.`, { conflicts, mainSha: H });
      }
      target = rebased.target;
      const rebasedErrors = [
        ...siteSchema.validate(head.schema, target),
        ...siteSchema.crossFieldErrors(target),
        ...siteSchema.readOnlyViolations(head.schema, head.site.value, target),
      ];
      if (rebasedErrors.length) throw invalid(rebasedErrors);
    }

    const changes = diff(head.site.value, target);
    if (changes.length === 0) {
      throw new RouteError(400, 'NO_CHANGE', kind === 'revert'
        ? `Nothing to restore: that version matches ${SITE_NAME}.`
        : `Nothing to preview: the draft matches ${SITE_NAME}.`);
    }

    const files = [];
    const siteText = JSON.stringify(target, null, 2) + '\n';
    if (siteText !== head.site.text) files.push({ path: site.configPath, content: siteText });
    if (head.credentials) {
      const synced = syncCredentials(head.credentials.text, target, todayIso());
      if (synced.changedKeys.length) files.push({ path: site.credentialsPath, content: synced.text });
    }

    const ref = crypto.randomUUID();
    const changedPaths = pathsOf(changes);
    const message = `site: ${changedPaths.join(', ').slice(0, 60)} (admin)\n\nAdmin-Audit-Id: ${ref}`;
    const tree = await writeTree(gh, { baseTree: head.commit.treeSha, files });
    const commit = await gh.createCommit({ message, treeSha: tree.sha, parents: [H] });
    await gh.setBranch(site.previewBranch, commit.sha, { force: true });
    invalidate();
    // The stored draft becomes what the preview holds, on the new main, unless a newer draft was saved
    // while GitHub worked: overwriting that would lose an edit the page already reported as saved.
    let draft = null;
    if (kind === 'preview') {
      draft = await draftSerial(async () => {
        const stored = await loadDraft(req.user.id);
        if (!madeFrom(stored, { config: draftConfig, baseSha, rev })) return null;
        const saved = { config: target, baseSha: H, previewSha: commit.sha, rev: nextRev(stored && stored.rev, clock().getTime()) };
        return { ...saved, savedAt: await saveDraft(req.user.id, saved) };
      });
    }

    const eventType = kind === 'revert' ? 'site_reverted' : 'site_preview_created';
    await logAudit(eventType, 'site', ref, { ref, commit: commit.sha, changedPaths }, req.user.id, req.user.organisationId);
    log(`[site] ${kind === 'revert' ? 'restore' : 'preview'} committed`, { commit: commit.sha, ref, changedPaths });
    return { commitSha: commit.sha, parentSha: H, changes, previewUrl: site.previewUrl, auditRef: ref, draft };
  }

  async function publish(req, commitSha) {
    const preview = await previewRef();
    if (!preview || preview.sha !== commitSha) {
      throw new RouteError(409, 'PREVIEW_MOVED', 'Not published: a newer preview replaced this one. Review the newer preview.');
    }
    const runs = await gh.listRuns({ workflow: site.workflow, branch: site.previewBranch, headSha: commitSha, perPage: 10 });
    const run = newestFor(runs, commitSha);
    if (!run || run.status !== 'completed' || run.conclusion !== 'success') {
      throw new RouteError(409, 'PREVIEW_NOT_GREEN', 'Not published: the preview has not passed QA yet. Wait for the green check, or open the run.', { run: run || null });
    }
    const [commit, main] = await Promise.all([commitAt(commitSha), gh.getRef(site.branch)]);
    const mainMoved = new RouteError(409, 'MAIN_MOVED', `Not published: ${SITE_NAME} changed since this preview. Build the preview again.`, { mainSha: main.sha });
    if (commit.parents.length !== 1 || commit.parents[0] !== main.sha) throw mainMoved;
    try {
      // A fast-forward only: GitHub refuses it if main moved after the check above.
      await gh.updateRef(site.branch, commitSha, { force: false });
    } catch (err) {
      if (err instanceof StaleError) throw mainMoved;
      throw err;
    }
    invalidate();
    const ref = auditRefOf(commit.message);
    await logAudit('site_published', 'site', ref || commitSha, { ref, commit: commitSha }, req.user.id, req.user.organisationId);
    // main has moved, so a problem carrying the draft over is logged, never reported as a failed publish.
    await settleDraft(req.user.id, commitSha).catch((err) => log('[site] draft not carried over the publish', { error: err.message }));
    log('[site] published', { commit: commitSha, ref });
    return { commitSha, mainSha: commitSha };
  }

  // Publish drops the draft only when the preview was built from it, or when nothing of it is left
  // after the publish. A restore, or a preview published from a page older than the draft, keeps the
  // draft's own edits, moved onto the new main.
  function settleDraft(userId, commitSha) {
    return draftSerial(async () => {
      const stored = await loadDraft(userId);
      if (!stored) return;
      if (stored.previewSha === commitSha) {
        await deleteDraft(userId);
        return;
      }
      const published = await fileAt(site.configPath, commitSha);
      const r = await rebaseOnto(commitSha, published.value, stored.config, stored.baseSha);
      // A clash or a missing base keeps the draft as it is; its next preview reports STALE.
      if (!r.base || r.conflicts.length) return;
      if (r.mine.length === 0) {
        await deleteDraft(userId);
        return;
      }
      await saveDraft(userId, { config: r.target, baseSha: commitSha, rev: nextRev(stored.rev, clock().getTime()) });
    });
  }

  // What restoring sha would make of site.json on the current main. The confirm dialog shows its diff
  // and revert builds it, so what the owner reads is what the preview commit holds.
  async function restoreTarget(head, sha) {
    const old = await fileAt(site.configPath, sha).catch((err) => {
      if (err instanceof NotFoundError) return null;
      throw err;
    });
    if (!old) throw new RouteError(404, 'NOT_FOUND', `Not restored: commit ${shortSha(sha)} has no ${site.configPath} on GitHub.`);
    // Read-only fields keep today's values: a restore never reaches past what the admin may edit.
    const restorable = diff(head.site.value, old.value).filter((c) => !siteSchema.isReadOnlyPath(head.schema, c.path));
    return apply(head.site.value, restorable);
  }

  async function revert(req, sha) {
    const head = await headSnapshot();
    return buildPreview(req, { config: await restoreTarget(head, sha), baseSha: head.sha, kind: 'revert', head });
  }

  // --- Status ---

  async function fetchBuildJson(baseUrl) {
    try {
      const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/build.json`, {
        headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
        signal: AbortSignal.timeout(LIVE_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const json = await res.json();
      if (!json || typeof json.commit !== 'string' || !SHA_RE.test(json.commit)) return null;
      return {
        commit: json.commit,
        builtAt: typeof json.builtAt === 'string' ? json.builtAt : null,
        source: typeof json.source === 'string' ? json.source : null,
      };
    } catch {
      return null;
    }
  }
  const liveBuild = () => cached('live:production', () => fetchBuildJson(site.liveUrl));
  const previewBuild = () => cached('live:preview', () => fetchBuildJson(site.previewUrl));
  const mainRuns = () => cached('runs:production', () => gh.listRuns({ workflow: site.workflow, branch: site.branch, perPage: 10 }));
  const previewRuns = () => cached('runs:preview', () => gh.listRuns({ workflow: site.workflow, branch: site.previewBranch, perPage: 10 }));
  // A finished run's jobs never change until it is re-run, which moves its start time and result.
  const jobsOf = (run) => (run.status === 'completed'
    ? forever(`jobs:${run.id}:${run.runStartedAt}:${run.updatedAt}:${run.conclusion}`, () => gh.getRunJobs(run.id))
    : cached(`jobs:${run.id}`, () => gh.getRunJobs(run.id)));

  async function siteAuditRows(eventTypes, limit) {
    const rows = await dbAll(
      `SELECT entity_id, entity_data, performed_at FROM audit_log
        WHERE entity_type = 'site' AND event_type IN (${eventTypes.map(() => '?').join(', ')})
        ORDER BY performed_at DESC, rowid DESC LIMIT ?`,
      [...eventTypes, limit],
    );
    return rows.map((r) => ({ id: r.entity_id, data: parseJson(r.entity_data) || {}, at: sqliteUtcToIso(r.performed_at) }));
  }

  // Which fields the main head changed: the audit entry named by its Admin-Audit-Id trailer, or,
  // for a commit made outside the admin, nothing (the status then names the commit instead).
  async function lastChangePaths(commit, titles) {
    const ref = auditRefOf(commit.message);
    if (!ref) return null;
    const rows = await dbAll(
      `SELECT entity_data FROM audit_log WHERE entity_type = 'site' AND entity_id = ?
        AND event_type IN ('site_preview_created', 'site_reverted') LIMIT 1`,
      [ref],
    );
    const data = rows[0] ? parseJson(rows[0].entity_data) : null;
    if (data && Array.isArray(data.changedPaths)) return data.changedPaths;
    // The subject lists the paths but is cut at 60 characters; keep only the ones that are whole.
    const m = /^site: (.*) \(admin\)$/.exec(commit.message.split('\n')[0]);
    return m ? m[1].split(', ').filter((p) => titles[p]) : null;
  }

  async function status() {
    const [main, preview] = await Promise.all([
      cached('ref:production', () => gh.getRef(site.branch)),
      cached('ref:preview', previewRef),
    ]);
    const mainSha = main.sha;
    const previewHead = preview ? preview.sha : null;
    const [mainCommit, previewCommit, runsMain, runsPreview, schemaFile, buildJson, previewBuildJson] = await Promise.all([
      commitAt(mainSha),
      previewHead ? commitAt(previewHead) : null,
      mainRuns(),
      previewRuns(),
      fileAt(site.schemaPath, mainSha).catch(() => null),
      liveBuild(),
      previewBuild(),
    ]);
    const jobsByRunId = {};
    const watched = [newestFor(runsMain, mainSha), newestFor(runsPreview, previewHead)].filter(Boolean);
    await Promise.all(watched.map(async (run) => {
      jobsByRunId[run.id] = await jobsOf(run);
    }));
    const titles = schemaFile ? titlesFor(schemaFile.value) : {};
    const published = (await siteAuditRows(['site_published'], 20)).find((r) => r.data.commit === mainSha);
    return computeStatus({
      configured: true,
      mainSha,
      mainCommittedAt: mainCommit.date,
      previewHead,
      previewParent: previewCommit ? previewCommit.parents[0] || null : null,
      previewCommittedAt: previewCommit ? previewCommit.date : null,
      mainRuns: runsMain,
      previewRuns: runsPreview,
      jobsByRunId,
      buildJson,
      previewBuildJson,
      now: clock(),
      timeZone,
      titlesByPath: titles,
      lastChangePaths: await lastChangePaths(mainCommit, titles),
      publishedAt: published ? published.at : null,
      urls: { production: site.liveUrl, preview: site.previewUrl },
    });
  }

  async function lastConnectionAt() {
    try {
      const row = await dbGet('SELECT MAX(received_at) AS last FROM connections');
      return row && row.last ? sqliteUtcToIso(row.last) : null;
    } catch (err) {
      // Until the connections migration has run there is no table, and so no connection yet.
      if (!/no such table/i.test(err.message)) log('[site] health could not read connections', { error: err.message });
      return null;
    }
  }

  // --- Routes ---

  const limiter = (windowMs, max, what) => rateLimit({
    windowMs,
    max,
    keyGenerator: keyByUser,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      const reset = req.rateLimit && req.rateLimit.resetTime ? req.rateLimit.resetTime.getTime() - Date.now() : windowMs;
      res.set('Cache-Control', 'no-store');
      res.status(429).json({ ok: false, code: 'RATE_LIMITED', error: `Too many ${what} requests. Try again in ${Math.max(1, Math.ceil(reset / 60000))} min.` });
    },
  });
  const siteReadLimiter = limiter(15 * 60 * 1000, 600, 'website');
  const draftLimiter = limiter(15 * 60 * 1000, 180, 'draft');
  const siteWriteLimiter = limiter(60 * 60 * 1000, 30, 'publishing');

  const noStore = (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  };
  const owner = [noStore, requireAuth, requireRole('owner')];
  const needsToken = (req, res, next) => (gh ? next() : res.status(503).json({ ok: false, ...NOT_CONFIGURED }));
  const reads = [...owner, siteReadLimiter, needsToken];
  const drafts = [...owner, draftLimiter, needsToken, csrfProtection];
  const writes = [...owner, siteWriteLimiter, needsToken, csrfProtection];
  // POST /validate changes nothing, so it spends the read allowance, but still carries CSRF.
  const checks = [...owner, siteReadLimiter, needsToken, csrfProtection];

  const sha40 = (field, what) => body(field).isString().withMessage(`${what} must be a 40-character commit SHA.`).bail()
    .matches(SHA_RE).withMessage(`${what} must be a 40-character commit SHA.`);
  const configBody = body('config').custom((value) => {
    if (!isPlainObject(value)) throw new Error('config must be the site.json object.');
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_DRAFT_BYTES) throw new Error('config is larger than 64 KB; site.json is a few KB.');
    return true;
  });

  app.get('/api/admin/site', ...owner, siteReadLimiter, route(async (req, res) => {
    if (!gh) return res.json({ configured: false });
    const head = await headSnapshot();
    let draft = await loadDraft(req.user.id);
    // A draft from before a commit landed on main is shown moved onto main, so the form, the Changes
    // table and the count show what its preview would commit, not the upstream fields going back.
    // Nothing is written: the next autosave stores it, and every read rebases it the same way.
    if (draft && draft.baseSha !== head.sha) {
      const r = await rebaseOnto(head.sha, head.site.value, draft.config, draft.baseSha);
      if (r.target) draft = { ...draft, config: r.target, baseSha: head.sha, previewSha: null, rebasedFrom: draft.baseSha };
      else if (r.base) draft = { ...draft, conflicts: r.conflicts };
    }
    res.json({
      configured: true,
      repo: site.repo,
      branches: { production: site.branch, preview: site.previewBranch },
      urls: { production: site.liveUrl, preview: site.previewUrl },
      main: { sha: head.sha, siteBlobSha: head.site.sha, credentialsBlobSha: head.credentials ? head.credentials.sha : null },
      config: head.site.value,
      schema: head.schema,
      fields: siteSchema.listFields(head.schema),
      draft,
      tokenExpiresAt: gh.tokenExpiresAt ? gh.tokenExpiresAt.toISOString() : null,
    });
  }));

  const revBody = body('rev').optional().isInt({ min: 0 }).withMessage('rev must be the draft revision this page loaded.').bail().toInt();

  app.post('/api/admin/site/draft', ...drafts, [configBody, sha40('baseSha', 'baseSha'), revBody], handleValidationErrors, route(async (req, res) => {
    const { config: draftConfig, baseSha, rev } = req.body;
    res.json(await draftSerial(async () => {
      const stored = await loadDraft(req.user.id);
      // Saving the same draft again (another device resuming it, or an autosave that a preview already
      // stored) changes nothing and keeps its preview.
      if (stored && stored.baseSha === baseSha && deepEqual(stored.config, draftConfig)) {
        return { savedAt: stored.savedAt, rev: stored.rev };
      }
      if (stored && rev !== undefined && rev !== stored.rev) {
        throw new RouteError(409, 'DRAFT_CHANGED', 'Draft not saved: it changed on another device or tab since this page loaded it. Reload to see that version.', { rev: stored.rev });
      }
      // Any edit drops the preview: it no longer holds this draft.
      const next = nextRev(stored ? stored.rev : rev, clock().getTime());
      const savedAt = await saveDraft(req.user.id, { config: draftConfig, baseSha, rev: next });
      return { savedAt, rev: next };
    }));
  }));

  app.delete('/api/admin/site/draft', ...drafts, route(async (req, res) => {
    await deleteDraft(req.user.id);
    res.json({ success: true });
  }));

  // With the draft's baseSha, this answers what Build preview would do: read-only fields judged against
  // the base, the draft's edits moved onto main, and the clashes named. Without it, or when GitHub no
  // longer has the base, the draft is compared with main as it stands.
  app.post('/api/admin/site/validate', ...checks, [configBody, body('baseSha').optional().isString().bail().matches(SHA_RE)
    .withMessage('baseSha must be a 40-character commit SHA.')], handleValidationErrors, route(async (req, res) => {
    const head = await snapshot((await cached('ref:production', () => gh.getRef(site.branch))).sha);
    const draftConfig = req.body.config;
    const r = req.body.baseSha ? await rebaseOnto(head.sha, head.site.value, draftConfig, req.body.baseSha) : null;
    const base = r && r.base ? r.base.value : head.site.value;
    const errors = [
      ...siteSchema.validate(head.schema, draftConfig),
      ...siteSchema.crossFieldErrors(draftConfig),
      ...siteSchema.readOnlyViolations(head.schema, base, draftConfig),
    ];
    if (!r || !r.base) return res.json({ errors, changes: diff(head.site.value, draftConfig), conflicts: [] });

    const seen = new Set(errors.map((e) => `${e.path}\n${e.message}`));
    const add = (e) => {
      const k = `${e.path}\n${e.message}`;
      if (!seen.has(k)) errors.push(e);
      seen.add(k);
    };
    for (const p of r.conflicts) add({ path: p, message: 'also changed on GitHub since this draft started. Build the preview to load that change.' });
    const target = r.target || apply(head.site.value, r.mine.filter((c) => !r.conflicts.includes(c.path)));
    if (r.target) [...siteSchema.validate(head.schema, target), ...siteSchema.crossFieldErrors(target)].forEach(add);
    res.json({ errors, changes: diff(head.site.value, target), conflicts: r.conflicts });
  }));

  app.post('/api/admin/site/preview', ...writes, [configBody, sha40('baseSha', 'baseSha'), revBody], handleValidationErrors, route(async (req, res) => {
    const out = await serial(() => buildPreview(req, { config: req.body.config, baseSha: req.body.baseSha, rev: req.body.rev }));
    res.status(202).json(out);
  }));

  app.post('/api/admin/site/publish', ...writes, [sha40('commitSha', 'commitSha')], handleValidationErrors, route(async (req, res) => {
    res.status(202).json(await serial(() => publish(req, req.body.commitSha)));
  }));

  app.post('/api/admin/site/revert', ...writes, [sha40('sha', 'sha')], handleValidationErrors, route(async (req, res) => {
    res.status(202).json(await serial(() => revert(req, req.body.sha)));
  }));

  app.get('/api/admin/site/status', ...reads, route(async (req, res) => {
    res.json(await status());
  }));

  app.get('/api/admin/site/runs', ...reads, [
    query('branch').optional().isIn([site.branch, site.previewBranch]).withMessage(`branch must be ${site.branch} or ${site.previewBranch}.`),
  ], handleValidationErrors, route(async (req, res) => {
    const items = req.query.branch === site.previewBranch ? await previewRuns() : await mainRuns();
    res.json({ items });
  }));

  app.get('/api/admin/site/history', ...reads, route(async (req, res) => {
    const commits = await cached('history', () => gh.listCommits({ path: site.configPath, sha: site.branch, perPage: 20 }));
    res.json({
      items: commits.map((c) => {
        const auditRef = auditRefOf(c.message);
        return { sha: c.sha, subject: c.message.split('\n')[0], date: c.date, via: auditRef ? 'admin' : 'git', auditRef };
      }),
    });
  }));

  // Read-only: the fields a restore of :sha would change against main, for the confirm before revert.
  app.get('/api/admin/site/history/:sha/changes', ...reads, [
    param('sha').matches(SHA_RE).withMessage('sha must be a 40-character commit SHA.'),
  ], handleValidationErrors, route(async (req, res) => {
    const head = await snapshot((await cached('ref:production', () => gh.getRef(site.branch))).sha);
    res.json({ sha: req.params.sha, mainSha: head.sha, changes: diff(head.site.value, await restoreTarget(head, req.params.sha)) });
  }));

  const runId = param('id').isInt({ min: 1 }).withMessage('The run ID must be a whole number.');

  app.post('/api/admin/site/runs/:id/rerun', ...writes, [runId], handleValidationErrors, route(async (req, res) => {
    const id = Number(req.params.id);
    await serial(() => gh.rerunFailedJobs(id));
    invalidate();
    await logAudit('site_run_rerun', 'site', String(id), { runId: id }, req.user.id, req.user.organisationId);
    res.json({ success: true });
  }));

  app.post('/api/admin/site/runs/:id/cancel', ...writes, [runId], handleValidationErrors, route(async (req, res) => {
    const id = Number(req.params.id);
    try {
      await serial(() => gh.cancelRun(id));
    } catch (err) {
      if (err instanceof GitHubError && err.status === 409) throw new RouteError(409, 'RUN_FINISHED', 'Not cancelled: the run already finished.');
      throw err;
    }
    invalidate();
    await logAudit('site_run_cancelled', 'site', String(id), { runId: id }, req.user.id, req.user.organisationId);
    res.json({ success: true });
  }));

  // A 204 dispatch names no run; GitHub creates it a moment later, so look for it a few times.
  async function dispatchAndFind(workflow, inputs) {
    const since = new Date(clock().getTime() - 10 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const out = await gh.dispatch(workflow, site.branch, inputs);
    if (out.runId) return out;
    for (let attempt = 0; attempt < 3; attempt++) {
      const run = await gh.findDispatchedRun(workflow, site.branch, since);
      if (run) return { runId: run.id, htmlUrl: run.htmlUrl };
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return { runId: null, htmlUrl: null };
  }

  app.post('/api/admin/site/redeploy', ...writes, route(async (req, res) => {
    const out = await serial(() => dispatchAndFind(site.workflow, {}));
    invalidate();
    await logAudit('site_redeploy_requested', 'site', out.runId ? String(out.runId) : crypto.randomUUID(), { runId: out.runId }, req.user.id, req.user.organisationId);
    log('[site] redeploy requested', { runId: out.runId });
    res.json(out);
  }));

  app.post('/api/admin/site/rollback', ...writes, [
    body('confirm').equals('ROLL BACK').withMessage('Not rolled back: type ROLL BACK to confirm.'),
    body('deploymentId').optional({ values: 'falsy' }).isString().bail().matches(/^[a-f0-9-]{8,64}$/)
      .withMessage('deploymentId must be a Cloudflare deployment ID (8 to 64 characters of a-f, 0-9 and -).'),
    body('dryRun').optional().custom((v) => typeof v === 'boolean').withMessage('dryRun must be true or false.'),
  ], handleValidationErrors, route(async (req, res) => {
    const deploymentId = req.body.deploymentId || null;
    const dryRun = req.body.dryRun === true;
    const out = await serial(() => dispatchAndFind(site.rollbackWorkflow, { deployment_id: deploymentId || '', dry_run: dryRun ? 'true' : 'false' }));
    invalidate();
    await logAudit('site_rollback_requested', 'site', crypto.randomUUID(), { dryRun, deploymentId }, req.user.id, req.user.organisationId);
    log('[site] rollback requested', { runId: out.runId, dryRun });
    res.json(out);
  }));

  // Health reports booleans and dates only. It answers without a token too: "token set: no" is
  // the first thing the owner needs to see.
  app.get('/api/admin/health', ...owner, siteReadLimiter, route(async (req, res) => {
    const github = { tokenSet: Boolean(gh), canReadRepo: false, tokenExpiresAt: null, expiresSoon: false, workflowFound: false, rollbackWorkflowFound: false };
    if (gh) {
      const ok = (promise) => promise.then(() => true, () => false);
      [github.canReadRepo, github.workflowFound, github.rollbackWorkflowFound] = await Promise.all([
        ok(gh.getRef(site.branch)),
        ok(gh.listRuns({ workflow: site.workflow, perPage: 1 })),
        ok(gh.listRuns({ workflow: site.rollbackWorkflow, perPage: 1 })),
      ]);
      const expires = gh.tokenExpiresAt;
      github.tokenExpiresAt = expires ? expires.toISOString() : null;
      github.expiresSoon = Boolean(expires) && expires.getTime() - clock().getTime() <= EXPIRY_WARNING_DAYS * DAY_MS;
    }
    const build = await liveBuild();
    // Ingest refuses every send unless an organisation has CONNECT_ORG_SLUG, and setup derives the
    // slug from whatever name was typed there, so a secret alone does not mean the form works.
    const orgSlug = config.connect ? config.connect.orgSlug : null;
    const [connectOrg, ownOrg] = await Promise.all([
      orgSlug ? dbGet('SELECT id FROM organisations WHERE slug = ?', [orgSlug]) : null,
      dbGet('SELECT slug FROM organisations WHERE id = ?', [req.user.organisationId]),
    ]);
    res.json({
      github,
      live: { buildJsonReachable: Boolean(build), liveSha: build ? build.commit : null },
      connect: {
        ingestSecretSet: Boolean(config.connect && config.connect.ingestSecret),
        orgSlug,
        orgFound: Boolean(connectOrg),
        ownerOrgSlug: ownOrg ? ownOrg.slug : null,
        lastReceivedAt: await lastConnectionAt(),
      },
      mail: { configured: Boolean(config.mailConfigured) },
      setup: { setupTokenPresent: Boolean(config.setupToken) },
      backups: { enabled: Boolean(config.backup && config.backup.intervalHours > 0) },
    });
  }));

  // The QR the owner prints or shares: the live card URL, never the admin host.
  app.get('/api/admin/card/qr.svg', ...owner, siteReadLimiter, [
    query('via').optional().isIn(['qr', 'nfc']).withMessage('via must be qr or nfc.'),
  ], handleValidationErrors, route(async (req, res) => {
    const via = req.query.via || 'qr';
    const svg = await QRCode.toString(`${site.liveUrl}/card/?via=${via}`, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 4,
      color: { dark: '#0E0D0C', light: '#FAF9F7' },
    });
    res.type('image/svg+xml').send(svg);
  }));

  return {};
}

module.exports = { register, ALLOWED_PATHS, assertAllowedPath, writeTree, PathNotAllowedError };
