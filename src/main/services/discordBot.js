'use strict';
// Discord bot: slash commands (/check /list /start /stop /restart /update /send /backup /stats) restricted to
// settings.discord.allowedUserIds / adminRoleIds (default deny). The handlers live in discordCommands.js (no discord.js);
// this file wires the discord.js client: login, command registration, interactions, status.
// discord.js is required lazily, so the app and the tests run without it when the bot is off.
const path = require('path');
const cmds = require('./discordCommands');

/** Builds one SlashCommandBuilder per plain definition (so the plain JSON and the builders cannot drift apart). */
function buildCommands(D) {
  return cmds.COMMANDS.map((def) => {
    const b = new D.SlashCommandBuilder().setName(def.name).setDescription(def.description).setDMPermission(false);
    for (const o of def.options || []) {
      const set = (x) => {
        x.setName(o.name).setDescription(o.description).setRequired(!!o.required);
        if (o.autocomplete) x.setAutocomplete(true);
        if (o.min_length) x.setMinLength(o.min_length);
        if (o.max_length) x.setMaxLength(o.max_length);
        return x;
      };
      if (o.type === cmds.OPT.BOOLEAN) b.addBooleanOption(set); else b.addStringOption(set);
    }
    return b;
  });
}

function appVersion() { try { return require(path.join(__dirname, '..', '..', '..', 'package.json')).version; } catch { return 'unknown'; } }

class DiscordBot {
  /**
   * @param {import('../serverManager').ServerManager} mgr  server manager
   * @param {object} plugins  the plugins module (unused, kept for the common service signature)
   * @param {object} settings app settings snapshot (mgr.settings is the live object and is read at use time)
   * @param {string} dataDir  NodeGSM data folder
   * @param {{loadDiscord?: () => object, now?: () => number}} [opts]  loadDiscord: injectable discord.js module (tests)
   */
  constructor(mgr, plugins, settings, dataDir, opts = {}) {
    this.mgr = mgr; this.plugins = plugins; this.dataDir = dataDir;
    this.loadDiscord = opts.loadDiscord || (() => require('discord.js'));
    this.now = opts.now || Date.now;
    this.started = false; this.client = null; this.gen = 0; this.sig = null;
    this.collector = null;          // set by main.js (MetricsCollector) for /stats
    this.onStatus = null;           // (status) => void, pushed to the renderer as the "discordBot" event
    this.bootTime = Date.now();
    this._status = { state: 'off', user: '', error: '', guilds: 0, registered: false };
    this.handlers = cmds.createHandlers({ mgr, getSettings: () => this.settings, getCollector: () => this.collector, version: appVersion(), now: () => this.now(), bootTime: this.bootTime });
  }

  get settings() { return (this.mgr && this.mgr.settings) || {}; }
  get cfg() { return this.settings.discord || {}; }
  /** Settings that need a reconnect when they change. */
  signature() { const c = this.cfg; return JSON.stringify([!!c.botEnabled, c.botToken || '', c.applicationId || '', c.guildId || '']); }

  status() { return { ...this._status }; }
  _set(patch) {
    this._status = { ...this._status, ...patch };
    if (patch.error) this._status.error = cmds.redact(patch.error, this.cfg.botToken);
    try { if (this.onStatus) this.onStatus(this.status()); } catch { /* ignore */ }
  }
  _err(e) { return cmds.safeError(e, this.cfg.botToken); }

  /** Connect when enabled and a token is saved. Safe to call once at app start. */
  start() { this.started = true; return this.apply(true); }

  /** Clean shutdown (app quit). */
  async stop() { this.started = false; this.sig = null; await this._teardown(); this._set({ state: 'off', user: '', error: '', guilds: 0, registered: false }); }

  /** Re-read the settings; reconnect only when the bot fields changed (force: always). Returns the new status. */
  async apply(force = false) {
    if (!this.started) return this.status();
    const sig = this.signature();
    if (!force && sig === this.sig) return this.status();
    this.sig = sig;
    await this._teardown();
    return this._connect();
  }
  /** Apply the saved settings now (also reconnects after an error). */
  restart() { return this.apply(true); }

  async _teardown() {
    this.gen++;
    const c = this.client; this.client = null;
    if (c) { try { c.removeAllListeners(); c.on('error', () => {}); await c.destroy(); } catch { /* ignore */ } }
  }

  async _connect() {
    const c = this.cfg; const gen = this.gen;
    if (!c.botEnabled) { this._set({ state: 'off', user: '', error: '', guilds: 0, registered: false }); return this.status(); }
    if (!cmds.tokenFormatOk(c.botToken)) { this._set({ state: 'error', user: '', error: c.botToken ? 'The bot token does not look valid (expected three parts separated by dots).' : 'No bot token is saved.', guilds: 0, registered: false }); return this.status(); }
    let D;
    try { D = this.loadDiscord(); } catch (e) { this._set({ state: 'error', error: 'The discord.js package is not installed (run npm install).', user: '', guilds: 0, registered: false }); return this.status(); }
    this._set({ state: 'connecting', user: '', error: '', guilds: 0, registered: false });
    let client;
    try {
      client = new D.Client({ intents: [D.GatewayIntentBits.Guilds] });   // slash commands need no message content
    } catch (e) { this._set({ state: 'error', error: this._err(e) }); return this.status(); }
    this.client = client;
    const live = () => gen === this.gen && this.client === client;
    const E = D.Events || {};
    client.on('error', (e) => { if (live()) this._set({ error: this._err(e) }); });
    client.on(E.ShardDisconnect || 'shardDisconnect', () => { if (live()) this._set({ state: 'connecting' }); });
    client.on(E.ShardResume || 'shardResume', () => { if (live()) this._set({ state: 'online', error: '' }); });
    client.on(E.InteractionCreate || 'interactionCreate', (i) => {
      if (!live()) return;
      const run = i.isAutocomplete && i.isAutocomplete() ? this.handlers.autocomplete(i) : i.isChatInputCommand && i.isChatInputCommand() ? this.handlers.handle(i) : null;
      if (run) run.catch(() => { /* handlers answer the user themselves */ });
    });
    client.once(E.ClientReady || 'ready', async () => {
      if (!live()) return;
      this._set({ state: 'online', user: client.user ? client.user.tag || client.user.username : '', error: '', guilds: client.guilds && client.guilds.cache ? client.guilds.cache.size : 0 });
      try {
        const payload = buildCommands(D).map((b) => b.toJSON());
        const gid = this.cfg.guildId;
        if (gid) await client.application.commands.set(payload, gid); else await client.application.commands.set(payload);
        if (live()) this._set({ registered: true });
      } catch (e) { if (live()) this._set({ registered: false, error: 'Registering the slash commands failed: ' + this._err(e) }); }
    });
    try { await client.login(c.botToken); }
    catch (e) {
      if (live()) { this._set({ state: 'error', user: '', error: this._err(e), guilds: 0, registered: false }); this.client = null; try { client.removeAllListeners(); client.on('error', () => {}); await client.destroy(); } catch { /* ignore */ } }
    }
    return this.status();
  }
}

module.exports = { DiscordBot, buildCommands };
