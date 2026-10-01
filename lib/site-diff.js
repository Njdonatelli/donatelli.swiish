'use strict';
// Field-level differences between two site.json values. Objects are compared leaf by leaf, so a
// draft and an upstream commit that touch different fields can be combined; arrays are compared
// whole, because an index path ("card.links.1") means nothing once items are added or removed.

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const join = (prefix, key) => (prefix ? `${prefix}.${key}` : key);

function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

// A key present on one side only reports undefined on the other; apply() treats that as a delete.
function diff(a, b, prefix = '', out = []) {
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = [...Object.keys(a), ...Object.keys(b).filter((k) => !Object.hasOwn(a, k))];
    for (const key of keys) {
      diff(Object.hasOwn(a, key) ? a[key] : undefined, Object.hasOwn(b, key) ? b[key] : undefined, join(prefix, key), out);
    }
  } else if (!deepEqual(a, b)) {
    out.push({ path: prefix, from: a, to: b });
  }
  return out;
}

const clone = (v) => (v === undefined ? undefined : structuredClone(v));
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function apply(base, changes) {
  let result = clone(base);
  for (const { path, to } of changes) {
    if (path === '') {
      result = clone(to);
      continue;
    }
    const keys = path.split('.');
    // Paths come from client JSON; a prototype key would write onto Object.prototype, not the copy.
    if (keys.some((k) => UNSAFE_KEYS.has(k))) continue;
    if (!isPlainObject(result)) result = {};
    let node = result;
    for (const key of keys.slice(0, -1)) {
      if (!isPlainObject(node[key])) node[key] = {};
      node = node[key];
    }
    const last = keys[keys.length - 1];
    if (to === undefined) delete node[last];
    else node[last] = clone(to);
  }
  return result;
}

const paths = (changes) => changes.map((c) => c.path);

// Two paths collide when one is the other or contains it (a whole object replaced vs one of its fields).
const overlaps = (a, b) => a === b || a.startsWith(b + '.') || b.startsWith(a + '.');

module.exports = { diff, apply, paths, overlaps, deepEqual };
