'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, nativeTheme } = require('electron');
const path = require('path');
const { ServerManager } = require('./serverManager');
const { GAMES, detail: pluginDetail } = require('./plugins');
const appSettings = require('./settings');
const { MetricsCollector } = require('./metrics');
const { shouldRestart } = require('./crash');
const { buildApi } = require('./api');
const { EventLog } = require('./services/eventLog');
const { Discord } = require('./services/discord');
const { DiscordBot } = require('./services/discordBot');
const { BackupService } = require('./services/backup');
const { Cluster } = require('./services/cluster');
const { AutoClear } = require('./services/autoClear');
const { Consoles } = require('./services/consoles');

// Keep using the pre-rename data folder if it exists so existing servers/downloads are not orphaned.
const legacyDir = path.join(app.getPath('appData'), 'node-wgsm2026', 'WGSM');
const dataDir = process.env.NODEGSM_DATA || process.env.WGSM_DATA ||
  (require('fs').existsSync(legacyDir) ? legacyDir : path.join(app.getPath('appData'), 'NodeGSM'));
const earlySettings = appSettings.read(dataDir);
if (!earlySettings.hardwareAcceleration) app.disableHardwareAcceleration();
nativeTheme.themeSource = earlySettings.theme; // dialogs / menus follow the chosen theme

let mgr; let win; let tray; let quitting = false; let collector; let services = [];
const BG = { dark: '#14161c', light: '#f3f5f9' };
const currentBg = () => BG[appSettings.resolveTheme(mgr ? mgr.settings.theme : earlySettings.theme, nativeTheme.shouldUseDarkColors)];

// ---- crash handling: log, and (optionally) relaunch the app, max 3 times per 10 minutes ----
const fsx = require('fs');
async function onCrash(kind, err) {
  try {
    fsx.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
    fsx.appendFileSync(path.join(dataDir, 'logs', 'crash.log'), `[${new Date().toISOString()}] ${kind}: ${err && err.stack ? err.stack : err}\n`);
  } catch { /* ignore */ }
  if (!mgr || !mgr.settings.autoRestartApp || quitting) return;
  const file = path.join(dataDir, 'logs', 'crash-history.json');
  let hist = []; try { hist = JSON.parse(fsx.readFileSync(file, 'utf8')); } catch { /* none */ }
  const r = shouldRestart(hist, Date.now());
  try { fsx.writeFileSync(file, JSON.stringify(r.history)); } catch { /* ignore */ }
  if (!r.allow) return; // crash loop: stay down so the user can see the problem
  quitting = 'done';
  try { await mgr.shutdown(); } catch { /* ignore */ }
  app.relaunch();
  app.exit(0);
}
process.on('uncaughtException', (e) => onCrash('uncaughtException', e));
process.on('unhandledRejection', (e) => onCrash('unhandledRejection', e));

function publicGames() {
  return GAMES.map(({ id, name, icon, description, tags, port, queryPort, map, maxPlayers, additional, appId, query, gslt, source, author, version, overrides }) =>
    ({ id, name, icon, description, tags, port, queryPort, map, maxPlayers, additional, appId, query, gslt: !!gslt, source, author, version, overrides: !!overrides }));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 980, minHeight: 600, backgroundColor: currentBg(), title: 'NodeGSM',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.on('render-process-gone', (_e, d) => {
    onCrash('renderer', d.reason);
    if (mgr.settings.autoRestartApp && !win.isDestroyed()) win.reload();
  });
  win.on('close', (e) => { if (!quitting && mgr.settings.minimizeToTray) { e.preventDefault(); win.hide(); } });
}

function send(ch, payload) { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); }

function handle(name, fn) {
  ipcMain.handle(name, async (_e, ...args) => {
    try { return { ok: true, data: await fn(...args) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
}

app.whenReady().then(() => {
  mgr = new ServerManager(dataDir);
  mgr.on('status', (v) => send('status', v));
  mgr.on('console', (m) => send('console', m));
  mgr.on('removed', (id) => send('removed', id));
  mgr.on('logLines', (m) => send('logLines', m));
  mgr.on('consoleOut', (m) => send('consoleOut', m));
  collector = new MetricsCollector(mgr);
  collector.on('metrics', (m) => send('metrics', m));

  // Services subscribe to mgr.events (see services/*.js)
  const instances = [EventLog, Discord, DiscordBot, BackupService, Cluster, AutoClear, Consoles].map((S) => new S(mgr, require('./plugins'), mgr.settings, dataDir));
  services = instances;
  const [eventLog, discord] = instances;
  const cluster = instances.find((x) => x instanceof Cluster);
  const autoClear = instances.find((x) => x instanceof AutoClear);
  const consoles = instances.find((x) => x instanceof Consoles);
  const discordBot = instances.find((x) => x instanceof DiscordBot);
  discordBot.collector = collector;
  discordBot.onStatus = (st) => send('discordBot', st);
  cluster.onProgress = (p) => send('cluster:progress', p);

  const api = buildApi({
    mgr, collector, publicGames, shell, dialog, app, nativeTheme, currentBg, eventLog, discord, discordBot, cluster, autoClear, consoles,
    getWin: () => win,
    beforeRelaunch: () => { quitting = 'done'; },
  });
  for (const [name, fn] of Object.entries(api)) handle(name, fn);
  services.forEach((s) => s.start());

  createWindow();
  mgr.startScheduler();
  collector.start();
  mgr.autoStartAll();

  const icon = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'assets', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('NodeGSM');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show', click: () => { win.show(); } },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', () => win.show());
});

app.on('before-quit', async (e) => {
  if (quitting === 'done') return;
  e.preventDefault();
  quitting = true;
  try { collector.stop(); await Promise.all(services.map((x) => Promise.resolve(x.stop()).catch(() => {}))); await mgr.shutdown(); } catch {}
  quitting = 'done';
  app.quit();
});
app.on('window-all-closed', () => { if (!mgr.settings.minimizeToTray) app.quit(); });
