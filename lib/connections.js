'use strict';
// Connections: the details a visitor sends from the card on donatelli.tech.
//   POST /api/ingest/connections   server-to-server from the Pages Function, HMAC-signed, no cookies
//   /api/admin/connections*        owner-only list, detail, notes, export, erase and delete
// Visitor details never reach log() or audit_log: both are readable from the admin, and the
// audit entries record what happened to a row, not what was in it.
const crypto = require('crypto');
const { body, param, query } = require('express-validator');
const { verifyIngest } = require('./ingest-auth');
const { toCsv } = require('./csv');
const { buildVisitorVCard, vcardFilename } = require('./vcard');
const { createMutex } = require('./mutex');

const SOURCES = ['card', 'nfc', 'qr', 'link'];
const STATUSES = ['new', 'contacted', 'archived'];
// The same patterns as the relay (website functions/api/connect.js), which validates first.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const CONTROL = /[\u0000-\u001F\u007F]/;
const CONTROL_BUT_NEWLINE = /[\u0000-\u0009\u000B-\u001F\u007F]/;
const CONTROL_BUT_TAB_NEWLINE = /[\u0000-\u0008\u000B-\u001F\u007F]/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const SQLITE_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const PAYLOAD_KEYS = ['v', 'id', 'submittedAt', 'name', 'email', 'company', 'note', 'source',
  'consentVersion', 'consentNotice', 'retentionDays', 'ipHash'];

const WINDOW_MS = 15 * 60 * 1000;
const VISITOR_MAX = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
const PURGE_EVERY_MS = 60 * 60 * 1000;
const LIKE_ESCAPE = "ESCAPE '\\'";
// config does not carry the sender; this is the one server.js uses for its own mail.
const MAIL_FROM = process.env.SMTP_FROM || 'noreply@localhost';

const CSV_COLUMNS = ['received_at', 'name', 'email', 'company', 'note', 'source', 'status', 'owner_notes']
  .map((key) => ({ key, header: key }));

// SQLite CURRENT_TIMESTAMP is UTC written as 'YYYY-MM-DD HH:MM:SS' with no zone marker.
const toSqlite = (date) => date.toISOString().replace('T', ' ').slice(0, 19);
const toIso = (value) => (value ? new Date(value.replace(' ', 'T') + 'Z').toISOString() : null);

function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(date);
  const out = {};
  for (const p of parts) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return out;
}

function offsetAt(ms, timeZone) {
  const p = zonedParts(new Date(ms), timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

// The instant a calendar day starts in timeZone. The second pass settles days where the UTC
// offset at the first guess differs from the offset at midnight (daylight-saving changes).
function zonedMidnight(year, month, day, timeZone) {
  const wall = Date.UTC(year, month - 1, day);
  const guess = wall - offsetAt(wall, timeZone);
  return new Date(wall - offsetAt(guess, timeZone));
}

function zonedDate(date, timeZone) {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

// Recent ICU puts a narrow no-break space before AM/PM; plain-text mail gets an ordinary one.
const formatTime = (date, timeZone) => new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' })
  .format(date).replace(/\u202f/g, ' ');

// Trimmed text under the relay's rules. Returns null for an empty optional value, and BAD for a
// wrong type, a missing required value, an over-long value or a control character.
const BAD = Symbol('bad');
function cleanText(value, { max, required = false, multiline = false }) {
  if (value === null || value === undefined) return required ? BAD : null;
  if (typeof value !== 'string') return BAD;
  const text = (multiline ? value.replace(/\r\n?/g, '\n') : value).trim();
  if (text === '') return required ? BAD : null;
  if (text.length > max || (multiline ? CONTROL_BUT_NEWLINE : CONTROL).test(text)) return BAD;
  return text;
}

// Returns { value } with the row to store, or { field } naming the first field that failed. The
// field name goes back to the relay; the value never does.
function validatePayload(data, nowMs) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { field: 'body' };
  const unknown = Object.keys(data).find((k) => !PAYLOAD_KEYS.includes(k));
  if (unknown) return { field: unknown };
  const missing = PAYLOAD_KEYS.find((k) => !(k in data));
  if (missing) return { field: missing };

  if (data.v !== 1) return { field: 'v' };
  if (typeof data.id !== 'string' || !UUID.test(data.id)) return { field: 'id' };

  const submitted = typeof data.submittedAt === 'string' && ISO_TIME.test(data.submittedAt)
    ? Date.parse(data.submittedAt) : NaN;
  if (!Number.isFinite(submitted) || Math.abs(submitted - nowMs) > DAY_MS) return { field: 'submittedAt' };

  const name = cleanText(data.name, { max: 120, required: true });
  if (name === BAD) return { field: 'name' };
  const email = cleanText(data.email, { max: 254, required: true });
  if (email === BAD || !EMAIL.test(email)) return { field: 'email' };
  const company = cleanText(data.company, { max: 120 });
  if (company === BAD) return { field: 'company' };
  const note = cleanText(data.note, { max: 1000, multiline: true });
  if (note === BAD) return { field: 'note' };
  const source = cleanText(data.source, { max: 10 }) ?? 'card';
  if (source === BAD || !SOURCES.includes(source)) return { field: 'source' };

  if (typeof data.consentVersion !== 'string' || !/^[0-9a-f]{8}$/.test(data.consentVersion)) return { field: 'consentVersion' };
  const consentNotice = cleanText(data.consentNotice, { max: 1000, required: true, multiline: true });
  if (consentNotice === BAD) return { field: 'consentNotice' };
  if (!Number.isInteger(data.retentionDays) || data.retentionDays < 30 || data.retentionDays > 1825) {
    return { field: 'retentionDays' };
  }
  if (data.ipHash !== null && (typeof data.ipHash !== 'string' || !/^[0-9a-f]{16}$/.test(data.ipHash))) {
    return { field: 'ipHash' };
  }

  return {
    value: {
      id: data.id.toLowerCase(),
      submittedAt: toSqlite(new Date(submitted)),
      name,
      email: email.toLowerCase(),
      company,
      note,
      source,
      consentVersion: data.consentVersion,
      consentNotice,
      retentionDays: data.retentionDays,
      ipHash: data.ipHash,
    },
  };
}

const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);

const encodeCursor = (row) => Buffer.from(JSON.stringify({ r: row.received_at, i: row.id }), 'utf8').toString('base64url');
function decodeCursor(value) {
  if (typeof value !== 'string' || value.length > 200) return null;
  try {
    const c = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    return c && typeof c.r === 'string' && SQLITE_TIME.test(c.r) && typeof c.i === 'string' && UUID.test(c.i) ? c : null;
  } catch {
    return null;
  }
}

function listItem(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    company: row.company,
    source: row.source,
    status: row.status,
    receivedAt: toIso(row.received_at),
    hasNote: row.note !== null,
  };
}

// Every column except ip_hash, which exists only for the 15-minute per-visitor limit and is
// cleared by the hourly purge once that window has passed.
function detail(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    company: row.company,
    note: row.note,
    source: row.source,
    status: row.status,
    ownerNotes: row.owner_notes,
    consentVersion: row.consent_version,
    consentNotice: row.consent_notice,
    retentionDays: row.retention_days,
    submittedAt: toIso(row.submitted_at),
    receivedAt: toIso(row.received_at),
    expiresAt: toIso(row.expires_at),
    updatedAt: toIso(row.updated_at),
  };
}

function register(app, deps) {
  const {
    express, dbGet, dbAll, dbRunInfo, logAudit, log, requireAuth, requireRole, csrfProtection,
    handleValidationErrors, rateLimit, keyByUser, config, emailTransporter,
  } = deps;
  const now = deps.now || (() => new Date());
  const tz = config.timeZone;
  const serial = createMutex();

  // ---- Ingest -------------------------------------------------------------------------------

  const fail = (res, status, code, error, extra = {}) => res.status(status).json({ ok: false, code, error, ...extra });

  // The HMAC covers the raw bytes, so this route reads them itself; server.js keeps its 10 MB
  // parsers off /api/ingest/.
  const rawJson = express.raw({ type: 'application/json', limit: '16kb' });
  const readRaw = (req, res, next) => rawJson(req, res, (err) => {
    if (!err) return next();
    if (err.type === 'entity.too.large') {
      return fail(res, 413, 'TOO_LARGE', 'Connection not stored: the request is over 16 KB. Send the v1 payload only.');
    }
    if (err.status >= 400 && err.status < 500) {
      return fail(res, 400, 'INVALID', 'Connection not stored: the request body could not be read. Send it again.');
    }
    next(err);
  });

  const noStore = (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  };

  function notify(source, at) {
    const to = config.connect.notifyEmail;
    if (!to || !emailTransporter) return;
    // Time, source and a link only: mailboxes get forwarded and synced, so no visitor details.
    const text = `Someone sent their details from the card at ${formatTime(at, tz)} (source: ${source}). `
      + `Open ${config.appUrl}/admin/connections to read them.`;
    Promise.resolve()
      .then(() => emailTransporter.sendMail({ from: MAIL_FROM, to, subject: 'New connection on donatelli.tech', text }))
      .catch((err) => log('[connect] notification not sent', { error: err.message }));
  }

  async function ingest(req, res) {
    const secrets = [config.connect.ingestSecret, config.connect.ingestSecretPrevious].filter(Boolean);
    if (!config.connect.ingestSecret) {
      return fail(res, 503, 'NOT_CONFIGURED', 'Connections are off: CONNECT_INGEST_SECRET is not set on this server. Set it and restart.');
    }

    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const at = now();
    const auth = verifyIngest({
      secrets,
      body: raw,
      timestampHeader: req.get('X-Dt-Timestamp'),
      signatureHeader: req.get('X-Dt-Signature'),
      nowSeconds: Math.floor(at.getTime() / 1000),
      windowSeconds: 300,
    });
    if (!auth.ok) {
      const reasons = {
        MISSING: 'Connection not stored: X-Dt-Timestamp or X-Dt-Signature is missing. Sign the request and send it again.',
        STALE: 'Connection not stored: the timestamp is more than 5 minutes from this server\'s clock. Check both clocks, then send again.',
        BAD_SIGNATURE: 'Connection not stored: the signature did not match. Set the same CONNECT_INGEST_SECRET on Cloudflare Pages and this server.',
      };
      return fail(res, 401, auth.code, reasons[auth.code]);
    }

    let data;
    try {
      data = JSON.parse(raw.toString('utf8'));
    } catch {
      return fail(res, 400, 'INVALID', 'Connection not stored: the body is not JSON. Send the v1 payload.');
    }
    const checked = validatePayload(data, at.getTime());
    if (checked.field) {
      return fail(res, 400, 'INVALID', `Connection not stored: ${checked.field} is not valid. Send the v1 payload as the card relay builds it.`);
    }
    const c = checked.value;

    const org = await dbGet('SELECT id FROM organisations WHERE slug = ?', [config.connect.orgSlug]);
    if (!org) {
      // The relay shows the visitor a generic "Not sent", so this line is the owner's only trace.
      log('[connect] refused: no organisation has the configured slug', { slug: config.connect.orgSlug });
      return fail(res, 503, 'NOT_CONFIGURED', `Connections are off: no organisation has the slug "${config.connect.orgSlug}". Finish /setup, or set CONNECT_ORG_SLUG.`);
    }

    // The limit counts and the insert run as one step: otherwise a burst of concurrent sends all
    // count the same rows before any of them inserts, and every one gets past both limits.
    const stored = await serial(() => store(res, c, org, at));
    if (!stored) return undefined;

    await logAudit('connection_created', 'connection', c.id, { source: c.source }, null, org.id);
    log('[connect] stored', { id: c.id, source: c.source });
    notify(c.source, at);
    return res.status(201).json({ ok: true, id: c.id });
  }

  // Answers the duplicate and limit cases itself and returns false; returns true once the row is stored.
  async function store(res, c, org, at) {
    // A resend of a stored id is answered as a duplicate before the limits, so a retry is never refused.
    if (await dbGet('SELECT 1 AS found FROM connections WHERE id = ?', [c.id])) {
      res.status(200).json({ ok: true, duplicate: true });
      return false;
    }

    if (c.ipHash) {
      const recent = await dbAll(
        `SELECT received_at FROM connections
          WHERE ip_hash = ? AND received_at > datetime(CURRENT_TIMESTAMP, '-15 minutes')
          ORDER BY received_at ASC`,
        [c.ipHash]
      );
      if (recent.length >= VISITOR_MAX) {
        // The send is allowed again once enough of these rows leave the 15-minute window.
        const freesAt = Date.parse(toIso(recent[recent.length - VISITOR_MAX].received_at)) + WINDOW_MS;
        const retryAfterSeconds = Math.max(1, Math.ceil((freesAt - at.getTime()) / 1000));
        res.set('Retry-After', String(retryAfterSeconds));
        const minutes = Math.ceil(retryAfterSeconds / 60);
        fail(res, 429, 'RATE_LIMITED', `Connection not stored: ${VISITOR_MAX} sends from this visitor in 15 minutes. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`, { retryAfterSeconds });
        return false;
      }
    }

    const today = await dbGet(
      "SELECT COUNT(*) AS n FROM connections WHERE organisation_id = ? AND received_at >= datetime(CURRENT_TIMESTAMP, 'start of day')",
      [org.id]
    );
    if (today.n >= config.connect.dailyCap) {
      const retryAfterSeconds = Math.max(1, Math.ceil((Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1) - at.getTime()) / 1000));
      res.set('Retry-After', String(retryAfterSeconds));
      fail(res, 429, 'RATE_LIMITED', `Connection not stored: the daily limit of ${config.connect.dailyCap} is reached. It resets at midnight UTC; CONNECT_DAILY_CAP raises it.`, { retryAfterSeconds });
      return false;
    }

    // ON CONFLICT(id) rather than INSERT OR IGNORE: OR IGNORE also skips rows that fail a CHECK,
    // which would report a row that was never stored as a duplicate.
    const { changes } = await dbRunInfo(
      `INSERT INTO connections (id, organisation_id, name, email, company, note, source, consent_version,
          consent_notice, retention_days, expires_at, ip_hash, submitted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime(CURRENT_TIMESTAMP, '+' || ? || ' days'), ?, ?)
        ON CONFLICT(id) DO NOTHING`,
      [c.id, org.id, c.name, c.email, c.company, c.note, c.source, c.consentVersion,
        c.consentNotice, c.retentionDays, c.retentionDays, c.ipHash, c.submittedAt]
    );
    if (changes === 0) {
      res.status(200).json({ ok: true, duplicate: true });
      return false;
    }
    return true;
  }

  // No address-keyed limiter here: every send arrives from the relay, so one would be a single
  // bucket shared by every visitor, and one visitor could fill it for everyone. The HMAC check is
  // cheap, and the per-visitor and daily limits above are counted in SQLite.
  app.post('/api/ingest/connections', noStore, readRaw, (req, res, next) => {
    ingest(req, res).catch((err) => {
      // The relay reads only the status; the error itself is for the server console.
      console.error('[connect] ingest failed:', err.message);
      if (res.headersSent) return next(err);
      fail(res, 500, 'SERVER_ERROR', 'Connection not stored: the server hit an error. Check the server console, then send again.');
    });
  });

  // ---- Admin --------------------------------------------------------------------------------

  const limited = { error: 'Too many requests in 15 minutes. Wait a few minutes, then try again.', code: 'RATE_LIMITED' };
  const readLimiter = rateLimit({
    windowMs: WINDOW_MS, max: 600, keyGenerator: keyByUser, standardHeaders: true, legacyHeaders: false, message: limited,
  });
  const writeLimiter = rateLimit({
    windowMs: WINDOW_MS, max: 120, keyGenerator: keyByUser, standardHeaders: true, legacyHeaders: false, message: limited,
  });
  const owner = [noStore, requireAuth, requireRole('owner')];
  const reading = [...owner, readLimiter];
  const writing = [...owner, writeLimiter, csrfProtection];

  const requireOrg = (req, res, next) => (req.user.organisationId ? next() : res.status(401).json({ error: 'Unauthorized' }));
  // A repeated query key arrives as an array, which the checks would accept item by item.
  const single = (name, message) => query(name).optional().not().isArray().withMessage(message).bail();
  const statusQuery = (values) => single('status', `status must be ${values.join(', ')}.`)
    .isIn(values).withMessage(`status must be ${values.join(', ')}.`);
  const idParam = param('id').isUUID().withMessage('That connection id is not valid. Open the connection from the list.');
  const notFound = (res) => res.status(404).json({ error: 'Connection not found. It was deleted or reached the end of its retention.', code: 'NOT_FOUND' });

  const load = (id, orgId) => dbGet('SELECT * FROM connections WHERE id = ? AND organisation_id = ?', [id.toLowerCase(), orgId]);

  async function counts(orgId) {
    const at = now();
    const p = zonedParts(at, tz);
    const weekStart = new Date(Date.UTC(p.year, p.month - 1, p.day - 6));
    const row = await dbGet(
      `SELECT COALESCE(SUM(status = 'new'), 0) AS fresh,
              COALESCE(SUM(received_at >= ?), 0) AS today,
              COALESCE(SUM(received_at >= ?), 0) AS week,
              COUNT(*) AS total
         FROM connections WHERE organisation_id = ?`,
      [
        toSqlite(zonedMidnight(p.year, p.month, p.day, tz)),
        // "This week" is today and the six days before it, on the owner's calendar.
        toSqlite(zonedMidnight(weekStart.getUTCFullYear(), weekStart.getUTCMonth() + 1, weekStart.getUTCDate(), tz)),
        orgId,
      ]
    );
    return { new: row.fresh, today: row.today, week: row.week, total: row.total };
  }

  app.get('/api/admin/connections', ...reading, [
    statusQuery(['all', ...STATUSES]),
    single('q', 'Search is at most 100 characters.').isString().isLength({ max: 100 }).withMessage('Search is at most 100 characters.'),
    single('cursor', 'That page of results is out of date. Reload the list.')
      .custom((v) => decodeCursor(v) !== null).withMessage('That page of results is out of date. Reload the list.'),
    single('limit', 'limit must be a whole number from 1 to 100.')
      .isInt({ min: 1, max: 100 }).withMessage('limit must be a whole number from 1 to 100.'),
  ], handleValidationErrors, requireOrg, async (req, res, next) => {
    try {
      const orgId = req.user.organisationId;
      const status = req.query.status || 'all';
      const limit = req.query.limit ? Number(req.query.limit) : 50;
      const where = ['organisation_id = ?'];
      const params = [orgId];
      if (status !== 'all') {
        where.push('status = ?');
        params.push(status);
      }
      const q = (req.query.q || '').trim();
      if (q) {
        const like = `%${escapeLike(q)}%`;
        where.push(`(name LIKE ? ${LIKE_ESCAPE} OR email LIKE ? ${LIKE_ESCAPE} OR company LIKE ? ${LIKE_ESCAPE})`);
        params.push(like, like, like);
      }
      if (req.query.cursor) {
        const c = decodeCursor(req.query.cursor);
        where.push('(received_at < ? OR (received_at = ? AND id < ?))');
        params.push(c.r, c.r, c.i);
      }
      const rows = await dbAll(
        `SELECT id, name, email, company, note, source, status, received_at FROM connections
          WHERE ${where.join(' AND ')} ORDER BY received_at DESC, id DESC LIMIT ?`,
        [...params, limit + 1]
      );
      const page = rows.slice(0, limit);
      res.json({
        items: page.map(listItem),
        nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null,
        counts: await counts(orgId),
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/admin/connections/export.csv', ...reading, [
    statusQuery(['all', ...STATUSES]),
  ], handleValidationErrors, requireOrg, async (req, res, next) => {
    try {
      const orgId = req.user.organisationId;
      const status = req.query.status || 'all';
      const rows = await dbAll(
        `SELECT received_at, name, email, company, note, source, status, owner_notes FROM connections
          WHERE organisation_id = ?${status === 'all' ? '' : ' AND status = ?'}
          ORDER BY received_at DESC, id DESC`,
        status === 'all' ? [orgId] : [orgId, status]
      );
      const csv = toCsv(rows.map((r) => ({ ...r, received_at: toIso(r.received_at) })), CSV_COLUMNS);
      await logAudit('connections_exported', 'connection', crypto.randomUUID(), { count: rows.length, status }, req.user.id, orgId);
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="connections-${zonedDate(now(), tz)}.csv"`);
      res.send(csv);
    } catch (err) {
      next(err);
    }
  });

  const eraseMessage = 'Enter the email address to erase.';
  const confirmMessage = 'The confirmation does not match the email address. Type the same address in both fields.';
  app.post('/api/admin/connections/erase', ...writing, [
    body('email').isString().withMessage(eraseMessage).bail().trim().toLowerCase()
      .isLength({ max: 254 }).withMessage(eraseMessage).matches(EMAIL).withMessage(eraseMessage),
    body('confirm').isString().withMessage(confirmMessage).bail().trim().toLowerCase()
      .custom((v, { req }) => v === req.body.email).withMessage(confirmMessage),
  ], handleValidationErrors, requireOrg, async (req, res, next) => {
    try {
      const orgId = req.user.organisationId;
      const { changes } = await dbRunInfo('DELETE FROM connections WHERE organisation_id = ? AND email = ?', [orgId, req.body.email]);
      // A fresh entity id: the erased address is exactly what must not be written down.
      await logAudit('connections_erased', 'connection', crypto.randomUUID(), { count: changes }, req.user.id, orgId);
      res.json({ count: changes });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/admin/connections/:id', ...reading, [idParam], handleValidationErrors, requireOrg, async (req, res, next) => {
    try {
      const row = await load(req.params.id, req.user.organisationId);
      if (!row) return notFound(res);
      res.json({ connection: detail(row) });
    } catch (err) {
      next(err);
    }
  });

  const notesMessage = 'Notes must be text of 2,000 characters or fewer.';
  const cleanNotes = (v) => {
    if (v === null) return null;
    const text = v.replace(/\r\n?/g, '\n').trim();
    return text === '' ? null : text;
  };
  app.post('/api/admin/connections/:id', ...writing, [
    idParam,
    body('status').optional().isIn(STATUSES).withMessage('Status must be new, contacted or archived.'),
    body('ownerNotes').optional().custom((v) => {
      if (v === null) return true;
      if (typeof v !== 'string') return false;
      const text = cleanNotes(v);
      return text === null || (text.length <= 2000 && !CONTROL_BUT_TAB_NEWLINE.test(text));
    }).withMessage(notesMessage),
  ], handleValidationErrors, requireOrg, async (req, res, next) => {
    try {
      const orgId = req.user.organisationId;
      if (req.body.status === undefined && req.body.ownerNotes === undefined) {
        return res.status(400).json({ error: 'Nothing to save. Send a status, notes, or both.' });
      }
      const row = await load(req.params.id, orgId);
      if (!row) return notFound(res);

      const status = req.body.status === undefined ? row.status : req.body.status;
      const notes = req.body.ownerNotes === undefined ? row.owner_notes : cleanNotes(req.body.ownerNotes);
      const fields = [];
      if (status !== row.status) fields.push('status');
      if (notes !== row.owner_notes) fields.push('owner_notes');

      if (fields.length > 0) {
        await dbRunInfo(
          'UPDATE connections SET status = ?, owner_notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organisation_id = ?',
          [status, notes, row.id, orgId]
        );
        // Which fields changed, and the status move; the notes text stays out of the audit trail.
        await logAudit('connection_updated', 'connection', row.id,
          { fields, from: { status: row.status }, to: { status } }, req.user.id, orgId);
      }
      res.json({ connection: detail(await load(row.id, orgId)) });
    } catch (err) {
      next(err);
    }
  });

  app.delete('/api/admin/connections/:id', ...writing, [idParam], handleValidationErrors, requireOrg, async (req, res, next) => {
    try {
      const orgId = req.user.organisationId;
      const id = req.params.id.toLowerCase();
      const { changes } = await dbRunInfo('DELETE FROM connections WHERE id = ? AND organisation_id = ?', [id, orgId]);
      if (changes === 0) return notFound(res);
      await logAudit('connection_deleted', 'connection', id, {}, req.user.id, orgId);
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/admin/connections/:id/contact.vcf', ...reading, [idParam], handleValidationErrors, requireOrg, async (req, res, next) => {
    try {
      const orgId = req.user.organisationId;
      const row = await load(req.params.id, orgId);
      if (!row) return notFound(res);
      const vcard = buildVisitorVCard({
        name: row.name,
        email: row.email,
        company: row.company,
        note: row.note,
        source: row.source,
        receivedAt: toIso(row.received_at),
        timeZone: tz,
      });
      await logAudit('connection_vcard_exported', 'connection', row.id, {}, req.user.id, orgId);
      res.set('Content-Type', 'text/vcard; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="${vcardFilename(row.name)}"`);
      res.send(vcard);
    } catch (err) {
      next(err);
    }
  });

  // ---- Retention ----------------------------------------------------------------------------

  // Each row carries the expiry its visitor was promised in the notice they saw.
  async function purgeExpired() {
    const { changes } = await dbRunInfo('DELETE FROM connections WHERE expires_at < CURRENT_TIMESTAMP');
    if (changes > 0) {
      // No organisation and no user: a system job, which the audit feed lists for this instance.
      await logAudit('connections_purged', 'connection', crypto.randomUUID(), { count: changes }, null, null);
      log('[connect] expired connections deleted', { count: changes });
    }
    // ip_hash is a keyed hash whose key sits on this host, so for IPv4 it can be reversed by
    // trying every address. It serves only the 15-minute limit, so it is not kept past that window.
    // The same expression as the limit's query, so no row the limit still counts is touched.
    await dbRunInfo("UPDATE connections SET ip_hash = NULL WHERE ip_hash IS NOT NULL AND received_at <= datetime(CURRENT_TIMESTAMP, '-15 minutes')");
    return changes;
  }

  let timer = null;
  const runPurge = () => purgeExpired().catch((err) => log('[connect] retention purge failed', { error: err.message }));

  return {
    purgeExpired,
    startTimers() {
      if (timer) return;
      runPurge();
      timer = setInterval(runPurge, PURGE_EVERY_MS);
      timer.unref();
    },
    stopTimers() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

module.exports = { register, validatePayload, zonedMidnight };
