'use strict';
// NGSM event log: records server events (start/stop/crash/update/backup/restore/commands/config edits) as daily rotated JSONL
// under <data>/logs/ngsm-YYYY-MM-DD.log, with retention (settings.logging.retentionDays).
// Other services (backup, cluster, discord bot, auto-clear) record their own entries through log(entry).
const fs = require('fs');
const path = require('path');
const { resolveLog, decode } = require('../logTail');

const LEVELS = ['info', 'warn', 'error'];
const FILE_RE = /^ngsm-(\d{4}-\d{2}-\d{2})\.log$/;
const MAX_MESSAGE = 1000;
const MAX_DETAIL = 4000;
const PATTERN_COOLDOWN_MS = 10000;   // the same pattern on the same server is logged at most once per 10 s
const DAY_MS = 24 * 60 * 60 * 1000;
const SCAN_MS = 2000;                 // logging.logFiles are checked every 2 s
const SCAN_MAX_BYTES = 256 * 1024;    // at most this much new data per file per check

/** server:* bus event -> { level, message(payload) } */
const EVENT_MAP = {
  'server:started': { level: 'info', msg: (p) => `Server started${p.detail.pid ? ` (PID ${p.detail.pid})` : ''}` },
  'server:stopped': { level: 'info', msg: (p) => `Server stopped${p.detail.code != null ? ` (exit code ${p.detail.code})` : ''}` },
  'server:crashed': { level: 'error', msg: (p) => `Server stopped suddenly (crash)${p.detail.code != null ? `, exit code ${p.detail.code}` : ''}` },
  'server:restarted': { level: 'info', msg: (p) => `Server restarted (${p.detail.reason || 'manual'})` },
  'server:updated': { level: 'info', msg: (p) => `Server updated${p.detail.from ? ` ${p.detail.from} -> ${p.detail.to}` : ''}${p.detail.validate ? ' (validate)' : ''}` },
  'server:backup': { level: 'info', msg: (p) => `Backup created: ${p.detail.file || ''}${p.detail.mode ? ` (${p.detail.mode === 'neatpick' ? 'neat pick' : p.detail.mode})` : ''}` },
  'server:restore': { level: 'warn', msg: (p) => `Backup restored: ${p.detail.file || ''}${p.detail.asNew ? ' (as a new server)' : ''}` },
  'server:command': { level: 'info', msg: (p) => `Console command: ${p.detail.command}`, skip: (p) => p.detail.silent },
  'server:config': { level: 'info', msg: (p) => `Config file edited: ${p.detail.path || p.detail.config}` },
};

const pad = (n) => String(n).padStart(2, '0');
const dayOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

class EventLog {
  /**
   * @param {import('../serverManager').ServerManager} mgr  server manager (mgr.events emits server:* events)
   * @param {object} plugins  the plugins module (GAMES, byId, ...)
   * @param {object} settings app settings snapshot (mgr.settings is the live object and is read at use time)
   * @param {string} dataDir  NodeGSM data folder
   * @param {{now?: () => number}} [opts]  injectable clock (tests)
   */
  constructor(mgr, plugins, settings, dataDir, opts = {}) {
    this.mgr = mgr; this.plugins = plugins; this.dataDir = dataDir;
    this.dir = path.join(dataDir, 'logs');
    this.now = opts.now || Date.now;
    this.started = false;
    this.handlers = []; this.timer = null; this.consoleHandler = null;
    this.patternSeen = new Map();   // "<server>|<pattern>" -> last logged ms
    this.regexCache = new Map();    // game id -> [{ id, re, level }]
    this.logScan = new Map();       // "<server>|<logFiles entry>" -> { file, pos, partial } (plugin logging.logFiles scanning)
    this.scanTimer = null;
  }

  get settings() { return (this.mgr && this.mgr.settings) || {}; }
  get retentionDays() { const d = this.settings.logging && this.settings.logging.retentionDays; return d >= 1 ? d : 30; }

  /** Subscribe to server events and console lines, prune old files now and daily. Safe to call once. */
  start() {
    if (this.started) return;
    this.started = true;
    this.mgr.eventLog = this;   // other services (backup, cluster ...) write their entries through mgr.eventLog.log()
    for (const [type, def] of Object.entries(EVENT_MAP)) {
      const h = (p) => { try { if (!def.skip || !def.skip(p)) this.log({ level: def.level, event: type, serverId: p.id, serverName: p.name, message: def.msg(p), detail: p.detail }); } catch { /* never break the bus */ } };
      this.mgr.events.on(type, h); this.handlers.push([type, h]);
    }
    const rh = () => this.resetPatterns(); this.mgr.events.on('plugins:reloaded', rh); this.handlers.push(['plugins:reloaded', rh]);
    this.consoleHandler = ({ id, line }) => this.scanLine(id, line);
    this.mgr.on('console', this.consoleHandler);
    this.prune();
    this.timer = setInterval(() => this.prune(), DAY_MS);
    if (this.timer.unref) this.timer.unref();
    this.scanTimer = setInterval(() => { try { this.scanFiles(); } catch { /* never break the app */ } }, SCAN_MS);
    if (this.scanTimer.unref) this.scanTimer.unref();
  }

  /** Unsubscribe and stop timers. */
  stop() {
    if (this.mgr.eventLog === this) this.mgr.eventLog = null;
    this.started = false;
    for (const [t, h] of this.handlers) this.mgr.events.removeListener(t, h);
    this.handlers = [];
    if (this.consoleHandler) this.mgr.removeListener('console', this.consoleHandler);
    this.consoleHandler = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.scanTimer = null; this.logScan.clear();
  }

  fileFor(date) { return path.join(this.dir, `ngsm-${dayOf(date)}.log`); }

  /**
   * Append one entry. Never throws. Missing fields are filled in.
   * @param {{level?:string, event:string, serverId?:string, serverName?:string, message:string, detail?:object}} entry
   * @returns {object|null} the stored entry
   */
  log(entry) {
    try {
      const e = entry || {};
      const t = new Date(this.now());
      let serverName = e.serverName;
      if (!serverName && e.serverId != null && this.mgr && this.mgr.getConfig) { const c = this.mgr.getConfig(e.serverId); serverName = c ? c.name : ''; }
      let detail = e.detail && typeof e.detail === 'object' ? e.detail : null;
      if (detail) { try { if (JSON.stringify(detail).length > MAX_DETAIL) detail = { truncated: JSON.stringify(detail).slice(0, MAX_DETAIL) }; } catch { detail = null; } }
      const rec = {
        ts: t.toISOString(),
        level: LEVELS.includes(e.level) ? e.level : 'info',
        event: String(e.event || 'log').slice(0, 80),
        serverId: e.serverId != null ? String(e.serverId) : '',
        serverName: String(serverName || '').slice(0, 100),
        message: String(e.message == null ? '' : e.message).slice(0, MAX_MESSAGE),
        detail: detail || {},
      };
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(this.fileFor(t), JSON.stringify(rec) + '\n');
      try { this.mgr.events.emit('ngsm:log', rec); } catch { /* listener errors are not ours */ }
      return rec;
    } catch { return null; }
  }

  // ---------- plugin logging.patterns ----------
  patternsFor(gameId) {
    if (this.regexCache.has(gameId)) return this.regexCache.get(gameId);
    const g = this.plugins && this.plugins.byId ? this.plugins.byId(gameId) : null;
    const list = [];
    for (const p of (g && g.logging && g.logging.patterns) || []) {
      try { list.push({ id: p.id, re: new RegExp(p.regex, 'i'), level: LEVELS.includes(p.level) ? p.level : 'info' }); } catch { /* validated already; skip bad */ }
    }
    const events = new Set(((g && g.events) || []).map((x) => x.id));
    this.regexCache.set(gameId, { list, events });
    return this.regexCache.get(gameId);
  }
  /** Forget compiled patterns (call after plugins reload). */
  resetPatterns() { this.regexCache.clear(); }

  /** Match one console line against the plugin patterns of that server's game. Rate limited per pattern and server. */
  scanLine(id, line) {
    const c = this.mgr.getConfig(id);
    if (!c || !c.game) return;
    const { list, events } = this.patternsFor(c.game);
    if (!list.length) return;
    for (const p of list) {
      if (!p.re.test(line)) continue;
      const key = `${id}|${p.id}`; const t = this.now();
      if (t - (this.patternSeen.get(key) || 0) < PATTERN_COOLDOWN_MS) continue;
      this.patternSeen.set(key, t);
      // a pattern whose id matches a declared plugin event becomes "game:<id>" (can be sent to Discord); others stay "pattern:<id>"
      this.log({ level: p.level, event: events.has(p.id) ? `game:${p.id}` : `pattern:${p.id}`, serverId: String(id), serverName: c.name, message: String(line).slice(0, 500), detail: { pattern: p.id } });
    }
  }

  /**
   * Plugin `logging.logFiles`: read the new lines of the game's own log files (relative to the server files, newest match of a
   * "*" name) and match them with the same `logging.patterns` as console lines. Only running servers are scanned; the first look
   * at a file starts at its end (old history is not replayed), a rotated or truncated file is read from its start.
   */
  scanFiles() {
    const live = new Set();
    for (const id of this.mgr.ids()) {
      if (!this.mgr.isRunning(id)) continue;
      const c = this.mgr.getConfig(id); if (!c || !c.game) continue;
      const g = this.plugins && this.plugins.byId ? this.plugins.byId(c.game) : null;
      const files = (g && g.logging && g.logging.logFiles) || [];
      if (!files.length || !this.patternsFor(c.game).list.length) continue;
      const root = this.mgr.filesDir(id);
      for (const rel of files) {
        const key = `${id}|${rel}`; live.add(key);
        const f = resolveLog(root, rel);
        let st = this.logScan.get(key);
        if (!f) { if (st) { st.file = null; st.pos = 0; st.partial = ''; } continue; }
        let size; try { size = fs.statSync(f).size; } catch { continue; }
        if (!st) { this.logScan.set(key, { file: f, pos: size, partial: '' }); continue; }
        if (st.file !== f) { st.file = f; st.pos = 0; st.partial = ''; }
        if (size < st.pos) { st.pos = 0; st.partial = ''; }
        if (size === st.pos) continue;
        const prev = st.pos; const start = Math.max(prev, size - SCAN_MAX_BYTES);
        let fd; try { fd = fs.openSync(f, 'r'); } catch { continue; }
        let text;
        try { const buf = Buffer.alloc(size - start); fs.readSync(fd, buf, 0, buf.length, start); text = decode(buf); } catch { continue; } finally { fs.closeSync(fd); }
        st.pos = size;
        const parts = ((start === prev ? st.partial : '') + text).split(/\r?\n/);
        st.partial = parts.pop() || '';
        for (const line of parts) if (line) this.scanLine(id, line);
      }
    }
    for (const k of [...this.logScan.keys()]) if (!live.has(k)) this.logScan.delete(k);   // stopped server: look again from the end next time
  }

  // ---------- retention ----------
  files() {
    try { return fs.readdirSync(this.dir).map((f) => ({ f, m: FILE_RE.exec(f) })).filter((x) => x.m).map((x) => ({ file: path.join(this.dir, x.f), day: x.m[1] })).sort((a, b) => (a.day < b.day ? 1 : -1)); }
    catch { return []; }
  }
  /** Delete log files older than retentionDays. Returns the number removed. */
  prune() {
    const limit = dayOf(new Date(this.now() - this.retentionDays * DAY_MS));
    let n = 0;
    for (const x of this.files()) if (x.day < limit) { try { fs.unlinkSync(x.file); n++; } catch { /* in use */ } }
    return n;
  }

  // ---------- reading ----------
  /**
   * Newest first. Filters (all optional): serverId, level, event (substring), text (substring of message/server name), since (ms or ISO), limit (default 500, max 5000).
   */
  query(f = {}) {
    const limit = Math.min(Math.max(parseInt(f.limit, 10) || 500, 1), 5000);
    const since = f.since != null && f.since !== '' ? (typeof f.since === 'number' ? f.since : Date.parse(f.since)) : 0;
    const sinceDay = since ? dayOf(new Date(since)) : '';
    const text = f.text ? String(f.text).toLowerCase() : '';
    const out = [];
    for (const x of this.files()) {
      if (sinceDay && x.day < sinceDay) break;   // files are newest first
      let lines;
      try { lines = fs.readFileSync(x.file, 'utf8').split('\n'); } catch { continue; }
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i]) continue;
        let e; try { e = JSON.parse(lines[i]); } catch { continue; }
        if (f.serverId != null && f.serverId !== '' && e.serverId !== String(f.serverId)) continue;
        if (f.level && e.level !== f.level) continue;
        if (f.event && !String(e.event).includes(f.event)) continue;
        if (since && Date.parse(e.ts) < since) continue;
        if (text && !`${e.message} ${e.serverName} ${e.event}`.toLowerCase().includes(text)) continue;
        out.push(e);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  /** Plain text for download, oldest first. format 'jsonl' returns raw JSON lines. */
  export(f = {}) {
    const rows = this.query({ limit: 5000, ...f }).reverse();
    if (f.format === 'jsonl') return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
    return rows.map((r) => `${r.ts} ${r.level.toUpperCase().padEnd(5)} ${r.event}${r.serverId ? ` [#${r.serverId} ${r.serverName}]` : ''} ${r.message}`).join('\n') + (rows.length ? '\n' : '');
  }

  /** Delete every NGSM log file (crash.log is not touched). Returns the number removed. */
  clear() {
    let n = 0;
    for (const x of this.files()) { try { fs.unlinkSync(x.file); n++; } catch { /* in use */ } }
    this.log({ level: 'info', event: 'log:cleared', message: `Event log cleared (${n} file${n === 1 ? '' : 's'})` });
    return n;
  }
}

module.exports = { EventLog, EVENT_MAP, LEVELS };
