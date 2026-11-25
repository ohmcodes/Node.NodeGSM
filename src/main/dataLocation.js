'use strict';
// Where NodeGSM keeps its data (servers, backups, settings, downloads).
//
// The chosen folder is remembered in a tiny text file that lives OUTSIDE the data folder (the setting itself is stored in the
// data folder, so it cannot say where the data folder is):
//   Windows: %APPDATA%\NodeGSM\data-location.txt      other: ~/.config/NodeGSM/data-location.txt
// The installer writes the same file, so "choose a data folder" during setup and "Change..." in Settings are one mechanism.
//
// Moving never deletes anything: the data is copied, the pointer is switched and NodeGSM restarts. The old folder stays until
// the user removes it.
const fs = require('fs');
const path = require('path');
const os = require('os');

const POINTER_NAME = 'data-location.txt';
const isWin = (p) => p === 'win32' || p === 'windows';

function pointerPath({ platform = process.platform, env = process.env, appData, home = os.homedir() } = {}) {
  if (isWin(platform)) return path.join(appData || env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'NodeGSM', POINTER_NAME);
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'NodeGSM', POINTER_NAME);
}

/** The folder written in the pointer file, or null (no file, empty, or not an absolute path). */
function readPointer(o = {}) {
  try {
    const first = fs.readFileSync(pointerPath(o), 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)[0].trim();
    return first && path.isAbsolute(first) ? first : null;
  } catch { return null; }
}
function writePointer(dir, o = {}) {
  const f = pointerPath(o);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, `${dir}\n`);
}

const samePath = (a, b) => path.relative(path.resolve(a), path.resolve(b)) === '';
const isInside = (parent, child) => { const r = path.relative(path.resolve(parent), path.resolve(child)); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };

/** Files and bytes under dir (symlinks are counted as `skipped`, they are never followed). */
async function scan(dir, ignore = () => false) {
  const out = { files: 0, bytes: 0, skipped: 0 };
  async function walk(d) {
    let ents;
    try { ents = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (ignore(p)) continue;
      if (e.isSymbolicLink()) { out.skipped++; continue; }
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) { try { out.bytes += (await fs.promises.stat(p)).size; out.files++; } catch { /* vanished */ } }
    }
  }
  await walk(dir);
  return out;
}

const nearestExisting = (p) => { let d = path.resolve(p); while (!fs.existsSync(d)) { const up = path.dirname(d); if (up === d) break; d = up; } return d; };
function freeBytes(p) { try { const s = fs.statfsSync(nearestExisting(p)); return s.bavail * s.bsize; } catch { return null; } }

/** A target is usable when it does not exist yet, or is an empty folder (the pointer file may sit in it). */
async function targetEmpty(dir) {
  try { return (await fs.promises.readdir(dir)).filter((n) => n !== POINTER_NAME).length === 0; } catch (e) { return e.code === 'ENOENT'; }
}

/**
 * Check a planned change. Returns { ok, error?, files, bytes, skipped, free, mode }.
 *   mode 'copy' - copy `from` into the (empty) `to`;  mode 'use' - `to` already holds NodeGSM data, just point at it.
 */
async function plan({ from, to, mode = 'copy', busy = false }) {
  const fail = (error) => ({ ok: false, error });
  if (typeof to !== 'string' || !to.trim()) return fail('Choose a folder.');
  if (!path.isAbsolute(to)) return fail('The folder must be a full path such as D:\\NodeGSM-data.');
  if (samePath(from, to)) return fail('That is already the data folder.');
  if (busy) return fail('Stop all servers (and wait for installs and updates to finish) before changing the data folder.');
  if (mode === 'use') {
    const has = fs.existsSync(path.join(to, 'settings.json')) || fs.existsSync(path.join(to, 'servers'));
    return has ? { ok: true, mode, files: 0, bytes: 0, skipped: 0, free: null } : fail('That folder does not contain NodeGSM data (no settings.json or servers folder).');
  }
  if (isInside(from, to)) return fail('The new folder cannot be inside the current data folder.');
  if (isInside(to, from)) return fail('The new folder cannot contain the current data folder.');
  if (fs.existsSync(to) && !fs.statSync(to).isDirectory()) return fail('That path is a file, not a folder.');
  if (!(await targetEmpty(to))) return fail('That folder is not empty. Choose an empty folder, or use "Use existing data" if it already holds NodeGSM data.');
  const s = await scan(from);
  const free = freeBytes(to);
  const need = Math.ceil(s.bytes * 1.05) + 50 * 1024 * 1024;
  if (free !== null && free < need) return fail(`Not enough free space: ${(s.bytes / 1e9).toFixed(2)} GB to copy, ${(free / 1e9).toFixed(2)} GB free.`);
  return { ok: true, mode, ...s, free };
}

/** Copy `from` into `to` (async, reports progress). Removes what it copied if anything fails. */
async function copyTree(from, to, onProgress = () => {}) {
  const total = await scan(from);
  const made = []; let done = 0; let n = 0; let last = 0;
  const existed = fs.existsSync(to);
  async function walk(src, dst) {
    await fs.promises.mkdir(dst, { recursive: true });
    for (const e of await fs.promises.readdir(src, { withFileTypes: true })) {
      const s = path.join(src, e.name); const d = path.join(dst, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) await walk(s, d);
      else if (e.isFile()) {
        await fs.promises.copyFile(s, d);
        made.push(d); n++;
        try { done += (await fs.promises.stat(d)).size; } catch { /* ignore */ }
        if (Date.now() - last > 250) { last = Date.now(); onProgress({ files: n, totalFiles: total.files, bytes: done, totalBytes: total.bytes }); }
      }
    }
  }
  try {
    await walk(from, to);
    onProgress({ files: n, totalFiles: total.files, bytes: done, totalBytes: total.bytes, done: true });
    return { files: n, bytes: done, skipped: total.skipped };
  } catch (err) {
    if (!existed) fs.rmSync(to, { recursive: true, force: true });
    else for (const name of fs.readdirSync(to)) if (name !== POINTER_NAME) fs.rmSync(path.join(to, name), { recursive: true, force: true });
    throw err;
  }
}

/**
 * Do the move: validate, copy (mode 'copy'), then switch the pointer. The caller restarts the app afterwards.
 * Returns { from, to, files, bytes, skipped }.
 */
async function relocate({ from, to, mode = 'copy', busy = false, pointerOpts = {}, onProgress }) {
  const p = await plan({ from, to, mode, busy });
  if (!p.ok) throw new Error(p.error);
  const r = mode === 'use' ? { files: 0, bytes: 0, skipped: 0 } : await copyTree(from, to, onProgress);
  writePointer(path.resolve(to), pointerOpts);
  return { from: path.resolve(from), to: path.resolve(to), ...r };
}

module.exports = { POINTER_NAME, pointerPath, readPointer, writePointer, plan, copyTree, relocate, scan, samePath, isInside };
