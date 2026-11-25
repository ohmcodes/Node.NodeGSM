'use strict';
// Backups: full and neat-pick (plugin backup.presets + chosen folders/files) zip backups with a sidecar manifest,
// exclude patterns, retention, restore, restore-as-new and the all-servers backup list.
// Zips are written and read as streams (services/zip.js), so big servers do not need to fit in memory.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { ZipWriter, openZip, extractEntry } = require('./zip');

const MANIFEST_VERSION = 1;
const META_DIR = '__nodegsm';                 // reserved zip folder for NodeGSM metadata; never extracted into the server files
const META_SETTINGS = `${META_DIR}/wgsm.json`;
const FOLDER_RE = /^\d+(\.deleted-\d+)?$/;    // <id> or <id>.deleted-<timestamp> (backups of a deleted server)
const FILE_RE = /^[A-Za-z0-9._-]+\.zip$/;
const MODES = ['full', 'neatpick'];
const SKIP_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOENT']);
const WIN = process.platform === 'win32';
const norm = (p) => (WIN ? p.toLowerCase() : p);

/**
 * Normalise a user / plugin / zip-entry path to "a/b/c": forward slashes, no empty or "." parts.
 * Rejects "..", absolute paths, drive letters, NUL and ":" (Windows alternate data streams).
 */
function safeRel(p) {
  if (typeof p !== 'string') throw new Error('Invalid path');
  const s = p.replace(/\\/g, '/').trim();
  if (!s || s.includes('\0') || s.startsWith('/') || /^[a-z]:/i.test(s)) throw new Error(`Invalid path: ${p}`);
  const parts = s.split('/').filter((x) => x && x !== '.');
  if (!parts.length || parts.some((x) => x === '..' || x.includes(':'))) throw new Error(`Invalid path: ${p}`);
  return parts.join('/');
}

/** root + rel -> absolute path, which must stay inside root. */
function inside(root, rel) {
  const abs = path.resolve(root, rel);
  if (norm(abs) !== norm(root) && !norm(abs).startsWith(norm(root) + path.sep)) throw new Error(`Path escapes the server folder: ${rel}`);
  return abs;
}
/** True when the real (symlink-resolved) path of abs is inside realRoot. */
function realInside(realRoot, abs) {
  let r; try { r = fs.realpathSync(abs); } catch { return false; }
  return norm(r) === norm(realRoot) || norm(r).startsWith(norm(realRoot) + path.sep);
}

/** Wildcard patterns (* ** ?). No "/" in the pattern: matches any file or folder name. With "/": matches the path from the server root. Case-insensitive. */
function compileExclude(patterns) {
  const list = [];
  for (const raw of patterns || []) {
    let s = String(raw).replace(/\\/g, '/').trim().replace(/^\/+|\/+$/g, '');
    if (!s) continue;
    const anchored = s.includes('/');
    let re = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '*') { if (s[i + 1] === '*') { re += '.*'; i++; } else re += '[^/]*'; }
      else if (c === '?') re += '[^/]';
      else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    list.push({ anchored, re: new RegExp(`^${re}$`, 'i') });
  }
  return (rel, name) => list.some((x) => x.re.test(x.anchored ? rel : name));
}

const stampOf = () => new Date().toISOString().replace(/[:.]/g, '-');
const strArr = (v, max, len) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, len)).slice(0, max) : []);

class BackupService {
  /**
   * @param {import('../serverManager').ServerManager} mgr  server manager (mgr.events emits server:* events)
   * @param {object} plugins  the plugins module (GAMES, byId, ...)
   * @param {object} settings app settings snapshot (mgr.settings is the live object)
   * @param {string} dataDir  NodeGSM data folder
   * @param {{zip64Threshold?:number, forceZip64?:boolean}} [opts]  zip options (tests)
   */
  constructor(mgr, plugins, settings, dataDir, opts = {}) {
    this.mgr = mgr; this.plugins = plugins; this.settings = settings; this.dataDir = dataDir;
    this.zipOpts = opts;
    this.started = false;
    mgr._bk = this;   // ServerManager.backup/restore/... delegate here
  }

  start() { this.started = true; }
  stop() { this.started = false; }

  // ---------- paths ----------
  dirOf(folder) {
    folder = String(folder);
    if (!FOLDER_RE.test(folder)) throw new Error('Invalid backup folder');
    return path.join(this.mgr.backupsDir, folder);
  }
  filePath(folder, file) {
    const f = path.basename(String(file || ''));
    if (!FILE_RE.test(f)) throw new Error('Invalid backup file name');
    return path.join(this.dirOf(folder), f);
  }
  manifestPath(zipFile) { return zipFile.replace(/\.zip$/i, '.json'); }

  readManifest(zipFile) {
    try {
      const m = JSON.parse(fs.readFileSync(this.manifestPath(zipFile), 'utf8'));
      if (!m || typeof m !== 'object' || m.version !== MANIFEST_VERSION) return null;
      return { ...m, mode: MODES.includes(m.mode) ? m.mode : 'full', paths: Array.isArray(m.paths) ? m.paths : [], exclude: Array.isArray(m.exclude) ? m.exclude : [] };
    } catch { return null; }
  }

  // ---------- listing ----------
  /** One folder's backups, newest first. Old backups without a sidecar are reported as mode "full" with legacy: true. */
  list(folder) {
    folder = String(folder);
    const d = this.dirOf(folder);
    let files = [];
    try { files = fs.readdirSync(d).filter((f) => FILE_RE.test(f)); } catch { return []; }
    const sid = folder.split('.')[0];
    const cfg = this.mgr.getConfig(sid);
    const alive = !!cfg && !folder.includes('.deleted-');
    const out = [];
    for (const f of files) {
      let st; try { st = fs.statSync(path.join(d, f)); } catch { continue; }
      const m = this.readManifest(path.join(d, f));
      out.push({
        folder, serverId: sid, file: f, size: st.size, time: m && m.createdAt ? Date.parse(m.createdAt) || st.mtimeMs : st.mtimeMs,
        mode: m ? m.mode : 'full', legacy: !m, manifest: m,
        serverName: m && m.serverName ? m.serverName : (cfg && alive ? cfg.name : ''), game: m ? m.game : (cfg && alive ? cfg.game : ''),
        deleted: !alive,
      });
    }
    return out.sort((a, b) => b.time - a.time);
  }
  /** Every backup of every server (also the ones of deleted servers). */
  listAll() {
    let dirs = [];
    try { dirs = fs.readdirSync(this.mgr.backupsDir, { withFileTypes: true }).filter((e) => e.isDirectory() && FOLDER_RE.test(e.name)).map((e) => e.name); } catch { return []; }
    const rows = dirs.flatMap((d) => this.list(d));
    for (const r of rows) {
      const g = r.game ? this.plugins.byId(r.game) : null;
      r.gameName = g ? g.name : r.game;
      r.pluginMissing = !!r.game && !g;
    }
    return rows.sort((a, b) => b.time - a.time);
  }

  // ---------- selection ----------
  /** Validate and normalise backup options. */
  normalize(c, g, opts = {}) {
    const mode = opts.mode === undefined || opts.mode === null || opts.mode === '' ? 'full' : opts.mode;
    if (!MODES.includes(mode)) throw new Error(`Unknown backup mode: ${mode}`);
    const presets = [];
    const known = (g && g.backup && g.backup.presets) || [];
    if (mode === 'neatpick') {
      for (const pid of strArr(opts.presets, 50, 60)) {
        const p = known.find((x) => x.id === pid);
        if (!p) throw new Error(`Unknown backup preset: ${pid}`);
        if (!presets.includes(pid)) presets.push(pid);
      }
    }
    const paths = mode === 'neatpick' ? [...new Set(strArr(opts.paths, 2000, 500).map(safeRel))] : [];
    const user = strArr(opts.exclude, 200, 200);
    const exclude = [...new Set([...(((g && g.backup && g.backup.exclude) || [])), ...user])];
    const includeServerSettings = opts.includeServerSettings === undefined ? mode === 'full' : !!opts.includeServerSettings;
    if (mode === 'neatpick' && !presets.length && !paths.length && !includeServerSettings) throw new Error('Neat pick: choose at least one preset, folder or file');
    return { mode, presets, paths, exclude, includeServerSettings, presetDefs: known };
  }

  /** Walk the server files according to the options. Nothing is read or written besides directory listings. */
  async collect(id, o) {
    const root = path.resolve(this.mgr.filesDir(id));
    const skipped = []; const missing = []; const seen = new Set(); const entries = []; const emptyDirs = [];
    let totalBytes = 0;
    if (!fs.existsSync(root)) {
      if (o.mode === 'full') return { root, entries, emptyDirs, totalBytes, fileCount: 0, skipped, missing, selection: [] };
    }
    let realRoot = root; try { realRoot = fs.realpathSync(root); } catch { /* missing folder: neat pick reports each path as missing */ }
    const excluded = compileExclude(o.exclude);
    const add = (rel, abs, st) => { const k = norm(rel); if (seen.has(k)) return; seen.add(k); entries.push({ rel, abs, size: st.size, mtimeMs: st.mtimeMs }); totalBytes += st.size; };
    const walk = async (absDir, rel) => {
      let ents;
      try { ents = await fsp.readdir(absDir, { withFileTypes: true }); } catch (e) { skipped.push({ path: rel, reason: e.code || 'unreadable' }); return; }
      if (!ents.length && rel) emptyDirs.push(rel);
      for (const d of ents) {
        const r = rel ? `${rel}/${d.name}` : d.name;
        if (excluded(r, d.name)) continue;
        const abs = path.join(absDir, d.name);
        if (d.isSymbolicLink()) { skipped.push({ path: r, reason: 'symlink' }); continue; }
        if (d.isDirectory()) await walk(abs, r);
        else if (d.isFile()) { try { add(r, abs, await fsp.stat(abs)); } catch (e) { skipped.push({ path: r, reason: e.code || 'unreadable' }); } }
      }
    };
    let selection = [];
    if (o.mode === 'full') await walk(root, '');
    else {
      const sel = [];
      for (const pid of o.presets) { const p = o.presetDefs.find((x) => x.id === pid); for (const x of (p && p.paths) || []) sel.push(safeRel(x)); }
      for (const x of o.paths) sel.push(x);
      selection = [...new Set(sel.map((x) => x))];
      for (const rel of selection) {
        const abs = inside(root, rel);
        let st; try { st = await fsp.lstat(abs); } catch { missing.push(rel); continue; }
        if (st.isSymbolicLink() || !realInside(realRoot, abs)) { skipped.push({ path: rel, reason: 'symlink' }); continue; }
        if (excluded(rel, rel.split('/').pop())) continue;
        if (st.isDirectory()) await walk(abs, rel);
        else if (st.isFile()) add(rel, abs, st);
      }
    }
    return { root, entries, emptyDirs, totalBytes, fileCount: entries.length, skipped, missing, selection };
  }

  /** Estimate for the UI: file count and uncompressed size (the zip is usually smaller). */
  async preview(id, opts = {}) {
    id = String(id);
    const c = this.mgr.getConfig(id); if (!c) throw new Error('Server not found');
    const g = this.plugins.byId(c.game);
    const o = this.normalize(c, g, opts);
    const s = await this.collect(id, o);
    return { mode: o.mode, fileCount: s.fileCount, totalBytes: s.totalBytes, skipped: s.skipped.length, missing: s.missing, includeServerSettings: o.includeServerSettings, exclude: o.exclude, presets: o.presets, paths: s.selection };
  }

  /** Plugin presets and excludes + retention for the UI. */
  info(id) {
    const c = this.mgr.getConfig(id); if (!c) throw new Error('Server not found');
    const g = this.plugins.byId(c.game);
    return { presets: ((g && g.backup && g.backup.presets) || []).map((p) => ({ id: p.id, name: p.name, paths: p.paths })), exclude: (g && g.backup && g.backup.exclude) || [], keep: Number(c.backupKeep) || 0,
      schedule: c.backupSchedule || { enabled: false, cron: '0 4 * * *', options: { mode: 'full' } }, nextRun: c.backupSchedule && c.backupSchedule.enabled ? require('../serverManager').ServerManager.cronNext(c.backupSchedule.cron) : 0 };
  }

  // ---------- backup ----------
  async create(id, opts = {}) {
    id = String(id);
    const c = this.mgr.getConfig(id); if (!c) throw new Error('Server not found');
    const g = this.plugins.byId(c.game);
    const o = this.normalize(c, g, opts);
    const dir = path.join(this.mgr.backupsDir, id);
    await fsp.mkdir(dir, { recursive: true });
    const rt = this.mgr.rt(id);
    const prev = rt.busy; rt.busy = 'Backing up'; this.mgr.emit('status', this.mgr.view(id));
    this.mgr.log(id, o.mode === 'full' ? 'Backing up server files ...' : 'Backing up the selected files ...');
    let zw; let tmp;
    try {
      const sel = await this.collect(id, o);
      if (!sel.fileCount && !o.includeServerSettings) throw new Error('Nothing to back up (no files matched)');
      let base = `backup-${stampOf()}`; let zipFile = path.join(dir, `${base}.zip`);
      for (let n = 2; fs.existsSync(zipFile); n++) zipFile = path.join(dir, `${base}-${n}.zip`);
      tmp = `${zipFile}.partial`;
      zw = new ZipWriter(tmp, this.zipOpts);
      let written = 0; let bytes = 0; const skipped = sel.skipped.slice();
      if (o.includeServerSettings) { try { await zw.addBuffer(META_SETTINGS, fs.readFileSync(this.mgr.cfgFile(id)), Date.now()); } catch (e) { skipped.push({ path: META_SETTINGS, reason: e.code || e.message }); } }
      for (const f of sel.entries) {
        try { await zw.addFile(f.rel, f.abs, f); written++; bytes += f.size; }
        catch (e) { if (e.skippable && SKIP_CODES.has(e.code)) skipped.push({ path: f.rel, reason: e.code }); else throw e; }
      }
      for (const d of sel.emptyDirs) await zw.addDir(d, Date.now());
      await zw.finish(); zw = null;
      await fsp.rename(tmp, zipFile); tmp = null;
      const st = await fsp.stat(zipFile);
      const manifest = {
        version: MANIFEST_VERSION, mode: o.mode, game: c.game, serverName: c.name, serverId: id, createdAt: new Date().toISOString(),
        paths: o.mode === 'full' ? [] : sel.selection, presets: o.presets, exclude: o.exclude, sizeBytes: st.size, uncompressedBytes: bytes, fileCount: written,
        gameVersion: await this.gameVersion(id, g), includesServerSettings: o.includeServerSettings,
        ...(skipped.length ? { skipped: skipped.length } : {}), ...(sel.missing.length ? { missing: sel.missing } : {}),
      };
      await fsp.writeFile(this.manifestPath(zipFile), JSON.stringify(manifest, null, 2));
      const file = path.basename(zipFile);
      this.mgr.log(id, `Backup created: ${file} (${written} files${skipped.length ? `, ${skipped.length} skipped` : ''})`);
      this.mgr.emitEvent('server:backup', id, { file, mode: o.mode, sizeBytes: st.size, fileCount: written, skipped: skipped.length });
      if (skipped.length) this.logEntry({ level: 'warn', event: 'backup:skipped', serverId: id, message: `Backup ${file}: ${skipped.length} file(s) skipped (locked, unreadable or symlink)`, detail: { sample: skipped.slice(0, 10) } });
      this.prune(id);
      return file;
    } catch (e) {
      if (zw) zw.abort();
      if (tmp) await fsp.rm(tmp, { force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
      this.logEntry({ level: 'error', event: 'backup:failed', serverId: id, message: `Backup failed: ${e.message}`, detail: { mode: o.mode } });
      throw e;
    } finally { rt.busy = prev; this.mgr.emit('status', this.mgr.view(id)); }
  }

  async gameVersion(id, g) {
    try {
      if (g && g.appId) { const b = this.mgr.steam.getLocalBuild(this.mgr.filesDir(id), g.appId); if (b) return String(b); }
      if (g && g.hooks && g.hooks.local) { const v = await g.hooks.local(this.mgr.filesDir(id)); if (v) return String(v); }
    } catch { /* version is optional */ }
    return null;
  }

  logEntry(entry) { try { const el = this.mgr.eventLog; if (el && el.log) el.log(entry); } catch { /* logging never breaks a backup */ } }

  /** Retention: keep the newest `backupKeep` backups of a server (0 = unlimited). Returns the number removed. */
  prune(id) {
    const c = this.mgr.getConfig(id); const keep = c ? Math.floor(Number(c.backupKeep)) || 0 : 0;
    if (keep < 1) return 0;
    const old = this.list(String(id)).slice(keep);
    for (const b of old) this.remove(String(id), b.file);
    if (old.length) { this.mgr.log(id, `Retention: removed ${old.length} old backup(s) (keeping ${keep})`); this.logEntry({ level: 'info', event: 'backup:pruned', serverId: id, message: `Retention removed ${old.length} old backup(s), keeping ${keep}`, detail: { files: old.map((b) => b.file) } }); }
    return old.length;
  }

  remove(folder, file) {
    const z = this.filePath(folder, file);
    fs.rmSync(z, { force: true }); fs.rmSync(this.manifestPath(z), { force: true });
  }

  // ---------- restore ----------
  /** Check every entry name before anything is written (zip-slip). Returns [{ e, rel, abs }] for the entries to extract. */
  plan(zip, root, realRoot) {
    const files = []; let settings = null; const dirs = [];
    for (const e of zip.entries) {
      const rel = safeRel(e.name.replace(/\/+$/, '') || '.');   // throws for "..", absolute, drive letters
      if (rel === META_DIR || rel.startsWith(`${META_DIR}/`)) { if (rel === META_SETTINGS) settings = e; continue; }
      const abs = inside(root, rel);
      if (e.dir) dirs.push(abs); else files.push({ e, rel, abs });
    }
    return { files, dirs, settings, realRoot };
  }

  async extractAll(zipFile, root, progress) {
    await fsp.mkdir(root, { recursive: true });
    const realRoot = fs.realpathSync(root);
    const zip = await openZip(zipFile);
    try {
      const p = this.plan(zip, root, realRoot);
      for (const d of p.dirs) { await fsp.mkdir(d, { recursive: true }); if (!realInside(realRoot, d)) throw new Error('Refusing to extract through a symlink'); }
      let n = 0;
      for (const f of p.files) {
        await fsp.mkdir(path.dirname(f.abs), { recursive: true });
        if (!realInside(realRoot, path.dirname(f.abs))) throw new Error(`Refusing to extract through a symlink: ${f.rel}`);
        try { const l = await fsp.lstat(f.abs); if (l.isSymbolicLink()) throw new Error(`Refusing to overwrite a symlink: ${f.rel}`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        await extractEntry(zip, f.e, f.abs);
        n++; if (progress && n % 200 === 0) progress(n, p.files.length);
      }
      let settings = null;
      if (p.settings) { const tmp = path.join(path.dirname(zipFile), `.settings-${process.pid}-${Date.now()}.tmp`); try { await extractEntry(zip, p.settings, tmp); settings = JSON.parse(fs.readFileSync(tmp, 'utf8')); } finally { fs.rmSync(tmp, { force: true }); } }
      return { files: n, settings };
    } finally { await zip.close(); }
  }

  isInstalled(id, g) { return fs.existsSync(path.join(this.mgr.filesDir(id), g.exe)); }

  /** Restore into an existing server. opts: { restoreSettings } (apply wgsm.json from the backup; default false). */
  async restore(id, file, opts = {}) {
    id = String(id);
    const c = this.mgr.getConfig(id); if (!c) throw new Error('Server not found');
    const zipFile = this.filePath(id, file);
    if (!fs.existsSync(zipFile)) throw new Error('Backup not found');
    const m = this.readManifest(zipFile);
    const g = this.plugins.byId(c.game);
    if (m && m.game && m.game !== c.game) throw new Error(`This backup belongs to a "${m.game}" server and cannot be restored into a "${c.game}" server`);
    if (m && m.mode === 'neatpick' && !(g && this.isInstalled(id, g))) throw new Error('This server is not installed. Install the game first, then restore the neat-pick backup.');
    const rt = this.mgr.rt(id);
    if (rt.busy) throw new Error(`Busy: ${rt.busy}`);
    if (this.mgr.isRunning(id)) await this.mgr.stop(id);
    rt.busy = 'Restoring'; this.mgr.emit('status', this.mgr.view(id));
    try {
      this.mgr.log(id, `Restoring ${path.basename(zipFile)} ...`);
      const r = await this.extractAll(zipFile, this.mgr.filesDir(id));
      if (opts.restoreSettings && r.settings) this.applySettings(id, r.settings, { keepName: true });
      this.mgr.log(id, `Restore finished (${r.files} files).`);
      this.mgr.emitEvent('server:restore', id, { file: path.basename(zipFile), mode: m ? m.mode : 'full', fileCount: r.files });
      return { files: r.files, mode: m ? m.mode : 'full' };
    } catch (e) {
      this.logEntry({ level: 'error', event: 'backup:restore-failed', serverId: id, message: `Restore failed: ${e.message}`, detail: { file: path.basename(zipFile) } });
      throw e;
    } finally { rt.busy = null; this.mgr.emit('status', this.mgr.view(id)); }
  }

  /** Apply a wgsm.json from a backup to a server: only known keys; no id / game / installDir; ports that are taken by another server move to the next free one. */
  applySettings(id, saved, { keepName = false, name } = {}) {
    const cur = this.mgr.getConfig(id);
    const g = this.plugins.byId(cur.game);
    const patch = {};
    for (const k of Object.keys(cur)) {
      if (['id', 'game', 'installDir'].includes(k) || !(k in saved) || typeof saved[k] !== typeof cur[k]) continue;
      patch[k] = saved[k];
    }
    if (name) patch.name = name; else if (keepName) delete patch.name;
    try { require('../settings').sanitizeServerDiscord({ discordWebhook: patch.discordWebhook }); } catch { patch.discordWebhook = ''; }
    const used = new Set();
    for (const oid of this.mgr.ids()) { if (oid === String(id)) continue; const oc = this.mgr.getConfig(oid); used.add(+oc.port); used.add(+oc.queryPort); }
    const inc = (g && g.portIncrement) || 1; let adjusted = false;
    const same = patch.port !== undefined && String(patch.port) === String(patch.queryPort);   // port == query port stays that way
    for (const f of ['port', 'queryPort']) {
      if (patch[f] === undefined || patch[f] === '') continue;
      if (f === 'queryPort' && same) { patch.queryPort = patch.port; continue; }
      let p = parseInt(patch[f], 10);
      if (!Number.isFinite(p)) { delete patch[f]; continue; }
      const start = p;
      while (used.has(p) && p < 65535) p += inc;
      if (p !== start) { adjusted = true; patch[f] = String(p); }
      used.add(p);
    }
    this.mgr.saveConfig(id, patch);
    return { portAdjusted: adjusted };
  }

  /** Locate a backup: ref is { serverId|folder, file } or just a file name (searched in every folder). */
  find(ref) {
    if (ref && typeof ref === 'object') {
      const folder = String(ref.folder != null ? ref.folder : ref.serverId);
      const z = this.filePath(folder, ref.file);
      if (!fs.existsSync(z)) throw new Error('Backup not found');
      return { folder, file: path.basename(z), zipFile: z };
    }
    const f = path.basename(String(ref || ''));
    const hit = this.listAll().find((b) => b.file === f);
    if (!hit) throw new Error('Backup not found');
    return { folder: hit.folder, file: hit.file, zipFile: this.filePath(hit.folder, hit.file) };
  }

  /**
   * Create a NEW server from a backup. Full: create + extract. Neat pick: create + install the game + apply the backup.
   * opts: { name, game (only for old backups without a manifest), restoreSettings (default true) }.
   */
  async restoreAsNew(ref, opts = {}) {
    const { folder, file, zipFile } = this.find(ref);
    const m = this.readManifest(zipFile);
    const gameId = m ? m.game : opts.game;
    if (!gameId) throw new Error('This is an old backup without a manifest, so its game is unknown. Pass the game to restore it as a new server.');
    const g = this.plugins.byId(gameId);
    if (!g) throw new Error(`The plugin for "${gameId}" is not installed. Install the game plugin first, then restore as a new server.`);
    const mode = m ? m.mode : 'full';
    const name = String(opts.name || '').trim().slice(0, 100) || `${(m && m.serverName) || g.name} (restored)`;
    // Check the backup before creating anything.
    const zip = await openZip(zipFile);
    try { this.plan(zip, path.resolve(this.mgr.serversDir, '_check'), null); } finally { await zip.close(); }
    const created = this.mgr.create(gameId, name);
    const id = created.id;
    this.mgr.log(id, `Creating server from backup ${file} ...`);
    try {
      if (mode === 'neatpick') {
        this.mgr.log(id, 'Neat-pick backup: installing the game first ...');
        await this.mgr.install(id);
      }
      const r = await this.extractAll(zipFile, this.mgr.filesDir(id));
      let portAdjusted = false;
      if (r.settings && opts.restoreSettings !== false) portAdjusted = this.applySettings(id, r.settings, { name }).portAdjusted;
      this.mgr.log(id, `Restored ${file} (${r.files} files)${portAdjusted ? '; a port was already in use and was moved to the next free one' : ''}.`);
      this.mgr.emitEvent('server:restore', id, { file, mode, fileCount: r.files, asNew: true, from: folder });
      return { id, name, mode, files: r.files, portAdjusted, settingsRestored: !!(r.settings && opts.restoreSettings !== false) };
    } catch (e) {
      this.logEntry({ level: 'error', event: 'backup:restore-failed', serverId: id, serverName: name, message: `Restore as new server failed: ${e.message}`, detail: { file, from: folder } });
      try { await this.mgr.remove(id, true); } catch { /* leave it for the user */ }
      throw e;
    }
  }
}

module.exports = { BackupService, safeRel, inside, realInside, compileExclude, MANIFEST_VERSION, META_SETTINGS };
