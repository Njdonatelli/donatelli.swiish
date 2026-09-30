'use strict';
// lib/site-schema.js against the shared cases file. The website runs the same cases through its ESM
// engine (tools/site-schema.mjs); the sync tests below fail when the copies here drift from it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { validate, crossFieldErrors, readOnlyViolations, isReadOnlyPath, listFields } = require('../../lib/site-schema');

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'site');
const read = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const SCHEMA = JSON.parse(read('site.schema.json'));
const SITE = JSON.parse(read('site.json'));
const CASES = JSON.parse(read('site-schema.cases.json'));

// The website checkout, when this machine has one: WEBSITE_DIR, a sibling of this repo, or the
// path the spec names.
const WEBSITE = [process.env.WEBSITE_DIR, path.join(__dirname, '..', '..', '..', 'donatelli-website'), '/home/user/donatelli-website']
  .filter(Boolean)
  .find((dir) => fs.existsSync(path.join(dir, 'data', 'site.schema.json')));

const setPath = (obj, dotted, value) => {
  const keys = dotted.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k];
  o[keys[keys.length - 1]] = value;
};
const siteWith = (sets) => {
  const s = structuredClone(SITE);
  for (const { path: p, value } of sets) setPath(s, p, value);
  return s;
};
const errorsOf = (s) => [...validate(SCHEMA, s), ...crossFieldErrors(s)];
const messageAt = (s, p) => errorsOf(s).filter((e) => e.path === p).map((e) => e.message);

test('the fixture site.json round-trips byte for byte and passes every rule', () => {
  assert.equal(JSON.stringify(SITE, null, 2) + '\n', read('site.json'));
  assert.deepEqual(errorsOf(SITE), []);
});

test('the shared cases file holds the 21 cases', () => {
  assert.equal(CASES.length, 21);
});

for (const [i, c] of CASES.entries()) {
  test(`case ${i + 1}: ${c.name}`, () => {
    const found = [...new Set(errorsOf(siteWith(c.set)).map((e) => e.path))].sort();
    assert.deepEqual(found, c.expect);
  });
}

test('messages match the website build word for word', () => {
  const m = (sets, p) => messageAt(siteWith(sets), p);
  const plain = 'use plain text (no < > " backtick, and & only before a space).';
  assert.deepEqual(m([{ path: 'tagline', value: 42 }], 'tagline'), ['must be a string.']);
  assert.deepEqual(m([{ path: 'bookingUrl', value: 42 }], 'bookingUrl'), ['must be a string or null.']);
  assert.deepEqual(m([{ path: 'year', value: 2026.5 }], 'year'), ['must be an integer.']);
  assert.deepEqual(m([{ path: 'card.connect.retentionDays', value: '365' }], 'card.connect.retentionDays'), ['must be an integer or null.']);
  assert.deepEqual(m([{ path: 'card.showQr', value: 'yes' }], 'card.showQr'), ['must be true or false.']);
  const noYear = structuredClone(SITE);
  delete noYear.year;
  assert.deepEqual(messageAt(noYear, 'year'), ['is required.']);
  assert.deepEqual(m([{ path: 'owner.phone', value: '555' }], 'owner.phone'), ['is not a known field.']);
  assert.deepEqual(m([{ path: 'name', value: 'Donatelli' }], 'name'), ['must be "donatelli.tech".']);
  assert.deepEqual(m([{ path: 'tagline', value: 'ab' }], 'tagline'), ['2 characters; the minimum is 3.']);
  assert.deepEqual(m([{ path: 'card.lede', value: 'x'.repeat(161) }], 'card.lede'), ['161 characters; the limit is 160.']);
  assert.deepEqual(m([{ path: 'bookingUrl', value: 'https://calendly.com/x' }], 'bookingUrl'), ["Use a Cal.com link (https://cal.com/...). The site's security policy only allows Cal.com."]);
  assert.deepEqual(m([{ path: 'year', value: 2023 }], 'year'), ['must be at least 2024.']);
  assert.deepEqual(m([{ path: 'year', value: 2101 }], 'year'), ['must be at most 2100.']);
  assert.deepEqual(m([{ path: 'card.links', value: Array.from({ length: 5 }, () => ({ label: 'L', url: 'https://a.b/' })) }], 'card.links'), ['has 5 items; the limit is 4.']);
  assert.deepEqual(m([{ path: 'tagline', value: '<b>x</b>' }], 'tagline'), [`contains "<"; ${plain}`]);
  assert.deepEqual(m([{ path: 'tagline', value: 'A &amp; B' }], 'tagline'), [`contains "&"; ${plain}`]);
  assert.deepEqual(m([{ path: 'tagline', value: 'Say "hi"' }], 'tagline'), [`contains a double quote; ${plain}`]);
  assert.deepEqual(m([{ path: 'tagline', value: 'Tab\there' }], 'tagline'), [`contains a control character; ${plain}`]);
  assert.deepEqual(m([{ path: 'tagline', value: 'Ends with &' }], 'tagline'), []);
  assert.deepEqual(m([{ path: 'owner.region', value: 'Calif' }], 'owner.region'), ['Two capital letters, e.g. CA.']);
});

test('keywords the fixture schema does not use still work: enum, minItems, a bare pattern', () => {
  const schema = {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['a', 'b'] },
      list: { type: 'array', minItems: 2, items: { type: 'string' } },
      code: { type: 'string', pattern: '^[0-9]+$' },
    },
  };
  assert.deepEqual(validate(schema, { mode: 'c', list: ['x'], code: 'x1' }), [
    { path: 'mode', message: 'must be one of: a, b.' },
    { path: 'list', message: 'has 1 item; the minimum is 2.' },
    { path: 'code', message: 'does not match the expected format.' },
  ]);
});

test('x-plainText reaches strings deep in the document and inside arrays', () => {
  assert.equal(messageAt(siteWith([{ path: '_meta.rule', value: 'a <b> rule' }]), '_meta.rule').length, 1);
  assert.equal(messageAt(siteWith([{ path: 'alternateNames', value: ['Ok', 'Not`ok'] }]), 'alternateNames.1').length, 1);
  assert.equal(messageAt(siteWith([{ path: 'card.links', value: [{ label: 'A>B', url: 'https://example.com/' }] }]), 'card.links.0.label').length, 1);
});

test('prototype keys are unknown fields, not a way around the schema', () => {
  const hostile = JSON.parse('{"__proto__": {"x": 1}, "constructor": "x"}');
  const errors = validate(SCHEMA, { ...structuredClone(SITE), ...hostile });
  assert.deepEqual(errors, [
    { path: '__proto__', message: 'is not a known field.' },
    { path: 'constructor', message: 'is not a known field.' },
  ]);
});

test('lengths count characters, not UTF-16 units', () => {
  assert.deepEqual(messageAt(siteWith([{ path: 'card.lede', value: '\u{1F44B}'.repeat(160) }]), 'card.lede'), []);
});

test('R1 and R2 name the field and the rule', () => {
  assert.deepEqual(crossFieldErrors(siteWith([{ path: 'owner.name', value: 'Nicolas Donatelli' }])), [
    { path: 'owner.name', message: 'must equal given name + space + family name ("Nick Donatelli").' },
  ]);
  const on = [{ path: 'card.connect.enabled', value: true }];
  assert.deepEqual(crossFieldErrors(siteWith(on)), [
    { path: 'card.connect.notice', message: 'is required while the form is on.' },
    { path: 'card.connect.retentionDays', message: 'is required while the form is on.' },
  ]);
  const ready = siteWith([...on, { path: 'card.connect.notice', value: 'x'.repeat(40) }, { path: 'card.connect.retentionDays', value: 365 }]);
  assert.deepEqual(errorsOf(ready), []);
});

test('the cross-field rules tolerate a malformed document instead of throwing', () => {
  assert.deepEqual(crossFieldErrors(null), []);
  assert.deepEqual(crossFieldErrors({ owner: 'x', card: [] }), []);
  assert.ok(validate(SCHEMA, null).length > 0);
});

test('readOnlyViolations flags each read-only field that moved, and nothing else', () => {
  const after = siteWith([
    { path: 'name', value: 'donatelli.tech ' },
    { path: 'owner.photo', value: '/other.webp' },
    { path: 'owner.country', value: 'CA' },
    { path: 'alternateNames', value: ['Donatelli'] },
    { path: '_meta.rule', value: 'A different rule.' },
    { path: 'tagline', value: 'Remote operations and automation' },
  ]);
  const msg = 'This field is read-only in the admin.';
  assert.deepEqual(readOnlyViolations(SCHEMA, SITE, after), [
    { path: '_meta', message: msg },
    { path: 'name', message: msg },
    { path: 'alternateNames', message: msg },
    { path: 'owner.country', message: msg },
    { path: 'owner.photo', message: msg },
  ]);
  assert.deepEqual(readOnlyViolations(SCHEMA, SITE, structuredClone(SITE)), []);
  const dropped = structuredClone(SITE);
  delete dropped.owner.photoSmall;
  assert.deepEqual(readOnlyViolations(SCHEMA, SITE, dropped), [{ path: 'owner.photoSmall', message: msg }]);
});

test('isReadOnlyPath follows read-only ancestors', () => {
  assert.equal(isReadOnlyPath(SCHEMA, '_meta.rule'), true);
  assert.equal(isReadOnlyPath(SCHEMA, 'owner.photo'), true);
  assert.equal(isReadOnlyPath(SCHEMA, 'owner.jobTitle'), false);
  assert.equal(isReadOnlyPath(SCHEMA, 'card.connect.notice'), false);
  assert.equal(isReadOnlyPath(SCHEMA, 'not.a.field'), false);
});

test('listFields: every tabbed field in schema order, with its limits', () => {
  const fields = listFields(SCHEMA);
  assert.deepEqual(fields.map((f) => f.path), [
    'name', 'alternateNames', 'tagline', 'bookingUrl', 'contactEmail',
    'owner.name', 'owner.givenName', 'owner.familyName', 'owner.jobTitle', 'owner.city', 'owner.region', 'owner.regionName',
    'owner.country', 'owner.photo', 'owner.photoSmall',
    'sameAs', 'ownerSameAs', 'year',
    'card.lede', 'card.links', 'card.showQr', 'card.connect.enabled', 'card.connect.intro', 'card.connect.notice', 'card.connect.retentionDays',
  ]);
  const by = Object.fromEntries(fields.map((f) => [f.path, f]));
  assert.deepEqual(by.tagline, {
    path: 'tagline', type: 'string', title: 'Tagline', description: 'Footer line and home page eyebrow.', widget: null,
    minLength: 3, maxLength: 60, minimum: null, maximum: null, maxItems: null, patternHint: null, nullable: false,
    tab: 'website', group: 'Brand', readOnly: false,
  });
  assert.equal(by.bookingUrl.nullable, true);
  assert.equal(by.bookingUrl.patternHint, "Use a Cal.com link (https://cal.com/...). The site's security policy only allows Cal.com.");
  assert.equal(by['owner.photo'].readOnly, true);
  assert.equal(by.name.readOnly, true);
  assert.equal(by.alternateNames.type, 'string[]');
  assert.equal(by.year.type, 'integer');
  assert.equal(by['card.showQr'].type, 'boolean');
  assert.equal(by['card.connect.notice'].widget, 'textarea');
  assert.equal(by['card.connect.retentionDays'].minimum, 30);
  assert.equal(by['card.connect.retentionDays'].nullable, true);
  assert.equal(by['card.links'].type, 'object[]');
  assert.equal(by['card.links'].maxItems, 4);
  assert.deepEqual(by['card.links'].itemFields.map((f) => [f.key, f.type, f.title, f.maxLength]), [['label', 'string', 'Label', 40], ['url', 'string', 'Link', 200]]);
  assert.deepEqual([...new Set(fields.map((f) => f.tab))].sort(), ['card', 'website']);
  assert.ok(fields.every((f) => f.group), 'every field names its form section');
});

test('sync: the fixtures match the website checkout', { skip: WEBSITE ? false : 'no donatelli-website checkout on this machine' }, () => {
  const pairs = [
    ['site-schema.cases.json', 'tools/test/fixtures/site-schema.cases.json'],
    ['site.schema.json', 'data/site.schema.json'],
    ['site.json', 'tools/test/fixtures/site.json'],
  ];
  for (const [mine, theirs] of pairs) {
    const other = path.join(WEBSITE, theirs);
    if (!fs.existsSync(other)) continue;
    assert.equal(read(mine), fs.readFileSync(other, 'utf8'), `test/fixtures/site/${mine} differs from ${other}; copy it over.`);
  }
});

// The byte-identical cases file only helps if both engines read it the same way, so the website's own
// engine runs here too, on every shared case and on documents the 21 cases do not reach.
test('sync: the website engine gives the same errors, in the same order, as this one', { skip: WEBSITE && fs.existsSync(path.join(WEBSITE, 'tools', 'site-schema.mjs')) ? false : 'no donatelli-website engine on this machine' }, async () => {
  const web = await import(path.join(WEBSITE, 'tools', 'site-schema.mjs'));
  const webErrorsOf = (s) => [...web.validate(SCHEMA, s), ...web.crossFieldErrors(s)];
  const docs = CASES.map((c) => [c.name, siteWith(c.set)]);
  const siteText = JSON.stringify(SITE);
  docs.push(
    ['prototype keys at the root', { ...structuredClone(SITE), ...JSON.parse('{"__proto__": {"x": 1}, "constructor": "x", "toString": "x"}') }],
    ['a prototype key in a nested object', JSON.parse(siteText.replace('"connect":{', '"connect":{"hasOwnProperty":"x",'))],
    ['wrong types', siteWith([{ path: 'year', value: 2026.5 }, { path: 'card.showQr', value: 'yes' }, { path: 'card.connect.retentionDays', value: '365' }])],
    ['lengths in characters', siteWith([{ path: 'owner.givenName', value: '\u{1F44B}'.repeat(41) }, { path: 'tagline', value: 'a' }])],
    ['plain text everywhere', siteWith([{ path: '_meta.rule', value: 'a <b>' }, { path: 'alternateNames', value: ['A&B'] }, { path: 'card.links', value: [{ label: 'x`', url: 'https://example.com/' }] }])],
    ['the form on without its notice', siteWith([{ path: 'card.connect.enabled', value: true }, { path: 'card.connect.retentionDays', value: 10 }])],
    ['not an object', null],
  );
  for (const [name, doc] of docs) assert.deepEqual(webErrorsOf(doc), errorsOf(doc), name);
});
