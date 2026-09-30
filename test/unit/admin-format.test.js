'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const f = require('../../src/admin/format');

test('parseDate reads SQLite timestamps as UTC and passes ISO through', () => {
  assert.equal(f.parseDate('2026-09-30 16:12:05').toISOString(), '2026-09-30T16:12:05.000Z');
  assert.equal(f.parseDate('2026-09-30T16:12:05Z').toISOString(), '2026-09-30T16:12:05.000Z');
  assert.equal(f.parseDate('2026-09-30T09:12:05-07:00').toISOString(), '2026-09-30T16:12:05.000Z');
  assert.equal(f.parseDate(null), null);
  assert.equal(f.parseDate(''), null);
  assert.equal(f.parseDate('not a date'), null);
});

test('formatTime gives "4:12 PM" with a plain space', () => {
  const t = f.formatTime('2026-09-30T16:12:00Z', 'en-US', 'UTC');
  assert.equal(t, '4:12 PM');
  assert.equal(f.formatTime('2026-09-30T23:12:00Z', 'en-US', 'America/Los_Angeles'), '4:12 PM');
  assert.equal(f.formatTime('2026-09-30T09:05:00Z', undefined, 'UTC'), '9:05 AM');
  assert.equal(f.formatTime(null), '');
});

test('formatDate and formatDateTime use YYYY-MM-DD in the given zone', () => {
  assert.equal(f.formatDate('2027-09-30 03:00:00', 'UTC'), '2027-09-30');
  assert.equal(f.formatDate('2027-09-30 03:00:00', 'America/Los_Angeles'), '2027-09-29');
  assert.equal(f.formatDateTime('2026-09-30T16:12:00Z', 'UTC'), '2026-09-30 16:12');
  assert.equal(f.formatDateTime('2026-09-30T00:05:00Z', 'UTC'), '2026-09-30 00:05');
});

test('relativeTime steps from minutes to hours to days to a date', () => {
  const now = new Date('2026-09-30T16:00:00Z');
  assert.equal(f.relativeTime('2026-09-30T15:59:30Z', now), 'just now');
  assert.equal(f.relativeTime('2026-09-30T16:00:05Z', now), 'just now');
  assert.equal(f.relativeTime('2026-09-30T15:55:00Z', now), '5 min ago');
  assert.equal(f.relativeTime('2026-09-30 14:00:00', now), '2 h ago');
  assert.equal(f.relativeTime('2026-09-27T16:00:00Z', now), '3 d ago');
  assert.match(f.relativeTime('2026-07-01T12:00:00Z', now), /^2026-07-0[12]$/);
});

test('pluralize keeps the number', () => {
  assert.equal(f.pluralize(1, 'change', 'changes'), '1 change');
  assert.equal(f.pluralize(3, 'change', 'changes'), '3 changes');
  assert.equal(f.pluralize(0, 'record', 'records'), '0 records');
});

test('daysUntil rounds down', () => {
  const now = new Date('2026-12-15T12:00:00Z');
  assert.equal(f.daysUntil('2026-12-29T12:00:00Z', now), 14);
  assert.equal(f.daysUntil('2026-12-29T11:00:00Z', now), 13);
  assert.equal(f.daysUntil('2026-12-14T12:00:00Z', now), -1);
  assert.equal(f.daysUntil(null, now), null);
});

test('formatEta', () => {
  assert.equal(f.formatEta(60), 'About 1 min left.');
  assert.equal(f.formatEta(150), 'About 3 min left.');
  assert.equal(f.formatEta(20), 'Less than 1 min left.');
  assert.equal(f.formatEta(null), '');
});

test('shortSha', () => {
  assert.equal(f.shortSha('3f2a1c9e0b8d7c6a5f4e3d2c1b0a9f8e7d6c5b4a'), '3f2a1c9');
  assert.equal(f.shortSha(null), '');
});

test('countCsvRecords counts records, not lines, and skips the header', () => {
  const header = '﻿received_at,name,email,company,note,source,status,owner_notes\r\n';
  assert.equal(f.countCsvRecords(header), 0);
  assert.equal(f.countCsvRecords(''), 0);
  const rows = header
    + '2026-09-30 16:12:05,Test Visitor One,visitor1@example.com,,"Line one\r\nline two, with ""quotes""",qr,new,\r\n'
    + '2026-09-30 16:13:05,Test Visitor Two,visitor2@example.com,Example Co,,card,contacted,\r\n';
  assert.equal(f.countCsvRecords(rows), 2);
  assert.equal(f.countCsvRecords(rows.replace(/\r\n$/, '')), 2);
});
