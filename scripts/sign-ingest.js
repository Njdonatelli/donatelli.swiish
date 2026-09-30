#!/usr/bin/env node
'use strict';
// Sends one signed connection to an ingest URL, the same way the card relay on donatelli.tech
// does. It checks a new admin host or a rotated CONNECT_INGEST_SECRET without the website.
//
//   node scripts/sign-ingest.js --url https://admin.donatelli.tech/api/ingest/connections \
//     --name "Test Visitor One" --email visitor1@example.com [--company ...] [--note ...] \
//     [--source qr] [--retention 365] [--ip 203.0.113.7] [--secret ...]
//
// The secret comes from --secret or, better (it stays out of shell history), CONNECT_INGEST_SECRET.
// CONNECT_ACCESS_CLIENT_ID and CONNECT_ACCESS_CLIENT_SECRET, when both are set, are sent as the
// Cloudflare Access service token, as the relay does.
const crypto = require('crypto');
const { parseArgs } = require('util');
const { signIngest } = require('../lib/ingest-auth');

// The stored row keeps the notice text as its consent record, so a test row says it is one.
const TEST_NOTICE = 'Test connection sent with scripts/sign-ingest.js.';

// The relay's ipHash: a keyed hash of the visitor address, cut to 16 hex, so no address is stored.
const ipHashFor = (secret, ip) => crypto.createHmac('sha256', secret).update(`ip:${ip}`, 'utf8').digest('hex').slice(0, 16);

// A v1 payload with the relay's exact keys. The notice and its version follow the website build:
// '<notice> Kept for N days, then deleted.' and the first 8 hex of its SHA-1.
function buildPayload(fields = {}) {
  const retentionDays = fields.retentionDays ?? 365;
  const consentNotice = fields.consentNotice ?? `${TEST_NOTICE} Kept for ${retentionDays} days, then deleted.`;
  return {
    v: 1,
    id: fields.id ?? crypto.randomUUID(),
    submittedAt: fields.submittedAt ?? new Date().toISOString(),
    name: fields.name,
    email: fields.email,
    company: fields.company ?? null,
    note: fields.note ?? null,
    source: fields.source ?? 'card',
    consentVersion: fields.consentVersion ?? crypto.createHash('sha1').update(consentNotice, 'utf8').digest('hex').slice(0, 8),
    consentNotice,
    retentionDays,
    ipHash: fields.ipHash ?? null,
  };
}

// timestamp is unix seconds; tests pass an old one to exercise the 5-minute window.
async function postSigned({ url, secret, payload, timestamp = Math.floor(Date.now() / 1000), headers = {}, fetch = globalThis.fetch }) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const signed = signIngest({ secret, body, timestamp });
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Dt-Timestamp': signed.timestamp,
      'X-Dt-Signature': signed.signature,
      ...headers,
    },
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, json, text };
}

const USAGE = 'Usage: node scripts/sign-ingest.js --url <ingest url> --name "<name>" --email <email> '
  + '[--company <text>] [--note <text>] [--source card|nfc|qr|link] [--retention <days>] [--ip <address>] [--secret <secret>]';

async function main(argv) {
  let args;
  try {
    ({ values: args } = parseArgs({
      args: argv,
      options: {
        url: { type: 'string' },
        secret: { type: 'string' },
        name: { type: 'string' },
        email: { type: 'string' },
        company: { type: 'string' },
        note: { type: 'string' },
        source: { type: 'string' },
        retention: { type: 'string' },
        ip: { type: 'string' },
      },
    }));
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`);
    return 2;
  }
  const secret = args.secret || process.env.CONNECT_INGEST_SECRET;
  const missing = ['url', 'name', 'email'].filter((k) => !args[k]);
  if (!secret) missing.push('secret (or CONNECT_INGEST_SECRET)');
  if (missing.length > 0) {
    console.error(`Not sent: ${missing.join(', ')} missing.\n${USAGE}`);
    return 2;
  }
  if (args.retention !== undefined && !/^\d+$/.test(args.retention)) {
    console.error(`Not sent: --retention is "${args.retention}". Use a whole number of days from 30 to 1825.`);
    return 2;
  }

  const payload = buildPayload({
    name: args.name,
    email: args.email,
    company: args.company,
    note: args.note,
    source: args.source,
    retentionDays: args.retention === undefined ? undefined : Number(args.retention),
    ipHash: args.ip ? ipHashFor(secret, args.ip) : undefined,
  });
  const headers = {};
  if (process.env.CONNECT_ACCESS_CLIENT_ID && process.env.CONNECT_ACCESS_CLIENT_SECRET) {
    headers['CF-Access-Client-Id'] = process.env.CONNECT_ACCESS_CLIENT_ID;
    headers['CF-Access-Client-Secret'] = process.env.CONNECT_ACCESS_CLIENT_SECRET;
  }

  let res;
  try {
    res = await postSigned({ url: args.url, secret, payload, headers });
  } catch (err) {
    console.error(`Not sent: ${args.url} did not answer (${err.name === 'TimeoutError' ? 'no reply in 8 s' : err.message}). Check the URL and that the server is running.`);
    return 1;
  }
  console.log(`${res.status} ${res.text}`);
  return res.status >= 200 && res.status < 300 ? 0 : 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = { buildPayload, postSigned, ipHashFor, main };
