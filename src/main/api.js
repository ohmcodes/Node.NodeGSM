'use strict';
// Transport-agnostic API table: { channelName: fn(...args) }.
// Electron mounts it on ipcMain (see main.js); a future HTTP/WebSocket server can mount the same table.
// Functions return plain data or throw; the transport wraps the result as { ok, data } / { ok:false, error }.
const { detail: pluginDetail } = require('./plugins');
const appSettings = require('./settings');

/**
 * @param {object} ctx
 *   mgr          ServerManager
 *   collector    MetricsCollector
 *   publicGames  () => array
 *   shell, dialog, app, nativeTheme   Electron modules (injected so this file stays testable)
 *   getWin       () => BrowserWindow | undefined
 *   currentBg    () => string
 *   beforeRelaunch  async () => void   (marks the app as quitting)
 *   eventLog, discord, cluster   service instances (services/eventLog.js, services/discord.js, services/cluster.js)
 */
function buildApi(ctx) {
  const { mgr, collector, shell, dialog, app, nativeTheme, getWin, currentBg } = ctx;
  const svc = (k) => { if (!ctx[k]) throw new Error(`Service not available: ${k}`); return ctx[k]; };
  return {
    games: () => ctx.publicGames(),
    list: () => mgr.list(),
    get: (id) => mgr.getConfig(id),
    create: (game, name) => mgr.view(mgr.create(game, name).id),
    import: (game, name, dir) => mgr.view(mgr.importServer(game, name, dir).id),
    install: (id) => mgr.install(id),
    save: (id, patch) => { mgr.saveConfig(id, patch); return mgr.view(id); },
    start: (id) => mgr.start(id),
    stop: (id) => mgr.stop(id),
    restart: (id) => mgr.restart(id),
    remove: (id, files) => mgr.remove(id, files),
    console: (id) => mgr.getConsole(id),
    command: (id, text) => mgr.sendCommand(id, text),
    checkUpdate: (id) => mgr.checkUpdate(id),
    update: (id, validate) => mgr.update(id, validate),
    // backups (services/backup.js): backups() lists every server's backups, backups(id) one folder
    backups: (id) => (id === undefined || id === null || id === '' ? mgr.bk().listAll() : mgr.bk().list(id)),
    backup: (id, opts) => mgr.backup(id, opts),
    backupInfo: (id) => mgr.bk().info(id),
    backupPreview: (id, opts) => mgr.bk().preview(id, opts),
    restore: (id, f, opts) => mgr.restore(id, f, opts),
    restoreNew: async (folder, f, opts) => { const r = await mgr.bk().restoreAsNew({ folder, file: f }, opts); return { ...r, server: mgr.view(r.id) }; },
    deleteBackup: (id, f) => mgr.deleteBackup(id, f),
    backupDownload: (folder, f) => shell.showItemInFolder(mgr.bk().filePath(folder, f)),
    backupOpenFolder: (folder) => shell.openPath(mgr.bk().dirOf(folder)),
    firewall: (id, on) => mgr.firewall(id, on),
    listDir: (id, rel) => mgr.listDir(id, rel),
    readFile: (id, rel) => mgr.readTextFile(id, rel),
    writeFile: (id, rel, t) => mgr.writeTextFile(id, rel, t),
    openFolder: (id) => shell.openPath(mgr.filesDir(id)),
    configList: (id) => mgr.configList(id),
    configRead: (id, c) => mgr.readConfig(id, c),
    configWrite: (id, c, t) => mgr.writeConfig(id, c, t),
    configCreate: (id, c) => mgr.createConfig(id, c),
    logsList: (id) => mgr.logsList(id),
    logStart: (id, l) => mgr.logStart(id, l),
    logStop: (id, l) => mgr.logStop(id, l),
    pluginDetail: (id) => pluginDetail(id),
    openExternal: (u) => { if (!/^https?:\/\//i.test(String(u))) throw new Error('Only http(s) links can be opened'); return shell.openExternal(String(u)); },
    bulk: (action, ids) => mgr.bulk(action, ids),
    kill: (id) => mgr.kill(id),
    eventLogQuery: (f) => svc('eventLog').query(f),
    eventLogExport: (f) => svc('eventLog').export(f),
    eventLogClear: () => svc('eventLog').clear(),
    // clusters (services/cluster.js)
    clusters: () => svc('cluster').list(),
    clusterCreate: (o) => svc('cluster').create(o),
    clusterSave: (id, patch) => svc('cluster').save(id, patch),
    clusterDelete: (id) => svc('cluster').delete(id),
    clusterUpdatePlan: (id, o) => svc('cluster').updatePlan(id, o),
    clusterUpdate: (id, o) => svc('cluster').update(id, o),
    clusterConfigPlan: (id, o) => svc('cluster').configPlan(id, o),
    clusterConfigApply: (id, o) => svc('cluster').configApply(id, o),
    clusterClearPlan: (id, o) => svc('cluster').clearPlan(id, o),
    clusterClear: (id, o) => svc('cluster').clear(id, o),
    discordInfo: () => svc('discord').info(),
    discordTest: (kind, template) => svc('discord').test(kind, template),
    discordPreview: (template, sampleVars, event) => svc('discord').preview(template, sampleVars, event),
    settingsDefaults: () => appSettings.DEFAULTS,
    metricsState: () => collector.state(),
    pluginsInfo: () => mgr.pluginInfo,
    pluginsReload: () => mgr.reloadPlugins(),
    pluginsInstallZip: async () => {
      const r = await dialog.showOpenDialog(getWin(), { filters: [{ name: 'Plugin zip', extensions: ['zip'] }], properties: ['openFile'] });
      return r.canceled ? null : mgr.installPlugin(r.filePaths[0]);
    },
    pluginsInstallFolder: async () => {
      const r = await dialog.showOpenDialog(getWin(), { properties: ['openDirectory'] });
      return r.canceled ? null : mgr.installPlugin(r.filePaths[0]);
    },
    pluginsFolder: () => shell.openPath(mgr.pluginsDir),
    metrics: () => mgr.metrics(),
    settings: () => mgr.settings,
    saveSettings: (p) => {
      const s = mgr.saveSettings(p);
      app.setLoginItemSettings({ openAtLogin: !!s.startOnLogin });
      nativeTheme.themeSource = s.theme;
      const win = getWin();
      if (win && !win.isDestroyed()) win.setBackgroundColor(currentBg());
      return s;
    },
    relaunch: async () => {
      ctx.beforeRelaunch();
      try { await mgr.shutdown(); } catch { /* ignore */ }
      app.relaunch();
      app.exit(0);
    },
    pickFolder: async () => {
      const r = await dialog.showOpenDialog(getWin(), { properties: ['openDirectory'] });
      return r.canceled ? null : r.filePaths[0];
    },
  };
}

module.exports = { buildApi };
