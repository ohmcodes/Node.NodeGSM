'use strict';
// Plugin loader. A plugin is a folder (or zip) containing plugin.json [+ icon.png] [+ plugin.js].
// Drop it in <data>/plugins/<id>/ and click "Reload plugins" - no app update needed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const { GAMES, splitArgs } = require('./games');

const ID_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;

/** Expand one arg template. Returns array of argv items ([] if a placeholder is empty). */
function expand(tpl, cfg, ctx) {
  if (tpl === '{param}') return splitArgs(cfg.param);
  let empty = false;
  const out = String(tpl).replace(/\{(\w+)\}/g, (_, k) => {
    const v = k === 'serverFiles' ? ctx.serverFiles : cfg[k];
    if (v === undefined || v === null || String(v).trim() === '') empty = true;
    return v == null ? '' : String(v);
  });
  return empty ? [] : [out];
}

function validate(m) {
  const errs = [];
  if (!m.id || !ID_RE.test(m.id)) errs.push('"id" must be 2-32 chars of a-z 0-9 _ -');
  if (!m.name) errs.push('"name" is required');
  if (!m.exe) errs.push('"exe" (start path relative to server files) is required');
  const i = m.install || {};
  if (!['steamcmd', 'manual', 'script'].includes(i.type)) errs.push('install.type must be steamcmd | manual | script');
  if (i.type === 'steamcmd' && !/^\d+$/.test(String(i.appId || ''))) errs.push('install.appId must be a numeric Steam app id');
  if (m.args && !Array.isArray(m.args)) errs.push('"args" must be an array of strings');
  if (m.query && !['a2s', 'ut3', 'fivem'].includes(m.query)) errs.push('query must be a2s | ut3 | fivem');
  return errs;
}

function toGame(m, dir) {
  const d = m.defaults || {};
  let hooks = {};
  const js = path.join(dir, 'plugin.js');
  if (fs.existsSync(js)) { delete require.cache[require.resolve(js)]; hooks = require(js); }
  const tpls = m.args || ['{param}'];
  const iconFile = ['icon.png', `${m.id}.png`].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
  return {
    id: m.id, name: m.name, icon: null,
    iconData: iconFile ? `data:image/png;base64,${fs.readFileSync(iconFile).toString('base64')}` : null,
    engine: 'plugin', plugin: true, pluginDir: dir, author: m.author, version: m.version, description: m.description, url: m.url, color: m.color,
    appId: m.install.type === 'steamcmd' ? String(m.install.appId) : null,
    installer: m.install.type === 'manual' ? 'manual' : null,
    exe: m.exe, cwd: m.workingDir || '', launcher: m.launcher,
    port: String(d.port || ''), queryPort: String(d.queryPort || d.port || ''), map: String(d.map || ''), maxPlayers: String(d.maxPlayers || ''),
    additional: String(d.additional || ''), portIncrement: d.portIncrement || 1,
    query: m.query || null, gslt: !!m.gslt, stopCommand: m.stopCommand || null,
    hooks,
    args: hooks.args ? (c, ctx) => hooks.args(c, ctx) : (c, ctx) => tpls.flatMap((t) => expand(t, c, ctx)),
  };
}

function loadAll(pluginsDir) {
  fs.mkdirSync(pluginsDir, { recursive: true });
  for (let i = GAMES.length - 1; i >= 0; i--) if (GAMES[i].plugin) GAMES.splice(i, 1);
  const loaded = []; const errors = [];
  for (const e of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const dir = path.join(pluginsDir, e.name);
    if (!fs.existsSync(path.join(dir, 'plugin.json'))) continue;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
      const errs = validate(m);
      if (errs.length) throw new Error(errs.join('; '));
      if (GAMES.some((g) => g.id === m.id)) throw new Error(`id "${m.id}" collides with an existing game`);
      const g = toGame(m, dir);
      GAMES.push(g);
      loaded.push({ id: g.id, name: g.name, author: g.author, version: g.version, folder: e.name });
    } catch (err) { errors.push({ folder: e.name, error: err.message }); }
  }
  return { loaded, errors };
}

/** Install from a .zip file or a folder. Returns the plugin id. */
function installFrom(src, pluginsDir) {
  fs.mkdirSync(pluginsDir, { recursive: true });
  let tmp = src;
  let cleanup = null;
  if (fs.statSync(src).isFile()) {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wgsm-plugin-'));
    cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
    new AdmZip(src).extractAllTo(tmp, true);
  }
  try {
    const find = (d, depth = 0) => {
      if (fs.existsSync(path.join(d, 'plugin.json'))) return d;
      if (depth >= 2) return null;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) { const r = find(path.join(d, e.name), depth + 1); if (r) return r; }
      }
      return null;
    };
    const root = find(tmp);
    if (!root) throw new Error('plugin.json not found in the selected ' + (cleanup ? 'zip' : 'folder'));
    const m = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8'));
    const errs = validate(m);
    if (errs.length) throw new Error(errs.join('; '));
    const dest = path.join(pluginsDir, m.id);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(root, dest, { recursive: true });
    return m.id;
  } finally { if (cleanup) cleanup(); }
}

module.exports = { loadAll, installFrom, validate, expand };
