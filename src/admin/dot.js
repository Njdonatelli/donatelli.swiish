'use strict';
// CommonJS so node:test can require it without Babel. Kept to syntax that Babel compiles without
// runtime helpers: a helper import would turn this file into an ES module and break module.exports.

// Design system Decision 6: only the terminal mark takes the signal colour. The four two-part marks get a
// gradient split class; the stops live in admin.css.
var CLASS_BY_MARK = { '.': 'dot', '?': 'dot dot-q', '!': 'dot dot-x', ';': 'dot dot-s', ':': 'dot dot-c' };

function splitTerminalMark(text) {
  var s = String(text == null ? '' : text).replace(/\s+$/, '');
  var mark = s.charAt(s.length - 1);
  if (!Object.prototype.hasOwnProperty.call(CLASS_BY_MARK, mark)) {
    return { head: s, mark: null, cls: null };
  }
  return { head: s.slice(0, -1), mark: mark, cls: CLASS_BY_MARK[mark] };
}

// Schema group names ("Person", "Send me your details") become headings, and every heading ends in a mark.
function withTerminalMark(text) {
  var s = String(text == null ? '' : text).replace(/\s+$/, '');
  if (!s) return s;
  return splitTerminalMark(s).mark ? s : s + '.';
}

module.exports = { splitTerminalMark: splitTerminalMark, withTerminalMark: withTerminalMark };
