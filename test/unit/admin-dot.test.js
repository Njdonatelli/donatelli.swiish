'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { splitTerminalMark, withTerminalMark } = require('../../src/admin/dot');

test('splits each of the five heading marks with its class', () => {
  assert.deepEqual(splitTerminalMark('Connections.'), { head: 'Connections', mark: '.', cls: 'dot' });
  assert.deepEqual(splitTerminalMark('Ready?'), { head: 'Ready', mark: '?', cls: 'dot dot-q' });
  assert.deepEqual(splitTerminalMark('Done!'), { head: 'Done', mark: '!', cls: 'dot dot-x' });
  assert.deepEqual(splitTerminalMark('Plan;'), { head: 'Plan', mark: ';', cls: 'dot dot-s' });
  assert.deepEqual(splitTerminalMark('Steps:'), { head: 'Steps', mark: ':', cls: 'dot dot-c' });
});

test('wraps only the terminal mark, never an inner one', () => {
  assert.deepEqual(splitTerminalMark('donatelli.tech changed.'), { head: 'donatelli.tech changed', mark: '.', cls: 'dot' });
  assert.deepEqual(splitTerminalMark('Log in.'), { head: 'Log in', mark: '.', cls: 'dot' });
});

test('trailing whitespace is ignored', () => {
  assert.deepEqual(splitTerminalMark('Card.  \n'), { head: 'Card', mark: '.', cls: 'dot' });
});

test('comma, dash and plain text are left alone', () => {
  assert.deepEqual(splitTerminalMark('Website,'), { head: 'Website,', mark: null, cls: null });
  assert.deepEqual(splitTerminalMark('Website -'), { head: 'Website -', mark: null, cls: null });
  assert.deepEqual(splitTerminalMark('Website'), { head: 'Website', mark: null, cls: null });
  assert.deepEqual(splitTerminalMark(''), { head: '', mark: null, cls: null });
  assert.deepEqual(splitTerminalMark(null), { head: '', mark: null, cls: null });
});

test('withTerminalMark adds a period only when no mark ends the text', () => {
  assert.equal(withTerminalMark('Person'), 'Person.');
  assert.equal(withTerminalMark('Send me your details'), 'Send me your details.');
  assert.equal(withTerminalMark('Ready?'), 'Ready?');
  assert.equal(withTerminalMark('Card. '), 'Card.');
  assert.equal(withTerminalMark(''), '');
});
