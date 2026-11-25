'use strict';
// Discord bot slash commands: definitions (plain JSON in Discord's API shape), authorisation, rate limit, handlers and formatting.
// This file never imports discord.js: handlers take an interaction-like object, so tests drive them with fakes.
//   interaction = { commandName, user:{id,tag}, member:{roles:{cache}|string[]}, options:{getString,getBoolean,getFocused},
//                   reply, deferReply, editReply, followUp, deleteReply?, respond? (autocomplete) }
// Every attempt (allowed, denied, rate limited, failed) is written to the NGSM event log as "discord:command".

const EPHEMERAL = 64;                 // MessageFlags.Ephemeral
const OPT = { STRING: 3, BOOLEAN: 5 };// ApplicationCommandOptionType
const MAX_SEND = 500;                 // /send command length cap
const RATE = { max: 5, windowMs: 10000 };
const DASH = '—';
const COLORS = { ok: 0x2ecc71, info: 0x3498db, warn: 0xf1c40f, bad: 0xe74c3c };

const serverOpt = { type: OPT.STRING, name: 'serverid', description: 'Server (type to search by id or name)', required: true, autocomplete: true };

/** Registration payload (Discord API shape). Names: lowercase, <= 32 chars; descriptions <= 100 chars. */
const COMMANDS = [
  { name: 'check', description: 'NodeGSM health: version, uptime, servers running, CPU and RAM', mutating: false },
  { name: 'list', description: 'List the game servers with status and players', mutating: false },
  { name: 'start', description: 'Start a game server', mutating: true, options: [serverOpt] },
  { name: 'stop', description: 'Stop a game server', mutating: true, options: [serverOpt] },
  { name: 'restart', description: 'Restart a game server', mutating: true, options: [serverOpt] },
  { name: 'update', description: 'Update a game server (stops and restarts it when it was running)', mutating: true,
    options: [serverOpt, { type: OPT.BOOLEAN, name: 'validate', description: 'Also validate (re-check) every game file - slower', required: false }] },
  { name: 'send', description: 'Send a console command to a server (needs "allow raw commands" in NodeGSM)', mutating: true,
    options: [serverOpt, { type: OPT.STRING, name: 'command', description: `Console command, up to ${MAX_SEND} characters`, required: true, min_length: 1, max_length: MAX_SEND }] },
  { name: 'backup', description: 'Create a backup of a game server', mutating: true, options: [serverOpt] },
  { name: 'stats', description: 'System CPU / RAM / disk and per-server CPU, RAM, players and tick', mutating: false },
];
const BY_NAME = Object.fromEntries(COMMANDS.map((c) => [c.name, c]));

/** The payload sent to Discord (internal `mutating` flag removed). */
function registrationJson() {
  return COMMANDS.map(({ name, description, options }) => ({ name, description, ...(options ? { options: options.map((o) => ({ ...o })) } : {}) }));
}

// ---------- token redaction ----------
const TOKEN_RE = /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}/g;
/** Remove the bot token (exact value and anything shaped like one) from text. */
function redact(text, token) {
  let s = String(text == null ? '' : text);
  if (token) s = s.split(String(token)).join('[token]');
  return s.replace(TOKEN_RE, '[token]').replace(/\bBot\s+[A-Za-z0-9._-]{20,}/g, 'Bot [token]');
}
/** Loose format check only (three dot separated parts). Real validation is the login. */
function tokenFormatOk(token) { return typeof token === 'string' && /^[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}$/.test(token.trim()); }

// ---------- formatting ----------
const clip = (v, n) => { const s = String(v == null ? '' : v); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
function fmtBytes(n) {
  n = Number(n); if (!Number.isFinite(n) || n < 0) return 'n/a';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}
function fmtDuration(ms) {
  let s = Math.max(0, Math.floor(Number(ms) / 1000)); if (!Number.isFinite(s)) return 'n/a';
  const d = Math.floor(s / 86400); s %= 86400; const h = Math.floor(s / 3600); s %= 3600; const m = Math.floor(s / 60);
  return d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}
const pct = (v) => (typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(0)}%` : 'n/a');
const embed = (title, description, color, extra = {}) => ({ title: clip(title, 256), description: clip(description, 4000), color, footer: { text: 'NodeGSM' }, ...extra });

/** Error text safe to show in Discord: single readable line, no token. */
function safeError(e, token) { return clip(redact(e && e.message ? e.message : e, token).replace(/\s+/g, ' ').trim(), 300) || 'Unknown error'; }

class Refusal extends Error { }   // a readable "no" (unknown server, busy, not running ...) - not a failure

// ---------- authorisation ----------
function memberRoleIds(member) {
  const r = member && member.roles;
  if (!r) return [];
  if (Array.isArray(r)) return r.map(String);
  const c = r.cache || r;
  if (Array.isArray(c)) return c.map(String);
  if (typeof c.keys === 'function') return [...c.keys()].map(String);   // Map / Collection (role id -> role) or Set of ids
  return [];
}
const asList = (v) => (Array.isArray(v) ? v.map(String) : []);

/**
 * Who may use the bot. Default deny: an empty allowlist and no admin role means nobody.
 * @returns {{ok:boolean, admin:boolean, reason?:string}}
 */
function authorize(discordCfg, user, member) {
  const cfg = discordCfg || {};
  const id = user && user.id != null ? String(user.id) : '';
  const adminRoles = asList(cfg.adminRoleIds);
  const admin = adminRoles.length > 0 && memberRoleIds(member).some((r) => adminRoles.includes(r));
  if (admin) return { ok: true, admin: true };
  if (id && asList(cfg.allowedUserIds).includes(id)) return { ok: true, admin: false };
  return { ok: false, admin: false, reason: 'not authorised' };
}
/** Per-server restriction: when wgsm.json has a non-empty discordAllowedUserIds only those users (and admins) may act on that server. */
function serverAllows(serverCfg, user, auth) {
  const list = asList(serverCfg && serverCfg.discordAllowedUserIds);
  return !list.length || auth.admin || list.includes(String(user.id));
}

// ---------- rate limit ----------
class RateLimiter {
  constructor({ max = RATE.max, windowMs = RATE.windowMs, now = Date.now } = {}) { this.max = max; this.windowMs = windowMs; this.now = now; this.hits = new Map(); }
  /** Records an attempt. Returns 'ok', 'first' (first one over the limit in this window: log it) or 'limited'. */
  hit(key) {
    const t = this.now();
    const list = (this.hits.get(key) || []).filter((x) => t - x < this.windowMs);
    list.push(t); this.hits.set(key, list);
    if (this.hits.size > 500) for (const [k, v] of this.hits) if (!v.some((x) => t - x < this.windowMs)) this.hits.delete(k);
    return list.length <= this.max ? 'ok' : list.length === this.max + 1 ? 'first' : 'limited';
  }
}

/**
 * @param {object} deps
 *   mgr         ServerManager (or a fake): getConfig, list, view, isRunning, start, stop, restart, update, backup, sendCommand, eventLog, events
 *   getSettings () => app settings (read live so changes apply without a restart)
 *   getCollector () => MetricsCollector | null
 *   version     app version string
 *   now         clock (ms)
 *   bootTime    process start (ms) for /check uptime
 */
function createHandlers(deps) {
  const { mgr } = deps;
  const now = deps.now || Date.now;
  const limiter = deps.limiter || new RateLimiter({ now });
  const settings = () => (deps.getSettings ? deps.getSettings() : mgr.settings) || {};
  const dcfg = () => settings().discord || {};
  const token = () => dcfg().botToken || '';
  const snapshot = () => { try { const c = deps.getCollector && deps.getCollector(); return c && c.state ? c.state().snapshot : null; } catch { return null; } };

  function logAttempt(user, cmdName, serverId, result, level = 'info', extra = {}) {
    const tag = (user && (user.tag || user.username)) || 'unknown';
    const id = user && user.id != null ? String(user.id) : '';
    const detail = { userId: id, userTag: tag, command: cmdName, serverId: serverId || '', result, ...extra };
    const entry = { level, event: 'discord:command', serverId: serverId || undefined, message: clip(`${tag} (${id}) /${cmdName}${serverId ? ' ' + serverId : ''}: ${result}`, 500), detail };
    try { if (mgr.eventLog && mgr.eventLog.log) mgr.eventLog.log(entry); } catch { /* never fail the command */ }
    try { if (mgr.events && mgr.events.emit) mgr.events.emit('discord:command', { ...entry, ts: new Date(now()).toISOString() }); } catch { /* ignore */ }
  }

  const views = () => { try { return mgr.list(); } catch { return []; } };
  function findServer(raw, mutating) {
    const id = String(raw == null ? '' : raw).trim();
    const cfg = id ? mgr.getConfig(id) : null;
    if (!cfg) throw new Refusal(`No server with id \`${clip(id, 40)}\`. Use /list to see the ids.`);
    const view = mgr.view(id);
    if (mutating && view && view.pending) throw new Refusal(`**${cfg.name}** is busy (${view.pending}). Try again when it has finished.`);
    return { id, cfg, view, running: !!(mgr.isRunning && mgr.isRunning(id)) };
  }
  const label = (s) => `**${clip(s.cfg.name, 100)}** (#${s.id})`;

  // ---------- command actions: (c) => Promise ----------
  const actions = {
    async check(c) {
      const v = views(); const running = v.filter((x) => mgr.isRunning && mgr.isRunning(x.id)).length;
      const snap = snapshot(); const sys = snap && snap.system;
      const fields = [
        { name: 'Version', value: String(deps.version || 'unknown'), inline: true },
        { name: 'Uptime', value: fmtDuration(now() - (deps.bootTime || now())), inline: true },
        { name: 'Servers', value: `${running} running / ${v.length} total`, inline: true },
        { name: 'CPU', value: sys ? pct(sys.cpuPercent) : 'n/a', inline: true },
        { name: 'RAM', value: sys ? `${fmtBytes(sys.memUsed)} / ${fmtBytes(sys.memTotal)}` : 'n/a', inline: true },
      ];
      await c.reply({ embeds: [embed('NodeGSM is running', 'Everything is up.', COLORS.ok, { fields })] });
    },

    async list(c) {
      const v = views();
      if (!v.length) return c.reply({ embeds: [embed('Servers', 'No servers are installed yet.', COLORS.info)] });
      const lines = v.slice(0, 40).map((x) => {
        const max = x.maxPlayersLive || x.maxPlayers;
        const pl = x.players != null ? ` - ${x.players}${max ? '/' + max : ''} players` : '';
        return `\`${x.id}\` **${clip(x.name, 60)}** (${clip(x.gameName || x.game, 40)}) - ${x.pending || x.status}${pl}`;
      });
      if (v.length > 40) lines.push(`... and ${v.length - 40} more`);
      await c.reply({ embeds: [embed(`Servers (${v.length})`, lines.join('\n'), COLORS.info)] });
    },

    async start(c) {
      const s = findServer(c.str('serverid'), true); c.serverId = s.id;
      if (s.running) throw new Refusal(`${label(s)} is already running.`);
      await c.defer(); await mgr.start(s.id);
      await c.finish(embed('Server started', `${label(s)} was started.`, COLORS.ok));
    },
    async stop(c) {
      const s = findServer(c.str('serverid'), true); c.serverId = s.id;
      if (!s.running) throw new Refusal(`${label(s)} is not running.`);
      await c.defer(); await mgr.stop(s.id);
      await c.finish(embed('Server stopped', `${label(s)} was stopped.`, COLORS.info));
    },
    async restart(c) {
      const s = findServer(c.str('serverid'), true); c.serverId = s.id;
      if (!s.running) throw new Refusal(`${label(s)} is not running. Use /start instead.`);
      await c.defer(); await mgr.restart(s.id);
      await c.finish(embed('Server restarted', `${label(s)} was restarted.`, COLORS.info));
    },
    async update(c) {
      const s = findServer(c.str('serverid'), true); c.serverId = s.id;
      const validate = c.bool('validate') === true;
      await c.defer(); const t0 = now();
      await mgr.update(s.id, validate);
      await c.finish(embed(validate ? 'Server validated and updated' : 'Server updated', `${label(s)} was ${validate ? 'validated and updated' : 'updated'}${s.running ? ' and started again' : ''}.`, COLORS.ok, { fields: [{ name: 'Took', value: fmtDuration(now() - t0), inline: true }] }));
    },
    async backup(c) {
      const s = findServer(c.str('serverid'), true); c.serverId = s.id;
      await c.defer(); const t0 = now();
      const file = await mgr.backup(s.id);
      await c.finish(embed('Backup created', `A backup of ${label(s)} was created.`, COLORS.ok, { fields: [{ name: 'File', value: clip(file && file.file ? file.file : file, 200) || 'n/a', inline: false }, { name: 'Took', value: fmtDuration(now() - t0), inline: true }] }));
    },
    async send(c) {
      if (dcfg().allowRawCommands !== true) throw new Refusal('Raw console commands are switched off. Enable **Allow raw commands (/send)** in NodeGSM > Discord > Bot to use /send.');
      const s = findServer(c.str('serverid'), true); c.serverId = s.id;
      const text = String(c.str('command') == null ? '' : c.str('command'));
      if (!text.trim()) throw new Refusal('The command is empty.');
      if (text.length > MAX_SEND) throw new Refusal(`The command is too long (${text.length} characters, the limit is ${MAX_SEND}).`);
      if (/[\r\n\0]/.test(text)) throw new Refusal('The command must be a single line.');
      if (!s.running) throw new Refusal(`${label(s)} is not running.`);
      mgr.sendCommand(s.id, text);
      c.extra = { length: text.length };
      await c.reply({ embeds: [embed('Command sent', `Sent a ${text.length}-character command to ${label(s)}.`, COLORS.ok)] }, true);
    },

    async stats(c) {
      const snap = snapshot();
      if (!snap) return c.reply({ embeds: [embed('Statistics', 'No metrics have been collected yet. Try again in a few seconds.', COLORS.warn)] });
      const sys = snap.system || {};
      const fields = [
        { name: 'CPU', value: pct(sys.cpuPercent), inline: true },
        { name: 'RAM', value: `${fmtBytes(sys.memUsed)} / ${fmtBytes(sys.memTotal)}`, inline: true },
        { name: 'Disk', value: sys.disk ? `${fmtBytes(sys.disk.used)} / ${fmtBytes(sys.disk.total)} (${sys.disk.drive})` : 'n/a', inline: true },
      ];
      const run = (snap.servers || []).filter((r) => r.pid);
      const lines = run.slice(0, 25).map((r) => {
        const tick = r.tick ? `${Math.round(r.tick.value * 10) / 10} ${r.tick.unit || ''}`.trim() : r.metrics && r.metrics.latency ? `${Math.round(r.metrics.latency.value)} ms latency` : 'n/a';
        return `\`${r.id}\` **${clip(r.name, 40)}** - CPU ${pct(r.cpu)}, RAM ${r.mem != null ? fmtBytes(r.mem) : 'n/a'}, players ${r.players != null ? r.players + (r.maxPlayers ? '/' + r.maxPlayers : '') : 'n/a'}, tick ${tick}`;
      });
      await c.reply({ embeds: [embed('Statistics', lines.length ? lines.join('\n') : 'No server is running.', COLORS.info, { fields })] });
    },
  };

  // ---------- main entry ----------
  async function handle(interaction) {
    const user = interaction.user || {};
    const name = interaction.commandName;
    const def = BY_NAME[name];
    const noMentions = { allowedMentions: { parse: [] } };
    let deferred = false;
    const ctx = {
      serverId: '', extra: {},
      str: (n) => (interaction.options && interaction.options.getString ? interaction.options.getString(n) : null),
      bool: (n) => (interaction.options && interaction.options.getBoolean ? interaction.options.getBoolean(n) : null),
      reply: (body, ephemeral = false) => interaction.reply({ ...body, ...noMentions, ...(ephemeral ? { flags: EPHEMERAL } : {}) }),
      defer: async () => { await interaction.deferReply(); deferred = true; },
      finish: (embedBody) => (deferred ? interaction.editReply({ embeds: [embedBody], ...noMentions }) : ctx.reply({ embeds: [embedBody] })),
    };
    // errors and refusals are ephemeral; after a public defer the placeholder is removed and the error follows privately
    const sayNo = async (text) => {
      const body = { embeds: [embed('Cannot do that', text, COLORS.bad)], ...noMentions };
      try {
        if (deferred) {
          let removed = false;
          if (interaction.deleteReply) { try { await interaction.deleteReply(); removed = true; } catch { /* fall through */ } }
          if (removed) { await interaction.followUp({ ...body, flags: EPHEMERAL }); return; }
          await interaction.editReply(body); return;
        }
        await interaction.reply({ ...body, flags: EPHEMERAL });
      } catch { /* the interaction expired */ }
    };

    if (!def) { await sayNo('Unknown command.'); logAttempt(user, String(name), '', 'unknown command', 'warn'); return { result: 'unknown command' }; }

    const rl = limiter.hit(String(user.id));
    if (rl !== 'ok') {
      if (rl === 'first') logAttempt(user, name, '', 'rate limited', 'warn');
      await sayNo(`Slow down: at most ${RATE.max} commands per ${RATE.windowMs / 1000} seconds.`);
      return { result: 'rate limited' };
    }

    const auth = authorize(dcfg(), user, interaction.member);
    if (!auth.ok) {
      logAttempt(user, name, '', 'denied: not authorised', 'warn');
      await sayNo('You are not authorised to use NodeGSM commands.');
      return { result: 'denied' };
    }

    try {
      // per-server restriction (mutating commands only; the server id is validated inside the action first)
      if (def.mutating) {
        const raw = ctx.str('serverid');
        const cfg = raw ? mgr.getConfig(String(raw).trim()) : null;
        if (cfg && !serverAllows(cfg, user, auth)) {
          logAttempt(user, name, String(raw).trim(), 'denied: server restricted', 'warn');
          await sayNo('You are not authorised to control this server.');
          return { result: 'denied' };
        }
      }
      await actions[name](ctx);
      logAttempt(user, name, ctx.serverId, 'ok', 'info', ctx.extra);
      return { result: 'ok' };
    } catch (e) {
      const refused = e instanceof Refusal;
      const msg = safeError(e, token());
      logAttempt(user, name, ctx.serverId, refused ? `refused: ${msg}` : `error: ${msg}`, refused ? 'warn' : 'error', ctx.extra);
      await sayNo(refused ? msg : `The command failed: ${msg}`);
      return { result: refused ? 'refused' : 'error' };
    }
  }

  /** Autocomplete for the serverid option: "<id> - <name>" for the servers the user may see. Answers [] to unauthorised users. */
  async function autocomplete(interaction) {
    const respond = (list) => interaction.respond(list.slice(0, 25));
    try {
      const auth = authorize(dcfg(), interaction.user || {}, interaction.member);
      if (!auth.ok) return respond([]);
      const focused = interaction.options && interaction.options.getFocused ? interaction.options.getFocused(true) : { name: 'serverid', value: '' };
      const f = focused && typeof focused === 'object' ? focused : { name: 'serverid', value: String(focused || '') };
      if (f.name !== 'serverid') return respond([]);
      const q = String(f.value || '').toLowerCase().trim();
      const out = [];
      for (const v of views()) {
        const cfg = { discordAllowedUserIds: v.discordAllowedUserIds };
        if (!serverAllows(cfg, interaction.user || {}, auth)) continue;
        const text = `${v.id} ${DASH} ${v.name}`;
        if (!q || String(v.id).toLowerCase().includes(q) || String(v.name).toLowerCase().includes(q)) out.push({ name: clip(text, 100), value: String(v.id) });
      }
      return respond(out);
    } catch { try { return respond([]); } catch { return undefined; } }
  }

  return { handle, autocomplete, limiter, logAttempt };
}

module.exports = {
  COMMANDS, BY_NAME, OPT, EPHEMERAL, MAX_SEND, RATE, DASH,
  registrationJson, createHandlers, authorize, serverAllows, memberRoleIds, RateLimiter, Refusal,
  redact, safeError, tokenFormatOk, fmtBytes, fmtDuration,
};
