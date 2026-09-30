'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, ConfigError, JWT_PLACEHOLDER } = require('../../lib/config');

const SECRET = 'x'.repeat(48);
const PROD = {
  NODE_ENV: 'production',
  APP_URL: 'https://admin.example.com',
  JWT_SECRET: SECRET,
};

function problemsFor(env) {
  try {
    load(env);
  } catch (err) {
    assert.ok(err instanceof ConfigError, `expected ConfigError, got ${err}`);
    return err.problems;
  }
  return [];
}

test('a complete production env loads with the documented defaults', () => {
  const config = load(PROD);
  assert.equal(config.isProd, true);
  assert.equal(config.appUrl, 'https://admin.example.com');
  assert.equal(config.appOrigin, 'https://admin.example.com');
  assert.deepEqual(config.allowedOrigins, ['https://admin.example.com']);
  assert.equal(config.timeZone, 'America/Los_Angeles');
  assert.equal(config.port, 3000);
  assert.deepEqual(config.jwt, { secret: SECRET, expiresIn: '24h', cookieMaxAgeMs: 24 * 60 * 60 * 1000 });
  assert.equal(config.setupToken, null);
  assert.equal(config.mailConfigured, false);
  assert.deepEqual(config.site, {
    enabled: false,
    token: null,
    repo: 'Njdonatelli/donatelli-website',
    branch: 'main',
    previewBranch: 'admin-preview',
    workflow: 'site.yml',
    rollbackWorkflow: 'rollback.yml',
    configPath: 'data/site.json',
    schemaPath: 'data/site.schema.json',
    credentialsPath: 'outputs/data/credentials.json',
    liveUrl: 'https://donatelli.tech',
    previewUrl: 'https://admin-preview.donatelli-services.pages.dev',
    apiUrl: 'https://api.github.com',
  });
  assert.deepEqual(config.connect, {
    enabled: false,
    ingestSecret: null,
    ingestSecretPrevious: null,
    orgSlug: 'donatelli-tech',
    dailyCap: 200,
    notifyEmail: null,
  });
  assert.deepEqual(config.backup, { intervalHours: 0, keep: 14 });
});

test('production refuses each unsafe value, naming the variable and the fix', () => {
  const cases = [
    ['JWT_SECRET shorter than 32', { JWT_SECRET: 'x'.repeat(31) }, /JWT_SECRET is shorter than 32 characters/],
    ['JWT_SECRET placeholder', { JWT_SECRET: JWT_PLACEHOLDER }, /JWT_SECRET is the example placeholder/],
    ['JWT_SECRET missing', { JWT_SECRET: undefined }, /JWT_SECRET is not set/],
    ['DEMO_MODE=true', { DEMO_MODE: 'true' }, /DEMO_MODE is true/],
    ['APP_URL missing', { APP_URL: undefined }, /APP_URL is not set/],
    ['APP_URL http', { APP_URL: 'http://admin.example.com' }, /APP_URL is "http:\/\/admin.example.com", which is not https/],
    ['SITE_GITHUB_API_URL http', { SITE_GITHUB_API_URL: 'http://api.example.com' }, /SITE_GITHUB_API_URL is "http:\/\/api.example.com", which is not https/],
    ['preview branch = branch', { SITE_PREVIEW_BRANCH: 'main' }, /SITE_PREVIEW_BRANCH equals SITE_GITHUB_BRANCH \(main\)/],
    ['preview branch = custom branch', { SITE_GITHUB_BRANCH: 'live', SITE_PREVIEW_BRANCH: 'live' }, /SITE_PREVIEW_BRANCH equals SITE_GITHUB_BRANCH \(live\)/],
    ['CONNECT_INGEST_SECRET short', { CONNECT_INGEST_SECRET: 'y'.repeat(31) }, /CONNECT_INGEST_SECRET is shorter than 32 characters/],
    ['ALLOWED_ORIGINS without APP_URL', { ALLOWED_ORIGINS: 'https://other.example.com' }, /ALLOWED_ORIGINS does not include the APP_URL origin \(https:\/\/admin.example.com\)/],
  ];
  for (const [name, overrides, pattern] of cases) {
    const problems = problemsFor({ ...PROD, ...overrides });
    assert.equal(problems.length, 1, `${name}: ${JSON.stringify(problems)}`);
    assert.match(problems[0], pattern, name);
  }
});

test('every problem is reported at once, in the error message too', () => {
  let error;
  try {
    load({ NODE_ENV: 'production', JWT_SECRET: 'short', DEMO_MODE: 'true', SITE_PREVIEW_BRANCH: 'main' });
  } catch (err) {
    error = err;
  }
  assert.ok(error instanceof ConfigError);
  assert.equal(error.problems.length, 4);
  assert.match(error.message, /^Server not started: 4 configuration problems\.\n- /);
  for (const problem of error.problems) assert.ok(error.message.includes(`- ${problem}`));
});

test('localhost APP_URL and SITE_GITHUB_API_URL may be http in production (test harness, mock GitHub)', () => {
  const config = load({ ...PROD, APP_URL: 'http://localhost:4321', SITE_GITHUB_API_URL: 'http://127.0.0.1:4010/' });
  assert.equal(config.appOrigin, 'http://localhost:4321');
  assert.deepEqual(config.allowedOrigins, ['http://localhost:4321']);
  assert.equal(config.site.apiUrl, 'http://127.0.0.1:4010');
});

test('explicit ALLOWED_ORIGINS are normalised to origins', () => {
  const config = load({ ...PROD, ALLOWED_ORIGINS: ' https://admin.example.com/ ,https://ops.example.com' });
  assert.deepEqual(config.allowedOrigins, ['https://admin.example.com', 'https://ops.example.com']);
  assert.match(problemsFor({ ...PROD, ALLOWED_ORIGINS: 'https://admin.example.com,not a url' })[0], /ALLOWED_ORIGINS has "not a url"/);
});

test('development boots on dev defaults with only JWT_SECRET set', () => {
  const config = load({ JWT_SECRET: JWT_PLACEHOLDER });
  assert.equal(config.nodeEnv, 'development');
  assert.equal(config.isProd, false);
  assert.equal(config.appUrl, 'http://localhost:3000');
  assert.deepEqual(config.allowedOrigins, ['http://localhost:3000', 'http://localhost:8095']);
  // Production-only rules do not apply in development
  assert.equal(load({ JWT_SECRET: 'short', DEMO_MODE: 'true', APP_URL: 'http://dev.example.com' }).demoMode, true);
  assert.match(problemsFor({})[0], /JWT_SECRET is not set/);
});

test('the preview branch can never equal the production branch, even in development', () => {
  assert.match(problemsFor({ JWT_SECRET: SECRET, SITE_PREVIEW_BRANCH: 'main' })[0], /SITE_PREVIEW_BRANCH equals/);
});

test('empty strings count as unset (dotenv and compose env_file write KEY=)', () => {
  const config = load({ ...PROD, PORT: '', ALLOWED_ORIGINS: '', SETUP_TOKEN: '', SITE_GITHUB_TOKEN: ' ', CONNECT_INGEST_SECRET: '', ADMIN_TIME_ZONE: '' });
  assert.equal(config.port, 3000);
  assert.deepEqual(config.allowedOrigins, ['https://admin.example.com']);
  assert.equal(config.setupToken, null);
  assert.equal(config.site.enabled, false);
  assert.equal(config.connect.enabled, false);
  assert.equal(config.timeZone, 'America/Los_Angeles');
});

test('JWT_EXPIRES_IN drives the cookie lifetime; bare numbers are seconds', () => {
  const cases = [
    ['24h', '24h', 86400000],
    ['30m', '30m', 1800000],
    ['7d', '7d', 604800000],
    ['45s', '45s', 45000],
    ['3600', 3600, 3600000],
  ];
  for (const [raw, expiresIn, ms] of cases) {
    const { jwt } = load({ ...PROD, JWT_EXPIRES_IN: raw });
    assert.equal(jwt.expiresIn, expiresIn, raw);
    assert.equal(jwt.cookieMaxAgeMs, ms, raw);
  }
  assert.match(problemsFor({ ...PROD, JWT_EXPIRES_IN: '2 weeks' })[0], /JWT_EXPIRES_IN is "2 weeks"/);
  assert.match(problemsFor({ ...PROD, JWT_EXPIRES_IN: '0h' })[0], /JWT_EXPIRES_IN/);
});

test('site, connect, mail and backup values are read from the env', () => {
  const config = load({
    ...PROD,
    SETUP_TOKEN: 'setup-token-value',
    SMTP_HOST: 'smtp.example.com',
    SMTP_USER: 'mailer',
    SMTP_PASSWORD: 'mail-password',
    SITE_GITHUB_TOKEN: 'token-value',
    SITE_LIVE_URL: 'https://www.example.com/',
    CONNECT_INGEST_SECRET: 'z'.repeat(32),
    CONNECT_INGEST_SECRET_PREVIOUS: 'p'.repeat(32),
    CONNECT_ORG_SLUG: 'example-org',
    CONNECT_DAILY_CAP: '3',
    CONNECT_NOTIFY_EMAIL: 'owner@example.com',
    BACKUP_INTERVAL_HOURS: '24',
    BACKUP_KEEP: '7',
    ADMIN_TIME_ZONE: 'Europe/London',
  });
  assert.equal(config.setupToken, 'setup-token-value');
  assert.equal(config.mailConfigured, true);
  assert.equal(config.site.enabled, true);
  assert.equal(config.site.token, 'token-value');
  assert.equal(config.site.liveUrl, 'https://www.example.com');
  assert.deepEqual(config.connect, {
    enabled: true,
    ingestSecret: 'z'.repeat(32),
    ingestSecretPrevious: 'p'.repeat(32),
    orgSlug: 'example-org',
    dailyCap: 3,
    notifyEmail: 'owner@example.com',
  });
  assert.deepEqual(config.backup, { intervalHours: 24, keep: 7 });
  assert.equal(config.timeZone, 'Europe/London');
});

test('malformed numbers, URLs and time zones are refused in every environment', () => {
  const dev = { JWT_SECRET: SECRET };
  assert.match(problemsFor({ ...dev, CONNECT_DAILY_CAP: '0' })[0], /CONNECT_DAILY_CAP is "0"/);
  assert.match(problemsFor({ ...dev, BACKUP_KEEP: 'many' })[0], /BACKUP_KEEP is "many"/);
  assert.match(problemsFor({ ...dev, BACKUP_INTERVAL_HOURS: '1000' })[0], /BACKUP_INTERVAL_HOURS is "1000"/);
  assert.match(problemsFor({ ...dev, PORT: '70000' })[0], /PORT is "70000"/);
  assert.match(problemsFor({ ...dev, SITE_LIVE_URL: 'donatelli.tech' })[0], /SITE_LIVE_URL is "donatelli.tech", which is not an http\(s\) URL/);
  assert.match(problemsFor({ ...dev, APP_URL: 'admin.example.com' })[0], /APP_URL is "admin.example.com", which is not an http\(s\) URL/);
  assert.match(problemsFor({ ...dev, ADMIN_TIME_ZONE: 'Mars/Olympus' })[0], /ADMIN_TIME_ZONE is "Mars\/Olympus"/);
});

test('secret values never appear in problem messages', () => {
  const problems = problemsFor({ ...PROD, JWT_SECRET: 'tiny-secret', CONNECT_INGEST_SECRET: 'short-ingest' });
  assert.equal(problems.length, 2);
  for (const p of problems) {
    assert.ok(!p.includes('tiny-secret'));
    assert.ok(!p.includes('short-ingest'));
  }
});
