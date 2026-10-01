'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// Login compares an unknown email against DUMMY_PASSWORD_HASH so it takes as long as a real check. That
// holds only while every hash the server or a script stores has the dummy's cost.
test('every bcrypt hash written by server.js and scripts/ uses one literal cost', () => {
  const sources = ['server.js', ...fs.readdirSync(path.join(ROOT, 'scripts')).filter((f) => f.endsWith('.js')).map((f) => path.join('scripts', f))];
  const costs = new Map();
  for (const file of sources) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const calls = text.match(/bcrypt\.hash(?:Sync)?\(/g) || [];
    const literal = [...text.matchAll(/bcrypt\.hash(?:Sync)?\([^;]*?,\s*(\d+)\s*[,)]/g)].map((m) => Number(m[1]));
    assert.equal(literal.length, calls.length, `${file}: a bcrypt hash call without a literal cost`);
    literal.forEach((cost) => costs.set(cost, [...(costs.get(cost) || []), file]));
  }
  assert.ok(costs.size > 0, 'no bcrypt hash calls found');
  assert.equal(costs.size, 1, `bcrypt costs differ: ${JSON.stringify(Object.fromEntries(costs))}`);
});
