'use strict';
// Rate-limit key for a client address. One IPv6 client usually controls a whole /64 or more, so
// keying on the full address lets it rotate past any per-address limit; IPv6 is keyed on its /56
// prefix instead. IPv4-mapped IPv6 (::ffff:a.b.c.d) is unwrapped first, or every IPv4 visitor
// behind a dual-stack proxy would share the bucket of ::/56.
const net = require('net');

const PREFIX_BITS = 56;

function hextets(ip) {
  let addr = ip;
  // A trailing dotted quad (::ffff:1.2.3.4, 64:ff9b::1.2.3.4) is the last two hextets.
  const quad = addr.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (quad) {
    const [a, b, c, d] = quad[1].split('.').map(Number);
    addr = addr.slice(0, -quad[1].length) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const [head, tail] = addr.includes('::') ? addr.split('::') : [addr, null];
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const fill = tail === null ? [] : Array(8 - left.length - right.length).fill('0');
  return [...left, ...fill, ...right].map((h) => parseInt(h, 16));
}

function ipKey(ip) {
  if (!ip) return 'unknown';
  const bare = String(ip).replace(/%.*$/, '');
  const mapped = bare.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped && net.isIPv4(mapped[1])) return mapped[1];
  if (!net.isIPv6(bare)) return bare;
  const h = hextets(bare);
  const full = Math.floor(PREFIX_BITS / 16);
  const kept = h.slice(0, full);
  const rest = PREFIX_BITS % 16;
  if (rest) kept.push(h[full] & (0xffff << (16 - rest)) & 0xffff);
  while (kept.length < 8) kept.push(0);
  return kept.map((n) => n.toString(16)).join(':') + '/' + PREFIX_BITS;
}

const keyByIp = (req) => ipKey(req.ip);

module.exports = { ipKey, keyByIp, PREFIX_BITS };
