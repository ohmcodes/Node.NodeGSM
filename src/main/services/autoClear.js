'use strict';
// Auto-clear: periodically deletes old files by folder/pattern/age (plugin files.autoClear rules + per-server rules), confined to the server folder.
// Skeleton (Phase 0): construction and start()/stop() are wired in main.js but do nothing yet.

class AutoClear {
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

module.exports = { AutoClear };
