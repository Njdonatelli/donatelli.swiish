'use strict';
// The admin's copy of the website's data/site.json validator. The website build
// (donatelli-website tools/site-schema.mjs) is the authority; this engine runs the same keywords and
// messages so the owner sees a problem before a preview is built, not in a red CI run. The schema
// itself is read from GitHub at the main head, so only this engine is duplicated, and
// test/fixtures/site/site-schema.cases.json (byte-identical to the website's) keeps the two in step.

const typeOf = (v) => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
};
const TYPE_WORDS = { string: 'a string', integer: 'an integer', number: 'a number', boolean: 'true or false', array: 'a list', object: 'an object', null: 'null' };
const typeMatches = (want, got) => want === got || (want === 'number' && got === 'integer');
const join = (a, b) => (a ? `${a}.${b}` : String(b));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// JSON Schema counts code points, so an emoji is one character, as a person would count it.
const chars = (s) => [...s].length;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// site.json values are interpolated into the site's HTML without escaping, so markup-significant
// characters are refused here as they are in the build. "&" followed by a space is how the copy is
// written ("Remote operations & automation"); any other "&" could start an entity.
const plainTextProblem = (s) => {
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '<' || c === '>' || c === '`') return `"${c}"`;
    if (c === '"') return 'a double quote';
    if (/[\u0000-\u001F\u007F]/.test(c)) return 'a control character';
    if (c === '&' && i + 1 < s.length && !/\s/.test(s[i + 1])) return '"&"';
  }
  return null;
};
const PLAIN_HINT = 'use plain text (no < > " backtick, and & only before a space).';

function walk(schema, value, p, parentPlain, errors) {
  // x-plainText: false turns the inherited rule off for a node and everything under it, as in the website's
  // engine. The link fields use it: a URL's query carries &, and the link pattern refuses markup itself.
  const plain = schema['x-plainText'] === false ? false : (parentPlain || schema['x-plainText'] === true);
  const push = (message, at = p) => errors.push({ path: at, message });
  const got = typeOf(value);
  if (schema.type) {
    const want = [].concat(schema.type);
    if (!want.some((t) => typeMatches(t, got))) {
      push(`must be ${want.map((t) => TYPE_WORDS[t] || t).join(' or ')}.`);
      return;
    }
  }
  if (schema.const !== undefined && value !== schema.const) push(`must be ${JSON.stringify(schema.const)}.`);
  if (schema.enum && !schema.enum.includes(value)) push(`must be one of: ${schema.enum.join(', ')}.`);

  if (got === 'string') {
    const bad = plain && plainTextProblem(value);
    if (bad) push(`contains ${bad}; ${PLAIN_HINT}`);
    const n = chars(value);
    if (schema.minLength !== undefined && n < schema.minLength) push(`${plural(n, 'character', 'characters')}; the minimum is ${schema.minLength}.`);
    if (schema.maxLength !== undefined && n > schema.maxLength) push(`${plural(n, 'character', 'characters')}; the limit is ${schema.maxLength}.`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) push(schema['x-patternHint'] || 'does not match the expected format.');
  }

  if (got === 'integer' || got === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) push(`must be at least ${schema.minimum}.`);
    if (schema.maximum !== undefined && value > schema.maximum) push(`must be at most ${schema.maximum}.`);
  }

  if (got === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) push(`has ${plural(value.length, 'item', 'items')}; the minimum is ${schema.minItems}.`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) push(`has ${plural(value.length, 'item', 'items')}; the limit is ${schema.maxItems}.`);
    value.forEach((item, i) => walk(schema.items || {}, item, join(p, i), plain, errors));
  }

  if (got === 'object') {
    const props = schema.properties || {};
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) push('is required.', join(p, key));
    for (const [key, v] of Object.entries(value)) {
      // hasOwn, not props[key]: a "__proto__" key in the draft must read as unknown, not as Object.prototype.
      if (Object.hasOwn(props, key)) walk(props[key], v, join(p, key), plain, errors);
      else if (schema.additionalProperties === false) push('is not a known field.', join(p, key));
    }
  }
}

// Schema keywords only. x-plainText on the root reaches every string unless a node sets it to false.
function validate(schema, value) {
  const errors = [];
  walk(schema, value, '', false, errors);
  return errors;
}

// R1 and R2. R3 (credentials.json) and R4 (portrait files) are checked by the website build only:
// the admin rewrites credentials.json itself and cannot add portrait files.
function crossFieldErrors(site) {
  const errors = [];
  const o = isObj(site) && isObj(site.owner) ? site.owner : null;
  if (o && typeof o.givenName === 'string' && typeof o.familyName === 'string' && typeof o.name === 'string') {
    const want = `${o.givenName} ${o.familyName}`;
    if (o.name !== want) errors.push({ path: 'owner.name', message: `must equal given name + space + family name ("${want}").` });
  }
  const c = isObj(site) && isObj(site.card) && isObj(site.card.connect) ? site.card.connect : null;
  if (c && c.enabled === true) {
    for (const key of ['notice', 'retentionDays']) {
      if (c[key] === null || c[key] === undefined) errors.push({ path: `card.connect.${key}`, message: 'is required while the form is on.' });
    }
  }
  return errors;
}

function valueAt(obj, path) {
  let node = obj;
  for (const key of path.split('.')) {
    if (!isObj(node) || !Object.hasOwn(node, key)) return undefined;
    node = node[key];
  }
  return node;
}

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Visits every property schema with its dotted path, and whether it or an ancestor is x-readOnly.
function eachProperty(schema, visit, prefix = '', inheritedReadOnly = false) {
  for (const [key, node] of Object.entries((schema && schema.properties) || {})) {
    const path = join(prefix, key);
    const readOnly = inheritedReadOnly || node['x-readOnly'] === true;
    if (visit(path, node, readOnly) === false) continue;
    if (node.properties) eachProperty(node, visit, path, readOnly);
  }
}

// Read-only fields (brand name, portrait paths, _meta) change only through a commit in the website
// repo; the admin refuses a draft that moves them, whatever the client sent.
function readOnlyViolations(schema, before, after) {
  const errors = [];
  eachProperty(schema, (path, node) => {
    if (node['x-readOnly'] !== true) return true;
    if (!sameValue(valueAt(before, path), valueAt(after, path))) {
      errors.push({ path, message: 'This field is read-only in the admin.' });
    }
    return false;
  });
  return errors;
}

function isReadOnlyPath(schema, path) {
  let node = schema;
  for (const key of path.split('.')) {
    node = node && node.properties ? node.properties[key] : undefined;
    if (!node) return false;
    if (node['x-readOnly'] === true) return true;
  }
  return false;
}

const orNull = (v) => (v === undefined ? null : v);

function describeType(node) {
  const types = [].concat(node.type || []);
  const base = types.find((t) => t !== 'null') || null;
  if (base !== 'array') return { type: base, nullable: types.includes('null') };
  const itemTypes = [].concat((node.items && node.items.type) || 'string');
  return { type: `${itemTypes.find((t) => t !== 'null')}[]`, nullable: types.includes('null') };
}

function constraintsOf(node) {
  const { type, nullable } = describeType(node);
  return {
    type,
    title: orNull(node.title),
    description: orNull(node.description),
    widget: orNull(node['x-widget']),
    minLength: orNull(node.minLength),
    maxLength: orNull(node.maxLength),
    minimum: orNull(node.minimum),
    maximum: orNull(node.maximum),
    maxItems: orNull(node.maxItems),
    patternHint: orNull(node['x-patternHint']),
    nullable,
  };
}

function fieldOf(path, node, readOnly) {
  const field = {
    path,
    ...constraintsOf(node),
    tab: orNull(node['x-tab']),
    group: orNull(node['x-group']),
    readOnly,
  };
  // A repeatable group (card.links) is edited as one value; its item fields describe the inputs.
  if (field.type === 'object[]') {
    field.itemFields = Object.entries(node.items.properties || {}).map(([key, child]) => ({ key, ...constraintsOf(child) }));
  }
  return field;
}

// The editable form, in schema order: every property that names its admin tab. Objects without a
// tab (owner, card, card.connect) are containers whose fields carry their own tab.
function listFields(schema) {
  const fields = [];
  eachProperty(schema, (path, node, readOnly) => {
    if (!node['x-tab']) return true;
    fields.push(fieldOf(path, node, readOnly));
    return false;
  });
  return fields;
}

module.exports = { validate, crossFieldErrors, readOnlyViolations, isReadOnlyPath, listFields, valueAt };
