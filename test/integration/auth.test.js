'use strict';
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const sqlite3 = require('sqlite3');
const bcrypt = require('bcrypt');
const { startServer, runUntilExit } = require('../helpers/server-harness');
const { createClient } = require('../helpers/cookie-jar');
const { seedMember, setRole } = require('../helpers/seed-member');
const { BLOCKED_PREFIXES } = require('../../lib/edition');

const OWNER = 'owner@example.com';
const MEMBER = 'member@example.com';

// Each client is a distinct visitor to the per-IP limiters (the server trusts one proxy hop).
let visitor = 0;
const clientFor = (srv) => createClient(srv.url, { headers: { 'X-Forwarded-For': `203.0.113.${++visitor}` } });

function query(dbFile, sql, params = []) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbFile, sqlite3.OPEN_READONLY, (openErr) => {
      if (openErr) return reject(openErr);
      db.all(sql, params, (err, rows) => db.close(() => (err ? reject(err) : resolve(rows))));
    });
  });
}

function runScript(cwd, args, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

function authCookie(res) {
  return res.headers.getSetCookie().find((c) => c.startsWith('authToken='));
}

describe('boot', () => {
  test('production refuses to boot for each unsafe value (exit 1, reason on stderr)', async () => {
    const cases = [
      [{ JWT_SECRET: 'x'.repeat(31) }, /JWT_SECRET is shorter than 32 characters/],
      [{ JWT_SECRET: 'change-this-secret-in-production' }, /JWT_SECRET is the example placeholder/],
      [{ DEMO_MODE: 'true' }, /DEMO_MODE is true/],
      [{ APP_URL: undefined }, /APP_URL is not set/],
      [{ APP_URL: 'http://admin.example.com' }, /APP_URL is "http:\/\/admin\.example\.com", which is not https/],
      [{ SITE_GITHUB_API_URL: 'http://api.example.com' }, /SITE_GITHUB_API_URL is "http:\/\/api\.example\.com", which is not https/],
      [{ SITE_PREVIEW_BRANCH: 'main' }, /SITE_PREVIEW_BRANCH equals SITE_GITHUB_BRANCH \(main\)/],
      [{ CONNECT_INGEST_SECRET: 'y'.repeat(31) }, /CONNECT_INGEST_SECRET is shorter than 32 characters/],
      [{ ALLOWED_ORIGINS: 'https://other.example.com' }, /ALLOWED_ORIGINS does not include the APP_URL origin/],
    ];
    const results = await Promise.all(cases.map(([env]) => runUntilExit({ env })));
    results.forEach((result, i) => {
      const [env, pattern] = cases[i];
      const label = JSON.stringify(env);
      assert.equal(result.code, 1, `${label}: exit code`);
      assert.match(result.stderr, /Server not started: 1 configuration problem\./, label);
      assert.match(result.stderr, pattern, label);
      assert.doesNotMatch(result.stdout, /Server running/, label);
    });
  });

  test('development mode (NODE_ENV unset) boots on the dev defaults', async () => {
    const srv = await startServer({ env: { NODE_ENV: undefined, SETUP_TOKEN: undefined } });
    try {
      const client = clientFor(srv);
      assert.equal((await client.get('/api/health')).status, 200);
      // Development needs no setup token, and its cookies work over plain http
      assert.equal((await client.get('/api/setup/status')).json.setupTokenRequired, false, 'so the setup form leaves the field out');
      const res = await client.setupOwner({ email: OWNER, password: 'dev password 123' });
      assert.equal(res.status, 200, res.text);
      assert.doesNotMatch(authCookie(res), /Secure/);
      assert.match(srv.output(), /Environment: development/);
    } finally {
      await srv.stop();
    }
  });
});

describe('a production server', () => {
  let srv;
  let owner;
  let ownerPassword = 'first owner password';

  before(async () => {
    // BACKUP_INTERVAL_HOURS also proves the in-process backup timer loads its script at boot
    srv = await startServer({ env: { BACKUP_INTERVAL_HOURS: '24' } });
    owner = clientFor(srv);
  });
  after(() => srv.stop());

  test('GET /api/health answers 200 with no auth, noindex and no-store', async () => {
    const res = await owner.get('/api/health');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true });
    assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });

  test('the data folder, which holds the database and backups, is closed to other local accounts', { skip: process.platform === 'win32' ? 'POSIX modes only' : false }, () => {
    assert.equal(fs.statSync(path.join(srv.dir, 'data')).mode & 0o077, 0);
  });

  test('the CSP allows only this origin to connect and forbids framing', async () => {
    const csp = (await owner.get('/api/health')).headers.get('content-security-policy');
    assert.match(csp, /connect-src 'self'(;|$)/);
    assert.doesNotMatch(csp, /api\.github\.com/);
    assert.match(csp, /img-src 'self' data: https:\/\/donatelli\.tech(;|$)/);
    for (const directive of ["frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'"]) {
      assert.ok(csp.includes(directive), directive);
    }
  });

  test('setup status reports mailConfigured', async () => {
    const res = await owner.get('/api/setup/status');
    assert.equal(res.status, 200);
    assert.equal(res.json.setupComplete, false);
    assert.equal(res.json.mailConfigured, false);
    assert.equal(res.json.setupTokenRequired, true);
  });

  test('setup needs the SETUP_TOKEN, a 12-character password, and runs once', async () => {
    const body = { email: OWNER, password: ownerPassword };

    let res = await owner.setupOwner(body);
    assert.equal(res.status, 403);
    assert.deepEqual(res.json, { code: 'SETUP_TOKEN', error: 'Setup token did not match. Check SETUP_TOKEN on the server.' });

    res = await owner.setupOwner({ ...body, setupToken: 'not-the-token' });
    assert.equal(res.status, 403);
    assert.equal(res.json.code, 'SETUP_TOKEN');

    res = await owner.setupOwner({ ...body, password: 'elevenchars', setupToken: srv.env.SETUP_TOKEN });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'Use at least 12 characters.');

    res = await owner.setupOwner({ ...body, setupToken: srv.env.SETUP_TOKEN });
    assert.equal(res.status, 200, res.text);
    const cookie = authCookie(res);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Secure/);
    // Max-Age follows JWT_EXPIRES_IN (default 24h)
    assert.match(cookie, /Max-Age=86400/);

    const me = await owner.get('/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.json.role, 'owner');
    assert.equal(me.json.orgSlug, 'donatelli-tech');
    // The SPA formats every time in the zone the server's own status copy uses (ADMIN_TIME_ZONE's default).
    assert.equal(me.json.timeZone, 'America/Los_Angeles');

    res = await clientFor(srv).setupOwner({ email: 'second@example.com', password: 'second owner password', setupToken: srv.env.SETUP_TOKEN });
    assert.equal(res.status, 403);
  });

  test('login: wrong password is refused generically, the right one works', async () => {
    const client = clientFor(srv);
    let res = await client.login(OWNER, 'wrong password here');
    assert.equal(res.status, 401);
    assert.equal(res.json.error, 'Invalid email or password');
    res = await client.login(OWNER, ownerPassword);
    assert.equal(res.status, 200);
    assert.equal((await client.get('/api/auth/me')).status, 200);
  });

  test('non-string email or password fields get 400 and never take the server down', async () => {
    const cases = [
      ['/api/auth/forgot-password', { email: ['x@example.com'] }],
      ['/api/auth/forgot-password', { email: [OWNER] }],
      ['/api/auth/forgot-password', { email: { a: OWNER } }],
      ['/api/login', { email: OWNER, password: 12345 }],
      ['/api/login', { email: OWNER, password: ['x'] }],
      ['/api/login', { email: OWNER, password: { a: 1 } }],
      ['/api/login', { email: 'nobody@example.com', password: ['x'] }],
      ['/api/auth/reset-password', { token: ['a'.repeat(64)], password: 'long enough password' }],
      ['/api/auth/reset-password', { token: 'a'.repeat(64), password: { a: 1 } }],
    ];
    for (const [route, json] of cases) {
      const res = await clientFor(srv).post(route, json);
      assert.equal(res.status, 400, `${route} ${JSON.stringify(json)}: ${res.text}`);
    }
    // Repeated form fields arrive as an array too
    const form = await clientFor(srv).request('POST', '/api/auth/forgot-password', {
      body: 'email=a%40b.co&email=c%40d.co',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(form.status, 400, form.text);
    for (const json of [{ currentPassword: 12345, newPassword: 'long enough password' }, { currentPassword: ownerPassword, newPassword: ['a'.repeat(15)] }]) {
      const res = await owner.post('/api/auth/change-password', json);
      assert.equal(res.status, 400, `${JSON.stringify(json)}: ${res.text}`);
    }
    assert.equal((await clientFor(srv).get('/api/health')).status, 200);
    assert.equal((await owner.get('/api/auth/me')).status, 200);
  });

  test('a write without the CSRF token gets 403 CSRF, not 500', async () => {
    const res = await owner.post('/api/auth/logout-all', undefined, { csrf: false });
    assert.equal(res.status, 403);
    assert.deepEqual(res.json, { error: 'Session check failed. Reload the page and try again.', code: 'CSRF' });
  });

  test('a foreign Origin gets 403 ORIGIN; the admin origin may preflight PUT and PATCH', async () => {
    let res = await owner.post('/api/login', { email: OWNER, password: ownerPassword }, { headers: { Origin: 'https://evil.example.com' } });
    assert.equal(res.status, 403);
    assert.deepEqual(res.json, { error: 'Origin not allowed.', code: 'ORIGIN' });

    res = await owner.request('OPTIONS', '/api/admin/site/draft', {
      headers: { Origin: srv.url, 'Access-Control-Request-Method': 'PATCH' },
    });
    assert.equal(res.status, 204);
    assert.match(res.headers.get('access-control-allow-methods'), /PUT/);
    assert.match(res.headers.get('access-control-allow-methods'), /PATCH/);
  });

  test('an oversized JSON body gets 413 TOO_LARGE, not 500', async () => {
    const res = await owner.post('/api/login', { email: OWNER, password: 'x'.repeat(11 * 1024 * 1024) });
    assert.equal(res.status, 413);
    assert.deepEqual(res.json, { error: 'Request too large.', code: 'TOO_LARGE' });
  });

  test('20 KB ingest body → 413 (the ingest route caps at 16 KB)', async () => {
    const res = await owner.request('POST', '/api/ingest/connections', {
      body: JSON.stringify({ v: 1, pad: 'x'.repeat(20 * 1024) }),
      headers: { 'Content-Type': 'application/json' },
      csrf: false,
    });
    assert.equal(res.status, 413);
    assert.equal(res.json.ok, false);
    assert.equal(res.json.code, 'TOO_LARGE');
  });

  test('the 10 MB global parsers leave /api/ingest/ bodies alone', async () => {
    // Only the ingest route's own 16 KB reader answers with {ok:false}; the global errorHandler's
    // 413 has no ok field, so this shape proves the global parser never read the body.
    const res = await owner.request('POST', '/api/ingest/connections', {
      body: JSON.stringify({ pad: 'x'.repeat(11 * 1024 * 1024) }),
      headers: { 'Content-Type': 'application/json' },
      csrf: false,
    });
    assert.equal(res.status, 413);
    assert.equal(res.json.ok, false);
    assert.equal(res.json.code, 'TOO_LARGE');
    assert.notEqual(res.json.error, 'Request too large.');
  });

  test('sign out everywhere: every earlier session gets 401', async () => {
    const other = clientFor(srv);
    assert.equal((await other.login(OWNER, ownerPassword)).status, 200);
    const oldToken = owner.jar.get('authToken');

    const res = await owner.post('/api/auth/logout-all');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { success: true });
    assert.equal(owner.jar.has('authToken'), false);

    assert.equal((await other.get('/api/auth/me')).status, 401);
    const replay = clientFor(srv);
    replay.jar.set('authToken', oldToken);
    assert.equal((await replay.get('/api/auth/me')).status, 401);

    assert.equal((await owner.login(OWNER, ownerPassword)).status, 200);
    assert.equal((await owner.get('/api/auth/me')).status, 200);
  });

  test('change password: other sessions get 401, the current one stays', async () => {
    const other = clientFor(srv);
    assert.equal((await other.login(OWNER, ownerPassword)).status, 200);

    let res = await owner.post('/api/auth/change-password', { currentPassword: ownerPassword, newPassword: 'too short' });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'Use at least 12 characters.');

    res = await owner.post('/api/auth/change-password', { currentPassword: 'not my password', newPassword: 'second owner password' });
    assert.equal(res.status, 401);

    res = await owner.post('/api/auth/change-password', { currentPassword: ownerPassword, newPassword: 'second owner password' });
    assert.equal(res.status, 200, res.text);
    assert.ok(authCookie(res), 'the current session gets a fresh cookie');
    ownerPassword = 'second owner password';

    assert.equal((await owner.get('/api/auth/me')).status, 200);
    assert.equal((await other.get('/api/auth/me')).status, 401);
    const fresh = clientFor(srv);
    assert.equal((await fresh.login(OWNER, 'first owner password')).status, 401);
    assert.equal((await fresh.login(OWNER, ownerPassword)).status, 200);
  });

  test('reset password by emailed token: 12 characters, one use, signs out every session', async () => {
    const res = await clientFor(srv).post('/api/auth/forgot-password', { email: OWNER });
    assert.equal(res.status, 200);
    const [row] = await query(srv.dbFile, 'SELECT token FROM password_reset_tokens WHERE used_at IS NULL');
    assert.ok(row, 'a reset token row exists');

    const anon = clientFor(srv);
    let reset = await anon.post('/api/auth/reset-password', { token: row.token, password: 'too short' });
    assert.equal(reset.status, 400);
    assert.equal(reset.json.error, 'Use at least 12 characters.');

    // With a valid token, a non-string password must still stop at validation, not at bcrypt
    for (const password of [{ a: 1 }, ['aaaaaaaaaaaaaaa'], 123456789012345]) {
      reset = await anon.post('/api/auth/reset-password', { token: row.token, password });
      assert.equal(reset.status, 400, JSON.stringify(password));
      assert.equal(reset.json.error, 'Use at least 12 characters.');
    }
    assert.equal((await anon.get('/api/health')).status, 200);

    reset = await anon.post('/api/auth/reset-password', { token: row.token, password: 'third owner password' });
    assert.equal(reset.status, 200, reset.text);
    ownerPassword = 'third owner password';
    assert.equal((await owner.get('/api/auth/me')).status, 401);

    reset = await anon.post('/api/auth/reset-password', { token: row.token, password: 'fourth owner password' });
    assert.equal(reset.status, 400);

    assert.equal((await owner.login(OWNER, ownerPassword)).status, 200);
  });

  test('roles come from the database on every request; /api/admin/logs is owner-only', async () => {
    const id = await seedMember(srv.dbFile, { email: MEMBER, password: 'member password 1' });

    const member = clientFor(srv);
    assert.equal((await member.login(MEMBER, 'member password 1')).status, 200);
    assert.equal((await member.get('/api/admin/logs')).status, 403);
    assert.equal((await member.get('/api/admin/audit')).status, 403);
    assert.equal((await owner.get('/api/admin/logs')).status, 200);

    // A promotion applies to the member's existing token at once, and so does the demotion.
    await setRole(srv.dbFile, id, 'owner');
    assert.equal((await member.get('/api/admin/logs')).status, 200);
    await setRole(srv.dbFile, id, 'member');
    assert.equal((await member.get('/api/admin/logs')).status, 403);

    // A deleted user's token stops working immediately
    assert.equal((await owner.del(`/api/admin/users/${id}`)).status, 200);
    assert.equal((await member.get('/api/auth/me')).status, 401);
  });

  test('the owner cannot create or promote a second account; listing still works', async () => {
    const created = await owner.post('/api/admin/users', { email: 'backdoor@example.net', password: 'short123', role: 'owner' });
    assert.equal(created.status, 404);
    assert.deepEqual(created.json, { error: 'Not found' });
    assert.equal(created.headers.get('x-robots-tag'), 'noindex, nofollow');
    const [self] = await query(srv.dbFile, 'SELECT id FROM users WHERE email = ?', [OWNER]);
    const promoted = await owner.patch(`/api/admin/users/${self.id}`, { role: 'member' });
    assert.equal(promoted.status, 404);
    assert.equal((await query(srv.dbFile, "SELECT COUNT(*) AS n FROM users WHERE email = 'backdoor@example.net'"))[0].n, 0);
    const list = await owner.get('/api/admin/users');
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.map((u) => u.email), [OWNER]);
  });

  test('Swiish public surfaces answer JSON 404 with X-Robots-Tag', async () => {
    const samples = {
      '/api/cards/': '/api/cards/short/Ab3dE6x',
      '/api/admin/cards': '/api/admin/cards',
      '/api/qr/': '/api/qr/Ab3dE6x',
      '/api/upload': '/api/upload',
      '/uploads/': '/uploads/photo.png',
      '/manifest/': '/manifest/nick.json',
      '/icons/': '/icons/nick.svg',
      '/api/demo/': '/api/demo/status',
      '/api/invitations/': `/api/invitations/${'a'.repeat(64)}`,
      '/api/admin/invitations': '/api/admin/invitations',
    };
    assert.deepEqual(Object.keys(samples), BLOCKED_PREFIXES);
    for (const p of [...Object.values(samples), '/api/settings']) {
      const res = await owner.get(p);
      assert.equal(res.status, 404, p);
      assert.deepEqual(res.json, { error: 'Not found' }, p);
      assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow', p);
    }
    const upload = await owner.post('/api/upload', {});
    assert.equal(upload.status, 404);
  });

  test('the SPA shell is served for admin paths without card meta tags', async () => {
    for (const p of ['/login', '/admin/connections', '/Ab3dE6x', '/donatelli-tech/nick']) {
      const res = await owner.get(p);
      assert.equal(res.status, 200, p);
      assert.match(res.text, /<script nonce="[^"]+" src="\/static\/js\/main\.js">/, p);
      assert.doesNotMatch(res.text, /og:|Digital Business Card|name="robots"/, p);
      assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow', p);
    }
  });

  test('GET /api/admin/audit lists auth events without PII and pages with before/limit', async () => {
    let res = await owner.get('/api/admin/audit?entity_type=auth&limit=100');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const types = res.json.items.map((i) => i.eventType);
    for (const t of ['setup_completed', 'sessions_revoked', 'password_changed', 'password_reset']) {
      assert.ok(types.includes(t), `${t} in ${types}`);
    }
    for (const item of res.json.items) {
      assert.deepEqual(Object.keys(item).sort(), ['data', 'entityId', 'entityType', 'eventType', 'id', 'performedAt']);
      assert.equal(item.entityType, 'auth');
      assert.deepEqual(item.data, {});
      assert.ok(!Number.isNaN(Date.parse(item.performedAt)));
    }
    assert.ok(!res.text.includes(OWNER));

    res = await owner.get('/api/admin/audit?limit=1');
    assert.equal(res.json.items.length, 1);
    res = await owner.get('/api/admin/audit?before=2000-01-01T00:00:00Z');
    assert.deepEqual(res.json.items, []);

    const badQueries = {
      'entity_type=user': /^entity_type must be/,
      'entity_type=auth&entity_type=site': /^entity_type must be/,
      'limit=0': /^limit must be/,
      'limit=101': /^limit must be/,
      'limit=1&limit=2': /^limit must be/,
      'before=yesterday': /^before must be/,
    };
    for (const [bad, message] of Object.entries(badQueries)) {
      const refused = await owner.get(`/api/admin/audit?${bad}`);
      assert.equal(refused.status, 400, bad);
      assert.match(refused.json.error, message, bad);
    }
  });

  test('audit paging by time and id returns rows that share one second exactly once', async () => {
    const [{ organisation_id: org }] = await query(srv.dbFile, 'SELECT organisation_id FROM users WHERE email = ?', [OWNER]);
    const burst = Array.from({ length: 25 }, () => require('crypto').randomUUID());
    await new Promise((resolve, reject) => {
      const db = new sqlite3.Database(srv.dbFile);
      db.serialize(() => {
        const insert = db.prepare(`INSERT INTO audit_log (id, event_type, entity_type, entity_id, entity_data, performed_by, organisation_id, performed_at)
          VALUES (?, 'password_changed', 'auth', ?, '{}', NULL, ?, '2001-01-01 00:00:00')`);
        for (const id of burst) insert.run(id, id, org);
        insert.finalize((err) => db.close(() => (err ? reject(err) : resolve())));
      });
    });

    const seen = [];
    let path = '/api/admin/audit?entity_type=auth&limit=10&before=2001-01-01T00:00:01Z';
    for (let page = 0; page < 5; page++) {
      const res = await owner.get(path);
      assert.equal(res.status, 200, JSON.stringify(res.json));
      seen.push(...res.json.items.map((i) => i.id));
      if (res.json.items.length < 10) break;
      const last = res.json.items[res.json.items.length - 1];
      path = `/api/admin/audit?entity_type=auth&limit=10&before=${encodeURIComponent(last.performedAt)}&before_id=${last.id}`;
    }
    assert.equal(new Set(seen).size, seen.length, 'no row twice');
    assert.deepEqual([...seen].sort(), [...burst].sort());

    for (const bad of [`before_id=${burst[0]}`, 'before=2001-01-01T00:00:01Z&before_id=not-an-id']) {
      const refused = await owner.get(`/api/admin/audit?${bad}`);
      assert.equal(refused.status, 400, bad);
      assert.match(refused.json.error, /^before_id must be/, bad);
    }
  });

  test('scripts/set-password.js resets from the shell and signs out every session', async () => {
    const script = path.join('scripts', 'set-password.js');

    let run = await runScript(srv.dir, [script, 'nobody@example.com'], 'unused password 1\nunused password 1\n');
    assert.equal(run.code, 1);
    assert.match(run.stderr, /No user with that email\./);

    run = await runScript(srv.dir, [script, OWNER], 'short\nshort\n');
    assert.equal(run.code, 1);
    assert.match(run.stderr, /use at least 12 characters/);

    run = await runScript(srv.dir, [script, OWNER], 'shell owner password\nshell owner passwort\n');
    assert.equal(run.code, 1);
    assert.match(run.stderr, /did not match/);

    const hashOf = async () => (await query(srv.dbFile, 'SELECT password_hash FROM users WHERE email = ?', [OWNER]))[0].password_hash;
    const serverHash = await hashOf();
    run = await runScript(srv.dir, [script, OWNER.toUpperCase()], 'shell owner password\nshell owner password\n');
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /Password changed for owner@example\.com/);
    // Login times an unknown email against a dummy hash at the server's cost; a reset at another cost
    // would make the owner's address answer at a different speed.
    assert.equal(bcrypt.getRounds(await hashOf()), bcrypt.getRounds(serverHash), 'the shell reset hashes at the server\'s cost');

    assert.equal((await owner.get('/api/auth/me')).status, 401);
    assert.equal((await owner.login(OWNER, ownerPassword)).status, 401);
    ownerPassword = 'shell owner password';
    assert.equal((await owner.login(OWNER, ownerPassword)).status, 200);

    const rows = await query(srv.dbFile, "SELECT entity_type, entity_data, performed_by FROM audit_log WHERE event_type = 'password_reset_cli'");
    assert.deepEqual(rows, [{ entity_type: 'auth', entity_data: '{}', performed_by: null }]);
  });

  test('no password or secret reaches server output or server.log', async () => {
    const log = fs.readFileSync(path.join(srv.dir, 'server.log'), 'utf8');
    const text = srv.output() + log;
    const secrets = [
      srv.env.JWT_SECRET, srv.env.SETUP_TOKEN, srv.env.CONNECT_INGEST_SECRET,
      'first owner password', 'second owner password', 'third owner password', 'shell owner password', 'member password 1',
    ];
    for (const secret of secrets) assert.ok(!text.includes(secret), 'a secret or password leaked');
  });
});

describe('a production server without SETUP_TOKEN', () => {
  let srv;
  before(async () => { srv = await startServer({ env: { SETUP_TOKEN: undefined } }); });
  after(() => srv.stop());

  test('setup is locked', async () => {
    const res = await clientFor(srv).setupOwner({ email: OWNER, password: 'first owner password', setupToken: 'anything' });
    assert.equal(res.status, 403);
    assert.deepEqual(res.json, { code: 'SETUP_LOCKED', error: 'Setup is locked. Set SETUP_TOKEN on the server and reload.' });
  });

  test('IPv6 visitors share one login limit per /56, so rotating addresses does not escape it', async () => {
    const from = (ip) => createClient(srv.url, { headers: { 'X-Forwarded-For': ip } });
    for (let i = 1; i <= 5; i++) {
      assert.equal((await from(`2001:db8:1:${i}::${i}`).login(OWNER, 'wrong password here')).status, 401, `attempt ${i}`);
    }
    assert.equal((await from('2001:db8:1:ff::99').login(OWNER, 'wrong password here')).status, 429);
    // The next /56 and an IPv4-mapped visitor keep their own limits
    assert.equal((await from('2001:db8:1:100::1').login(OWNER, 'wrong password here')).status, 401);
    assert.equal((await from('::ffff:198.51.100.200').login(OWNER, 'wrong password here')).status, 401);
  });

  test('the 6th login attempt from one address in 15 minutes gets 429', async () => {
    const client = clientFor(srv);
    for (let i = 1; i <= 5; i++) {
      assert.equal((await client.login(OWNER, 'wrong password here')).status, 401, `attempt ${i}`);
    }
    const res = await client.login(OWNER, 'wrong password here');
    assert.equal(res.status, 429);
    assert.ok(res.headers.get('ratelimit-reset'), 'RateLimit-Reset tells the login page when to retry');
    // Another address is not affected
    assert.equal((await clientFor(srv).login(OWNER, 'wrong password here')).status, 401);
  });
});

describe('a production server whose SMTP server never answers', () => {
  let srv;
  let smtp;
  const sockets = new Set();

  before(async () => {
    // Accepts the connection and never sends a greeting, like a stalled mail provider.
    smtp = net.createServer((socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise((resolve) => smtp.listen(0, '127.0.0.1', resolve));
    srv = await startServer({
      env: { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.address().port), SMTP_USER: 'u', SMTP_PASSWORD: 'p' },
    });
    const res = await clientFor(srv).setupOwner({ email: OWNER, password: 'first owner password', setupToken: srv.env.SETUP_TOKEN });
    assert.equal(res.status, 200, res.text);
  });
  after(async () => {
    await srv.stop();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => smtp.close(resolve));
  });

  test('forgot-password answers a known address as fast as an unknown one', async () => {
    const timed = async (email) => {
      const started = Date.now();
      const res = await clientFor(srv).post('/api/auth/forgot-password', { email });
      return { res, ms: Date.now() - started };
    };
    const unknown = await timed('nobody@example.com');
    const known = await timed(OWNER);
    for (const { res } of [unknown, known]) {
      assert.equal(res.status, 200);
      assert.deepEqual(res.json, { success: true, message: 'If an account exists with this email, a password reset link has been sent' });
    }
    // The stalled send would hold the known address's answer for nodemailer's 30 s greeting timeout
    assert.ok(known.ms < 2000, `known address took ${known.ms} ms`);
    const [row] = await query(srv.dbFile, 'SELECT COUNT(*) AS n FROM password_reset_tokens WHERE used_at IS NULL');
    assert.equal(row.n, 1);
    assert.equal((await clientFor(srv).get('/api/health')).status, 200);
  });
});
