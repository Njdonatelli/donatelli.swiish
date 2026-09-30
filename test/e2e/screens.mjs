// End-to-end run of the whole feature (spec §7.3): the public card on the edge, visitor details into the
// admin, and the admin's card, connections, website and account tools against a mock GitHub. Every flow the
// owner has is driven through the real UI and screenshotted.
//
// Run (Bash/Zsh), from the swiish repo root, after `CI=true npm run build`:
//   NODE_PATH=/opt/node22/lib/node_modules PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node test/e2e/screens.mjs
// Success: every screen and check prints "ok", the last line is "e2e: N screens and checks, no problems",
// exit code 0. Screenshots and results.json land in test/e2e/out/ (git-ignored).
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
const VISITOR_ONE = { name: 'Test Visitor One', email: 'visitor1@example.com', company: 'Example Co', note: 'Quotes take a week to go out.' };
const VISITOR_TWO = { name: 'Test Visitor Two', email: 'visitor2@example.com' };
const OWNER_NOTES = 'Called back on Friday about quoting.';
// The browser runs in a zone other than the admin's (ADMIN_TIME_ZONE defaults to America/Los_Angeles), so a
// screen that mixed browser time with server copy would show two different clocks.
const BROWSER_TZ = 'Europe/Berlin';

const cleanups = [];
const results = [];
const log = (...a) => console.log(...a);

function fail(message) {
  throw new Error(message);
}

function check(name, problems) {
  results.push({ name, problems });
  log(`${name}: ${problems.length ? 'PROBLEMS\n  - ' + problems.join('\n  - ') : 'ok'}`);
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
function buildWebsiteCopy() {
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
async function startEdge(dir, bindings) {
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
// 3. Screens: one screenshot each, plus the §7.3 assertions and the design-system checks below.
// ---------------------------------------------------------------------------------------------------------
const VIEW = {
  375: { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true },
  1280: { viewport: { width: 1280, height: 800 } },
};

async function newContext(browser, width, { scheme = 'light', storageState, javaScriptEnabled = true } = {}) {
  const ctx = await browser.newContext({ ...VIEW[width], colorScheme: scheme, storageState, javaScriptEnabled, acceptDownloads: true, timezoneId: BROWSER_TZ });
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

// Runs in the page. Only what is inside the viewport counts, as a person sees it.
function inspect() {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const signalProbe = document.createElement('span');
  signalProbe.style.color = 'var(--dt-signal)';
  document.body.appendChild(signalProbe);
  const signal = getComputedStyle(signalProbe).color;
  signalProbe.remove();
  const prim = [...document.querySelectorAll('.btn-primary, .btn--primary')].filter(visible);
  const headings = [...document.querySelectorAll('h1, h2, h3, h4')].filter((h) => getComputedStyle(h).display !== 'none' && h.getBoundingClientRect().width > 0).map((h) => {
    const text = h.textContent.replace(/\s+$/, '');
    const dot = h.querySelector('.dot:last-of-type');
    const mark = /[.?!;:]$/.test(text) ? text.slice(-1) : null;
    let colour = null;
    if (dot) {
      const s = getComputedStyle(dot);
      colour = mark === '.' ? s.color : s.backgroundClip === 'text' || s.webkitBackgroundClip === 'text' ? 'clip' : s.color;
    }
    return { tag: h.tagName.toLowerCase(), text, mark, wrapped: !!dot && text.endsWith(dot.textContent) && dot.textContent === mark, colour };
  });
  const mono = [...document.querySelectorAll('body *')].some((el) => /IBM Plex Mono/.test(getComputedStyle(el).fontFamily.split(',')[0]) && el.textContent.trim() && visible(el));
  const faces = [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/["']/g, ''));
  return {
    signal,
    primaries: prim.length,
    colors: prim.map((p) => getComputedStyle(p).color),
    font: getComputedStyle(document.body).fontFamily,
    faces,
    mono,
    scrollWidth: document.documentElement.scrollWidth,
    headings,
    csp: window.__csp || [],
  };
}

// Full-page shots grow the viewport to the page height instead of stitching, so fixed and sticky bars sit
// where they sit at the end of a scroll, not over the middle of the page.
async function shoot(page, name, { width, fullPage = true, jsOff = false } = {}) {
  // The pointer stays where the last click left it; parked in the corner, no button is caught mid-hover.
  await page.mouse.move(0, 0);
  await page.waitForTimeout(400);
  const problems = [];
  if (!jsOff) {
    await page.evaluate(() => document.fonts.ready);
    const c = await page.evaluate(inspect);
    if (c.primaries > 1) problems.push(`${c.primaries} primary buttons visible in the viewport`);
    for (const color of c.colors) if (color !== 'rgb(14, 13, 12)') problems.push(`primary text is ${color}, not rgb(14, 13, 12)`);
    if (!/Archivo/.test(c.font)) problems.push(`body font is ${c.font}`);
    if (!c.faces.includes('Archivo')) problems.push('Archivo never loaded: the page is drawn in a fallback font');
    if (c.mono && !c.faces.includes('IBM Plex Mono')) problems.push('IBM Plex Mono never loaded: mono text is drawn in a fallback font');
    if (width === 375 && c.scrollWidth > 375) problems.push(`horizontal scroll: scrollWidth ${c.scrollWidth}`);
    for (const h of c.headings) {
      if (h.tag === 'h1' && !h.mark) problems.push(`h1 "${h.text}" ends in no mark`);
      if (h.mark && !h.wrapped) problems.push(`${h.tag} "${h.text}" does not end in a .dot span`);
      if (h.wrapped && h.mark === '.' && h.colour !== c.signal) problems.push(`${h.tag} "${h.text}" dot is ${h.colour}, not the signal ${c.signal}`);
      if (h.wrapped && h.mark !== '.' && h.colour !== 'clip') problems.push(`${h.tag} "${h.text}" mark "${h.mark}" is not the clipped two-colour split`);
    }
    for (const v of c.csp) problems.push('CSP violation: ' + v);
  }
  const file = path.join(OUT, name + '.png');
  const size = page.viewportSize();
  const height = fullPage ? await page.evaluate(() => Math.ceil(document.documentElement.scrollHeight)) : size.height;
  if (fullPage && height > size.height) {
    await page.setViewportSize({ width: size.width, height });
    await page.waitForTimeout(150);
    await page.screenshot({ path: file });
    await page.setViewportSize(size);
  } else {
    await page.screenshot({ path: file, fullPage: jsOff && fullPage });
  }
  for (const line of page.__console || []) problems.push(line);
  page.__console = [];
  results.push({ name, file: path.relative(ROOT, file), problems });
  log(`${name}: ${problems.length ? 'PROBLEMS\n  - ' + problems.join('\n  - ') : 'ok'}`);
}

async function download(page, trigger) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), trigger()]);
  return { name: dl.suggestedFilename(), text: fs.readFileSync(await dl.path(), 'utf8') };
}

// ---------------------------------------------------------------------------------------------------------
// 4. Flows.
// ---------------------------------------------------------------------------------------------------------

// The public card: three looks, the form sent with JS, the no-JS 303 path, and the not-sent page.
async function cardScreens(browser, edge) {
  for (const [width, scheme, theme] of [[375, 'dark', null], [1280, 'dark', null], [375, 'light', 'light']]) {
    const c = await newContext(browser, width, { scheme });
    await c.page.goto(edge.url + '/card/?via=qr');
    if (theme) await c.page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    await shoot(c.page, `card-${width}-${scheme}`, { width });
    await c.ctx.close();
  }

  const sent = await newContext(browser, 375, { scheme: 'dark' });
  await sent.page.goto(edge.url + '/card/?via=qr');
  await sent.page.fill('.card-form input[name=name]', VISITOR_ONE.name);
  await sent.page.fill('.card-form input[name=email]', VISITOR_ONE.email);
  await sent.page.fill('.card-form input[name=company]', VISITOR_ONE.company);
  await sent.page.fill('.card-form textarea[name=note]', VISITOR_ONE.note);
  await sent.page.click('.card-form button[type=submit]');
  await sent.page.locator('.card-status', { hasText: /Sent to Nick at/ }).waitFor({ timeout: 20000 });
  await sent.page.locator('.card-connect').scrollIntoViewIfNeeded();
  await shoot(sent.page, 'card-form-sent-375', { width: 375, fullPage: false });
  await sent.ctx.close();

  const nojs = await newContext(browser, 375, { scheme: 'dark', javaScriptEnabled: false });
  await nojs.page.goto(edge.url + '/card/?via=nfc');
  await nojs.page.fill('.card-form input[name=name]', VISITOR_TWO.name);
  await nojs.page.fill('.card-form input[name=email]', VISITOR_TWO.email);
  await Promise.all([nojs.page.waitForURL('**/card/sent/', { timeout: 20000 }), nojs.page.click('.card-form button[type=submit]')]);
  await shoot(nojs.page, 'card-sent-nojs-375', { width: 375, jsOff: true });
  await nojs.ctx.close();

  const notSent = await newContext(browser, 375, { scheme: 'dark' });
  await notSent.page.goto(edge.url + '/card/not-sent/');
  await shoot(notSent.page, 'card-not-sent-375', { width: 375 });
  await notSent.ctx.close();
}

// Setup through the UI on a fresh database, then the login page in both themes, a refused password, the
// keyboard focus ring, and a real login whose session the other admin screens reuse.
async function setupAndLogin(t) {
  const { browser, ADMIN, harness } = t;
  t.a375 = await newContext(browser, 375);
  const p = t.a375.page;
  await p.goto(ADMIN + '/admin');
  await p.waitForURL('**/setup');
  await shoot(p, 'setup-375', { width: 375 });
  await p.fill('#setup-token', harness.env.SETUP_TOKEN);
  await p.fill('#setup-email', OWNER_EMAIL);
  await p.fill('#setup-password', OWNER_PASSWORD);
  await p.click('button[type=submit]');
  await p.waitForURL(/\/admin$/);

  for (const [width, scheme] of [[375, 'light'], [1280, 'dark']]) {
    const anon = await newContext(browser, width, { scheme });
    await anon.page.goto(ADMIN + '/login');
    await anon.page.locator('h1').waitFor();
    await shoot(anon.page, `login-${width}-${scheme}`, { width });
    await anon.ctx.close();
  }

  // The login limiter allows five tries per 15 minutes per address; this run uses three.
  const login = await newContext(browser, 375);
  await login.page.goto(ADMIN + '/login');
  await login.page.fill('#login-email', OWNER_EMAIL);
  await login.page.fill('#login-password', 'not-the-password-at-all');
  await login.page.click('button[type=submit]');
  await login.page.getByText('Email or password did not match. Try again, or reset your password.').waitFor();
  await shoot(login.page, 'login-error-375', { width: 375 });
  await login.page.fill('#login-password', OWNER_PASSWORD);
  await login.page.focus('#login-password');
  await login.page.keyboard.press('Tab');
  await login.page.keyboard.press('Tab');
  const ring = await login.page.evaluate(() => {
    const el = document.activeElement;
    const s = getComputedStyle(el);
    return { text: el.textContent.trim(), outline: s.outlineStyle + ' ' + s.outlineWidth, color: s.outlineColor, focusVisible: el.matches(':focus-visible') };
  });
  const ringProblems = [];
  if (ring.text !== 'Log in' || !ring.focusVisible || ring.outline !== 'solid 2px') ringProblems.push(`focused ${JSON.stringify(ring)}`);
  check('login-focus-ring', ringProblems);
  await shoot(login.page, 'login-focus-375', { width: 375 });
  await login.page.keyboard.press('Enter');
  await login.page.waitForURL(/\/admin$/);
  t.owner = await login.ctx.storageState();
  await login.ctx.close();

  t.a1280 = await newContext(browser, 1280, { storageState: t.owner });
  await t.a1280.page.goto(ADMIN + '/admin/connections');
  await t.a1280.page.getByText('No connections yet.', { exact: false }).waitFor();
  await shoot(t.a1280.page, 'connections-empty-1280', { width: 1280 });
}

async function api(page, url, p) {
  const r = await page.request.get(url + p);
  if (!r.ok()) fail(`GET ${p} answered ${r.status()}`);
  return r.json();
}

// The two visitors reach the list and the detail; status, notes, vCard, CSV and erase-by-email.
async function connectionsFlow(t) {
  const { ADMIN } = t;
  const p375 = t.a375.page;
  const p1280 = t.a1280.page;

  await p375.goto(ADMIN + '/admin');
  await p375.getByText(VISITOR_ONE.name).first().waitFor();
  await shoot(p375, 'overview-375', { width: 375 });

  await p1280.goto(ADMIN + '/admin/connections');
  await p1280.getByText(VISITOR_ONE.email).waitFor();
  await shoot(p1280, 'connections-list-1280', { width: 1280 });

  await p375.goto(ADMIN + '/admin/connections');
  await p375.getByText(VISITOR_TWO.name).waitFor();
  await shoot(p375, 'connections-list-375', { width: 375 });
  await p375.click(`a.row:has-text("${VISITOR_ONE.name}")`);
  await p375.getByText('Kept until', { exact: false }).waitFor();
  await shoot(p375, 'connection-detail-375', { width: 375 });

  await p375.selectOption('#conn-status', 'contacted');
  await p375.getByText(/Marked contacted at \d{1,2}:\d{2} [AP]M\./).waitFor();
  await p375.fill('#conn-notes', OWNER_NOTES);
  await p375.getByRole('button', { name: 'Save notes' }).click();
  await p375.getByText(/Notes saved at \d{1,2}:\d{2} [AP]M\./).waitFor();
  const vcf = await download(p375, () => p375.getByRole('button', { name: 'Save to contacts' }).click());
  const vcfProblems = [];
  if (vcf.name !== 'test-visitor-one.vcf') vcfProblems.push(`file name ${vcf.name}`);
  for (const line of ['BEGIN:VCARD', 'VERSION:3.0', `FN:${VISITOR_ONE.name}`, 'N:One;Test Visitor;;;', `ORG:${VISITOR_ONE.company}`, `EMAIL;TYPE=INTERNET:${VISITOR_ONE.email}`, 'END:VCARD']) {
    if (!vcf.text.split('\r\n').includes(line)) vcfProblems.push(`missing line ${line}`);
  }
  if (!/NOTE:Quotes take a week to go out\.\\nMet via the donatelli\.tech card \(qr\) on \d{4}-\d{2}-\d{2}/.test(vcf.text.replace(/\r\n /g, ''))) vcfProblems.push('NOTE does not hold the note and the "Met via" line');
  if (/^TEL/m.test(vcf.text)) vcfProblems.push('has a TEL line');
  if (/[^\r]\n/.test(vcf.text)) vcfProblems.push('line endings are not CRLF');
  check('contact-vcf', vcfProblems);
  await shoot(p375, 'connection-detail-updated-375', { width: 375 });

  await p1280.goto(ADMIN + '/admin/connections');
  await p1280.getByText(VISITOR_ONE.email).waitFor();
  const csv = await download(p1280, () => p1280.getByRole('button', { name: 'Export CSV' }).click());
  await p1280.getByText('Exported 2 connections.').waitFor();
  const csvProblems = [];
  if (!/^connections-\d{4}-\d{2}-\d{2}\.csv$/.test(csv.name)) csvProblems.push(`file name ${csv.name}`);
  if (!csv.text.startsWith('﻿received_at,name,email,company,note,source,status,owner_notes\r\n')) csvProblems.push('no BOM plus the spec header');
  if (!csv.text.includes(`,${VISITOR_ONE.name},${VISITOR_ONE.email},${VISITOR_ONE.company},${VISITOR_ONE.note},qr,contacted,${OWNER_NOTES}\r\n`)) csvProblems.push('the visitor one row is not as stored');
  // Only card.js turns ?via= into the source field (spec §4.1), so the no-JS send from ?via=nfc says card.
  if (!csv.text.includes(`,${VISITOR_TWO.name},${VISITOR_TWO.email},,,card,new,\r\n`)) csvProblems.push('the visitor two row is not as stored: ' + JSON.stringify(csv.text));
  check('connections-csv', csvProblems);
  await shoot(p1280, 'connections-exported-1280', { width: 1280, fullPage: false });

  await p1280.getByRole('button', { name: 'Contacted', exact: true }).click();
  await p1280.locator('tbody tr').filter({ hasText: VISITOR_TWO.email }).waitFor({ state: 'detached' });
  const filtered = await p1280.locator('tbody tr').count();
  check('connections-filter-contacted', filtered === 1 ? [] : [`${filtered} rows under Contacted, expected 1`]);
  await p1280.getByRole('button', { name: 'Archived', exact: true }).click();
  await p1280.getByText('No connections match this filter.').waitFor();
  await p1280.getByRole('button', { name: 'All', exact: true }).click();
  await p1280.locator('tbody tr').filter({ hasText: VISITOR_TWO.email }).waitFor();

  await p375.goto(ADMIN + '/admin/connections');
  await p375.getByText(VISITOR_TWO.name).waitFor();
  await p375.getByRole('button', { name: 'Erase by email' }).click();
  await p375.fill('#erase-email', VISITOR_TWO.email);
  await shoot(p375, 'connections-erase-dialog-375', { width: 375, fullPage: false });
  await p375.locator('dialog').getByRole('button', { name: 'Erase records' }).click();
  await p375.getByText(new RegExp(`Erased 1 record for ${VISITOR_TWO.email.replace('.', '\\.')} at \\d{1,2}:\\d{2} [AP]M\\.`)).waitFor();
  await p375.locator('a.row', { hasText: VISITOR_TWO.name }).waitFor({ state: 'detached' });
  await shoot(p375, 'connections-erased-375', { width: 375 });
  const left = await api(p375, ADMIN, '/api/admin/connections?status=all');
  check('erase-by-email', left.items.length === 1 && left.items[0].email === VISITOR_ONE.email ? [] : [`${left.items.length} rows left after the erase`]);
}

// Build preview, let the mock pass the preview run, publish, let the mock pass the production run, and wait
// for the status to read Live. Returns the published commit.
async function previewAndPublish(t, { buildOn, publishOn, prevHead = null, shots = {} }) {
  const { ADMIN, mock } = t;
  if (shots.build !== false) {
    const before = await api(buildOn.page, ADMIN, '/api/admin/site/status');
    prevHead = before.preview && before.preview.headSha;
  }
  if (shots.build !== false) {
    await buildOn.page.locator('.publishbar button', { hasText: 'Build preview' }).click();
  }
  await buildOn.page.locator('.publishbar', { hasText: 'Building preview' }).waitFor({ timeout: 20000 });
  if (shots.building) await shoot(buildOn.page, shots.building, { width: buildOn.width, fullPage: false });

  const building = await waitFor(async () => {
    const s = await api(buildOn.page, ADMIN, '/api/admin/site/status');
    return s.preview && s.preview.headSha && s.preview.headSha !== prevHead && s.preview.run && s.preview.run.headSha === s.preview.headSha ? s : null;
  }, { what: 'the preview run to appear' });
  await mock.completeRun(building.preview.run.id, 'success');
  await waitFor(async () => (await api(buildOn.page, ADMIN, '/api/admin/site/status')).preview.publishable, { what: 'a publishable preview' });

  const page = publishOn.page;
  await page.goto(ADMIN + publishOn.path);
  const publish = page.locator('.publishbar button', { hasText: 'Publish to donatelli.tech' });
  await publish.waitFor({ timeout: 20000 });
  if (shots.ready) await shoot(page, shots.ready, { width: publishOn.width, fullPage: false });

  await publish.click();
  const publishing = await waitFor(async () => {
    const s = await api(page, ADMIN, '/api/admin/site/status');
    return s.production && s.production.run && s.production.run.headSha === building.preview.headSha ? s : null;
  }, { what: 'the production run for the published commit' });
  if (shots.publishing) {
    await page.locator('.publishbar', { hasText: 'Publishing' }).waitFor({ timeout: 20000 });
    await shoot(page, shots.publishing, { width: publishOn.width, fullPage: false });
  }
  await mock.completeRun(publishing.production.run.id, 'success');
  const live = await waitFor(async () => {
    const s = await api(page, ADMIN, '/api/admin/site/status');
    return s.state === 'live' && s.production.liveSha === building.preview.headSha ? s : null;
  }, { what: 'the live state' });
  const main = mock.state.refs.get('main');
  const problems = [];
  if (main !== building.preview.headSha) problems.push(`main is ${main}, not the preview commit ${building.preview.headSha}`);
  const patches = mock.state.requests.filter((r) => r.method === 'PATCH' && r.path === '/git/refs/heads/main');
  if (!patches.length || patches.some((r) => r.body.force !== false)) problems.push('a PATCH of main did not send force:false');
  return { commit: building.preview.headSha, headline: live.headline, problems };
}

// Card tab: edit the card line, watch the preview follow, then preview, publish and go live.
async function cardEditFlow(t) {
  const { ADMIN, mock } = t;
  const p1280 = t.a1280.page;
  const p375 = t.a375.page;

  await p1280.goto(ADMIN + '/admin/card');
  await p1280.locator('.card-preview').waitFor();
  await shoot(p1280, 'card-editor-1280', { width: 1280, fullPage: false });

  await p375.goto(ADMIN + '/admin/card');
  await p375.getByRole('button', { name: 'Preview', exact: true }).click();
  await p375.locator('.card-preview').waitFor();
  await shoot(p375, 'card-editor-375-preview', { width: 375 });

  const line = 'End-to-end test card line.';
  await p1280.fill('#f-card-lede', line);
  await p1280.getByText(/Draft saved \d{1,2}:\d{2} [AP]M\./).waitFor({ timeout: 15000 });
  await p1280.locator('.card-preview', { hasText: line }).waitFor();
  await p1280.locator('.publishbar', { hasText: '1 change.' }).waitFor();
  // From the top the sticky preview shows the edited line; next to the field it has scrolled past it.
  await p1280.evaluate(() => window.scrollTo(0, 0));
  await shoot(p1280, 'card-editor-changed-1280', { width: 1280, fullPage: false });

  const out = await previewAndPublish(t, {
    buildOn: { page: p1280, width: 1280 },
    publishOn: { page: p375, width: 375, path: '/admin/card' },
    shots: { building: 'card-preview-building-1280', ready: 'card-preview-ready-375', publishing: 'card-publishing-375' },
  });
  if (!/^Live since \d{1,2}:\d{2} [AP]M\. Last change: card line\.$/.test(out.headline)) out.problems.push(`headline "${out.headline}"`);
  const site = JSON.parse(t.mock.fileAt('main', 'data/site.json'));
  if (site.card.lede !== line) out.problems.push(`main site.json card.lede is ${JSON.stringify(site.card.lede)}`);
  check('card-edit-published', out.problems);
  t.cardCommit = out.commit;

  await p1280.goto(ADMIN + '/admin');
  await p1280.getByText(/Last change: card line\./).waitFor({ timeout: 20000 });
  await shoot(p1280, 'overview-1280', { width: 1280 });

  // A laptop commit to the same field while a draft is open: Build preview is refused as STALE, and from
  // then on the tab shows and autosaves the draft the server rebased onto that commit.
  await p1280.goto(ADMIN + '/admin/card');
  await p1280.locator('#f-owner-jobTitle').waitFor();
  await p1280.fill('#f-owner-jobTitle', 'Operations and automation lead');
  await waitFor(async () => {
    const d = (await api(p1280, ADMIN, '/api/admin/site')).draft;
    return d && d.config.owner.jobTitle === 'Operations and automation lead';
  }, { what: 'the job title draft to save' });
  const upstream = JSON.parse(mock.fileAt('main', 'data/site.json'));
  upstream.owner.jobTitle = 'Operations and automation consultant';
  const laptop = mock.pushCommit({ files: { 'data/site.json': JSON.stringify(upstream, null, 2) + '\n' }, message: 'Edit the job title from the laptop' });
  await mock.completeRun(mock.runsFor(laptop)[0].id, 'success');
  await p1280.locator('.publishbar button', { hasText: 'Build preview' }).click();
  await p1280.locator('.publishbar', { hasText: /in the same fields: job title\. Reload to get that change/i }).waitFor();
  const stale = [];
  await waitFor(async () => (await p1280.inputValue('#f-owner-jobTitle')) === upstream.owner.jobTitle, { what: 'the rebased draft in the form' }).catch((e) => stale.push(e.message));
  // The only edit was the clashing one, so once validation catches up the rebased draft matches main.
  await p1280.locator('.publishbar', { hasText: 'No changes.' }).waitFor().catch((e) => stale.push(e.message));
  await p1280.evaluate(() => window.scrollTo(0, 0));
  await shoot(p1280, 'card-stale-1280', { width: 1280, fullPage: false });
  await p1280.fill('#f-card-lede', 'Second end-to-end test line.');
  await waitFor(async () => {
    const d = (await api(p1280, ADMIN, '/api/admin/site')).draft;
    return d && d.config.card.lede === 'Second end-to-end test line.' ? d : null;
  }, { what: 'the next autosave' }).then((d) => {
    if (d.baseSha !== laptop) stale.push(`the autosave wrote base ${d.baseSha}, not the laptop commit ${laptop}`);
    if (d.config.owner.jobTitle !== upstream.owner.jobTitle) stale.push(`the autosave put back job title ${JSON.stringify(d.config.owner.jobTitle)}`);
  });
  const previewBefore = mock.state.refs.get('admin-preview');
  await p1280.locator('.publishbar button', { hasText: 'Build preview' }).click();
  await waitFor(() => {
    const head = mock.state.refs.get('admin-preview');
    return head !== previewBefore && mock.state.commits.get(head).parents[0] === laptop;
  }, { timeoutMs: 20000, what: 'a preview built on the laptop commit' }).catch((e) => stale.push(e.message));
  check('stale-draft-rebased', stale);
  const leftover = await api(p1280, ADMIN, '/api/admin/site/status');
  if (leftover.preview && leftover.preview.run && leftover.preview.run.status !== 'completed') await mock.completeRun(leftover.preview.run.id, 'success');
  await p1280.getByRole('button', { name: 'Discard draft' }).click();
  await p1280.locator('dialog[open]').getByRole('button', { name: 'Discard draft' }).click();
  await p1280.getByText('No draft.', { exact: false }).waitFor();
}

// Website tab: a site-facts edit through to live, a restore from History, Redeploy, and a dry-run rollback.
async function websiteFlow(t) {
  const { ADMIN, mock } = t;
  const p1280 = t.a1280.page;
  const p375 = t.a375.page;

  await p1280.goto(ADMIN + '/admin/website');
  await p1280.locator('#f-tagline').waitFor();
  const oldTagline = await p1280.inputValue('#f-tagline');
  await p1280.fill('#f-tagline', 'Remote operations and automation');
  await p1280.getByText(/Draft saved \d{1,2}:\d{2} [AP]M\./).waitFor({ timeout: 15000 });
  await p1280.locator('.tablewrap td', { hasText: 'Remote operations and automation' }).waitFor();
  await p1280.evaluate(() => window.scrollTo(0, 0));
  await shoot(p1280, 'website-1280', { width: 1280 });

  await p375.goto(ADMIN + '/admin/website');
  await p375.locator('.publishbar button', { hasText: 'Build preview' }).waitFor();
  const facts = await previewAndPublish(t, {
    buildOn: { page: p375, width: 375 },
    publishOn: { page: p1280, width: 1280, path: '/admin/website' },
    shots: { building: 'website-preview-building-375', ready: 'website-preview-ready-1280' },
  });
  if (!/Last change: tagline\.$/.test(facts.headline)) facts.problems.push(`headline "${facts.headline}"`);
  check('website-facts-published', facts.problems);
  await p1280.goto(ADMIN + '/admin/website');
  await p1280.locator('.pill .badge', { hasText: 'Live' }).waitFor({ timeout: 20000 });
  await shoot(p1280, 'website-live-1280', { width: 1280, fullPage: false });

  // Restore the seed version: the confirm lists both edits before anything is committed.
  await p1280.locator('#ws-history').scrollIntoViewIfNeeded();
  const seedRow = p1280.locator('.history li', { hasText: 'Seed the website repo' });
  await seedRow.waitFor();
  await shoot(p1280, 'website-history-1280', { width: 1280, fullPage: false });
  await p375.goto(ADMIN + '/admin/website');
  const seed375 = p375.locator('.history li', { hasText: 'Seed the website repo' });
  await seed375.getByRole('button', { name: 'Restore this version' }).click();
  const dialog = p375.locator('dialog[open]');
  await dialog.locator('tbody tr', { hasText: 'Tagline' }).waitFor();
  await dialog.locator('tbody tr', { hasText: 'Card line' }).waitFor();
  await shoot(p375, 'website-restore-dialog-375', { width: 375, fullPage: false });
  await seedRow.getByRole('button', { name: 'Restore this version' }).click();
  await p1280.locator('dialog[open] tbody tr', { hasText: 'Tagline' }).waitFor();
  await shoot(p1280, 'website-restore-dialog-1280', { width: 1280, fullPage: false });
  await p1280.locator('dialog[open]').getByRole('button', { name: 'Cancel' }).click();

  const beforeRestore = await api(p375, ADMIN, '/api/admin/site/status');
  await dialog.getByRole('button', { name: 'Build preview of this version' }).click();
  await p375.getByText(/Restore of [0-9a-f]{7} sent to the preview\./).waitFor({ timeout: 20000 });
  await shoot(p375, 'website-restored-375', { width: 375 });
  const restored = await previewAndPublish(t, {
    buildOn: { page: p375, width: 375 },
    publishOn: { page: p1280, width: 1280, path: '/admin/website' },
    prevHead: beforeRestore.preview && beforeRestore.preview.headSha,
    shots: { build: false },
  });
  const site = JSON.parse(mock.fileAt('main', 'data/site.json'));
  if (site.tagline !== oldTagline) restored.problems.push(`tagline after restore is ${JSON.stringify(site.tagline)}`);
  if (site.card.lede !== null) restored.problems.push(`card.lede after restore is ${JSON.stringify(site.card.lede)}`);
  check('history-restore-published', restored.problems);

  // Recovery: Redeploy dispatches site.yml on main; the dry-run rollback dispatches rollback.yml with dry_run.
  await p1280.goto(ADMIN + '/admin/website');
  await p1280.locator('.pill .badge', { hasText: 'Live' }).waitFor({ timeout: 20000 });
  // The mock keeps runs newest first, so new ones are told apart by id.
  const knownRuns = () => new Set(mock.state.runs.map((r) => r.id));
  let known = knownRuns();
  await p1280.getByRole('button', { name: 'Redeploy live site' }).click();
  await p1280.getByText(/Redeploy started at \d{1,2}:\d{2} [AP]M\./).waitFor();
  const redeploy = mock.state.runs.find((r) => !known.has(r.id) && r.event === 'workflow_dispatch');
  const redeployProblems = [];
  if (!redeploy || redeploy.head_branch !== 'main' || !/site/.test(redeploy.path || redeploy.name || '')) redeployProblems.push(`dispatch ${JSON.stringify(redeploy && { branch: redeploy.head_branch, name: redeploy.name, path: redeploy.path })}`);
  await p1280.locator('#ws-recovery').scrollIntoViewIfNeeded();
  await shoot(p1280, 'website-redeploy-1280', { width: 1280, fullPage: false });
  if (redeploy) {
    await mock.completeRun(redeploy.id, 'success');
    await waitFor(async () => (await api(p1280, ADMIN, '/api/admin/site/status')).state === 'live', { what: 'live after the redeploy' });
  }
  check('redeploy-dispatched', redeployProblems);

  await p375.goto(ADMIN + '/admin/website');
  await p375.getByRole('button', { name: 'Roll back production' }).click();
  const rb = p375.locator('dialog[open]');
  await rb.locator('label[for$="rollback-dry"], label.switch').first().click();
  await rb.getByLabel('Type ROLL BACK to confirm.').fill('ROLL BACK');
  await shoot(p375, 'website-rollback-dialog-375', { width: 375, fullPage: false });
  known = knownRuns();
  await rb.getByRole('button', { name: 'Request the rollback plan' }).click();
  await p375.getByText(/Rollback plan requested at \d{1,2}:\d{2} [AP]M\. The run summary lists the target; nothing changed\./).waitFor();
  const rollback = mock.state.runs.find((r) => !known.has(r.id) && r.event === 'workflow_dispatch');
  const rbProblems = [];
  if (!rollback || !/rollback/.test(rollback.path || rollback.name || '') || !rollback.inputs || rollback.inputs.dry_run !== 'true') {
    rbProblems.push(`dispatch ${JSON.stringify(rollback && { name: rollback.name, path: rollback.path, inputs: rollback.inputs })}`);
  }
  await shoot(p375, 'website-rollback-plan-375', { width: 375 });
  if (rollback) await mock.completeRun(rollback.id, 'success');
  const after = await waitFor(async () => {
    const s = await api(p375, ADMIN, '/api/admin/site/status');
    return s.state !== 'publishing' ? s : null;
  }, { what: 'status after the dry run' });
  if (after.state !== 'live') rbProblems.push(`state after a dry run is ${after.state}`);
  check('rollback-dry-run-dispatched', rbProblems);
}

// Account: health and activity in both themes, the theme menu, then Sign out everywhere ends every session
// and a fresh login works.
async function accountFlow(t) {
  const { browser, ADMIN } = t;
  const p1280 = t.a1280.page;
  const p375 = t.a375.page;

  await p1280.goto(ADMIN + '/admin/account');
  await p1280.locator('.checklist li').first().waitFor();
  await p1280.locator('section[aria-labelledby="acc-activity"] tbody tr').first().waitFor();
  await shoot(p1280, 'account-1280', { width: 1280 });

  const dark = await newContext(browser, 1280, { scheme: 'dark', storageState: t.owner });
  await dark.page.goto(ADMIN + '/admin');
  await dark.page.getByText(VISITOR_ONE.name).first().waitFor();
  await shoot(dark.page, 'overview-1280-dark', { width: 1280 });
  await dark.page.goto(ADMIN + '/admin/website');
  await dark.page.locator('#f-tagline').waitFor();
  await shoot(dark.page, 'website-1280-dark', { width: 1280, fullPage: false });
  await dark.page.goto(ADMIN + '/admin/connections');
  await dark.page.getByText(VISITOR_ONE.email).waitFor();
  await dark.page.click(`a:has-text("${VISITOR_ONE.name}")`);
  await dark.page.getByText('Kept until', { exact: false }).waitFor();
  await shoot(dark.page, 'connection-detail-1280-dark', { width: 1280 });
  await dark.ctx.close();

  await p375.goto(ADMIN + '/admin/account');
  await p375.locator('.checklist li').first().waitFor();
  await p375.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'Dark' }).click();
  const theme = await p375.evaluate(() => document.documentElement.getAttribute('data-theme'));
  check('theme-menu-dark', theme === 'dark' ? [] : [`data-theme is ${theme}`]);
  await shoot(p375, 'account-375-dark', { width: 375 });
  await p375.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'System' }).click();

  await p375.getByRole('button', { name: 'Sign out everywhere' }).click();
  await p375.waitForURL('**/login');
  await p375.getByText(/Signed out everywhere at \d{1,2}:\d{2} [AP]M\. Log in again on each device\./).waitFor();
  await shoot(p375, 'signed-out-375', { width: 375 });

  // The other device's session is gone too: its next request lands on the login page.
  await p1280.goto(ADMIN + '/admin/connections');
  await p1280.waitForURL('**/login', { timeout: 15000 });
  const stale = await p1280.request.get(ADMIN + '/api/auth/me');
  const problems = stale.status() === 401 ? [] : [`the other session still answers ${stale.status()}`];
  await p1280.fill('#login-email', OWNER_EMAIL);
  await p1280.fill('#login-password', OWNER_PASSWORD);
  await p1280.click('button[type=submit]');
  await p1280.waitForURL(/\/admin\/connections$/);
  await p1280.getByText(VISITOR_ONE.email).waitFor();
  check('sign-out-everywhere', problems);
}

// Visitor details reach the connections table only: never the audit trail, the server log or its output.
// The owner's own notes stay out of them too.
async function checkLogs(harness) {
  const needles = [VISITOR_ONE.email, VISITOR_TWO.email, VISITOR_ONE.name, VISITOR_TWO.name, VISITOR_ONE.company, VISITOR_ONE.note, OWNER_NOTES];
  const logFile = path.join(harness.dir, 'server.log');
  const haystacks = { 'server output': harness.output(), 'server.log': fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '' };
  const sqlite3 = require(path.join(ROOT, 'node_modules', 'sqlite3'));
  const rows = await new Promise((resolve, reject) => {
    const db = new sqlite3.Database(harness.dbFile, sqlite3.OPEN_READONLY, (err) => {
      if (err) return reject(err);
      db.all('SELECT event_type, entity_type, entity_id, entity_data FROM audit_log', [], (e, all) => {
        db.close();
        if (e) reject(e);
        else resolve(all);
      });
    });
  });
  haystacks.audit_log = JSON.stringify(rows);
  const problems = [];
  for (const [where, text] of Object.entries(haystacks)) {
    for (const n of needles) if (text.includes(n)) problems.push(`${where} contains "${n}"`);
  }
  if (!haystacks['server.log'].includes('[connect] stored')) problems.push('server.log has no "[connect] stored" entry, so the scan proves nothing');
  check('no-visitor-data-in-logs', problems);

  const events = new Set(rows.map((r) => r.event_type));
  const expected = ['setup_completed', 'connection_created', 'connection_updated', 'connection_vcard_exported', 'connections_exported', 'connections_erased', 'site_preview_created', 'site_published', 'site_reverted', 'site_redeploy_requested', 'site_rollback_requested', 'sessions_revoked'];
  check('audit-events', expected.filter((e) => !events.has(e)).map((e) => `no ${e} row`));
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

  // Headless Linux Chromium hints glyph advances to whole pixels, which closes up Archivo's word space at
  // 16px ("Bookan intro call"). Phones and desktop browsers place glyphs fractionally, as this flag does.
  const browser = await chromium.launch({ args: ['--font-render-hinting=none'] });
  cleanups.push(() => browser.close());
  const t = { browser, edge, harness, mock, ADMIN };

  await setupAndLogin(t);
  await cardScreens(browser, edge);
  await connectionsFlow(t);
  await cardEditFlow(t);
  await websiteFlow(t);
  await accountFlow(t);
  await checkLogs(harness);

  const failed = results.filter((r) => r.problems.length);
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ edge: edge.kind, results }, null, 2) + '\n');
  if (failed.length) {
    log(`e2e: ${failed.length} of ${results.length} screens and checks with problems`);
    process.exitCode = 1;
  } else {
    log(`e2e: ${results.length} screens and checks, no problems`);
  }
}

async function runCleanups() {
  for (const fn of cleanups.splice(0).reverse()) {
    try {
      await fn();
    } catch (e) {
      // Cleanup is best effort; the temp dirs are in os.tmpdir().
    }
  }
}

try {
  await main();
} catch (e) {
  console.error(e.stack || e.message);
  process.exitCode = 1;
} finally {
  await runCleanups();
}
