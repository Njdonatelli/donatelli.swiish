'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { previewMatches } = require('../../src/admin/preview-match');

const status = (headSha, publishable) => ({ preview: { headSha, publishable } });
const match = (opts) => previewMatches({ record: null, configKey: 'k', draft: null, hasChanges: true, ...opts });

test('no preview on admin-preview matches nothing', () => {
  assert.equal(match({ record: { commitSha: 'a1', kind: 'draft', key: 'k' }, status: status(null, false) }), false);
  assert.equal(match({ status: null, hasChanges: false }), false);
});

test("this browser's own preview matches while the draft is unchanged since it was built", () => {
  assert.equal(match({ record: { commitSha: 'a1', kind: 'draft', key: 'k' }, status: status('a1', true) }), true);
  assert.equal(match({ record: { commitSha: 'a1', kind: 'draft', key: 'k' }, configKey: 'k2', status: status('a1', true) }), false);
  assert.equal(match({ record: { commitSha: 'a1', kind: 'restore', key: null }, configKey: 'k2', status: status('a1', false) }), true);
});

// The phone built the preview from the shared draft; the laptop never did, or built an older one.
test('a preview another device built from this same draft matches, whatever this browser recorded', () => {
  const draft = { previewSha: 'b2', key: 'k' };
  assert.equal(match({ draft, status: status('b2', true) }), true);
  assert.equal(match({ record: { commitSha: 'a1', kind: 'draft', key: 'k' }, draft, status: status('b2', true) }), true);
  assert.equal(match({ draft, configKey: 'k2', status: status('b2', true) }), false, 'edited here since that draft was saved');
});

// Publishing it would ship some other change and drop this draft with it.
test('a green preview of something else does not match a draft with changes of its own', () => {
  assert.equal(match({ status: status('b2', true) }), false);
  assert.equal(match({ record: { commitSha: 'a1', kind: 'draft', key: 'k' }, status: status('b2', true) }), false);
  assert.equal(match({ draft: { previewSha: 'c3', key: 'k' }, status: status('b2', true) }), false);
});

test('with nothing pending here, a green preview built elsewhere (a restore, say) is publishable', () => {
  assert.equal(match({ hasChanges: false, status: status('b2', true) }), true);
  assert.equal(match({ hasChanges: false, status: status('b2', false) }), false);
  assert.equal(match({ hasChanges: false, record: { commitSha: 'a1', kind: 'draft', key: 'k' }, status: status('b2', true) }), true);
});
