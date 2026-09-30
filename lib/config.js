'use strict';
// Server configuration for the donatelli edition. Production refuses to boot on an unsafe
// value instead of limping along, so every problem is collected and reported in one go.

const JWT_PLACEHOLDER = 'change-this-secret-in-production';
const SECRET_HINT = 'openssl rand -base64 48';
const DEV_ORIGINS = ['http://localhost:3000', 'http://localhost:8095'];
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

class ConfigError extends Error {
  constructor(problems) {
    const noun = problems.length === 1 ? 'problem' : 'problems';
    super(`Server not started: ${problems.length} configuration ${noun}.\n` + problems.map((p) => `- ${p}`).join('\n'));
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

// dotenv and compose env_file both turn `KEY=` into an empty string; treat that as unset.
function read(env, name) {
  const value = env[name];
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed;
}

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function withoutTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

function isHttpsOrLocal(url) {
  return url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname));
}

// jsonwebtoken reads a bare numeric string as milliseconds, so seconds are passed as a Number.
function parseDuration(value) {
  const match = /^(\d+)\s*([smhd]?)$/.exec(value);
  if (!match) return null;
  const amount = Number(match[1]);
  if (amount <= 0) return null;
  const unitMs = { '': 1000, s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 }[match[2]];
  return { expiresIn: match[2] ? `${amount}${match[2]}` : amount, ms: amount * unitMs };
}

function isTimeZone(value) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function load(env = process.env) {
  const problems = [];

  const integer = (name, fallback, { min, max = Number.MAX_SAFE_INTEGER }) => {
    const raw = read(env, name);
    if (raw === null) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      const range = max === Number.MAX_SAFE_INTEGER ? `of ${min} or more` : `from ${min} to ${max}`;
      problems.push(`${name} is "${raw}". Use a whole number ${range}, or remove it to use ${fallback}.`);
      return fallback;
    }
    return value;
  };

  const url = (name, fallback) => {
    const raw = read(env, name) || fallback;
    const parsed = parseUrl(raw);
    if (!parsed || !/^https?:$/.test(parsed.protocol)) {
      problems.push(`${name} is "${raw}", which is not an http(s) URL. Set a full URL such as ${fallback}.`);
      return { value: fallback, parsed: new URL(fallback) };
    }
    return { value: withoutTrailingSlash(raw), parsed };
  };

  const nodeEnv = read(env, 'NODE_ENV') || 'development';
  const isProd = nodeEnv === 'production';
  const port = integer('PORT', 3000, { min: 0, max: 65535 });

  const jwtSecret = read(env, 'JWT_SECRET');
  if (!jwtSecret) {
    problems.push(`JWT_SECRET is not set. Set it to the output of: ${SECRET_HINT}`);
  } else if (isProd && jwtSecret === JWT_PLACEHOLDER) {
    problems.push(`JWT_SECRET is the example placeholder. Set it to the output of: ${SECRET_HINT}`);
  } else if (isProd && jwtSecret.length < 32) {
    problems.push(`JWT_SECRET is shorter than 32 characters. Set it to the output of: ${SECRET_HINT}`);
  }

  const expiresRaw = read(env, 'JWT_EXPIRES_IN') || '24h';
  let duration = parseDuration(expiresRaw);
  if (!duration) {
    problems.push(`JWT_EXPIRES_IN is "${expiresRaw}". Use seconds or a number with m, h or d, such as 24h.`);
    duration = parseDuration('24h');
  }

  if (isProd && read(env, 'DEMO_MODE') === 'true') {
    problems.push('DEMO_MODE is true, and demo mode skips login. Remove DEMO_MODE.');
  }

  let appUrl = 'http://localhost:3000';
  let appOrigin = 'http://localhost:3000';
  const appUrlRaw = read(env, 'APP_URL');
  if (appUrlRaw) {
    const parsed = parseUrl(appUrlRaw);
    if (!parsed || !/^https?:$/.test(parsed.protocol)) {
      problems.push(`APP_URL is "${appUrlRaw}", which is not an http(s) URL. Set it to the admin origin, such as https://admin.donatelli.tech`);
    } else if (isProd && !isHttpsOrLocal(parsed)) {
      problems.push(`APP_URL is "${appUrlRaw}", which is not https. Set it to the https admin origin, such as https://admin.donatelli.tech`);
    } else {
      appUrl = withoutTrailingSlash(appUrlRaw);
      appOrigin = parsed.origin;
    }
  } else if (isProd) {
    problems.push('APP_URL is not set. Set it to the admin origin, such as https://admin.donatelli.tech');
  }

  let allowedOrigins;
  const originsRaw = read(env, 'ALLOWED_ORIGINS');
  if (originsRaw) {
    allowedOrigins = [];
    for (const entry of originsRaw.split(',').map((s) => s.trim()).filter(Boolean)) {
      const parsed = parseUrl(entry);
      if (!parsed || !/^https?:$/.test(parsed.protocol)) {
        problems.push(`ALLOWED_ORIGINS has "${entry}", which is not an origin. List origins such as https://admin.donatelli.tech, separated by commas.`);
      } else {
        allowedOrigins.push(parsed.origin);
      }
    }
    if (isProd && !allowedOrigins.includes(appOrigin)) {
      problems.push(`ALLOWED_ORIGINS does not include the APP_URL origin (${appOrigin}), so every admin save would be refused. Add it, or remove ALLOWED_ORIGINS to allow that origin alone.`);
    }
  } else {
    allowedOrigins = isProd ? [appOrigin] : [...new Set([appOrigin, ...DEV_ORIGINS])];
  }

  const timeZone = read(env, 'ADMIN_TIME_ZONE') || 'America/Los_Angeles';
  if (!isTimeZone(timeZone)) {
    problems.push(`ADMIN_TIME_ZONE is "${timeZone}", which is not an IANA time zone. Use a name such as America/Los_Angeles.`);
  }

  const apiUrl = url('SITE_GITHUB_API_URL', 'https://api.github.com');
  if (isProd && !isHttpsOrLocal(apiUrl.parsed)) {
    problems.push(`SITE_GITHUB_API_URL is "${apiUrl.value}", which is not https. Remove it to use https://api.github.com.`);
  }
  const liveUrl = url('SITE_LIVE_URL', 'https://donatelli.tech');
  const previewUrl = url('SITE_PREVIEW_URL', 'https://admin-preview.donatelli-services.pages.dev');

  const branch = read(env, 'SITE_GITHUB_BRANCH') || 'main';
  const previewBranch = read(env, 'SITE_PREVIEW_BRANCH') || 'admin-preview';
  // Previews force-update their branch, so the two names must never meet, in any environment.
  if (previewBranch === branch) {
    problems.push(`SITE_PREVIEW_BRANCH equals SITE_GITHUB_BRANCH (${branch}), and previews force-update their branch. Set SITE_PREVIEW_BRANCH to admin-preview.`);
  }

  const ingestSecret = read(env, 'CONNECT_INGEST_SECRET');
  if (isProd && ingestSecret && ingestSecret.length < 32) {
    problems.push(`CONNECT_INGEST_SECRET is shorter than 32 characters. Set it to the output of: ${SECRET_HINT}, and set the same value on Cloudflare Pages.`);
  }

  const siteToken = read(env, 'SITE_GITHUB_TOKEN');
  const config = {
    nodeEnv,
    isProd,
    port,
    appUrl,
    appOrigin,
    allowedOrigins,
    timeZone,
    demoMode: read(env, 'DEMO_MODE') === 'true',
    jwt: { secret: jwtSecret, expiresIn: duration.expiresIn, cookieMaxAgeMs: duration.ms },
    setupToken: read(env, 'SETUP_TOKEN'),
    mailConfigured: Boolean(read(env, 'SMTP_HOST') && read(env, 'SMTP_USER') && read(env, 'SMTP_PASSWORD')),
    site: {
      enabled: Boolean(siteToken),
      token: siteToken,
      repo: read(env, 'SITE_GITHUB_REPO') || 'Njdonatelli/donatelli-website',
      branch,
      previewBranch,
      workflow: read(env, 'SITE_WORKFLOW') || 'site.yml',
      rollbackWorkflow: read(env, 'SITE_ROLLBACK_WORKFLOW') || 'rollback.yml',
      configPath: read(env, 'SITE_CONFIG_PATH') || 'data/site.json',
      schemaPath: read(env, 'SITE_SCHEMA_PATH') || 'data/site.schema.json',
      credentialsPath: read(env, 'SITE_CREDENTIALS_PATH') || 'outputs/data/credentials.json',
      liveUrl: liveUrl.value,
      previewUrl: previewUrl.value,
      apiUrl: apiUrl.value,
    },
    connect: {
      enabled: Boolean(ingestSecret),
      ingestSecret,
      ingestSecretPrevious: read(env, 'CONNECT_INGEST_SECRET_PREVIOUS'),
      orgSlug: read(env, 'CONNECT_ORG_SLUG') || 'donatelli-tech',
      dailyCap: integer('CONNECT_DAILY_CAP', 200, { min: 1 }),
      notifyEmail: read(env, 'CONNECT_NOTIFY_EMAIL'),
    },
    backup: {
      // setInterval cannot wait longer than about 24.8 days (2^31 - 1 ms).
      intervalHours: integer('BACKUP_INTERVAL_HOURS', 0, { min: 0, max: 24 * 24 }),
      keep: integer('BACKUP_KEEP', 14, { min: 1, max: 1000 }),
    },
  };

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}

module.exports = { load, ConfigError, JWT_PLACEHOLDER };
