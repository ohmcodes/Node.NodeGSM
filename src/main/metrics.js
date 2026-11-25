'use strict';
// Dashboard metrics: system CPU / memory / disk, per-server CPU / memory / players / uptime (the whole process tree),
// and plugin-declared metrics (FPS, tick rate ...) read from the console or a log with a regex.
const os = require('os');
const fs = require('fs');
const path = require('path');
const platform = require('./platform');
const { EventEmitter } = require('events');
const { byId } = require('./plugins');
const { LogTail } = require('./logTail');
const tickUtil = require('../renderer/tick');   // shared with the renderer (colours, number parsing, header aggregate)

const HISTORY = 360;              // points kept (5 s apart = 30 minutes)
const DEFAULT_STALE_MS = 120000;
const LATENCY_FRESH_MS = 60000;   // the query round trip counts as 'latency' for this long after the last poll

const readProcesses = () => platform.readProcesses();   // win32: PowerShell CIM, Linux: /proc (see platform.js)

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
    this.tail = new LogTail(); this.tailing = new Set(); this.cmdTimers = new Map(); this.inflight = new Set(); this.pollErrors = new Map();
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
    if (!this.compiled.has(m)) {
      // patternFlags (optional) replaces the default "i"; g / y are dropped (a stateful regex would skip matches)
      try { this.compiled.set(m, new RegExp(m.pattern, typeof m.patternFlags === 'string' ? m.patternFlags.replace(/[gy]/g, '') : 'i')); } catch { this.compiled.set(m, null); }
    }
    return this.compiled.get(m);
  }
  /** Match one line / text against a metric; stores the value (first capture group) when it parses. Tick metrics are colour-stripped and parsed tolerantly. */
  record(id, m, line) {
    const tick = m.kind === 'tick';
    const re = this.regex(m); const r = re && re.exec(tick ? tickUtil.stripColours(line) : line);
    if (!r || r[1] === undefined) return false;
    const v = tick ? tickUtil.parseTickNumber(r[1]) : parseFloat(String(r[1]).replace(',', '.'));
    if (Number.isNaN(v)) return false;
    this.custom.set(`${id}:${m.id}`, { value: v, t: Date.now() });
    return true;
  }
  feed(id, source, line) {
    const c = this.mgr.getConfig(id); const g = c && byId(c.game);
    if (!g || !g.metrics.length) return;
    for (const m of g.metrics) if (m.source === source) this.record(id, m, line);
  }
  /** source "rcon:<command>": send the command through the server's RCON (silently) and read the first matching line of the reply. */
  async pollRcon(id, m) {
    const key = `${id}:${m.id}`; const cs = this.mgr._consoles;
    if (!cs || this.inflight.has(key) || !this.mgr.isRunning(id)) return false;
    this.inflight.add(key);
    try {
      const out = await cs.poll(id, m.source.slice(5), { consoleId: m.rconConsole, source: m.rconSource });
      this.pollErrors.delete(key);
      for (const line of String(out).split(/\r?\n/)) if (this.record(id, m, line)) return true;
      return false;
    } catch (e) { this.pollErrors.set(key, e.message); return false; }   // messages never contain the password
    finally { this.inflight.delete(key); }
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
      const every = Math.max(2, Number(m.intervalSec) || 10) * 1000;
      if (m.source.startsWith('rcon:')) {
        if (up && !this.cmdTimers.has(key)) this.cmdTimers.set(key, setInterval(() => { this.pollRcon(id, m).catch(() => {}); }, every));
        else if (!up && this.cmdTimers.has(key)) { clearInterval(this.cmdTimers.get(key)); this.cmdTimers.delete(key); }
      } else if (m.command) {
        if (up && !this.cmdTimers.has(key)) {
          this.cmdTimers.set(key, setInterval(() => { try { if (this.mgr.rt(id).proc) this.mgr.sendCommand(id, m.command, { silent: true }); } catch { /* no stdin */ } }, every));
        } else if (!up && this.cmdTimers.has(key)) { clearInterval(this.cmdTimers.get(key)); this.cmdTimers.delete(key); }
      }
      if (!up) this.custom.delete(key);
    }
  }
  customFor(id, g, now) {
    const out = {};
    for (const m of g.metrics) {
      const e = this.custom.get(`${id}:${m.id}`);
      if (!e || now - e.t > (Number(m.staleSec) || 120) * 1000) continue;
      const entry = { value: e.value, unit: m.unit || '' };
      if (m.kind === 'tick') { entry.kind = 'tick'; entry.cls = tickUtil.classify(e.value, m); entry.higherIsBetter = m.higherIsBetter !== false; }
      out[`m:${m.id}`] = entry;
    }
    return out;
  }
  /** Row summary of the first available tick metric of a server ({ id, name, value, unit, cls, higherIsBetter, target }) or null. */
  tickOf(g, metrics) {
    for (const m of g.metrics) {
      const e = m.kind === 'tick' && metrics[`m:${m.id}`];
      if (e) return { id: `m:${m.id}`, name: m.name, value: e.value, unit: e.unit, cls: e.cls, higherIsBetter: e.higherIsBetter, target: Number(m.tickTarget) || null };
    }
    return null;
  }
  /** Built-in fallback for games without a tick metric: the query round trip (ms), clearly named Latency, never "tick". */
  latencyFor(id, g, now) {
    if (g && g.metrics.some((m) => m.kind === 'tick')) return null;
    const l = this.mgr.rt(id).latency;
    return l && now - l.t <= LATENCY_FRESH_MS ? { value: l.ms, unit: 'ms', kind: 'latency', higherIsBetter: false } : null;
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
        for (const m of (g && g.metrics) || []) if (!defs.has(`m:${m.id}`)) defs.set(`m:${m.id}`, { id: `m:${m.id}`, name: m.name, unit: m.unit || '', ...(m.kind === 'tick' ? { kind: 'tick', higherIsBetter: m.higherIsBetter !== false } : {}) });
        const row = {
          id: v.id, name: v.name, game: v.game, gameName: v.gameName, icon: v.icon, status: v.status, pid: v.pid || null,
          ip: v.ip_display, port: v.port, queryPort: v.queryPort, players: v.players, maxPlayers: v.maxPlayersLive || v.maxPlayers,
          map: v.liveMap || v.map || '', restarts: v.restarts || 0, uptime: v.startedAt ? now - v.startedAt : null,
          cpu: null, mem: null, threads: null, metrics: g ? this.customFor(v.id, g, now) : {}, tick: null,
        };
        if (g) {
          row.tick = this.tickOf(g, row.metrics);
          const lat = v.pid ? this.latencyFor(v.id, g, now) : null;
          if (lat) { row.metrics.latency = lat; if (!defs.has('latency')) defs.set('latency', { id: 'latency', name: 'Latency', unit: 'ms', kind: 'latency', higherIsBetter: false }); }
        }
        if (v.pid) online++;
        if (v.pid && table) {
          const t = treeTotals(table, v.pid);
          const prev = this.prevProc.get(v.id);
          if (prev && now > prev.t && t.cpuTime >= prev.cpuTime) row.cpu = Math.min(100, ((t.cpuTime - prev.cpuTime) / 1e7) / ((now - prev.t) / 1000) / this.cores * 100);
          else row.cpu = prev ? 0 : null;
          this.prevProc.set(v.id, { cpuTime: t.cpuTime, t: now });
          row.mem = t.mem; row.threads = t.threads;
        } else if (!v.pid) this.prevProc.delete(v.id);
        if (v.pid) { point.players += v.players || 0; point.s[v.id] = { p: v.players || 0, c: row.cpu || 0, m: row.mem || 0, ...(row.tick ? { k: row.tick.value } : {}), ...(row.metrics.latency ? { l: row.metrics.latency.value } : {}) }; }
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
