'use strict';
// Clusters: groups of same-game servers with a parent; cluster update, config sync honouring plugin cluster.protectedConfigKeys / configs[].protect, and clearFolders. Data in <data>/clusters.json.
// Skeleton (Phase 0): construction and start()/stop() are wired in main.js but do nothing yet.

class Cluster {
  /**
   * @param {import('../serverManager').ServerManager} mgr  server manager (mgr.events emits server:* events)
   * @param {object} plugins  the plugins module (GAMES, byId, ...)
   * @param {object} settings app settings snapshot (mgr.settings is the live object)
   * @param {string} dataDir  NodeGSM data folder
   */
  constructor(mgr, plugins, settings, dataDir) {
    this.mgr = mgr; this.plugins = plugins; this.settings = settings; this.dataDir = dataDir;
    this.started = false;
  }

  /** Subscribe to events / start timers. Safe to call once. */
  start() { this.started = true; }

  /** Unsubscribe and stop timers. */
  stop() { this.started = false; }
}

module.exports = { Cluster };
