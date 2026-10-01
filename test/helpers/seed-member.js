'use strict';
// The edition refuses POST /api/admin/users, so tests that need a second account write it
// straight into the server's SQLite file, in the owner's organisation.
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const sqlite3 = require('sqlite3');

function run(dbFile, sql, params) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbFile, (openErr) => {
      if (openErr) return reject(openErr);
      db.run(sql, params, function onRun(err) {
        const changes = this ? this.changes : 0;
        db.close(() => (err ? reject(err) : resolve(changes)));
      });
    });
  });
}

async function seedMember(dbFile, { email, password, role = 'member' }) {
  const id = crypto.randomUUID();
  const hash = await bcrypt.hash(password, 10);
  const changes = await run(dbFile,
    `INSERT INTO users (id, email, password_hash, organisation_id, role, email_verified)
     SELECT ?, ?, ?, id, ?, 1 FROM organisations LIMIT 1`,
    [id, email.toLowerCase(), hash, role]);
  if (changes !== 1) throw new Error('seedMember: no organisation yet. Run setup first.');
  return id;
}

const setRole = (dbFile, id, role) => run(dbFile, 'UPDATE users SET role = ? WHERE id = ?', [role, id]);

module.exports = { seedMember, setRole };
