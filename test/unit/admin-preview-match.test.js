'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { previewMatches } = require('../../src/admin/preview-match');

const status = (headSha, publishable) => ({ preview: { headSha, publishable } });

test('no preview on admin-preview matches nothing', () => {
  assert.equal(previewMatches({ commitSha: 'a1', kind: 'draft', key: 'k' }, 'k', status(null, false)), false);
  assert.equal(previewMatches(null, 'k', null), false);
});

test("this browser's own preview matches while the draft is unchanged since it was built", () => {
  assert.equal(previewMatches({ commitSha: 'a1', kind: 'draft', key: 'k' }, 'k', status('a1', true)), true);
  assert.equal(previewMatches({ commitSha: 'a1', kind: 'draft', key: 'k' }, 'k2', status('a1', true)), false);
  assert.equal(previewMatches({ commitSha: 'a1', kind: 'restore', key: null }, 'k2', status('a1', false)), true);
});

test('a browser with no record trusts the server: a green preview is publishable', () => {
  assert.equal(previewMatches(null, 'k', status('b2', true)), true);
  assert.equal(previewMatches(null, 'k', status('b2', false)), false);
});

// The phone builds a preview after the laptop built an older one: the laptop's record names a commit that is
// no longer on admin-preview, so it says nothing about the new preview.
test('a record of an older preview is ignored, as if this browser had none', () => {
  assert.equal(previewMatches({ commitSha: 'a1', kind: 'draft', key: 'k' }, 'k', status('b2', true)), true);
  assert.equal(previewMatches({ commitSha: 'a1', kind: 'draft', key: 'k' }, 'k', status('b2', false)), false);
});
