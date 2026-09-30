'use strict';
// The donatelli edition keeps Swiish's code paths for upstream diffing but serves none of its
// public card surfaces: the one public card lives on donatelli.tech as a static page.

const BLOCKED_PREFIXES = [
  '/api/cards/',
  '/api/admin/cards',
  '/api/qr/',
  '/api/upload',
  '/uploads/',
  '/manifest/',
  '/icons/',
  '/api/demo/',
  '/api/invitations/',
  '/api/admin/invitations',
];

const BLOCKED_EXACT = ['/api/settings'];

// Express matches routes case-insensitively and ignores a trailing slash, so the guard must too.
function isBlocked(pathname) {
  const p = String(pathname || '').toLowerCase();
  const bare = p.length > 1 ? p.replace(/\/+$/, '') : p;
  return BLOCKED_EXACT.includes(bare) || BLOCKED_PREFIXES.some((prefix) => p.startsWith(prefix));
}

function guard() {
  return function editionGuard(req, res, next) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    if (isBlocked(req.path)) {
      return res.status(404).json({ error: 'Not found' });
    }
    next();
  };
}

module.exports = { guard, isBlocked, BLOCKED_PREFIXES, BLOCKED_EXACT };
