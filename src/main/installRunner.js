'use strict';
// Executes a plugin's install.steps in order. Everything is confined to the server files folder.
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const AdmZip = require('adm-zip');
const platform = require('./platform');

const UA = { 'User-Agent': 'NodeGSM' };

function get(url, headers = {}, redirects = 5) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers: { ...UA, ...headers } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).toString(), headers, redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      resolve(res);
    }).on('error', reject);
  });
}

async function fetchText(url, headers) {
  const res = await get(url, headers);
  return new Promise((resolve, reject) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(d)); res.on('error', reject); });
}
const fetchJson = async (url, headers) => JSON.parse(await fetchText(url, headers));

async function download(url, dest, onProgress) {
  const res = await get(url);
  const total = parseInt(res.headers['content-length'] || '0', 10);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    let done = 0;
    res.on('data', (c) => { done += c.length; if (onProgress && total) onProgress({ percent: (done / total) * 100, done, total }); });
    res.pipe(out);
    out.on('finish', () => out.close(resolve));
    out.on('error', reject); res.on('error', reject);
  });
  return dest;
}

function extract(file, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (/\.zip$/i.test(file)) { new AdmZip(file).extractAllTo(destDir, true); return; }
  // 7z, tar.gz, ... : Windows 10/11 ships bsdtar which reads these; Linux uses GNU tar (gzip is detected from the name)
  const win = platform.isWindows();
  const r = spawnSync('tar', win ? ['-xf', file, '-C', destDir] : platform.tarArgs(file, destDir), { windowsHide: true });
  if (r.status !== 0) throw new Error(`Could not extract ${path.basename(file)} (needs ${win ? 'Windows tar, or install 7-Zip' : 'tar'}): ${String(r.stderr || '').trim()}`);
}

/** Resolve a plugin-relative path inside the server files folder; refuses to escape it. */
function inside(dir, rel) {
  const root = path.resolve(dir);
  const p = path.resolve(root, rel);
  if (p !== root && !p.startsWith(root + path.sep)) throw new Error(`Path escapes the server folder: ${rel}`);
  return p;
}

const fill = (s, vars) => String(s).replace(/\{(\w+)\}/g, (_, k) => (vars[k] === undefined || vars[k] === null ? '' : String(vars[k])));

/**
 * @param {object} game  loaded plugin game object
 * @param {object} env   { dir, cfg, log, steam, onProgress }
 */
async function runInstall(game, env) {
  const { dir, cfg, log, steam, onProgress } = env;
  const validate = env.validate; const validateArgs = env.validateArgs || {};   // Update vs Validate (see PLUGINS.md: update.validateArgs)
  fs.mkdirSync(dir, { recursive: true });
  const vars = { ...cfg, serverFiles: dir, appId: game.appId };
  const helpers = {
    dir, cfg, log, validate: !!validate, validateArgs, fetchJson, fetchText, download: (u, d) => download(u, inside(dir, d), onProgress),
    extract: (f, d) => extract(inside(dir, f), inside(dir, d)), inside: (r) => inside(dir, r), path, fs,
    steamcmd: (appId, opts) => steam.install(dir, appId, { onProgress, ...opts }, log),
  };
  const steps = game.steps.slice();
  if (!steps.length && game.hooks.install) steps.push({ type: 'script' });
  let i = 0;
  for (const s of steps) {
    i += 1;
    log(`[step ${i}/${steps.length}] ${s.type}${s.appId ? ' ' + s.appId : s.url ? ' ' + fill(s.url, vars) : ''}`);
    if (s.type === 'steamcmd') {
      const code = await steam.install(dir, s.appId, { forcePlatform: s.platform, validate: s.validate !== false, validateArgs: validateArgs.steamcmd, mod: s.mod, repeat: s.repeat, beta: s.beta, onProgress }, log);
      if (code !== 0) throw new Error(`SteamCMD exited with code ${code} - the download did not complete`);
    } else if (s.type === 'download') {
      const to = inside(dir, fill(s.to, vars));
      await download(fill(s.url, vars), to, onProgress);
      if (s.extract) {
        extract(to, inside(dir, fill(s.extractTo || '.', vars)));
        if (s.deleteAfter !== false) fs.unlinkSync(to);
      }
    } else if (s.type === 'extract') {
      extract(inside(dir, fill(s.from, vars)), inside(dir, fill(s.to, vars)));
    } else if (s.type === 'run') {
      const exe = path.isAbsolute(s.exe) ? s.exe : inside(dir, fill(s.exe, vars));
      await new Promise((resolve, reject) => {
        platform.makeExecutable(exe);
        const p = spawn(exe, (s.args || []).map((a) => fill(a, vars)), { cwd: s.cwd ? inside(dir, s.cwd) : dir, windowsHide: true });
        const pipe = (st) => st.on('data', (d) => d.toString().split(/\r?\n/).filter(Boolean).forEach(log));
        pipe(p.stdout); pipe(p.stderr);
        p.on('error', reject);
        p.on('close', (c) => (c === 0 || s.ignoreExit ? resolve() : reject(new Error(`${path.basename(exe)} exited with code ${c}`))));
      });
    } else if (s.type === 'write') {
      const f = inside(dir, fill(s.path, vars));
      if (s.overwrite || !fs.existsSync(f)) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, fill(s.content, vars)); }
    } else if (s.type === 'mkdir') {
      fs.mkdirSync(inside(dir, fill(s.path, vars)), { recursive: true });
    } else if (s.type === 'script') {
      if (!game.hooks.install) throw new Error('plugin.js has no install()');
      await game.hooks.install(helpers);
    }
  }
}

module.exports = { runInstall, download, extract, fetchJson, fetchText, inside };
