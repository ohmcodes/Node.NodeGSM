'use strict';
// Transport-agnostic bootstrap shared by the Electron app (main.js) and the headless web server (src/server/headless.js).
// Creates the data dir contents, settings, plugins, ServerManager, services, MetricsCollector and the push-event hub.
// This file (and everything it requires) must never load 'electron'.
const platform = require('./platform');
const { ServerManager } = require('./serverManager');
const plugins = require('./plugins');
const { MetricsCollector } = require('./metrics');
const { buildApi } = require('./api');
const { EventLog } = require('./services/eventLog');
const { Discord } = require('./services/discord');
const { DiscordBot } = require('./services/discordBot');
const { BackupService } = require('./services/backup');
const { Cluster } = require('./services/cluster');
const { AutoClear } = require('./services/autoClear');
const { Consoles } = require('./services/consoles');
const { Catalogue } = require('./catalogue');

/** Game list as the renderer sees it (no hooks, no readme). */
function publicGames() {
  return plugins.GAMES.map(({ id, name, icon, description, tags, port, queryPort, map, maxPlayers, additional, appId, query, gslt, source, author, version, overrides, platforms, supported }) =>
    ({ id, name, icon, description, tags, port, queryPort, map, maxPlayers, additional, appId, query, gslt: !!gslt, source, author, version, overrides: !!overrides, platforms, supported }));
}

/** Push events (status, console, ...): transports subscribe with hub.on(fn(channel, payload)) and get an unsubscribe function back. */
function createHub() {
  const subs = new Set();
  return {
    on(fn) { subs.add(fn); return () => subs.delete(fn); },
    emit(ch, payload) { for (const fn of [...subs]) { try { fn(ch, payload); } catch { /* a broken subscriber must not stop the others */ } } },
    get size() { return subs.size; },
  };
}

/** What the renderer may show: desktop = every feature, web = the ones that need a native window are off. */
function platformInfo(mode, plat = platform.current()) {
  const desktop = mode !== 'web';
  return {
    mode: desktop ? 'desktop' : 'web',
    platform: plat,
    features: {
      pickFolder: desktop, openFolder: desktop, revealBackup: desktop, backupDownload: !desktop,
      relaunch: desktop, dataLocation: desktop, tray: desktop, startOnLogin: desktop, hardwareAcceleration: desktop,
      installPluginFile: desktop, pluginsFolder: desktop, firewall: plat === 'windows',
    },
  };
}

/**
 * @param {object} o
 *   dataDir  string
 *   mode     'desktop' | 'web'
 */
function createCore({ dataDir, mode = 'desktop' }) {
  const hub = createHub();
  const mgr = new ServerManager(dataDir);
  mgr.on('status', (v) => hub.emit('status', v));
  mgr.on('console', (m) => hub.emit('console', m));
  mgr.on('removed', (id) => hub.emit('removed', id));
  mgr.on('logLines', (m) => hub.emit('logLines', m));
  mgr.on('consoleOut', (m) => hub.emit('consoleOut', m));
  const collector = new MetricsCollector(mgr);
  collector.on('metrics', (m) => hub.emit('metrics', m));

  // Services subscribe to mgr.events (see services/*.js)
  const instances = [EventLog, Discord, DiscordBot, BackupService, Cluster, AutoClear, Consoles].map((S) => new S(mgr, plugins, mgr.settings, dataDir));
  const [eventLog, discord] = instances;
  const cluster = instances.find((x) => x instanceof Cluster);
  const autoClear = instances.find((x) => x instanceof AutoClear);
  const consoles = instances.find((x) => x instanceof Consoles);
  const discordBot = instances.find((x) => x instanceof DiscordBot);
  discordBot.collector = collector;
  discordBot.onStatus = (st) => hub.emit('discordBot', st);
  cluster.onProgress = (p) => hub.emit('cluster:progress', p);

  const catalogue = new Catalogue(dataDir, () => mgr.settings, (zip) => mgr.installPlugin(zip));

  let started = false; let stopped = false;
  return {
    dataDir, mode, mgr, collector, hub, catalogue, services: instances, eventLog, discord, discordBot, cluster, autoClear, consoles, publicGames,
    platformInfo: () => platformInfo(mode),
    /** IPC table for this core; extra = transport specific ctx (shell, dialog, app, nativeTheme, getWin, currentBg, beforeRelaunch). */
    buildApi: (extra = {}) => buildApi({ mgr, collector, publicGames, catalogue, eventLog, discord, discordBot, cluster, autoClear, consoles, platformInfo: () => platformInfo(mode), emit: (ch, p) => hub.emit(ch, p), ...extra }),
    start() {
      if (started) return; started = true;
      instances.forEach((s) => s.start());
      mgr.startScheduler();
      collector.start();
      mgr.autoStartAll();
    },
    /** Stops the collector, the services and every running game server (same path for Electron quit and SIGTERM). */
    async stop() {
      if (stopped) return; stopped = true;
      try { collector.stop(); await Promise.all(instances.map((x) => Promise.resolve(x.stop()).catch(() => {}))); await mgr.shutdown(); } catch { /* best effort */ }
    },
  };
}

/** Stand-ins for the Electron members of the api ctx when running headless (web mode). */
function headlessHost({ restartHint = 'Restart the NodeGSM service yourself (for example: systemctl restart nodegsm).' } = {}) {
  const no = (what) => () => { throw new Error(`${what} is not available in web mode.`); };
  return {
    shell: { showItemInFolder: no('Revealing a file'), openPath: no('Opening a folder'), openExternal: no('Opening links on the server') },
    dialog: { showOpenDialog: no('The folder / file picker (type the path instead)') },
    app: { setLoginItemSettings() {}, relaunch() {}, exit() {} },
    nativeTheme: {},
    getWin: () => null,
    currentBg: () => '#14161c',
    beforeRelaunch() { throw new Error(restartHint); },
  };
}

module.exports = { createCore, createHub, publicGames, platformInfo, headlessHost };
