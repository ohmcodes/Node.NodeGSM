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
  discord: { webhookUrl: '', botEnabled: false, botToken: '', applicationId: '', guildId: '', allowedUserIds: [], adminRoleIds: [], permissions: [], allowRawCommands: false, events: {}, templates: {} },
  logging: { retentionDays: 30 }, // NGSM event log retention
  steam: { username: '' },   // the Steam account signed in under Settings > Steam account (only the name; SteamCMD keeps its own login token, NodeGSM never stores the password)
  web: { enabled: false, host: '127.0.0.1', port: 8730, https: false, trustProxy: false, require2fa: false, sessionHours: 12 }, // Web access: the browser UI served by the desktop app (accounts: <data>/web-users.json)
  catalogueUrl: '',           // plugin catalogue: https:// address or a local folder; '' = the official catalogue
};
const HOST = /^(?:[A-Za-z0-9.-]{1,253}|\[?[0-9A-Fa-f:]{2,45}\]?)$/;
/** Web access settings: bind address, port, HTTPS / proxy flags. Invalid values fall back to the safe default (loopback, 8730). */
function sanitizeWeb(v) {
  const d = DEFAULTS.web; v = v && typeof v === 'object' ? v : {};
  const host = typeof v.host === 'string' && HOST.test(v.host.trim()) ? v.host.trim().replace(/^\[|\]$/g, '') : d.host;
  const port = Math.round(Number(v.port)); const hrs = Math.round(Number(v.sessionHours));
  return { enabled: v.enabled === true, host, port: port >= 1 && port <= 65535 ? port : d.port, https: v.https === true, trustProxy: v.trustProxy === true, require2fa: v.require2fa === true, sessionHours: hrs >= 1 && hrs <= 720 ? hrs : d.sessionHours };
}
const VIEWS = ['servers', 'table', 'dashboard'];
const CHARTS = ['players', 'cpu', 'memory', 'tick', 'latency'];

const { sanitizeRules: sanitizePermissions } = require('./services/discordPermissions');
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
  if ('discordAllowedUserIds' in patch) out.discordAllowedUserIds = idList(patch.discordAllowedUserIds);   // bot: only these users (and admin roles) may control this server; empty = no extra restriction
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
  if (patch && typeof patch === 'object' && 'backupSchedule' in patch) out.backupSchedule = sanitizeBackupSchedule(patch.backupSchedule);
  if (patch && typeof patch === 'object' && 'rconSchedule' in patch) out.rconSchedule = sanitizeRconSchedule(patch.rconSchedule);
  return out;
}
const MAX_RCON_JOBS = 20;
/**
 * Scheduled commands of one server: [{ enabled, cron (5 fields, validated), command, console }]. The command is sent through the
 * game's rcon console (console = its id, empty = the first one; a game without RCON uses its own console). Throws on a bad row.
 */
function sanitizeRconSchedule(v) {
  if (!Array.isArray(v)) return [];
  if (v.length > MAX_RCON_JOBS) throw new Error('At most ' + MAX_RCON_JOBS + ' scheduled commands per server.');
  return v.map((j, i) => {
    j = j && typeof j === 'object' ? j : {};
    const n = i + 1;
    const cron = str(j.cron, 100);
    if (cron.split(/\s+/).length !== 5) throw new Error('Scheduled command ' + n + ': the schedule must be a cron expression with 5 fields, for example "*/30 * * * *" (every 30 minutes).');
    try { require('cron-parser').parseExpression(cron); } catch (e) { throw new Error('Scheduled command ' + n + ': invalid cron expression: ' + e.message); }
    // one command per line (up to 20), like several arguments of mcrcon; wait = seconds between them (0 - 600)
    const lines = (typeof j.command === 'string' ? j.command : '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) throw new Error('Scheduled command ' + n + ': the command is empty.');
    if (lines.length > 20) throw new Error('Scheduled command ' + n + ': at most 20 commands per job.');
    if (lines.some((l) => Buffer.byteLength(l, 'utf8') > 4096)) throw new Error('Scheduled command ' + n + ': a command is too long (limit 4096 bytes).');
    const wait = j.wait === undefined || j.wait === '' ? 1 : Math.floor(Number(j.wait));
    if (!(wait >= 0 && wait <= 600)) throw new Error('Scheduled command ' + n + ': the wait between commands must be 0 to 600 seconds.');
    return { enabled: j.enabled !== false, cron, command: lines.join('\n'), console: str(j.console, 40), wait };
  });
}
const strList = (v, n, len) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string').map((x) => x.trim().slice(0, len)).filter(Boolean))].slice(0, n) : []);
/**
 * Scheduled backup of one server: { enabled, cron (5 fields, validated), options: { mode, presets, paths, exclude, includeServerSettings } }.
 * The options have the same shape as the "Backup now" options (services/backup.js validates them when a backup runs). Throws on an invalid cron expression.
 */
function sanitizeBackupSchedule(v) {
  v = v && typeof v === 'object' ? v : {};
  const cron = str(v.cron, 100) || '0 4 * * *';
  if (cron.split(/\s+/).length !== 5) throw new Error('The schedule must be a cron expression with 5 fields, for example "0 4 * * *" (every day at 04:00).');
  try { require('cron-parser').parseExpression(cron); } catch (e) { throw new Error(`Invalid cron expression: ${e.message}`); }
  const o = v.options && typeof v.options === 'object' ? v.options : {};
  const options = { mode: o.mode === 'neatpick' ? 'neatpick' : 'full', presets: strList(o.presets, 50, 60), paths: strList(o.paths, 2000, 500), exclude: strList(o.exclude, 200, 200) };
  if (typeof o.includeServerSettings === 'boolean') options.includeServerSettings = o.includeServerSettings;
  return { enabled: v.enabled === true, cron, options };
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
    webhookUrl: webhook(v.webhookUrl), botEnabled: v.botEnabled === true, botToken: str(v.botToken, 200).replace(/^Bot\s+/i, ''), applicationId: str(v.applicationId, 30), guildId: str(v.guildId, 30),
    allowedUserIds: idList(v.allowedUserIds), adminRoleIds: idList(v.adminRoleIds), permissions: sanitizePermissions(v.permissions), allowRawCommands: v.allowRawCommands === true,
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
    else if (k === 'web') { if (v && typeof v === 'object') out.web = sanitizeWeb(v); }
    else if (k === 'steam') { if (v && typeof v === 'object') { const u = str(v.username, 64); out.steam = { username: u === '' || /^[A-Za-z0-9_.@-]{2,64}$/.test(u) ? u : '' }; } }
    else if (k === 'catalogueUrl') { const s = str(v, 300); if (s === '' || require('./catalogue').normalizeBase(s)) out.catalogueUrl = s; }
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

module.exports = { sanitizeRconSchedule, sanitizeBackupSchedule, sanitizeWeb, DEFAULTS, THEMES, sanitize, read, resolveTheme, isDiscordWebhook, sanitizeTemplate, sanitizeServerDiscord, sanitizeServerBackup, sanitizeAutoClear, sanitizeAutoClearRule, sanitizeServerAutoClear, relFolder };
