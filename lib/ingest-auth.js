'use strict';
// HMAC signing for the card relay → admin ingest hop (POST /api/ingest/connections).
// The website's Pages Function (functions/api/connect.js) signs with Web Crypto; this is the Node
// side of the same scheme, and both repos pin one fixed vector in their tests.
//   X-Dt-Timestamp: <unix seconds>
//   X-Dt-Signature: v1=<hex HMAC-SHA256(secret, `${timestamp}.${raw body}`)>
const crypto = require('crypto');

const PREFIX = 'v1=';

// The signature covers the exact bytes on the wire, so a Buffer body is hashed as is rather than
// decoded and re-encoded.
function hmacHex(secret, timestamp, body) {
  const mac = crypto.createHmac('sha256', secret);
  mac.update(`${timestamp}.`, 'utf8');
  mac.update(Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8'));
  return mac.digest('hex');
}

function signIngest({ secret, body, timestamp }) {
  const ts = String(timestamp);
  return { timestamp: ts, signature: PREFIX + hmacHex(secret, ts, body) };
}

// Digests make both sides 32 bytes, so timingSafeEqual never throws on a length mismatch and the
// comparison time does not depend on how much of the header was right.
const digest = (value) => crypto.createHash('sha256').update(value, 'utf8').digest();

function verifyIngest({ secrets, body, timestampHeader, signatureHeader, nowSeconds, windowSeconds = 300 }) {
  if (!timestampHeader || !signatureHeader) return { ok: false, code: 'MISSING' };

  const now = nowSeconds === undefined ? Math.floor(Date.now() / 1000) : nowSeconds;
  // A timestamp that is not plain unix seconds cannot be placed inside the window.
  if (!/^\d{1,12}$/.test(timestampHeader) || Math.abs(now - Number(timestampHeader)) > windowSeconds) {
    return { ok: false, code: 'STALE' };
  }

  const provided = digest(signatureHeader);
  let match = false;
  // Every secret is tried, even after a match, so a rotation does not show up in response times.
  for (const secret of (secrets || []).filter(Boolean)) {
    const expected = digest(PREFIX + hmacHex(secret, timestampHeader, body));
    if (crypto.timingSafeEqual(provided, expected)) match = true;
  }
  return match ? { ok: true } : { ok: false, code: 'BAD_SIGNATURE' };
}

module.exports = { signIngest, verifyIngest };
