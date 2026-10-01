'use strict';
// CommonJS so node:test can require it without Babel. Kept to syntax that Babel compiles without
// runtime helpers: a helper import would turn this file into an ES module and break module.exports.

var MINUTE = 60 * 1000;
var HOUR = 60 * MINUTE;
var DAY = 24 * HOUR;

// The admin server's ADMIN_TIME_ZONE once the session knows it; until then the browser's own zone.
var defaultZone = null;

function setTimeZone(timeZone) {
  if (!timeZone) {
    defaultZone = null;
    return;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timeZone });
    defaultZone = timeZone;
  } catch (e) {
    // An old browser without that zone keeps the zone it had; a wrong clock beats a view that throws.
  }
}

// SQLite CURRENT_TIMESTAMP gives "2026-09-30 16:12:05" with no zone; it is UTC, and Date() would read it
// as local time.
var SQLITE_UTC = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/;

function parseDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') return new Date(value);
  var s = String(value);
  var m = SQLITE_UTC.exec(s);
  var d = new Date(m ? m[1] + 'T' + m[2] + 'Z' : s);
  return isNaN(d.getTime()) ? null : d;
}

function parts(date, timeZone) {
  var opts = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  if (timeZone || defaultZone) opts.timeZone = timeZone || defaultZone;
  var out = {};
  var list = new Intl.DateTimeFormat('en-US', opts).formatToParts(date);
  for (var i = 0; i < list.length; i++) out[list[i].type] = list[i].value;
  return out;
}

// '4:12 PM'. ICU 72+ puts a narrow no-break space before AM/PM; copy and tests expect a plain space.
function formatTime(date, locale, timeZone) {
  var d = parseDate(date);
  if (!d) return '';
  var opts = { hour: 'numeric', minute: '2-digit' };
  if (timeZone || defaultZone) opts.timeZone = timeZone || defaultZone;
  return new Intl.DateTimeFormat(locale || 'en-US', opts).format(d).replace(/[  ]/g, ' ');
}

// '2026-09-30': the site's own date style (sitemap, credentials.json), unambiguous in any locale.
function formatDate(date, timeZone) {
  var d = parseDate(date);
  if (!d) return '';
  var p = parts(d, timeZone);
  return p.year + '-' + p.month + '-' + p.day;
}

function formatDateTime(date, timeZone) {
  var d = parseDate(date);
  if (!d) return '';
  var p = parts(d, timeZone);
  return p.year + '-' + p.month + '-' + p.day + ' ' + p.hour + ':' + p.minute;
}

function relativeTime(date, now) {
  var d = parseDate(date);
  if (!d) return '';
  var ref = parseDate(now == null ? new Date() : now);
  var diff = ref.getTime() - d.getTime();
  // Clock skew between the admin host and the browser can put a fresh row a few seconds in the future.
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return Math.floor(diff / MINUTE) + ' min ago';
  if (diff < DAY) return Math.floor(diff / HOUR) + ' h ago';
  if (diff < 30 * DAY) return Math.floor(diff / DAY) + ' d ago';
  return formatDate(d);
}

function pluralize(n, one, many) {
  return n + ' ' + (n === 1 ? one : many);
}

// Whole days left, rounded down, so "14 days" never overstates the time before a token expires.
function daysUntil(date, now) {
  var d = parseDate(date);
  if (!d) return null;
  var ref = parseDate(now == null ? new Date() : now);
  return Math.floor((d.getTime() - ref.getTime()) / DAY);
}

function formatEta(seconds) {
  if (seconds == null || !isFinite(seconds)) return '';
  if (seconds < 60) return 'Less than 1 min left.';
  return 'About ' + Math.round(seconds / 60) + ' min left.';
}

function shortSha(sha) {
  return sha ? String(sha).slice(0, 7) : '';
}

// Data rows in an RFC 4180 export: record breaks outside quotes, minus the header. A note can hold a
// line break inside quotes, so counting lines would overcount.
function countCsvRecords(text) {
  var s = String(text || '').replace(/^﻿/, '');
  if (!s) return 0;
  var records = 0;
  var quoted = false;
  var sawContent = false;
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    if (c === '"') quoted = !quoted;
    if (!quoted && c === '\n') {
      if (sawContent) records++;
      sawContent = false;
    } else if (c !== '\r') {
      sawContent = true;
    }
  }
  if (sawContent) records++;
  return Math.max(0, records - 1);
}

// A visitor's email is stored as typed, and '?', '&' and '=' are legal in it, so a plain
// 'mailto:' + email would let it add cc, bcc, subject or body fields (RFC 6068) to the owner's
// reply. Encoding both sides of the last '@' keeps the whole value as the one recipient.
function mailtoHref(email) {
  var text = String(email || '');
  var at = text.lastIndexOf('@');
  if (at < 0) return 'mailto:' + encodeURIComponent(text);
  return 'mailto:' + encodeURIComponent(text.slice(0, at)) + '@' + encodeURIComponent(text.slice(at + 1));
}

module.exports = {
  mailtoHref: mailtoHref,
  setTimeZone: setTimeZone,
  parseDate: parseDate,
  formatTime: formatTime,
  formatDate: formatDate,
  formatDateTime: formatDateTime,
  relativeTime: relativeTime,
  pluralize: pluralize,
  daysUntil: daysUntil,
  formatEta: formatEta,
  shortSha: shortSha,
  countCsvRecords: countCsvRecords,
};
