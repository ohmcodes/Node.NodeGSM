'use strict';
// Web access accounts: <data>/web-users.json (mode 0600). Passwords are scrypt hashes (never stored or logged in clear),
// optional TOTP second factor with one-time recovery codes. Roles: owner > admin > viewer.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const totp = require('./totp');

const ROLES = ['owner', 'admin', 'viewer'];
const USERNAME = /^[a-z0-9][a-z0-9._-]{2,31}$/i;
const MIN_PASSWORD = 10;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

const scrypt = (pw, salt, o = SCRYPT) => new Promise((res, rej) => crypto.scrypt(pw, salt, o.keylen, { N: o.N, r: o.r, p: o.p, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))));

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const k = await scrypt(pw, salt);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${k.toString('base64')}`;
}
async function checkPassword(pw, stored) {
  const parts = String(stored || '').split('$');
  if (parts[0] !== 'scrypt' || parts.length !== 6) return false;
  const [, N, r, p, salt, hash] = parts;
  const want = Buffer.from(hash, 'base64');
  const got = await scrypt(pw, Buffer.from(salt, 'base64'), { N: +N, r: +r, p: +p, keylen: want.length });
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function passwordProblem(pw, username) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) return `The password needs at least ${MIN_PASSWORD} characters.`;
  if (pw.length > 200) return 'The password is too long (200 characters max).';
  if (username && pw.toLowerCase() === String(username).toLowerCase()) return 'The password must not be the username.';
  if (/^(.)\1+$/.test(pw)) return 'The password is too simple.';
  return '';
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const newRecoveryCodes = () => Array.from({ length: 8 }, () => { const b = crypto.randomBytes(5).toString('hex'); return `${b.slice(0, 5)}-${b.slice(5)}`; });

class UserStore {
  constructor(dataDir, { now = Date.now, maxFailures = 5, lockMs = 15 * 60 * 1000 } = {}) {
    this.file = path.join(dataDir, 'web-users.json');
    this.now = now; this.maxFailures = maxFailures; this.lockMs = lockMs;
    this.users = []; this.pending = new Map();   // pending TOTP enrolment: username -> secret
    this.fails = new Map();                      // username -> { count, lockedUntil }
    this.dummy = null;
    try { const j = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (Array.isArray(j.users)) this.users = j.users.filter((u) => u && USERNAME.test(u.username) && ROLES.includes(u.role) && u.pw); } catch { /* none yet */ }
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, users: this.users }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch { /* Windows: the user's own folder ACLs apply */ }
  }
  has() { return this.users.length > 0; }
  find(username) { const k = String(username || '').toLowerCase(); return this.users.find((u) => u.username.toLowerCase() === k) || null; }
  pub(u) { return { username: u.username, role: u.role, totp: !!(u.totp && u.totp.enabled), recoveryLeft: u.totp && u.totp.enabled ? (u.totp.recovery || []).length : 0, createdAt: u.createdAt, lastLogin: u.lastLogin || 0 }; }
  list() { return this.users.map((u) => this.pub(u)); }
  owners() { return this.users.filter((u) => u.role === 'owner'); }

  async create({ username, password, role = 'viewer' }) {
    username = String(username || '').trim();
    if (!USERNAME.test(username)) throw new Error('Username: 3-32 characters (letters, digits, dot, dash, underscore), starting with a letter or digit.');
    if (!ROLES.includes(role)) throw new Error('Unknown role.');
    const bad = passwordProblem(password, username); if (bad) throw new Error(bad);
    if (this.find(username)) throw new Error('That username already exists.');
    this.users.push({ username, role, pw: await hashPassword(password), totp: { enabled: false, secret: '', lastStep: 0, recovery: [] }, createdAt: this.now(), lastLogin: 0 });
    this.save(); return this.pub(this.find(username));
  }
  async setPassword(username, password) {
    const u = this.find(username); if (!u) throw new Error('No such user.');
    const bad = passwordProblem(password, u.username); if (bad) throw new Error(bad);
    u.pw = await hashPassword(password); this.fails.delete(u.username.toLowerCase()); this.save();
  }
  setRole(username, role) {
    const u = this.find(username); if (!u) throw new Error('No such user.');
    if (!ROLES.includes(role)) throw new Error('Unknown role.');
    if (u.role === 'owner' && role !== 'owner' && this.owners().length < 2) throw new Error('There must be at least one owner.');
    u.role = role; this.save();
  }
  remove(username) {
    const u = this.find(username); if (!u) throw new Error('No such user.');
    if (u.role === 'owner' && this.owners().length < 2) throw new Error('The last owner cannot be deleted.');
    this.users = this.users.filter((x) => x !== u); this.save();
  }

  /** Password check. Always does one scrypt run (also for unknown users) so timing does not reveal which usernames exist. */
  async verifyPassword(username, password) {
    const u = this.find(username);
    if (!this.dummy) this.dummy = await hashPassword('dummy-password-for-timing');
    const ok = await checkPassword(String(password || '').slice(0, 400), u ? u.pw : this.dummy);
    return ok && u ? u : null;
  }

  lockedFor(username) {
    const e = this.fails.get(String(username || '').toLowerCase()); if (!e || !e.lockedUntil) return 0;
    const left = e.lockedUntil - this.now(); if (left <= 0) { this.fails.delete(String(username).toLowerCase()); return 0; }
    return Math.ceil(left / 1000);
  }
  fail(username) {
    const k = String(username || '').toLowerCase(); if (!k || k.length > 64) return;
    const e = this.fails.get(k) || { count: 0, lockedUntil: 0 };
    e.count += 1; if (e.count >= this.maxFailures) { e.lockedUntil = this.now() + this.lockMs; e.count = 0; }
    this.fails.set(k, e);
    if (this.fails.size > 5000) for (const [x, v] of this.fails) if (!v.lockedUntil) this.fails.delete(x);
  }
  success(username) { this.fails.delete(String(username || '').toLowerCase()); const u = this.find(username); if (u) { u.lastLogin = this.now(); this.save(); } }

  // ---- second factor ----
  needsSecondFactor(u) { return !!(u.totp && u.totp.enabled); }
  /** TOTP code or a one-time recovery code. */
  checkSecondFactor(u, input) {
    const s = String(input || '').trim();
    if (u.totp && u.totp.enabled) {
      const step = totp.verify(u.totp.secret, s, { now: this.now(), lastStep: u.totp.lastStep || 0 });
      if (step) { u.totp.lastStep = step; this.save(); return true; }
      const h = sha(s.toLowerCase().replace(/\s/g, ''));
      const i = (u.totp.recovery || []).indexOf(h);
      if (i >= 0) { u.totp.recovery.splice(i, 1); this.save(); return true; }
    }
    return false;
  }
  beginTotp(username) {
    const u = this.find(username); if (!u) throw new Error('No such user.');
    if (u.totp && u.totp.enabled) throw new Error('Two-factor authentication is already on.');
    const secret = totp.newSecret(); this.pending.set(u.username, secret);
    return { secret, uri: totp.uri(secret, u.username) };
  }
  /** Confirms the enrolment with a code from the app; returns the recovery codes (shown once). */
  confirmTotp(username, codeInput) {
    const u = this.find(username); if (!u) throw new Error('No such user.');
    const secret = this.pending.get(u.username); if (!secret) throw new Error('Start the setup first.');
    const step = totp.verify(secret, codeInput, { now: this.now() });
    if (!step) throw new Error('That code is not correct. Check the clock of your phone and try again.');
    const codes = newRecoveryCodes();
    u.totp = { enabled: true, secret, lastStep: step, recovery: codes.map((c) => sha(c)) };
    this.pending.delete(u.username); this.save(); return codes;
  }
  disableTotp(username) { const u = this.find(username); if (!u) throw new Error('No such user.'); u.totp = { enabled: false, secret: '', lastStep: 0, recovery: [] }; this.pending.delete(u.username); this.save(); }
}

module.exports = { UserStore, ROLES, USERNAME, MIN_PASSWORD, hashPassword, checkPassword, passwordProblem };
