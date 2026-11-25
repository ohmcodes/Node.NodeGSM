'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, nativeTheme } = require('electron');
const path = require('path');
const platform = require('./platform');
const appSettings = require('./settings');
const { shouldRestart } = require('./crash');
const { createCore } = require('./core');

// Keep using the pre-rename data folder if it exists so existing servers/downloads are not orphaned (platform.defaultDataDir).
const dataDir = platform.defaultDataDir({ appData: app.getPath('appData') });
const earlySettings = appSettings.read(dataDir);
if (!earlySettings.hardwareAcceleration) app.disableHardwareAcceleration();
nativeTheme.themeSource = earlySettings.theme; // dialogs / menus follow the chosen theme

let core; let mgr; let win; let tray; let quitting = false;
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

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 980, minHeight: 600, backgroundColor: currentBg(), title: 'NodeGSM', icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
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
  core = createCore({ dataDir, mode: 'desktop' });
  mgr = core.mgr;
  core.hub.on(send);
  const api = core.buildApi({
    shell, dialog, app, nativeTheme, currentBg,
    getWin: () => win,
    beforeRelaunch: () => { quitting = 'done'; },
  });
  for (const [name, fn] of Object.entries(api)) handle(name, fn);

  createWindow();
  core.start();

  // tray: 16 px image + 32 px representation for high-DPI screens (falls back to resizing the 256 px icon)
  const assetsDir = path.join(__dirname, '..', '..', 'assets');
  let icon = nativeImage.createFromPath(path.join(assetsDir, 'icon-16.png'));
  if (icon.isEmpty()) icon = nativeImage.createFromPath(path.join(assetsDir, 'icon.png')).resize({ width: 16, height: 16 });
  else { const hi = nativeImage.createFromPath(path.join(assetsDir, 'icon-32.png')); if (!hi.isEmpty()) icon.addRepresentation({ scaleFactor: 2, buffer: hi.toPNG() }); }
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
  try { await core.stop(); } catch {}
  quitting = 'done';
  app.quit();
});
app.on('window-all-closed', () => { if (!mgr || !mgr.settings.minimizeToTray) app.quit(); });
