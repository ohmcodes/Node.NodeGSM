'use strict';
// Injected consoles: the plugin's consoles[] (besides the game's own process console).
//   type "process"  the game console (stdin/stdout of the server process, always available as id "main")
//   type "log"      read-only tail of a plugin logs[] entry (source = log id)
//   type "rcon"     Source RCON (also Minecraft, Factorio ...): source = "rcon:<port>:<password>"; WebSocket RCON (Rust): "webrcon:<port>:<password>"; see parseRconSource()
// Output reaches the renderer through the 'consoleOut' event: { id, consoleId, lines[], reset?, file? }.
const { RconClient } = require('../rcon');
const { WebRconClient } = require('../webrcon');
const configEdit = require('../configEdit');

const MAX_COMMAND = 4096;
const RCON_IDLE_CLOSE_MS = 5 * 60 * 1000;
const MAX_BATCH = 20;   // commands in one scheduled job
const MAX_QUICK = 30;   // quick-command buttons per console
/** Value of a start-parameter option: "+rcon.port 28016", "-rcon.port 28016", "rcon.port=28016" (quotes around the value are removed). */
function paramValue(param, name) {
  const toks = String(param || '').match(/"[^"]*"|'[^']*'|\S+/g) || [];
  const strip = (t) => (/^(["']).*\1$/.test(t) ? t.slice(1, -1) : t);
  const want = String(name).toLowerCase();
  for (let i = 0; i < toks.length; i++) {
    const bare = toks[i].replace(/^[-+]+/, '');
    const eq = bare.indexOf('=');
    if (eq > 0 && bare.slice(0, eq).toLowerCase() === want) return strip(bare.slice(eq + 1));
    if (bare.toLowerCase() === want && i + 1 < toks.length && !/^[-+]/.test(toks[i + 1])) return strip(toks[i + 1]);
  }
  return undefined;
}

const SETTING_KEYS = ['port', 'queryPort', 'maxPlayers', 'map', 'ip'];   // server settings that may be used as {placeholders}; secrets such as gslt are not exposed

/**
 * Parse "rcon:<port>:<password>" (Source RCON) or "webrcon:<port>:<password>" (WebSocket RCON). Each part is a literal or a {placeholder}:
 *   {port} / {queryPort} / {maxPlayers} / {map} / {ip}   server settings
 *   {param:name}                                         value of "name" in the server's start parameters ("+name value", "-name value" or "name=value")
 *   {configId:key}                                       value of "key" in the plugin config file "configId"
 *   {key}                                                value of "key" in the first plugin config file that has it
 * The password is the rest of the text after the second ":" and may itself contain ":".
 * Returns { web, port, password } (raw tokens), or throws.
 */
function parseRconSource(src) {
  const m = /^(web)?rcon:(\{[^}]+\}|\d{1,5}):(.*)$/s.exec(String(src || ''));
  if (!m) throw new Error('Invalid RCON source (expected rcon:<port>:<password> or webrcon:<port>:<password>)');
  return { web: !!m[1], port: m[2], password: m[3] };
}

/** The plugin's quick-command buttons of a console: [{ label, command, confirm }] (text only, capped). */
function quickCommands(d) {
  return (Array.isArray(d.commands) ? d.commands : []).filter((c) => c && typeof c.label === 'string' && typeof c.command === 'string' && c.command.trim())
    .slice(0, MAX_QUICK).map((c) => ({ label: c.label.slice(0, 40), command: c.command.slice(0, MAX_COMMAND), confirm: c.confirm === true }));
}

class Consoles {
  constructor(mgr, plugins, settings, dataDir) {
    this.mgr = mgr; this.plugins = plugins; this.dataDir = dataDir;
    this.clients = new Map();   // "<server>:<console>" -> { client, last }
    this.logSubs = new Map();   // "<server>:<console>" -> log id
    this.started = false; this.timer = null; this.onLines = null;
    mgr._consoles = this;
  }

  start() {
    if (this.started) return; this.started = true;
    // re-emit tailed lines of log consoles as consoleOut events
    this.onLines = (m) => {
      for (const [key, logId] of this.logSubs) {
        const [sid, cid] = key.split(':');
        if (sid === String(m.id) && logId === m.logId) this.mgr.emit('consoleOut', { id: sid, consoleId: cid, reset: !!m.reset, file: m.file || null, lines: m.lines });
      }
    };
    this.mgr.on('logLines', this.onLines);
    this.timer = setInterval(() => this.sweep(), 60000); if (this.timer.unref) this.timer.unref();
    this._onRemoved = (id) => this.closeServer(id); this.mgr.on('removed', this._onRemoved);
  }
  stop() {
    if (!this.started) return; this.started = false;
    clearInterval(this.timer); this.mgr.off('logLines', this.onLines); this.mgr.off('removed', this._onRemoved);
    for (const k of [...this.clients.keys()]) this.drop(k);
    for (const k of [...this.logSubs.keys()]) this.stopLog(k.split(':')[0], k.split(':')[1]);
  }

  game(id) { const c = this.mgr.getConfig(id); if (!c) throw new Error('Server not found'); const g = this.plugins.byId(c.game); if (!g) throw new Error('Game plugin not installed'); return { c, g }; }

  /** [{ id, name, type, readOnly }] - "main" (the game console) first. Sources are never returned (they may name secrets). */
  list(id) {
    const { g } = this.game(id);
    const decl = (g.consoles || []);
    const proc = decl.find((x) => x.type === 'process');
    const out = [{ id: 'main', name: proc ? proc.name : 'Game console', type: 'process', readOnly: false }];
    for (const x of decl) {
      if (x.type === 'process' || x.id === 'main') continue;
      out.push({ id: x.id, name: x.name, type: x.type, readOnly: x.type === 'log', commands: x.type === 'rcon' ? quickCommands(x) : [] });
    }
    return out;
  }
  def(id, consoleId) {
    const { g } = this.game(id);
    const d = (g.consoles || []).find((x) => x.id === consoleId && x.type !== 'process');
    if (!d) throw new Error('Unknown console');
    return d;
  }

  // ---------- RCON ----------
  /** Resolve the placeholders of an rcon source against server settings and config files. Never returns anything to the renderer. */
  resolveRcon(id, source) {
    const tok = parseRconSource(source);
    const { c, g } = this.game(id);
    const cache = new Map();
    const fileFor = (cid) => { if (!cache.has(cid)) { try { const r = this.mgr.readConfig(id, cid); cache.set(cid, r.exists ? r : null); } catch { cache.set(cid, null); } } return cache.get(cid); };
    const value = (t) => {
      const m = /^\{([^}]+)\}$/.exec(t); if (!m) return t;
      const name = m[1].trim();
      if (/^param:/i.test(name)) {
        const pn = name.slice(6).trim(); const v = paramValue(c.param, pn);
        if (v === undefined || v === '') throw new Error('RCON: "' + pn + '" was not found in the start parameters of this server');
        return v;
      }
      if (name.includes(':')) {
        const [cid, ...rest] = name.split(':'); const key = rest.join(':');
        const def = g.configs.find((x) => x.id === cid); if (!def) throw new Error(`RCON: unknown config file "${cid}"`);
        const f = fileFor(cid); const v = f ? configEdit.get(def.format || 'text', f.text, key) : undefined;
        if (v === undefined) throw new Error(`RCON: "${key}" was not found in ${def.path} (is the setting enabled and the file saved?)`);
        return v;
      }
      if (SETTING_KEYS.includes(name)) { if (c[name] === '' || c[name] == null) throw new Error(`RCON: server setting "${name}" is empty`); return String(c[name]); }
      for (const def of g.configs) {
        const f = fileFor(def.id); const v = f ? configEdit.get(def.format || 'text', f.text, name) : undefined;
        if (v !== undefined) return v;
      }
      throw new Error(`RCON: "${name}" was not found in any config file of this game`);
    };
    const port = Number(value(tok.port));
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('RCON: the port is not a valid number');
    return { web: tok.web, port, password: value(tok.password) };
  }

  client(id, consoleId) { return this.clientFor(id, `${id}:${consoleId}`, this.def(id, consoleId).source); }
  /** Pooled client for an rcon source ("rcon:<port>:<password>" with placeholders), one per pool key. */
  clientFor(id, key, source) {
    const { web, port, password } = this.resolveRcon(id, source);
    let e = this.clients.get(key);
    // settings may have changed (new password / port): reconnect when they differ
    if (e && (e.port !== port || e.pw !== password || e.web !== web)) { this.drop(key); e = null; }
    if (!e) {
      const Client = web ? WebRconClient : RconClient;
      e = { client: new Client({ host: '127.0.0.1', port, password, ...(this.rconOpts || {}) }), port, web, pw: password, last: Date.now() };
      Object.defineProperty(e, 'pw', { enumerable: false, value: password });
      this.clients.set(key, e);
    }
    e.last = Date.now();
    return e.client;
  }
  drop(key) { const e = this.clients.get(key); if (e) { try { e.client.close(); } catch { /* ignore */ } this.clients.delete(key); } }
  closeServer(id) { for (const k of [...this.clients.keys()]) if (k.startsWith(`${id}:`)) this.drop(k); for (const k of [...this.logSubs.keys()]) if (k.startsWith(`${id}:`)) this.stopLog(id, k.split(':')[1]); }
  sweep() { const now = Date.now(); for (const [k, e] of this.clients) if (now - e.last > RCON_IDLE_CLOSE_MS) this.drop(k); }

  // ---------- commands ----------
  /** Run a command in a console. main -> server stdin; rcon -> RCON; log -> refused. Resolves { output }. */
  async command(id, consoleId, text) {
    text = String(text == null ? '' : text);
    if (!text.trim()) throw new Error('Empty command');
    if (Buffer.byteLength(text, 'utf8') > MAX_COMMAND) throw new Error(`Command too long (limit ${MAX_COMMAND} bytes)`);
    if (consoleId === 'main' || consoleId === undefined || consoleId === null || consoleId === '') { this.mgr.sendCommand(id, text); return { output: '' }; }
    const d = this.def(id, consoleId);
    if (d.type === 'log') throw new Error('This console is read-only');
    if (d.type !== 'rcon') throw new Error('This console does not accept commands');
    if (!this.mgr.isRunning(id)) throw new Error('The server is not running');
    const key = `${id}:${consoleId}`;
    let out;
    try { out = await this.client(id, consoleId).send(text); }
    catch (e) { this.drop(key); throw new Error(e.message); }   // a dead connection is re-opened by the next command
    this.mgr.emitEvent('server:command', id, { command: text, silent: false, console: consoleId });
    const lines = out.split(/\r?\n/).filter((l, i, a) => l.length || i < a.length - 1);
    this.mgr.emit('consoleOut', { id: String(id), consoleId, lines: [`> ${text}`, ...lines] });
    return { output: out };
  }

  /**
   * Silent RCON command for metrics polling (tick): no console output, no event-log entry (so polling never floods the log
   * and the command is never echoed). Uses the rcon console `consoleId`, else the first declared rcon console, else the inline
   * `source` ("rcon:<port>:<password>"). Resolves the response text; errors never contain the password.
   */
  async poll(id, command, { consoleId, source } = {}) {
    command = String(command == null ? '' : command);
    if (!command.trim()) throw new Error('Empty command');
    if (!this.mgr.isRunning(id)) throw new Error('The server is not running');
    let key; let client;
    if (source) { key = `${id}:~poll`; client = this.clientFor(id, key, source); }
    else {
      const { g } = this.game(id);
      const d = (g.consoles || []).find((x) => x.type === 'rcon' && (!consoleId || x.id === consoleId));
      if (!d) throw new Error('This game declares no RCON console');
      key = `${id}:${d.id}`; client = this.client(id, d.id);
    }
    try { return await client.send(command); } catch (e) { this.drop(key); throw new Error(e.message); }
  }

  /** Id of the game's first rcon console, or null. */
  rconConsoleId(id) { const { g } = this.game(id); const d = (g.consoles || []).find((x) => x.type === 'rcon'); return d ? d.id : null; }

  /**
   * Run a command for automation (scheduled commands): through the rcon console consoleId (default: the first one), else the
   * game's own console (stdin). Shows up in the console and the event log like a typed command.
   */
  async run(id, text, consoleId, { waitSec = 1 } = {}) {
    const cid = consoleId || this.rconConsoleId(id) || 'main';
    // one command per line (like several arguments of mcrcon); a pause between them (mcrcon -w), none after the last
    const lines = String(text == null ? '' : text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, MAX_BATCH);
    if (!lines.length) throw new Error('Empty command');
    const wait = Math.min(Math.max(Number(waitSec) || 0, 0), 600) * 1000;
    let out = '';
    for (let i = 0; i < lines.length; i++) {
      if (i > 0 && wait) await new Promise((r) => setTimeout(r, wait));
      const r = await this.command(id, cid, lines[i]); out = (r && r.output) || '';
    }
    return { output: out };
  }

  // ---------- log consoles ----------
  /** Start tailing a log console. Returns { file, lines }. Subsequent lines arrive as consoleOut events. */
  startLog(id, consoleId) {
    const d = this.def(id, consoleId);
    if (d.type !== 'log') throw new Error('Not a log console');
    this.logSubs.set(`${id}:${consoleId}`, d.source);
    return this.mgr.logStart(id, d.source);
  }
  stopLog(id, consoleId) {
    const key = `${id}:${consoleId}`; const logId = this.logSubs.get(key);
    if (logId === undefined) return;
    this.logSubs.delete(key);
    if (![...this.logSubs.entries()].some(([k, v]) => k.startsWith(`${id}:`) && v === logId)) this.mgr.logStop(id, logId);
  }
}

module.exports = { Consoles, parseRconSource, paramValue, quickCommands };
