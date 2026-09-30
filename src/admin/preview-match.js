'use strict';
// CommonJS so node:test can require it without Babel. Kept to syntax that Babel compiles without
// runtime helpers: a helper import would turn this file into an ES module and break module.exports.

// Whether the preview on admin-preview is the one this draft (or a restore) produced. `record` is what this
// browser stored when it last built one: {commitSha, kind:'draft'|'restore', key}. A record for any other
// commit is stale (another device built since), so it counts as no record and the server's green,
// publishable flag decides.
function previewMatches(record, configKey, status) {
  var preview = status && status.preview;
  var head = preview && preview.headSha;
  if (!head) return false;
  if (record && record.commitSha === head) {
    return record.kind === 'restore' || record.key === configKey;
  }
  return !!preview.publishable;
}

module.exports = { previewMatches: previewMatches };
