'use strict';
// Clusters: groups of same-game servers with a parent.
//   - cluster update: update the parent, then copy its game files to every member without touching configs / saves
//   - config sync: copy chosen plugin config files, keeping protected keys and NGSM:ignore lines of each member
//   - clear folders: delete old files in plugin / cluster-defined folders on all members
// Data: <data>/clusters.json { version: 1, clusters: [{ id, name, game, parentId, memberIds[], createdAt, options }] }.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { safeRel, inside, realInside } = require('./backup');
const { mergeConfig, unifiedDiff } = require('./clusterMerge');

const VERSION = 1;
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const LOCK_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
const WIN = process.platform === 'win32';
const norm = (p) => (WIN ? p.toLowerCase() : p);

const globRe = (g, anywhere) => {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') { if (g[i + 1] === '*') { re += '.*'; i++; } else re += '[^/]*'; }
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
};
/** Path patterns relative to the server files folder. A pattern with "/" or without wildcards is anchored at the root; "*.sav" matches by name anywhere. A match covers everything below it. */
function pathMatcher(patterns) {
  const list = [];
  for (const raw of patterns) {
    const s = String(raw).replace(/\\/g, '/').trim().replace(/^\/+|\/+$/g, '');
    if (s) list.push({ name: !s.includes('/') && /[*?]/.test(s), re: globRe(s) });
  }
  return (rel) => {
    const parts = rel.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join('/'); const nm = parts[i - 1];
      if (list.some((x) => x.re.test(x.name ? nm : p))) return true;
    }
    return false;
  };
}

const strList = (v, max = 50, len = 200) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, len)).slice(0, max) : []);

/** Validate / normalise per-cluster options. Throws on an invalid clear rule. */
function sanitizeOptions(o) {
  o = o && typeof o === 'object' ? o : {};
  const rules = [];
  for (const r of Array.isArray(o.clearFolders) ? o.clearFolders.slice(0, 30) : []) {
    if (!r || typeof r !== 'object') continue;
    const rule = { path: safeRel(String(r.path || '')), pattern: typeof r.pattern === 'string' && r.pattern.trim() ? r.pattern.trim().slice(0, 100) : '*' };
    const d = Number(r.olderThanDays); if (Number.isFinite(d) && d > 0) rule.olderThanDays = Math.min(d, 36500);
    if (r.recursive === true) rule.recursive = true;
    rules.push(rule);
  }
  return { protect: strList(o.protect), preserve: strList(o.preserve).map((p) => safeRel(p)), clearFolders: rules, onlyChanged: o.onlyChanged === true };
}

class Cluster {
  /**
   * @param {import('../serverManager').ServerManager} mgr  server manager (mgr.events emits server:* events)
   * @param {object} plugins  the plugins module (GAMES, byId, ...)
   * @param {object} settings app settings snapshot (mgr.settings is the live object)
   * @param {string} dataDir  NodeGSM data folder
   */
  constructor(mgr, plugins, settings, dataDir) {
    this.mgr = mgr; this.plugins = plugins; this.settings = settings; this.dataDir = dataDir;
    this.file = path.join(dataDir, 'clusters.json');
    this.started = false;
    this.ops = new Map();          // cluster id -> running operation name
    this.onProgress = null;        // (payload) => void ; main.js pushes it to the renderer as "cluster:progress"
    this.handler = null;
    this.data = this.load();
    mgr._cluster = this;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.handler = (id) => this.serverRemoved(id);
    this.mgr.on('removed', this.handler);
  }
  stop() {
    this.started = false;
    if (this.handler) { this.mgr.removeListener('removed', this.handler); this.handler = null; }
  }

  // ---------- storage ----------
  load() {
    let raw;
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch { return { version: VERSION, clusters: [] }; }
    try {
      const d = JSON.parse(raw);
      if (!d || !Array.isArray(d.clusters)) throw new Error('bad shape');
      return { version: VERSION, clusters: d.clusters.filter((c) => c && c.id && Array.isArray(c.memberIds)).map((c) => ({ ...c, id: String(c.id), memberIds: c.memberIds.map(String), parentId: String(c.parentId), options: sanitizeOptionsSafe(c.options) })) };
    } catch {
      try { fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`); } catch { /* keep */ }
      return { version: VERSION, clusters: [] };
    }
  }
  persist() {
    const tmp = `${this.file}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
  log(level, event, serverId, message, detail) {
    try { if (this.mgr.eventLog) this.mgr.eventLog.log({ level, event, serverId, message, detail }); } catch { /* logging never breaks an action */ }
  }
  emit(type, parentId, detail) { this.mgr.emitEvent(type, parentId, detail); }

  // ---------- CRUD ----------
  find(id) { return this.data.clusters.find((c) => c.id === String(id)); }
  need(id) { const c = this.find(id); if (!c) throw new Error('Cluster not found'); return c; }
  of(serverId) { return this.data.clusters.find((c) => c.memberIds.includes(String(serverId))) || null; }
  game(c) { return this.plugins.byId(c.game); }

  checkMembers(memberIds, parentId, selfId) {
    if (!Array.isArray(memberIds)) throw new Error('memberIds must be a list of server ids');
    const ids = [...new Set(memberIds.map(String))];
    if (ids.length < 2) throw new Error('A cluster needs at least 2 servers');
    let game = null;
    for (const id of ids) {
      const c = this.mgr.getConfig(id);
      if (!c) throw new Error(`Server #${id} does not exist`);
      if (game === null) game = c.game;
      else if (c.game !== game) throw new Error(`All servers of a cluster must run the same game (#${ids[0]} is ${game}, #${id} is ${c.game})`);
      const other = this.data.clusters.find((x) => x.id !== selfId && x.memberIds.includes(id));
      if (other) throw new Error(`Server #${id} (${c.name}) is already in the cluster "${other.name}". A server can belong to only one cluster`);
    }
    if (!this.plugins.byId(game)) throw new Error(`The game plugin "${game}" is not installed`);
    const parent = parentId === undefined || parentId === null || parentId === '' ? ids[0] : String(parentId);
    if (!ids.includes(parent)) throw new Error('The parent server must be a member of the cluster');
    return { ids, game, parent };
  }
  checkName(name, fallback) {
    const n = String(name == null || String(name).trim() === '' ? fallback : name).trim().slice(0, 60);
    if (!n) throw new Error('The cluster needs a name');
    return n;
  }

  create({ name, memberIds, parentId, options } = {}) {
    const { ids, game, parent } = this.checkMembers(memberIds, parentId, null);
    const g = this.plugins.byId(game);
    let n = 1; while (this.find(String(n))) n++;
    const c = { id: String(n), name: this.checkName(name, `${g.name} cluster`), game, parentId: parent, memberIds: ids, createdAt: new Date().toISOString(), options: sanitizeOptions(options) };
    this.data.clusters.push(c); this.persist();
    this.log('info', 'cluster:created', parent, `Cluster "${c.name}" created (${ids.length} servers, parent #${parent})`, { clusterId: c.id, memberIds: ids });
    this.emit('cluster:created', parent, { clusterId: c.id, clusterName: c.name, memberIds: ids });
    return this.view(c);
  }

  /** patch: { name?, parentId?, memberIds?, options? }. Returns the cluster view. */
  save(id, patch = {}) {
    const c = this.need(id);
    if (this.ops.has(c.id)) throw new Error(`The cluster is busy (${this.ops.get(c.id)})`);
    const next = { ...c };
    if (patch.name !== undefined) next.name = this.checkName(patch.name, c.name);
    if (patch.memberIds !== undefined || patch.parentId !== undefined) {
      const members = patch.memberIds !== undefined ? patch.memberIds : c.memberIds;
      const { ids, parent } = this.checkMembers(members, patch.parentId !== undefined ? patch.parentId : (members.map(String).includes(c.parentId) ? c.parentId : undefined), c.id);
      if (ids.length && this.mgr.getConfig(ids[0]).game !== c.game) throw new Error('The game of a cluster cannot change');
      next.memberIds = ids; next.parentId = parent;
    }
    if (patch.options !== undefined) next.options = sanitizeOptions({ ...c.options, ...patch.options });
    Object.assign(c, next); this.persist();
    this.log('info', 'cluster:saved', c.parentId, `Cluster "${c.name}" changed`, { clusterId: c.id, memberIds: c.memberIds, parentId: c.parentId });
    return this.view(c);
  }
  rename(id, name) { return this.save(id, { name }); }
  setParent(id, parentId) { return this.save(id, { parentId }); }
  addMember(id, serverId) { const c = this.need(id); return this.save(id, { memberIds: [...c.memberIds, String(serverId)] }); }
  removeMember(id, serverId) { const c = this.need(id); return this.save(id, { memberIds: c.memberIds.filter((m) => m !== String(serverId)) }); }

  /** Deletes the cluster record only; servers and their files are never touched. */
  delete(id) {
    const c = this.need(id);
    if (this.ops.has(c.id)) throw new Error(`The cluster is busy (${this.ops.get(c.id)})`);
    this.data.clusters = this.data.clusters.filter((x) => x !== c); this.persist();
    this.log('info', 'cluster:deleted', c.parentId, `Cluster "${c.name}" deleted (the servers are untouched)`, { clusterId: c.id });
    this.emit('cluster:deleted', c.parentId, { clusterId: c.id, clusterName: c.name });
    return true;
  }

  /** A server was deleted: drop it from its cluster; a cluster with fewer than 2 servers is dissolved, a deleted parent is replaced by the first remaining member. */
  serverRemoved(serverId) {
    serverId = String(serverId);
    let changed = false;
    for (const c of [...this.data.clusters]) {
      if (!c.memberIds.includes(serverId)) continue;
      changed = true;
      c.memberIds = c.memberIds.filter((m) => m !== serverId);
      if (c.memberIds.length < 2) {
        this.data.clusters = this.data.clusters.filter((x) => x !== c);
        this.log('warn', 'cluster:dissolved', serverId, `Cluster "${c.name}" removed: server #${serverId} was deleted and fewer than 2 servers are left`, { clusterId: c.id });
        this.emit('cluster:deleted', serverId, { clusterId: c.id, clusterName: c.name, reason: 'member-removed' });
      } else {
        const wasParent = c.parentId === serverId;
        if (wasParent) c.parentId = c.memberIds[0];
        this.log('warn', 'cluster:member-removed', serverId, `Server #${serverId} was deleted and left the cluster "${c.name}"${wasParent ? `; the new parent is #${c.parentId}` : ''}`, { clusterId: c.id, parentId: c.parentId });
      }
    }
    if (changed) this.persist();
  }

  // ---------- views ----------
  effective(c) {
    const g = this.game(c);
    return {
      preserve: g ? this.preserveList(g, c) : [],
      protectedKeys: g ? [...new Set([...g.cluster.protectedConfigKeys, ...c.options.protect])] : [],
      clearRules: g ? this.clearRules(g, c) : [],
    };
  }
  view(c) {
    const g = this.game(c);
    const members = c.memberIds.map((id) => { const v = this.mgr.getConfig(id) ? this.mgr.view(id) : null; return { id, name: v ? v.name : '(deleted)', port: v ? v.port : '', status: v ? v.status : 'Missing', missing: !v, isParent: id === c.parentId }; });
    return {
      ...c, gameName: g ? g.name : c.game, pluginMissing: !g, members, busy: this.ops.get(c.id) || null,
      parentName: (members.find((m) => m.isParent) || {}).name || '',
      configs: g ? g.configs.map((d) => ({ id: d.id, name: d.name, path: d.path, format: d.format || 'text', protect: d.protect || [] })) : [],
      ...this.effective(c),
      validateSupported: !!(g && (g.appId || g.hooks.latest)),
    };
  }
  list() { return this.data.clusters.map((c) => this.view(c)); }
  get(id) { return this.view(this.need(id)); }

  // ---------- operation guard / progress ----------
  begin(c, op) {
    if (this.ops.has(c.id)) throw new Error(`The cluster is already busy (${this.ops.get(c.id)})`);
    this.ops.set(c.id, op);
  }
  end(c) { this.ops.delete(c.id); }
  progress(p) { try { if (this.onProgress) this.onProgress(p); } catch { /* the UI is optional */ } }
  /** Members other than the parent (config sync / update targets). Optional subset. */
  targets(c, only) {
    const sel = Array.isArray(only) && only.length ? new Set(only.map(String)) : null;
    const t = c.memberIds.filter((id) => id !== c.parentId && (!sel || sel.has(id)));
    for (const id of t) if (!this.mgr.getConfig(id)) throw new Error(`Server #${id} does not exist any more`);
    return t;
  }
  name(id) { const v = this.mgr.getConfig(id); return v ? v.name : `#${id}`; }

  // ================= 1. cluster update =================
  preserveList(g, c) {
    const cfg = g.configs.flatMap((d) => [d.path, `${d.path}.bak`]);
    return [...new Set([...cfg, ...g.cluster.preserve, ...c.options.preserve, 'configs/wgsm.json', '__nodegsm'])];
  }

  /** Walk the parent's files and decide, for one member, what would be copied. Never follows links. */
  scanMember(c, parentId, memberId, { onlyChanged = false } = {}) {
    const g = this.game(c);
    const srcRaw = this.mgr.filesDir(parentId);
    if (!fs.existsSync(srcRaw)) throw new Error(`The parent server #${parentId} has no files yet (install it first)`);
    const dstRaw = this.mgr.filesDir(memberId);
    fs.mkdirSync(dstRaw, { recursive: true });
    const srcRoot = fs.realpathSync(srcRaw); const dstRoot = fs.realpathSync(dstRaw);
    const a = norm(srcRoot) + path.sep; const b = norm(dstRoot) + path.sep;
    if (a === b || a.startsWith(b) || b.startsWith(a)) throw new Error('The parent and the member use the same (or nested) folders');
    const isPreserved = pathMatcher(this.preserveList(g, c));
    const out = { srcRoot, dstRoot, files: [], bytes: 0, preserved: 0, preservedPaths: [], identical: 0, links: 0 };
    const walk = (relDir) => {
      for (const e of fs.readdirSync(path.join(srcRoot, relDir), { withFileTypes: true })) {
        const rel = relDir ? `${relDir}/${e.name}` : e.name;
        if (e.isSymbolicLink()) { out.links++; continue; }
        if (isPreserved(rel)) { out.preserved++; if (out.preservedPaths.length < 100) out.preservedPaths.push(rel); continue; }
        if (e.isDirectory()) { walk(rel); continue; }
        if (!e.isFile()) continue;
        let st; try { st = fs.statSync(path.join(srcRoot, rel)); } catch { continue; }
        if (onlyChanged) {
          try { const d = fs.lstatSync(path.join(dstRoot, rel)); if (d.isFile() && d.size === st.size && Math.abs(d.mtimeMs - st.mtimeMs) < 2000) { out.identical++; continue; } } catch { /* missing = copy */ }
        }
        out.files.push({ rel, size: st.size, mtime: st.mtime, atime: st.atime }); out.bytes += st.size;
      }
    };
    walk('');
    return out;
  }

  /** Dry run: per member counts and sizes + the preserve list. Nothing is written. */
  updatePlan(id, opts = {}) {
    const c = this.need(id); const g = this.game(c);
    if (!g) throw new Error(`The game plugin "${c.game}" is not installed`);
    const onlyChanged = opts.onlyChanged !== undefined ? !!opts.onlyChanged : !!c.options.onlyChanged;
    const members = []; let files = 0; let bytes = 0;
    for (const mid of this.targets(c, opts.memberIds)) {
      const row = { id: mid, name: this.name(mid), running: this.mgr.isRunning(mid) };
      try {
        const s = this.scanMember(c, c.parentId, mid, { onlyChanged });
        Object.assign(row, { files: s.files.length, bytes: s.bytes, skippedPreserved: s.preserved, skippedIdentical: s.identical, skippedLinks: s.links, preservedPaths: s.preservedPaths });
        files += s.files.length; bytes += s.bytes;
      } catch (e) { row.error = e.message; }
      members.push(row);
    }
    return { clusterId: c.id, parentId: c.parentId, onlyChanged, preserve: this.preserveList(g, c), members, files, bytes };
  }

  async copyFiles(scan, memberId, onFile) {
    const dirsOk = new Set();
    const ensureDir = (relDir) => {
      if (!relDir || dirsOk.has(relDir)) return;
      let cur = scan.dstRoot;
      for (const part of relDir.split('/')) {
        cur = path.join(cur, part);
        let st = null; try { st = fs.lstatSync(cur); } catch { /* missing */ }
        if (!st) fs.mkdirSync(cur);
        else if (st.isSymbolicLink()) throw new Error(`${relDir} is a link, not followed`);
        else if (!st.isDirectory()) throw new Error(`${relDir} exists but is not a folder`);
      }
      dirsOk.add(relDir);
    };
    const r = { copied: 0, bytes: 0, failed: 0, failures: [], links: 0 };
    for (const f of scan.files) {
      const dst = inside(scan.dstRoot, f.rel); const tmp = `${dst}.ngsm-tmp`;
      try {
        ensureDir(path.posix.dirname(f.rel) === '.' ? '' : path.posix.dirname(f.rel));
        let ds = null; try { ds = fs.lstatSync(dst); } catch { /* new file */ }
        if (ds && ds.isSymbolicLink()) { r.links++; continue; }
        if (ds && ds.isDirectory()) throw new Error('a folder with this name exists on the member');
        await fsp.copyFile(path.join(scan.srcRoot, f.rel), tmp);
        await fsp.rename(tmp, dst);
        try { await fsp.utimes(dst, f.atime, f.mtime); } catch { /* not important */ }
        r.copied++; r.bytes += f.size;
      } catch (e) {
        r.failed++; if (r.failures.length < 10) r.failures.push(`${f.rel}: ${e.code || e.message}`);
        try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
      }
      onFile(f);
    }
    return r;
  }

  /**
   * Update the parent (unless skipParentUpdate), then copy its files to every member.
   * opts: { validate, onlyChanged, skipParentUpdate, memberIds }. Resolves with a per-member report; a failing member does not stop the others.
   */
  async update(id, opts = {}) {
    const c = this.need(id); const g = this.game(c);
    if (!g) throw new Error(`The game plugin "${c.game}" is not installed`);
    const targets = this.targets(c, opts.memberIds);
    const onlyChanged = opts.onlyChanged !== undefined ? !!opts.onlyChanged : !!c.options.onlyChanged;
    this.begin(c, 'update');
    const t0 = Date.now(); const base = { clusterId: c.id, clusterName: c.name, parentId: c.parentId, memberIds: targets, validate: !!opts.validate, onlyChanged };
    const report = { clusterId: c.id, ok: true, parent: { updated: false }, members: [], durationMs: 0 };
    const push = (p) => this.progress({ clusterId: c.id, memberCount: targets.length, ...p });
    this.log('info', 'cluster:update-started', c.parentId, `Cluster "${c.name}" update started (${targets.length} member${targets.length === 1 ? '' : 's'}${opts.validate ? ', validate' : ''}${onlyChanged ? ', only changed files' : ''})`, base);
    this.emit('cluster:update-started', c.parentId, base);
    try {
      if (!opts.skipParentUpdate) {
        push({ phase: 'parent', percent: 0, memberId: c.parentId, memberName: this.name(c.parentId), message: `Updating the parent ${this.name(c.parentId)} ...` });
        try { await this.mgr.update(c.parentId, !!opts.validate, { cluster: c.id }); report.parent.updated = true; }
        catch (e) { throw Object.assign(new Error(`The parent server could not be updated: ${e.message}`), { parent: true }); }
      }
      // plan after the parent update so sizes are current
      const scans = new Map(); let totalBytes = 0; let totalFiles = 0;
      for (const mid of targets) {
        try { const s = this.scanMember(c, c.parentId, mid, { onlyChanged }); scans.set(mid, s); totalBytes += s.bytes; totalFiles += s.files.length; }
        catch (e) { scans.set(mid, { error: e.message }); }
      }
      let doneBytes = 0; let doneFiles = 0; let lastEmit = 0;
      const pct = () => (totalBytes > 0 ? (doneBytes / totalBytes) * 100 : totalFiles > 0 ? (doneFiles / totalFiles) * 100 : 100);
      let index = 0;
      for (const mid of targets) {
        index++;
        const mname = this.name(mid); const scan = scans.get(mid);
        const row = { id: mid, name: mname, ok: true, files: 0, bytes: 0, skippedIdentical: 0, skippedPreserved: 0, failed: 0, failures: [], wasRunning: false, restarted: false };
        report.members.push(row);
        push({ phase: 'member', percent: pct(), memberId: mid, memberName: mname, memberIndex: index, message: `Copying to ${mname} ...` });
        const rt = this.mgr.rt(mid);
        let stoppedHere = false;
        try {
          if (scan.error) throw new Error(scan.error);
          if (rt.busy) throw new Error(`Busy: ${rt.busy}`);
          row.wasRunning = this.mgr.isRunning(mid);
          if (row.wasRunning) { push({ phase: 'member', percent: pct(), memberId: mid, memberName: mname, memberIndex: index, message: `Stopping ${mname} ...` }); await this.mgr.stop(mid); stoppedHere = true; }
          rt.busy = 'Cluster update'; this.mgr.setStatus(mid, 'Updating');
          try {
            const r = await this.copyFiles(scan, mid, (f) => {
              doneBytes += f.size; doneFiles++;
              const now = Date.now();
              if (now - lastEmit > 150) { lastEmit = now; push({ phase: 'member', percent: pct(), memberId: mid, memberName: mname, memberIndex: index, file: f.rel, message: `Copying to ${mname}` }); }
            });
            Object.assign(row, { files: r.copied, bytes: r.bytes, failed: r.failed, failures: r.failures, skippedIdentical: scan.identical, skippedPreserved: scan.preserved });
            if (r.failed) { row.ok = false; row.error = `${r.failed} file${r.failed === 1 ? '' : 's'} could not be copied (locked or blocked): ${r.failures.slice(0, 3).join('; ')}`; }
          } finally { rt.busy = null; this.mgr.setStatus(mid, 'Stopped'); }
        } catch (e) { row.ok = false; row.error = e.message; }
        if (stoppedHere) {
          try { await this.mgr.start(mid); row.restarted = true; } catch (e) { row.ok = false; row.error = `${row.error ? `${row.error}; ` : ''}could not be restarted: ${e.message}`; }
        }
        if (!row.ok) { report.ok = false; this.log('error', 'cluster:update-member-failed', mid, `Cluster "${c.name}": member ${mname} failed: ${row.error}`, { clusterId: c.id, failures: row.failures }); }
        else this.log('info', 'cluster:update-member', mid, `Cluster "${c.name}": ${mname} updated (${row.files} file${row.files === 1 ? '' : 's'} copied, ${row.skippedIdentical} identical, ${row.skippedPreserved} preserved)`, { clusterId: c.id, files: row.files, bytes: row.bytes });
      }
      report.durationMs = Date.now() - t0;
      const failed = report.members.filter((m) => !m.ok).length;
      push({ phase: 'done', percent: 100, message: failed ? `Finished with ${failed} failed member${failed === 1 ? '' : 's'}` : 'Finished' });
      const detail = { ...base, durationMs: report.durationMs, members: report.members.map((m) => ({ id: m.id, ok: m.ok, files: m.files, failed: m.failed, error: m.error })) };
      this.log(failed ? 'warn' : 'info', 'cluster:update-finished', c.parentId, `Cluster "${c.name}" update finished: ${report.members.length - failed}/${report.members.length} members ok`, detail);
      this.emit('cluster:update-finished', c.parentId, { ...detail, ok: report.ok });
      return report;
    } catch (e) {
      report.ok = false; report.error = e.message; report.durationMs = Date.now() - t0;
      push({ phase: 'failed', percent: 0, message: e.message });
      this.log('error', 'cluster:update-failed', c.parentId, `Cluster "${c.name}" update failed: ${e.message}`, { ...base, error: e.message });
      this.emit('cluster:update-failed', c.parentId, { ...base, error: e.message });
      throw e;
    } finally { this.end(c); }
  }

  // ================= 2. config sync =================
  protectList(g, c, def) { return [...new Set([...(def.protect || []), ...g.cluster.protectedConfigKeys, ...c.options.protect])]; }

  /** Compute (without writing) the merged file of every member for the chosen config ids. */
  configResults(c, opts) {
    const g = this.game(c);
    if (!g) throw new Error(`The game plugin "${c.game}" is not installed`);
    const ids = [...new Set((Array.isArray(opts.configIds) && opts.configIds.length ? opts.configIds : []).map(String))];
    if (!ids.length) throw new Error('Choose at least one config file');
    const defs = ids.map((cid) => { const d = g.configs.find((x) => x.id === cid); if (!d) throw new Error(`Unknown config file: ${cid}`); return d; });
    const parents = defs.map((d) => {
      const f = this.mgr.pluginPath(c.parentId, d.path);
      if (!fs.existsSync(f)) throw new Error(`The parent server has no ${d.name} (${d.path}) yet`);
      if (fs.statSync(f).size > MAX_CONFIG_BYTES) throw new Error(`${d.name} is too large for config sync (2 MB limit)`);
      return { def: d, text: fs.readFileSync(f, 'utf8') };
    });
    const members = [];
    for (const mid of this.targets(c, opts.memberIds)) {
      const row = { id: mid, name: this.name(mid), files: [] };
      for (const { def, text } of parents) {
        const entry = { configId: def.id, name: def.name, path: def.path, format: def.format || 'text', status: 'unchanged', warnings: [], diff: '', added: 0, removed: 0 };
        try {
          const file = this.mgr.pluginPath(mid, def.path);
          let cur = null;
          if (fs.existsSync(file)) {
            const st = fs.lstatSync(file);
            if (st.isSymbolicLink()) throw new Error('The member file is a link, not followed');
            if (st.size > MAX_CONFIG_BYTES) throw new Error('The member file is too large (2 MB limit)');
            cur = fs.readFileSync(file, 'utf8');
          }
          const r = mergeConfig({ format: entry.format, parentText: text, memberText: cur, protect: this.protectList(g, c, def) });
          entry.warnings = r.warnings; entry.file = file; entry.next = r.text;
          const d = unifiedDiff(cur || '', r.text);
          entry.diff = d.text; entry.added = d.added; entry.removed = d.removed;
          entry.status = cur === null ? 'new' : (cur.replace(/^﻿/, '') === r.text.replace(/^﻿/, '') ? 'unchanged' : 'changed');
        } catch (e) { entry.status = 'error'; entry.error = e.message; }
        row.files.push(entry);
      }
      members.push(row);
    }
    return { defs, members };
  }

  /** Dry run: per member and file a unified-style diff and warnings. Nothing is written. */
  configPlan(id, opts = {}) {
    const c = this.need(id);
    const { defs, members } = this.configResults(c, opts);
    const strip = (e) => { const { file, next, ...rest } = e; return rest; };
    return {
      clusterId: c.id, parentId: c.parentId,
      configs: defs.map((d) => ({ id: d.id, name: d.name, path: d.path, format: d.format || 'text' })),
      members: members.map((m) => ({ id: m.id, name: m.name, files: m.files.map(strip) })),
    };
  }

  /** Write the merged files to the members (a .bak of the previous member file is kept). */
  configApply(id, opts = {}) {
    const c = this.need(id);
    this.begin(c, 'config sync');
    try {
      const { members } = this.configResults(c, opts);
      let written = 0; let errors = 0;
      const out = members.map((m) => {
        const files = m.files.map((e) => {
          const r = { configId: e.configId, name: e.name, path: e.path, status: e.status, written: false, warnings: e.warnings };
          if (e.error) { r.error = e.error; errors++; this.log('error', 'cluster:config-failed', m.id, `Cluster "${c.name}": ${e.name} not synced to ${m.name}: ${e.error}`, { clusterId: c.id, config: e.configId }); return r; }
          if (e.status === 'unchanged') return r;
          try {
            fs.mkdirSync(path.dirname(e.file), { recursive: true });
            if (fs.existsSync(e.file)) fs.copyFileSync(e.file, `${e.file}.bak`);
            fs.writeFileSync(e.file, e.next);
            r.written = true; written++;
            this.mgr.emitEvent('server:config', m.id, { config: e.configId, path: e.path, cluster: c.id });
            this.log(e.warnings.length ? 'warn' : 'info', 'cluster:config-sync', m.id, `Cluster "${c.name}": ${e.name} synced to ${m.name} (${e.added}+ ${e.removed}-)${e.warnings.length ? `; ${e.warnings.length} warning${e.warnings.length === 1 ? '' : 's'}` : ''}`, { clusterId: c.id, config: e.configId, warnings: e.warnings.slice(0, 10) });
          } catch (err) { r.error = err.message; errors++; }
          return r;
        });
        return { id: m.id, name: m.name, files };
      });
      this.emit('cluster:config-synced', c.parentId, { clusterId: c.id, clusterName: c.name, written, errors });
      return { clusterId: c.id, written, errors, members: out };
    } finally { this.end(c); }
  }

  // ================= 3. clear folders =================
  /** plugin rules + the cluster's own rules */
  clearRules(g, c) {
    return [...g.cluster.clearFolders.map((r) => ({ ...r, source: 'plugin' })), ...c.options.clearFolders.map((r) => ({ ...r, source: 'cluster' }))];
  }

  /** Files matching the rules on one server. Paths are confined to its files folder; links are never followed. */
  scanClear(memberId, rules, now = Date.now()) {
    const rootRaw = this.mgr.filesDir(memberId);
    const res = { id: memberId, name: this.name(memberId), rules: [], files: [], bytes: 0, errors: [] };
    let root; try { root = fs.realpathSync(rootRaw); } catch { for (const r of rules) res.rules.push({ path: r.path, pattern: r.pattern || '*', exists: false, files: 0, bytes: 0 }); return res; }
    const seen = new Set();
    for (const rule of rules) {
      const info = { path: rule.path, pattern: rule.pattern || '*', olderThanDays: rule.olderThanDays || 0, source: rule.source, exists: false, files: 0, bytes: 0 };
      res.rules.push(info);
      let abs;
      try {
        abs = inside(root, safeRel(String(rule.path)));
        const st = fs.lstatSync(abs);
        if (st.isSymbolicLink()) throw new Error('is a link, not followed');
        if (!st.isDirectory()) throw new Error('is not a folder');
        if (!realInside(root, abs)) throw new Error('leaves the server folder');
        info.exists = true;
      } catch (e) { if (e.code !== 'ENOENT') { info.error = e.message; res.errors.push(`${rule.path}: ${e.message}`); } continue; }
      const re = globRe(String(rule.pattern || '*').replace(/\\/g, '/'));
      const minAge = (Number(rule.olderThanDays) || 0) * 86400000;
      const walk = (dir) => {
        let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
          const p = path.join(dir, e.name);
          if (e.isSymbolicLink()) continue;
          if (e.isDirectory()) { if (rule.recursive) walk(p); continue; }
          if (!e.isFile() || !re.test(e.name) || seen.has(norm(p))) continue;
          let st; try { st = fs.lstatSync(p); } catch { continue; }
          if (minAge && now - st.mtimeMs < minAge) continue;
          seen.add(norm(p));
          res.files.push({ abs: p, rel: path.relative(root, p).split(path.sep).join('/'), size: st.size });
          info.files++; info.bytes += st.size; res.bytes += st.size;
        }
      };
      walk(abs);
    }
    return res;
  }

  clearScan(c, opts = {}) {
    const g = this.game(c);
    if (!g) throw new Error(`The game plugin "${c.game}" is not installed`);
    const rules = this.clearRules(g, c);
    if (!rules.length) throw new Error('No folders to clear: the game plugin declares no cluster.clearFolders and the cluster has no rules of its own');
    const ids = Array.isArray(opts.memberIds) && opts.memberIds.length ? c.memberIds.filter((m) => opts.memberIds.map(String).includes(m)) : c.memberIds;
    return ids.map((mid) => this.scanClear(mid, rules));
  }

  /** Dry run: files and bytes per member and rule. */
  clearPlan(id, opts = {}) {
    const c = this.need(id);
    const members = this.clearScan(c, opts).map((m) => ({ id: m.id, name: m.name, files: m.files.length, bytes: m.bytes, rules: m.rules, errors: m.errors, sample: m.files.slice(0, 20).map((f) => f.rel) }));
    return { clusterId: c.id, members, files: members.reduce((n, m) => n + m.files, 0), bytes: members.reduce((n, m) => n + m.bytes, 0) };
  }

  /** Delete the matching files (never the folders). Locked files are skipped and counted. */
  clear(id, opts = {}) {
    const c = this.need(id);
    this.begin(c, 'clear folders');
    try {
      const scans = this.clearScan(c, opts);
      let files = 0; let bytes = 0; let locked = 0;
      const members = scans.map((m) => {
        const r = { id: m.id, name: m.name, deleted: 0, bytes: 0, locked: 0, errors: m.errors.slice() };
        for (const f of m.files) {
          try {
            const st = fs.lstatSync(f.abs);
            if (st.isSymbolicLink() || !st.isFile()) continue;
            fs.unlinkSync(f.abs); r.deleted++; r.bytes += st.size;
          } catch (e) { if (LOCK_CODES.has(e.code)) r.locked++; else if (e.code !== 'ENOENT') r.errors.push(`${f.rel}: ${e.code || e.message}`); }
        }
        files += r.deleted; bytes += r.bytes; locked += r.locked;
        this.log(r.errors.length ? 'warn' : 'info', 'cluster:clear', m.id, `Cluster "${c.name}": cleared ${r.deleted} file${r.deleted === 1 ? '' : 's'} (${r.bytes} bytes) on ${m.name}${r.locked ? `, ${r.locked} locked and skipped` : ''}`, { clusterId: c.id, deleted: r.deleted, bytes: r.bytes, locked: r.locked });
        return r;
      });
      this.emit('cluster:cleared', c.parentId, { clusterId: c.id, clusterName: c.name, files, bytes, locked });
      return { clusterId: c.id, files, bytes, locked, members };
    } finally { this.end(c); }
  }
}

function sanitizeOptionsSafe(o) { try { return sanitizeOptions(o); } catch { return sanitizeOptions({}); } }

module.exports = { Cluster, sanitizeOptions, pathMatcher };
