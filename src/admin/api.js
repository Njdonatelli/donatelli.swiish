// Same-origin JSON client for the admin API. Cookies carry the session (httpOnly authToken); every write
// carries the csurf token, fetched once and refreshed once when the server says it went stale.

export const NETWORK_MESSAGE = 'The admin server did not answer. Check your connection and try again.';

export class ApiError extends Error {
  constructor({ status, code, message, errors, retryAfterSeconds, data }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code || null;
    this.errors = errors || null;
    this.retryAfterSeconds = retryAfterSeconds == null ? null : retryAfterSeconds;
    this.data = data || null;
  }
}

// express-rate-limit sends RateLimit-Reset (seconds, draft-6 headers) and Retry-After on a 429.
function retryAfter(res, data) {
  const fromHeader = Number(res.headers.get('RateLimit-Reset') || res.headers.get('Retry-After'));
  if (Number.isFinite(fromHeader) && fromHeader > 0) return fromHeader;
  if (data && Number.isFinite(data.retryAfterSeconds)) return data.retryAfterSeconds;
  return null;
}

async function readBody(res) {
  const type = res.headers.get('Content-Type') || '';
  if (!type.includes('json')) return null;
  try {
    return await res.json();
  } catch (e) {
    return null;
  }
}

function filenameFrom(res, fallback) {
  const cd = res.headers.get('Content-Disposition') || '';
  const m = /filename="?([^";]+)"?/i.exec(cd);
  return m ? m[1] : fallback;
}

export function createApi({ base = '/api', fetch = window.fetch.bind(window) } = {}) {
  let csrfToken = null;
  const unauthorizedListeners = new Set();

  async function refreshCsrf() {
    let res;
    try {
      res = await fetch(base + '/csrf-token', { credentials: 'same-origin', cache: 'no-store' });
    } catch (e) {
      throw new ApiError({ status: 0, code: 'NETWORK', message: NETWORK_MESSAGE });
    }
    const data = await readBody(res);
    if (!res.ok || !data || !data.csrfToken) {
      throw new ApiError({ status: res.status, code: 'CSRF', message: 'Session check failed. Reload the page and try again.' });
    }
    csrfToken = data.csrfToken;
    return csrfToken;
  }

  // keepalive lets a save outlive the page (pagehide). With a token already cached, the request starts
  // before this function first awaits, so it is sent even as the page goes away.
  async function send(method, path, body, { raw = false, retried = false, keepalive = false } = {}) {
    const headers = { Accept: raw ? '*/*' : 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET') headers['X-CSRF-Token'] = csrfToken || (await refreshCsrf());
    let res;
    try {
      res = await fetch(base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'same-origin',
        cache: 'no-store',
        keepalive,
      });
    } catch (e) {
      throw new ApiError({ status: 0, code: 'NETWORK', message: NETWORK_MESSAGE });
    }
    if (res.ok && raw) return res;
    const data = await readBody(res);
    if (res.ok) return data === null ? {} : data;

    if (res.status === 403 && data && data.code === 'CSRF' && !retried) {
      await refreshCsrf();
      return send(method, path, body, { raw, retried: true, keepalive });
    }
    // A 401 on an owner route means the session ended (expired, revoked, or signed out elsewhere).
    if (res.status === 401 && path.indexOf('/admin/') === 0) {
      unauthorizedListeners.forEach((fn) => fn());
    }
    throw new ApiError({
      status: res.status,
      code: data && data.code,
      message: (data && data.error) || 'The admin server answered ' + res.status + '. Try again.',
      errors: data && data.errors,
      retryAfterSeconds: retryAfter(res, data),
      data,
    });
  }

  // Saves a server-made file (CSV export, visitor vCard) with the name the server chose.
  async function download(path, filename) {
    const res = await send('GET', path, undefined, { raw: true });
    const blob = await res.blob();
    const name = filenameFrom(res, filename);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { filename: name, blob };
  }

  return {
    get: (path) => send('GET', path),
    post: (path, body, opts) => send('POST', path, body === undefined ? {} : body, opts),
    del: (path) => send('DELETE', path),
    download,
    refreshCsrf,
    onUnauthorized(fn) {
      unauthorizedListeners.add(fn);
      return () => unauthorizedListeners.delete(fn);
    },
  };
}
