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
    s.contactEmail = 'nick@donatelli.tech';
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
  assert.equal(after.entries.contact_email.value, 'nick@donatelli.tech');
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

// R3 fails while the registry names a LinkedIn URL the card does not list, and only git can edit the
// registry, so removing the profile from the card must clear it in the same commit.
test('no LinkedIn profile link on the card clears the LinkedIn entry; its status stays', () => {
  for (const ownerSameAs of [['https://github.com/Njdonatelli'], ['https://www.linkedin.com/company/example'], []]) {
    const { text, changedKeys } = syncCredentials(TEXT, siteWith((s) => { s.ownerSameAs = ownerSameAs; }), TODAY);
    assert.deepEqual(changedKeys, ['owner_linkedin'], JSON.stringify(ownerSameAs));
    const entry = JSON.parse(text).entries.owner_linkedin;
    assert.equal(entry.value, null);
    assert.equal(entry.date, TODAY);
    assert.equal(entry.status, 'verified');
  }
});

test('a LinkedIn profile on a country host or in another letter case is still the profile', () => {
  for (const url of ['https://ca.linkedin.com/in/nick-donatelli/', 'https://www.LinkedIn.com/in/nick-donatelli/']) {
    const { text } = syncCredentials(TEXT, siteWith((s) => { s.ownerSameAs = [url]; }), TODAY);
    assert.equal(JSON.parse(text).entries.owner_linkedin.value, url);
  }
});

test('a registry LinkedIn value the card still lists is kept when no other profile link matches', () => {
  const trimmed = JSON.parse(TEXT);
  trimmed.entries.owner_linkedin.value = 'https://linkedin.example/in/nick';
  const text = JSON.stringify(trimmed, null, 2) + '\n';
  const out = syncCredentials(text, siteWith((s) => { s.ownerSameAs = ['https://linkedin.example/in/nick']; }), TODAY);
  assert.deepEqual(out, { text, changedKeys: [] });
});

// The contact entry's check reads "Domain matches the site", which an address elsewhere cannot meet.
test('a public email off the site domain is synced but shows as pending, keeping its last confirmed date', () => {
  const { text, changedKeys } = syncCredentials(TEXT, siteWith((s) => { s.contactEmail = 'nick.donatelli@gmail.com'; }), TODAY);
  assert.deepEqual(changedKeys, ['contact_email']);
  const before = JSON.parse(TEXT).entries.contact_email;
  const entry = JSON.parse(text).entries.contact_email;
  assert.equal(entry.value, 'nick.donatelli@gmail.com');
  assert.equal(entry.status, 'pending');
  assert.equal(entry.date, before.date);
  for (const field of ['verify', 'note', 'label', 'group']) assert.equal(entry[field], before[field], field);

  const onDomain = syncCredentials(TEXT, siteWith((s) => { s.contactEmail = 'Nick@Donatelli.tech'; }), TODAY);
  assert.equal(JSON.parse(onDomain.text).entries.contact_email.status, 'verified');
  assert.equal(JSON.parse(onDomain.text).entries.contact_email.date, TODAY);
});

// Only git can edit the registry, so a pending status the sync set must not outlive the address that caused it.
test('a public email back on the site domain after an off-domain one is verified again', () => {
  const sync = (text, contactEmail) => syncCredentials(text, siteWith((s) => { s.contactEmail = contactEmail; }), TODAY).text;
  const before = JSON.parse(TEXT).entries.contact_email;

  let text = sync(TEXT, 'nick.donatelli@gmail.com');
  text = sync(text, 'nick@elsewhere.example');
  const back = JSON.parse(sync(text, 'hello@donatelli.tech')).entries.contact_email;
  assert.equal(back.value, 'hello@donatelli.tech');
  assert.equal(back.status, 'verified');
  assert.equal(back.date, TODAY);
  assert.deepEqual(Object.keys(back), Object.keys(before), 'no sync bookkeeping is left in the entry');

  // Cleared in between, the address still returns as verified.
  const cleared = sync(sync(TEXT, 'nick.donatelli@gmail.com'), null);
  assert.equal(JSON.parse(sync(cleared, 'hello@donatelli.tech')).entries.contact_email.status, 'verified');
});

test('a pending contact email the owner set stays pending through an off-domain round trip', () => {
  const owned = JSON.parse(TEXT);
  owned.entries.contact_email.status = 'pending';
  const sync = (text, contactEmail) => syncCredentials(text, siteWith((s) => { s.contactEmail = contactEmail; }), TODAY).text;
  const text = sync(sync(JSON.stringify(owned, null, 2) + '\n', 'nick.donatelli@gmail.com'), 'hello@donatelli.tech');
  const entry = JSON.parse(text).entries.contact_email;
  assert.equal(entry.status, 'pending');
  assert.deepEqual(Object.keys(entry), Object.keys(owned.entries.contact_email));
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

// The website checkout, when this machine has one: WEBSITE_DIR, a sibling of this repo, or the path the spec names.
const WEBSITE = [process.env.WEBSITE_DIR, path.join(__dirname, '..', '..', '..', 'donatelli-website'), '/home/user/donatelli-website']
  .filter(Boolean)
  .find((dir) => fs.existsSync(path.join(dir, 'tools', 'site-schema.mjs')));

// What the admin commits must pass the build's R3, or every preview of the edit fails at "Build site".
test('sync: every profile-link edit leaves a registry the website build accepts', { skip: WEBSITE ? false : 'no donatelli-website engine on this machine' }, async () => {
  const web = await import(path.join(WEBSITE, 'tools', 'site-schema.mjs'));
  const edits = [
    ['LinkedIn removed', ['https://github.com/Njdonatelli']],
    ['a company page instead', ['https://www.linkedin.com/company/example', 'https://github.com/Njdonatelli']],
    ['a country host', ['https://ca.linkedin.com/in/nick-donatelli/']],
    ['an upper-case host', ['https://www.LinkedIn.com/in/nick-donatelli/']],
    ['no profile links at all', []],
    ['another profile', ['https://www.linkedin.com/in/someone-else/']],
  ];
  for (const [name, ownerSameAs] of edits) {
    const site = siteWith((s) => { s.ownerSameAs = ownerSameAs; s.contactEmail = 'nick.donatelli@gmail.com'; });
    const { text } = syncCredentials(TEXT, site, TODAY);
    assert.deepEqual(web.credentialsErrors(site, JSON.parse(text)), [], name);
  }
});
