'use strict';
// Catalogue client: the plugin list (games) lives in its own repository and is published as static files
// (see https://github.com/ohmcodes/Node.NodeGSM.Catalogue). NodeGSM downloads the list ONCE, keeps it on disk
// and refreshes it only when it is older than REFRESH_MS or the user asks. Plugins are installed from the catalogue
// zips after a sha256 check, into <data>/plugins (the normal user plugin folder).
//
//   <data>/catalogue/index.json   the cached list (lean, no READMEs)
//   <data>/catalogue/meta.json    { url, fetchedAt, hash, count }
//   <data>/catalogue/detail/<id>.json   cached per-plugin detail (README, docs ...), fetched on demand
//
// The catalogue address is a https:// URL or a local folder (a checkout's public/ folder: works with no internet and no website).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_URL = 'https://ohmcodes.github.io/Node.NodeGSM.Catalogue/';
const REFRESH_MS = 24 * 3600e3;
const ID_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;
const MAX_JSON = 20 * 1024 * 1024;
const MAX_ZIP = 100 * 1024 * 1024;
const TIMEOUT_MS = 20000;

/** https URL (trailing slash added) or an existing local folder; anything else -> null. */
function normalizeBase(v) {
  const s = String(v || '').trim();
  if (!s) return DEFAULT_URL;
  if (/^https:\/\//i.test(s) || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(s)) { try { return new URL(s.endsWith('/') ? s : s + '/').href; } catch { return null; } }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return null;           // other schemes (ftp, file ...) are refused
  try { if (fs.statSync(s).isDirectory()) return path.resolve(s); } catch { /* not a folder */ }
  return null;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const isLocal = (base) => !/^https?:/i.test(base);

class Catalogue {
  /** @param {string} dataDir  @param {() => object} getSettings  @param {(zipPath:string)=>string} installZip installs a plugin zip, returns its id */
  constructor(dataDir, getSettings, installZip) {
    this.dir = path.join(dataDir, 'catalogue');
    this.getSettings = getSettings;
    this.installZip = installZip;
    this.busy = null;
  }

  get base() { return normalizeBase((this.getSettings() || {}).catalogueUrl); }
  _file(n) { return path.join(this.dir, n); }
  _read(n) { try { return JSON.parse(fs.readFileSync(this._file(n), 'utf8')); } catch { return null; } }
  _write(n, o) { fs.mkdirSync(path.dirname(this._file(n)), { recursive: true }); const t = this._file(n) + '.tmp'; fs.writeFileSync(t, JSON.stringify(o)); fs.renameSync(t, this._file(n)); }

  /** Reads a file of the catalogue (relative path) as a Buffer, from the web or a local folder. Never leaves the catalogue root. */
  async _get(rel, max) {
    const base = this.base;
    if (!base) throw new Error('The catalogue address is not valid (use an https:// URL or an existing folder).');
    if (rel.includes('..') || path.isAbsolute(rel) || /^[a-z]+:/i.test(rel)) throw new Error('Bad catalogue path: ' + rel);
    if (isLocal(base)) {
      const f = path.join(base, rel);
      if (!path.resolve(f).startsWith(path.resolve(base))) throw new Error('Bad catalogue path: ' + rel);
      const st = fs.statSync(f); if (st.size > max) throw new Error('File too large: ' + rel);
      return fs.readFileSync(f);
    }
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(new URL(rel, base).href, { signal: ctl.signal, redirect: 'follow', headers: { 'User-Agent': 'NodeGSM' } });
      if (!r.ok) throw new Error(`Catalogue answered ${r.status} for ${rel}`);
      const len = Number(r.headers.get('content-length') || 0); if (len > max) throw new Error('File too large: ' + rel);
      const buf = Buffer.from(await r.arrayBuffer()); if (buf.length > max) throw new Error('File too large: ' + rel);
      return buf;
    } catch (e) { throw new Error(e.name === 'AbortError' ? 'The catalogue did not answer in time.' : e.message); }
    finally { clearTimeout(t); }
  }
  async _json(rel) { return JSON.parse((await this._get(rel, MAX_JSON)).toString('utf8')); }

  /** What the UI shows: cached list + freshness + which plugins are installed (and whether a newer version exists). */
  state(installed = {}) {
    const idx = this._read('index.json'); const meta = this._read('meta.json');
    const plugins = (idx && idx.plugins ? idx.plugins : []).map((p) => {
      const have = installed[p.id];
      return { ...p, installed: !!have, installedVersion: have || null, update: !!have && have !== p.version };
    });
    return {
      url: this.base, valid: !!this.base, fetchedAt: meta ? meta.fetchedAt : 0, count: plugins.length,
      stale: !meta || Date.now() - meta.fetchedAt > REFRESH_MS, tags: idx ? idx.tags || [] : [], plugins,
    };
  }

  /**
   * Makes sure there is a cached list. Network is used only when there is no cache, the cache is older than 24 h, or force is set;
   * even then only the tiny catalogue.json is downloaded first, and index.json only when its hash changed.
   */
  refresh({ force = false } = {}) {
    if (this.busy) return this.busy;
    this.busy = (async () => {
      const base = this.base; if (!base) throw new Error('The catalogue address is not valid.');
      const meta = this._read('meta.json');
      const sameSource = meta && meta.url === base && this._read('index.json');
      if (sameSource && !force && Date.now() - meta.fetchedAt < REFRESH_MS) return { changed: false, cached: true };
      let remote = null;
      try { remote = await this._json('catalogue.json'); } catch { /* old catalogue without marker: fall through and fetch the index */ }
      if (sameSource && remote && remote.hash === meta.hash) { this._write('meta.json', { ...meta, fetchedAt: Date.now() }); return { changed: false, cached: false }; }
      const raw = await this._get('index.json', MAX_JSON);
      const idx = JSON.parse(raw.toString('utf8'));
      if (!idx || idx.schema !== 1 || !Array.isArray(idx.plugins)) throw new Error('This is not a NodeGSM catalogue (unknown format).');
      idx.plugins = idx.plugins.filter((p) => p && ID_RE.test(p.id) && /^[a-f0-9]{64}$/.test(p.sha256 || '') && typeof p.zip === 'string');
      if (remote && remote.hash && remote.hash !== sha256(raw)) throw new Error('The catalogue is inconsistent (index does not match catalogue.json). Try again in a minute.');
      this._write('index.json', idx);
      fs.rmSync(this._file('detail'), { recursive: true, force: true });
      this._write('meta.json', { url: base, fetchedAt: Date.now(), hash: sha256(raw), count: idx.plugins.length });
      return { changed: true, cached: false };
    })().finally(() => { this.busy = null; });
    return this.busy;
  }

  /** Full detail of one plugin (README, docs, ports, screenshots). Cached on disk after the first view. */
  async detail(id) {
    if (!ID_RE.test(String(id))) throw new Error('Unknown plugin');
    const cached = this._read(`detail/${id}.json`);
    const entry = ((this._read('index.json') || {}).plugins || []).find((p) => p.id === id);
    if (cached && entry && cached.sha256 === entry.sha256) return this._abs(cached);
    if (!entry) throw new Error('Unknown plugin (refresh the catalogue)');
    const d = await this._json(entry.detail || `plugins/${id}.json`);
    this._write(`detail/${id}.json`, d);
    return this._abs(d);
  }
  // media paths -> absolute URLs so the UI can show them straight from the catalogue host
  _abs(d) {
    const base = this.base; if (!base || isLocal(base)) return d;
    const u = (r) => (r ? new URL(r, base).href : r);
    return { ...d, icon: u(d.icon), banner: u(d.banner), screenshots: (d.screenshots || []).map(u) };
  }

  /** Downloads the zip, verifies the sha256 from the index and installs it. Returns the plugin id. */
  async install(id) {
    if (!ID_RE.test(String(id))) throw new Error('Unknown plugin');
    const entry = ((this._read('index.json') || {}).plugins || []).find((p) => p.id === id);
    if (!entry) throw new Error('Unknown plugin (refresh the catalogue)');
    const buf = await this._get(entry.zip, MAX_ZIP);
    if (sha256(buf) !== entry.sha256) throw new Error(`Checksum mismatch for "${id}": the download is corrupt or was changed. Nothing was installed.`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nodegsm-cat-'));
    try {
      const f = path.join(tmp, `${id}.zip`); fs.writeFileSync(f, buf);
      const got = this.installZip(f);
      if (got !== id) throw new Error(`The zip contained plugin "${got}", not "${id}".`);
      return got;
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
}

module.exports = { Catalogue, normalizeBase, DEFAULT_URL, REFRESH_MS };
