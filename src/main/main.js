'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, nativeTheme } = require('electron');
const path = require('path');
const { ServerManager } = require('./serverManager');
const { GAMES, detail: pluginDetail } = require('./plugins');
const appSettings = require('./settings');
const { MetricsCollector } = require('./metrics');
const { shouldRestart } = require('./crash');

// Keep using the pre-rename data folder if it exists so existing servers/downloads are not orphaned.
const legacyDir = path.join(app.getPath('appData'), 'node-wgsm2026', 'WGSM');
const dataDir = process.env.NODEGSM_DATA || process.env.WGSM_DATA ||
  (require('fs').existsSync(legacyDir) ? legacyDir : path.join(app.getPath('appData'), 'NodeGSM'));
const earlySettings = appSettings.read(dataDir);
if (!earlySettings.hardwareAcceleration) app.disableHardwareAcceleration();
nativeTheme.themeSource = earlySettings.theme; // dialogs / menus follow the chosen theme

let mgr; let win; let tray; let quitting = false; let collector;
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
  collector = new MetricsCollector(mgr);
  collector.on('metrics', (m) => send('metrics', m));

  handle('games', () => publicGames());
  handle('list', () => mgr.list());
  handle('get', (id) => mgr.getConfig(id));
  handle('create', (game, name) => mgr.view(mgr.create(game, name).id));
  handle('import', (game, name, dir) => mgr.view(mgr.importServer(game, name, dir).id));
  handle('install', (id) => mgr.install(id));
  handle('save', (id, patch) => { mgr.saveConfig(id, patch); return mgr.view(id); });
  handle('start', (id) => mgr.start(id));
  handle('stop', (id) => mgr.stop(id));
  handle('restart', (id) => mgr.restart(id));
  handle('remove', (id, files) => mgr.remove(id, files));
  handle('console', (id) => mgr.getConsole(id));
  handle('command', (id, text) => mgr.sendCommand(id, text));
  handle('checkUpdate', (id) => mgr.checkUpdate(id));
  handle('update', (id, validate) => mgr.update(id, validate));
  handle('backups', (id) => mgr.backupList(id));
  handle('backup', (id) => mgr.backup(id));
  handle('restore', (id, f) => mgr.restore(id, f));
  handle('deleteBackup', (id, f) => mgr.deleteBackup(id, f));
  handle('firewall', (id, on) => mgr.firewall(id, on));
  handle('listDir', (id, rel) => mgr.listDir(id, rel));
  handle('readFile', (id, rel) => mgr.readTextFile(id, rel));
  handle('writeFile', (id, rel, t) => mgr.writeTextFile(id, rel, t));
  handle('openFolder', (id) => shell.openPath(mgr.filesDir(id)));
  handle('configList', (id) => mgr.configList(id));
  handle('configRead', (id, c) => mgr.readConfig(id, c));
  handle('configWrite', (id, c, t) => mgr.writeConfig(id, c, t));
  handle('configCreate', (id, c) => mgr.createConfig(id, c));
  handle('logsList', (id) => mgr.logsList(id));
  handle('logStart', (id, l) => mgr.logStart(id, l));
  handle('logStop', (id, l) => mgr.logStop(id, l));
  handle('pluginDetail', (id) => pluginDetail(id));
  handle('openExternal', (u) => { if (!/^https?:\/\//i.test(String(u))) throw new Error('Only http(s) links can be opened'); return shell.openExternal(String(u)); });
  handle('bulk', (action, ids) => mgr.bulk(action, ids));
  handle('kill', (id) => mgr.kill(id));
  handle('settingsDefaults', () => appSettings.DEFAULTS);
  handle('metricsState', () => collector.state());
  handle('pluginsInfo', () => mgr.pluginInfo);
  handle('pluginsReload', () => mgr.reloadPlugins());
  handle('pluginsInstallZip', async () => {
    const r = await dialog.showOpenDialog(win, { filters: [{ name: 'Plugin zip', extensions: ['zip'] }], properties: ['openFile'] });
    return r.canceled ? null : mgr.installPlugin(r.filePaths[0]);
  });
  handle('pluginsInstallFolder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    return r.canceled ? null : mgr.installPlugin(r.filePaths[0]);
  });
  handle('pluginsFolder', () => shell.openPath(mgr.pluginsDir));
  handle('metrics', () => mgr.metrics());
  handle('settings', () => mgr.settings);
  handle('saveSettings', (p) => {
    const s = mgr.saveSettings(p);
    app.setLoginItemSettings({ openAtLogin: !!s.startOnLogin });
    nativeTheme.themeSource = s.theme;
    if (win && !win.isDestroyed()) win.setBackgroundColor(currentBg());
    return s;
  });
  handle('relaunch', async () => {
    quitting = 'done';
    try { await mgr.shutdown(); } catch { /* ignore */ }
    app.relaunch();
    app.exit(0);
  });
  handle('pickFolder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });

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
  try { collector.stop(); await mgr.shutdown(); } catch {}
  quitting = 'done';
  app.quit();
});
app.on('window-all-closed', () => { if (!mgr.settings.minimizeToTray) app.quit(); });
