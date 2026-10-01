'use strict';
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { signIngest, verifyIngest } = require('../../lib/ingest-auth');

// The website checkout, for the cross-check against its relay; DT_WEBSITE_DIR points elsewhere.
const RELAY = path.join(process.env.DT_WEBSITE_DIR || '/home/user/donatelli-website', 'functions', 'api', 'connect.js');

const SECRET = 'test-secret-0123456789abcdef0123456789';
const OLD_SECRET = 'previous-secret-abcdef0123456789abcdef';
const NOW = 1790000000;
const BODY = '{"v":1,"id":"8a8f0a3e-2c1b-4d7e-9f00-3b2a1c0d9e8f"}';

const verifyAt = (overrides = {}) => {
  const { timestamp, signature } = signIngest({ secret: SECRET, body: BODY, timestamp: NOW });
  return verifyIngest({
    secrets: [SECRET],
    body: BODY,
    timestampHeader: timestamp,
    signatureHeader: signature,
    nowSeconds: NOW,
    ...overrides,
  });
};

// The website's Pages Function (functions/api/connect.js) asserts this same header for the same
// inputs, so a change to either signer fails a test in both repos.
test('fixed vector shared with the website relay', () => {
  assert.deepEqual(signIngest({ secret: SECRET, body: '{"v":1}', timestamp: '1790000000' }), {
    timestamp: '1790000000',
    signature: 'v1=1edc9386d61a9760524140d15d61b41e2f6cc035b33e1665e0dab93b45f594a2',
  });
});

test('the signature is HMAC-SHA256 over "<timestamp>.<body>", and a Buffer body signs the same bytes', () => {
  const expected = 'v1=' + crypto.createHmac('sha256', SECRET).update(`${NOW}.${BODY}`).digest('hex');
  assert.equal(signIngest({ secret: SECRET, body: BODY, timestamp: NOW }).signature, expected);
  assert.equal(signIngest({ secret: SECRET, body: Buffer.from(BODY), timestamp: NOW }).signature, expected);
  const accented = '{"name":"Zoë Ångström"}';
  assert.equal(
    signIngest({ secret: SECRET, body: Buffer.from(accented, 'utf8'), timestamp: NOW }).signature,
    signIngest({ secret: SECRET, body: accented, timestamp: NOW }).signature,
  );
});

test('a valid signature passes, including at exactly ±300 s', () => {
  assert.deepEqual(verifyAt(), { ok: true });
  assert.deepEqual(verifyAt({ nowSeconds: NOW + 300 }), { ok: true });
  assert.deepEqual(verifyAt({ nowSeconds: NOW - 300 }), { ok: true });
});

test('a timestamp 301 s off in either direction is STALE', () => {
  assert.deepEqual(verifyAt({ nowSeconds: NOW + 301 }), { ok: false, code: 'STALE' });
  assert.deepEqual(verifyAt({ nowSeconds: NOW - 301 }), { ok: false, code: 'STALE' });
});

test('a timestamp that is not unix seconds is STALE', () => {
  for (const ts of ['1790000000.5', '-1790000000', 'soon', '2026-09-30T12:00:00Z', '1'.repeat(13)]) {
    const signature = signIngest({ secret: SECRET, body: BODY, timestamp: ts }).signature;
    assert.deepEqual(verifyAt({ timestampHeader: ts, signatureHeader: signature }), { ok: false, code: 'STALE' }, ts);
  }
});

test('missing headers are MISSING', () => {
  assert.deepEqual(verifyAt({ timestampHeader: undefined }), { ok: false, code: 'MISSING' });
  assert.deepEqual(verifyAt({ signatureHeader: undefined }), { ok: false, code: 'MISSING' });
  assert.deepEqual(verifyAt({ signatureHeader: '' }), { ok: false, code: 'MISSING' });
});

test('a changed body, secret, timestamp or prefix is BAD_SIGNATURE', () => {
  assert.deepEqual(verifyAt({ body: BODY.replace('1', '2') }), { ok: false, code: 'BAD_SIGNATURE' });
  assert.deepEqual(verifyAt({ secrets: ['another-secret-0123456789abcdef0123'] }), { ok: false, code: 'BAD_SIGNATURE' });
  assert.deepEqual(verifyAt({ timestampHeader: String(NOW + 1) }), { ok: false, code: 'BAD_SIGNATURE' });
  const { signature } = signIngest({ secret: SECRET, body: BODY, timestamp: NOW });
  assert.deepEqual(verifyAt({ signatureHeader: signature.replace('v1=', 'v2=') }), { ok: false, code: 'BAD_SIGNATURE' });
  assert.deepEqual(verifyAt({ signatureHeader: signature.toUpperCase() }), { ok: false, code: 'BAD_SIGNATURE' });
});

test('no configured secret never verifies', () => {
  assert.deepEqual(verifyAt({ secrets: [] }), { ok: false, code: 'BAD_SIGNATURE' });
  assert.deepEqual(verifyAt({ secrets: [null, undefined, ''] }), { ok: false, code: 'BAD_SIGNATURE' });
});

test('during a rotation the PREVIOUS secret is accepted alongside the current one', () => {
  const old = signIngest({ secret: OLD_SECRET, body: BODY, timestamp: NOW });
  const secrets = [SECRET, OLD_SECRET];
  assert.deepEqual(verifyAt({ secrets, signatureHeader: old.signature }), { ok: true });
  assert.deepEqual(verifyAt({ secrets }), { ok: true });
  assert.deepEqual(verifyAt({ secrets: [SECRET], signatureHeader: old.signature }), { ok: false, code: 'BAD_SIGNATURE' });
});

test('comparison is timingSafeEqual on equal-length buffers, even when the header length is wrong', (t) => {
  const spy = t.mock.method(crypto, 'timingSafeEqual');
  const { signature } = signIngest({ secret: SECRET, body: BODY, timestamp: NOW });
  for (const header of [signature.slice(0, 10), signature + '00', 'v1=', 'x'.repeat(4096)]) {
    assert.deepEqual(verifyAt({ signatureHeader: header, secrets: [SECRET, OLD_SECRET] }), { ok: false, code: 'BAD_SIGNATURE' });
  }
  assert.deepEqual(verifyAt(), { ok: true });
  // Four bad headers and one good one, each against both secrets: no early exit.
  assert.equal(spy.mock.callCount(), 4 * 2 + 1);
  for (const call of spy.mock.calls) {
    const [a, b] = call.arguments;
    assert.ok(Buffer.isBuffer(a) && Buffer.isBuffer(b));
    assert.equal(a.length, b.length);
  }
  mock.restoreAll();
});

test('the website relay signs byte-for-byte like signIngest, and verifyIngest accepts it', { skip: !fs.existsSync(RELAY) && `${RELAY} is not present` }, async () => {
  const relay = await import(pathToFileURL(RELAY).href);
  for (let i = 0; i < 50; i += 1) {
    const secret = crypto.randomBytes(48).toString('base64');
    const timestamp = NOW + i * 7919;
    const body = JSON.stringify({ v: 1, name: `Zoë ${crypto.randomBytes(6).toString('hex')}`, note: 'a\nb' });
    const theirs = await relay.signIngest({ secret, body, timestamp });
    assert.deepEqual(theirs, signIngest({ secret, body, timestamp }));
    assert.deepEqual(verifyIngest({
      secrets: [secret], body: Buffer.from(body), timestampHeader: theirs.timestamp, signatureHeader: theirs.signature, nowSeconds: timestamp,
    }), { ok: true });
  }
});
