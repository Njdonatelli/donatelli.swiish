'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { syncCredentials } = require('../../lib/credentials-sync');

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'site');
const TEXT = fs.readFileSync(path.join(FIXTURES, 'credentials.json'), 'utf8');
const SITE = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'site.json'), 'utf8'));
const TODAY = '2026-09-30';

const siteWith = (edit) => {
  const s = structuredClone(SITE);
  edit(s);
  return s;
};

test('the registry file round-trips through JSON.stringify(x, null, 2) + newline', () => {
  assert.equal(JSON.stringify(JSON.parse(TEXT), null, 2) + '\n', TEXT);
});

test('today\'s site.json already agrees with the registry: the text comes back untouched', () => {
  assert.deepEqual(syncCredentials(TEXT, SITE, TODAY), { text: TEXT, changedKeys: [] });
});

test('only the derived values and their dates change', () => {
  const site = siteWith((s) => {
    s.contactEmail = 'owner@example.com';
    s.owner.city = 'Carlsbad';
    s.owner.givenName = 'Nicolas';
    s.owner.name = 'Nicolas Donatelli';
    s.ownerSameAs = ['https://github.com/Njdonatelli', 'https://linkedin.com/in/example'];
  });
  const { text, changedKeys } = syncCredentials(TEXT, site, TODAY);
  assert.deepEqual(changedKeys.sort(), ['contact_email', 'owner_linkedin', 'owner_location', 'owner_name']);

  const before = JSON.parse(TEXT);
  const after = JSON.parse(text);
  assert.equal(after.entries.owner_name.value, 'Nicolas Donatelli');
  assert.equal(after.entries.owner_location.value, 'Carlsbad, California');
  assert.equal(after.entries.contact_email.value, 'owner@example.com');
  assert.equal(after.entries.owner_linkedin.value, 'https://linkedin.com/in/example');
  for (const key of changedKeys) {
    assert.equal(after.entries[key].date, TODAY, key);
    // status, verify, note, label and group are the owner's claims and stay as written
    for (const field of ['status', 'verify', 'note', 'label', 'group']) {
      assert.deepEqual(after.entries[key][field], before.entries[key][field], `${key}.${field}`);
    }
    assert.deepEqual(Object.keys(after.entries[key]), Object.keys(before.entries[key]), `${key} keeps its key order`);
  }
  // Every other entry and the _meta block are unchanged
  for (const key of Object.keys(before.entries).filter((k) => !changedKeys.includes(k))) {
    assert.deepEqual(after.entries[key], before.entries[key], key);
  }
  assert.deepEqual(after._meta, before._meta);
  assert.equal(text, JSON.stringify(after, null, 2) + '\n');
});

test('a change to one fact touches only that entry', () => {
  const { text, changedKeys } = syncCredentials(TEXT, siteWith((s) => { s.owner.regionName = 'Calif.'; }), TODAY);
  assert.deepEqual(changedKeys, ['owner_location']);
  const lines = (t) => t.split('\n');
  const changedLines = lines(text).filter((line, i) => line !== lines(TEXT)[i]);
  assert.deepEqual(changedLines, ['      "value": "San Marcos, Calif.",', `      "date": "${TODAY}",`]);
});

test('no LinkedIn link on the card leaves the LinkedIn entry as it is', () => {
  const { changedKeys } = syncCredentials(TEXT, siteWith((s) => { s.ownerSameAs = ['https://github.com/Njdonatelli']; }), TODAY);
  assert.deepEqual(changedKeys, []);
});

test('the first LinkedIn profile link wins; other links are ignored', () => {
  const site = siteWith((s) => {
    s.ownerSameAs = ['https://www.linkedin.com/company/example', 'https://www.linkedin.com/in/second/', 'https://www.linkedin.com/in/third/'];
  });
  const { text } = syncCredentials(TEXT, site, TODAY);
  assert.equal(JSON.parse(text).entries.owner_linkedin.value, 'https://www.linkedin.com/in/second/');
});

test('a public email set to null clears the registry value, as rule R3 requires', () => {
  const { text, changedKeys } = syncCredentials(TEXT, siteWith((s) => { s.contactEmail = null; }), TODAY);
  assert.deepEqual(changedKeys, ['contact_email']);
  assert.equal(JSON.parse(text).entries.contact_email.value, null);
  assert.equal(JSON.parse(text).entries.contact_email.status, 'verified');
});

test('an entry the registry does not have is not created', () => {
  const trimmed = JSON.parse(TEXT);
  delete trimmed.entries.owner_linkedin;
  const text = JSON.stringify(trimmed, null, 2) + '\n';
  const out = syncCredentials(text, siteWith((s) => { s.ownerSameAs = ['https://www.linkedin.com/in/example/']; }), TODAY);
  assert.deepEqual(out, { text, changedKeys: [] });
});
