#!/usr/bin/env node
'use strict';
// Break-glass password reset from the host shell, for servers without SMTP.
// Usage: node scripts/set-password.js <email>
// In Docker: docker compose exec swiish node scripts/set-password.js <email>
// Reads the new password twice from stdin (no echo on a terminal) and signs out every
// existing session for that account.

const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const sqlite3 = require('sqlite3');
const bcrypt = require('bcrypt');

const MIN_LENGTH = 12;
// Same file as server.js outside demo mode
const DB_FILE = path.join(__dirname, '..', 'data', 'cards.db');

class CliError extends Error {}

function promptHidden(question) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

// Piped input (scripts, tests): the first two lines are the password and its repeat.
async function readPipedLines(count) {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const lines = [];
  for await (const line of rl) {
    lines.push(line);
    if (lines.length === count) break;
  }
  rl.close();
  return lines;
}

async function readPasswords() {
  if (process.stdin.isTTY) {
    const first = await promptHidden('New password: ');
    const second = await promptHidden('Repeat password: ');
    return [first, second];
  }
  const [first = '', second = ''] = await readPipedLines(2);
  return [first, second];
}

function open(file) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(file, sqlite3.OPEN_READWRITE, (err) => (err ? reject(err) : resolve(db)));
  });
}

function get(db, sql, params) {
  return new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));
}

function run(db, sql, params) {
  return new Promise((resolve, reject) => db.run(sql, params, function (err) {
    if (err) reject(err);
    else resolve(this.changes);
  }));
}

async function main(argv) {
  const email = (argv[0] || '').trim().toLowerCase();
  if (!email) {
    throw new CliError('Usage: node scripts/set-password.js <email>');
  }

  let db;
  try {
    db = await open(DB_FILE);
  } catch (err) {
    throw new CliError(`No database at ${DB_FILE}. Start the server once so it creates the database, then run this again.`);
  }

  try {
    const user = await get(db, 'SELECT id, organisation_id FROM users WHERE email = ?', [email]);
    if (!user) throw new CliError('No user with that email.');

    const [password, repeat] = await readPasswords();
    if (password.length < MIN_LENGTH) throw new CliError(`Password not changed: use at least ${MIN_LENGTH} characters.`);
    if (password !== repeat) throw new CliError('Password not changed: the two entries did not match.');

    // The server's cost: login answers an unknown email with a compare at this cost, so a different
    // one here would show by its timing which address has the account.
    const hash = await bcrypt.hash(password, 10);
    const changes = await run(
      db,
      'UPDATE users SET password_hash = ?, session_version = session_version + 1, updated_at = CURRENT_TIMESTAMP WHERE email = ?',
      [hash, email]
    );
    if (changes === 0) throw new CliError('No user with that email.');

    await run(
      db,
      'INSERT INTO audit_log (id, event_type, entity_type, entity_id, entity_data, performed_by, organisation_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [crypto.randomUUID(), 'password_reset_cli', 'auth', user.id, '{}', null, user.organisation_id]
    );
    console.log(`Password changed for ${email}. Every existing session is signed out; log in with the new password.`);
  } finally {
    await new Promise((resolve) => db.close(() => resolve()));
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof CliError ? err.message : `Password not changed: ${err.message}`);
  process.exit(1);
});
