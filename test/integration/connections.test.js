'use strict';
// Connections against the real server.js in production mode: signed ingest, the owner API, the
// retention purge at boot, the sign-ingest CLI, and a final scan proving that no visitor detail
// reached audit_log, server.log or the process output.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const sqlite3 = require('sqlite3');
const { startServer } = require('../helpers/server-harness');
const { createClient } = require('../helpers/cookie-jar');
const { seedMember } = require('../helpers/seed-member');
const { buildPayload, postSigned, ipHashFor } = require('../../scripts/sign-ingest');

const ROOT = path.join(__dirname, '..', '..');
const OWNER = 'owner@example.com';
const OWNER_PASSWORD = 'connections owner password';
const MEMBER = 'member@example.com';

let visitorIp = 0;
const clientFor = (srv) => createClient(srv.url, { headers: { 'X-Forwarded-For': `198.51.100.${++visitorIp}` } });

function query(dbFile, sql, params = []) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbFile, (openErr) => {
      if (openErr) return reject(openErr);
      db.all(sql, params, (err, rows) => db.close(() => (err ? reject(err) : resolve(rows))));
    });
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

async function waitFor(check, what, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

// Boots a second server.js on the same directory and database, which is what a restart does:
// startTimers() runs the retention purge before the server listens.
async function restartOnSameData(srv) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], { cwd: srv.dir, env: { ...srv.env, PORT: String(port) }, stdio: 'ignore' });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  await waitFor(async () => {
    try {
      return (await fetch(`http://localhost:${port}/api/health`)).status === 200;
    } catch {
      return false;
    }
  }, 'the restarted server');
  return async () => {
    child.kill('SIGTERM');
    await exited;
  };
}

describe('connections on a production server', () => {
  let srv;
  let owner;
  const submitted = [];
  const ids = {};

  const url = () => `${srv.url}/api/ingest/connections`;
  const send = (fields, opts = {}) => {
    submitted.push(fields);
    return postSigned({ url: url(), secret: srv.env.CONNECT_INGEST_SECRET, payload: buildPayload(fields), ...opts });
  };
  const visitor = (n, extra = {}) => ({
    name: `Test Visitor ${n}`, email: `visitor${n}@example.com`, company: `Example Co ${n}`, note: `Private note ${n}`, ...extra,
  });

  before(async () => {
    srv = await startServer();
    owner = clientFor(srv);
    const res = await owner.setupOwner({ email: OWNER, password: OWNER_PASSWORD, setupToken: srv.env.SETUP_TOKEN });
    assert.equal(res.status, 200, res.text);
  });
  after(() => srv.stop());

  test('a signed ingest is stored: 201, then 200 duplicate for the same id', async () => {
    const payload = buildPayload(visitor('One', { source: 'qr', ipHash: ipHashFor(srv.env.CONNECT_INGEST_SECRET, '203.0.113.10') }));
    submitted.push(payload);
    ids.one = payload.id;
    let res = await postSigned({ url: url(), secret: srv.env.CONNECT_INGEST_SECRET, payload });
    assert.equal(res.status, 201, res.text);
    assert.deepEqual(res.json, { ok: true, id: payload.id });

    res = await postSigned({ url: url(), secret: srv.env.CONNECT_INGEST_SECRET, payload });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true, duplicate: true });
    assert.equal((await query(srv.dbFile, 'SELECT COUNT(*) AS n FROM connections WHERE id = ?', [payload.id]))[0].n, 1);
  });

  test('a stale timestamp or a wrong secret is 401; nothing is stored', async () => {
    let res = await send(visitor('Stale'), { timestamp: Math.floor(Date.now() / 1000) - 301 });
    assert.equal(res.status, 401);
    assert.deepEqual({ ok: res.json.ok, code: res.json.code }, { ok: false, code: 'STALE' });

    res = await send(visitor('Forged'), { secret: crypto.randomBytes(48).toString('base64') });
    assert.equal(res.status, 401);
    assert.equal(res.json.code, 'BAD_SIGNATURE');
    assert.equal((await query(srv.dbFile, "SELECT COUNT(*) AS n FROM connections WHERE name IN ('Test Visitor Stale', 'Test Visitor Forged')"))[0].n, 0);
  });

  test('a 20 KB ingest body is 413 in the ingest error shape', async () => {
    const res = await send(visitor('Big', { note: 'x'.repeat(20 * 1024) }));
    assert.equal(res.status, 413);
    assert.equal(res.json.ok, false);
    assert.equal(res.json.code, 'TOO_LARGE');
  });

  test('the sixth send from one ipHash in 15 minutes is 429 RATE_LIMITED', async () => {
    const ipHash = ipHashFor(srv.env.CONNECT_INGEST_SECRET, '203.0.113.20');
    for (let i = 1; i <= 5; i += 1) {
      const res = await send(visitor(`Burst${i}`, { ipHash, source: 'nfc' }));
      assert.equal(res.status, 201, res.text);
    }
    const res = await send(visitor('Burst6', { ipHash }));
    assert.equal(res.status, 429);
    assert.equal(res.json.code, 'RATE_LIMITED');
    assert.ok(res.json.retryAfterSeconds > 0);
  });

  test('owner list: counts, status filter, search and cursor pages', async () => {
    let res = await owner.get('/api/admin/connections');
    assert.equal(res.status, 200, res.text);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.json.items.length, 6);
    assert.deepEqual(res.json.counts.total, 6);
    assert.deepEqual(res.json.counts.new, 6);

    res = await owner.get('/api/admin/connections?q=visitorone%40');
    assert.deepEqual(res.json.items.map((i) => i.id), [ids.one]);
    res = await owner.get('/api/admin/connections?q=Burst');
    assert.equal(res.json.items.length, 5);

    const seen = [];
    let cursor = null;
    do {
      res = await owner.get(`/api/admin/connections?status=new&limit=4${cursor ? `&cursor=${cursor}` : ''}`);
      assert.equal(res.status, 200, res.text);
      seen.push(...res.json.items.map((i) => i.id));
      cursor = res.json.nextCursor;
    } while (cursor);
    assert.equal(seen.length, 6);
    assert.equal(new Set(seen).size, 6);
  });

  test('detail has every documented field and no ip_hash', async () => {
    const res = await owner.get(`/api/admin/connections/${ids.one}`);
    assert.equal(res.status, 200);
    const c = res.json.connection;
    assert.equal(c.name, 'Test Visitor One');
    assert.equal(c.email, 'visitorone@example.com');
    assert.equal(c.source, 'qr');
    assert.equal(c.retentionDays, 365);
    assert.equal(Date.parse(c.expiresAt) - Date.parse(c.receivedAt), 365 * 24 * 3600 * 1000);
    assert.ok(!('ipHash' in c) && !('ip_hash' in c));
    assert.ok(!res.text.includes(ipHashFor(srv.env.CONNECT_INGEST_SECRET, '203.0.113.10')));
  });

  test('status and notes update; the audit entry names the fields, never the notes text', async () => {
    let res = await owner.post(`/api/admin/connections/${ids.one}`, { status: 'contacted', ownerNotes: 'Owner note: call back Tuesday.' });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.connection.status, 'contacted');
    assert.equal(res.json.connection.ownerNotes, 'Owner note: call back Tuesday.');

    res = await owner.post(`/api/admin/connections/${ids.one}`, { status: 'archived' }, { csrf: false });
    assert.equal(res.status, 403);
    assert.equal(res.json.code, 'CSRF');

    const rows = await query(srv.dbFile, "SELECT entity_data, performed_by FROM audit_log WHERE event_type = 'connection_updated' AND entity_id = ?", [ids.one]);
    assert.equal(rows.length, 1);
    assert.deepEqual(JSON.parse(rows[0].entity_data), { fields: ['status', 'owner_notes'], from: { status: 'new' }, to: { status: 'contacted' } });
    assert.ok(rows[0].performed_by);

    const feed = await owner.get('/api/admin/audit?entity_type=connection');
    assert.equal(feed.status, 200);
    assert.ok(feed.json.items.some((i) => i.eventType === 'connection_updated' && i.entityId === ids.one));
    assert.ok(!feed.text.includes('call back Tuesday'));
  });

  test('CSV export is an attachment with the fixed columns', async () => {
    const res = await owner.request('GET', '/api/admin/connections/export.csv?status=contacted');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/csv; charset=utf-8');
    assert.match(res.headers.get('content-disposition'), /^attachment; filename="connections-\d{4}-\d{2}-\d{2}\.csv"$/);
    const lines = res.text.replace(/^\uFEFF/, '').split('\r\n');
    assert.equal(lines[0], 'received_at,name,email,company,note,source,status,owner_notes');
    assert.equal(lines.length, 3);
    assert.match(lines[1], /,Test Visitor One,visitorone@example\.com,Example Co One,Private note One,qr,contacted,Owner note: call back Tuesday\.$/);
  });

  test('contact.vcf downloads the visitor as a vCard', async () => {
    const res = await owner.get(`/api/admin/connections/${ids.one}/contact.vcf`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/vcard; charset=utf-8');
    assert.equal(res.headers.get('content-disposition'), 'attachment; filename="test-visitor-one.vcf"');
    assert.match(res.text, /^BEGIN:VCARD\r\nVERSION:3\.0\r\nFN:Test Visitor One\r\nN:One;Test Visitor;;;\r\nORG:Example Co One\r\nEMAIL;TYPE=INTERNET:visitorone@example\.com\r\n/);
  });

  test('members get 403 on every connections route', async () => {
    await seedMember(srv.dbFile, { email: MEMBER, password: 'member password 1' });
    const member = clientFor(srv);
    assert.equal((await member.login(MEMBER, 'member password 1')).status, 200);
    const routes = [
      ['GET', '/api/admin/connections'],
      ['GET', '/api/admin/connections/export.csv'],
      ['POST', '/api/admin/connections/erase', { email: 'visitorone@example.com', confirm: 'visitorone@example.com' }],
      ['GET', `/api/admin/connections/${ids.one}`],
      ['POST', `/api/admin/connections/${ids.one}`, { status: 'archived' }],
      ['DELETE', `/api/admin/connections/${ids.one}`],
      ['GET', `/api/admin/connections/${ids.one}/contact.vcf`],
    ];
    for (const [method, route, json] of routes) {
      const res = await member.request(method, route, json ? { json } : {});
      assert.equal(res.status, 403, `${method} ${route}: ${res.text}`);
    }
    assert.equal((await query(srv.dbFile, 'SELECT COUNT(*) AS n FROM connections WHERE id = ?', [ids.one]))[0].n, 1);
  });

  test('erase by email removes every record for the address and returns the count', async () => {
    assert.equal((await send(visitor('Twice', { email: 'repeat@example.com' }))).status, 201);
    assert.equal((await send(visitor('Twice again', { email: 'Repeat@Example.com' }))).status, 201);
    let res = await owner.post('/api/admin/connections/erase', { email: 'repeat@example.com', confirm: 'someone@example.com' });
    assert.equal(res.status, 400);
    res = await owner.post('/api/admin/connections/erase', { email: 'repeat@example.com', confirm: 'repeat@example.com' });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json, { count: 2 });
    assert.equal((await query(srv.dbFile, "SELECT COUNT(*) AS n FROM connections WHERE email = 'repeat@example.com'"))[0].n, 0);
  });

  test('delete removes one connection', async () => {
    const res = await send(visitor('Delete'));
    assert.equal(res.status, 201);
    assert.deepEqual((await owner.del(`/api/admin/connections/${res.json.id}`)).json, { success: true });
    assert.equal((await owner.get(`/api/admin/connections/${res.json.id}`)).status, 404);
  });

  test('a restart purges rows past expires_at and audits the count', async () => {
    const res = await send(visitor('Expired'));
    assert.equal(res.status, 201);
    await query(srv.dbFile, "UPDATE connections SET expires_at = datetime(CURRENT_TIMESTAMP, '-1 minute') WHERE id = ?", [res.json.id]);

    const stop = await restartOnSameData(srv);
    try {
      await waitFor(async () => (await query(srv.dbFile, "SELECT 1 FROM audit_log WHERE event_type = 'connections_purged'")).length > 0, 'the purge audit entry');
    } finally {
      await stop();
    }
    assert.equal((await query(srv.dbFile, 'SELECT COUNT(*) AS n FROM connections WHERE id = ?', [res.json.id]))[0].n, 0);
    const [purge] = await query(srv.dbFile, "SELECT entity_data, performed_by FROM audit_log WHERE event_type = 'connections_purged'");
    assert.deepEqual(JSON.parse(purge.entity_data), { count: 1 });
    assert.equal(purge.performed_by, null);
    assert.equal((await owner.get(`/api/admin/connections/${ids.one}`)).status, 200, 'unexpired rows stay');
  });

  test('scripts/sign-ingest.js sends a signed connection and exits 0; a wrong secret exits 1', async () => {
    const args = ['scripts/sign-ingest.js', '--url', url(), '--name', 'Test Visitor Cli', '--email', 'visitorcli@example.com', '--source', 'link', '--note', 'Private note Cli'];
    submitted.push({ name: 'Test Visitor Cli', email: 'visitorcli@example.com', note: 'Private note Cli' });
    let out = await run(args, { CONNECT_INGEST_SECRET: srv.env.CONNECT_INGEST_SECRET });
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /^201 \{"ok":true,"id":"[0-9a-f-]{36}"\}\n$/);

    out = await run(args, { CONNECT_INGEST_SECRET: 'wrong-secret-0123456789abcdef0123456789' });
    assert.equal(out.code, 1);
    assert.match(out.stdout, /^401 .*"code":"BAD_SIGNATURE"/);

    out = await run(['scripts/sign-ingest.js', '--url', url()], {});
    assert.equal(out.code, 2);
    assert.match(out.stderr, /^Not sent: name, email, secret \(or CONNECT_INGEST_SECRET\) missing\./);
  });

  test('no submitted name, email, company or note appears in audit_log, server.log or the process output', async () => {
    // log() appends to server.log without waiting.
    await new Promise((r) => setTimeout(r, 300));
    const serverLog = fs.readFileSync(path.join(srv.dir, 'server.log'), 'utf8');
    assert.match(serverLog, /\[connect\] stored/, 'the scan covers a log that has connection entries');
    const audit = JSON.stringify(await query(srv.dbFile, 'SELECT * FROM audit_log'));
    assert.match(audit, /connection_created/);
    const haystacks = { audit_log: audit.toLowerCase(), 'server.log': serverLog.toLowerCase(), output: srv.output().toLowerCase() };

    const needles = new Set();
    for (const v of submitted) {
      for (const key of ['name', 'email', 'company', 'note']) if (v[key]) needles.add(String(v[key]).toLowerCase());
    }
    needles.add('call back tuesday');
    assert.ok(needles.size > 20);
    for (const [where, text] of Object.entries(haystacks)) {
      for (const needle of needles) assert.ok(!text.includes(needle), `${where} contains "${needle}"`);
    }
  });
});

describe('ingest limits that need their own server', () => {
  let srv;
  before(async () => { srv = await startServer({ env: { CONNECT_DAILY_CAP: '3' } }); });
  after(() => srv.stop());

  const send = (n) => postSigned({
    url: `${srv.url}/api/ingest/connections`,
    secret: srv.env.CONNECT_INGEST_SECRET,
    payload: buildPayload({ name: `Test Visitor ${n}`, email: `visitor${n}@example.com` }),
  });

  test('before /setup there is no organisation: 503 NOT_CONFIGURED', async () => {
    const res = await send(1);
    assert.equal(res.status, 503);
    assert.equal(res.json.code, 'NOT_CONFIGURED');
  });

  test('CONNECT_DAILY_CAP=3: the fourth send today is 429', async () => {
    const res = await clientFor(srv).setupOwner({ email: OWNER, password: OWNER_PASSWORD, setupToken: srv.env.SETUP_TOKEN });
    assert.equal(res.status, 200, res.text);
    for (const n of [2, 3, 4]) assert.equal((await send(n)).status, 201);
    const capped = await send(5);
    assert.equal(capped.status, 429);
    assert.equal(capped.json.code, 'RATE_LIMITED');
    assert.match(capped.headers.get('retry-after'), /^\d+$/);
  });
});
