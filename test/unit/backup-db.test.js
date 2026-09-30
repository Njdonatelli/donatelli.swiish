'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');
const { createTestDb } = require('../helpers/db');
const { runBackup } = require('../../scripts/backup-db');

function readOrgNames(file) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(file, sqlite3.OPEN_READONLY, (openErr) => {
      if (openErr) return reject(openErr);
      db.all('SELECT name FROM organisations', (err, rows) => db.close(() => (err ? reject(err) : resolve(rows.map((r) => r.name)))));
    });
  });
}

test('runBackup writes a consistent copy and keeps only the newest N', async (t) => {
  const source = await createTestDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-backup-'));
  t.after(async () => {
    await source.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await source.dbRun("INSERT INTO organisations (id, name, slug) VALUES ('org-1', 'donatelli.tech', 'donatelli-tech')");

  const times = ['2026-09-30T10:00:00.000Z', '2026-09-30T11:00:00.000Z', '2026-10-01T09:30:05.000Z'];
  let last;
  for (const iso of times) {
    last = await runBackup({ dbFile: source.file, dir, keep: 2, now: new Date(iso) });
  }
  // A file that is not a backup is never rotated out
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'kept');
  const again = await runBackup({ dbFile: source.file, dir, keep: 2, now: new Date('2026-10-02T00:00:00.000Z') });

  assert.equal(path.basename(last.file), 'cards-20261001T093005Z.db');
  assert.deepEqual(again.removed, ['cards-20260930T110000Z.db']);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['cards-20261002T000000Z.db', 'cards-20261001T093005Z.db', 'notes.txt'].sort());
  assert.deepEqual(await readOrgNames(again.file), ['donatelli.tech']);
});

test('runBackup refuses a bad keep and a missing database', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-backup-'));
  try {
    await assert.rejects(runBackup({ dbFile: path.join(dir, 'x.db'), dir, keep: 0 }), /keep is 0/);
    await assert.rejects(runBackup({ dbFile: path.join(dir, 'missing.db'), dir, keep: 3 }), /No database at/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
