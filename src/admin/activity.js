'use strict';
// CommonJS so node:test can require it without Babel. Kept to syntax that Babel compiles without
// runtime helpers: a helper import would turn this file into an ES module and break module.exports.

var shortSha = require('./format').shortSha;

// Audit rows carry no personal data (spec §4.7), so the sentences here never name a visitor.
function counted(label, d, noun) {
  return label + (d && d.count != null ? ' (' + d.count + (noun ? ' ' + noun : '') + ')' : '') + '.';
}

function withCommit(label, d) {
  return label + (d && d.commit ? ' (' + shortSha(d.commit) + ')' : '') + '.';
}

// lib/connections.js always writes to.status, also when only the notes changed, so the fields list is what
// says which of the two moved.
function connectionUpdated(d) {
  var fields = d && Array.isArray(d.fields) ? d.fields : [];
  var status = d && d.to && d.to.status;
  var marked = status && fields.indexOf('status') !== -1;
  var notes = fields.indexOf('owner_notes') !== -1;
  if (marked && notes) return 'Connection marked ' + status + '; notes updated.';
  if (marked) return 'Connection marked ' + status + '.';
  if (notes) return 'Connection notes updated.';
  return 'Connection updated.';
}

var SENTENCES = {
  connection_created: function (d) { return 'Connection received' + (d && d.source ? ' (source: ' + d.source + ')' : '') + '.'; },
  connection_updated: connectionUpdated,
  connection_deleted: function () { return 'Connection deleted.'; },
  connection_vcard_exported: function () { return 'Connection saved as a contact.'; },
  connections_exported: function (d) { return counted('Connections exported', d); },
  connections_erased: function (d) { return counted('Erased by email', d, 'records'); },
  connections_purged: function (d) { return counted('Expired connections deleted', d); },
  setup_completed: function () { return 'Admin set up.'; },
  sessions_revoked: function () { return 'Signed out everywhere.'; },
  password_changed: function () { return 'Password changed.'; },
  password_reset: function () { return 'Password reset by email link.'; },
  password_reset_cli: function () { return 'Password reset from the server shell.'; },
  site_preview_created: function (d) { return withCommit('Preview built', d); },
  site_reverted: function (d) { return withCommit('Earlier version sent to preview', d); },
  site_published: function (d) { return withCommit('Published to donatelli.tech', d); },
  site_run_rerun: function () { return 'Workflow run restarted.'; },
  site_run_cancelled: function () { return 'Workflow run cancelled.'; },
  site_redeploy_requested: function () { return 'Redeploy requested.'; },
  site_rollback_requested: function (d) { return d && d.dryRun ? 'Rollback plan requested.' : 'Rollback requested.'; },
};

function activitySentence(item) {
  var fn = Object.prototype.hasOwnProperty.call(SENTENCES, item.eventType) ? SENTENCES[item.eventType] : null;
  if (fn) return fn(item.data || {});
  return String(item.eventType).replace(/_/g, ' ') + '.';
}

module.exports = { activitySentence: activitySentence, EVENT_TYPES: Object.keys(SENTENCES) };
