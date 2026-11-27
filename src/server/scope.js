'use strict';
// Per-server permissions for web accounts. A viewer or operator account may be limited to some servers (`servers: ['1', '3']`;
// no list = all servers). Owners and admins always see everything. Three small pure helpers used by the headless server:
//   check(name, args, allowed)        throws a 403 error when an API call names a server that is not allowed
//   filterResult(name, data, allowed) removes other servers from what a channel returns
//   filterPush(ch, payload, allowed)  returns the push-event payload, a filtered copy, or null (do not send)
// `allowed` is a Set of server ids, or null for "all".

const forbidden = () => Object.assign(new Error('You do not have access to this server.'), { status: 403 });

/** Channels whose first argument is a server id. */
const ID_FIRST = new Set(['get', 'start', 'stop', 'restart', 'kill', 'remove', 'install', 'save', 'console', 'command', 'checkUpdate', 'update', 'backup', 'backupInfo', 'backupPreview', 'restore', 'deleteBackup', 'firewall', 'listDir', 'readFile', 'writeFile', 'openFolder', 'configList', 'configRead', 'configWrite', 'configCreate', 'autoClearList', 'autoClearSave', 'autoClearRun', 'consolesList', 'consoleCommand', 'consoleStart', 'consoleStop', 'logsList', 'logStart', 'logStop']);
/** Channels whose first argument is a backup folder: "<server id>" or "<server id>.deleted-<ms>". */
const FOLDER_FIRST = new Set(['backupDownload', 'backupOpenFolder', 'restoreNew']);
const folderId = (f) => String(f == null ? '' : f).split('.')[0];

function check(name, args, allowed) {
  if (!allowed) return;
  const a0 = args && args[0];
  if (ID_FIRST.has(name)) { if (!allowed.has(String(a0))) throw forbidden(); return; }
  if (FOLDER_FIRST.has(name)) { if (!allowed.has(folderId(a0))) throw forbidden(); return; }
  if (name === 'backups') { if (a0 !== undefined && a0 !== null && a0 !== '' && !allowed.has(folderId(a0))) throw forbidden(); return; }
  if (name === 'bulk') { const ids = Array.isArray(args[1]) ? args[1] : []; if (ids.some((i) => !allowed.has(String(i)))) throw forbidden(); return; }
  if (name === 'eventLogQuery' || name === 'eventLogExport') { const sid = a0 && a0.serverId; if (sid !== undefined && sid !== null && sid !== '' && !allowed.has(String(sid))) throw forbidden(); return; }
  if (name.startsWith('cluster') && name !== 'clusters') throw forbidden();   // clusters change several servers at once
}

function filterResult(name, data, allowed) {
  if (!allowed || data == null) return data;
  switch (name) {
    case 'list': return Array.isArray(data) ? data.filter((v) => allowed.has(String(v.id))) : data;
    case 'backups': return Array.isArray(data) ? data.filter((b) => allowed.has(folderId(b.folder))) : data;
    case 'eventLogQuery': return Array.isArray(data) ? data.filter((e) => e && e.serverId !== undefined && allowed.has(String(e.serverId))) : data;
    case 'clusters': return Array.isArray(data) ? data.filter((c) => (c.memberIds || []).every((i) => allowed.has(String(i)))) : data;
    case 'metricsState': return data.snapshot ? { snapshot: filterSnapshot(data.snapshot, allowed), history: (data.history || []).map((p) => filterPoint(p, allowed)) } : data;
    default: return data;
  }
}
function filterSnapshot(snap, allowed) {
  const servers = (snap.servers || []).filter((r) => allowed.has(String(r.id)));
  return { ...snap, servers, game: snap.game ? { ...snap.game, players: servers.reduce((n, r) => n + (r.players || 0), 0), online: servers.filter((r) => r.pid || r.status === 'Started').length } : snap.game };
}
function filterPoint(p, allowed) {
  if (!p || !p.s) return p;
  const s = {}; let players = 0;
  for (const [id, v] of Object.entries(p.s)) if (allowed.has(String(id))) { s[id] = v; players += (v && v.p) || 0; }
  return { ...p, s, players };
}

function filterPush(ch, payload, allowed) {
  if (!allowed) return payload;
  switch (ch) {
    case 'status': return payload && allowed.has(String(payload.id)) ? payload : null;
    case 'console': case 'logLines': case 'consoleOut': return payload && allowed.has(String(payload.id)) ? payload : null;
    case 'removed': return allowed.has(String(payload)) ? payload : null;
    case 'metrics': return payload && payload.snapshot ? { snapshot: filterSnapshot(payload.snapshot, allowed), point: filterPoint(payload.point, allowed) } : null;
    case 'cluster:progress': case 'discordBot': case 'dataLocation:progress': return null;
    default: return payload;
  }
}

/** Roles that can have a server list (owners and admins always see everything). */
const SCOPED_ROLES = ['viewer', 'operator'];

module.exports = { check, filterResult, filterPush, ID_FIRST, SCOPED_ROLES };
