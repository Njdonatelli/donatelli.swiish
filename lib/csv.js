'use strict';
// CSV for the connections export: RFC 4180 quoting and CRLF records, with a UTF-8 BOM so Excel
// reads accented names correctly instead of guessing a legacy code page.

const BOM = '\uFEFF';
const CRLF = '\r\n';

// Visitors type these values, and a spreadsheet runs a cell that starts with one of these
// characters as a formula (OWASP "CSV injection"). A leading apostrophe makes it plain text.
const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

function csvCell(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows, columns) {
  const lines = [columns.map((c) => csvCell(c.header)).join(',')];
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c.key])).join(','));
  return BOM + lines.join(CRLF) + CRLF;
}

module.exports = { csvCell, toCsv };
