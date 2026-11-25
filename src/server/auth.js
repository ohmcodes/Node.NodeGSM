'use strict';
// Authentication helpers for the headless server: token storage, constant-time compare, signed in-memory sessions,
// failed-login rate limiting. Nothing here logs or returns a token except loadToken() (printed once by headless.js).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COOKIE = 'nodegsm_session';

/** Constant-time string compare (hashes both sides first so the length does not leak). */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * The access token: env NODEGSM_TOKEN, else <data>/web-token, else a new random one stored there (mode 0600 where supported).
 * Returns { token, source: 'env' | 'file' | 'generated' }.
 */
function loadToken(dataDir, env = process.env) {
  const fromEnv = String(env.NODEGSM_TOKEN || '').trim();
  if (fromEnv) {
    if (fromEnv.length < 12) throw new Error('NODEGSM_TOKEN must be at least 12 characters');
    return { token: fromEnv, source: 'env' };
  }
  const file = path.join(dataDir, 'web-token');
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t.length >= 12) return { token: t, source: 'file' };
  } catch { /* none yet */ }
  const token = crypto.randomBytes(24).toString('base64url');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, token + '\n', { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* Windows: ACLs of the user's own folder apply */ }
  return { token, source: 'generated' };
}

/** Sessions: random id kept in memory, cookie = id.HMAC(secret, id) so a forged cookie is rejected without a lookup. */
class Sessions {
  constructor({ ttlMs = 12 * 3600 * 1000, now = Date.now } = {}) {
    this.ttlMs = ttlMs; this.now = now;
    this.secret = crypto.randomBytes(32);
    this.map = new Map();   // id -> expiresAt
  }
  sign(id) { return crypto.createHmac('sha256', this.secret).update(id).digest('base64url'); }
  create() {
    const id = crypto.randomBytes(24).toString('base64url');
    this.map.set(id, this.now() + this.ttlMs);
    return `${id}.${this.sign(id)}`;
  }
  valid(cookieValue) {
    const v = String(cookieValue || ''); const i = v.indexOf('.');
    if (i < 1) return false;
    const id = v.slice(0, i);
    if (!safeEqual(v.slice(i + 1), this.sign(id))) return false;
    const exp = this.map.get(id);
    if (!exp) return false;
    if (exp <= this.now()) { this.map.delete(id); return false; }
    return true;
  }
  destroy(cookieValue) { const v = String(cookieValue || ''); this.map.delete(v.slice(0, Math.max(0, v.indexOf('.')))); }
  sweep() { const t = this.now(); for (const [k, e] of this.map) if (e <= t) this.map.delete(k); }
}

/** Failed-attempt limiter per key (client IP): after maxFailures within windowMs the key is locked for lockMs. */
class RateLimiter {
  constructor({ maxFailures = 5, windowMs = 15 * 60 * 1000, lockMs = 15 * 60 * 1000, now = Date.now } = {}) {
    Object.assign(this, { maxFailures, windowMs, lockMs, now });
    this.map = new Map();
  }
  /** Seconds until the key may try again, or 0. */
  retryAfter(key) {
    const e = this.map.get(key);
    if (!e || !e.lockedUntil) return 0;
    const left = e.lockedUntil - this.now();
    if (left <= 0) { this.map.delete(key); return 0; }
    return Math.ceil(left / 1000);
  }
  fail(key) {
    const t = this.now(); let e = this.map.get(key);
    if (!e || t - e.first > this.windowMs) e = { count: 0, first: t, lockedUntil: 0 };
    e.count += 1;
    if (e.count >= this.maxFailures) e.lockedUntil = t + this.lockMs;
    this.map.set(key, e);
    if (this.map.size > 5000) this.sweep();
  }
  success(key) { this.map.delete(key); }
  sweep() { const t = this.now(); for (const [k, e] of this.map) if (t - e.first > this.windowMs && (!e.lockedUntil || e.lockedUntil <= t)) this.map.delete(k); }
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

const isLoopback = (host) => /^(127\.\d+\.\d+\.\d+|::1|\[::1\]|localhost)$/i.test(String(host || ''));

module.exports = { COOKIE, safeEqual, loadToken, Sessions, RateLimiter, parseCookies, isLoopback };
