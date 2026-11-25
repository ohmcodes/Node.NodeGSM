'use strict';
// Live log viewer backend: tails files declared in a plugin's "logs" list.
// Supports wildcards in the file name (newest match wins, so rotating logs keep working).
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const INITIAL_BYTES = 64 * 1024;
const MAX_CHUNK = 1024 * 1024;

function globToRegex(glob) {
  return new RegExp('^' + glob.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
}

/** Resolve "dir/sub/*.log" (wildcards only in the file name) to the newest existing file, or null. */
function resolveLog(root, rel) {
  const full = path.resolve(root, rel);
  if (full !== path.resolve(root) && !full.startsWith(path.resolve(root) + path.sep)) return null;
  const dir = path.dirname(full); const base = path.basename(full);
  if (!/[*?]/.test(base)) return fs.existsSync(full) && fs.statSync(full).isFile() ? full : null;
  try {
    const re = globToRegex(base);
    const hits = fs.readdirSync(dir).filter((f) => re.test(f)).map((f) => {
      const p = path.join(dir, f); const st = fs.statSync(p);
      return st.isFile() ? { p, t: st.mtimeMs } : null;
    }).filter(Boolean).sort((a, b) => b.t - a.t);
    return hits.length ? hits[0].p : null;
  } catch { return null; }
}

function decode(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.slice(2).toString('utf16le');
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.slice(3).toString('utf8');
  return buf.toString('utf8');
}

class LogTail extends EventEmitter {
  constructor() { super(); this.subs = new Map(); }

  list(root, logs) {
    return logs.map((l) => {
      const f = resolveLog(root, l.path);
      let size = null; let mtime = null;
      if (f) { const st = fs.statSync(f); size = st.size; mtime = st.mtimeMs; }
      return { id: l.id, name: l.name, path: l.path, description: l.description || '', file: f ? path.relative(root, f) : null, size, mtime };
    });
  }

  /** Start tailing. Emits 'lines' {id, logId, reset, lines[]}. Returns the initial lines. */
  start(serverId, logId, root, rel) {
    const key = `${serverId}:${logId}`;
    this.stop(serverId, logId);
    const sub = { file: null, pos: 0, partial: '', timer: null, serverId, logId };
    const initial = this.poll(sub, root, rel, true);
    sub.timer = setInterval(() => {
      const r = this.poll(sub, root, rel, false);
      if (r.lines.length || r.reset) this.emit('lines', { id: String(serverId), logId, reset: r.reset, file: sub.file ? path.relative(root, sub.file) : null, lines: r.lines });
    }, 1000);
    this.subs.set(key, sub);
    return { file: sub.file ? path.relative(root, sub.file) : null, lines: initial.lines };
  }

  poll(sub, root, rel, first) {
    const f = resolveLog(root, rel);
    if (!f) { const had = !!sub.file; sub.file = null; sub.pos = 0; return { lines: [], reset: had }; }
    let reset = false;
    if (f !== sub.file) { sub.file = f; sub.pos = 0; sub.partial = ''; reset = !first; first = true; }
    let st;
    try { st = fs.statSync(f); } catch { return { lines: [], reset }; }
    if (st.size < sub.pos) { sub.pos = 0; sub.partial = ''; reset = true; first = true; } // truncated/rotated in place
    let start = sub.pos;
    if (first && st.size > INITIAL_BYTES) start = st.size - INITIAL_BYTES;
    if (st.size - start > MAX_CHUNK) start = st.size - MAX_CHUNK;
    if (st.size <= start) { sub.pos = st.size; return { lines: [], reset }; }
    const fd = fs.openSync(f, 'r');
    try {
      const buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      sub.pos = st.size;
      const text = (first ? '' : sub.partial) + decode(buf);
      const parts = text.split(/\r?\n/);
      sub.partial = parts.pop();
      if (first && start > 0) parts.shift(); // first line is probably cut in half
      return { lines: parts, reset };
    } finally { fs.closeSync(fd); }
  }

  stop(serverId, logId) {
    const key = `${serverId}:${logId}`;
    const s = this.subs.get(key);
    if (s) { clearInterval(s.timer); this.subs.delete(key); }
  }
  stopAll(serverId) {
    for (const [k, s] of this.subs) if (String(s.serverId) === String(serverId)) { clearInterval(s.timer); this.subs.delete(k); }
  }
  shutdown() { for (const s of this.subs.values()) clearInterval(s.timer); this.subs.clear(); }
}

module.exports = { LogTail, resolveLog, globToRegex, decode };
