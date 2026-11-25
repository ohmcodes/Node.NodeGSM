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
};
const VIEWS = ['servers', 'table', 'dashboard'];
const CHARTS = ['players', 'cpu', 'memory'];

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
