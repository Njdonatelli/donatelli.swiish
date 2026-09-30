// Path helpers for the site.json draft. Paths are dotted with numeric array indices ("card.links.0.url"),
// the same form the server's validator reports errors in.

export function splitPath(path) {
  return String(path).split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p));
}

export function getPath(obj, path) {
  let cur = obj;
  for (const key of splitPath(path)) {
    if (cur == null) return undefined;
    cur = cur[key];
  }
  return cur;
}

// Immutable set: copies only the containers on the path, so React sees a new object.
export function setPath(obj, path, value) {
  const keys = splitPath(path);
  const write = (node, i) => {
    const key = keys[i];
    const copy = Array.isArray(node) ? node.slice() : { ...(node || {}) };
    copy[key] = i === keys.length - 1 ? value : write(node == null ? undefined : node[key], i + 1);
    return copy;
  };
  return write(obj, 0);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function same(a, b) {
  return stableStringify(a) === stableStringify(b);
}

// Leaf-level for objects, whole-value for arrays: the rule lib/site-diff.js uses on the server, so the
// change count here agrees with the preview's.
export function diffConfig(a, b, prefix = '') {
  const out = [];
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  keys.forEach((k) => {
    const path = prefix ? prefix + '.' + k : k;
    const x = a ? a[k] : undefined;
    const y = b ? b[k] : undefined;
    if (isPlainObject(x) && isPlainObject(y)) out.push(...diffConfig(x, y, path));
    else if (!same(x, y)) out.push({ path, from: x === undefined ? null : x, to: y === undefined ? null : y });
  });
  return out;
}

export function stableStringify(v) {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (isPlainObject(v)) {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  }
  return JSON.stringify(v === undefined ? null : v);
}

// The schema node for a dotted path, stepping through properties and items.
export function schemaAt(schema, path) {
  let node = schema;
  for (const key of splitPath(path)) {
    if (!node) return null;
    if (typeof key === 'number') node = node.items;
    else node = node.properties ? node.properties[key] : null;
  }
  return node || null;
}

export function typesOf(node) {
  if (!node || node.type == null) return [];
  return Array.isArray(node.type) ? node.type : [node.type];
}
