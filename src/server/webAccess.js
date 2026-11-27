'use strict';
// Web access control: accounts, sign-in (password + optional TOTP), first-time setup, sessions, roles and the "web*" API channels.
// Used by the headless server and by the Electron app when "Web access" is switched on (one instance serves both the HTTP
// server and the desktop window's IPC). Never loads 'electron'. Passwords, tokens and codes are never logged.
const crypto = require('crypto');
const auth = require('./auth');
const { UserStore } = require('./users');
const scope = require('./scope');

/** API channels a viewer may call: read-only, and nothing that returns secrets (settings / config files are admin only). */
const VIEWER_OK = new Set(['games', 'list', 'get', 'console', 'backups', 'backupInfo', 'eventLogQuery', 'eventLogExport', 'clusters', 'consolesList', 'logsList', 'pluginDetail', 'pluginsInfo', 'platformInfo', 'settingsDefaults', 'metricsState', 'metrics', 'discordBotStatus', 'catalogueState', 'catalogueDetail']);
/** What an operator may do on top of a viewer: run servers, use consoles, make backups (not edit settings, files, configs, plugins). */
const OPERATOR_EXTRA = new Set(['start', 'stop', 'restart', 'kill', 'command', 'consoleCommand', 'consoleStart', 'consoleStop', 'logStart', 'logStop', 'backup', 'checkUpdate', 'bulk']);
const OPERATOR_BULK = new Set(['start', 'stop', 'restart', 'kill', 'backup']);   // bulk actions an operator may use
/** Channels only an owner may call over the web (besides every web* management call). */
const OWNER_ONLY = new Set(['steamLogin', 'steamLogout', 'relaunch', 'eventLogClear', 'discordBotTest', 'discordTest', 'discordBotRestart', 'pluginsInstallZip', 'pluginsInstallFolder', 'pluginsReload', 'catalogueInstall', 'catalogueRefresh', 'dataLocation', 'dataLocationPlan', 'dataLocationMove', 'dataLocationOpenOld']);
/** What a session that still has to set up two-factor authentication may call. */
const LIMITED_OK = new Set(['webAccount', 'webPasswordChange', 'webTotpBegin', 'webTotpConfirm', 'platformInfo']);

const err = (message, status = 400) => Object.assign(new Error(message), { status });

class WebAccess {
  /**
   * opts: { dataDir, env, token, sessionHours, idleHours, maxFailures, require2fa, audit(level, event, message, detail), now }
   */
  constructor(opts = {}) {
    this.dataDir = opts.dataDir; this.env = opts.env || process.env; this.now = opts.now || Date.now;
    this.users = new UserStore(this.dataDir, { now: this.now, maxFailures: opts.userMaxFailures || 5 });
    this.sessions = new auth.Sessions({ ttlMs: (Number(opts.sessionHours) > 0 ? Number(opts.sessionHours) : 12) * 3600 * 1000, idleMs: (Number(opts.idleHours) > 0 ? Number(opts.idleHours) : 4) * 3600 * 1000, now: this.now });
    this.limiter = new auth.RateLimiter({ maxFailures: opts.maxFailures || 5, now: this.now });
    this.tok = opts.token ? { token: opts.token, source: 'env' } : auth.loadToken(this.dataDir, this.env);
    this.require2fa = !!opts.require2fa;
    this.challenges = new Map();   // challenge id -> { user, exp, tries }
    this.auditFn = typeof opts.audit === 'function' ? opts.audit : () => {};
  }
  audit(level, event, message, detail) { try { this.auditFn(level, event, message, detail || {}); } catch { /* logging must never break a login */ } }
  get token() { return this.tok.token; }
  get tokenSource() { return this.tok.source; }
  get hasAccounts() { return this.users.has(); }
  /** True when the shared access token may sign in / call the API: only while no account exists (first-time setup). */
  tokenLoginOpen() { return !this.users.has(); }
  setRequire2fa(v) { this.require2fa = !!v; }
  tokenOk(t) { return typeof t === 'string' && auth.safeEqual(t.trim(), this.tok.token); }

  sweep() { this.sessions.sweep(); this.limiter.sweep(); const t = this.now(); for (const [k, c] of this.challenges) if (c.exp <= t) this.challenges.delete(k); }

  newSession(user, meta) {
    const limited = !!(this.require2fa && !this.users.needsSecondFactor(user));
    return { ok: true, cookie: this.sessions.create({ user: user.username, role: user.role, ip: meta.ip, ua: meta.ua, limited }), limited, user: this.users.pub(user) };
  }

  /** Token sign-in (only while there are no accounts). Returns { ok, cookie } or { ok:false, status, error, retryAfter }. */
  tokenLogin(token, meta) {
    if (!this.tokenLoginOpen()) return { ok: false, status: 403, error: 'Sign in with your username and password.' };
    const wait = this.limiter.retryAfter(meta.ip); if (wait) return { ok: false, status: 429, retryAfter: wait, error: `Too many failed attempts. Try again in ${wait} s.` };
    if (!this.tokenOk(token)) {
      this.limiter.fail(meta.ip); this.audit('warn', 'web:login-failed', 'Web sign-in failed (wrong token)', { ip: meta.ip });
      const w2 = this.limiter.retryAfter(meta.ip);
      return { ok: false, status: w2 ? 429 : 401, retryAfter: w2, error: w2 ? `Too many failed attempts. Try again in ${w2} s.` : 'Wrong token' };
    }
    this.limiter.success(meta.ip); this.audit('info', 'web:login', 'Web sign-in with the access token (no accounts yet)', { ip: meta.ip });
    return { ok: true, cookie: this.sessions.create({ user: '', role: 'owner', ip: meta.ip, ua: meta.ua }), limited: false };
  }

  /** First-time setup: the access token proves control of the machine, then the first owner account is created and signed in. */
  async setup({ token, username, password }, meta) {
    if (this.users.has()) return { ok: false, status: 403, error: 'Setup is already done. Sign in with your account.' };
    const wait = this.limiter.retryAfter(meta.ip); if (wait) return { ok: false, status: 429, retryAfter: wait, error: `Too many failed attempts. Try again in ${wait} s.` };
    if (!this.tokenOk(token)) { this.limiter.fail(meta.ip); this.audit('warn', 'web:login-failed', 'Web setup refused (wrong token)', { ip: meta.ip }); return { ok: false, status: 401, error: 'Wrong access token' }; }
    try { await this.users.create({ username, password, role: 'owner' }); } catch (e) { return { ok: false, status: 400, error: e.message }; }
    this.limiter.success(meta.ip); this.audit('info', 'web:user-created', `First owner account created: ${String(username).trim()}`, { ip: meta.ip });
    return this.newSession(this.users.find(username), meta);
  }

  /** Username + password (+ code). Returns { ok, cookie } | { ok:false, need2fa, challenge } | { ok:false, status, error }. */
  async login({ username, password, code, challenge }, meta) {
    const generic = { ok: false, status: 401, error: 'Wrong username or password' };
    const wait = this.limiter.retryAfter(meta.ip);
    if (wait) return { ok: false, status: 429, retryAfter: wait, error: `Too many failed attempts. Try again in ${wait} s.` };
    username = String(username || '').trim().slice(0, 64);

    if (challenge) {   // second step
      const c = this.challenges.get(String(challenge));
      if (!c || c.exp <= this.now()) { this.challenges.delete(String(challenge)); return { ok: false, status: 401, error: 'The sign-in expired. Start again.' }; }
      const u = this.users.find(c.user);
      const lock = this.users.lockedFor(c.user); if (lock) return { ok: false, status: 429, retryAfter: lock, error: `Too many failed attempts. Try again in ${lock} s.` };
      c.tries += 1;
      if (u && this.users.checkSecondFactor(u, code)) {
        this.challenges.delete(String(challenge)); this.limiter.success(meta.ip); this.users.success(u.username);
        this.audit('info', 'web:login', `Web sign-in: ${u.username}`, { ip: meta.ip, twoFactor: true });
        return this.newSession(u, meta);
      }
      this.limiter.fail(meta.ip); this.users.fail(c.user); this.audit('warn', 'web:login-failed', `Wrong two-factor code for ${c.user}`, { ip: meta.ip });
      if (c.tries >= 5) this.challenges.delete(String(challenge));
      return { ok: false, status: 401, error: 'Wrong code' };
    }

    if (!username || typeof password !== 'string') return generic;
    const lock = this.users.lockedFor(username);
    if (lock) { this.audit('warn', 'web:login-blocked', `Sign-in refused, account locked: ${username}`, { ip: meta.ip }); return { ok: false, status: 429, retryAfter: lock, error: `Too many failed attempts. Try again in ${lock} s.` }; }
    const u = await this.users.verifyPassword(username, password);
    if (!u) {
      this.limiter.fail(meta.ip); this.users.fail(username);
      this.audit('warn', 'web:login-failed', `Web sign-in failed for "${username.replace(/[^\w.@-]/g, '?').slice(0, 40)}"`, { ip: meta.ip });
      const w2 = this.limiter.retryAfter(meta.ip) || this.users.lockedFor(username);
      return w2 ? { ok: false, status: 429, retryAfter: w2, error: `Too many failed attempts. Try again in ${w2} s.` } : generic;
    }
    if (this.users.needsSecondFactor(u)) {
      const id = crypto.randomBytes(24).toString('base64url');
      this.challenges.set(id, { user: u.username, exp: this.now() + 5 * 60 * 1000, tries: 0 });
      return { ok: false, need2fa: true, challenge: id };
    }
    this.limiter.success(meta.ip); this.users.success(u.username);
    this.audit('info', 'web:login', `Web sign-in: ${u.username}`, { ip: meta.ip, twoFactor: false });
    return this.newSession(u, meta);
  }

  logout(cookie) { const s = this.sessions.get(cookie); if (s) this.audit('info', 'web:logout', `Web sign-out: ${s.user || 'token'}`, { ip: s.ip }); this.sessions.destroy(cookie); }

  /** Role gate for a normal API channel. actor = { local, role, limited }. Throws an Error with .status 403. */
  authorize(name, actor, args = []) {
    if (actor.local) return;
    if (actor.limited && !LIMITED_OK.has(name)) throw err('Two-factor authentication must be set up first (open the account page).', 403);
    if (name.startsWith('web')) return;   // checked inside api()
    if (actor.role === 'owner') return;
    if (OWNER_ONLY.has(name)) throw err('Only an owner can do this.', 403);
    if (actor.role === 'viewer' && !VIEWER_OK.has(name)) throw err('Your account is read-only (viewer).', 403);
    if (actor.role === 'operator') {
      if (!VIEWER_OK.has(name) && !OPERATOR_EXTRA.has(name)) throw err('Operators can run servers, use consoles and make backups, but not change settings, files or plugins.', 403);
      if (name === 'bulk' && !OPERATOR_BULK.has(String(args[0]))) throw err('Operators can start, stop, restart, kill and back up servers in bulk, nothing else.', 403);
    }
    if (actor.role === 'admin' || actor.role === 'owner') return;
    scope.check(name, args, this.scopeFor(actor));
  }

  /** The servers an account may use: a Set of ids, or null for all (owners, admins, the desktop window, the access token). */
  scopeFor(actor) { return actor.local || !actor.user || actor.role === 'owner' || actor.role === 'admin' ? null : this.users.scopeOf(actor.user); }
  /** Throws 403 when the call names a server this account may not use (limited accounts only). */
  checkScope(name, args, actor) { scope.check(name, args, this.scopeFor(actor)); }
  /** Remove other servers from a channel's result (limited accounts only). */
  scopeResult(name, data, actor) { return scope.filterResult(name, data, this.scopeFor(actor)); }
  scopePush(ch, payload, actor) { return scope.filterPush(ch, payload, this.scopeFor(actor)); }

  /** The web* channels for one caller. actor = { local, user, role, cookie, limited }. */
  api(actor) {
    const owner = actor.local || actor.role === 'owner';
    const needOwner = () => { if (!owner) throw err('Only an owner can manage web access.', 403); };
    const self = () => { if (actor.local || !actor.user) throw err('This is for signed-in web accounts. Use the account page in the browser.'); return actor.user; };
    const sessionsOf = (all) => this.sessions.list(all ? undefined : actor.user).map((s) => ({ ...s, current: !!actor.cookie && s.handle === this.handleOf(actor.cookie) }));
    return {
      webStatus: () => ({ accounts: this.users.has(), setupNeeded: !this.users.has(), user: actor.local ? '' : actor.user || '', role: actor.local ? 'owner' : actor.role, local: !!actor.local, require2fa: this.require2fa, limited: !!actor.limited }),
      webAccount: () => { const u = this.users.find(self()); if (!u) throw err('Unknown account.'); return { ...this.users.pub(u), require2fa: this.require2fa, limited: !!actor.limited }; },
      webUsers: () => { needOwner(); return this.users.list(); },
      webUserCreate: async (username, password, role, servers) => { needOwner(); const u = await this.users.create({ username, password, role, servers }); this.audit('info', 'web:user-created', `Account created: ${u.username} (${u.role})`, { by: actor.user || 'desktop' }); return u; },
      webUserServers: (username, servers) => { needOwner(); this.users.setServers(username, servers); this.sessions.revoke({ user: this.users.find(username).username }); this.audit('warn', 'web:user-servers', 'Server access changed for ' + username + ': ' + (servers ? servers.length + ' server(s)' : 'all servers'), { by: actor.user || 'desktop' }); return this.users.list(); },
      // two-factor enrolment of ANY account by the owner (the desktop window shows the secret to scan / type into the authenticator app; the account holder confirms with a code)
      webUserTotpBegin: (username) => { needOwner(); const u = this.users.find(username); if (!u) throw err('No such user.'); return this.users.beginTotp(u.username); },
      webUserTotpConfirm: (username, code) => { needOwner(); const u = this.users.find(username); if (!u) throw err('No such user.'); const codes = this.users.confirmTotp(u.username, code); this.sessions.revoke({ user: u.username }); this.audit('info', 'web:2fa-on', 'Two-factor authentication set up for ' + u.username + ' by an owner', { by: actor.user || 'desktop' }); return { recoveryCodes: codes }; },
      webUserRole: (username, role) => { needOwner(); this.users.setRole(username, role); this.sessions.revoke({ user: this.users.find(username).username }); this.audit('warn', 'web:user-role', `Role changed: ${username} -> ${role}`, { by: actor.user || 'desktop' }); return this.users.list(); },
      webUserPassword: async (username, password) => { needOwner(); await this.users.setPassword(username, password); this.sessions.revoke({ user: this.users.find(username).username }); this.audit('warn', 'web:password-reset', `Password reset for ${username}`, { by: actor.user || 'desktop' }); return true; },
      webUserTotpOff: (username) => { needOwner(); this.users.disableTotp(username); this.sessions.revoke({ user: this.users.find(username).username }); this.audit('warn', 'web:2fa-off', `Two-factor authentication removed for ${username}`, { by: actor.user || 'desktop' }); return this.users.list(); },
      webUserDelete: (username) => { needOwner(); const u = this.users.find(username); this.users.remove(username); if (u) this.sessions.revoke({ user: u.username }); this.audit('warn', 'web:user-deleted', `Account deleted: ${username}`, { by: actor.user || 'desktop' }); return this.users.list(); },
      webSessions: () => (owner ? sessionsOf(true) : sessionsOf(false)),
      webSessionRevoke: (handle) => { const mine = this.sessions.list(owner ? undefined : actor.user).some((s) => s.handle === handle); if (!mine) throw err('No such session.'); const n = this.sessions.revoke({ handle }); this.audit('info', 'web:session-revoked', 'A web session was revoked', { by: actor.user || 'desktop' }); return n; },
      webSignOutOthers: () => { const n = this.sessions.revoke({ user: self(), exceptCookie: actor.cookie }); this.audit('info', 'web:session-revoked', `${n} other session(s) of ${actor.user} signed out`, {}); return n; },
      webPasswordChange: async (oldPassword, newPassword) => {
        const name = self(); const lock = this.users.lockedFor(name); if (lock) throw err(`Too many failed attempts. Try again in ${lock} s.`, 429);
        if (!(await this.users.verifyPassword(name, oldPassword))) { this.users.fail(name); throw err('The current password is wrong.'); }
        await this.users.setPassword(name, newPassword); this.sessions.revoke({ user: name, exceptCookie: actor.cookie });
        this.audit('info', 'web:password-changed', `${name} changed the password`, {}); return true;
      },
      webTotpBegin: () => this.users.beginTotp(self()),
      webTotpConfirm: (code) => { const name = self(); const codes = this.users.confirmTotp(name, code); this.sessions.revoke({ user: name, exceptCookie: actor.cookie }); if (actor.cookie) { const s = this.sessions.get(actor.cookie); if (s) s.limited = false; } this.audit('info', 'web:2fa-on', `${name} turned on two-factor authentication`, {}); return codes; },
      webTotpDisable: async (password) => {
        const name = self(); if (this.require2fa) throw err('Two-factor authentication is required by the owner and cannot be turned off.', 403);
        if (!(await this.users.verifyPassword(name, password))) { this.users.fail(name); throw err('The password is wrong.'); }
        this.users.disableTotp(name); this.audit('warn', 'web:2fa-off', `${name} turned off two-factor authentication`, {}); return true;
      },
      // the shared access token: shown only in the desktop window; regenerating it is owner only
      webTokenInfo: () => { if (!actor.local) throw err('The access token is shown in the desktop app or in <data>/web-token.', 403); return { token: this.tok.token, source: this.tok.source, usable: this.tokenLoginOpen() }; },
      webTokenRegenerate: () => {
        needOwner(); if (this.tok.source === 'env') throw err('The token comes from NODEGSM_TOKEN; change it there.');
        const fs = require('fs'); const path = require('path'); const token = crypto.randomBytes(24).toString('base64url');
        fs.writeFileSync(path.join(this.dataDir, 'web-token'), token + '\n', { mode: 0o600 }); this.tok = { token, source: 'file' };
        this.audit('warn', 'web:token-regenerated', 'The access token was regenerated', { by: actor.user || 'desktop' }); return actor.local ? { token } : true;
      },
    };
  }
  handleOf(cookie) { const s = this.sessions.get(cookie); if (!s) return ''; return crypto.createHash('sha256').update(s.id).digest('hex').slice(0, 16); }
  get webChannels() { return Object.keys(this.api({ local: true })); }
}

module.exports = { WebAccess, VIEWER_OK, OWNER_ONLY, LIMITED_OK, OPERATOR_EXTRA };
