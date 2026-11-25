#!/usr/bin/env node
'use strict';
// NodeGSM headless server (web mode): the same ServerManager / services as the desktop app, controlled from a browser.
//   npm run serve            (or: nodegsm / node src/server/headless.js)
//   --host 127.0.0.1  --port 8730  --data <dir>  --https  --no-auth (loopback only)  --session-hours 12  --trust-proxy
// Env: NODEGSM_HOST NODEGSM_PORT NODEGSM_DATA NODEGSM_TOKEN NODEGSM_HTTPS NODEGSM_NO_AUTH NODEGSM_SESSION_HOURS NODEGSM_MAX_BODY NODEGSM_TRUST_PROXY
// This file must never load 'electron'. See docs/TECH-architecture.md (auth model) and docs/TECH-api.md (HTTP / WebSocket protocol).
const fs = require('fs');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');
const platform = require('../main/platform');
const { createCore, headlessHost } = require('../main/core');
const auth = require('./auth');

const RENDERER = path.resolve(__dirname, '..', 'renderer');
const ASSETS = path.resolve(__dirname, '..', '..', 'assets');
const PUBLIC_FILES = new Set(['/login.html', '/login.js', '/styles.css', '/theme-boot.js', '/assets/logo.svg', '/assets/icon.png', '/assets/icon-32.png', '/assets/icon-16.png']);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.woff2': 'font/woff2',
};
const DEFAULT_PORT = 8730;
const MAX_WS = 50;

const json = (res, code, obj, headers = {}) => {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(b);
};
const safeHost = (h) => (/^[A-Za-z0-9.\-:[\]]{1,255}$/.test(String(h || '')) ? h : 'localhost');

function csp(host) {
  const h = safeHost(host);
  return `default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://${h} wss://${h}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;
}
const baseHeaders = (host) => ({ 'Content-Security-Policy': csp(host), 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin' });

/** Map a URL path to a file under the renderer or assets folder; null when it escapes, is hidden or has an unknown type. */
function resolveStatic(urlPath, { renderer = RENDERER, assets = ASSETS } = {}) {
  let p;
  try { p = decodeURIComponent(urlPath); } catch { return null; }
  if (p.includes('\0') || p.includes('\\')) return null;
  if (p === '/') p = '/index.html';
  if (!p.startsWith('/')) return null;
  const segs = p.split('/').slice(1);
  if (segs.some((s) => s === '..' || s === '.' || s === '' || s.startsWith('.'))) return null;
  const isAsset = segs[0] === 'assets' && segs.length > 1;
  const root = isAsset ? assets : renderer;
  const rel = (isAsset ? segs.slice(1) : segs).join('/');
  if (!MIME[path.extname(rel).toLowerCase()]) return null;
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(root + path.sep)) return null;
  try {
    const real = fs.realpathSync(abs);
    if (!real.startsWith(fs.realpathSync(root) + path.sep) || !fs.statSync(real).isFile()) return null;
    return { file: real, url: p };
  } catch { return null; }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const len = parseInt(req.headers['content-length'] || '0', 10);
    if (len > limit) { req.resume(); return reject(Object.assign(new Error('Request body too large'), { status: 413 })); }
    const chunks = []; let n = 0; let dead = false;
    req.on('data', (c) => {
      if (dead) return;
      n += c.length;
      if (n > limit) { dead = true; chunks.length = 0; reject(Object.assign(new Error('Request body too large'), { status: 413 })); req.resume(); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!dead) resolve(Buffer.concat(chunks)); });
    req.on('error', (e) => { if (!dead) reject(e); });
  });
}

/**
 * Build and start the server.
 * opts: { dataDir, host, port, auth (default true), token, https, sessionHours, maxBody, maxFailures, trustProxy, core, startCore, env }
 * Resolves to { server, core, host, port, token, tokenSource, close() }.
 */
async function startServer(opts = {}) {
  const env = opts.env || process.env;
  const host = opts.host || '127.0.0.1';
  const authOn = opts.auth !== false;
  if (!authOn && !auth.isLoopback(host)) throw new Error(`Refusing to listen on ${host} without authentication. Authentication may only be disabled on a loopback address.`);
  const dataDir = opts.dataDir || platform.defaultDataDir();
  fs.mkdirSync(dataDir, { recursive: true });
  const tok = authOn ? (opts.token ? { token: opts.token, source: 'env' } : auth.loadToken(dataDir, env)) : { token: null, source: 'none' };
  const sessions = new auth.Sessions({ ttlMs: (Number(opts.sessionHours) > 0 ? Number(opts.sessionHours) : 12) * 3600 * 1000 });
  const limiter = new auth.RateLimiter({ maxFailures: opts.maxFailures || 5 });
  const maxBody = Number(opts.maxBody) > 0 ? Number(opts.maxBody) : 4 * 1024 * 1024;
  const httpsMode = !!opts.https;
  const trustProxy = !!opts.trustProxy;

  const core = opts.core || createCore({ dataDir, mode: 'web' });
  const api = core.buildApi(headlessHost());
  const has = (name) => Object.prototype.hasOwnProperty.call(api, name);

  const ipOf = (req) => {
    if (trustProxy) { const x = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(); if (x) return x; }
    return req.socket.remoteAddress || '?';
  };
  /** { ok, via: 'bearer' | 'cookie' | 'none', locked?: seconds } */
  const authenticate = (req) => {
    if (!authOn) return { ok: true, via: 'none' };
    const ip = ipOf(req);
    const h = String(req.headers.authorization || '');
    const bearer = /^Bearer\s+(.+)$/i.exec(h);
    if (bearer) {
      const wait = limiter.retryAfter(ip); if (wait) return { ok: false, locked: wait };
      if (auth.safeEqual(bearer[1].trim(), tok.token)) { limiter.success(ip); return { ok: true, via: 'bearer' }; }
      limiter.fail(ip); return { ok: false };
    }
    const c = auth.parseCookies(req.headers.cookie)[auth.COOKIE];
    return c && sessions.valid(c) ? { ok: true, via: 'cookie', cookie: c } : { ok: false };
  };
  /** Cross-site request forgery guard for cookie / no-auth requests: the Origin header must be present and equal to Host. */
  const sameOrigin = (req) => {
    const o = req.headers.origin;
    if (!o) return false;
    try { return new URL(o).host === req.headers.host; } catch { return false; }
  };
  const cookieHeader = (req, value, maxAgeSec) => {
    const secure = httpsMode || /^https$/i.test(String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim());
    return `${auth.COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
  };
  const denied = (res, a) => (a.locked
    ? json(res, 429, { ok: false, error: 'Too many failed attempts' }, { 'Retry-After': String(a.locked) })
    : json(res, 401, { ok: false, error: 'Unauthorized' }));

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const pathname = url.pathname;

    if (pathname === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) return json(res, 200, { ok: true });

    // ---- login / logout ----
    if (pathname === '/login' && req.method === 'POST') {
      if (!authOn) return json(res, 200, { ok: true });
      if (!sameOrigin(req)) return json(res, 403, { ok: false, error: 'Cross-origin request rejected' });
      if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return json(res, 415, { ok: false, error: 'Content-Type must be application/json' });
      const ip = ipOf(req); const wait = limiter.retryAfter(ip);
      if (wait) return json(res, 429, { ok: false, error: `Too many failed attempts. Try again in ${wait} s.` }, { 'Retry-After': String(wait) });
      let body; try { body = JSON.parse((await readBody(req, 4096)).toString('utf8')); } catch (e) { return json(res, e.status || 400, { ok: false, error: e.status === 413 ? e.message : 'Invalid JSON' }); }
      if (!body || typeof body.token !== 'string' || !auth.safeEqual(body.token.trim(), tok.token)) {
        limiter.fail(ip);
        const w2 = limiter.retryAfter(ip);
        return json(res, w2 ? 429 : 401, { ok: false, error: w2 ? `Too many failed attempts. Try again in ${w2} s.` : 'Wrong token' }, w2 ? { 'Retry-After': String(w2) } : {});
      }
      limiter.success(ip);
      return json(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(req, sessions.create(), Math.floor(sessions.ttlMs / 1000)) });
    }
    if (pathname === '/logout' && req.method === 'POST') {
      if (!sameOrigin(req)) return json(res, 403, { ok: false, error: 'Cross-origin request rejected' });
      const c = auth.parseCookies(req.headers.cookie)[auth.COOKIE]; if (c) sessions.destroy(c);
      return json(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(req, '', 0) });
    }

    // ---- API ----
    if (pathname.startsWith('/api/')) {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'Use POST' }, { Allow: 'POST' });
      const a = authenticate(req);
      if (!a.ok) return denied(res, a);
      if (a.via !== 'bearer' && !sameOrigin(req)) return json(res, 403, { ok: false, error: 'Cross-origin request rejected' });
      if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return json(res, 415, { ok: false, error: 'Content-Type must be application/json' });
      let name; try { name = decodeURIComponent(pathname.slice(5)); } catch { name = ''; }
      if (!/^[A-Za-z][A-Za-z0-9:]{0,63}$/.test(name) || !has(name)) return json(res, 404, { ok: false, error: 'Unknown channel' });
      let body;
      try { const raw = await readBody(req, maxBody); body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch (e) { return json(res, e.status || 400, { ok: false, error: e.status === 413 ? e.message : 'Invalid JSON' }); }
      const args = body && body.args !== undefined ? body.args : [];
      if (!Array.isArray(args)) return json(res, 400, { ok: false, error: '"args" must be an array' });
      try { return json(res, 200, { ok: true, data: await api[name](...args) }); } catch (e) { return json(res, 200, { ok: false, error: e && e.message ? e.message : String(e) }); }
    }

    // ---- backup download ----
    if (pathname === '/download/backup' && req.method === 'GET') {
      const a = authenticate(req);
      if (!a.ok) return denied(res, a);
      let file; try { file = core.mgr.bk().filePath(url.searchParams.get('folder'), url.searchParams.get('file')); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
      let st; try { st = fs.statSync(file); if (!st.isFile()) throw new Error('x'); } catch { return json(res, 404, { ok: false, error: 'Backup not found' }); }
      const name = path.basename(file).replace(/[^A-Za-z0-9._-]/g, '_');
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': st.size, 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      return fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    }

    // ---- static files ----
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { ok: false, error: 'Method not allowed' }, { Allow: 'GET, HEAD' });
    const f = resolveStatic(pathname);
    if (!f) return json(res, 404, { ok: false, error: 'Not found' });
    if (!PUBLIC_FILES.has(f.url)) {
      const a = authenticate(req);
      if (!a.ok) {
        if (!a.locked && f.url === '/index.html') { res.writeHead(302, { Location: '/login.html', 'Cache-Control': 'no-store' }); return res.end(); }
        return denied(res, a);
      }
    }
    const data = fs.readFileSync(f.file);
    res.writeHead(200, { ...baseHeaders(req.headers.host), 'Content-Type': MIME[path.extname(f.file).toLowerCase()], 'Content-Length': data.length, 'Cache-Control': 'no-cache' });
    return res.end(req.method === 'HEAD' ? undefined : data);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => { if (!res.headersSent) json(res, 500, { ok: false, error: 'Internal error' }); else res.destroy(); });
  });
  server.requestTimeout = 120000; server.headersTimeout = 20000;

  // ---- WebSocket push channel ----
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const reject = (code, text) => { try { socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* gone */ } socket.destroy(); };
    if (new URL(req.url, 'http://x').pathname !== '/ws') return reject(404, 'Not Found');
    const a = authenticate(req);
    if (!a.ok) return reject(a.locked ? 429 : 401, a.locked ? 'Too Many Requests' : 'Unauthorized');
    if (a.via !== 'bearer' && !sameOrigin(req)) return reject(403, 'Forbidden');
    if (wss.clients.size >= MAX_WS) return reject(503, 'Service Unavailable');
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.alive = true; ws.cookie = a.cookie || null;
      ws.on('pong', () => { ws.alive = true; }); ws.on('message', () => { /* push only */ }); ws.on('error', () => {});
      wss.emit('connection', ws, req);
    });
  });
  const unsub = core.hub.on((ch, payload) => {
    if (!wss.clients.size) return;
    let msg; try { msg = JSON.stringify({ ch, payload }); } catch { return; }
    for (const ws of wss.clients) if (ws.readyState === 1 && ws.bufferedAmount < 8 * 1024 * 1024) ws.send(msg);
  });
  const beat = setInterval(() => {
    sessions.sweep(); limiter.sweep();
    for (const ws of wss.clients) {
      if (ws.cookie && !sessions.valid(ws.cookie)) { ws.close(4401, 'Session expired'); continue; }
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false; try { ws.ping(); } catch { /* closing */ }
    }
  }, 30000);
  beat.unref();

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(opts.port) >= 0 ? Number(opts.port) : DEFAULT_PORT, host, resolve); });
  if (opts.startCore !== false) core.start();
  let closing = null;
  const close = () => closing || (closing = (async () => {
    clearInterval(beat); unsub();
    for (const ws of wss.clients) { try { ws.close(1001, 'Server shutting down'); } catch { /* ignore */ } }
    await new Promise((r) => { server.close(() => r()); if (server.closeAllConnections) server.closeAllConnections(); });
    await core.stop();
  })());
  return { server, core, host, port: server.address().port, token: tok.token, tokenSource: tok.source, sessions, limiter, close };
}

// ---------- command line ----------
function parseArgs(argv, env = process.env) {
  const yes = (v) => /^(1|true|yes)$/i.test(v || '');
  const o = {
    host: env.NODEGSM_HOST || '127.0.0.1', port: env.NODEGSM_PORT ? Number(env.NODEGSM_PORT) : DEFAULT_PORT, dataDir: env.NODEGSM_DATA || env.WGSM_DATA || undefined,
    https: yes(env.NODEGSM_HTTPS), auth: !yes(env.NODEGSM_NO_AUTH),
    sessionHours: env.NODEGSM_SESSION_HOURS ? Number(env.NODEGSM_SESSION_HOURS) : undefined, maxBody: env.NODEGSM_MAX_BODY ? Number(env.NODEGSM_MAX_BODY) : undefined,
    trustProxy: yes(env.NODEGSM_TRUST_PROXY), help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const next = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--host') o.host = next(); else if (a === '--port') o.port = Number(next()); else if (a === '--data') o.dataDir = next();
    else if (a === '--https') o.https = true; else if (a === '--no-auth') o.auth = false; else if (a === '--trust-proxy') o.trustProxy = true;
    else if (a === '--session-hours') o.sessionHours = Number(next()); else if (a === '--max-body') o.maxBody = Number(next());
    else if (a === '-h' || a === '--help') o.help = true; else throw new Error(`Unknown option: ${a}`);
  }
  if (!Number.isInteger(o.port) || o.port < 0 || o.port > 65535) throw new Error('--port must be 0-65535');
  return o;
}

const HELP = `NodeGSM headless server
  nodegsm [--host 127.0.0.1] [--port ${DEFAULT_PORT}] [--data <dir>] [--https] [--trust-proxy] [--session-hours 12] [--no-auth]
  --https          the site is served over HTTPS by a reverse proxy: session cookies get the Secure flag
  --trust-proxy    use X-Forwarded-For for the client address (rate limiting); only behind your own reverse proxy
  --no-auth        no login; only allowed on a loopback address
  Token: NODEGSM_TOKEN, or <data>/web-token (generated on first start). See docs/GUIDE-web-linux.md.`;

async function main(argv = process.argv.slice(2)) {
  let o; try { o = parseArgs(argv); } catch (e) { console.error(e.message); console.error(HELP); process.exit(2); }
  if (o.help) { console.log(HELP); return; }
  const dataDir = o.dataDir || platform.defaultDataDir();
  let s;
  try { s = await startServer({ ...o, dataDir }); } catch (e) { console.error(`Cannot start: ${e.message}`); process.exit(1); }
  // crashes are logged next to the desktop app's crash log; the process keeps running (game servers are separate processes)
  const crash = (kind) => (err) => { try { fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true }); fs.appendFileSync(path.join(dataDir, 'logs', 'crash.log'), `[${new Date().toISOString()}] ${kind}: ${err && err.stack ? err.stack : err}\n`); } catch { /* ignore */ } };
  process.on('uncaughtException', crash('uncaughtException')); process.on('unhandledRejection', crash('unhandledRejection'));
  console.log(`NodeGSM web server listening on http://${s.host.includes(':') ? `[${s.host}]` : s.host}:${s.port}  (data: ${dataDir})`);
  if (!o.auth) console.log('WARNING: authentication is disabled (loopback only).');
  else if (s.tokenSource === 'generated') console.log(`First start: your access token is\n\n  ${s.token}\n\nIt is saved in ${path.join(dataDir, 'web-token')} and will not be printed again. Open the page and paste it into the login form.`);
  else console.log(`Access token: from ${s.tokenSource === 'env' ? 'NODEGSM_TOKEN' : path.join(dataDir, 'web-token')}`);
  if (!auth.isLoopback(s.host)) console.log('NOTE: listening on a non-loopback address. Put a TLS reverse proxy in front (see docs/GUIDE-web-linux.md); the login token must not travel over plain HTTP on an untrusted network.');
  let stopping = false;
  const stop = async (sig) => {
    if (stopping) { console.log('Forced exit.'); process.exit(1); }
    stopping = true; console.log(`${sig} received: stopping game servers and shutting down ...`);
    try { await s.close(); } catch { /* best effort */ }
    process.exit(0);
  };
  process.on('SIGINT', () => stop('SIGINT')); process.on('SIGTERM', () => stop('SIGTERM'));
}

if (require.main === module) main();

module.exports = { startServer, parseArgs, resolveStatic, main, PUBLIC_FILES };
