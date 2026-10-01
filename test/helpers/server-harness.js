'use strict';
// Runs the real server.js as a child process in a throwaway directory, so each test server
// gets its own SQLite file, server.log and in-memory rate limiters.
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const COPIED = ['server.js', 'lib', 'migrations', 'scripts', 'database.json'];
// A script tag lets tests see the CSP nonce injection without a React build.
const STUB_INDEX = '<!doctype html><html><head><meta charset="utf-8"><title>donatelli.tech admin</title></head>'
  + '<body><div id="root"></div><script src="/static/js/main.js"></script></body></html>\n';
// Only what node and npx need; the parent's env (a developer .env, SITE_*, SMTP_*) stays out.
const PASSTHROUGH = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'NODE_EXTRA_CA_CERTS'];

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function prepareDir({ realBuild }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-srv-'));
  for (const name of COPIED) {
    const src = path.join(ROOT, name);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(dir, name), { recursive: true });
  }
  if (realBuild) {
    const build = path.join(ROOT, 'build');
    if (!fs.existsSync(path.join(build, 'index.html'))) {
      throw new Error('realBuild needs build/index.html. Run `npm run build` first.');
    }
    fs.cpSync(build, path.join(dir, 'build'), { recursive: true });
  } else {
    fs.mkdirSync(path.join(dir, 'build'));
    fs.writeFileSync(path.join(dir, 'build', 'index.html'), STUB_INDEX);
  }
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  fs.mkdirSync(path.join(dir, 'data'));
  return dir;
}

// Overrides win; an override of undefined or null removes that variable.
function buildEnv(port, overrides) {
  const env = {};
  for (const key of PASSTHROUGH) if (process.env[key] !== undefined) env[key] = process.env[key];
  Object.assign(env, {
    NODE_ENV: 'production',
    PORT: String(port),
    APP_URL: `http://localhost:${port}`,
    JWT_SECRET: crypto.randomBytes(48).toString('base64'),
    SETUP_TOKEN: crypto.randomBytes(24).toString('hex'),
    CONNECT_INGEST_SECRET: crypto.randomBytes(48).toString('base64'),
  });
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === null) delete env[key];
    else env[key] = String(value);
  }
  return env;
}

function spawnServer(dir, env) {
  const child = spawn(process.execPath, ['server.js'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { stdout: '', stderr: '', all: '' };
  child.stdout.on('data', (d) => { out.stdout += d; out.all += d; });
  child.stderr.on('data', (d) => { out.stderr += d; out.all += d; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  return { child, out, exited };
}

async function waitForHealth(url, exited, out, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let exit = null;
  exited.then((e) => { exit = e; });
  while (Date.now() < deadline) {
    if (exit) {
      const err = new Error(`server.js exited with code ${exit.code} before it was healthy:\n${out.all}`);
      err.exitCode = exit.code;
      err.output = out.all;
      throw err;
    }
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.status === 200) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server.js was not healthy after ${timeoutMs} ms:\n${out.all}`);
}

async function startServer({ env = {}, realBuild = false, timeoutMs = 30000 } = {}) {
  const dir = prepareDir({ realBuild });
  const port = await freePort();
  const fullEnv = buildEnv(port, env);
  const { child, out, exited } = spawnServer(dir, fullEnv);
  const url = `http://localhost:${port}`;

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const killer = setTimeout(() => child.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(killer);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  };

  try {
    await waitForHealth(url, exited, out, timeoutMs);
  } catch (err) {
    await stop();
    throw err;
  }

  return {
    url,
    port,
    dir,
    dbFile: path.join(dir, 'data', 'cards.db'),
    env: fullEnv,
    stop,
    output: () => out.all,
  };
}

// For boot-refusal tests: runs server.js and resolves once it exits (or is killed at the
// timeout, which then reports code null).
async function runUntilExit({ env = {}, timeoutMs = 15000 } = {}) {
  const dir = prepareDir({ realBuild: false });
  const port = await freePort();
  const { child, out, exited } = spawnServer(dir, buildEnv(port, env));
  const killer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  const { code, signal } = await exited;
  clearTimeout(killer);
  fs.rmSync(dir, { recursive: true, force: true });
  return { code, signal, stdout: out.stdout, stderr: out.stderr };
}

module.exports = { startServer, runUntilExit };
