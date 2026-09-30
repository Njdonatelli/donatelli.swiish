'use strict';
// A visitor's details as a vCard 3.0 file (RFC 2426) for the owner's address book. The same
// escaping and folding rules as the website's tools/vcard.mjs, which builds the owner's own card.
// Never a TEL: the card form has no phone field, and nothing is inferred.

const CRLF = '\r\n';

// RFC 2426 §4: backslash, semicolon, comma and line breaks are escaped in text values. Nothing else
// is, because an address book shows any other escape literally.
const escapeText = (s) => String(s)
  .replace(/\\/g, '\\\\')
  .replace(/;/g, '\\;')
  .replace(/,/g, '\\,')
  .replace(/\r\n|\r|\n/g, '\\n');

// RFC 2426 §2.6: lines longer than 75 octets continue after CRLF and one space. Walking code points
// keeps every multi-byte UTF-8 sequence on one line.
function foldLine(line) {
  const out = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (bytes + n > 75) {
      out.push(cur);
      cur = ' ';
      bytes = 1;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join(CRLF);
}

// YYYY-MM-DD as the calendar in timeZone shows it, so "met on" matches the owner's own day.
function calendarDate(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// receivedAt: a Date or an ISO string. timeZone: the owner's zone for the "met on" date; REV is
// always UTC because RFC 2426 timestamps carry their zone.
function buildVisitorVCard({ name, email, company, note, source, receivedAt, timeZone = 'UTC' }) {
  const received = new Date(receivedAt);
  const words = String(name).trim().split(/\s+/);
  const family = words.pop();
  const given = words.join(' ');
  const met = `Met via the donatelli.tech card (${source}) on ${calendarDate(received, timeZone)}`;

  const lines = ['BEGIN:VCARD', 'VERSION:3.0'];
  lines.push(`FN:${escapeText(name)}`);
  lines.push(`N:${escapeText(family)};${escapeText(given)};;;`);
  if (company) lines.push(`ORG:${escapeText(company)}`);
  lines.push(`EMAIL;TYPE=INTERNET:${escapeText(email)}`);
  lines.push(`NOTE:${escapeText(note ? `${note}\n${met}` : met)}`);
  lines.push(`REV:${received.toISOString().replace(/\.\d{3}Z$/, 'Z')}`);
  lines.push('END:VCARD');
  return lines.map(foldLine).join(CRLF) + CRLF;
}

// ASCII only, so the name is safe inside a quoted Content-Disposition filename.
function vcardFilename(name) {
  const slug = String(name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return `${slug || 'contact'}.vcf`;
}

module.exports = { buildVisitorVCard, vcardFilename, escapeText, foldLine };
