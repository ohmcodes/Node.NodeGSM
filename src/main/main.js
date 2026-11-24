'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { ServerManager } = require('./serverManager');
const { GAMES } = require('./games');

const dataDir = process.env.WGSM_DATA || path.join(app.getPath('userData'), 'WGSM');
let mgr; let win; let tray; let quitting = false;

function publicGames() {
  return GAMES.map(({ id, name, icon: iconData || icon, port, queryPort, map, maxPlayers, additional, appId, query, gslt, plugin, author, version }) =>
    ({ id, name, icon, iconData, port, queryPort, map, maxPlayers, additional, appId, query, gslt: !!gslt, plugin: !!plugin, author, version }));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 980, minHeight: 600, backgroundColor: '#14161c', title: 'Node.WGSM2026',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
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
    return s;
  });
  handle('pickFolder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });

  createWindow();
  mgr.startScheduler();
  mgr.autoStartAll();

  const icon = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'assets', 'games', 'csgo.png')).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('Node.WGSM2026');
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
  try { await mgr.shutdown(); } catch {}
  quitting = 'done';
  app.quit();
});
app.on('window-all-closed', () => { if (!mgr.settings.minimizeToTray) app.quit(); });
