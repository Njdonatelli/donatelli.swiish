'use strict';
// Throwaway SQLite database with every migration applied (db-migrate programmatic API).
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');
const sqlite3 = require('sqlite3');
const DBMigrate = require('db-migrate');

async function createTestDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-db-'));
  const file = path.join(dir, 'test.db');
  const dbm = DBMigrate.getInstance(true, {
    cwd: path.join(__dirname, '..', '..'),
    env: 'test',
    config: { test: { driver: 'sqlite3', filename: file } },
    throwUncatched: true,
  });
  dbm.silence(true);
  await dbm.up();
  const db = new sqlite3.Database(file);
  await new Promise((res, rej) => db.run('PRAGMA foreign_keys = ON', (e) => (e ? rej(e) : res())));
  // As server.js opens it
  await new Promise((res, rej) => db.run('PRAGMA secure_delete = ON', (e) => (e ? rej(e) : res())));
  const dbGet = util.promisify(db.get.bind(db));
  const dbAll = util.promisify(db.all.bind(db));
  const dbRunInfo = (sql, params = []) => new Promise((res, rej) =>
    db.run(sql, params, function (e) { if (e) rej(e); else res({ changes: this.changes, lastID: this.lastID }); }));
  const dbRun = (sql, params = []) => dbRunInfo(sql, params).then(() => undefined);
  const close = () => new Promise((res) => db.close(() => { fs.rmSync(dir, { recursive: true, force: true }); res(); }));
  return { db, file, dbGet, dbAll, dbRun, dbRunInfo, close };
}
module.exports = { createTestDb };
