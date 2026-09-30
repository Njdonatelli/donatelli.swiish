// End-to-end screenshots of the whole feature (spec §7.3): the public card on the edge, visitor details into
// the admin, and the admin's card, connections and website tools against a mock GitHub.
//
// Run (Bash/Zsh), from the swiish repo root, after `CI=true npm run build`:
//   NODE_PATH=/opt/node22/lib/node_modules PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node test/e2e/screens.mjs
// Success: every screen prints "ok", the last line is "e2e: N screens, no problems", exit code 0.
// Screenshots and results.json land in test/e2e/out/ (git-ignored).
//
// Environment:
//   E2E_WEBSITE_DIR  the donatelli-website checkout (default: ../donatelli-website beside this repo)
//   E2E_EDGE         "wrangler" (default: wrangler pages dev, falling back to node) or "node" (skip wrangler)
//
// Everything written here is test-only and lives in temp dirs: the website copy with the form switched on,
// the throwaway admin database, the owner owner@example.com and the visitors at example.com.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
// NODE_PATH reaches CommonJS resolution only, which is how the global Playwright install is found.
const { chromium } = require('playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'test', 'e2e', 'out');
const WEBSITE = path.resolve(process.env.E2E_WEBSITE_DIR || path.join(ROOT, '..', 'donatelli-website'));
const EDGE = process.env.E2E_EDGE || 'wrangler';
const REPO = 'Njdonatelli/donatelli-website';
const OWNER_EMAIL = 'owner@example.com';
const OWNER_PASSWORD = 'e2e-' + crypto.randomBytes(12).toString('hex');
// The draft notice from spec §4.1. It goes live only after the owner approves it; here it is test data.
const NOTICE = 'Nick Donatelli sees these details and uses them only to reply to you. They are not sold or shared. To delete them sooner, email hello@donatelli.tech.';

const cleanups = [];
const results = [];
const log = (...a) => console.log(...a);

function fail(message) {
  throw new Error(message);
}

async function waitFor(fn, { timeoutMs = 30000, stepMs = 250, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
  fail(`Timed out after ${timeoutMs} ms waiting for ${what}${last instanceof Error ? ': ' + last.message : ''}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// ---------------------------------------------------------------------------------------------------------
// 1. The website: a temp copy (with .git, so LASTMOD and FIRST_PUBLISHED resolve) with the form switched on.
// ---------------------------------------------------------------------------------------------------------
export function buildWebsiteCopy() {
  if (!fs.existsSync(path.join(WEBSITE, 'data', 'site.json'))) {
    fail(`No website checkout with data/site.json at ${WEBSITE}. Set E2E_WEBSITE_DIR.`);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-e2e-site-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const skip = new Set([path.join(WEBSITE, 'node_modules'), path.join(WEBSITE, 'outputs', 'node_modules'), path.join(WEBSITE, 'dist'), path.join(WEBSITE, '.wrangler')]);
  fs.cpSync(WEBSITE, dir, { recursive: true, filter: (src) => !skip.has(src) });
  fs.symlinkSync(path.join(WEBSITE, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  if (fs.existsSync(path.join(WEBSITE, 'outputs', 'node_modules'))) {
    fs.symlinkSync(path.join(WEBSITE, 'outputs', 'node_modules'), path.join(dir, 'outputs', 'node_modules'), 'dir');
  }

  const sitePath = path.join(dir, 'data', 'site.json');
  const site = JSON.parse(fs.readFileSync(sitePath, 'utf8'));
  site.card.connect = { ...site.card.connect, enabled: true, notice: NOTICE, retentionDays: 365 };
  fs.writeFileSync(sitePath, JSON.stringify(site, null, 2) + '\n');

  // The build refuses the form without the /security/#card-details section (spec §4.8), so the copy gets one.
  const mdPath = path.join(dir, 'outputs', 'content', 'security-practices.md');
  const md = fs.readFileSync(mdPath, 'utf8');
  const anchor = '\n\n<span id="card-details"></span>**From the contact card.** End-to-end test build only: this paragraph is never published.\n';
  const marker = 'That is all the site collects from you.';
  const at = md.indexOf(marker);
  const lineEnd = at === -1 ? md.length : md.indexOf('\n', at);
  fs.writeFileSync(mdPath, md.slice(0, lineEnd === -1 ? md.length : lineEnd) + anchor + md.slice(lineEnd === -1 ? md.length : lineEnd));

  log('website: building the test copy in', dir);
  const env = { ...process.env };
  delete env.SITE_ORIGIN;
  const r = spawnSync('npm', ['run', 'build'], { cwd: dir, env, encoding: 'utf8' });
  if (r.status !== 0) fail('Website build failed:\n' + r.stdout + r.stderr);
  if (!fs.existsSync(path.join(dir, 'dist', 'card', 'index.html'))) fail('Website build made no dist/card/index.html.');
  const consent = JSON.parse(fs.readFileSync(path.join(dir, 'dist', 'card', 'consent.json'), 'utf8'));
  if (!consent.enabled || !/^[0-9a-f]{8}$/.test(consent.version || '')) fail('dist/card/consent.json is not enabled with an 8-hex version.');
  return dir;
}

// Files the mock serves as the website repo's main branch.
function repoFiles(dir) {
  const files = {};
  for (const p of ['data/site.json', 'data/site.schema.json', 'outputs/data/credentials.json', '.github/workflows/site.yml', '.github/workflows/rollback.yml']) {
    const f = path.join(dir, p);
    if (fs.existsSync(f)) files[p] = fs.readFileSync(f, 'utf8');
  }
  return files;
}

// ---------------------------------------------------------------------------------------------------------
// 2. The edge: wrangler pages dev with the ingest bindings, or a node server calling handleConnect directly.
// ---------------------------------------------------------------------------------------------------------
export async function startEdge(dir, bindings) {
  return (EDGE === 'wrangler' && (await startWrangler(dir, bindings))) || startNodeEdge(dir, bindings);
}

async function startWrangler(dir, bindings) {
  const port = await freePort();
  const bin = path.join(dir, 'node_modules', '.bin', 'wrangler');
  if (!fs.existsSync(bin)) return null;
  const args = ['pages', 'dev', 'dist', '--port', String(port), '--ip', '127.0.0.1'];
  for (const [k, v] of Object.entries(bindings)) args.push('--binding', `${k}=${v}`);
  const child = spawn(bin, args, { cwd: dir, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const url = `http://127.0.0.1:${port}`;
  try {
    await waitFor(async () => (await fetch(url + '/card/')).status === 200, { timeoutMs: 45000, what: 'wrangler pages dev' });
  } catch (e) {
    child.kill('SIGKILL');
    log('edge: wrangler pages dev did not start; using the node fallback.\n' + output.slice(-2000));
    return null;
  }
  cleanups.push(() => child.kill('SIGTERM'));
  return { url, kind: 'wrangler' };
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.vcf': 'text/vcard; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml' };

function distFile(dist, pathname) {
  let f = path.join(dist, decodeURIComponent(pathname));
  if (!f.startsWith(dist)) return null;
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
  return fs.existsSync(f) ? f : null;
}

async function startNodeEdge(dir, bindings) {
  const dist = path.join(dir, 'dist');
  const { handleConnect } = await import(pathToFileURL(path.join(dir, 'functions', 'api', 'connect.js')).href);
  const ASSETS = {
    async fetch(input) {
      const u = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      const f = distFile(dist, u.pathname);
      if (!f) return new Response('Not found', { status: 404 });
      return new Response(fs.readFileSync(f), { status: 200, headers: { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' } });
    },
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/api/connect') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const request = new Request(url, { method: req.method, headers: req.headers, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined });
      const response = await handleConnect({ request, env: { ...bindings, ASSETS } });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      return res.end(Buffer.from(await response.arrayBuffer()));
    }
    const f = distFile(dist, url.pathname);
    if (!f) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.existsSync(path.join(dist, '404.html')) ? fs.readFileSync(path.join(dist, '404.html')) : 'Not found');
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
    res.end(fs.readFileSync(f));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, kind: 'node' };
}

// ---------------------------------------------------------------------------------------------------------
// 3. Screens: one screenshot each, plus the §7.3 assertions.
// ---------------------------------------------------------------------------------------------------------
const VIEW = {
  375: { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true },
  1280: { viewport: { width: 1280, height: 800 } },
};

export async function newContext(browser, width, { scheme = 'light', storageState, javaScriptEnabled = true } = {}) {
  const ctx = await browser.newContext({ ...VIEW[width], colorScheme: scheme, storageState, javaScriptEnabled, acceptDownloads: true });
  // Recorded in the page itself, so a violation is caught even when the console line is filtered.
  if (javaScriptEnabled) {
    await ctx.addInitScript(() => {
      window.__csp = [];
      document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
    });
  }
  const page = await ctx.newPage();
  page.__console = [];
  page.on('console', (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) page.__console.push(m.text());
  });
  page.on('pageerror', (e) => page.__console.push('pageerror: ' + e.message));
  return { ctx, page };
}

export async function shoot(page, name, { width, fullPage = true, jsOff = false } = {}) {
  await page.waitForTimeout(400);
  const file = path.join(OUT, name + '.png');
  await page.screenshot({ path: file, fullPage });
  const problems = [];
  if (!jsOff) {
    const c = await page.evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight && s.visibility !== 'hidden' && s.display !== 'none';
      };
      const prim = [...document.querySelectorAll('.btn-primary, .btn--primary')].filter(visible);
      return {
        primaries: prim.length,
        colors: prim.map((p) => getComputedStyle(p).color),
        font: getComputedStyle(document.body).fontFamily,
        scrollWidth: document.documentElement.scrollWidth,
        h1: [...document.querySelectorAll('h1')].map((h) => ({ text: h.textContent, dot: !!(h.lastElementChild && h.lastElementChild.classList.contains('dot') && h.textContent.endsWith(h.lastElementChild.textContent)) })),
        csp: window.__csp || [],
      };
    });
    if (c.primaries > 1) problems.push(`${c.primaries} primary buttons visible in the viewport`);
    for (const color of c.colors) if (color !== 'rgb(14, 13, 12)') problems.push(`primary text is ${color}, not rgb(14, 13, 12)`);
    if (!/Archivo/.test(c.font)) problems.push(`body font is ${c.font}`);
    if (width === 375 && c.scrollWidth > 375) problems.push(`horizontal scroll: scrollWidth ${c.scrollWidth}`);
    for (const h of c.h1) if (!h.dot) problems.push(`h1 "${h.text}" does not end in a .dot span`);
    for (const v of c.csp) problems.push('CSP violation: ' + v);
  }
  for (const line of page.__console || []) problems.push(line);
  page.__console = [];
  results.push({ name, file: path.relative(ROOT, file), problems });
  log(`${name}: ${problems.length ? 'PROBLEMS\n  - ' + problems.join('\n  - ') : 'ok'}`);
}

export function resetOut() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
}

export { results, cleanups, chromium };

// The public card: three looks, the form sent with JS, the no-JS 303 path, and the not-sent page.
export async function cardScreens(browser, edge) {
  for (const [width, scheme, theme] of [[375, 'dark', null], [1280, 'dark', null], [375, 'light', 'light']]) {
    const c = await newContext(browser, width, { scheme });
    await c.page.goto(edge.url + '/card/?via=qr');
    if (theme) await c.page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    await shoot(c.page, `card-${width}-${scheme}`, { width });
    await c.ctx.close();
  }

  const sent = await newContext(browser, 375, { scheme: 'dark' });
  await sent.page.goto(edge.url + '/card/?via=qr');
  await sent.page.fill('.card-form input[name=name]', 'Test Visitor One');
  await sent.page.fill('.card-form input[name=email]', 'visitor1@example.com');
  await sent.page.fill('.card-form input[name=company]', 'Example Co');
  await sent.page.fill('.card-form textarea[name=note]', 'Quotes take a week to go out.');
  await sent.page.click('.card-form button[type=submit]');
  await sent.page.locator('.card-status', { hasText: /Sent to Nick at/ }).waitFor({ timeout: 20000 });
  await sent.page.locator('.card-connect').scrollIntoViewIfNeeded();
  await shoot(sent.page, 'card-form-sent-375', { width: 375, fullPage: false });
  await sent.ctx.close();

  const nojs = await newContext(browser, 375, { scheme: 'dark', javaScriptEnabled: false });
  await nojs.page.goto(edge.url + '/card/?via=nfc');
  await nojs.page.fill('.card-form input[name=name]', 'Test Visitor Two');
  await nojs.page.fill('.card-form input[name=email]', 'visitor2@example.com');
  await Promise.all([nojs.page.waitForURL('**/card/sent/', { timeout: 20000 }), nojs.page.click('.card-form button[type=submit]')]);
  await shoot(nojs.page, 'card-sent-nojs-375', { width: 375, jsOff: true });
  await nojs.ctx.close();

  const notSent = await newContext(browser, 375, { scheme: 'dark' });
  await notSent.page.goto(edge.url + '/card/not-sent/');
  await shoot(notSent.page, 'card-not-sent-375', { width: 375 });
  await notSent.ctx.close();
}

// Visitor details reach the connections table only: never the audit trail, the server log or its output.
async function checkNoPii(harness) {
  const needles = ['visitor1@example.com', 'visitor2@example.com', 'Test Visitor One', 'Test Visitor Two', 'Example Co'];
  const logFile = path.join(harness.dir, 'server.log');
  const haystacks = { 'server output': harness.output(), 'server.log': fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '' };
  const sqlite3 = require(path.join(ROOT, 'node_modules', 'sqlite3'));
  haystacks.audit_log = await new Promise((resolve, reject) => {
    const db = new sqlite3.Database(harness.dbFile, sqlite3.OPEN_READONLY, (err) => {
      if (err) return reject(err);
      db.all('SELECT event_type, entity_id, entity_data FROM audit_log', [], (e, rows) => {
        db.close();
        if (e) reject(e);
        else resolve(JSON.stringify(rows));
      });
    });
  });
  const problems = [];
  for (const [where, text] of Object.entries(haystacks)) {
    for (const n of needles) if (text.includes(n)) problems.push(`${where} contains "${n}"`);
  }
  results.push({ name: 'no-visitor-data-in-logs', problems });
  log(`no-visitor-data-in-logs: ${problems.length ? 'PROBLEMS\n  - ' + problems.join('\n  - ') : 'ok'}`);
}

async function main() {
  const { startServer } = require(path.join(ROOT, 'test', 'helpers', 'server-harness.js'));
  const { startMockGitHub } = require(path.join(ROOT, 'scripts', 'mock-github.js'));
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  if (!fs.existsSync(path.join(ROOT, 'build', 'index.html'))) {
    log('admin: build/ is missing; running CI=true npm run build');
    const r = spawnSync('npm', ['run', 'build'], { cwd: ROOT, env: { ...process.env, CI: 'true' }, encoding: 'utf8' });
    if (r.status !== 0) fail('Admin build failed:\n' + r.stdout + r.stderr);
  }

  const siteDir = buildWebsiteCopy();

  const mock = await startMockGitHub({ port: 0, repo: REPO, files: repoFiles(siteDir), seedFrom: siteDir, autoProgress: false });
  cleanups.push(() => mock.close());
  log('mock GitHub:', mock.url);

  const harness = await startServer({
    realBuild: true,
    env: {
      SITE_GITHUB_TOKEN: 'e2e-' + crypto.randomBytes(20).toString('hex'),
      SITE_GITHUB_REPO: REPO,
      SITE_GITHUB_API_URL: mock.url,
      SITE_LIVE_URL: mock.liveUrl('main'),
      SITE_PREVIEW_URL: mock.liveUrl('admin-preview'),
    },
  });
  cleanups.push(() => harness.stop());
  const ADMIN = harness.url;
  log('admin:', ADMIN);

  const bindings = {
    CONNECT_INGEST_URL: `${ADMIN}/api/ingest/connections`,
    CONNECT_INGEST_SECRET: harness.env.CONNECT_INGEST_SECRET,
  };
  const edge = await startEdge(siteDir, bindings);
  log(`edge (${edge.kind}):`, edge.url);

  const browser = await chromium.launch();
  cleanups.push(() => browser.close());
  const api = async (page, p) => {
    const r = await page.request.get(ADMIN + p);
    if (!r.ok()) fail(`GET ${p} answered ${r.status()}`);
    return r.json();
  };

  // --- Setup through the UI, on a fresh database. ---
  const a375 = await newContext(browser, 375);
  await a375.page.goto(ADMIN + '/admin');
  await a375.page.waitForURL('**/setup');
  await shoot(a375.page, 'setup-375', { width: 375 });
  await a375.page.fill('#setup-token', harness.env.SETUP_TOKEN);
  await a375.page.fill('#setup-email', OWNER_EMAIL);
  await a375.page.fill('#setup-password', OWNER_PASSWORD);
  await a375.page.click('button[type=submit]');
  await a375.page.waitForURL(/\/admin$/);
  // One login per run: the server allows five per 15 minutes per address, so other contexts reuse this one.
  const owner = await a375.ctx.storageState();

  const a1280 = await newContext(browser, 1280, { storageState: owner });
  await a1280.page.goto(ADMIN + '/admin/connections');
  await a1280.page.getByText('No connections yet.', { exact: false }).waitFor();
  await shoot(a1280.page, 'connections-empty-1280', { width: 1280 });

  for (const [width, scheme] of [[375, 'light'], [1280, 'dark']]) {
    const anon = await newContext(browser, width, { scheme });
    await anon.page.goto(ADMIN + '/login');
    await anon.page.locator('h1').waitFor();
    await shoot(anon.page, `login-${width}-${scheme}`, { width });
    await anon.ctx.close();
  }

  // --- The public card on the edge; the two sends become the admin's connections. ---
  await cardScreens(browser, edge);

  // --- The admin with those two connections. ---
  await a375.page.goto(ADMIN + '/admin');
  await a375.page.getByText('Test Visitor One').first().waitFor();
  await shoot(a375.page, 'overview-375', { width: 375 });

  await a1280.page.goto(ADMIN + '/admin/connections');
  await a1280.page.getByText('visitor1@example.com').waitFor();
  await shoot(a1280.page, 'connections-list-1280', { width: 1280 });

  await a375.page.goto(ADMIN + '/admin/connections');
  await a375.page.getByText('Test Visitor Two').waitFor();
  await shoot(a375.page, 'connections-list-375', { width: 375 });
  await a375.page.click('a.row:has-text("Test Visitor One")');
  await a375.page.getByText('Kept until', { exact: false }).waitFor();
  await shoot(a375.page, 'connection-detail-375', { width: 375 });

  // --- Card tab. ---
  await a1280.page.goto(ADMIN + '/admin/card');
  await a1280.page.locator('.card-preview').waitFor();
  await shoot(a1280.page, 'card-editor-1280', { width: 1280, fullPage: false });

  await a375.page.goto(ADMIN + '/admin/card');
  await a375.page.getByRole('button', { name: 'Preview', exact: true }).click();
  await a375.page.locator('.card-preview').waitFor();
  await shoot(a375.page, 'card-editor-375-preview', { width: 375 });

  // --- Website tab: edit, preview, publish. ---
  await a1280.page.goto(ADMIN + '/admin/website');
  await a1280.page.locator('#f-tagline').waitFor();
  await a1280.page.fill('#f-tagline', 'Remote operations and automation');
  await a1280.page.getByText(/Draft saved \d/).waitFor({ timeout: 15000 });
  await a1280.page.locator('.tablewrap td', { hasText: 'Remote operations and automation' }).waitFor();
  await shoot(a1280.page, 'website-1280', { width: 1280 });

  await a375.page.goto(ADMIN + '/admin/website');
  await a375.page.locator('.publishbar button', { hasText: 'Build preview' }).click();
  await a375.page.locator('.publishbar', { hasText: 'Building preview' }).waitFor({ timeout: 20000 });
  await shoot(a375.page, 'website-preview-building-375', { width: 375, fullPage: false });

  const building = await waitFor(async () => {
    const s = await api(a375.page, '/api/admin/site/status');
    return s.preview && s.preview.run && s.preview.run.id ? s : null;
  }, { what: 'the preview run to appear' });
  await mock.completeRun(building.preview.run.id, 'success');
  await waitFor(async () => (await api(a375.page, '/api/admin/site/status')).preview.publishable, { what: 'a publishable preview' });

  await a1280.page.goto(ADMIN + '/admin/website');
  const publish = a1280.page.locator('.publishbar button', { hasText: 'Publish to donatelli.tech' });
  await publish.waitFor({ timeout: 20000 });
  await shoot(a1280.page, 'website-preview-ready-1280', { width: 1280, fullPage: false });

  await publish.click();
  const publishing = await waitFor(async () => {
    const s = await api(a1280.page, '/api/admin/site/status');
    return s.production && s.production.run && s.production.run.headSha === building.preview.headSha ? s : null;
  }, { what: 'the production run for the published commit' });
  await mock.completeRun(publishing.production.run.id, 'success');
  await waitFor(async () => (await api(a1280.page, '/api/admin/site/status')).state === 'live', { what: 'the live state' });
  await a1280.page.goto(ADMIN + '/admin/website');
  await a1280.page.locator('.pill .badge', { hasText: 'Live' }).waitFor({ timeout: 20000 });
  await shoot(a1280.page, 'website-live-1280', { width: 1280, fullPage: false });

  await a1280.page.locator('#ws-history').scrollIntoViewIfNeeded();
  await a1280.page.locator('.history li').first().waitFor();
  await shoot(a1280.page, 'website-history-1280', { width: 1280, fullPage: false });

  await checkNoPii(harness);

  const failed = results.filter((r) => r.problems.length);
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ edge: edge.kind, results }, null, 2) + '\n');
  if (failed.length) {
    log(`e2e: ${failed.length} of ${results.length} screens with problems`);
    process.exitCode = 1;
  } else {
    log(`e2e: ${results.length} screens, no problems`);
  }
}

export async function runCleanups() {
  for (const fn of cleanups.splice(0).reverse()) {
    try {
      await fn();
    } catch (e) {
      // Cleanup is best effort; the temp dirs are in os.tmpdir().
    }
  }
}

// Runs only as a script, so a scratch check can import the pieces without starting the whole run.
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    await main();
  } catch (e) {
    console.error(e.stack || e.message);
    process.exitCode = 1;
  } finally {
    await runCleanups();
  }
}
