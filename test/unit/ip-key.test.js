'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ipKey, keyByIp } = require('../../lib/ip-key');

test('IPv6 addresses in one /56 share a key; another /56 does not', () => {
  const a = ipKey('2001:db8:1:2::1');
  assert.equal(a, '2001:db8:1:0:0:0:0:0/56');
  assert.equal(ipKey('2001:db8:1:2:ffff:ffff:ffff:ffff'), a);
  assert.equal(ipKey('2001:db8:1:ff::7'), a);
  assert.equal(ipKey('2001:0db8:0001:00aa:0:0:0:1'), a);
  assert.notEqual(ipKey('2001:db8:1:100::1'), a);
  assert.notEqual(ipKey('2001:db8:2:2::1'), a);
  assert.equal(ipKey('::1'), '0:0:0:0:0:0:0:0/56');
  assert.equal(ipKey('fe80::1%eth0'), 'fe80:0:0:0:0:0:0:0/56');
});

test('IPv4 and IPv4-mapped IPv6 keep one key per IPv4 address', () => {
  assert.equal(ipKey('203.0.113.7'), '203.0.113.7');
  assert.equal(ipKey('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(ipKey('::FFFF:203.0.113.8'), '203.0.113.8');
  assert.notEqual(ipKey('::ffff:203.0.113.7'), ipKey('::ffff:203.0.113.8'));
  // A NAT64 address embeds IPv4 in its low bits, so it still masks to its /56
  assert.equal(ipKey('64:ff9b::203.0.113.7'), '64:ff9b:0:0:0:0:0:0/56');
});

test('keyByIp reads req.ip and never returns an empty key', () => {
  assert.equal(keyByIp({ ip: '2001:db8:1:2::9' }), '2001:db8:1:0:0:0:0:0/56');
  assert.equal(keyByIp({ ip: undefined }), 'unknown');
});
