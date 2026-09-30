'use strict';
// lib/connections.js on a bare Express app over a fully migrated temp database. Auth, CSRF and
// validation errors are small stand-ins with the same contracts as server.js; the database,
// rate limiters and audit writes are real.
const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { validationResult } = require('express-validator');
const { createTestDb } = require('../helpers/db');
const { load: loadConfig } = require('../../lib/config');
const connections = require('../../lib/connections');
const { signIngest } = require('../../lib/ingest-auth');
const { buildPayload, postSigned } = require('../../scripts/sign-ingest');

const SECRET = crypto.randomBytes(48).toString('base64');
const PREVIOUS = crypto.randomBytes(48).toString('base64');
const ORG = '0b1e2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const OTHER_ORG = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const OWNER = 'a0000000-0000-4000-8000-000000000001';
const MEMBER = 'a0000000-0000-4000-8000-000000000002';
const OTHER_OWNER = 'a0000000-0000-4000-8000-000000000003';
const CSRF = 'test-csrf-token';

async function makeApp({ env = {}, transporter = null, now, slug = 'donatelli-tech' } = {}) {
  const t = await createTestDb();
  await t.dbRun('INSERT INTO organisations (id, name, slug) VALUES (?, ?, ?)', [ORG, 'donatelli.tech', slug]);
  await t.dbRun('INSERT INTO organisations (id, name, slug) VALUES (?, ?, ?)', [OTHER_ORG, 'Other', 'other-org']);
  for (const [id, email, role, org] of [
    [OWNER, 'owner@example.com', 'owner', ORG],
    [MEMBER, 'member@example.com', 'member', ORG],
    [OTHER_OWNER, 'other@example.com', 'owner', OTHER_ORG],
  ]) {
    await t.dbRun('INSERT INTO users (id, email, password_hash, organisation_id, role) VALUES (?, ?, ?, ?, ?)', [id, email, 'x', org, role]);
  }

  const config = loadConfig({ JWT_SECRET: 'j'.repeat(48), CONNECT_INGEST_SECRET: SECRET, ...env });
  const logs = [];
  const app = express();
  app.use((req, res, next) => (req.path.startsWith('/api/ingest/') ? next() : express.json()(req, res, next)));

  const requireAuth = (req, res, next) => {
    const id = req.get('X-Test-User');
    if (!id) return res.status(401).json({ error: 'Unauthorized' });
    t.dbGet('SELECT role, organisation_id FROM users WHERE id = ?', [id]).then((row) => {
      if (!row) return res.status(401).json({ error: 'Unauthorized' });
      req.user = { id, role: row.role, organisationId: row.organisation_id };
      next();
    }, next);
  };
  const requireRole = (...roles) => (req, res, next) => (
    roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Forbidden: Insufficient permissions' })
  );
  const csrfProtection = (req, res, next) => {
    if (req.get('X-CSRF-Token') === CSRF) return next();
    const err = new Error('invalid csrf token');
    err.code = 'EBADCSRFTOKEN';
    next(err);
  };
  const handleValidationErrors = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    next();
  };
  const logAudit = (eventType, entityType, entityId, entityData, performedBy, organisationId) => t.dbRun(
    'INSERT INTO audit_log (id, event_type, entity_type, entity_id, entity_data, performed_by, organisation_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [crypto.randomUUID(), eventType, entityType, entityId, JSON.stringify(entityData), performedBy, organisationId]
  );

  const handle = connections.register(app, {
    express, db: t.db, dbRun: t.dbRun, dbGet: t.dbGet, dbAll: t.dbAll, dbRunInfo: t.dbRunInfo,
    logAudit, log: (message, data) => logs.push({ message, data }),
    requireAuth, requireRole, csrfProtection, handleValidationErrors,
    rateLimit, keyByUser: (req) => (req.user?.id ? 'u:' + req.user.id : req.ip),
    config, emailTransporter: transporter, escapeXml: (s) => s, fetch: globalThis.fetch,
    now: now || (() => new Date()),
  });
  app.use((err, req, res, next) => {
    if (err.code === 'EBADCSRFTOKEN') return res.status(403).json({ error: 'Session check failed.', code: 'CSRF' });
    res.status(500).json({ error: err.message });
  });

  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const url = `http://127.0.0.1:${server.address().port}`;

  async function call(method, path, { user, json, headers = {}, csrf = true } = {}) {
    const h = { ...headers };
    if (user) h['X-Test-User'] = user;
    if (csrf && method !== 'GET') h['X-CSRF-Token'] = CSRF;
    if (json !== undefined) h['Content-Type'] = 'application/json';
    const res = await fetch(url + path, { method, headers: h, body: json === undefined ? undefined : JSON.stringify(json) });
    // Decoded from the bytes: Response.text() would drop the CSV byte-order mark under test.
    const text = Buffer.from(await res.arrayBuffer()).toString('utf8');
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    return { status: res.status, headers: res.headers, json: parsed, text };
  }

  const ingestUrl = `${url}/api/ingest/connections`;
  const ingest = (fields, opts = {}) => postSigned({ url: ingestUrl, secret: SECRET, payload: buildPayload(fields), ...opts });

  return {
    ...t, app, url, ingestUrl, logs, handle, call, ingest,
    audit: (type) => t.dbAll('SELECT * FROM audit_log WHERE event_type = ? ORDER BY rowid', [type]),
    close: async () => {
      handle.stopTimers();
      await new Promise((r) => server.close(r));
      await t.close();
    },
  };
}

const visitor = (n, extra = {}) => ({ name: `Test Visitor ${n}`, email: `visitor${n}@example.com`, ...extra });
const hash16 = (n) => crypto.createHash('sha256').update(`visitor-${n}`).digest('hex').slice(0, 16);

describe('POST /api/ingest/connections', () => {
  let ctx;
  before(async () => { ctx = await makeApp(); });
  after(() => ctx.close());

  test('a signed payload is stored with 201; the row is normalised and expires per its retention', async () => {
    const payload = buildPayload({
      name: '  Test Visitor One  ', email: 'Visitor1@Example.COM', company: '', note: 'Line one\r\nLine two  ',
      source: 'qr', retentionDays: 90, ipHash: hash16(1),
    });
    const res = await postSigned({ url: ctx.ingestUrl, secret: SECRET, payload });
    assert.equal(res.status, 201, res.text);
    assert.deepEqual(res.json, { ok: true, id: payload.id });
    assert.equal(res.headers.get('cache-control'), 'no-store');

    const row = await ctx.dbGet('SELECT *, julianday(expires_at) - julianday(received_at) AS days FROM connections WHERE id = ?', [payload.id]);
    assert.equal(row.organisation_id, ORG);
    assert.equal(row.name, 'Test Visitor One');
    assert.equal(row.email, 'visitor1@example.com');
    assert.equal(row.company, null);
    assert.equal(row.note, 'Line one\nLine two');
    assert.equal(row.source, 'qr');
    assert.equal(row.status, 'new');
    assert.equal(row.retention_days, 90);
    assert.equal(row.days, 90);
    assert.equal(row.ip_hash, hash16(1));
    assert.equal(row.consent_notice, payload.consentNotice);
    assert.match(row.submitted_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    const [audit] = await ctx.audit('connection_created');
    assert.equal(audit.entity_type, 'connection');
    assert.equal(audit.entity_id, payload.id);
    assert.deepEqual(JSON.parse(audit.entity_data), { source: 'qr' });
    assert.equal(audit.performed_by, null);
    assert.equal(audit.organisation_id, ORG);
    assert.deepEqual(ctx.logs.find((l) => l.message === '[connect] stored').data, { id: payload.id, source: 'qr' });
  });

  test('the same id again is 200 duplicate, with no second row or audit entry', async () => {
    const payload = buildPayload(visitor(2));
    assert.equal((await postSigned({ url: ctx.ingestUrl, secret: SECRET, payload })).status, 201);
    const again = await postSigned({ url: ctx.ingestUrl, secret: SECRET, payload });
    assert.equal(again.status, 200);
    assert.deepEqual(again.json, { ok: true, duplicate: true });
    assert.equal((await ctx.dbGet('SELECT COUNT(*) AS n FROM connections WHERE id = ?', [payload.id])).n, 1);
    assert.equal((await ctx.audit('connection_created')).filter((a) => a.entity_id === payload.id).length, 1);
  });

  test('signature failures are 401 with MISSING, STALE or BAD_SIGNATURE', async () => {
    const body = JSON.stringify(buildPayload(visitor(3)));
    let res = await fetch(ctx.ingestUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    assert.equal(res.status, 401);
    assert.deepEqual(Object.keys(await res.json()).sort(), ['code', 'error', 'ok']);

    const cases = [
      [{ timestamp: Math.floor(Date.now() / 1000) - 301 }, 'STALE'],
      [{ timestamp: Math.floor(Date.now() / 1000) + 301 }, 'STALE'],
      [{ secret: 'not-the-secret-0123456789abcdef0123456789' }, 'BAD_SIGNATURE'],
    ];
    for (const [opts, code] of cases) {
      res = await ctx.ingest(visitor(3), opts);
      assert.equal(res.status, 401);
      assert.equal(res.json.ok, false);
      assert.equal(res.json.code, code);
    }
    res = await fetch(ctx.ingestUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dt-Timestamp': '1' }, body });
    assert.equal((await res.json()).code, 'MISSING');
  });

  test('a body that is not application/json is never parsed, so its signature cannot match', async () => {
    const body = JSON.stringify(buildPayload(visitor(3)));
    const { timestamp, signature } = signIngest({ secret: SECRET, body, timestamp: Math.floor(Date.now() / 1000) });
    const res = await fetch(ctx.ingestUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'X-Dt-Timestamp': timestamp, 'X-Dt-Signature': signature },
      body,
    });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).code, 'BAD_SIGNATURE');
  });

  test('a signed body that is not JSON, or not a v1 payload, is 400 INVALID naming the field only', async () => {
    let res = await postSigned({ url: ctx.ingestUrl, secret: SECRET, payload: 'not json' });
    assert.equal(res.status, 400);
    assert.equal(res.json.code, 'INVALID');

    const base = buildPayload(visitor(4, { company: 'Example Co', note: 'A note' }));
    const now = Date.now();
    const cases = {
      v: [2, '1', null],
      id: ['not-a-uuid', 42, null],
      submittedAt: [new Date(now - 25 * 3600 * 1000).toISOString(), new Date(now + 25 * 3600 * 1000).toISOString(), '2026-09-30', 'yesterday', null],
      name: ['', '   ', 'x'.repeat(121), 'Tab\there', 'Line\nbreak', 42, null],
      email: ['no-at-sign', 'a@b.c', 'two@@example.com', `${'x'.repeat(250)}@example.com`, 'sp ace@example.com', null],
      company: ['x'.repeat(121), 'Bell\u0007', 7],
      note: ['x'.repeat(1001), 'Nul\u0000', { text: 'object' }],
      source: ['email', 'QR', 5],
      consentVersion: ['1234567', '123456789', 'ABCDEF12', null],
      consentNotice: ['', 'x'.repeat(1001), null],
      retentionDays: [29, 1826, 365.5, '365', null],
      ipHash: ['abc', 'ABCDEF0123456789', '0123456789abcdef0', 16],
    };
    for (const [field, values] of Object.entries(cases)) {
      for (const value of values) {
        res = await postSigned({ url: ctx.ingestUrl, secret: SECRET, payload: { ...base, [field]: value } });
        assert.equal(res.status, 400, `${field}=${JSON.stringify(value)} → ${res.status} ${res.text}`);
        assert.deepEqual(res.json.code, 'INVALID');
        assert.match(res.json.error, new RegExp(`: ${field} is not valid`));
      }
    }

    const { email, ...withoutEmail } = base;
    res = await postSigned({ url: ctx.ingestUrl, secret: SECRET, payload: withoutEmail });
    assert.match(res.json.error, /: email is not valid/);
    res = await postSigned({ url: ctx.ingestUrl, secret: SECRET, payload: { ...base, phone: '+1 555 0100' } });
    assert.match(res.json.error, /: phone is not valid/);
    res = await postSigned({ url: ctx.ingestUrl, secret: SECRET, payload: [base] });
    assert.match(res.json.error, /: body is not valid/);
    assert.equal((await ctx.dbGet('SELECT COUNT(*) AS n FROM connections WHERE email = ?', [email])).n, 0);
  });

  test('accepted edge values: null source defaults to card, note keeps line breaks, uppercase id is stored lowercase', async () => {
    const id = crypto.randomUUID().toUpperCase();
    const res = await ctx.ingest(visitor(5, { id, source: null, note: 'a\nb', company: 'x'.repeat(120), retentionDays: 1825 }));
    assert.equal(res.status, 201, res.text);
    assert.equal(res.json.id, id.toLowerCase());
    const row = await ctx.dbGet('SELECT source, note, company, retention_days FROM connections WHERE id = ?', [id.toLowerCase()]);
    assert.deepEqual({ ...row }, { source: 'card', note: 'a\nb', company: 'x'.repeat(120), retention_days: 1825 });
  });

  test('a body over 16 KB is 413 TOO_LARGE in the ingest error shape', async () => {
    const res = await ctx.ingest(visitor(6, { note: 'x'.repeat(17 * 1024) }));
    assert.equal(res.status, 413);
    assert.deepEqual(res.json.ok, false);
    assert.equal(res.json.code, 'TOO_LARGE');
  });

  test('the sixth send from one ipHash in 15 minutes is 429 with retryAfterSeconds; other hashes and null are unaffected', async () => {
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await ctx.ingest(visitor(`7-${i}`, { ipHash: hash16(7) }))).status, 201);
    }
    const res = await ctx.ingest(visitor('7-5', { ipHash: hash16(7) }));
    assert.equal(res.status, 429);
    assert.equal(res.json.code, 'RATE_LIMITED');
    assert.ok(res.json.retryAfterSeconds > 14 * 60 && res.json.retryAfterSeconds <= 15 * 60, String(res.json.retryAfterSeconds));
    assert.equal(res.headers.get('retry-after'), String(res.json.retryAfterSeconds));
    assert.equal((await ctx.ingest(visitor('7-6', { ipHash: hash16(8) }))).status, 201);
    assert.equal((await ctx.ingest(visitor('7-7', { ipHash: null }))).status, 201);

    // Rows older than the window no longer count.
    await ctx.dbRun("UPDATE connections SET received_at = datetime(CURRENT_TIMESTAMP, '-16 minutes') WHERE ip_hash = ?", [hash16(7)]);
    assert.equal((await ctx.ingest(visitor('7-8', { ipHash: hash16(7) }))).status, 201);
  });

  test('a resend of a stored id is a duplicate even when its visitor is at the limit', async () => {
    const payloads = [];
    for (let i = 0; i < 5; i += 1) {
      payloads.push(buildPayload(visitor(`9-${i}`, { ipHash: hash16(9) })));
      assert.equal((await postSigned({ url: ctx.ingestUrl, secret: SECRET, payload: payloads[i] })).status, 201);
    }
    const res = await postSigned({ url: ctx.ingestUrl, secret: SECRET, payload: payloads[4] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true, duplicate: true });
  });
});

describe('ingest configuration, rotation and caps', () => {
  test('no CONNECT_INGEST_SECRET → 503 NOT_CONFIGURED', async () => {
    const ctx = await makeApp({ env: { CONNECT_INGEST_SECRET: '' } });
    try {
      const res = await ctx.ingest(visitor(1));
      assert.equal(res.status, 503);
      assert.equal(res.json.code, 'NOT_CONFIGURED');
    } finally {
      await ctx.close();
    }
  });

  test('no organisation with CONNECT_ORG_SLUG → 503 NOT_CONFIGURED', async () => {
    const ctx = await makeApp({ slug: 'donatelli-services' });
    try {
      const res = await ctx.ingest(visitor(1));
      assert.equal(res.status, 503);
      assert.equal(res.json.code, 'NOT_CONFIGURED');
      assert.equal((await ctx.dbGet('SELECT COUNT(*) AS n FROM connections')).n, 0);
    } finally {
      await ctx.close();
    }
  });

  test('CONNECT_INGEST_SECRET_PREVIOUS is accepted during a rotation', async () => {
    const ctx = await makeApp({ env: { CONNECT_INGEST_SECRET_PREVIOUS: PREVIOUS } });
    try {
      assert.equal((await ctx.ingest(visitor(1), { secret: PREVIOUS })).status, 201);
      assert.equal((await ctx.ingest(visitor(2))).status, 201);
    } finally {
      await ctx.close();
    }
  });

  test('the daily cap counts rows since the start of the UTC day', async () => {
    const ctx = await makeApp({ env: { CONNECT_DAILY_CAP: '2' } });
    try {
      assert.equal((await ctx.ingest(visitor(1))).status, 201);
      assert.equal((await ctx.ingest(visitor(2))).status, 201);
      const res = await ctx.ingest(visitor(3));
      assert.equal(res.status, 429);
      assert.equal(res.json.code, 'RATE_LIMITED');
      assert.ok(res.json.retryAfterSeconds >= 1 && res.json.retryAfterSeconds <= 86400);
      await ctx.dbRun("UPDATE connections SET received_at = datetime(CURRENT_TIMESTAMP, 'start of day', '-1 second')");
      assert.equal((await ctx.ingest(visitor(4))).status, 201);
    } finally {
      await ctx.close();
    }
  });
});

describe('new-connection email', () => {
  const wait = () => new Promise((r) => setTimeout(r, 50));

  test('carries a time, the source and a link, and no visitor details', async () => {
    const sent = [];
    const ctx = await makeApp({
      env: { CONNECT_NOTIFY_EMAIL: 'owner@example.com', APP_URL: 'https://admin.example.com', ADMIN_TIME_ZONE: 'America/Los_Angeles' },
      transporter: { sendMail: async (m) => { sent.push(m); return {}; } },
      now: () => new Date('2026-09-30T23:12:30Z'),
    });
    try {
      const payload = buildPayload({
        ...visitor(1, { company: 'Example Co', note: 'Private note', source: 'nfc' }),
        submittedAt: '2026-09-30T23:12:00.000Z',
      });
      const { timestamp, signature } = signIngest({ secret: SECRET, body: JSON.stringify(payload), timestamp: Date.parse('2026-09-30T23:12:30Z') / 1000 });
      const res = await fetch(ctx.ingestUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Dt-Timestamp': timestamp, 'X-Dt-Signature': signature },
        body: JSON.stringify(payload),
      });
      assert.equal(res.status, 201);
      await wait();
      assert.equal(sent.length, 1);
      assert.equal(sent[0].to, 'owner@example.com');
      assert.equal(sent[0].subject, 'New connection on donatelli.tech');
      assert.equal(sent[0].text, 'Someone sent their details from the card at 4:12 PM (source: nfc). Open https://admin.example.com/admin/connections to read them.');
      const everything = JSON.stringify(sent[0]);
      for (const secret of ['Test Visitor 1', 'visitor1@example.com', 'Example Co', 'Private note']) {
        assert.ok(!everything.includes(secret), secret);
      }
    } finally {
      await ctx.close();
    }
  });

  test('a failed send is logged without details and the connection is still stored', async () => {
    const ctx = await makeApp({
      env: { CONNECT_NOTIFY_EMAIL: 'owner@example.com' },
      transporter: { sendMail: async () => { throw new Error('connect ECONNREFUSED'); } },
    });
    try {
      assert.equal((await ctx.ingest(visitor(1))).status, 201);
      await wait();
      assert.deepEqual(ctx.logs.find((l) => l.message === '[connect] notification not sent').data, { error: 'connect ECONNREFUSED' });
    } finally {
      await ctx.close();
    }
  });

  test('no email without CONNECT_NOTIFY_EMAIL, or without a transporter', async () => {
    const sent = [];
    const withoutAddress = await makeApp({ transporter: { sendMail: async (m) => { sent.push(m); } } });
    const withoutTransport = await makeApp({ env: { CONNECT_NOTIFY_EMAIL: 'owner@example.com' } });
    try {
      assert.equal((await withoutAddress.ingest(visitor(1))).status, 201);
      assert.equal((await withoutTransport.ingest(visitor(1))).status, 201);
      await wait();
      assert.equal(sent.length, 0);
    } finally {
      await withoutAddress.close();
      await withoutTransport.close();
    }
  });
});

describe('admin API', () => {
  let ctx;
  const ids = {};
  const get = (path, opts) => ctx.call('GET', path, { user: OWNER, ...opts });
  const post = (path, json, opts) => ctx.call('POST', path, { user: OWNER, json, ...opts });

  before(async () => {
    ctx = await makeApp();
    const people = [
      ['a', visitor('A', { name: 'Ada Lovelace', company: 'Engines 100% Ltd', note: 'Needs numbers', source: 'nfc' })],
      ['b', visitor('B', { name: 'Grace Hopper', company: 'Compilers_Co' })],
      ['c', visitor('C', { name: 'Alan Turing', company: '=cmd|calc', note: '@SUM(1)', source: 'link' })],
      ['d', visitor('D', { name: 'Edsger Dijkstra', email: 'shared@example.com' })],
      ['e', visitor('E', { name: 'Barbara Liskov', email: 'SHARED@example.com' })],
    ];
    for (const [key, fields] of people) {
      const payload = buildPayload({ ...fields, ipHash: hash16(key) });
      ids[key] = payload.id;
      const res = await postSigned({ url: ctx.ingestUrl, secret: SECRET, payload });
      assert.equal(res.status, 201, res.text);
    }
    // Distinct receipt times so the order is known: a is oldest, e is newest.
    const order = ['a', 'b', 'c', 'd', 'e'];
    for (const [i, key] of order.entries()) {
      await ctx.dbRun(`UPDATE connections SET received_at = datetime(CURRENT_TIMESTAMP, '-${10 - i} minutes') WHERE id = ?`, [ids[key]]);
    }
    const foreign = buildPayload(visitor('F'));
    await ctx.dbRun(
      `INSERT INTO connections (id, organisation_id, name, email, consent_version, consent_notice, retention_days, expires_at, submitted_at)
       VALUES (?, ?, 'Other Org Visitor', 'visitorf@example.com', '0123abcd', 'Notice', 30, datetime('now', '+30 days'), datetime('now'))`,
      [foreign.id, OTHER_ORG]
    );
    ids.foreign = foreign.id;
  });
  after(() => ctx.close());

  test('list: newest first, list fields only, counts, no-store', async () => {
    const res = await get('/api/admin/connections');
    assert.equal(res.status, 200, res.text);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(res.json.items.map((i) => i.id), ['e', 'd', 'c', 'b', 'a'].map((k) => ids[k]));
    assert.deepEqual(Object.keys(res.json.items[0]).sort(), ['company', 'email', 'hasNote', 'id', 'name', 'receivedAt', 'source', 'status'].sort());
    assert.equal(res.json.items.find((i) => i.id === ids.a).hasNote, true);
    assert.equal(res.json.items.find((i) => i.id === ids.b).hasNote, false);
    assert.match(res.json.items[0].receivedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
    assert.equal(res.json.nextCursor, null);
    assert.deepEqual(res.json.counts, { new: 5, today: res.json.counts.today, week: 5, total: 5 });
    assert.ok(!res.text.includes('ip_hash') && !res.text.includes(hash16('a')));
  });

  test('list: cursor pages through in order with no overlap', async () => {
    const seen = [];
    let cursor = null;
    let pages = 0;
    do {
      const res = await get(`/api/admin/connections?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      assert.equal(res.status, 200, res.text);
      assert.ok(res.json.items.length <= 2);
      seen.push(...res.json.items.map((i) => i.id));
      cursor = res.json.nextCursor;
      pages += 1;
    } while (cursor);
    assert.equal(pages, 3);
    assert.deepEqual(seen, ['e', 'd', 'c', 'b', 'a'].map((k) => ids[k]));
  });

  test('list: search matches name, email or company, with LIKE wildcards taken literally', async () => {
    const q = async (text) => (await get(`/api/admin/connections?q=${encodeURIComponent(text)}`)).json.items.map((i) => i.id);
    assert.deepEqual(await q('lovelace'), [ids.a]);
    assert.deepEqual(await q('visitorb@'), [ids.b]);
    assert.deepEqual(await q('100%'), [ids.a]);
    assert.deepEqual(await q('%'), [ids.a]);
    assert.deepEqual(await q('_'), [ids.b]);
    assert.deepEqual(await q('Compilers_'), [ids.b]);
    assert.deepEqual(await q('shared'), [ids.e, ids.d]);
    assert.deepEqual(await q('Other Org'), []);
  });

  test('list: bad status, limit, cursor or a repeated key is 400', async () => {
    for (const qs of ['status=old', 'limit=0', 'limit=101', 'limit=abc', 'cursor=bm90LWpzb24', 'status=new&status=all', `q=${'x'.repeat(101)}`]) {
      const res = await get(`/api/admin/connections?${qs}`);
      assert.equal(res.status, 400, qs);
      assert.equal(typeof res.json.error, 'string');
    }
  });

  test('detail: every documented field and never ip_hash; other organisations are 404', async () => {
    const res = await get(`/api/admin/connections/${ids.a}`);
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.json.connection).sort(), [
      'id', 'name', 'email', 'company', 'note', 'source', 'status', 'ownerNotes', 'consentVersion', 'consentNotice',
      'retentionDays', 'submittedAt', 'receivedAt', 'expiresAt', 'updatedAt',
    ].sort());
    assert.equal(res.json.connection.company, 'Engines 100% Ltd');
    assert.ok(!res.text.includes(hash16('a')));
    assert.equal((await get(`/api/admin/connections/${ids.foreign}`)).status, 404);
    assert.equal((await get(`/api/admin/connections/${ids.a.toUpperCase()}`)).status, 200);
    assert.equal((await get('/api/admin/connections/not-a-uuid')).status, 400);
  });

  test('update: status and notes save; the audit names the fields and the status move, never the notes', async () => {
    let res = await post(`/api/admin/connections/${ids.b}`, { status: 'contacted' });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.connection.status, 'contacted');

    res = await post(`/api/admin/connections/${ids.b}`, { ownerNotes: '  Called Tuesday.\r\nFollow up in May.  ' });
    assert.equal(res.json.connection.ownerNotes, 'Called Tuesday.\nFollow up in May.');

    // Unchanged values write nothing.
    res = await post(`/api/admin/connections/${ids.b}`, { status: 'contacted', ownerNotes: 'Called Tuesday.\nFollow up in May.' });
    assert.equal(res.status, 200);

    const audits = (await ctx.audit('connection_updated')).filter((a) => a.entity_id === ids.b);
    assert.deepEqual(audits.map((a) => JSON.parse(a.entity_data)), [
      { fields: ['status'], from: { status: 'new' }, to: { status: 'contacted' } },
      { fields: ['owner_notes'], from: { status: 'contacted' }, to: { status: 'contacted' } },
    ]);
    assert.ok(audits.every((a) => a.performed_by === OWNER && a.organisation_id === ORG));
    assert.ok(!audits.some((a) => a.entity_data.includes('Called')));

    res = await post(`/api/admin/connections/${ids.b}`, { ownerNotes: null });
    assert.equal(res.json.connection.ownerNotes, null);
    res = await post(`/api/admin/connections/${ids.b}`, { ownerNotes: '   ' });
    assert.equal(res.json.connection.ownerNotes, null);
  });

  test('update: invalid or empty bodies are 400; unknown ids 404', async () => {
    for (const json of [{}, { status: 'done' }, { status: null }, { ownerNotes: 'x'.repeat(2001) }, { ownerNotes: 5 }, { ownerNotes: 'bell\u0007' }]) {
      const res = await post(`/api/admin/connections/${ids.b}`, json);
      assert.equal(res.status, 400, JSON.stringify(json));
    }
    assert.equal((await post(`/api/admin/connections/${crypto.randomUUID()}`, { status: 'archived' })).status, 404);
    assert.equal((await post(`/api/admin/connections/${ids.foreign}`, { status: 'archived' })).status, 404);
  });

  test('status filter and counts follow updates', async () => {
    await post(`/api/admin/connections/${ids.c}`, { status: 'archived' });
    const archived = await get('/api/admin/connections?status=archived');
    assert.deepEqual(archived.json.items.map((i) => i.id), [ids.c]);
    const fresh = await get('/api/admin/connections?status=new');
    assert.deepEqual(fresh.json.items.map((i) => i.id), [ids.e, ids.d, ids.a]);
    assert.equal(fresh.json.counts.new, 3);
    assert.equal(fresh.json.counts.total, 5);
  });

  test('CSV export: attachment, BOM, fixed columns, formula guard, audited with count and status', async () => {
    const res = await get('/api/admin/connections/export.csv');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/csv; charset=utf-8');
    assert.match(res.headers.get('content-disposition'), /^attachment; filename="connections-\d{4}-\d{2}-\d{2}\.csv"$/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const lines = res.text.split('\r\n');
    assert.equal(lines[0], '\uFEFFreceived_at,name,email,company,note,source,status,owner_notes');
    assert.equal(lines.length, 5 + 2);
    assert.equal(lines[6], '');
    const turing = lines.find((l) => l.includes('Alan Turing'));
    assert.match(turing, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z,Alan Turing,visitorc@example\.com,'=cmd\|calc,'@SUM\(1\),link,archived,$/);
    assert.ok(!res.text.includes(hash16('c')));

    const archivedOnly = await get('/api/admin/connections/export.csv?status=archived');
    assert.equal(archivedOnly.text.split('\r\n').length, 1 + 2);
    const audits = await ctx.audit('connections_exported');
    assert.deepEqual(audits.map((a) => JSON.parse(a.entity_data)), [{ count: 5, status: 'all' }, { count: 1, status: 'archived' }]);
    assert.ok(audits.every((a) => a.performed_by === OWNER));
  });

  test('contact.vcf: the visitor as a vCard attachment, audited', async () => {
    const res = await get(`/api/admin/connections/${ids.a}/contact.vcf`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/vcard; charset=utf-8');
    assert.equal(res.headers.get('content-disposition'), 'attachment; filename="ada-lovelace.vcf"');
    assert.match(res.text, /^BEGIN:VCARD\r\nVERSION:3\.0\r\nFN:Ada Lovelace\r\nN:Lovelace;Ada;;;\r\nORG:Engines 100% Ltd\r\n/);
    assert.doesNotMatch(res.text, /^TEL/m);
    const [audit] = await ctx.audit('connection_vcard_exported');
    assert.equal(audit.entity_id, ids.a);
    assert.deepEqual(JSON.parse(audit.entity_data), {});
    assert.equal((await get(`/api/admin/connections/${ids.foreign}/contact.vcf`)).status, 404);
  });

  test('erase by email: typed confirmation, case-insensitive, count only in the audit', async () => {
    let res = await post('/api/admin/connections/erase', { email: 'shared@example.com', confirm: 'shared@example.org' });
    assert.equal(res.status, 400);
    res = await post('/api/admin/connections/erase', { email: 'not an email', confirm: 'not an email' });
    assert.equal(res.status, 400);
    res = await post('/api/admin/connections/erase', { email: 'Shared@Example.com ', confirm: 'shared@example.com' });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json, { count: 2 });
    assert.equal((await ctx.dbGet("SELECT COUNT(*) AS n FROM connections WHERE email = 'shared@example.com'")).n, 0);
    res = await post('/api/admin/connections/erase', { email: 'visitorf@example.com', confirm: 'visitorf@example.com' });
    assert.deepEqual(res.json, { count: 0 }, 'another organisation is untouched');

    const audits = await ctx.audit('connections_erased');
    assert.deepEqual(audits.map((a) => JSON.parse(a.entity_data)), [{ count: 2 }, { count: 0 }]);
    assert.ok(audits.every((a) => !a.entity_data.includes('@') && !a.entity_id.includes('@')));
  });

  test('delete: 200 once, then 404; audited with an empty payload', async () => {
    assert.deepEqual((await ctx.call('DELETE', `/api/admin/connections/${ids.b}`, { user: OWNER })).json, { success: true });
    assert.equal((await ctx.call('DELETE', `/api/admin/connections/${ids.b}`, { user: OWNER })).status, 404);
    assert.equal((await ctx.call('DELETE', `/api/admin/connections/${ids.foreign}`, { user: OWNER })).status, 404);
    const [audit] = await ctx.audit('connection_deleted');
    assert.equal(audit.entity_id, ids.b);
    assert.deepEqual(JSON.parse(audit.entity_data), {});
  });

  test('writes need the CSRF token', async () => {
    const res = await ctx.call('POST', `/api/admin/connections/${ids.a}`, { user: OWNER, json: { status: 'archived' }, csrf: false });
    assert.equal(res.status, 403);
    assert.equal(res.json.code, 'CSRF');
    assert.equal((await ctx.call('DELETE', `/api/admin/connections/${ids.a}`, { user: OWNER, csrf: false })).status, 403);
    assert.equal((await ctx.call('POST', '/api/admin/connections/erase', { user: OWNER, json: { email: 'a@example.com', confirm: 'a@example.com' }, csrf: false })).status, 403);
  });

  test('members get 403 and anonymous callers 401 on every route, with no-store', async () => {
    const routes = [
      ['GET', '/api/admin/connections'],
      ['GET', '/api/admin/connections/export.csv'],
      ['POST', '/api/admin/connections/erase', { email: 'visitora@example.com', confirm: 'visitora@example.com' }],
      ['GET', `/api/admin/connections/${ids.a}`],
      ['POST', `/api/admin/connections/${ids.a}`, { status: 'archived' }],
      ['DELETE', `/api/admin/connections/${ids.a}`],
      ['GET', `/api/admin/connections/${ids.a}/contact.vcf`],
    ];
    for (const [method, path, json] of routes) {
      const asMember = await ctx.call(method, path, { user: MEMBER, json });
      assert.equal(asMember.status, 403, `${method} ${path}`);
      assert.equal(asMember.headers.get('cache-control'), 'no-store');
      assert.equal((await ctx.call(method, path, { json })).status, 401, `${method} ${path}`);
    }
    assert.equal((await get(`/api/admin/connections/${ids.a}`)).json.connection.status, 'new');
  });
});

describe('counts on the owner calendar', () => {
  test('today and this week start at local midnight in ADMIN_TIME_ZONE', async () => {
    // Noon on 30 September in Los Angeles (UTC-7): today starts 07:00 UTC, the week at 07:00 UTC on the 24th.
    const ctx = await makeApp({ env: { ADMIN_TIME_ZONE: 'America/Los_Angeles' }, now: () => new Date('2026-09-30T19:00:00Z') });
    try {
      const times = ['2026-09-30 18:59:00', '2026-09-30 07:00:00', '2026-09-30 06:59:59', '2026-09-24 07:00:00', '2026-09-24 06:59:59'];
      for (const [i, at] of times.entries()) {
        await ctx.dbRun(
          `INSERT INTO connections (id, organisation_id, name, email, status, consent_version, consent_notice, retention_days, expires_at, submitted_at, received_at)
           VALUES (?, ?, ?, ?, ?, '0123abcd', 'Notice', 30, '2099-01-01 00:00:00', ?, ?)`,
          [crypto.randomUUID(), ORG, `Visitor ${i}`, `visitor${i}@example.com`, i === 0 ? 'contacted' : 'new', at, at]
        );
      }
      const res = await ctx.call('GET', '/api/admin/connections', { user: OWNER });
      assert.deepEqual(res.json.counts, { new: 4, today: 2, week: 4, total: 5 });
    } finally {
      await ctx.close();
    }
  });

  test('zonedMidnight handles both daylight-saving changes', () => {
    assert.equal(connections.zonedMidnight(2026, 3, 8, 'America/Los_Angeles').toISOString(), '2026-03-08T08:00:00.000Z');
    assert.equal(connections.zonedMidnight(2026, 3, 9, 'America/Los_Angeles').toISOString(), '2026-03-09T07:00:00.000Z');
    assert.equal(connections.zonedMidnight(2026, 11, 1, 'America/Los_Angeles').toISOString(), '2026-11-01T07:00:00.000Z');
    assert.equal(connections.zonedMidnight(2026, 11, 2, 'America/Los_Angeles').toISOString(), '2026-11-02T08:00:00.000Z');
    assert.equal(connections.zonedMidnight(2026, 9, 30, 'UTC').toISOString(), '2026-09-30T00:00:00.000Z');
  });
});

describe('retention purge', () => {
  let ctx;
  beforeEach(async () => { if (ctx) await ctx.close(); ctx = await makeApp(); });
  after(() => ctx.close());

  test('purgeExpired deletes rows past expires_at and audits the count only', async () => {
    for (let i = 0; i < 3; i += 1) assert.equal((await ctx.ingest(visitor(i))).status, 201);
    await ctx.dbRun("UPDATE connections SET expires_at = datetime(CURRENT_TIMESTAMP, '-1 minute') WHERE email IN ('visitor0@example.com', 'visitor1@example.com')");

    assert.equal(await ctx.handle.purgeExpired(), 2);
    assert.deepEqual((await ctx.dbAll('SELECT email FROM connections')).map((r) => r.email), ['visitor2@example.com']);
    const [audit] = await ctx.audit('connections_purged');
    assert.deepEqual(JSON.parse(audit.entity_data), { count: 2 });
    assert.equal(audit.performed_by, null);
    assert.equal(audit.organisation_id, null);

    assert.equal(await ctx.handle.purgeExpired(), 0);
    assert.equal((await ctx.audit('connections_purged')).length, 1, 'nothing purged, nothing audited');
  });

  test('startTimers purges at once; stopTimers is safe to call twice', async () => {
    assert.equal((await ctx.ingest(visitor(1))).status, 201);
    await ctx.dbRun("UPDATE connections SET expires_at = datetime(CURRENT_TIMESTAMP, '-1 second')");
    ctx.handle.startTimers();
    ctx.handle.startTimers();
    for (let i = 0; i < 50 && (await ctx.audit('connections_purged')).length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal((await ctx.dbGet('SELECT COUNT(*) AS n FROM connections')).n, 0);
    assert.equal((await ctx.audit('connections_purged')).length, 1);
    ctx.handle.stopTimers();
    ctx.handle.stopTimers();
  });
});

describe('scripts/sign-ingest.js', () => {
  test('buildPayload has exactly the relay keys and a consent version derived from the notice', () => {
    const payload = buildPayload({ name: 'Test Visitor One', email: 'visitor1@example.com', retentionDays: 30 });
    assert.deepEqual(Object.keys(payload), ['v', 'id', 'submittedAt', 'name', 'email', 'company', 'note', 'source',
      'consentVersion', 'consentNotice', 'retentionDays', 'ipHash']);
    assert.equal(payload.consentNotice, 'Test connection sent with scripts/sign-ingest.js. Kept for 30 days, then deleted.');
    assert.equal(payload.consentVersion, crypto.createHash('sha1').update(payload.consentNotice).digest('hex').slice(0, 8));
    assert.equal(connections.validatePayload(payload, Date.now()).field, undefined);
  });
});
