'use strict';
// CommonJS so node:test can require it without Babel. Kept to syntax that Babel compiles without
// runtime helpers: a helper import would turn this file into an ES module and break module.exports.

// Whether the preview on admin-preview is the one this draft (or a restore) produced, so Publish ships what
// the owner is looking at. Publish also drops the draft, so a preview of other changes must not match.
//   record      what this browser stored when it last built one: {commitSha, kind:'draft'|'restore', key}
//   configKey   the draft as it is in this browser now
//   draft       the server's draft as loaded: {previewSha, key}; previewSha is the preview built from it,
//               on any device
//   hasChanges  whether this browser's draft differs from main
function previewMatches(opts) {
  var status = opts.status;
  var preview = status && status.preview;
  var head = preview && preview.headSha;
  if (!head) return false;
  var record = opts.record;
  if (record && record.commitSha === head) {
    return record.kind === 'restore' || record.key === opts.configKey;
  }
  var draft = opts.draft;
  if (draft && draft.previewSha === head) return draft.key === opts.configKey;
  // Built elsewhere from nothing this browser has pending, such as a restore on the phone.
  return !opts.hasChanges && !!preview.publishable;
}

module.exports = { previewMatches: previewMatches };
