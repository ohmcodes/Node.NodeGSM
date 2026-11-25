'use strict';
// Plugin loader. EVERY game in NodeGSM is a plugin: a folder with plugin.json (+ icon, README, screenshots, plugin.js).
//   <app>/plugins/<id>/        bundled games (these are the ones contributed via GitHub PRs)
//   <data>/plugins/<id>/       user plugins; same id as a bundled one = local override
// See PLUGINS.md for the format and plugins/plugin.schema.json for editor auto-complete.
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');

const BUNDLED_DIR = path.join(__dirname, '..', '..', 'plugins');
const ID_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;
const STEP_TYPES = ['steamcmd', 'download', 'extract', 'run', 'write', 'mkdir', 'script'];
const FORMATS = ['ini', 'json', 'xml', 'properties', 'cfg', 'yaml', 'text'];
const QUERIES = ['a2s', 'ut3', 'fivem'];
const DOC_TYPES = ['official', 'unofficial'];

/** @type {Array<object>} live list of loaded games (mutated by loadAll) */
const GAMES = [];
const byId = (id) => GAMES.find((g) => g.id === id);

function splitArgs(str) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(str || ''))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

// ---------- argument templates -------------------------------------------------------------------
// item   := string | [string, string, ...]          (array = group, dropped as a whole if any part is empty)
// string := text with {placeholders}, [optional parts], {param} (split user params), {paramRaw} (verbatim)
// {port+10} adds a number. Placeholders: name ip port queryPort map maxPlayers gslt param serverFiles appId
function value(key, cfg, ctx) {
  const m = /^(\w+)(?:\+(\d+))?$/.exec(key);
  if (!m) return '';
  let v = m[1] === 'serverFiles' ? ctx.serverFiles : m[1] === 'appId' ? ctx.appId : cfg[m[1]];
  if (v === undefined || v === null || String(v).trim() === '') return '';
  if (m[2]) { const n = parseInt(v, 10); return Number.isNaN(n) ? '' : String(n + parseInt(m[2], 10)); }
  return String(v);
}

/** returns string, or null when a required placeholder is empty */
function expandString(str, cfg, ctx) {
  // optional [ ... ] parts first (innermost, non-nested)
  let s = String(str).replace(/\[([^[\]]*)\]/g, (_, inner) => {
    const r = expandString(inner, cfg, ctx);
    return r === null ? '' : r;
  });
  let missing = false;
  s = s.replace(/\{([^{}]+)\}/g, (_, key) => {
    if (key === 'paramRaw') return cfg.param || '';
    const v = value(key, cfg, ctx);
    if (v === '') missing = true;
    return v;
  });
  return missing ? null : s;
}

function expandItem(item, cfg, ctx) {
  if (Array.isArray(item)) {
    const parts = item.map((x) => expandString(x, cfg, ctx));
    return parts.some((p) => p === null) ? [] : parts;
  }
  if (item === '{param}') return splitArgs(cfg.param);
  const r = expandString(item, cfg, ctx);
  return r === null || r === '' ? [] : [r];
}

// ---------- validation ---------------------------------------------------------------------------
const safeRel = (p) => typeof p === 'string' && p.length > 0 && !path.isAbsolute(p) && !/^[a-zA-Z]:/.test(p) && !p.split(/[\\/]/).includes('..');

function normalizeInstall(i) {
  if (!i) return null;
  if (Array.isArray(i.steps)) return i.steps;
  if (i.type === 'steamcmd') return [{ type: 'steamcmd', appId: i.appId, mod: i.mod, repeat: i.repeat }];
  if (i.type === 'manual') return [];
  if (i.type === 'script') return [{ type: 'script' }];
  return null;
}

/** Returns { errors:[], warnings:[] } */
function validate(m, dir) {
  const errors = []; const warnings = [];
  const e = (s) => errors.push(s); const w = (s) => warnings.push(s);
  if (!m || typeof m !== 'object') return { errors: ['plugin.json must be a JSON object'], warnings };
  if (!m.id || !ID_RE.test(m.id)) e('"id" must be 2-32 chars of a-z 0-9 _ -');
  if (!m.name) e('"name" is required');
  if (!m.description) w('"description" is empty (shown in the game browser)');
  if (!m.author) w('"author" is empty');
  if (!m.version) w('"version" is empty');
  const run = m.run || {};
  if (!run.exe) e('"run.exe" (path of the server executable, relative to the server files folder) is required');
  if (run.exe && !safeRel(run.exe)) e('"run.exe" must be a relative path without ".."');
  if (run.workingDir && !safeRel(run.workingDir)) e('"run.workingDir" must be a relative path without ".."');
  if (run.args !== undefined && !Array.isArray(run.args)) e('"run.args" must be an array');
  (run.args || []).forEach((a, i) => {
    const ok = typeof a === 'string' || (Array.isArray(a) && a.every((x) => typeof x === 'string'));
    if (!ok) e(`run.args[${i}] must be a string or an array of strings`);
  });
  const steps = normalizeInstall(m.install);
  if (!steps) e('"install" is required: { "type": "steamcmd", "appId": "..." } or { "type": "manual" } or { "steps": [...] }');
  else {
    steps.forEach((s, i) => {
      const at = `install.steps[${i}]`;
      if (!STEP_TYPES.includes(s.type)) return e(`${at}.type must be one of ${STEP_TYPES.join(', ')}`);
      if (s.type === 'steamcmd' && !/^\d+$/.test(String(s.appId || ''))) e(`${at}.appId must be a numeric Steam app id`);
      if (s.type === 'download' && (!s.url || !s.to)) e(`${at} (download) needs "url" and "to"`);
      if (s.type === 'extract' && (!s.from || !s.to)) e(`${at} (extract) needs "from" and "to"`);
      if (s.type === 'run' && !s.exe) e(`${at} (run) needs "exe"`);
      if (s.type === 'write' && (!s.path || s.content === undefined)) e(`${at} (write) needs "path" and "content"`);
      if (s.type === 'mkdir' && !s.path) e(`${at} (mkdir) needs "path"`);
      for (const k of ['to', 'from', 'path']) if (s[k] !== undefined && !safeRel(s[k]) && s[k] !== '.') e(`${at}.${k} must be a relative path without ".."`);
      if (s.type === 'script' && !(dir && fs.existsSync(path.join(dir, 'plugin.js')))) e(`${at} (script) needs a plugin.js with install()`);
    });
  }
  if (m.docs !== undefined) {
    if (!Array.isArray(m.docs)) e('"docs" must be an array of { title, url, type }');
    else m.docs.forEach((d, i) => {
      const at = `docs[${i}]`;
      if (!d || typeof d !== 'object') return e(`${at} must be an object`);
      if (!d.title || typeof d.title !== 'string') e(`${at}.title is required`);
      if (typeof d.url !== 'string' || !/^https?:\/\/[^\s]+$/i.test(d.url)) e(`${at}.url must be an http(s) link`);
      if (!DOC_TYPES.includes(d.type)) e(`${at}.type must be "official" or "unofficial"`);
      if (d.description !== undefined && typeof d.description !== 'string') e(`${at}.description must be text`);
    });
  } else w('no "docs" links (official / unofficial guides for creating this server)');
  if (m.metrics !== undefined) {
    if (!Array.isArray(m.metrics)) e('"metrics" must be an array');
    else {
      const seen = new Set(); const logIds = new Set((m.logs || []).map((l) => l.id));
      m.metrics.forEach((x, i) => {
        const at = `metrics[${i}]`;
        if (!x || typeof x !== 'object') return e(`${at} must be an object`);
        if (!x.id || !/^[a-z0-9_-]+$/i.test(x.id)) e(`${at}.id is required (letters, digits, _ -)`);
        else if (seen.has(x.id)) e(`${at}.id "${x.id}" is duplicated`);
        seen.add(x.id);
        if (!x.name) e(`${at}.name is required`);
        if (x.source !== 'console' && !/^log:[a-z0-9_-]+$/i.test(String(x.source))) e(`${at}.source must be "console" or "log:<id of a declared log>"`);
        else if (x.source !== 'console' && !logIds.has(String(x.source).slice(4))) e(`${at}.source refers to an undeclared log "${String(x.source).slice(4)}"`);
        try { const re = new RegExp(x.pattern); if (new RegExp(re.source + '|').exec('').length < 2) e(`${at}.pattern needs one capture group, e.g. "fps=([0-9.]+)"`); }
        catch { e(`${at}.pattern is not a valid regular expression`); }
        if (x.command !== undefined && typeof x.command !== 'string') e(`${at}.command must be text`);
        if (x.intervalSec !== undefined && !(Number(x.intervalSec) >= 2)) e(`${at}.intervalSec must be a number >= 2`);
      });
    }
  }
  if (m.query !== undefined && m.query !== null && !QUERIES.includes(m.query)) e(`"query" must be one of ${QUERIES.join(', ')} or null`);
  for (const [key, list] of [['configs', m.configs], ['logs', m.logs]]) {
    if (list === undefined) continue;
    if (!Array.isArray(list)) { e(`"${key}" must be an array`); continue; }
    const seen = new Set();
    list.forEach((x, i) => {
      const at = `${key}[${i}]`;
      if (!x.id || !/^[a-z0-9_-]+$/i.test(x.id)) e(`${at}.id is required (letters, digits, _ -)`);
      else if (seen.has(x.id)) e(`${at}.id "${x.id}" is duplicated`);
      seen.add(x.id);
      if (!x.name) e(`${at}.name is required`);
      if (!safeRel(x.path)) e(`${at}.path must be a relative path without ".." (wildcards * ? allowed in the file name)`);
      if (key === 'configs' && x.format && !FORMATS.includes(x.format)) e(`${at}.format must be one of ${FORMATS.join(', ')}`);
      if (key === 'configs' && x.template && dir && !fs.existsSync(path.join(dir, x.template))) w(`${at}.template "${x.template}" not found in the plugin folder`);
    });
  }
  if (dir) {
    const media = m.media || {};
    const need = [media.icon || 'icon.png'];
    if (media.banner) need.push(media.banner);
    if (media.readme) need.push(media.readme);
    (media.screenshots || []).forEach((s) => need.push(s));
    for (const f of need) {
      if (!safeRel(f)) e(`media path "${f}" must be relative without ".."`);
      else if (!fs.existsSync(path.join(dir, f))) (f === (media.icon || 'icon.png') ? w : e)(`media file "${f}" not found`);
    }
    if (!fs.existsSync(path.join(dir, 'README.md')) && !media.readme) w('no README.md (shown in the game browser and on the website)');
  }
  return { errors, warnings };
}

// ---------- build a game object ------------------------------------------------------------------
const readB64 = (f) => `data:image/${path.extname(f).slice(1).replace('jpg', 'jpeg')};base64,${fs.readFileSync(f).toString('base64')}`;

function toGame(m, dir, source) {
  const d = m.defaults || {};
  const run = m.run || {};
  const steps = normalizeInstall(m.install);
  let hooks = {};
  const js = path.join(dir, 'plugin.js');
  if (fs.existsSync(js)) { delete require.cache[require.resolve(js)]; hooks = require(js); }
  const media = m.media || {};
  const iconFile = path.join(dir, media.icon || 'icon.png');
  const items = run.args || ['{param}'];
  const steam = steps.find((s) => s.type === 'steamcmd');
  return {
    id: m.id, name: m.name, description: m.description || '', author: m.author || '', version: m.version || '', url: m.url || '',
    color: m.color || '', tags: m.tags || [], docs: Array.isArray(m.docs) ? m.docs : [], source, dir,
    icon: fs.existsSync(iconFile) ? readB64(iconFile) : null,
    media,
    appId: steam ? String(steam.appId) : null, steps, hooks,
    exe: run.exe, command: run.command || null, cwd: run.workingDir || '', stdin: run.stdin !== false, stopCommand: run.stopCommand || null,
    port: String(d.port || ''), queryPort: String(d.queryPort || d.port || ''), map: String(d.map || ''),
    maxPlayers: String(d.maxPlayers || ''), additional: String(d.additional || ''), portIncrement: d.portIncrement || 1,
    query: m.query || null, gslt: !!m.gslt,
    configs: m.configs || [], logs: m.logs || [], metrics: Array.isArray(m.metrics) ? m.metrics : [],
    args: hooks.args ? (c, ctx) => hooks.args(c, ctx) : (c, ctx) => items.flatMap((it) => expandItem(it, c, { appId: steam && steam.appId, ...ctx })),
  };
}

function loadDir(root, source, loaded, errors) {
  if (!fs.existsSync(root)) return;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('_') || e.name.startsWith('.')) continue;
    const dir = path.join(root, e.name);
    const mf = path.join(dir, 'plugin.json');
    if (!fs.existsSync(mf)) continue;
    try {
      const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
      const { errors: errs } = validate(m, dir);
      if (errs.length) throw new Error(errs.join('; '));
      const existing = byId(m.id);
      if (existing && existing.source === source) throw new Error(`id "${m.id}" is already used by ${existing.dir}`);
      const g = toGame(m, dir, source);
      if (existing) { GAMES.splice(GAMES.indexOf(existing), 1); g.overrides = true; }
      GAMES.push(g);
      loaded.push({ id: g.id, name: g.name, author: g.author, version: g.version, source, folder: e.name, overrides: !!g.overrides });
    } catch (err) { errors.push({ folder: e.name, source, error: err.message }); }
  }
}

function loadAll(userDir) {
  fs.mkdirSync(userDir, { recursive: true });
  GAMES.length = 0;
  const loaded = []; const errors = [];
  loadDir(BUNDLED_DIR, 'bundled', loaded, errors);
  loadDir(userDir, 'user', loaded, errors);
  GAMES.sort((a, b) => a.name.localeCompare(b.name));
  return { loaded, errors };
}

/** Install from a .zip file or a folder into the user plugins dir. Returns the plugin id. */
function installFrom(src, userDir) {
  fs.mkdirSync(userDir, { recursive: true });
  let tmp = src; let cleanup = null;
  if (fs.statSync(src).isFile()) {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nodegsm-plugin-'));
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
    const { errors } = validate(m, root);
    if (errors.length) throw new Error(errors.join('; '));
    const dest = path.join(userDir, m.id);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(root, dest, { recursive: true });
    return m.id;
  } finally { if (cleanup) cleanup(); }
}

/** Details for the in-app game browser (readme text + screenshots as data URLs) */
function detail(id) {
  const g = byId(id);
  if (!g) throw new Error('Unknown game');
  const m = g.media || {};
  const readmeFile = path.join(g.dir, m.readme || 'README.md');
  const rd = (f) => { try { return readB64(path.join(g.dir, f)); } catch { return null; } };
  return {
    id: g.id, name: g.name, description: g.description, author: g.author, version: g.version, url: g.url, tags: g.tags, source: g.source,
    docs: g.docs, appId: g.appId, port: g.port, queryPort: g.queryPort, maxPlayers: g.maxPlayers, query: g.query, overrides: !!g.overrides,
    icon: g.icon, banner: m.banner ? rd(m.banner) : null,
    readme: fs.existsSync(readmeFile) ? fs.readFileSync(readmeFile, 'utf8') : '',
    screenshots: (m.screenshots || []).map(rd).filter(Boolean),
    configs: g.configs.map(({ id: i, name, path: p, format, description }) => ({ id: i, name, path: p, format, description })),
    logs: g.logs.map(({ id: i, name, path: p, description }) => ({ id: i, name, path: p, description })),
    metrics: g.metrics.map(({ id: i, name, unit, source, command, description }) => ({ id: i, name, unit, source, command, description })),
  };
}

module.exports = { GAMES, byId, splitArgs, expandItem, expandString, loadAll, installFrom, validate, detail, safeRel, BUNDLED_DIR, STEP_TYPES, FORMATS };
