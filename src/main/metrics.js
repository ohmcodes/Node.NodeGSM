'use strict';
// Dashboard metrics: system CPU / memory / disk, per-server CPU / memory / players / uptime (the whole process tree),
// and plugin-declared metrics (FPS, tick rate ...) read from the console or a log with a regex.
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');
const { byId } = require('./plugins');
const { LogTail } = require('./logTail');

const HISTORY = 360;              // points kept (5 s apart = 30 minutes)
const DEFAULT_STALE_MS = 120000;

/** One PowerShell call returns every process; we sum each server's process tree. */
function readProcesses() {
  return new Promise((resolve) => {
    const cmd = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,UserModeTime,ThreadCount | ConvertTo-Csv -NoTypeInformation';
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 20000 }, (err, out) => {
      if (err) return resolve(null);
      const rows = [];
      for (const line of String(out).split(/\r?\n/).slice(1)) {
        const f = line.match(/"([^"]*)"/g);
        if (!f || f.length < 6) continue;
        const n = f.map((x) => Number(x.slice(1, -1)) || 0);
        rows.push({ pid: n[0], ppid: n[1], mem: n[2], cpuTime: n[3] + n[4], threads: n[5] });
      }
      resolve(rows);
    });
  });
}

function treeTotals(rows, rootPid) {
  const kids = new Map();
  for (const r of rows) { if (!kids.has(r.ppid)) kids.set(r.ppid, []); kids.get(r.ppid).push(r); }
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const seen = new Set(); const stack = [rootPid]; const t = { mem: 0, cpuTime: 0, threads: 0, procs: 0 };
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const r = byPid.get(pid);
    if (r) { t.mem += r.mem; t.cpuTime += r.cpuTime; t.threads += r.threads; t.procs++; }
    for (const k of kids.get(pid) || []) stack.push(k.pid);
  }
  return t;
}

class MetricsCollector extends EventEmitter {
  constructor(mgr, { intervalMs = 5000, maxServers = 100, readProcs = readProcesses } = {}) {
    super();
    this.mgr = mgr; this.intervalMs = intervalMs; this.maxServers = maxServers; this.readProcs = readProcs;
    this.cores = os.cpus().length;
    this.history = []; this.last = null; this.busy = false; this.timer = null;
    this.prevSys = null; this.prevProc = new Map();   // id -> { cpuTime, t }
    this.custom = new Map();                          // "<id>:<metric>" -> { value, t }
    this.compiled = new Map();                        // metric object -> RegExp
    this.tail = new LogTail(); this.tailing = new Set(); this.cmdTimers = new Map();
    this.onConsole = ({ id, line }) => this.feed(id, 'console', line);
    this.onStatus = (v) => this.syncSources(v);
    this.tail.on('lines', ({ id, logId, lines }) => lines.forEach((l) => this.feed(id, `log:${logId.replace(/^m:/, '')}`, l)));
  }

  start() {
    this.mgr.on('console', this.onConsole);
    this.mgr.on('status', this.onStatus);
    this.timer = setInterval(() => this.tick().catch(() => {}), this.intervalMs);
    this.tick().catch(() => {});
  }
  stop() {
    clearInterval(this.timer); this.timer = null;
    this.mgr.off('console', this.onConsole); this.mgr.off('status', this.onStatus);
    this.tail.shutdown(); for (const t of this.cmdTimers.values()) clearInterval(t); this.cmdTimers.clear();
  }

  // ---------- plugin metrics ----------
  regex(m) {
    if (!this.compiled.has(m)) { try { this.compiled.set(m, new RegExp(m.pattern, 'i')); } catch { this.compiled.set(m, null); } }
    return this.compiled.get(m);
  }
  feed(id, source, line) {
    const c = this.mgr.getConfig(id); const g = c && byId(c.game);
    if (!g || !g.metrics.length) return;
    for (const m of g.metrics) {
      if (m.source !== source) continue;
      const re = this.regex(m); const r = re && re.exec(line);
      if (!r || r[1] === undefined) continue;
      const v = parseFloat(String(r[1]).replace(',', '.'));
      if (!Number.isNaN(v)) this.custom.set(`${id}:${m.id}`, { value: v, t: Date.now() });
    }
  }
  /** Start/stop log tails and command timers as servers start and stop. */
  syncSources(v) {
    const id = String(v.id); const c = this.mgr.getConfig(id); const g = c && byId(c.game);
    if (!g || !g.metrics.length) return;
    const up = v.status !== 'Stopped';
    for (const m of g.metrics) {
      const key = `${id}:${m.id}`;
      if (m.source.startsWith('log:')) {
        const def = g.logs.find((l) => l.id === m.source.slice(4));
        if (up && def && !this.tailing.has(key)) {
          this.tailing.add(key);
          try { this.tail.start(id, `m:${m.source.slice(4)}`, path.resolve(this.mgr.filesDir(id)), def.path); } catch { this.tailing.delete(key); }
        } else if (!up && this.tailing.has(key)) { this.tailing.delete(key); this.tail.stop(id, `m:${m.source.slice(4)}`); }
      }
      if (m.command) {
        if (up && !this.cmdTimers.has(key)) {
          this.cmdTimers.set(key, setInterval(() => { try { if (this.mgr.rt(id).proc) this.mgr.sendCommand(id, m.command, { silent: true }); } catch { /* no stdin */ } }, Math.max(2, Number(m.intervalSec) || 10) * 1000));
        } else if (!up && this.cmdTimers.has(key)) { clearInterval(this.cmdTimers.get(key)); this.cmdTimers.delete(key); }
      }
      if (!up) this.custom.delete(key);
    }
  }
  customFor(id, g, now) {
    const out = {};
    for (const m of g.metrics) {
      const e = this.custom.get(`${id}:${m.id}`);
      if (e && now - e.t <= (Number(m.staleSec) || 120) * 1000) out[`m:${m.id}`] = { value: e.value, unit: m.unit || '' };
    }
    return out;
  }

  // ---------- system ----------
  system() {
    const cpus = os.cpus(); let idle = 0; let total = 0;
    for (const c of cpus) { idle += c.times.idle; total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq; }
    let pct = 0;
    if (this.prevSys && total > this.prevSys.total) pct = (1 - (idle - this.prevSys.idle) / (total - this.prevSys.total)) * 100;
    this.prevSys = { idle, total };
    const memTotal = os.totalmem(); const memUsed = memTotal - os.freemem();
    let disk = null;
    try {
      const st = fs.statfsSync(this.mgr.dir);
      disk = { drive: path.parse(path.resolve(this.mgr.dir)).root.replace(/\\$/, ''), total: st.blocks * st.bsize, used: (st.blocks - st.bavail) * st.bsize };
    } catch { /* statfs unavailable */ }
    return { cpuModel: (cpus[0] && cpus[0].model || '').replace(/\s+/g, ' ').trim(), cores: cpus.length, cpuPercent: Math.max(0, Math.min(100, pct)), memTotal, memUsed, disk };
  }

  // ---------- one sample ----------
  async tick() {
    if (this.busy) return this.last;
    this.busy = true;
    try {
      const now = Date.now();
      const sys = this.system();
      const views = this.mgr.list();
      const running = views.filter((v) => v.pid);
      const table = running.length ? await this.readProcs() : null;
      const defs = new Map(); const rows = []; const point = { t: now, cpu: sys.cpuPercent, mem: sys.memUsed, players: 0, s: {} };
      let online = 0;
      for (const v of views) {
        const g = byId(v.game);
        for (const m of (g && g.metrics) || []) if (!defs.has(`m:${m.id}`)) defs.set(`m:${m.id}`, { id: `m:${m.id}`, name: m.name, unit: m.unit || '' });
        const row = {
          id: v.id, name: v.name, game: v.game, gameName: v.gameName, icon: v.icon, status: v.status, pid: v.pid || null,
          ip: v.ip_display, port: v.port, queryPort: v.queryPort, players: v.players, maxPlayers: v.maxPlayersLive || v.maxPlayers,
          map: v.liveMap || v.map || '', restarts: v.restarts || 0, uptime: v.startedAt ? now - v.startedAt : null,
          cpu: null, mem: null, threads: null, metrics: g ? this.customFor(v.id, g, now) : {},
        };
        if (v.pid) online++;
        if (v.pid && table) {
          const t = treeTotals(table, v.pid);
          const prev = this.prevProc.get(v.id);
          if (prev && now > prev.t && t.cpuTime >= prev.cpuTime) row.cpu = Math.min(100, ((t.cpuTime - prev.cpuTime) / 1e7) / ((now - prev.t) / 1000) / this.cores * 100);
          else row.cpu = prev ? 0 : null;
          this.prevProc.set(v.id, { cpuTime: t.cpuTime, t: now });
          row.mem = t.mem; row.threads = t.threads;
        } else if (!v.pid) this.prevProc.delete(v.id);
        if (v.pid) { point.players += v.players || 0; point.s[v.id] = { p: v.players || 0, c: row.cpu || 0, m: row.mem || 0 }; }
        rows.push(row);
      }
      const snapshot = {
        t: now, system: sys,
        game: { installed: views.length, max: this.maxServers, online, players: point.players },
        defs: [...defs.values()], servers: rows,
      };
      this.last = snapshot;
      this.history.push(point); if (this.history.length > HISTORY) this.history.shift();
      this.emit('metrics', { snapshot, point });
      return snapshot;
    } finally { this.busy = false; }
  }

  state() { return { snapshot: this.last, history: this.history }; }
}

module.exports = { MetricsCollector, treeTotals, readProcesses };
