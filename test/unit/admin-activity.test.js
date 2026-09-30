'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { activitySentence, EVENT_TYPES } = require('../../src/admin/activity');

const ROOT = path.join(__dirname, '..', '..');
const say = (eventType, data) => activitySentence({ eventType, data });

// lib/connections.js writes {fields, from:{status}, to:{status}} on every update, notes-only ones included.
test('a notes-only update reads as notes, not as a status change', () => {
  assert.equal(say('connection_updated', { fields: ['owner_notes'], from: { status: 'new' }, to: { status: 'new' } }), 'Connection notes updated.');
  assert.equal(say('connection_updated', { fields: ['status'], from: { status: 'new' }, to: { status: 'contacted' } }), 'Connection marked contacted.');
  assert.equal(
    say('connection_updated', { fields: ['status', 'owner_notes'], from: { status: 'contacted' }, to: { status: 'archived' } }),
    'Connection marked archived; notes updated.',
  );
});

test('counts and commits are shown when the row carries them', () => {
  assert.equal(say('connections_erased', { count: 2 }), 'Erased by email (2 records).');
  assert.equal(say('connections_exported', { count: 12, status: 'all' }), 'Connections exported (12).');
  assert.equal(say('site_published', { ref: null, commit: '3f2a1c9d0e8b7a6f5e4d3c2b1a0f9e8d7c6b5a49' }), 'Published to donatelli.tech (3f2a1c9).');
  assert.equal(say('site_rollback_requested', { dryRun: true, deploymentId: null }), 'Rollback plan requested.');
});

test('every audit event the server writes has its own sentence', () => {
  // Spec §4.7, the feed's three entity types.
  const spec = [
    'connection_created', 'connection_updated', 'connection_deleted', 'connection_vcard_exported',
    'connections_exported', 'connections_erased', 'connections_purged',
    'setup_completed', 'sessions_revoked', 'password_changed', 'password_reset', 'password_reset_cli',
    'site_preview_created', 'site_reverted', 'site_published', 'site_run_rerun', 'site_run_cancelled',
    'site_redeploy_requested', 'site_rollback_requested',
  ];
  assert.deepEqual([...EVENT_TYPES].sort(), [...spec].sort());

  const sources = ['server.js', ...fs.readdirSync(path.join(ROOT, 'lib')).map((f) => path.join('lib', f)), path.join('scripts', 'set-password.js')];
  const written = new Set();
  for (const file of sources) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const m of text.matchAll(/logAudit\(\s*'([a-z_]+)',\s*'(connection|site|auth)'/g)) written.add(m[1]);
  }
  assert.ok(written.size >= 10, `found ${written.size} logAudit calls`);
  for (const eventType of written) assert.ok(EVENT_TYPES.includes(eventType), `${eventType} has no sentence`);
});

test('an unknown event still reads as words', () => {
  assert.equal(say('something_new', {}), 'something new.');
  assert.equal(say('constructor', {}), 'constructor.');
});
