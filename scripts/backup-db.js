#!/usr/bin/env node
'use strict';
// Consistent SQLite snapshots with VACUUM INTO, safe to run while the server is up.
// Usage: node scripts/backup-db.js [--keep 14]
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
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `cards-${stamp(now)}.db`);

  const db = await new Promise((resolve, reject) => {
    const handle = new sqlite3.Database(dbFile, sqlite3.OPEN_READONLY, (err) => (err ? reject(err) : resolve(handle)));
  });
  try {
    await run(db, 'VACUUM INTO ?', [file]);
  } finally {
    await new Promise((resolve) => db.close(() => resolve()));
  }

  // The UTC stamp sorts lexically in time order, so the oldest files come first.
  const backups = fs.readdirSync(dir).filter((name) => BACKUP_NAME.test(name)).sort();
  const removed = backups.slice(0, Math.max(0, backups.length - keep));
  for (const name of removed) fs.unlinkSync(path.join(dir, name));

  return { file, removed };
}

function parseKeep(argv) {
  const i = argv.indexOf('--keep');
  if (i === -1) return 14;
  const value = Number(argv[i + 1]);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`--keep is "${argv[i + 1] ?? ''}". Use a whole number of 1 or more, such as --keep 14.`);
  }
  return value;
}

if (require.main === module) {
  (async () => {
    const root = path.join(__dirname, '..');
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

module.exports = { runBackup };
