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
  dashboardChart: 'players',  // players | cpu | memory
  ui: { leftCollapsed: false, rightCollapsed: false, bottomCollapsed: false, navCollapsed: false }, // panel collapse state
  headerStats: { cpu: true, ram: true, disk: false, servers: true, players: false, tick: false },  // header info bar
  discord: { webhookUrl: '', botToken: '', applicationId: '', guildId: '', allowedUserIds: [], adminRoleIds: [], allowRawCommands: false, events: {} },
  logging: { retentionDays: 30 }, // NGSM event log retention
};
const VIEWS = ['servers', 'table', 'dashboard'];
const CHARTS = ['players', 'cpu', 'memory'];

const SNOWFLAKE = /^\d{1,25}$/;
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const bools = (v, keys) => { const o = {}; if (v && typeof v === 'object') for (const k of keys) if (k in v) o[k] = !!v[k]; return o; };
const idList = (v) => (Array.isArray(v) ? [...new Set(v.map((x) => String(x).trim()).filter((x) => SNOWFLAKE.test(x)))].slice(0, 100) : []);
const UI_KEYS = ['leftCollapsed', 'rightCollapsed', 'bottomCollapsed', 'navCollapsed'];
const STAT_KEYS = ['cpu', 'ram', 'disk', 'servers', 'players', 'tick'];

function sanitizeDiscord(v) {
  v = v && typeof v === 'object' ? v : {};
  const events = {};
  if (v.events && typeof v.events === 'object') {
    for (const [k, x] of Object.entries(v.events).slice(0, 100)) if (/^[a-z0-9:_.-]{1,60}$/i.test(k)) events[k] = !!x;
  }
  return {
    webhookUrl: str(v.webhookUrl, 500), botToken: str(v.botToken, 200), applicationId: str(v.applicationId, 30), guildId: str(v.guildId, 30),
    allowedUserIds: idList(v.allowedUserIds), adminRoleIds: idList(v.adminRoleIds), allowRawCommands: v.allowRawCommands === true, events,
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

module.exports = { DEFAULTS, THEMES, sanitize, read, resolveTheme };
