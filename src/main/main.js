'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, nativeTheme, Notification } = require('electron');
const path = require('path');
const platform = require('./platform');
const appSettings = require('./settings');
const { shouldRestart } = require('./crash');
const { createCore, headlessHost } = require('./core');
const { startServer } = require('../server/headless');
const { WebAccess } = require('../server/webAccess');

// Keep using the pre-rename data folder if it exists so existing servers/downloads are not orphaned (platform.defaultDataDir).
const dataDir = platform.defaultDataDir({ appData: app.getPath('appData') });
const earlySettings = appSettings.read(dataDir);
if (!earlySettings.hardwareAcceleration) app.disableHardwareAcceleration();
nativeTheme.themeSource = earlySettings.theme; // dialogs / menus follow the chosen theme

let core; let mgr; let win; let tray; let quitting = false;

/** Tells the user that closing the window only hid NodeGSM in the tray (servers keep running; Quit is in the tray menu). */
function notifyTray() {
  const title = 'NodeGSM is still running'; const body = 'It was minimized to the system tray. Your servers keep running. Right-click the tray icon and choose Quit to exit.';
  try {
    if (Notification && Notification.isSupported()) new Notification({ title, body, silent: true }).show();
    else if (tray && tray.displayBalloon) tray.displayBalloon({ title, content: body });
  } catch { /* a notification must never block closing */ }
}
let webAccess; let web = null; let webState = { running: false, url: '', host: '', port: 0, error: '' };
const startHidden = process.argv.includes('--hidden');   // launched by the Windows login item: stay in the tray
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
    width: 1280, height: 800, minWidth: 980, minHeight: 600, backgroundColor: currentBg(), title: 'NodeGSM', show: !startHidden, icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
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
  win.on('close', (e) => { if (!quitting && mgr.settings.minimizeToTray) { e.preventDefault(); win.hide(); notifyTray(); } });
}

const isLoopbackHost = (h) => /^(127\.\d+\.\d+\.\d+|::1|localhost)$/i.test(h);
/** (Re)start or stop the browser access to match settings.web. Never throws: the reason is kept in webState and shown in Settings. */
async function applyWeb() {
  const w = mgr.settings.web;
  if (web) { try { await web.close(); } catch { /* closing */ } web = null; }
  webState = { running: false, url: '', host: w.host, port: w.port, error: '' };
  webAccess.setRequire2fa(w.require2fa); webAccess.sessions.ttlMs = w.sessionHours * 3600 * 1000;
  if (!w.enabled) return;
  if (!isLoopbackHost(w.host) && !webAccess.hasAccounts) { webState.error = 'Create an owner account first (Web access > Accounts), then listen on a network address.'; return; }
  try {
    web = await startServer({ core, webAccess, dataDir, host: w.host, port: w.port, https: w.https, trustProxy: w.trustProxy, require2fa: w.require2fa, sessionHours: w.sessionHours, startCore: false });
    const shown = w.host === '0.0.0.0' || w.host === '::' ? 'localhost' : w.host;
    webState = { running: true, host: w.host, port: web.port, url: `${w.https ? 'https' : 'http'}://${shown.includes(':') ? `[${shown}]` : shown}:${web.port}`, error: '' };
  } catch (e) { webState.error = e.code === 'EADDRINUSE' ? `Port ${w.port} is already in use.` : e.message; }
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
  webAccess = new WebAccess({ dataDir, sessionHours: mgr.settings.web.sessionHours, require2fa: mgr.settings.web.require2fa, audit: (level, event, message, detail) => core.eventLog.log({ level, event, message, detail }) });
  const api = core.buildApi({
    shell, dialog, app, nativeTheme, currentBg,
    getWin: () => win,
    beforeRelaunch: () => { quitting = 'done'; },
  });
  for (const [name, fn] of Object.entries(api)) {
    if (name === 'saveSettings') handle(name, async (p) => { const before = JSON.stringify(mgr.settings.web); const r = fn(p); if (JSON.stringify(mgr.settings.web) !== before) await applyWeb(); return r; });
    else handle(name, fn);
  }
  // account management for the browser access: the desktop window is the local owner (no sign-in needed)
  const localWeb = webAccess.api({ local: true });
  for (const [name, fn] of Object.entries(localWeb)) handle(name, fn);
  handle('webServerStatus', () => ({ ...webState, accounts: webAccess.hasAccounts, defaults: { host: '127.0.0.1', port: 8730 } }));

  createWindow();
  core.start();
  applyWeb();

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
  try { if (web) await web.close(); } catch {}
  try { await core.stop(); } catch {}
  quitting = 'done';
  app.quit();
});
app.on('window-all-closed', () => { if (!mgr || !mgr.settings.minimizeToTray) app.quit(); });
