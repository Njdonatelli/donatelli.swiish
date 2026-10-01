'use strict';
// A plain git branch name. Ref paths go into API URLs, where the URL parser resolves "." and ".."
// segments: "x/../main" passes a string compare with "main" and then addresses main itself. So a
// name with an empty or dot-led segment, "..", a ".lock" part or a trailing "." is refused, as git
// itself refuses it.
const SEGMENT = '[A-Za-z0-9_-][A-Za-z0-9._-]*';
const SHAPE = new RegExp(`^${SEGMENT}(/${SEGMENT})*$`);

function isBranchName(name) {
  return typeof name === 'string'
    && SHAPE.test(name)
    && !name.includes('..')
    && !/\.lock(\/|$)/.test(name)
    && !name.endsWith('.');
}

module.exports = { isBranchName };
