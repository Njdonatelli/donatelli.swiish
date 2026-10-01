'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { csvCell, toCsv } = require('../../lib/csv');

test('plain values pass through; null and undefined are empty cells', () => {
  assert.equal(csvCell('Test Visitor One'), 'Test Visitor One');
  assert.equal(csvCell(42), '42');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
  assert.equal(csvCell(''), '');
});

test('RFC 4180 quoting: commas, quotes and line breaks are quoted, quotes doubled', () => {
  assert.equal(csvCell('Example, Inc.'), '"Example, Inc."');
  assert.equal(csvCell('The "fast" one'), '"The ""fast"" one"');
  assert.equal(csvCell('line one\nline two'), '"line one\nline two"');
  assert.equal(csvCell('a\r\nb'), '"a\r\nb"');
});

test('formula guard: = + - @ TAB and CR at the start get a leading apostrophe', () => {
  assert.equal(csvCell('=HYPERLINK("http://example.com","x")'), `"'=HYPERLINK(""http://example.com"",""x"")"`);
  assert.equal(csvCell('+1 555'), "'+1 555");
  assert.equal(csvCell('-2+3'), "'-2+3");
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvCell('\tcmd'), "'\tcmd");
  assert.equal(csvCell('\rcmd'), `"'\rcmd"`);
  // Only the first character counts.
  assert.equal(csvCell('a=b'), 'a=b');
  assert.equal(csvCell('visitor1@example.com'), 'visitor1@example.com');
});

test('toCsv: UTF-8 BOM, header row, CRLF after every record, columns in the given order', () => {
  const columns = [{ key: 'name', header: 'name' }, { key: 'email', header: 'email' }, { key: 'note', header: 'note' }];
  const csv = toCsv([
    { email: 'visitor1@example.com', name: 'Zoë One', note: null },
    { email: 'visitor2@example.com', name: 'Two, Test', note: 'Line 1\nLine 2' },
  ], columns);
  assert.equal(csv,
    '\uFEFFname,email,note\r\n'
    + 'Zoë One,visitor1@example.com,\r\n'
    + '"Two, Test",visitor2@example.com,"Line 1\nLine 2"\r\n');
  assert.equal(Buffer.from(csv, 'utf8').subarray(0, 3).toString('hex'), 'efbbbf');
});

test('toCsv with no rows is the header alone', () => {
  assert.equal(toCsv([], [{ key: 'a', header: 'received_at' }]), '\uFEFFreceived_at\r\n');
});
