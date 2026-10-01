'use strict';
// A fetch client that behaves like the admin SPA: it keeps cookies, sends the CSRF header and
// an Origin on every write, and never follows redirects (tests assert them).

const OPTION_KEYS = new Set(['json', 'body', 'headers', 'csrf']);
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// post(path, { json }) and post(path, jsonBody, opts) are both accepted: tests for the other
// units were written in parallel against the one-line contract and either reading is natural.
function splitArgs(arg, opts) {
  const keys = arg && typeof arg === 'object' && !Array.isArray(arg) ? Object.keys(arg) : null;
  if (opts === undefined && keys && keys.length > 0 && keys.every((k) => OPTION_KEYS.has(k))) return arg;
  return { ...(opts || {}), json: arg };
}

// defaultHeaders lets a test act as a distinct visitor, e.g. { 'X-Forwarded-For': '203.0.113.7' }:
// the server trusts one proxy hop, and its rate limiters key on that address.
function createClient(baseUrl, { headers: defaultHeaders = {} } = {}) {
  const jar = new Map();
  let token = null;

  function storeCookies(res) {
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(';').map((s) => s.trim());
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      const expired = attrs.some((a) => {
        const [k, v = ''] = a.split('=');
        if (k.toLowerCase() === 'max-age') return Number(v) <= 0;
        if (k.toLowerCase() === 'expires') return new Date(v).getTime() <= Date.now();
        return false;
      });
      if (expired || value === '') jar.delete(name);
      else jar.set(name, value);
      // A new csurf secret invalidates the cached token.
      if (name === '_csrf') token = null;
    }
  }

  async function send(method, path, { json, body, headers = {}, csrf = true } = {}) {
    const upper = method.toUpperCase();
    const h = { ...defaultHeaders };
    if (WRITE_METHODS.has(upper)) {
      h.Origin = baseUrl;
      // Fetched first: the token call may set the _csrf cookie this request must carry.
      if (csrf) h['X-CSRF-Token'] = await csrfToken();
    }
    if (jar.size > 0) h.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let payload = body;
    if (json !== undefined) {
      h['Content-Type'] = 'application/json';
      payload = JSON.stringify(json);
    }
    Object.assign(h, headers);
    const res = await fetch(baseUrl + path, { method: upper, headers: h, body: payload, redirect: 'manual' });
    storeCookies(res);
    const text = await res.text();
    let parsed = null;
    if ((res.headers.get('content-type') || '').includes('json')) {
      try { parsed = JSON.parse(text); } catch { parsed = null; }
    }
    return { status: res.status, headers: res.headers, json: parsed, text };
  }

  async function csrfToken({ refresh = false } = {}) {
    if (token && !refresh) return token;
    const res = await send('GET', '/api/csrf-token');
    if (res.status !== 200 || !res.json || !res.json.csrfToken) {
      throw new Error(`GET /api/csrf-token returned ${res.status}: ${res.text}`);
    }
    token = res.json.csrfToken;
    return token;
  }

  return {
    jar,
    request: send,
    get: (path, opts) => send('GET', path, opts),
    post: (path, arg, opts) => send('POST', path, splitArgs(arg, opts)),
    put: (path, arg, opts) => send('PUT', path, splitArgs(arg, opts)),
    patch: (path, arg, opts) => send('PATCH', path, splitArgs(arg, opts)),
    del: (path, opts) => send('DELETE', path, opts),
    csrfToken,
    setupOwner: ({ email, password, setupToken, organisationName = 'donatelli.tech' }) =>
      send('POST', '/api/setup/initialize', { json: { organisationName, adminEmail: email, adminPassword: password, setupToken } }),
    login: (email, password) => send('POST', '/api/login', { json: { email, password } }),
  };
}

module.exports = { createClient };
