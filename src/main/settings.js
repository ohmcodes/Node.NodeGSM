'use strict';
// Application settings (settings.json in the data folder). Shared by the main process and the server manager.
const fs = require('fs');
const path = require('path');

const THEMES = ['dark', 'light', 'system'];
const HEX = /^#[0-9a-f]{6}$/i;

const DEFAULTS = {
  theme: 'dark',              // dark | light | system (follow Windows)
  accent: '#4f8cff',          // any #rrggbb; the UI offers a palette + custom colour
  animations: true,           // UI animation
  hardwareAcceleration: true, // needs an app restart
  startOnLogin: false,
  minimizeToTray: false,
  autoRestartApp: false,      // relaunch NodeGSM if it crashes
  discordToken: '',
  view: 'servers',            // servers (list) | table | dashboard (last opened view)
  tableColumns: ['id', 'pid', 'icon', 'status', 'name', 'ip', 'port', 'queryPort', 'map', 'players', 'cpu', 'memory', 'uptime'], // Table + Dashboard columns; plugin metrics are "m:<id>"
  dashboardShowStopped: false,
  dashboardChart: 'players',  // players | cpu | memory | tick | latency
  ui: { leftCollapsed: false, rightCollapsed: false, bottomCollapsed: false, navCollapsed: false }, // panel collapse state
  headerStats: { cpu: true, ram: true, disk: false, servers: true, players: false, tick: false },  // header info bar
  discord: { webhookUrl: '', botToken: '', applicationId: '', guildId: '', allowedUserIds: [], adminRoleIds: [], allowRawCommands: false, events: {}, templates: {} },
  logging: { retentionDays: 30 }, // NGSM event log retention
};
const VIEWS = ['servers', 'table', 'dashboard'];
const CHARTS = ['players', 'cpu', 'memory', 'tick', 'latency'];

const SNOWFLAKE = /^\d{1,25}$/;
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const bools = (v, keys) => { const o = {}; if (v && typeof v === 'object') for (const k of keys) if (k in v) o[k] = !!v[k]; return o; };
const idList = (v) => (Array.isArray(v) ? [...new Set(v.map((x) => String(x).trim()).filter((x) => SNOWFLAKE.test(x)))].slice(0, 100) : []);
const UI_KEYS = ['leftCollapsed', 'rightCollapsed', 'bottomCollapsed', 'navCollapsed'];
const STAT_KEYS = ['cpu', 'ram', 'disk', 'servers', 'players', 'tick'];

const EVENT_KEY = /^[a-z0-9:_.-]{1,60}$/i;
const WEBHOOK_HOSTS = ['discord.com', 'ptb.discord.com', 'canary.discord.com', 'discordapp.com'];

/** True for https://discord.com/api/webhooks/<id>/<token> (and discordapp.com / ptb / canary). Anything else is refused. */
function isDiscordWebhook(u) {
  try {
    const x = new URL(String(u));
    return x.protocol === 'https:' && WEBHOOK_HOSTS.includes(x.hostname) && !x.username && !x.password && !x.port && /^\/api\/webhooks\/\d+\/[\w-]+\/?$/.test(x.pathname);
  } catch { return false; }
}
/** Webhook field: trimmed, or '' when it is not a Discord webhook URL. */
const webhook = (v) => { const s = str(v, 500); return isDiscordWebhook(s) ? s : ''; };
/** Image / thumbnail: https URL up to 500 characters, else ''. */
const httpsUrl = (v) => { const s = str(v, 500); try { return new URL(s).protocol === 'https:' ? s : ''; } catch { return ''; } };
const color = (v) => (typeof v === 'string' && HEX.test(v.trim()) ? v.trim().toLowerCase() : '');

/** One embed / simple-message template. Strict types and length caps (Discord limits are larger; we stay well below). */
function sanitizeTemplate(t) {
  t = t && typeof t === 'object' ? t : {};
  const fields = [];
  if (Array.isArray(t.fields)) {
    for (const f of t.fields.slice(0, 10)) {
      if (!f || typeof f !== 'object') continue;
      const name = str(f.name, 100); const value = str(f.value, 500);
      if (name && value) fields.push({ name, value, inline: f.inline === true });
    }
  }
  return {
    mode: t.mode === 'simple' ? 'simple' : 'embed',
    content: str(t.content, 1000),
    title: str(t.title, 256), description: str(t.description, 2000), color: color(t.color),
    thumbnail: httpsUrl(t.thumbnail), image: httpsUrl(t.image), footer: str(t.footer, 200), fields,
  };
}
function sanitizeTemplates(v) {
  const out = {};
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v).slice(0, 60)) if (EVENT_KEY.test(k)) out[k] = sanitizeTemplate(x);
  return out;
}
/** Per-event on/off map ({ 'server:started': true }), used globally and as the per-server override. */
function sanitizeEventToggles(v) {
  const events = {};
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v).slice(0, 100)) if (EVENT_KEY.test(k)) events[k] = !!x;
  return events;
}
/** Per-server Discord fields of wgsm.json. Returns only the keys present in the patch; discordWebhook must be a valid Discord webhook (or empty). */
function sanitizeServerDiscord(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  if ('discordEvents' in patch) out.discordEvents = sanitizeEventToggles(patch.discordEvents);
  if ('discordMessage' in patch) out.discordMessage = str(patch.discordMessage, 500);
  if ('discordWebhook' in patch) {
    const raw = str(patch.discordWebhook, 500);
    if (raw && !isDiscordWebhook(raw)) throw new Error('Not a Discord webhook URL (expected https://discord.com/api/webhooks/<id>/<token>)');
    out.discordWebhook = raw;
  }
  return out;
}

/** Per-server backup fields of wgsm.json (retention). Returns only the keys present in the patch. */
function sanitizeServerBackup(patch) {
  const out = {};
  if (patch && typeof patch === 'object' && 'backupKeep' in patch) { const n = Math.floor(Number(patch.backupKeep)); out.backupKeep = n >= 0 && n <= 1000 ? n : 0; }
  return out;
}

const MAX_RULES = 50;
/** Relative folder path inside the server files folder: no "..", no absolute path, no drive letter / stream (":"), no NUL. Throws. */
function relFolder(p) {
  if (typeof p !== 'string') throw new Error('Invalid path');
  const s = p.replace(/[\\]/g, '/').trim();
  if (!s || s.length > 240 || s.includes('\0') || s.startsWith('/') || /^[a-z]:/i.test(s)) throw new Error(`Invalid path: ${p}`);
  const parts = s.split('/').filter((x) => x && x !== '.');
  if (!parts.length || parts.some((x) => x === '..' || x.includes(':') || /[<>"|?*]/.test(x))) throw new Error(`Invalid path: ${p}`);
  return parts.join('/');
}
/**
 * One auto-clear rule { path, pattern, olderThanDays, intervalMin, enabled, recursive, onlyWhenStopped, lastRun }.
 * path: relative folder (see relFolder), pattern: file-name wildcard (* ?, no "/" or "\\"), olderThanDays 0..3650, intervalMin 1..525600.
 */
function sanitizeAutoClearRule(r) {
  if (!r || typeof r !== 'object') throw new Error('Invalid auto-clear rule');
  const pattern = str(r.pattern, 100) || '*';
  if (/[/\\\0]/.test(pattern)) throw new Error('The pattern is matched against file names and cannot contain / or a backslash');
  const days = Number(r.olderThanDays === undefined || r.olderThanDays === '' ? 0 : r.olderThanDays);
  if (!Number.isFinite(days) || days < 0 || days > 3650) throw new Error('"Older than" must be 0 to 3650 days');
  const every = Number(r.intervalMin === undefined || r.intervalMin === '' ? 1440 : r.intervalMin);
  if (!Number.isFinite(every) || every < 1 || every > 525600) throw new Error('"Every" must be 1 to 525600 minutes');
  const lr = Number(r.lastRun);
  return {
    path: relFolder(r.path), pattern, olderThanDays: Math.round(days * 100) / 100, intervalMin: Math.floor(every),
    enabled: r.enabled !== false, recursive: r.recursive === true, onlyWhenStopped: r.onlyWhenStopped === true,
    lastRun: Number.isFinite(lr) && lr > 0 ? Math.floor(lr) : 0,
  };
}
/** Rule list. strict: throw on the first invalid rule (user input); otherwise invalid rules are dropped (files edited by hand). */
function sanitizeAutoClear(list, strict = true) {
  if (!Array.isArray(list)) { if (strict) throw new Error('Auto-clear rules must be a list'); return []; }
  if (strict && list.length > MAX_RULES) throw new Error(`At most ${MAX_RULES} auto-clear rules per server`);
  const out = [];
  for (const r of list.slice(0, MAX_RULES)) {
    try { out.push(sanitizeAutoClearRule(r)); } catch (e) { if (strict) throw e; }
  }
  return out;
}
/** Per-server auto-clear fields of wgsm.json: autoClear (rules) and autoClearSeeded (plugin rule keys that were already copied once). */
function sanitizeServerAutoClear(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  if ('autoClear' in patch) out.autoClear = sanitizeAutoClear(patch.autoClear, true);
  if ('autoClearSeeded' in patch) out.autoClearSeeded = Array.isArray(patch.autoClearSeeded) ? [...new Set(patch.autoClearSeeded.filter((x) => typeof x === 'string').map((x) => x.slice(0, 340)))].slice(0, 200) : [];
  return out;
}

function sanitizeDiscord(v) {
  v = v && typeof v === 'object' ? v : {};
  return {
    webhookUrl: webhook(v.webhookUrl), botToken: str(v.botToken, 200), applicationId: str(v.applicationId, 30), guildId: str(v.guildId, 30),
    allowedUserIds: idList(v.allowedUserIds), adminRoleIds: idList(v.adminRoleIds), allowRawCommands: v.allowRawCommands === true,
    events: sanitizeEventToggles(v.events), templates: sanitizeTemplates(v.templates),
  };
}

/** Keep only known keys with valid values. Returns the cleaned patch. */
function sanitize(patch) {
  const out = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in DEFAULTS)) continue;
    if (k === 'theme') { if (THEMES.includes(v)) out.theme = v; }
    else if (k === 'accent') { if (typeof v === 'string' && HEX.test(v)) out.accent = v.toLowerCase(); }
    else if (k === 'view') { if (VIEWS.includes(v)) out.view = v; }
    else if (k === 'dashboardChart') { if (CHARTS.includes(v)) out.dashboardChart = v; }
    else if (k === 'tableColumns') { if (Array.isArray(v)) out.tableColumns = v.filter((c) => typeof c === 'string' && /^[a-z0-9:_-]{1,40}$/i.test(c)).slice(0, 40); }
    else if (k === 'ui') { if (v && typeof v === 'object') out.ui = { ...DEFAULTS.ui, ...bools(v, UI_KEYS) }; }
    else if (k === 'headerStats') { if (v && typeof v === 'object') out.headerStats = { ...DEFAULTS.headerStats, ...bools(v, STAT_KEYS) }; }
    else if (k === 'discord') { if (v && typeof v === 'object') out.discord = sanitizeDiscord(v); }
    else if (k === 'logging') { if (v && typeof v === 'object') { const d = Math.round(Number(v.retentionDays)); out.logging = { retentionDays: d >= 1 && d <= 3650 ? d : DEFAULTS.logging.retentionDays }; } }
    else if (typeof DEFAULTS[k] === 'boolean') out[k] = !!v;
    else if (typeof DEFAULTS[k] === 'string') out[k] = String(v);
  }
  return out;
}

function read(dataDir) {
  try { return { ...DEFAULTS, ...sanitize(JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'))) }; }
  catch { return { ...DEFAULTS }; }
}

/** 'system' -> dark/light depending on Windows */
const resolveTheme = (theme, systemDark) => (theme === 'system' ? (systemDark ? 'dark' : 'light') : theme === 'light' ? 'light' : 'dark');

module.exports = { DEFAULTS, THEMES, sanitize, read, resolveTheme, isDiscordWebhook, sanitizeTemplate, sanitizeServerDiscord, sanitizeServerBackup, sanitizeAutoClear, sanitizeAutoClearRule, sanitizeServerAutoClear, relFolder };
