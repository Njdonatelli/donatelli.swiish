'use strict';
// The website tools end to end: the real server.js (temp-dir harness) against the in-process mock
// GitHub, driven the way the admin SPA drives it.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3');
const { startServer } = require('../helpers/server-harness');
const { createClient } = require('../helpers/cookie-jar');
const { seedMember } = require('../helpers/seed-member');
const { startMockGitHub } = require('../../scripts/mock-github');

const REPO = 'Njdonatelli/donatelli-website';
const OWNER = 'owner@example.com';
const MEMBER = 'member@example.com';
const PASSWORD = 'owner password 123';
const FIXTURES = path.join(__dirname, '..', 'fixtures', 'site');
const SITE_TEXT = fs.readFileSync(path.join(FIXTURES, 'site.json'), 'utf8');
const SITE = JSON.parse(SITE_TEXT);
const TZ = 'America/Los_Angeles';
const ALLOWED = ['data/site.json', 'outputs/data/credentials.json'];
const NOT_CONFIGURED = 'Publishing is off: SITE_GITHUB_TOKEN is not set on the admin server.';

let visitor = 0;
// Every response body a test sees, so the token check at the end covers all of them.
const seen = [];
function clientFor(srv) {
  const client = createClient(srv.url, { headers: { 'X-Forwarded-For': `198.51.100.${++visitor}` } });
  const wrap = (fn) => async (...args) => {
    const res = await fn(...args);
    seen.push(res.text);
    return res;
  };
  for (const key of ['get', 'post', 'del', 'request']) client[key] = wrap(client[key]);
  return client;
}

function query(dbFile, sql, params = []) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbFile, sqlite3.OPEN_READONLY, (openErr) => {
      if (openErr) return reject(openErr);
      db.all(sql, params, (err, rows) => db.close(() => (err ? reject(err) : resolve(rows))));
    });
  });
}

const todayInLA = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const expiryHeader = (date) => date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');

async function setupOwner(srv) {
  const owner = clientFor(srv);
  const res = await owner.setupOwner({ email: OWNER, password: PASSWORD, setupToken: srv.env.SETUP_TOKEN });
  assert.equal(res.status, 200, res.text);
  return owner;
}

async function memberOf(srv, owner) {
  await seedMember(srv.dbFile, { email: MEMBER, password: 'member password 1' });
  const member = clientFor(srv);
  assert.equal((await member.login(MEMBER, 'member password 1')).status, 200);
  return member;
}

describe('health when setup named the organisation something else', () => {
  let srv;
  before(async () => { srv = await startServer({ env: { SITE_GITHUB_TOKEN: undefined, SITE_LIVE_URL: 'http://127.0.0.1:9/live' } }); });
  after(() => srv.stop());

  test('the card form check fails and names the slug to set', async () => {
    const owner = clientFor(srv);
    const res = await owner.setupOwner({ email: OWNER, password: PASSWORD, setupToken: srv.env.SETUP_TOKEN, organisationName: 'Donatelli Services' });
    assert.equal(res.status, 200, res.text);
    const health = await owner.get('/api/admin/health');
    assert.equal(health.status, 200, health.text);
    assert.deepEqual(health.json.connect, {
      ingestSecretSet: true, orgSlug: 'donatelli-tech', orgFound: false, ownerOrgSlug: 'donatelli-services', lastReceivedAt: null,
    });
  });
});

describe('website tools without SITE_GITHUB_TOKEN', () => {
  let srv;
  let owner;

  before(async () => {
    // Port 9 on loopback refuses at once: the live-site check fails fast and never leaves this machine.
    srv = await startServer({ env: { SITE_GITHUB_TOKEN: undefined, SITE_LIVE_URL: 'http://127.0.0.1:9/live' } });
    owner = await setupOwner(srv);
  });
  after(() => srv.stop());

  test('GET /api/admin/site says configured:false', async () => {
    const res = await owner.get('/api/admin/site');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { configured: false });
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });

  test('every GitHub route answers 503 NOT_CONFIGURED', async () => {
    const sha = 'a'.repeat(40);
    const calls = [
      ['post', '/api/admin/site/draft', { config: SITE, baseSha: sha }],
      ['del', '/api/admin/site/draft'],
      ['post', '/api/admin/site/validate', { config: SITE }],
      ['post', '/api/admin/site/preview', { config: SITE, baseSha: sha }],
      ['post', '/api/admin/site/publish', { commitSha: sha }],
      ['post', '/api/admin/site/revert', { sha }],
      ['get', '/api/admin/site/status'],
      ['get', '/api/admin/site/runs?branch=main'],
      ['get', '/api/admin/site/history'],
      ['get', `/api/admin/site/history/${sha}/changes`],
      ['post', '/api/admin/site/runs/1/rerun', {}],
      ['post', '/api/admin/site/runs/1/cancel', {}],
      ['post', '/api/admin/site/redeploy', {}],
      ['post', '/api/admin/site/rollback', { confirm: 'ROLL BACK' }],
    ];
    for (const [method, url, payload] of calls) {
      const res = method === 'get' || method === 'del' ? await owner[method](url) : await owner.post(url, payload);
      assert.equal(res.status, 503, `${method} ${url}: ${res.text}`);
      assert.equal(res.json.code, 'NOT_CONFIGURED', url);
      assert.equal(res.json.error, NOT_CONFIGURED, url);
      assert.equal(res.headers.get('cache-control'), 'no-store', url);
    }
  });

  test('health still answers, and says the token is not set', async () => {
    const res = await owner.get('/api/admin/health');
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json, {
      github: { tokenSet: false, canReadRepo: false, tokenExpiresAt: null, expiresSoon: false, workflowFound: false, rollbackWorkflowFound: false },
      live: { buildJsonReachable: false, liveSha: null },
      connect: { ingestSecretSet: true, orgSlug: 'donatelli-tech', orgFound: true, ownerOrgSlug: 'donatelli-tech', lastReceivedAt: null },
      mail: { configured: false },
      setup: { setupTokenPresent: true },
      backups: { enabled: false },
    });
  });

  test('the card QR needs no GitHub', async () => {
    const res = await owner.get('/api/admin/card/qr.svg');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^image\/svg\+xml/);
    assert.match(res.text, /^<svg /);
    assert.match(res.text, /#0E0D0C/i);
    assert.match(res.text, /#FAF9F7/i);
  });

  test('anonymous callers get 401 and members 403 on every website route', async () => {
    const anon = clientFor(srv);
    for (const url of ['/api/admin/site', '/api/admin/site/status', '/api/admin/health', '/api/admin/card/qr.svg']) {
      assert.equal((await anon.get(url)).status, 401, url);
    }
    const member = await memberOf(srv, owner);
    for (const url of ['/api/admin/site', '/api/admin/site/status', '/api/admin/site/history', `/api/admin/site/history/${'a'.repeat(40)}/changes`, '/api/admin/health', '/api/admin/card/qr.svg']) {
      assert.equal((await member.get(url)).status, 403, url);
    }
    assert.equal((await member.post('/api/admin/site/redeploy', {})).status, 403);
  });
});

describe('website tools against the mock GitHub', () => {
  // Random per run and long enough that a chance match in a response is impossible.
  const TOKEN = 'test-token-' + crypto.randomBytes(30).toString('hex');
  const EXPIRES = new Date(Date.now() + 10 * 24 * 3600 * 1000);
  let mock;
  let srv;
  let owner;
  let seedSha;
  let p1;
  let p1Ref;
  let p2;
  let movedMain;

  const mainSha = () => mock.state.refs.get('main');
  const requests = (method, suffix) => mock.state.requests.filter((r) => r.method === method && r.path.endsWith(suffix));

  // The status is cached for 4 s on the server, so a change on the mock shows up within a few polls.
  async function statusUntil(check, what) {
    const deadline = Date.now() + 20000;
    let last;
    while (Date.now() < deadline) {
      last = await owner.get('/api/admin/site/status');
      assert.equal(last.status, 200, last.text);
      if (check(last.json)) return last.json;
      await new Promise((r) => setTimeout(r, 400));
    }
    assert.fail(`status never showed ${what}; last: ${JSON.stringify(last.json && { state: last.json.state, headline: last.json.headline })}`);
  }

  before(async () => {
    mock = await startMockGitHub({ autoProgress: false, token: TOKEN, tokenExpiresAt: expiryHeader(EXPIRES) });
    seedSha = mainSha();
    srv = await startServer({
      env: {
        SITE_GITHUB_TOKEN: TOKEN,
        SITE_GITHUB_REPO: REPO,
        SITE_GITHUB_API_URL: mock.url,
        SITE_LIVE_URL: mock.liveUrl('main'),
        SITE_PREVIEW_URL: mock.liveUrl('admin-preview'),
      },
    });
    owner = await setupOwner(srv);
  });
  after(async () => {
    await srv.stop();
    await mock.close();
  });

  test('GET /api/admin/site: main, its files, the form fields and the token expiry', async () => {
    const res = await owner.get('/api/admin/site');
    assert.equal(res.status, 200, res.text);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const s = res.json;
    assert.equal(s.configured, true);
    assert.equal(s.repo, REPO);
    assert.deepEqual(s.branches, { production: 'main', preview: 'admin-preview' });
    assert.deepEqual(s.urls, { production: mock.liveUrl('main'), preview: mock.liveUrl('admin-preview') });
    assert.equal(s.main.sha, seedSha);
    const blob = (text) => crypto.createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0${text}`).digest('hex');
    assert.equal(s.main.siteBlobSha, blob(SITE_TEXT));
    assert.equal(s.main.credentialsBlobSha, blob(fs.readFileSync(path.join(FIXTURES, 'credentials.json'), 'utf8')));
    assert.deepEqual(s.config, SITE);
    assert.equal(s.schema.$comment.slice(0, 22), 'Rules for data/site.js');
    assert.ok(s.fields.some((f) => f.path === 'tagline' && f.tab === 'website' && f.group === 'Brand'));
    assert.ok(s.fields.some((f) => f.path === 'owner.photo' && f.readOnly === true));
    assert.equal(s.draft, null);
    assert.equal(s.tokenExpiresAt, new Date(Math.floor(EXPIRES.getTime() / 1000) * 1000).toISOString());
  });

  test('a draft saves, resumes and is discarded', async () => {
    const config = { ...structuredClone(SITE), tagline: 'Remote operations and automation' };
    const saved = await owner.post('/api/admin/site/draft', { config, baseSha: seedSha });
    assert.equal(saved.status, 200, saved.text);
    assert.ok(!Number.isNaN(Date.parse(saved.json.savedAt)));
    assert.ok(Number.isInteger(saved.json.rev) && saved.json.rev > 0, 'each save returns the new revision');

    const resumed = (await owner.get('/api/admin/site')).json.draft;
    assert.deepEqual(resumed, { config, baseSha: seedSha, savedAt: saved.json.savedAt, previewSha: null, rev: saved.json.rev });

    assert.equal((await owner.post('/api/admin/site/draft', { config: [], baseSha: seedSha })).status, 400);
    assert.equal((await owner.post('/api/admin/site/draft', { config, baseSha: 'main' })).status, 400);
    assert.equal((await owner.post('/api/admin/site/draft', { config: { ...config, pad: 'x'.repeat(70 * 1024) }, baseSha: seedSha })).status, 400);
    assert.equal((await owner.post('/api/admin/site/draft', { config, baseSha: seedSha }, { csrf: false })).status, 403, 'drafts carry CSRF');

    const gone = await owner.del('/api/admin/site/draft');
    assert.deepEqual(gone.json, { success: true });
    assert.equal((await owner.get('/api/admin/site')).json.draft, null);
  });

  test('validate reports field errors, read-only moves and the changes against main', async () => {
    const config = structuredClone(SITE);
    config.tagline = '<b>Ops</b>';
    config.name = 'Donatelli';
    config.owner.jobTitle = 'Operations consultant';
    const res = await owner.post('/api/admin/site/validate', { config });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.errors, [
      { path: 'name', message: 'must be "donatelli.tech".' },
      { path: 'tagline', message: 'contains "<"; use plain text (no < > " backtick, and & only before a space).' },
      { path: 'name', message: 'This field is read-only in the admin.' },
    ]);
    assert.deepEqual(res.json.changes, [
      { path: 'name', from: 'donatelli.tech', to: 'Donatelli' },
      { path: 'tagline', from: 'Remote operations & automation', to: '<b>Ops</b>' },
      { path: 'owner.jobTitle', from: 'Operations & automation consultant', to: 'Operations consultant' },
    ]);
  });

  test('preview refuses an invalid draft (422) and a draft with no change (400)', async () => {
    const bad = structuredClone(SITE);
    bad.tagline = '<script>x</script>';
    bad.owner.photo = '/someone-else.webp';
    let res = await owner.post('/api/admin/site/preview', { config: bad, baseSha: seedSha });
    assert.equal(res.status, 422);
    assert.equal(res.json.code, 'INVALID');
    assert.deepEqual(res.json.errors.map((e) => e.path).sort(), ['owner.photo', 'tagline']);
    res = await owner.post('/api/admin/site/preview', { config: SITE, baseSha: seedSha });
    assert.equal(res.status, 400);
    assert.deepEqual(res.json, { ok: false, code: 'NO_CHANGE', error: 'Nothing to preview: the draft matches donatelli.tech.' });
    assert.equal(mock.state.refs.has('admin-preview'), false, 'nothing reached GitHub');
  });

  test('preview commits on admin-preview: base_tree, parent main, allowlisted files, audit trailer', async () => {
    const config = structuredClone(SITE);
    config.owner.jobTitle = 'Operations consultant';
    config.contactEmail = 'owner@example.com';
    const res = await owner.post('/api/admin/site/preview', { config, baseSha: seedSha });
    assert.equal(res.status, 202, res.text);
    p1 = res.json.commitSha;
    p1Ref = res.json.auditRef;
    assert.equal(res.json.parentSha, seedSha);
    assert.equal(res.json.previewUrl, mock.liveUrl('admin-preview'));
    assert.match(p1Ref, /^[0-9a-f-]{36}$/);
    assert.deepEqual(res.json.changes, [
      { path: 'contactEmail', from: 'hello@donatelli.tech', to: 'owner@example.com' },
      { path: 'owner.jobTitle', from: 'Operations & automation consultant', to: 'Operations consultant' },
    ]);

    assert.equal(mock.state.refs.get('admin-preview'), p1);
    const commit = mock.state.commits.get(p1);
    assert.deepEqual(commit.parents, [seedSha]);
    assert.equal(commit.message, `site: contactEmail, owner.jobTitle (admin)\n\nAdmin-Audit-Id: ${p1Ref}`);

    const [tree] = requests('POST', '/git/trees');
    assert.equal(tree.body.base_tree, mock.state.commits.get(seedSha).tree);
    assert.deepEqual(tree.body.tree.map((t) => t.path).sort(), ALLOWED);
    assert.equal(mock.fileAt(p1, 'data/site.json'), JSON.stringify(config, null, 2) + '\n');
    const creds = JSON.parse(mock.fileAt(p1, 'outputs/data/credentials.json'));
    assert.equal(creds.entries.contact_email.value, 'owner@example.com');
    assert.equal(creds.entries.contact_email.date, todayInLA());
    assert.equal(creds.entries.owner_name.date, '2026-09-14', 'unchanged entries keep their dates');
    // Every other file in the repo is carried over from main's tree
    assert.equal(mock.fileAt(p1, 'data/site.schema.json'), mock.fileAt(seedSha, 'data/site.schema.json'));

    // admin-preview did not exist yet: the force-update found no branch and created it.
    assert.deepEqual(requests('PATCH', '/git/refs/heads/admin-preview').map((r) => r.body), [{ sha: p1, force: true }]);
    assert.deepEqual(requests('POST', '/git/refs').map((r) => r.body), [{ ref: 'refs/heads/admin-preview', sha: p1 }]);

    const audit = await query(srv.dbFile, "SELECT entity_id, entity_data FROM audit_log WHERE event_type = 'site_preview_created'");
    assert.equal(audit.length, 1);
    assert.equal(audit[0].entity_id, p1Ref);
    assert.deepEqual(JSON.parse(audit[0].entity_data), { ref: p1Ref, commit: p1, changedPaths: ['contactEmail', 'owner.jobTitle'] });
  });

  // Another device resuming the draft learns which preview holds it, so it can offer Publish for that one
  // preview and no other.
  test('the draft remembers the preview built from it until the draft changes', async () => {
    let d = (await owner.get('/api/admin/site')).json.draft;
    assert.equal(d.previewSha, p1);
    assert.equal(d.baseSha, seedSha);
    assert.equal(d.config.owner.jobTitle, 'Operations consultant');

    await owner.post('/api/admin/site/draft', { config: d.config, baseSha: d.baseSha });
    assert.equal((await owner.get('/api/admin/site')).json.draft.previewSha, p1, 'the same draft saved again keeps it');

    const edited = { ...structuredClone(d.config), tagline: 'Remote operations and automation' };
    await owner.post('/api/admin/site/draft', { config: edited, baseSha: d.baseSha });
    d = (await owner.get('/api/admin/site')).json.draft;
    assert.equal(d.previewSha, null, 'an edited draft is not what the preview holds');
    await owner.post('/api/admin/site/draft', { config: structuredClone(SITE), baseSha: seedSha });
    assert.equal((await owner.get('/api/admin/site')).json.draft.previewSha, null, 'nor is one that went back to main');
  });

  test('status follows the preview run: building, step 2, then ready', async () => {
    let s = await statusUntil((x) => x.state === 'preview_building', 'the preview building');
    assert.equal(s.headline, 'Building preview. Step 1 of 4: Build.');
    assert.equal(s.preview.headSha, p1);
    assert.ok(s.preview.run && s.preview.run.id, 'the run is listed');
    const runId = s.preview.run.id;

    mock.advanceRun(runId, 'QA checks');
    s = await statusUntil((x) => x.step && x.step.index === 2, 'step 2');
    assert.equal(s.headline, 'Building preview. Step 2 of 4: QA.');
    assert.deepEqual(s.step, { index: 2, count: 4, name: 'QA' });

    const early = await owner.post('/api/admin/site/publish', { commitSha: p1 });
    assert.equal(early.status, 409);
    assert.equal(early.json.code, 'PREVIEW_NOT_GREEN');
    assert.equal(early.json.error, 'Not published: the preview has not passed QA yet. Wait for the green check, or open the run.');

    mock.completeRun(runId, 'success');
    s = await statusUntil((x) => x.state === 'preview_ready', 'the preview ready');
    assert.match(s.headline, /^Preview ready at \d{1,2}:\d{2} [AP]M\. QA passed\.$/);
    assert.equal(s.preview.publishable, true);
    assert.equal(s.production.mainSha, seedSha);
  });

  test('publish refuses a preview that is not the admin-preview head', async () => {
    const res = await owner.post('/api/admin/site/publish', { commitSha: 'c'.repeat(40) });
    assert.equal(res.status, 409);
    assert.deepEqual(res.json, { ok: false, code: 'PREVIEW_MOVED', error: 'Not published: a newer preview replaced this one. Review the newer preview.' });
  });

  test('publish fast-forwards main to the green preview (force:false) and drops the draft', async () => {
    await owner.post('/api/admin/site/draft', { config: structuredClone(SITE), baseSha: seedSha });
    const res = await owner.post('/api/admin/site/publish', { commitSha: p1 });
    assert.equal(res.status, 202, res.text);
    assert.deepEqual(res.json, { commitSha: p1, mainSha: p1 });
    assert.equal(mainSha(), p1);
    assert.deepEqual(requests('PATCH', '/git/refs/heads/main').map((r) => r.body), [{ sha: p1, force: false }]);
    assert.equal((await owner.get('/api/admin/site')).json.draft, null);
    const audit = await query(srv.dbFile, "SELECT entity_id, entity_data FROM audit_log WHERE event_type = 'site_published'");
    assert.deepEqual(audit.map((a) => [a.entity_id, JSON.parse(a.entity_data)]), [[p1Ref, { ref: p1Ref, commit: p1 }]]);
  });

  test('status follows the production run to live, naming the changed fields', async () => {
    let s = await statusUntil((x) => x.state === 'publishing', 'publishing');
    assert.match(s.headline, /^Publishing\. Step 1 of 4: Build\./);
    const runId = s.production.run.id;
    assert.equal(s.production.run.headSha, p1);

    mock.advanceRun(runId, 'Deploy to Cloudflare');
    s = await statusUntil((x) => x.step && x.step.index === 3, 'the deploy step');
    // The seed run took 90 s, so there is an estimate.
    assert.match(s.headline, /^Publishing\. Step 3 of 4: Deploy\. About \d+ min left\.$/);
    assert.equal(typeof s.etaSeconds, 'number');

    mock.completeRun(runId, 'success');
    s = await statusUntil((x) => x.state === 'live', 'live');
    assert.match(s.headline, /^Live since \d{1,2}:\d{2} [AP]M\. Last change: public email and job title\.$/);
    assert.equal(s.production.liveSha, p1);
    assert.equal(s.preview.publishable, false, 'a published preview is spent');
  });

  test('history marks admin commits and git commits', async () => {
    const res = await owner.get('/api/admin/site/history');
    assert.equal(res.status, 200, res.text);
    const [latest] = res.json.items;
    assert.deepEqual(latest, { sha: p1, subject: 'site: contactEmail, owner.jobTitle (admin)', date: latest.date, via: 'admin', auditRef: p1Ref });
    const seed = res.json.items[res.json.items.length - 1];
    assert.equal(seed.sha, seedSha);
    assert.equal(seed.via, 'git');
    assert.equal(seed.auditRef, null);
  });

  test('a failed preview, its re-run, then main moves under it: MAIN_MOVED', async () => {
    const config = structuredClone((await owner.get('/api/admin/site')).json.config);
    config.tagline = 'Remote operations and automation';
    const res = await owner.post('/api/admin/site/preview', { config, baseSha: p1 });
    assert.equal(res.status, 202, res.text);
    p2 = res.json.commitSha;
    const [run] = mock.runsFor(p2);

    mock.completeRun(run.id, 'failure', { failedStep: 'QA checks' });
    let s = await statusUntil((x) => x.state === 'preview_failed', 'the failed preview');
    assert.equal(s.headline, 'Preview not built: the QA check failed. Open the log, fix the field, and build the preview again.');
    assert.equal(s.detail, 'The "QA checks" step failed.');

    const rerun = await owner.post(`/api/admin/site/runs/${run.id}/rerun`, {});
    assert.deepEqual(rerun.json, { success: true });
    s = await statusUntil((x) => x.state === 'preview_building', 'the re-run');
    mock.completeRun(run.id, 'success');
    s = await statusUntil((x) => x.state === 'preview_ready', 'the re-run passing');

    const upstream = structuredClone(config);
    upstream.tagline = SITE.tagline;
    upstream.year = 2027;
    movedMain = mock.pushCommit({ files: { 'data/site.json': JSON.stringify(upstream, null, 2) + '\n' }, message: 'Bump the copyright year' });
    const refused = await owner.post('/api/admin/site/publish', { commitSha: p2 });
    assert.equal(refused.status, 409);
    assert.equal(refused.json.code, 'MAIN_MOVED');
    assert.equal(refused.json.error, 'Not published: donatelli.tech changed since this preview. Build the preview again.');
    assert.equal(mainSha(), movedMain);
  });

  test('a draft on an older main is rebased when upstream touched other fields', async () => {
    const config = structuredClone(mock.state && JSON.parse(mock.fileAt(p1, 'data/site.json')));
    config.tagline = 'Remote operations and automation';
    const res = await owner.post('/api/admin/site/preview', { config, baseSha: p1 });
    assert.equal(res.status, 202, res.text);
    assert.equal(res.json.parentSha, movedMain);
    assert.deepEqual(res.json.changes, [{ path: 'tagline', from: 'Remote operations & automation', to: 'Remote operations and automation' }]);
    const built = JSON.parse(mock.fileAt(res.json.commitSha, 'data/site.json'));
    assert.equal(built.year, 2027, 'the upstream change is kept');
    assert.equal(built.tagline, 'Remote operations and automation', 'the draft change is applied');
  });

  test('a draft on an older main that edits the same field is STALE, and the stored draft is rebased', async () => {
    const config = JSON.parse(mock.fileAt(p1, 'data/site.json'));
    config.year = 2028;
    config.owner.city = 'Carlsbad';
    await owner.post('/api/admin/site/draft', { config, baseSha: p1 });
    const res = await owner.post('/api/admin/site/preview', { config, baseSha: p1 });
    assert.equal(res.status, 409);
    assert.equal(res.json.code, 'STALE');
    assert.deepEqual(res.json.conflicts, ['year']);
    assert.equal(res.json.mainSha, movedMain);
    assert.match(res.json.error, new RegExp(`^donatelli\\.tech changed on GitHub at \\d{1,2}:\\d{2} [AP]M \\(commit ${movedMain.slice(0, 7)}\\) in the same fields: copyright year\\. Reload to get that change, then build the preview again\\.$`));

    const draft = (await owner.get('/api/admin/site')).json.draft;
    assert.equal(draft.baseSha, movedMain);
    assert.equal(draft.config.year, 2027, 'the clashing field shows the upstream value');
    assert.equal(draft.config.owner.city, 'Carlsbad', 'other edits are kept');
  });

  test('revert builds a new preview that restores an old version (read-only fields excepted)', async () => {
    // The confirm dialog reads the changes first; the revert must then commit exactly those.
    const before = await owner.get(`/api/admin/site/history/${seedSha}/changes`);
    assert.equal(before.status, 200, before.text);
    assert.equal(before.json.mainSha, movedMain);
    assert.ok(before.json.changes.length > 0);
    assert.equal(mainSha(), movedMain, 'reading the changes moved nothing');

    const res = await owner.post('/api/admin/site/revert', { sha: seedSha });
    assert.equal(res.status, 202, res.text);
    assert.equal(res.json.parentSha, movedMain);
    assert.deepEqual(res.json.changes, before.json.changes);
    assert.equal(mock.fileAt(res.json.commitSha, 'data/site.json'), SITE_TEXT);
    const creds = JSON.parse(mock.fileAt(res.json.commitSha, 'outputs/data/credentials.json'));
    assert.equal(creds.entries.contact_email.value, 'hello@donatelli.tech');
    const audit = await query(srv.dbFile, "SELECT entity_id, entity_data FROM audit_log WHERE event_type = 'site_reverted'");
    assert.equal(audit.length, 1);
    assert.deepEqual(JSON.parse(audit[0].entity_data).commit, res.json.commitSha);
    assert.equal(audit[0].entity_id, res.json.auditRef);

    const missing = await owner.post('/api/admin/site/revert', { sha: 'd'.repeat(40) });
    assert.equal(missing.status, 404);
    assert.equal(missing.json.code, 'NOT_FOUND');
    const missingChanges = await owner.get(`/api/admin/site/history/${'d'.repeat(40)}/changes`);
    assert.equal(missingChanges.status, 404);
    assert.equal(missingChanges.json.code, 'NOT_FOUND');
    assert.equal((await owner.get('/api/admin/site/history/main/changes')).status, 400);
  });

  test('runs list per branch; cancel a queued run once', async () => {
    const main = await owner.get('/api/admin/site/runs?branch=main');
    assert.equal(main.status, 200, main.text);
    assert.ok(main.json.items.length >= 2);
    assert.ok(main.json.items.every((r) => r.branch === 'main'));
    const preview = await owner.get('/api/admin/site/runs?branch=admin-preview');
    const queued = preview.json.items.find((r) => r.status === 'queued');
    assert.ok(queued, 'the revert preview run is queued');
    assert.equal((await owner.get('/api/admin/site/runs?branch=feature')).status, 400);

    assert.deepEqual((await owner.post(`/api/admin/site/runs/${queued.id}/cancel`, {})).json, { success: true });
    const again = await owner.post(`/api/admin/site/runs/${queued.id}/cancel`, {});
    assert.equal(again.status, 409);
    assert.deepEqual(again.json, { ok: false, code: 'RUN_FINISHED', error: 'Not cancelled: the run already finished.' });
    assert.equal((await owner.post('/api/admin/site/runs/abc/cancel', {})).status, 400);
    const audit = await query(srv.dbFile, "SELECT entity_data FROM audit_log WHERE event_type = 'site_run_cancelled'");
    assert.deepEqual(audit.map((a) => JSON.parse(a.entity_data)), [{ runId: queued.id }]);
  });

  test('redeploy dispatches site.yml on main, with the 204 fallback too', async () => {
    let res = await owner.post('/api/admin/site/redeploy', {});
    assert.equal(res.status, 200, res.text);
    assert.equal(typeof res.json.runId, 'number');
    assert.match(res.json.htmlUrl, /\/actions\/runs\/\d+$/);
    const dispatches = requests('POST', '/actions/workflows/site.yml/dispatches');
    assert.deepEqual(dispatches.map((d) => d.body), [{ ref: 'main', inputs: {} }]);

    mock.state.dispatch204 = true;
    try {
      res = await owner.post('/api/admin/site/redeploy', {});
    } finally {
      mock.state.dispatch204 = false;
    }
    assert.equal(res.status, 200, res.text);
    assert.equal(typeof res.json.runId, 'number', 'the run was found by listing dispatch runs');
    const run = mock.state.runs.find((r) => r.id === res.json.runId);
    assert.equal(run.event, 'workflow_dispatch');
    assert.equal(run.head_branch, 'main');
    const audit = await query(srv.dbFile, "SELECT entity_data FROM audit_log WHERE event_type = 'site_redeploy_requested'");
    assert.equal(audit.length, 2);
  });

  test('rollback needs the typed confirm and dispatches rollback.yml with its inputs', async () => {
    let res = await owner.post('/api/admin/site/rollback', { confirm: 'roll back' });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'Not rolled back: type ROLL BACK to confirm.');
    res = await owner.post('/api/admin/site/rollback', { confirm: 'ROLL BACK', deploymentId: 'not an id!' });
    assert.equal(res.status, 400);
    res = await owner.post('/api/admin/site/rollback', { confirm: 'ROLL BACK', dryRun: 'yes' });
    assert.equal(res.status, 400);

    res = await owner.post('/api/admin/site/rollback', { confirm: 'ROLL BACK', dryRun: true });
    assert.equal(res.status, 200, res.text);
    assert.equal(typeof res.json.runId, 'number');
    res = await owner.post('/api/admin/site/rollback', { confirm: 'ROLL BACK', deploymentId: '0a1b2c3d-4e5f-6789-abcd-ef0123456789' });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(requests('POST', '/actions/workflows/rollback.yml/dispatches').map((d) => d.body), [
      { ref: 'main', inputs: { deployment_id: '', dry_run: 'true' } },
      { ref: 'main', inputs: { deployment_id: '0a1b2c3d-4e5f-6789-abcd-ef0123456789', dry_run: 'false' } },
    ]);
    const audit = await query(srv.dbFile, "SELECT entity_data FROM audit_log WHERE event_type = 'site_rollback_requested' ORDER BY rowid");
    assert.deepEqual(audit.map((a) => JSON.parse(a.entity_data)), [
      { dryRun: true, deploymentId: null },
      { dryRun: false, deploymentId: '0a1b2c3d-4e5f-6789-abcd-ef0123456789' },
    ]);
  });

  test('health: GitHub reachable, workflows found, token expiring within 14 days', async () => {
    const res = await owner.get('/api/admin/health');
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json, {
      github: {
        tokenSet: true,
        canReadRepo: true,
        tokenExpiresAt: new Date(Math.floor(EXPIRES.getTime() / 1000) * 1000).toISOString(),
        expiresSoon: true,
        workflowFound: true,
        rollbackWorkflowFound: true,
      },
      live: { buildJsonReachable: true, liveSha: mock.state.live.get('main').commit },
      connect: { ingestSecretSet: true, orgSlug: 'donatelli-tech', orgFound: true, ownerOrgSlug: 'donatelli-tech', lastReceivedAt: null },
      mail: { configured: false },
      setup: { setupTokenPresent: true },
      backups: { enabled: false },
    });
  });

  test('health reports a missing workflow as not found', async () => {
    mock.state.workflows.delete('rollback.yml');
    try {
      const res = await owner.get('/api/admin/health');
      assert.equal(res.json.github.workflowFound, true);
      assert.equal(res.json.github.rollbackWorkflowFound, false);
    } finally {
      mock.state.workflows.add('rollback.yml');
    }
  });

  test('the card QR encodes the live card URL for qr or nfc', async () => {
    assert.equal((await owner.get('/api/admin/card/qr.svg?via=nfc')).status, 200);
    assert.equal((await owner.get('/api/admin/card/qr.svg?via=email')).status, 400);
  });

  test('every website response is no-store', async () => {
    for (const url of ['/api/admin/site', '/api/admin/site/status', '/api/admin/site/history', '/api/admin/site/runs', '/api/admin/health', '/api/admin/card/qr.svg']) {
      assert.equal((await owner.get(url)).headers.get('cache-control'), 'no-store', url);
    }
  });

  test('the token never appears in a response, the server output or server.log; GitHub got it only as a Bearer header', async () => {
    assert.ok(seen.length > 50, `checked ${seen.length} responses`);
    for (const text of seen) assert.ok(!text.includes(TOKEN), text.slice(0, 200));
    assert.ok(!srv.output().includes(TOKEN), 'server stdout/stderr');
    // log() appends to server.log without waiting.
    await new Promise((r) => setTimeout(r, 300));
    const serverLog = fs.readFileSync(path.join(srv.dir, 'server.log'), 'utf8');
    assert.match(serverLog, /\[site\] published/, 'the scan covers a log that has website entries');
    assert.ok(!serverLog.includes(TOKEN), 'server.log');
    const auditRows = await query(srv.dbFile, 'SELECT entity_data FROM audit_log');
    assert.ok(auditRows.every((r) => !String(r.entity_data).includes(TOKEN)), 'audit_log');
    for (const r of mock.state.requests) {
      assert.equal(r.headers.authorization, `Bearer ${TOKEN}`);
      assert.equal(r.headers['x-github-api-version'], '2026-03-10');
      assert.ok(!JSON.stringify({ ...r, headers: null }).includes(TOKEN), `${r.method} ${r.path}`);
    }
  });

  test('main only ever moved by fast-forward, and every tree write stayed in the allowlist', () => {
    for (const r of requests('PATCH', '/git/refs/heads/main')) assert.equal(r.body.force, false);
    for (const r of mock.state.requests.filter((x) => x.method === 'PATCH' && x.body && x.body.force === true)) {
      assert.equal(r.path, '/git/refs/heads/admin-preview');
    }
    const trees = requests('POST', '/git/trees');
    assert.ok(trees.length >= 4);
    for (const t of trees) {
      assert.ok(t.body.base_tree, 'base_tree is always sent');
      for (const item of t.body.tree) assert.ok(ALLOWED.includes(item.path), item.path);
    }
  });
});

// One owner on two devices, a restore and commits from git, all against one stored draft.
describe('the draft across devices, restores and upstream commits', () => {
  const TOKEN = 'test-token-' + crypto.randomBytes(30).toString('hex');
  let mock;
  let srv;
  let owner;
  const mainSha = () => mock.state.refs.get('main');
  const siteAt = (sha) => JSON.parse(mock.fileAt(sha, 'data/site.json'));
  const push = (mutate, message) => {
    const next = siteAt(mainSha());
    mutate(next);
    return mock.pushCommit({ files: { 'data/site.json': JSON.stringify(next, null, 2) + '\n' }, message });
  };
  const getDraft = async () => (await owner.get('/api/admin/site')).json.draft;
  async function publishGreen(commitSha) {
    const [run] = mock.runsFor(commitSha);
    mock.completeRun(run.id, 'success');
    const res = await owner.post('/api/admin/site/publish', { commitSha });
    assert.equal(res.status, 202, res.text);
  }

  before(async () => {
    mock = await startMockGitHub({ autoProgress: false, token: TOKEN });
    srv = await startServer({
      env: {
        SITE_GITHUB_TOKEN: TOKEN,
        SITE_GITHUB_REPO: REPO,
        SITE_GITHUB_API_URL: mock.url,
        SITE_LIVE_URL: mock.liveUrl('main'),
        SITE_PREVIEW_URL: mock.liveUrl('admin-preview'),
      },
    });
    owner = await setupOwner(srv);
  });
  after(async () => {
    await srv.stop();
    await mock.close();
  });

  test('a page holding an older revision cannot overwrite a newer draft; the same content is accepted', async () => {
    const base = mainSha();
    const a = { ...structuredClone(SITE), tagline: 'Draft A' };
    const b = { ...structuredClone(SITE), tagline: 'Draft B' };
    const savedA = await owner.post('/api/admin/site/draft', { config: a, baseSha: base, rev: 0 });
    assert.equal(savedA.status, 200, savedA.text);
    const savedB = await owner.post('/api/admin/site/draft', { config: b, baseSha: base, rev: savedA.json.rev });
    assert.equal(savedB.status, 200, savedB.text);
    assert.ok(savedB.json.rev > savedA.json.rev);

    // The laptop still holds revision A and saves another edit over it
    const stale = await owner.post('/api/admin/site/draft', { config: { ...a, year: 2030 }, baseSha: base, rev: savedA.json.rev });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.code, 'DRAFT_CHANGED');
    assert.equal(stale.json.rev, savedB.json.rev);
    assert.equal((await getDraft()).config.tagline, 'Draft B');

    const again = await owner.post('/api/admin/site/draft', { config: b, baseSha: base, rev: savedA.json.rev });
    assert.equal(again.status, 200, 'saving what is already stored is never a conflict');
    assert.deepEqual(again.json, savedB.json);
    assert.equal((await owner.post('/api/admin/site/draft', { config: b, baseSha: base, rev: 'x' })).status, 400);
    assert.equal((await owner.del('/api/admin/site/draft')).status, 200);
  });

  test('a preview never overwrites a draft saved while it was building', async () => {
    const base = mainSha();
    const clicked = { ...structuredClone(SITE), tagline: 'Built from this' };
    const first = await owner.post('/api/admin/site/draft', { config: clicked, baseSha: base, rev: 0 });
    // The autosave of an edit typed after Build preview lands before the preview's own save
    const typed = { ...clicked, owner: { ...clicked.owner, jobTitle: 'Typed during the build' } };
    const newer = await owner.post('/api/admin/site/draft', { config: typed, baseSha: base, rev: first.json.rev });
    assert.equal(newer.status, 200, newer.text);

    const res = await owner.post('/api/admin/site/preview', { config: clicked, baseSha: base, rev: first.json.rev });
    assert.equal(res.status, 202, res.text);
    assert.equal(res.json.draft, null, 'the stored draft was not the one previewed');
    const d = await getDraft();
    assert.equal(d.config.owner.jobTitle, 'Typed during the build');
    assert.equal(d.rev, newer.json.rev);
    assert.equal(d.previewSha, null);

    // Built from the stored draft, the preview records itself on it
    const own = await owner.post('/api/admin/site/preview', { config: typed, baseSha: base, rev: newer.json.rev });
    assert.equal(own.status, 202, own.text);
    assert.equal(own.json.draft.previewSha, own.json.commitSha);
    assert.ok(own.json.draft.rev > newer.json.rev);
    assert.deepEqual(await getDraft(), own.json.draft);
    assert.equal((await owner.del('/api/admin/site/draft')).status, 200);
  });

  test('publishing a restore keeps the pending draft, moved onto the new main', async () => {
    const seed = mainSha();
    push((s) => { s.tagline = 'Tagline from git'; }, 'Change the tagline');
    const draftConfig = siteAt(mainSha());
    draftConfig.owner.jobTitle = 'Draft job title';
    assert.equal((await owner.post('/api/admin/site/draft', { config: draftConfig, baseSha: mainSha(), rev: 0 })).status, 200);

    const restore = await owner.post('/api/admin/site/revert', { sha: seed });
    assert.equal(restore.status, 202, restore.text);
    assert.equal(restore.json.draft, null, 'a restore does not touch the draft');
    await publishGreen(restore.json.commitSha);

    const d = await getDraft();
    assert.ok(d, 'the draft survives the restore');
    assert.equal(d.baseSha, restore.json.commitSha);
    assert.equal(d.config.owner.jobTitle, 'Draft job title', 'its own edit is kept');
    assert.equal(d.config.tagline, SITE.tagline, 'the restored value is not undone');
    const checked = await owner.post('/api/admin/site/validate', { config: d.config, baseSha: d.baseSha });
    assert.deepEqual(checked.json.changes.map((c) => c.path), ['owner.jobTitle']);
  });

  test('publishing a preview from an older page keeps the newer edit made on another device', async () => {
    const d = await getDraft();
    const built = await owner.post('/api/admin/site/preview', { config: d.config, baseSha: d.baseSha, rev: d.rev });
    assert.equal(built.status, 202, built.text);
    const p = built.json.commitSha;

    // The laptop edits after the phone loaded the green preview
    const laptop = { ...structuredClone(built.json.draft.config), owner: { ...built.json.draft.config.owner, city: 'Carlsbad' } };
    assert.equal((await owner.post('/api/admin/site/draft', { config: laptop, baseSha: built.json.draft.baseSha, rev: built.json.draft.rev })).status, 200);
    await publishGreen(p);

    const after = await getDraft();
    assert.ok(after, 'the newer edit is not deleted with the published one');
    assert.equal(after.baseSha, p);
    assert.equal(after.config.owner.city, 'Carlsbad');
    const next = await owner.post('/api/admin/site/preview', { config: after.config, baseSha: after.baseSha, rev: after.rev });
    assert.equal(next.status, 202, next.text);
    assert.deepEqual(next.json.changes.map((c) => c.path), ['owner.city'], 'no false STALE, only the newer edit');
    await publishGreen(next.json.commitSha);
    assert.equal(await getDraft(), null, 'publishing the draft its preview was built from drops it');
  });

  test('a draft behind main is shown rebased, and validate with its base agrees with the preview', async () => {
    const base = mainSha();
    const draftConfig = siteAt(base);
    draftConfig.owner.jobTitle = 'Behind-main job title';
    const saved = await owner.post('/api/admin/site/draft', { config: draftConfig, baseSha: base, rev: 0 });
    const upstream = push((s) => {
      s.tagline = 'Tagline from the laptop';
      s.alternateNames = ['Donatelli Services'];
    }, 'Edit the tagline and names from git');

    const d = await getDraft();
    assert.equal(d.baseSha, upstream);
    assert.equal(d.rebasedFrom, base);
    assert.equal(d.rev, saved.json.rev);
    assert.equal(d.config.tagline, 'Tagline from the laptop');
    assert.deepEqual(d.config.alternateNames, ['Donatelli Services']);
    assert.equal(d.config.owner.jobTitle, 'Behind-main job title');

    // The page still holding the old base gets the preview's answer when it sends that base
    const withBase = await owner.post('/api/admin/site/validate', { config: draftConfig, baseSha: base });
    assert.equal(withBase.status, 200, withBase.text);
    assert.deepEqual(withBase.json.errors, []);
    assert.deepEqual(withBase.json.changes.map((c) => c.path), ['owner.jobTitle']);
    const withoutBase = await owner.post('/api/admin/site/validate', { config: draftConfig });
    assert.deepEqual(withoutBase.json.changes.map((c) => c.path), ['alternateNames', 'tagline', 'owner.jobTitle']);

    const preview = await owner.post('/api/admin/site/preview', { config: draftConfig, baseSha: base, rev: d.rev });
    assert.equal(preview.status, 202, preview.text);
    assert.deepEqual(preview.json.changes.map((c) => c.path), withBase.json.changes.map((c) => c.path));
    // The stored draft now holds the rebased config, so a reload still matches the preview
    assert.deepEqual((await getDraft()).config, preview.json.draft.config);
    assert.equal((await owner.del('/api/admin/site/draft')).status, 200);
  });

  test('name parts edited on both sides are STALE as one value, and the stored draft keeps rule R1', async () => {
    const base = mainSha();
    const draftConfig = siteAt(base);
    draftConfig.owner.givenName = 'Nicolas';
    draftConfig.owner.name = `Nicolas ${draftConfig.owner.familyName}`;
    draftConfig.owner.jobTitle = 'Kept through the clash';
    assert.equal((await owner.post('/api/admin/site/draft', { config: draftConfig, baseSha: base, rev: 0 })).status, 200);
    push((s) => {
      s.owner.familyName = 'Donatelli-Smith';
      s.owner.name = `${s.owner.givenName} Donatelli-Smith`;
    }, 'Change the family name from git');

    const res = await owner.post('/api/admin/site/preview', { config: draftConfig, baseSha: base });
    assert.equal(res.status, 409);
    assert.equal(res.json.code, 'STALE');
    assert.deepEqual([...res.json.conflicts].sort(), ['owner.givenName', 'owner.name']);

    const d = await getDraft();
    assert.equal(d.config.owner.name, `${d.config.owner.givenName} ${d.config.owner.familyName}`);
    assert.equal(d.config.owner.familyName, 'Donatelli-Smith');
    assert.equal(d.config.owner.jobTitle, 'Kept through the clash');
    const checked = await owner.post('/api/admin/site/validate', { config: d.config, baseSha: d.baseSha });
    assert.deepEqual(checked.json.errors, []);
    const again = await owner.post('/api/admin/site/preview', { config: d.config, baseSha: d.baseSha, rev: d.rev });
    assert.equal(again.status, 202, again.text);
  });
});
