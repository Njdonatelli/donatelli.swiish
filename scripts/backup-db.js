#!/usr/bin/env node
'use strict';
// Consistent SQLite snapshots with VACUUM INTO, safe to run while the server is up.
// Usage: node scripts/backup-db.js [--keep N]   (default: BACKUP_KEEP, else 14)
// Deleted connections survive in these files until they rotate out, which the owner
// runbook (docs/donatelli-deploy.md) states.

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');

const BACKUP_NAME = /^cards-\d{8}T\d{6}Z\.db$/;

function stamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve())));
}

async function runBackup({ dbFile, dir, keep = 14, now = new Date() }) {
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error(`keep is ${keep}. Use a whole number of 1 or more.`);
  }
  if (!fs.existsSync(dbFile)) {
    throw new Error(`No database at ${dbFile}. Start the server once so it creates the database, then run the backup.`);
  }
  // Every backup holds the visitors' details: readable by the server's own user only.
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, `cards-${stamp(now)}.db`);

  const db = await new Promise((resolve, reject) => {
    const handle = new sqlite3.Database(dbFile, sqlite3.OPEN_READONLY, (err) => (err ? reject(err) : resolve(handle)));
  });
  try {
    await run(db, 'VACUUM INTO ?', [file]);
  } finally {
    await new Promise((resolve) => db.close(() => resolve()));
  }
  fs.chmodSync(file, 0o600);

  // The UTC stamp sorts lexically in time order, so the oldest files come first.
  const backups = fs.readdirSync(dir).filter((name) => BACKUP_NAME.test(name)).sort();
  const removed = backups.slice(0, Math.max(0, backups.length - keep));
  for (const name of removed) fs.unlinkSync(path.join(dir, name));

  return { file, removed };
}

// --keep wins; otherwise BACKUP_KEEP, which the server's timer also uses, so a manual backup never
// deletes files the owner chose to keep. Read from the environment directly rather than through
// lib/config, whose full production check would stop a backup over an unrelated setting.
function parseKeep(argv, env = process.env) {
  const i = argv.indexOf('--keep');
  if (i !== -1) {
    const value = Number(argv[i + 1]);
    if (!Number.isInteger(value) || value < 1 || value > 1000) {
      throw new Error(`--keep is "${argv[i + 1] ?? ''}". Use a whole number from 1 to 1000, such as --keep 14.`);
    }
    return value;
  }
  // Compose's env_file turns "BACKUP_KEEP=" into an empty string, which means unset.
  const raw = env.BACKUP_KEEP == null ? '' : String(env.BACKUP_KEEP).trim();
  if (raw === '') return 14;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 1000) {
    throw new Error(`BACKUP_KEEP is "${raw}". Use a whole number from 1 to 1000, or remove it to keep 14.`);
  }
  return value;
}

if (require.main === module) {
  (async () => {
    const root = path.join(__dirname, '..');
    // As server.js does: a run on the host reads the same .env; an existing variable is never overridden.
    require('dotenv').config({ path: path.join(root, '.env') });
    const keep = parseKeep(process.argv.slice(2));
    const { file, removed } = await runBackup({
      dbFile: path.join(root, 'data', 'cards.db'),
      dir: path.join(root, 'data', 'backups'),
      keep,
    });
    console.log(`Backup written: ${path.relative(root, file)} (keeping ${keep}, removed ${removed.length} older).`);
  })().catch((err) => {
    console.error(`Backup not written: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { runBackup, parseKeep };
