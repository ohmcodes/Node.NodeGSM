'use strict';
// Discord webhook alerts: global webhook (settings.discord.webhookUrl) + the per-server webhook, per-event toggles
// (settings.discord.events, per-server override discordEvents), embed / simple-message templates (settings.discord.templates),
// a send queue with 429 handling. It never throws into the caller. Replaces the old ServerManager.alert().
const http = require('http');
const https = require('https');
const { isDiscordWebhook, sanitizeTemplate } = require('../settings');

const NAME = 'NodeGSM';
const VARIABLES = ['server', 'event', 'game', 'ip', 'port', 'players', 'time', 'id', 'reason', 'file', 'message'];

/** Built-in events that can be alerted. `on` = default toggle. */
const EVENTS = [
  { key: 'server:started', label: 'Server started', on: true, color: '#2ecc71' },
  { key: 'server:stopped', label: 'Server stopped', on: false, color: '#95a5a6' },
  { key: 'server:crashed', label: 'Server crashed', on: true, color: '#e74c3c' },
  { key: 'server:restarted', label: 'Server restarted', on: true, color: '#3498db' },
  { key: 'server:updated', label: 'Server updated', on: true, color: '#3498db' },
  { key: 'server:backup', label: 'Backup created', on: false, color: '#1abc9c' },
  { key: 'server:restore', label: 'Backup restored', on: false, color: '#1abc9c' },
];
const BY_KEY = Object.fromEntries(EVENTS.map((e) => [e.key, e]));

const F = (name, value, inline = true) => ({ name, value, inline });
const COMMON_FIELDS = [F('Game', '{game}'), F('Address', '{ip}:{port}'), F('Players', '{players}')];
/** Default templates (used until the user saves their own). */
const DEFAULT_TEMPLATES = {
  'server:started': { mode: 'embed', content: '**{server}** started ({game})', title: 'Server started', description: '**{server}** is now online.', color: '#2ecc71', thumbnail: '', image: '', footer: 'NodeGSM - server #{id}', fields: COMMON_FIELDS },
  'server:stopped': { mode: 'embed', content: '**{server}** stopped', title: 'Server stopped', description: '**{server}** was shut down.', color: '#95a5a6', thumbnail: '', image: '', footer: 'NodeGSM - server #{id}', fields: [F('Game', '{game}')] },
  'server:crashed': { mode: 'embed', content: '**{server}** crashed', title: 'Server crashed', description: '**{server}** stopped unexpectedly. {message}', color: '#e74c3c', thumbnail: '', image: '', footer: 'NodeGSM - server #{id}', fields: [F('Game', '{game}'), F('Address', '{ip}:{port}')] },
  'server:restarted': { mode: 'embed', content: '**{server}** restarted ({reason})', title: 'Server restarted', description: '**{server}** was restarted ({reason}).', color: '#3498db', thumbnail: '', image: '', footer: 'NodeGSM - server #{id}', fields: COMMON_FIELDS },
  'server:updated': { mode: 'embed', content: '**{server}** updated', title: 'Server updated', description: '**{server}** was updated. {message}', color: '#3498db', thumbnail: '', image: '', footer: 'NodeGSM - server #{id}', fields: [F('Game', '{game}')] },
  'server:backup': { mode: 'embed', content: 'Backup of **{server}** created', title: 'Backup created', description: 'A backup of **{server}** was created.', color: '#1abc9c', thumbnail: '', image: '', footer: 'NodeGSM - server #{id}', fields: [F('File', '{file}')] },
  'server:restore': { mode: 'embed', content: 'Backup of **{server}** restored', title: 'Backup restored', description: 'A backup of **{server}** was restored.', color: '#1abc9c', thumbnail: '', image: '', footer: 'NodeGSM - server #{id}', fields: [F('File', '{file}')] },
};
/** Template for plugin events (game:<id>) that have no template of their own. */
const GAME_TEMPLATE = { mode: 'embed', content: '**{server}**: {event}', title: '{event}', description: '{message}', color: '#f1c40f', thumbnail: '', image: '', footer: 'NodeGSM - server #{id}', fields: [F('Game', '{game}')] };

const SAMPLE = { server: 'My Server', event: 'Server started', game: 'Counter-Strike 2', ip: '203.0.113.10', port: '27015', players: '3/24', id: '1', reason: 'manual', file: 'backup-2026-11-24.zip', message: 'Example message from the game.' };

const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
const hexToInt = (h) => (/^#[0-9a-f]{6}$/i.test(h || '') ? parseInt(h.slice(1), 16) : undefined);
const subst = (text, vars) => String(text == null ? '' : text).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));

/**
 * Template + variables -> Discord webhook JSON. Pure function (used for sending, preview and tests).
 * Mentions are disabled (allowed_mentions.parse = []) so a server name can never ping @everyone.
 */
function render(template, vars, now = Date.now()) {
  const t = sanitizeTemplate(template);
  const v = {}; for (const k of Object.keys(vars || {})) v[k] = clip(vars[k], 300);
  const body = { username: NAME, allowed_mentions: { parse: [] } };
  const content = clip(subst(t.content, v), 2000);
  if (t.mode === 'simple') { body.content = content || clip(subst('**{server}** - {event}', v), 2000); return body; }
  const fields = t.fields.map((f) => ({ name: clip(subst(f.name, v), 256), value: clip(subst(f.value, v), 1024), inline: !!f.inline })).filter((f) => f.name.trim() && f.value.trim());
  const embed = {};
  const title = clip(subst(t.title, v), 256); if (title) embed.title = title;
  const desc = clip(subst(t.description, v), 4000); if (desc.trim()) embed.description = desc;
  const col = hexToInt(t.color); if (col !== undefined) embed.color = col;
  if (t.thumbnail) embed.thumbnail = { url: t.thumbnail };
  if (t.image) embed.image = { url: t.image };
  const footer = clip(subst(t.footer, v), 2048); if (footer) embed.footer = { text: footer };
  if (fields.length) embed.fields = fields;
  embed.timestamp = new Date(now).toISOString();
  if (!embed.title && !embed.description && !fields.length && !embed.image && !embed.thumbnail) { body.content = content || clip(subst('**{server}** - {event}', v), 2000); return body; }
  body.embeds = [embed];
  return body;
}

/** Which old per-server flag decides this event. string = flag name, null = use the event toggles, false = legacy never alerted (override only). */
function legacyFlag(type, detail = {}) {
  switch (type) {
    case 'server:started': return 'autoStartAlert';
    case 'server:crashed': return 'crashAlert';
    case 'server:restarted': return detail.reason === 'crash' ? 'autoRestartAlert' : detail.reason === 'cron' ? 'restartCrontabAlert' : false;
    case 'server:updated': return detail.auto ? 'autoUpdateAlert' : false;
    default: return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Discord {
  /**
   * @param {import('../serverManager').ServerManager} mgr  server manager (mgr.events emits server:* events)
   * @param {object} plugins  the plugins module (GAMES, byId, ...)
   * @param {object} settings app settings snapshot (mgr.settings is the live object and is read at use time)
   * @param {string} dataDir  NodeGSM data folder
   * @param {{allowAnyUrl?:boolean, agent?:object, delayMs?:number, maxRetries?:number, now?:()=>number, sleep?:(ms:number)=>Promise}} [opts]
   *   allowAnyUrl / agent are for tests (local http server); in production only https://discord.com/api/webhooks/... is accepted.
   */
  constructor(mgr, plugins, settings, dataDir, opts = {}) {
    this.mgr = mgr; this.plugins = plugins; this.dataDir = dataDir;
    this.opts = { delayMs: 350, maxRetries: 3, ...opts };
    this.now = opts.now || Date.now;
    this.sleep = opts.sleep || sleep;
    this.started = false; this.handlers = [];
    this.queue = []; this.pumping = false;
    this.sent = 0;
  }

  get settings() { return (this.mgr && this.mgr.settings) || {}; }
  get cfg() { return this.settings.discord || {}; }

  start() {
    if (this.started) return;
    this.started = true;
    for (const e of EVENTS) {
      const h = (p) => { try { this.handle(e.key, p); } catch { /* never break the bus */ } };
      this.mgr.events.on(e.key, h); this.handlers.push([e.key, h]);
    }
    const lh = (rec) => { try { if (rec && String(rec.event).startsWith('game:')) this.handleGame(rec); } catch { /* ignore */ } };
    this.mgr.events.on('ngsm:log', lh); this.handlers.push(['ngsm:log', lh]);
  }

  stop() {
    this.started = false;
    for (const [t, h] of this.handlers) this.mgr.events.removeListener(t, h);
    this.handlers = [];
  }

  // ---------- catalog / templates ----------
  /** Built-in events plus the extra events (`events[]`) declared by the plugins of installed servers. */
  catalog() {
    const list = EVENTS.map((e) => ({ key: e.key, label: e.label, on: e.on, color: e.color, group: 'Server' }));
    const seen = new Set();
    try {
      for (const id of this.mgr.ids()) {
        const g = this.plugins.byId(this.mgr.getConfig(id).game);
        for (const ev of (g && g.events) || []) {
          const key = `game:${ev.id}`;
          if (seen.has(key)) continue; seen.add(key);
          list.push({ key, label: `${g.name}: ${ev.label}`, on: ev.default === true, color: GAME_TEMPLATE.color, group: 'Game' });
        }
      }
    } catch { /* no servers yet */ }
    return list;
  }
  defaultTemplate(key) { return sanitizeTemplate(DEFAULT_TEMPLATES[key] || GAME_TEMPLATE); }
  /** Saved template (if any) over the built-in default. */
  templateFor(key) { const saved = (this.cfg.templates || {})[key]; return saved ? sanitizeTemplate(saved) : this.defaultTemplate(key); }
  /** Data for the Discord view: events, default + saved templates, placeholders. */
  info() {
    const events = this.catalog();
    const defaults = {}; const templates = {};
    for (const e of events) { defaults[e.key] = this.defaultTemplate(e.key); templates[e.key] = this.templateFor(e.key); }
    return { events, defaults, templates, variables: VARIABLES, sample: SAMPLE };
  }
  globalToggle(key) {
    const t = (this.cfg.events || {})[key]; if (typeof t === 'boolean') return t;
    const e = BY_KEY[key] || (String(key).startsWith('game:') ? this.catalog().find((x) => x.key === key) : null);
    return e ? !!e.on : false;
  }

  // ---------- variables ----------
  varsFor(type, p, extra = {}) {
    const v = {}; const label = (BY_KEY[type] || {}).label || type;
    let view = null; try { view = p && p.id != null ? this.mgr.view(p.id) : null; } catch { /* server removed */ }
    const d = (p && p.detail) || {};
    v.server = (p && p.name) || (view && view.name) || ''; v.event = label; v.id = p ? String(p.id) : '';
    v.game = (view && view.gameName) || (p && p.game) || '';
    v.ip = view ? view.ip_display : ''; v.port = view ? String(view.port) : '';
    v.players = view && view.players != null ? `${view.players}/${view.maxPlayersLive || view.maxPlayers}` : 'n/a';
    v.time = new Date(this.now()).toLocaleString();
    v.reason = d.reason || ''; v.file = d.file || '';
    v.message = d.code != null ? `Exit code ${d.code}.` : d.from ? `${d.from} -> ${d.to}` : '';
    return { ...v, ...extra };
  }

  // ---------- who gets this event ----------
  /** Webhook URLs that should receive the event for this server. Pure; tested directly. */
  targets(type, serverId, detail = {}) {
    const c = serverId != null ? this.mgr.getConfig(serverId) : null;
    const override = c && c.discordEvents && typeof c.discordEvents[type] === 'boolean' ? c.discordEvents[type] : undefined;
    const urls = new Set();
    const ok = (u) => !!u && (this.opts.allowAnyUrl ? /^https?:\/\//i.test(u) : isDiscordWebhook(u));
    const g = this.cfg.webhookUrl;
    if (ok(g) && (override !== undefined ? override : this.globalToggle(type))) urls.add(g);
    if (c && c.discordAlert && ok(c.discordWebhook)) {
      const flag = legacyFlag(type, detail);
      const on = override !== undefined ? override : flag === false ? false : flag ? !!c[flag] : this.globalToggle(type);
      if (on) urls.add(c.discordWebhook);
    }
    return [...urls];
  }

  handle(type, p) {
    const urls = this.targets(type, p.id, p.detail || {});
    if (!urls.length) return;
    const v = this.varsFor(type, p);
    const custom = this.customMessage(p.id); if (custom) v.message = [v.message, custom].filter(Boolean).join(' ');
    const body = render(this.templateFor(type), v, this.now());
    for (const u of urls) this.enqueue(u, body);
  }
  handleGame(rec) {
    const key = rec.event;
    const urls = this.targets(key, rec.serverId, {});
    if (!urls.length) return;
    let label = key; try { const g = this.plugins.byId(this.mgr.getConfig(rec.serverId).game); const ev = (g.events || []).find((x) => `game:${x.id}` === key); if (ev) label = ev.label; } catch { /* keep key */ }
    const v = this.varsFor(key, { id: rec.serverId, name: rec.serverName, detail: {} }, { event: label, message: rec.message });
    const body = render(this.templateFor(key), v, this.now());
    for (const u of urls) this.enqueue(u, body);
  }
  /** The old per-server "custom message" is added to the {message} placeholder. */
  customMessage(id) { const c = this.mgr.getConfig(id); return c && c.discordMessage ? c.discordMessage : ''; }

  // ---------- test / preview (IPC) ----------
  /** Rendered webhook JSON for a template (unsaved templates are fine; they are sanitised first). */
  preview(template, sampleVars, eventKey) {
    const label = (BY_KEY[eventKey] || {}).label;
    const vars = { ...SAMPLE, ...(label ? { event: label } : {}) };
    if (sampleVars && typeof sampleVars === 'object') for (const [k, x] of Object.entries(sampleVars)) if (/^\w{1,20}$/.test(k) && typeof x === 'string') vars[k] = x;
    return render(template || this.templateFor(eventKey), vars, this.now());
  }
  /** Send a sample message for an event to the global webhook. template = the editor's current (unsaved) template. */
  async test(kind, template) {
    const url = this.cfg.webhookUrl;
    if (!url) return { ok: false, status: 0, error: 'No webhook URL saved. Paste a Discord webhook URL first.' };
    const body = kind && kind !== 'plain' ? this.preview(template, null, kind) : { username: NAME, content: 'NodeGSM test message - the webhook works.', allowed_mentions: { parse: [] } };
    return this.enqueue(url, body);
  }

  // ---------- sending ----------
  /** Queue one webhook POST. Resolves { ok, status, error? }; never rejects. */
  enqueue(url, body) {
    if (!(this.opts.allowAnyUrl ? /^https?:\/\//i.test(url) : isDiscordWebhook(url))) return Promise.resolve({ ok: false, status: 0, error: 'Not a Discord webhook URL' });
    return new Promise((resolve) => { this.queue.push({ url, body, resolve }); this.pump(); });
  }
  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length) {
        const it = this.queue.shift();
        let r; try { r = await this.deliver(it.url, it.body); } catch (e) { r = { ok: false, status: 0, error: e.message }; }
        it.resolve(r);
        if (this.queue.length) await this.sleep(this.opts.delayMs);
      }
    } finally { this.pumping = false; }
  }
  async deliver(url, body) {
    let last = { ok: false, status: 0, error: 'not sent' };
    for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
      last = await this.post(url, JSON.stringify(body));
      if (last.status === 429) { await this.sleep(Math.min(Math.max(last.retryAfter || 1, 0.05), 30) * 1000); continue; }
      if (last.status >= 500 && attempt < this.opts.maxRetries) { await this.sleep(1000 * (attempt + 1)); continue; }
      break;
    }
    if (last.ok) this.sent++;
    const { retryAfter, ...res } = last;
    return res;
  }
  post(url, payload) {
    return new Promise((resolve) => {
      let u; try { u = new URL(url); } catch { return resolve({ ok: false, status: 0, error: 'Invalid URL' }); }
      const lib = u.protocol === 'http:' ? http : https;
      const req = lib.request({ protocol: u.protocol, hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, method: 'POST', agent: this.opts.agent,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'User-Agent': 'NodeGSM' }, timeout: 10000 }, (res) => {
        let data = '';
        res.setEncoding('utf8'); res.on('data', (c) => { if (data.length < 4096) data += c; });
        res.on('end', () => {
          const status = res.statusCode || 0; const out = { ok: status >= 200 && status < 300, status };
          if (status === 429) {
            let ra = parseFloat(res.headers['retry-after']);
            try { const j = JSON.parse(data); if (typeof j.retry_after === 'number') ra = j.retry_after; } catch { /* header only */ }
            out.retryAfter = Number.isFinite(ra) ? ra : 1;
          }
          if (!out.ok) out.error = `HTTP ${status}`;
          resolve(out);
        });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (e) => resolve({ ok: false, status: 0, error: e.message }));
      req.end(payload);
    });
  }
}

module.exports = { Discord, render, legacyFlag, EVENTS, DEFAULT_TEMPLATES, VARIABLES, SAMPLE };
