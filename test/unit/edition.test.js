'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { guard, isBlocked, BLOCKED_PREFIXES, BLOCKED_EXACT } = require('../../lib/edition');

test('the blocked lists are exactly the Swiish public surfaces in the spec', () => {
  assert.deepEqual(BLOCKED_PREFIXES, [
    '/api/cards/',
    '/api/admin/cards',
    '/api/qr/',
    '/api/upload',
    '/uploads/',
    '/manifest/',
    '/icons/',
    '/api/demo/',
    '/api/invitations/',
    '/api/admin/invitations',
  ]);
  assert.deepEqual(BLOCKED_EXACT, ['/api/settings']);
});

test('path table: Swiish card surfaces are blocked, admin and ingest paths pass', () => {
  const table = [
    ['/api/cards/short/Ab3dE6x', true],
    ['/api/cards/donatelli-tech/nick', true],
    ['/api/cards/nick/preview.png', true],
    ['/api/admin/cards', true],
    ['/api/admin/cards/0b7e/nick', true],
    ['/api/qr/Ab3dE6x', true],
    ['/api/upload', true],
    ['/uploads/photo.png', true],
    ['/manifest/nick.json', true],
    ['/icons/nick.svg', true],
    ['/api/demo/status', true],
    ['/api/invitations/abc', true],
    ['/api/invitations/abc/accept', true],
    ['/api/admin/invitations', true],
    ['/api/admin/invitations/abc/retry', true],
    ['/api/settings', true],
    ['/api/settings/', true],
    // Express routes ignore case, so the guard does too
    ['/API/Cards/short/Ab3dE6x', true],
    ['/Api/Settings', true],
    ['/UPLOADS/photo.png', true],

    ['/api/ingest/connections', false],
    ['/api/admin/connections', false],
    ['/api/admin/connections/export.csv', false],
    ['/api/admin/site', false],
    ['/api/admin/site/preview', false],
    ['/api/admin/card/qr.svg', false],
    ['/api/admin/settings', false],
    ['/api/admin/audit', false],
    ['/api/admin/logs', false],
    ['/api/auth/me', false],
    ['/api/auth/logout-all', false],
    ['/api/login', false],
    ['/api/logout', false],
    ['/api/setup/status', false],
    ['/api/setup/initialize', false],
    ['/api/csrf-token', false],
    ['/api/health', false],
    ['/api/settingsx', false],
    ['/', false],
    ['/login', false],
    ['/admin/connections', false],
    ['/static/js/main.js', false],
  ];
  for (const [path, blocked] of table) {
    assert.equal(isBlocked(path), blocked, path);
  }
});

function fakeRes() {
  return {
    headers: {},
    statusCode: 200,
    body: undefined,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('the middleware sends JSON 404 for blocked paths and noindex on every response', () => {
  const middleware = guard({});

  const blockedRes = fakeRes();
  let nextCalled = false;
  middleware({ path: '/api/cards/short/Ab3dE6x' }, blockedRes, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(blockedRes.statusCode, 404);
  assert.deepEqual(blockedRes.body, { error: 'Not found' });
  assert.equal(blockedRes.headers['x-robots-tag'], 'noindex, nofollow');

  const allowedRes = fakeRes();
  middleware({ path: '/api/health' }, allowedRes, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(allowedRes.body, undefined);
  assert.equal(allowedRes.headers['x-robots-tag'], 'noindex, nofollow');
});
