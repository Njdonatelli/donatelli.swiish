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

// This edition has one admin, the owner made at setup. Creating or promoting a second account
// would plant a login that "Sign out everywhere" and a password change do not reach, so those
// writes are refused. Listing and deleting accounts stay open so a stray one can be found and removed.
const BLOCKED_ROUTES = [
  ['POST', /^\/api\/admin\/users\/?$/],
  ['PATCH', /^\/api\/admin\/users\/[^/]+\/?$/],
];

// Express matches routes case-insensitively and ignores a trailing slash, so the guard must too.
function isBlocked(pathname, method = 'GET') {
  const p = String(pathname || '').toLowerCase();
  const m = String(method || '').toUpperCase();
  const bare = p.length > 1 ? p.replace(/\/+$/, '') : p;
  return BLOCKED_EXACT.includes(bare)
    || BLOCKED_PREFIXES.some((prefix) => p.startsWith(prefix))
    || BLOCKED_ROUTES.some(([verb, re]) => verb === m && re.test(p));
}

function guard() {
  return function editionGuard(req, res, next) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    if (isBlocked(req.path, req.method)) {
      return res.status(404).json({ error: 'Not found' });
    }
    next();
  };
}

module.exports = { guard, isBlocked, BLOCKED_PREFIXES, BLOCKED_EXACT, BLOCKED_ROUTES };
