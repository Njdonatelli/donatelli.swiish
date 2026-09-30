'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildVisitorVCard, vcardFilename, foldLine } = require('../../lib/vcard');

const unfold = (card) => card.replace(/\r\n /g, '');

const VISITOR = {
  name: 'Test Visitor One',
  email: 'visitor1@example.com',
  company: 'Example Co',
  note: 'Scheduling is slow.',
  source: 'qr',
  receivedAt: '2026-09-30T19:12:05.000Z',
};

test('visitor vCard, byte for byte', () => {
  assert.equal(buildVisitorVCard(VISITOR), [
    'BEGIN:VCARD',
    'VERSION:3.0',
    'FN:Test Visitor One',
    'N:One;Test Visitor;;;',
    'ORG:Example Co',
    'EMAIL;TYPE=INTERNET:visitor1@example.com',
    // 76 octets, so the last character folds onto a continuation line.
    'NOTE:Scheduling is slow.\\nMet via the donatelli.tech card (qr) on 2026-09-3',
    ' 0',
    'REV:2026-09-30T19:12:05Z',
    'END:VCARD',
    '',
  ].join('\r\n'));
});

test('no company, no note: no ORG line, and the note is the "met via" line alone', () => {
  const card = buildVisitorVCard({ ...VISITOR, company: null, note: null, name: 'Cher', source: 'card' });
  assert.doesNotMatch(card, /^ORG/m);
  assert.match(card, /\r\nN:Cher;;;;\r\n/);
  assert.match(card, /\r\nNOTE:Met via the donatelli\.tech card \(card\) on 2026-09-30\r\n/);
});

test('never a TEL line, and every line ends in CRLF', () => {
  const card = buildVisitorVCard({ ...VISITOR, note: 'Call me on +1 555 0100' });
  assert.doesNotMatch(card, /^TEL/mi);
  assert.ok(card.endsWith('END:VCARD\r\n'));
  assert.doesNotMatch(card.replace(/\r\n/g, ''), /[\r\n]/);
});

test('escaping: backslash, semicolon, comma and line breaks in every text value', () => {
  const card = buildVisitorVCard({
    ...VISITOR,
    name: 'Ada; Lovelace, \\Countess',
    company: 'Engines; Analytical, Ltd',
    note: 'Line 1\r\nLine 2; a, b \\ c',
  });
  assert.match(card, /\r\nFN:Ada\\; Lovelace\\, \\\\Countess\r\n/);
  assert.match(card, /\r\nN:\\\\Countess;Ada\\; Lovelace\\,;;;\r\n/);
  assert.match(card, /\r\nORG:Engines\\; Analytical\\, Ltd\r\n/);
  const note = unfold(card).split('\r\n').find((l) => l.startsWith('NOTE:'));
  assert.equal(note, 'NOTE:Line 1\\nLine 2\\; a\\, b \\\\ c\\nMet via the donatelli.tech card (qr) on 2026-09-30');
});

test('lines over 75 octets fold with CRLF + space and never split a UTF-8 character', () => {
  const card = buildVisitorVCard({ ...VISITOR, note: 'Ω'.repeat(100) });
  for (const line of card.split('\r\n')) assert.ok(Buffer.byteLength(line, 'utf8') <= 75, line);
  assert.match(unfold(card), new RegExp(`\r\nNOTE:${'Ω'.repeat(100)}\\\\nMet via`));
  assert.doesNotMatch(card, /\uFFFD/);
  assert.equal(foldLine('x'.repeat(75)), 'x'.repeat(75));
  assert.equal(foldLine('x'.repeat(76)), `${'x'.repeat(75)}\r\n x`);
});

test('the "met on" date follows the owner time zone; REV stays UTC', () => {
  // 02:30 UTC on 1 October is still 30 September in Los Angeles.
  const card = buildVisitorVCard({ ...VISITOR, receivedAt: '2026-10-01T02:30:00.000Z', timeZone: 'America/Los_Angeles' });
  assert.match(unfold(card), /card \(qr\) on 2026-09-30\r\n/);
  assert.match(card, /\r\nREV:2026-10-01T02:30:00Z\r\n/);
  assert.match(unfold(buildVisitorVCard({ ...VISITOR, receivedAt: '2026-10-01T02:30:00.000Z' })), /on 2026-10-01\r\n/);
});

test('vcardFilename is an ASCII slug of the name, with a fallback', () => {
  assert.equal(vcardFilename('Test Visitor One'), 'test-visitor-one.vcf');
  assert.equal(vcardFilename('Zoë Ångström-Ñúñez'), 'zoe-angstrom-nunez.vcf');
  assert.equal(vcardFilename('"; rm -rf /'), 'rm-rf.vcf');
  assert.equal(vcardFilename('李雷'), 'contact.vcf');
  assert.equal(vcardFilename(''), 'contact.vcf');
  assert.ok(vcardFilename('a'.repeat(200)).length <= 64);
});
