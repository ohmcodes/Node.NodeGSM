'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { spawn, spawnSync, execFile } = require('child_process');
const { EventEmitter } = require('events');
const AdmZip = require('adm-zip');
const cronParser = require('cron-parser');
const { GAMES, byId } = require('./plugins');
const { SteamCMD } = require('./steamcmd');
const { runInstall, fetchJson, fetchText } = require('./installRunner');
const { LogTail } = require('./logTail');
const { query } = require('./query');

const MAX_SERVERS = 100;
const CONSOLE_LINES = 2000;

const DEFAULTS = {
  game: '', name: '', ip: '', port: '', queryPort: '', map: '', maxPlayers: '', gslt: '', param: '',
  autoRestart: false, autoStart: false, autoUpdate: false, updateOnStart: false, backupOnStart: false,
  discordAlert: false, discordWebhook: '', discordMessage: '',
  restartCrontab: false, crontabFormat: '0 6 * * *',
  autoStartAlert: true, autoRestartAlert: true, autoUpdateAlert: true, restartCrontabAlert: true, crashAlert: true,
  cpuPriority: 'Normal', cpuAffinity: '', installDir: '', // installDir: custom location for imported servers
};

const PRIORITY = { Idle: 19, BelowNormal: 10, Normal: 0, AboveNormal: -7, High: -14, RealTime: -20 };

class ServerManager extends EventEmitter {
  constructor(dataDir) {
    super();
    this.dir = dataDir;
    this.serversDir = path.join(dataDir, 'servers');
    this.backupsDir = path.join(dataDir, 'backups');
    this.settingsFile = path.join(dataDir, 'settings.json');
    fs.mkdirSync(this.serversDir, { recursive: true });
    fs.mkdirSync(this.backupsDir, { recursive: true });
    this.steam = new SteamCMD(dataDir);
    this.pluginsDir = path.join(dataDir, 'plugins');
    this.pluginInfo = require('./plugins').loadAll(this.pluginsDir);
    this.logTail = new LogTail();
    this.logTail.on('lines', (m) => this.emit('logLines', m));
    this.runtime = new Map(); // id -> { proc, console:[], status, startedAt, stopping, busy }
    this.timers = [];
    this.settings = this.loadSettings();
  }

  reloadPlugins() { this.pluginInfo = require('./plugins').loadAll(this.pluginsDir); return this.pluginInfo; }
  installPlugin(src) { const id = require('./plugins').installFrom(src, this.pluginsDir); this.reloadPlugins(); return id; }

  // ---------- settings / paths ----------
  loadSettings() { return require('./settings').read(this.dir); }
  saveSettings(patch) {
    this.settings = { ...this.settings, ...require('./settings').sanitize(patch) };
    fs.writeFileSync(this.settingsFile, JSON.stringify(this.settings, null, 2));
    return this.settings;
  }
  serverRoot(id) { return path.join(this.serversDir, String(id)); }
  cfgFile(id) { return path.join(this.serverRoot(id), 'configs', 'wgsm.json'); }
  filesDir(id) { const c = this.getConfig(id); return c && c.installDir ? c.installDir : path.join(this.serverRoot(id), 'serverfiles'); }

  // ---------- config CRUD ----------
  ids() {
    try {
      return fs.readdirSync(this.serversDir).filter((d) => /^\d+$/.test(d) && fs.existsSync(this.cfgFile(d))).sort((a, b) => a - b);
    } catch { return []; }
  }
  getConfig(id) {
    try { return { id: String(id), ...DEFAULTS, ...JSON.parse(fs.readFileSync(this.cfgFile(id), 'utf8')) }; } catch { return null; }
  }
  saveConfig(id, patch) {
    const cur = this.getConfig(id) || { ...DEFAULTS };
    const next = { ...cur, ...patch };
    delete next.id;
    fs.mkdirSync(path.dirname(this.cfgFile(id)), { recursive: true });
    fs.writeFileSync(this.cfgFile(id), JSON.stringify(next, null, 2));
    return this.getConfig(id);
  }
  nextId() {
    for (let i = 1; i <= MAX_SERVERS; i++) if (!fs.existsSync(this.serverRoot(i))) return String(i);
    throw new Error('Maximum number of servers reached');
  }
  /** Suggest a free port (game default + increments) */
  suggestPort(game, field = 'port') {
    const used = new Set();
    for (const id of this.ids()) { const c = this.getConfig(id); used.add(+c.port); used.add(+c.queryPort); }
    let p = parseInt(game[field], 10);
    const inc = game.portIncrement || 1;
    while (used.has(p)) p += inc;
    return String(p);
  }

  list() {
    return this.ids().map((id) => this.view(id));
  }
  view(id) {
    const c = this.getConfig(id);
    const rt = this.runtime.get(String(id));
    const g = byId(c.game);
    return {
      ...c,
      gameName: g ? g.name : c.game,
      icon: g ? g.icon : null,
      status: rt ? rt.status : 'Stopped',
      pid: rt && rt.proc ? rt.proc.pid : null,
      startedAt: rt ? rt.startedAt : null,
      players: rt ? rt.players : null,
      maxPlayersLive: rt ? rt.maxPlayersLive : null,
      liveMap: rt && rt.queryInfo ? rt.queryInfo.map || null : null,
      restarts: rt ? rt.restarts || 0 : 0,
      pending: rt && rt.busy ? rt.busy : null,
      progress: rt && rt.busy ? rt.progress || null : null,
      ip_display: c.ip || '0.0.0.0',
    };
  }
  setStatus(id, status, extra = {}) {
    const rt = this.rt(id);
    rt.status = status;
    Object.assign(rt, extra);
    this.emit('status', this.view(id));
  }
  rt(id) {
    id = String(id);
    if (!this.runtime.has(id)) this.runtime.set(id, { proc: null, console: [], status: 'Stopped', startedAt: null, stopping: false, busy: null, players: null });
    return this.runtime.get(id);
  }
  log(id, line) {
    const rt = this.rt(id);
    const lines = String(line).split(/\r?\n/).filter((l) => l.length);
    for (const l of lines) {
      rt.console.push(l);
      if (rt.console.length > CONSOLE_LINES) rt.console.shift();
      this.emit('console', { id: String(id), line: l });
    }
  }
  getConsole(id) { return this.rt(id).console.slice(); }

  // ---------- create / install / import / delete ----------
  create(gameId, name, extra = {}) {
    const g = byId(gameId);
    if (!g) throw new Error(`Unknown game: ${gameId}`);
    const id = this.nextId();
    const cfg = this.saveConfig(id, {
      ...DEFAULTS, game: gameId, name: name || g.name, port: this.suggestPort(g, 'port'), queryPort: this.suggestPort(g, 'queryPort'),
      map: g.map, maxPlayers: g.maxPlayers, param: g.additional, ...extra,
    });
    fs.mkdirSync(this.filesDir(id), { recursive: true });
    return cfg;
  }

  /** Run the plugin's install steps. mode: 'install' (all steps) | 'update' (steamcmd steps only when the game has one). */
  async runSteps(id, { validate = true, mode = 'install' } = {}) {
    const g = byId(this.getConfig(id).game);
    const rt = this.rt(id);
    const steam = g.steps.some((x) => x.type === 'steamcmd');
    let steps = g.steps;
    if (mode === 'update' && steam) steps = steps.filter((x) => x.type === 'steamcmd');
    steps = steps.map((x) => (x.type === 'steamcmd' ? { ...x, validate } : x));
    const onProgress = (p) => { rt.progress = p; this.emit('status', this.view(id)); };
    try {
      await runInstall({ ...g, steps }, { dir: this.filesDir(id), cfg: this.getConfig(id), log: (l) => this.log(id, l), steam: this.steam, onProgress });
    } finally { rt.progress = null; }
  }

  async install(id) {
    const c = this.getConfig(id);
    const g = byId(c.game);
    const rt = this.rt(id);
    if (rt.busy) throw new Error(`Busy: ${rt.busy}`);
    rt.busy = 'Installing';
    this.setStatus(id, 'Installing');
    const log = (l) => this.log(id, l);
    try {
      if (!g.steps.length && !g.hooks.install) throw new Error('This game has no automatic installer. Use "Import" to point NodeGSM at an existing install.');
      await this.runSteps(id, { validate: true, mode: 'install' });
      if (!fs.existsSync(path.join(this.filesDir(id), g.exe))) throw new Error(`Install incomplete: ${g.exe} was not found in ${this.filesDir(id)}. Run Install/Verify again.`);
      log('Install finished.');
      return true;
    } catch (e) {
      log(`Install failed: ${e.message}`);
      throw e;
    } finally {
      rt.busy = null;
      this.setStatus(id, 'Stopped');
    }
  }

  /** Import an existing server directory (no copy: points installDir at it) */
  importServer(gameId, name, dir) {
    const g = byId(gameId);
    if (!g) throw new Error('Unknown game');
    if (!fs.existsSync(path.join(dir, g.exe))) throw new Error(`Invalid path: ${g.exe} not found in ${dir}`);
    return this.create(gameId, name, { installDir: dir });
  }

  async remove(id, deleteFiles = true) {
    if (this.isRunning(id)) await this.stop(id);
    const c = this.getConfig(id);
    if (!c) return false;
    if (deleteFiles) {
      // Imported installs are never deleted, only the managed folder.
      fs.rmSync(this.serverRoot(id), { recursive: true, force: true });
    } else {
      fs.rmSync(path.join(this.serverRoot(id), 'configs'), { recursive: true, force: true });
    }
    // Keep the backups of a deleted server, but move them aside so a new server that reuses this id doesn't inherit them.
    const bdir = path.join(this.backupsDir, String(id));
    if (fs.existsSync(bdir)) { try { fs.renameSync(bdir, path.join(this.backupsDir, `${id}.deleted-${Date.now()}`)); } catch { /* keep */ } }
    this.logTail.stopAll(id);
    this.runtime.delete(String(id));
    this.emit('removed', String(id));
    return true;
  }

  // ---------- start / stop ----------
  isRunning(id) { const rt = this.runtime.get(String(id)); return !!(rt && rt.proc && rt.status !== 'Stopped'); }

  buildLaunch(id) {
    const c = this.getConfig(id);
    const g = byId(c.game);
    const dir = this.filesDir(id);
    const ctx = { serverFiles: dir };
    const cmd = g.command || path.join(dir, g.exe);
    const args = g.args(c, ctx).filter((a) => a !== undefined && a !== '');
    return { cmd, args, cwd: g.cwd ? path.join(dir, g.cwd) : dir, g, c };
  }

  async start(id) {
    id = String(id);
    const c = this.getConfig(id);
    if (!c) throw new Error('Server not found');
    const rt = this.rt(id);
    if (rt.proc) throw new Error('Server already running');
    if (rt.busy) throw new Error(`Busy: ${rt.busy}`);
    const g = byId(c.game);
    if (c.backupOnStart) { try { await this.backup(id); } catch (e) { this.log(id, `Backup failed: ${e.message}`); } }
    if (c.updateOnStart && g.appId) await this.update(id).catch((e) => this.log(id, `Update failed: ${e.message}`));

    const { cmd, args, cwd } = this.buildLaunch(id);
    const exePath = path.join(this.filesDir(id), g.exe);
    if (!fs.existsSync(exePath)) { const m = `${g.exe} not found (${exePath}). Install the server first.`; this.log(id, m); throw new Error(m); }
    this.log(id, `> ${path.basename(cmd)} ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);

    this.setStatus(id, 'Started', { startedAt: Date.now(), stopping: false, players: null });
    let proc;
    try {
      proc = spawn(cmd, args, { cwd, windowsHide: true, stdio: [g.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsVerbatimArguments: false });
    } catch (e) { this.setStatus(id, 'Stopped'); throw e; }
    rt.proc = proc;
    this.emit('status', this.view(id)); // the first Started event fired before the process existed: announce the PID now
    const pipe = (s) => { s.setEncoding('utf8'); s.on('data', (d) => this.log(id, d)); };
    pipe(proc.stdout); pipe(proc.stderr);
    proc.on('error', (e) => { this.log(id, `Process error: ${e.message}`); });
    proc.on('exit', (code) => this.onExit(id, proc, code));
    this.applyPriority(id, proc.pid);
    this.alert(id, 'autoStartAlert', 'Server started');
    return this.view(id);
  }

  onExit(id, proc, code) {
    const rt = this.rt(id);
    if (rt.proc !== proc) return;
    rt.proc = null;
    const c = this.getConfig(id);
    const crashed = !rt.stopping;
    this.log(id, `Server exited (code ${code}).`);
    this.setStatus(id, 'Stopped', { startedAt: null, players: null });
    if (!c) return;
    if (crashed) {
      this.alert(id, 'crashAlert', `Server crashed (exit code ${code})`);
      if (c.autoRestart) {
        rt.restarts = (rt.restarts || 0) + 1;
        this.log(id, 'Auto-restarting in 5s ...');
        setTimeout(() => { if (!this.rt(id).proc && !this.rt(id).stopping) this.start(id).then(() => this.alert(id, 'autoRestartAlert', 'Server auto-restarted')).catch((e) => this.log(id, e.message)); }, 5000);
      }
    }
  }

  async stop(id) {
    id = String(id);
    const rt = this.rt(id);
    const proc = rt.proc;
    if (!proc) return this.view(id);
    const g = byId(this.getConfig(id).game);
    rt.stopping = true;
    this.setStatus(id, 'Stopping');
    const exited = new Promise((res) => proc.once('exit', res));
    const graceful = g.stopCommand || 'quit';
    try { if (proc.stdin && proc.stdin.writable) proc.stdin.write(graceful + '\n'); } catch {}
    // soft taskkill (WM_CLOSE to windows), then hard kill
    spawnSync('taskkill', ['/PID', String(proc.pid), '/T'], { windowsHide: true });
    const timeout = new Promise((res) => setTimeout(res, 15000, 'timeout'));
    if ((await Promise.race([exited, timeout])) === 'timeout') {
      spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true });
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    }
    return this.view(id);
  }

  /** Force-kill the whole process tree immediately (no graceful stop). */
  async kill(id) {
    id = String(id);
    const rt = this.rt(id); const proc = rt.proc;
    if (!proc) return this.view(id);
    rt.stopping = true;
    this.setStatus(id, 'Stopping');
    const exited = new Promise((res) => proc.once('exit', res));
    spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true });
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    return this.view(id);
  }

  /**
   * Run one action on several servers. Returns [{ id, ok, skipped?, error? }].
   * stop / restart / kill run in parallel; start / update / backup run one after another
   * (SteamCMD and disk-heavy work should not overlap).
   */
  async bulk(action, ids) {
    const list = [...new Set((ids || []).map(String))].filter((i) => this.getConfig(i));
    const running = (id) => this.isRunning(id);
    const busy = (id) => { const b = this.rt(id).busy; if (b) throw new Error(`Busy: ${b}`); };
    const actions = {
      start: async (id) => { if (running(id)) return 'skipped'; busy(id); await this.start(id); },
      stop: async (id) => { if (!running(id)) return 'skipped'; await this.stop(id); },
      restart: async (id) => { if (!running(id)) return 'skipped'; busy(id); await this.restart(id); },
      kill: async (id) => { if (!running(id)) return 'skipped'; await this.kill(id); },
      update: async (id) => { busy(id); await this.update(id, false); },
      backup: async (id) => { busy(id); await this.backup(id); },
    };
    const fn = actions[action];
    if (!fn) throw new Error(`Unknown action: ${action}`);
    const one = async (id) => {
      try { const r = await fn(id); return r === 'skipped' ? { id, ok: true, skipped: true } : { id, ok: true }; }
      catch (e) { this.log(id, `${action} failed: ${e.message}`); return { id, ok: false, error: e.message }; }
    };
    if (['stop', 'restart', 'kill'].includes(action)) return Promise.all(list.map(one));
    const out = [];
    for (const id of list) { out.push(await one(id)); if (action === 'start') await new Promise((r) => setTimeout(r, 1000)); }
    return out;
  }

  async restart(id) {
    await this.stop(id);
    await new Promise((r) => setTimeout(r, 1000));
    return this.start(id);
  }

  sendCommand(id, text, { silent = false } = {}) {
    const rt = this.rt(id);
    if (!rt.proc || !rt.proc.stdin || !rt.proc.stdin.writable) throw new Error('Console input is not available for this server');
    rt.proc.stdin.write(text + '\n');
    if (!silent) this.log(id, `> ${text}`);
  }

  // ---------- CPU priority / affinity ----------
  applyPriority(id, pid) {
    const c = this.getConfig(id);
    try { os.setPriority(pid, PRIORITY[c.cpuPriority] ?? 0); } catch (e) { this.log(id, `Priority: ${e.message}`); }
    if (c.cpuAffinity && /^[01]+$/.test(c.cpuAffinity)) {
      // cpuAffinity as bit string e.g. "1100" => cores 3,2 ; convert to mask
      const mask = parseInt(c.cpuAffinity, 2);
      execFile('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).ProcessorAffinity = ${mask}`], { windowsHide: true }, () => {});
    }
  }

  // ---------- update ----------
  async checkUpdate(id) {
    const c = this.getConfig(id);
    const g = byId(c.game);
    if (g.appId) {
      const local = this.steam.getLocalBuild(this.filesDir(id), g.appId);
      const remote = await this.steam.getRemoteBuild(g.appId);
      return { local, remote, available: !!(local && remote && local !== remote) };
    }
    if (g.hooks.latest && g.hooks.local) {
      const local = await g.hooks.local(this.filesDir(id)); const remote = await g.hooks.latest({ fetchJson, fetchText });
      return { local, remote, available: !!(local && remote && local !== remote) };
    }
    return { local: null, remote: null, available: false };
  }

  async update(id, validate = false) {
    id = String(id);
    const rt = this.rt(id);
    const wasRunning = !!rt.proc;
    if (rt.busy) throw new Error(`Busy: ${rt.busy}`);
    if (wasRunning) await this.stop(id);
    rt.busy = 'Updating';
    this.setStatus(id, 'Updating');
    try {
      await this.runSteps(id, { validate, mode: 'update' });
      this.log(id, 'Update finished.');
    } finally {
      rt.busy = null;
      this.setStatus(id, 'Stopped');
    }
    if (wasRunning) await this.start(id);
  }

  // ---------- backup / restore ----------
  backupList(id) {
    const d = path.join(this.backupsDir, String(id));
    try {
      return fs.readdirSync(d).filter((f) => f.endsWith('.zip')).map((f) => {
        const s = fs.statSync(path.join(d, f));
        return { file: f, size: s.size, time: s.mtimeMs };
      }).sort((a, b) => b.time - a.time);
    } catch { return []; }
  }
  async backup(id) {
    id = String(id);
    const d = path.join(this.backupsDir, id);
    fs.mkdirSync(d, { recursive: true });
    const src = this.filesDir(id);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(d, `backup-${stamp}.zip`);
    this.log(id, 'Backing up server files ...');
    const rt = this.rt(id);
    const prev = rt.busy; rt.busy = 'Backing up'; this.emit('status', this.view(id));
    try {
      const zip = new AdmZip();
      zip.addLocalFolder(src);
      await new Promise((res, rej) => zip.writeZip(file, (e) => (e ? rej(e) : res())));
    } finally { rt.busy = prev; this.emit('status', this.view(id)); }
    this.log(id, `Backup created: ${path.basename(file)}`);
    return path.basename(file);
  }
  async restore(id, file) {
    id = String(id);
    const f = path.join(this.backupsDir, id, path.basename(file));
    if (!fs.existsSync(f)) throw new Error('Backup not found');
    if (this.isRunning(id)) await this.stop(id);
    this.log(id, `Restoring ${path.basename(file)} ...`);
    new AdmZip(f).extractAllTo(this.filesDir(id), true);
    this.log(id, 'Restore finished.');
  }
  deleteBackup(id, file) { fs.rmSync(path.join(this.backupsDir, String(id), path.basename(file)), { force: true }); }

  // ---------- Discord ----------
  alert(id, flag, message) {
    const c = this.getConfig(id);
    if (!c || !c.discordAlert || !c.discordWebhook || !c[flag]) return;
    const body = JSON.stringify({
      username: 'NodeGSM',
      embeds: [{ title: message, description: c.discordMessage || undefined, color: flag === 'crashAlert' ? 0xe74c3c : 0x2ecc71,
        fields: [{ name: 'Server', value: `#${id} ${c.name}`, inline: true }, { name: 'Game', value: (byId(c.game) || {}).name || c.game, inline: true }],
        timestamp: new Date().toISOString() }],
    });
    try {
      const u = new URL(c.discordWebhook);
      const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } });
      req.on('error', () => {}); req.end(body);
    } catch { /* invalid webhook */ }
  }

  // ---------- Windows firewall ----------
  firewall(id, enable = true) {
    const c = this.getConfig(id);
    const name = `NodeGSM #${id} ${c.name}`;
    const ports = [...new Set([c.port, c.queryPort].filter(Boolean))].join(',');
    spawnSync('netsh', ['advfirewall', 'firewall', 'delete', 'rule', `name=${name}`], { windowsHide: true });
    if (!enable) return { ok: true };
    let ok = true;
    for (const proto of ['TCP', 'UDP']) {
      const r = spawnSync('netsh', ['advfirewall', 'firewall', 'add', 'rule', `name=${name}`, 'dir=in', 'action=allow', `protocol=${proto}`, `localport=${ports}`], { windowsHide: true });
      if (r.status !== 0) ok = false;
    }
    return { ok, message: ok ? `Opened ports ${ports}` : 'Failed - run the app as Administrator to modify the firewall' };
  }

  // ---------- Mods / files ----------
  listDir(id, rel = '') {
    const root = path.resolve(this.filesDir(id));
    const target = path.resolve(root, rel);
    if (!target.startsWith(root)) throw new Error('Invalid path');
    return fs.readdirSync(target, { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory() }));
  }
  readTextFile(id, rel) {
    const root = path.resolve(this.filesDir(id));
    const target = path.resolve(root, rel);
    if (!target.startsWith(root)) throw new Error('Invalid path');
    if (fs.statSync(target).size > 2 * 1024 * 1024) throw new Error('File too large to edit (2MB limit)');
    return fs.readFileSync(target, 'utf8');
  }
  writeTextFile(id, rel, text) {
    const root = path.resolve(this.filesDir(id));
    const target = path.resolve(root, rel);
    if (!target.startsWith(root)) throw new Error('Invalid path');
    fs.writeFileSync(target, text);
  }

  // ---------- plugin-declared config files ----------
  pluginPath(id, rel) {
    const root = path.resolve(this.filesDir(id));
    const p = path.resolve(root, rel);
    if (p !== root && !p.startsWith(root + path.sep)) throw new Error('Invalid path');
    return p;
  }
  cfgDef(id, cid) {
    const g = byId(this.getConfig(id).game);
    const def = g.configs.find((x) => x.id === cid);
    if (!def) throw new Error('Unknown config file');
    return { g, def, file: this.pluginPath(id, def.path) };
  }
  configList(id) {
    const g = byId(this.getConfig(id).game);
    return g.configs.map((d) => {
      const f = this.pluginPath(id, d.path);
      const ex = fs.existsSync(f);
      return { id: d.id, name: d.name, path: d.path, format: d.format || 'text', description: d.description || '', exists: ex, size: ex ? fs.statSync(f).size : 0, hasTemplate: !!d.template };
    });
  }
  readConfig(id, cid) {
    const { def, file } = this.cfgDef(id, cid);
    if (!fs.existsSync(file)) return { id: cid, name: def.name, format: def.format || 'text', path: def.path, exists: false, text: '' };
    if (fs.statSync(file).size > 2 * 1024 * 1024) throw new Error('File too large to edit (2MB limit)');
    return { id: cid, name: def.name, format: def.format || 'text', path: def.path, exists: true, text: fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '') };
  }
  writeConfig(id, cid, text) {
    const { def, file } = this.cfgDef(id, cid);
    if ((def.format || 'text') === 'json') {
      try { JSON.parse(text); } catch (e) { throw new Error(`Not valid JSON: ${e.message}`); }
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak'); // keep one backup of the previous version
    fs.writeFileSync(file, text);
    return true;
  }
  createConfig(id, cid) {
    const { g, def, file } = this.cfgDef(id, cid);
    if (fs.existsSync(file)) return true;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (def.template) {
      const t = path.resolve(g.dir, def.template);
      if (!t.startsWith(path.resolve(g.dir) + path.sep)) throw new Error('Invalid template path');
      fs.copyFileSync(t, file);
    } else fs.writeFileSync(file, def.format === 'json' ? '{}\n' : '');
    return true;
  }

  // ---------- plugin-declared logs (live view) ----------
  logsList(id) {
    const g = byId(this.getConfig(id).game);
    return this.logTail.list(path.resolve(this.filesDir(id)), g.logs);
  }
  logStart(id, logId) {
    const g = byId(this.getConfig(id).game);
    const def = g.logs.find((x) => x.id === logId);
    if (!def) throw new Error('Unknown log');
    return this.logTail.start(id, logId, path.resolve(this.filesDir(id)), def.path);
  }
  logStop(id, logId) { this.logTail.stop(id, logId); }

  // ---------- Scheduler / monitoring ----------
  startScheduler() {
    // status polling (query + process liveness) every 15s
    this.timers.push(setInterval(() => this.pollAll(), 15000));
    // crontab every minute
    this.timers.push(setInterval(() => this.cronTick(), 60000));
    // auto-update every 30 min
    this.timers.push(setInterval(() => this.autoUpdateTick(), 30 * 60 * 1000));
  }
  stopScheduler() { this.timers.forEach(clearInterval); this.timers = []; }

  async pollAll() {
    for (const id of this.ids()) {
      const rt = this.rt(id);
      if (!rt.proc || rt.status === 'Stopping') continue;
      const c = this.getConfig(id); const g = byId(c.game);
      if (!g.query) continue;
      const info = await query(g.query, c.ip, c.queryPort || c.port, 2500);
      const status = info ? 'Started' : 'Starting';
      rt.players = info ? info.players : null; rt.maxPlayersLive = info ? info.maxPlayers : null; rt.queryInfo = info || null;
      if (rt.status !== status && rt.status !== 'Updating') this.setStatus(id, status);
      else this.emit('status', this.view(id));
    }
  }

  cronTick(now = new Date()) {
    for (const id of this.ids()) {
      const c = this.getConfig(id);
      if (!c.restartCrontab || !c.crontabFormat || !this.isRunning(id)) continue;
      try {
        const it = cronParser.parseExpression(c.crontabFormat, { currentDate: new Date(now.getTime() - 60000) });
        const nx = it.next().toDate();
        if (Math.abs(nx.getTime() - now.getTime()) < 60000 && nx.getMinutes() === now.getMinutes()) {
          this.log(id, 'Scheduled restart (crontab).');
          this.alert(id, 'restartCrontabAlert', 'Scheduled restart');
          this.restart(id).catch((e) => this.log(id, e.message));
        }
      } catch (e) { this.log(id, `Invalid crontab: ${e.message}`); }
    }
  }

  async autoUpdateTick() {
    for (const id of this.ids()) {
      const c = this.getConfig(id);
      if (!c.autoUpdate || this.rt(id).busy) continue;
      try {
        const r = await this.checkUpdate(id);
        if (r.available) {
          this.log(id, `Update available (${r.local} -> ${r.remote}). Updating ...`);
          this.alert(id, 'autoUpdateAlert', `Updating ${r.local} -> ${r.remote}`);
          await this.update(id);
        }
      } catch (e) { this.log(id, `Auto-update check failed: ${e.message}`); }
    }
  }

  /** Called on app launch: start servers flagged autoStart */
  async autoStartAll() {
    for (const id of this.ids()) {
      if (this.getConfig(id).autoStart) { try { await this.start(id); } catch (e) { this.log(id, e.message); } }
    }
  }

  async shutdown() {
    this.stopScheduler();
    this.logTail.shutdown();
    await Promise.all([...this.runtime.keys()].filter((id) => this.rt(id).proc).map((id) => this.stop(id)));
  }

  metrics() {
    const mem = { total: os.totalmem(), free: os.freemem() };
    return { cpuCount: os.cpus().length, load: os.loadavg(), mem, uptime: os.uptime() };
  }
}

module.exports = { ServerManager, GAMES, DEFAULTS, PRIORITY };
