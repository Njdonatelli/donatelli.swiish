'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { diff, apply, paths, overlaps, deepEqual } = require('../../lib/site-diff');

const SITE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'site', 'site.json'), 'utf8'));

test('equal values have no differences', () => {
  assert.deepEqual(diff(SITE, structuredClone(SITE)), []);
});

test('objects differ leaf by leaf, with dotted paths', () => {
  const b = structuredClone(SITE);
  b.owner.jobTitle = 'Operations consultant';
  b.card.connect.retentionDays = 365;
  assert.deepEqual(diff(SITE, b), [
    { path: 'owner.jobTitle', from: 'Operations & automation consultant', to: 'Operations consultant' },
    { path: 'card.connect.retentionDays', from: null, to: 365 },
  ]);
});

test('arrays are compared whole, never item by item', () => {
  const b = structuredClone(SITE);
  b.ownerSameAs = [...SITE.ownerSameAs, 'https://example.com/profile'];
  b.card.links = [{ label: 'Blog', url: 'https://example.com/' }];
  assert.deepEqual(paths(diff(SITE, b)), ['ownerSameAs', 'card.links']);
  const reordered = structuredClone(SITE);
  reordered.ownerSameAs.reverse();
  assert.deepEqual(diff(SITE, reordered), [{ path: 'ownerSameAs', from: SITE.ownerSameAs, to: reordered.ownerSameAs }]);
});

test('a key on one side only reports undefined on the other', () => {
  const b = structuredClone(SITE);
  b.owner.phone = '555';
  delete b.year;
  assert.deepEqual(diff(SITE, b), [
    { path: 'owner.phone', from: undefined, to: '555' },
    { path: 'year', from: 2026, to: undefined },
  ]);
});

test('a value replaced by a different type is one change at that path', () => {
  const b = structuredClone(SITE);
  b.card.connect = null;
  assert.deepEqual(diff(SITE, b), [{ path: 'card.connect', from: SITE.card.connect, to: null }]);
});

test('apply sets, adds and deletes paths on a copy, leaving the base untouched', () => {
  const before = structuredClone(SITE);
  const out = apply(SITE, [
    { path: 'tagline', to: 'Remote operations and automation' },
    { path: 'owner.phone', to: '555' },
    { path: 'year', to: undefined },
    { path: 'card.connect.enabled', to: true },
  ]);
  assert.deepEqual(SITE, before);
  assert.equal(out.tagline, 'Remote operations and automation');
  assert.equal(out.owner.phone, '555');
  assert.equal(Object.hasOwn(out, 'year'), false);
  assert.equal(out.card.connect.enabled, true);
});

test('apply(a, diff(a, b)) rebuilds b, and changes applied to another base carry over', () => {
  const b = structuredClone(SITE);
  b.tagline = 'Remote operations and automation';
  b.ownerSameAs = ['https://github.com/Njdonatelli'];
  delete b.card.lede;
  assert.deepEqual(apply(SITE, diff(SITE, b)), b);

  const upstream = structuredClone(SITE);
  upstream.year = 2027;
  const rebased = apply(upstream, diff(SITE, b));
  assert.equal(rebased.year, 2027);
  assert.equal(rebased.tagline, 'Remote operations and automation');
});

test('apply copies the values it sets, so later edits to the change do not leak in', () => {
  const links = [{ label: 'Blog', url: 'https://example.com/' }];
  const out = apply(SITE, [{ path: 'card.links', to: links }]);
  links[0].label = 'Changed';
  assert.equal(out.card.links[0].label, 'Blog');
});

test('apply never writes through a prototype key', () => {
  const hostile = JSON.parse('{"__proto__": {"polluted": true}, "owner": {"constructor": {"prototype": {"polluted": true}}}}');
  const out = apply(SITE, diff(SITE, { ...structuredClone(SITE), ...hostile }));
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(out.tagline, SITE.tagline);
});

test('overlaps: the same path, or one containing the other', () => {
  assert.equal(overlaps('owner.jobTitle', 'owner.jobTitle'), true);
  assert.equal(overlaps('card.connect', 'card.connect.notice'), true);
  assert.equal(overlaps('card.connect.notice', 'card.connect'), true);
  assert.equal(overlaps('owner.name', 'owner.givenName'), false);
  assert.equal(overlaps('card.links', 'card.lede'), false);
});

test('deepEqual ignores key order in objects but not item order in arrays', () => {
  assert.equal(deepEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 }), true);
  assert.equal(deepEqual([1, 2], [2, 1]), false);
  assert.equal(deepEqual({ a: undefined }, {}), false);
});
