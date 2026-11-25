'use strict';
// Files auto-clear: deletes old files by folder / file-name pattern / age on a per-server schedule.
//   rules live in the server's wgsm.json:  autoClear: [{ path, pattern, olderThanDays, intervalMin, enabled, recursive, onlyWhenStopped, lastRun }]
//   plugin files.autoClear entries are copied once per server (seeded); the user may then edit, disable or delete them and plugin updates never overwrite those edits.
// Safety: files only (folders are never removed), links are never followed, every path is confined to the server's files folder
// (safeRel + inside + realpath), locked files are skipped, dry runs never touch the disk.
// The scheduler (mgr.startScheduler) calls tick() every minute.
const fs = require('fs');
const path = require('path');
const { safeRel, inside, realInside } = require('./backup');
const { globToRegex } = require('../logTail');
const { sanitizeAutoClear, sanitizeAutoClearRule } = require('../settings');

const LOCK_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
const WIN = process.platform === 'win32';
const norm = (p) => (WIN ? p.toLowerCase() : p);
const MAX_FILES_PER_RUN = 200000;
const ruleKey = (r) => `${String(r.path).replace(/\\/g, '/').toLowerCase()}|${r.pattern || '*'}`;

class AutoClear {
  /**
   * @param {import('../serverManager').ServerManager} mgr  server manager (mgr.events emits server:* events)
   * @param {object} plugins  the plugins module (GAMES, byId, ...)
   * @param {object} settings app settings snapshot (mgr.settings is the live object)
   * @param {string} dataDir  NodeGSM data folder
   */
  constructor(mgr, plugins, settings, dataDir) {
    this.mgr = mgr; this.plugins = plugins; this.settings = settings; this.dataDir = dataDir;
    this.started = false; this.running = new Set(); this.memLast = new Map();   // "<server>|<ruleKey>" -> lastRun ms (in memory, also persisted in the rule)
    mgr._autoClear = this;
  }

  /** Scheduling is driven by mgr.startScheduler() -> tick(); nothing to subscribe to. Safe to call once. */
  start() { this.started = true; }
  stop() { this.started = false; }

  log(level, serverId, message, detail) {
    try { if (this.mgr.eventLog) this.mgr.eventLog.log({ level, event: 'autoclear:run', serverId, message, detail }); } catch { /* logging never breaks an action */ }
  }

  need(id) { const c = this.mgr.getConfig(id); if (!c) throw new Error('Server not found'); return c; }
  game(c) { return this.plugins.byId(c.game); }

  /** Copy plugin rules that were never seeded for this server. Returns the (possibly updated) config. Seeded rules start their interval now. */
  seed(id, now = Date.now()) {
    const c = this.need(id); const g = this.game(c);
    if (!g || !g.autoClear || !g.autoClear.length) return c;
    const seeded = new Set(c.autoClearSeeded || []);
    const rules = sanitizeAutoClear(c.autoClear, false);
    const add = [];
    for (const p of g.autoClear) {
      let r; try { r = sanitizeAutoClearRule({ ...p, enabled: p.default === true, lastRun: now }); } catch { continue; }
      const k = ruleKey(r);
      if (seeded.has(k)) continue;
      seeded.add(k);
      if (!rules.some((x) => ruleKey(x) === k)) add.push(r);
    }
    if (!add.length && seeded.size === (c.autoClearSeeded || []).length) return c;
    return this.mgr.saveConfig(id, { autoClear: [...rules, ...add], autoClearSeeded: [...seeded] });
  }

  /** The server's rules with schedule info: [{ ...rule, index, fromPlugin, nextRun }] */
  list(id) {
    const c = this.seed(id); const g = this.game(c);
    const pk = new Set(((g && g.autoClear) || []).map((p) => { try { return ruleKey(sanitizeAutoClearRule(p)); } catch { return ''; } }));
    return sanitizeAutoClear(c.autoClear, false).map((r, index) => ({ ...r, index, fromPlugin: pk.has(ruleKey(r)), nextRun: r.enabled ? (r.lastRun ? r.lastRun + r.intervalMin * 60000 : Date.now()) : null }));
  }

  /** Replace the rule list (strict validation). Keeps lastRun of rules whose folder + pattern did not change. */
  save(id, rules) {
    const c = this.need(id);
    const next = sanitizeAutoClear(rules, true);
    const old = new Map(sanitizeAutoClear(c.autoClear, false).map((r) => [ruleKey(r), r]));
    for (const r of next) { const o = old.get(ruleKey(r)); if (o && !r.lastRun) r.lastRun = o.lastRun; }
    this.mgr.saveConfig(id, { autoClear: next });
    this.log('info', id, `Auto-clear rules saved (${next.length} rule${next.length === 1 ? '' : 's'}) for ${c.name}`, { rules: next.length });
    return this.list(id);
  }

  /** Files matching one rule. Confined to the server's files folder, links never followed. */
  scan(id, rule, now = Date.now()) {
    const rootRaw = this.mgr.filesDir(id);
    const res = { path: rule.path, pattern: rule.pattern || '*', exists: false, files: [], bytes: 0, error: null };
    let root; try { root = fs.realpathSync(rootRaw); } catch { return res; }
    let abs;
    try {
      abs = inside(root, safeRel(String(rule.path)));
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) throw new Error('is a link, not followed');
      if (!st.isDirectory()) throw new Error('is not a folder');
      if (!realInside(root, abs)) throw new Error('leaves the server folder');
      res.exists = true;
    } catch (e) { if (e.code !== 'ENOENT') res.error = e.message; return res; }
    const re = globToRegex(String(rule.pattern || '*'));
    const minAge = (Number(rule.olderThanDays) || 0) * 86400000;
    const walk = (dir, depth) => {
      let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (res.files.length >= MAX_FILES_PER_RUN) return;
        const p = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) { if (rule.recursive && depth < 32) walk(p, depth + 1); continue; }
        if (!e.isFile() || !re.test(e.name)) continue;
        let st; try { st = fs.lstatSync(p); } catch { continue; }
        if (minAge && now - st.mtimeMs < minAge) continue;
        res.files.push({ abs: p, rel: path.relative(root, p).split(path.sep).join('/'), size: st.size });
        res.bytes += st.size;
      }
    };
    walk(abs, 0);
    return res;
  }

  /** Run (or preview) one rule. Returns { index, path, pattern, dryRun, matched, bytes, deleted, freed, locked, errors[], sample[] }. */
  runRule(id, rule, index, { dryRun = false, now = Date.now(), quiet = false } = {}) {
    const c = this.need(id);
    const scan = this.scan(id, rule, now);
    const out = { index, path: rule.path, pattern: rule.pattern || '*', olderThanDays: rule.olderThanDays, dryRun, exists: scan.exists, matched: scan.files.length, bytes: scan.bytes, deleted: 0, freed: 0, locked: 0, errors: [], sample: scan.files.slice(0, 20).map((f) => f.rel) };
    if (scan.error) out.errors.push(`${rule.path}: ${scan.error}`);
    if (dryRun) return out;
    for (const f of scan.files) {
      try {
        const st = fs.lstatSync(f.abs);
        if (st.isSymbolicLink() || !st.isFile()) continue;
        fs.unlinkSync(f.abs); out.deleted++; out.freed += st.size;
      } catch (e) { if (LOCK_CODES.has(e.code)) out.locked++; else if (e.code !== 'ENOENT') out.errors.push(`${f.rel}: ${e.code || e.message}`); }
    }
    this.markRun(id, rule, now);
    if (!quiet || out.deleted || out.errors.length) {
      this.log(out.errors.length ? 'warn' : 'info', id, `Auto-clear on ${c.name}: ${out.deleted} file${out.deleted === 1 ? '' : 's'} deleted from ${rule.path} (${rule.pattern || '*'}), ${out.freed} bytes freed${out.locked ? `, ${out.locked} locked and skipped` : ''}`, { path: rule.path, pattern: rule.pattern || '*', deleted: out.deleted, bytes: out.freed, locked: out.locked, errors: out.errors.length });
    }
    if (out.deleted || out.locked || out.errors.length || !quiet) this.mgr.emitEvent('server:autoclear', id, { path: rule.path, pattern: rule.pattern || '*', deleted: out.deleted, bytes: out.freed, locked: out.locked });
    return out;
  }

  markRun(id, rule, now) {
    this.memLast.set(`${id}|${ruleKey(rule)}`, now);
    try {
      const c = this.mgr.getConfig(id); const rules = sanitizeAutoClear(c.autoClear, false); const k = ruleKey(rule);
      const r = rules.find((x) => ruleKey(x) === k); if (!r) return;
      r.lastRun = now; this.mgr.saveConfig(id, { autoClear: rules });
    } catch { /* the persisted lastRun is a convenience */ }
  }

  /** IPC: run now / preview. ruleIndex undefined = every enabled rule; a given index runs that rule even when it is disabled. */
  run(id, ruleIndex, dryRun = false, now = Date.now()) {
    id = String(id); const c = this.seed(id);
    const rules = sanitizeAutoClear(c.autoClear, false);
    let todo;
    if (ruleIndex === undefined || ruleIndex === null || ruleIndex === '') todo = rules.map((r, i) => [r, i]).filter(([r]) => r.enabled);
    else { const i = Math.floor(Number(ruleIndex)); if (!rules[i]) throw new Error('Rule not found'); todo = [[rules[i], i]]; }
    if (this.running.has(id)) throw new Error('Auto-clear is already running for this server');
    this.running.add(id);
    try {
      const results = todo.map(([r, i]) => this.runRule(id, r, i, { dryRun: !!dryRun, now }));
      return { id, dryRun: !!dryRun, results, matched: results.reduce((n, r) => n + r.matched, 0), deleted: results.reduce((n, r) => n + r.deleted, 0), freed: results.reduce((n, r) => n + r.freed, 0), locked: results.reduce((n, r) => n + r.locked, 0) };
    } finally { this.running.delete(id); }
  }

  /** Scheduler entry (every minute): runs the enabled rules that are due. Returns [{ id, ruleIndex, result }]. */
  tick(now = Date.now()) {
    const done = [];
    let ids = []; try { ids = this.mgr.ids(); } catch { return done; }
    for (const id of ids) {
      try {
        const c = this.seed(id, now);
        const rt = this.mgr.runtime.get(String(id));
        if (rt && rt.busy) continue;                               // installing / updating / backing up: leave the files alone
        if (this.running.has(id)) continue;
        const running = this.mgr.isRunning(id);
        const rules = sanitizeAutoClear(c.autoClear, false);
        rules.forEach((r, i) => {
          if (!r.enabled || (r.onlyWhenStopped && running)) return;
          const last = Math.max(r.lastRun || 0, this.memLast.get(`${id}|${ruleKey(r)}`) || 0);
          if (last && now - last < r.intervalMin * 60000) return;
          this.running.add(id);
          try { done.push({ id, ruleIndex: i, result: this.runRule(id, r, i, { now, quiet: true }) }); }
          catch (e) { this.log('error', id, `Auto-clear failed: ${e.message}`, {}); }
          finally { this.running.delete(id); }
        });
      } catch { /* one broken server never stops the others */ }
    }
    return done;
  }
}

module.exports = { AutoClear, ruleKey };
