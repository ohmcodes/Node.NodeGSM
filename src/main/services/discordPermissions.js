'use strict';
// Discord bot permission rules: parse / format / sanitise / match. Pure functions, no I/O, no discord.js.
// A rule is { userId, serverId, actions[] }. Text form (one rule per line, "#" starts a comment):
//     <discordUserId> <serverId> <action,action,...>        e.g.  123456789012345678 3 start,stop,restart,backup
// serverId: a NodeGSM server id, or 0 / * for ALL servers. actions: any of ACTIONS plus the shortcuts "all" and "read".

const ACTIONS = ['check', 'list', 'start', 'stop', 'restart', 'update', 'send', 'backup', 'stats'];
const READ = ['check', 'list', 'stats'];
const GLOBAL_ACTIONS = ['check', 'list', 'stats'];   // not tied to one server (list is filtered to the servers the user has any permission for)
const SHORTCUTS = { all: ACTIONS, read: READ };
const MAX_RULES = 500;
const USER_ID = /^\d{15,25}$/;
const SERVER_ID = /^\d{1,9}$/;

/** Server id as stored: '*' and 0 -> '0' (all servers), leading zeros dropped. Returns '' when invalid. */
function normServerId(v) {
  const s = String(v == null ? '' : v).trim();
  if (s === '*') return '0';
  return SERVER_ID.test(s) ? String(parseInt(s, 10)) : '';
}
/** Expand shortcuts, drop unknown names, canonical order. unknown[] collects what was dropped. */
function normActions(list, unknown) {
  const set = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const a = String(raw == null ? '' : raw).trim().toLowerCase();
    if (!a) continue;
    if (SHORTCUTS[a]) SHORTCUTS[a].forEach((x) => set.add(x));
    else if (ACTIONS.includes(a)) set.add(a);
    else if (unknown) unknown.push(a);
  }
  return ACTIONS.filter((a) => set.has(a));
}
/** Merge rules of the same user + server (union of actions); keeps first-seen order. */
function merge(rules) {
  const map = new Map();
  for (const r of rules) {
    const k = r.userId + ' ' + r.serverId;
    const cur = map.get(k);
    if (cur) cur.actions = ACTIONS.filter((a) => cur.actions.includes(a) || r.actions.includes(a));
    else map.set(k, { userId: r.userId, serverId: r.serverId, actions: [...r.actions] });
  }
  return [...map.values()];
}

/** Strict sanitiser for settings.json / IPC: invalid rules are dropped, unknown actions removed, merged, capped. */
function sanitizeRules(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const r of v.slice(0, MAX_RULES * 2)) {
    if (!r || typeof r !== 'object') continue;
    const userId = String(r.userId == null ? '' : r.userId).trim();
    const serverId = normServerId(r.serverId);
    if (!USER_ID.test(userId) || !serverId) continue;
    const actions = normActions(r.actions);
    if (!actions.length) continue;
    out.push({ userId, serverId, actions });
  }
  return merge(out).slice(0, MAX_RULES);
}

/**
 * Lenient text parser with line-level reports.
 * @param {string} text
 * @param {{knownServerIds?: string[]}} [opts]  when given, a server id that does not exist yet is a warning (servers may be created later)
 * @returns {{rules:object[], errors:{line:number,text:string,message:string}[], warnings:{line:number,text:string,message:string}[]}}
 */
function parseRules(text, opts = {}) {
  const known = Array.isArray(opts.knownServerIds) ? new Set(opts.knownServerIds.map(String)) : null;
  const errors = []; const warnings = []; const rules = [];
  const lines = String(text == null ? '' : text).split(/\r\n|\r|\n/);
  lines.forEach((raw, i) => {
    const line = i + 1;
    const body = raw.replace(/#.*$/, '').trim();
    if (!body) return;
    const err = (message) => errors.push({ line, text: raw.trim().slice(0, 120), message });
    const warn = (message) => warnings.push({ line, text: raw.trim().slice(0, 120), message });
    const parts = body.split(/\s+/);
    if (parts.length < 3) return err('Expected: <userId> <serverId> <action,action,...>');
    const [userId, srv, ...rest] = parts;
    if (!USER_ID.test(userId)) return err(`"${userId.slice(0, 30)}" is not a Discord user id (15-25 digits)`);
    const serverId = normServerId(srv);
    if (!serverId) return err(`"${srv.slice(0, 30)}" is not a server id (a number, or 0 / * for all servers)`);
    const unknown = [];
    const actions = normActions(rest.join(' ').split(/[,\s]+/), unknown);
    if (unknown.length) return err(`Unknown action${unknown.length > 1 ? 's' : ''}: ${[...new Set(unknown)].slice(0, 5).join(', ')} (allowed: ${ACTIONS.join(', ')}, all, read)`);
    if (!actions.length) return err('No action given');
    if (known && serverId !== '0' && !known.has(serverId)) warn(`Server ${serverId} does not exist (yet)`);
    rules.push({ userId, serverId, actions });
  });
  const merged = merge(rules);
  if (merged.length > MAX_RULES) errors.push({ line: 0, text: '', message: `At most ${MAX_RULES} rules (the rest is ignored)` });
  return { rules: merged.slice(0, MAX_RULES), errors, warnings };
}

/** Rules -> editor text ("all" / "read" shortcuts where the list matches exactly). */
function formatRules(rules) {
  return sanitizeRules(rules).map((r) => {
    const a = r.actions.length === ACTIONS.length ? 'all' : r.actions.length === READ.length && READ.every((x) => r.actions.includes(x)) ? 'read' : r.actions.join(',');
    return `${r.userId} ${r.serverId} ${a}`;
  }).join('\n');
}

const rulesOf = (rules, userId) => (Array.isArray(rules) ? rules : []).filter((r) => r && r.userId === String(userId));
/** Does a rule of this user grant `action` on `serverId`? A rule for server 0 covers every server; rules for one server and for 0 are combined. */
function permits(userRules, action, serverId) {
  const sid = String(serverId == null ? '' : serverId).trim();
  const norm = /^\d+$/.test(sid) ? String(parseInt(sid, 10)) : sid;
  return userRules.some((r) => r.actions.includes(action) && (r.serverId === '0' || r.serverId === norm));
}
/** Does any rule of this user list `action` (for the global commands check / list / stats)? */
const hasAction = (userRules, action) => userRules.some((r) => r.actions.includes(action));
/** Servers this user has any permission on: 'all' (a rule for server 0) or a Set of server ids. */
function visibleServers(userRules) {
  if (userRules.some((r) => r.serverId === '0')) return 'all';
  return new Set(userRules.map((r) => r.serverId));
}

module.exports = { ACTIONS, READ, GLOBAL_ACTIONS, SHORTCUTS, MAX_RULES, USER_ID, normServerId, normActions, sanitizeRules, parseRules, formatRules, rulesOf, permits, hasAction, visibleServers };
