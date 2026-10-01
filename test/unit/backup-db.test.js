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

test('parseKeep: --keep wins, else BACKUP_KEEP, else 14; a bad value names its source', () => {
  const { parseKeep } = require('../../scripts/backup-db');
  assert.equal(parseKeep([], {}), 14);
  assert.equal(parseKeep([], { BACKUP_KEEP: '' }), 14, 'compose env_file writes KEY= for an unset value');
  assert.equal(parseKeep([], { BACKUP_KEEP: ' 30 ' }), 30);
  assert.equal(parseKeep(['--keep', '3'], { BACKUP_KEEP: '30' }), 3);
  assert.throws(() => parseKeep([], { BACKUP_KEEP: 'many' }), /^Error: BACKUP_KEEP is "many"/);
  assert.throws(() => parseKeep([], { BACKUP_KEEP: '0' }), /BACKUP_KEEP is "0"/);
  assert.throws(() => parseKeep(['--keep', 'x'], {}), /^Error: --keep is "x"/);
  assert.throws(() => parseKeep(['--keep', '1001'], {}), /--keep is "1001"/);
});

test('the manual backup keeps BACKUP_KEEP files, not 14', async (t) => {
  const { spawnSync } = require('child_process');
  const source = await createTestDb();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-backup-cli-'));
  t.after(async () => {
    await source.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(path.join(__dirname, '..', '..', 'scripts', 'backup-db.js'), path.join(root, 'scripts', 'backup-db.js'));
  fs.symlinkSync(path.join(__dirname, '..', '..', 'node_modules'), path.join(root, 'node_modules'), 'dir');
  fs.mkdirSync(path.join(root, 'data', 'backups'), { recursive: true });
  fs.copyFileSync(source.file, path.join(root, 'data', 'cards.db'));
  for (let day = 1; day <= 17; day++) {
    fs.copyFileSync(source.file, path.join(root, 'data', 'backups', `cards-202609${String(day).padStart(2, '0')}T000000Z.db`));
  }
  const run = spawnSync(process.execPath, ['scripts/backup-db.js'], { cwd: root, env: { PATH: process.env.PATH, BACKUP_KEEP: '30' }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /\(keeping 30, removed 0 older\)\.$/m);
  assert.equal(fs.readdirSync(path.join(root, 'data', 'backups')).length, 18);
});

test('backups are readable by their owner only', { skip: process.platform === 'win32' ? 'POSIX modes only' : false }, async (t) => {
  const source = await createTestDb();
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dt-backup-mode-')), 'backups');
  t.after(async () => {
    await source.close();
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  });
  const { file } = await runBackup({ dbFile: source.file, dir, keep: 2 });
  assert.equal(fs.statSync(dir).mode & 0o077, 0, 'the backups folder');
  assert.equal(fs.statSync(file).mode & 0o077, 0, 'the backup file');
});
