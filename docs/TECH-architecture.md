# NodeGSM - architecture (work in progress)

This document grows with each release. It describes what exists today.

## Process layout
- `src/main/main.js` - Electron main process: creates the window/tray, builds the services, mounts the API table on `ipcMain`.
- `src/main/api.js` - **transport-agnostic API table** `{ name: fn }` (`buildApi(ctx)`). Functions return data or throw; the transport wraps the result as `{ ok, data }` / `{ ok: false, error }`. A future HTTP/WebSocket server mounts the same table.
- `src/main/preload.js` - exposes `window.wgsm.call(name, ...args)` / `on(channel, cb)`.
- `src/renderer/` - plain JS/HTML/CSS, no framework, no inline scripts (CSP).

## Event bus
`ServerManager` owns `mgr.events` (an `EventEmitter`). `mgr.emitEvent(type, id, detail)` emits `{ id, name, game, ts, detail }` and never throws into the caller.

| Event | detail |
|---|---|
| `server:started` | `{ pid }` |
| `server:stopped` | `{ code }` |
| `server:crashed` | `{ code }` - process ended while not stopping |
| `server:restarted` | `{ reason: manual, crash or cron }` |
| `server:updated` | `{ validate, auto?, from?, to? }` |
| `server:backup`, `server:restore` | `{ file }` |
| `server:command` | `{ command, silent }` |
| `server:config` | `{ config, path }` |
| `server:autoclear` | `{ path, pattern, deleted, bytes, locked }` |
| `cluster:created`, `cluster:deleted` | `{ clusterId, clusterName, memberIds?, reason? }` (id = parent) |
| `cluster:update-started` / `-finished` / `-failed` | `{ clusterId, clusterName, parentId, memberIds, validate, onlyChanged, durationMs?, members?, error? }` |
| `cluster:config-synced`, `cluster:cleared` | `{ clusterId, clusterName, written/errors or files/bytes/locked }` |
| `plugins:reloaded` | - |
| `ngsm:log` | the entry written by the event log (payload is the entry itself) |

`mgr` itself emits UI events (`status`, `console`, `removed`, `logLines`) that `main.js` forwards to the renderer.

## Services (`src/main/services/`)
Each service is a class `new S(mgr, plugins, settings, dataDir)` with `start()` / `stop()`; they read `mgr.settings` at use time (the settings object is replaced on save).

| Service | State |
|---|---|
| `eventLog.js` | **done** - subscribes to `server:*` and console lines, writes JSONL, query / export / clear / retention |
| `discord.js` | **done** - webhook alerts: templates, toggles, queue, 429 handling |
| `backup.js` (+ `zip.js`) | **done** - full / neat-pick backups, restore, restore as new, retention, all-backups listing |
| `cluster.js` (+ `clusterMerge.js`) | **done** - clusters, cluster update, config sync, clear folders |
| `autoClear.js` | **done** - per-server rules, seeding from the plugin, scheduler tick, preview / run |
| `consoles.js` (+ `../rcon.js`, `../configEdit.js`) | **done** - injected consoles (log tail, RCON), structured config helpers |
| `discordBot.js` | skeleton |

### Event log (`eventLog.js`)
- `log({ level, event, serverId, serverName, message, detail })` - fills `ts`, validates `level` (`info|warn|error`), caps message (1000 chars) and detail (4000 chars), appends to today's file and emits `ngsm:log`. Never throws.
- `query({ serverId, level, event, text, since, limit })` newest first; `export({ format })`; `clear()`; `prune()`.
- Console patterns: per game compiled from `logging.patterns`; cache cleared on `plugins:reloaded`; cool-down 10 s per `(server, pattern)`.
- Constructor takes `{ now }` so tests can move the clock.

### Discord (`discord.js`)
- `render(template, vars, now)` - pure; template -> webhook JSON (`allowed_mentions.parse = []`, length caps).
- `targets(event, serverId, detail)` - which webhook URLs get an event: global toggle (`settings.discord.events`, default from the catalog), per-server override (`discordEvents`), legacy per-server flags (`legacyFlag`).
- `enqueue(url, body)` -> `{ ok, status, error? }`; a single queue with `delayMs` between sends; 429 waits `retry_after` (max 30 s), 5xx retried, max 3 retries; unreachable hosts return `{ ok:false, status:0 }`.
- Production accepts only `isDiscordWebhook()` URLs. Tests pass `{ allowAnyUrl: true, agent }` to talk to a local HTTP server.
- `info()` feeds the Discord view; `preview()` and `test()` back the IPC calls.

### Backups (`backup.js`, `zip.js`)
- `new BackupService(mgr, plugins, settings, dataDir, zipOpts?)` registers itself as `mgr._bk`; `mgr.bk()` returns it (creating one if `main.js` did not). `ServerManager.backup / backupList / restore / deleteBackup` delegate to it.
- `create(id, { mode, presets[], paths[], exclude[], includeServerSettings })`: `collect()` walks the files (excludes applied, symlinks skipped, paths confined with `safeRel()` + `inside()` + realpath checks), `ZipWriter` streams each file into `<zip>.partial`, rename, manifest `<zip>.json`, `server:backup` event, then `prune()` (retention `backupKeep`). While it runs `rt.busy = 'Backing up'`.
- `restore(id, file, opts)`: manifest checks (game, installed for neat pick), `plan()` validates **every** entry name (zip-slip) before anything is written, entry-by-entry extraction through a temp file with CRC check, optional `applySettings()`, `server:restore`.
- `restoreAsNew(ref, opts)`: validate entry names, `mgr.create`, (neat pick: `mgr.install`), extract, `applySettings` (taken ports move to the next free one), `server:restore` with `asNew`; any failure removes the half-created server.
- `list(folder)` / `listAll()` merge zips with manifests (`legacy: true` when there is none; `deleted: true` for `<id>.deleted-<ms>` folders or ids without a server). Folder and file names are validated (`^\d+(\.deleted-\d+)?$`, `*.zip`).
- `zip.js`: `ZipWriter` (`addFile` streams, `addBuffer`, `addDir`, `finish`; data descriptors; zip64 for entries >= 2 GB, archives > 4 GB or > 65535 entries; `forceZip64` for tests) and `openZip` / `extractEntry` (central directory incl. zip64, stored + deflate, CRC and size checks). Manifest and zip layout: [TECH-data-formats.md](TECH-data-formats.md).
- The event log registers itself as `mgr.eventLog`, so services can call `mgr.eventLog.log(entry)`.

### Clusters (`cluster.js`, `clusterMerge.js`)
- `new Cluster(mgr, plugins, settings, dataDir)` registers itself as `mgr._cluster`; `start()` listens to `mgr 'removed'` (`serverRemoved(id)`: member leaves, parent is replaced, a cluster with fewer than 2 servers is dissolved). `onProgress` (set by `main.js`) is pushed to the renderer as `cluster:progress`.
- Storage: `<data>/clusters.json` (see [TECH-data-formats.md](TECH-data-formats.md)), loaded once, written atomically (`.tmp` + rename); a corrupt file is renamed `clusters.json.corrupt-<ms>`. Validation (`checkMembers`): >= 2 distinct existing servers, one game, plugin installed, parent is a member, no server in two clusters.
- One operation per cluster at a time (`ops`: update / config sync / clear folders); `save` / `delete` are refused meanwhile.
- **Update:** `updatePlan` / `update`. `scanMember` walks the parent's files folder (`realpath`, symlinks skipped, `pathMatcher` over `configs[].path` (+ `.bak`), `cluster.preserve`, `options.preserve`, `configs/wgsm.json`, `__nodegsm`), optional size + mtime comparison (`onlyChanged`, 2 s tolerance). `update` = `mgr.update(parent, validate, { cluster })` unless `skipParentUpdate`, then per member: stop if running, `rt.busy = 'Cluster update'`, `copyFiles` (destination folders created with an lstat check per component, copy to `<name>.ngsm-tmp`, rename, `utimes`), start if it was running. Per-member report `{ id, ok, files, bytes, skippedIdentical, skippedPreserved, failed, failures[], wasRunning, restarted, error? }`; a failing member never stops the loop. Events `cluster:update-started|finished|failed` on `mgr.events` and `cluster:*` entries in the event log.
- **Config sync:** `configResults` computes `mergeConfig({ format, parentText, memberText, protect })` for every member and config id (protect = `configs[].protect` + `cluster.protectedConfigKeys` + `options.protect`); `configPlan` strips the texts and returns diffs; `configApply` writes with a `.bak` and emits `server:config`. `clusterMerge.js` is pure (no fs): line merge (ini / properties / cfg / yaml / text / xml) with occurrence matching of repeated keys and `NGSM:ignore` detection, json deep merge, `unifiedDiff` (prefix / suffix trim + LCS up to 2.5 M cells).
- **Clear folders:** `scanClear` confines every rule with `safeRel` + `inside` + `realInside`, skips links, filters by name glob and mtime; `clear` re-checks with `lstat` before `unlink`, counts locked files (`EBUSY / EPERM / EACCES`).

### Auto-clear (`autoClear.js`)
- `new AutoClear(...)` registers as `mgr._autoClear`; `mgr.startScheduler()` calls `tick(now)` every minute. `seed(id)` copies plugin `files.autoClear` rules once (`autoClearSeeded` keeps the rule keys `<path>|<pattern>`, so deleted or edited rules never come back / get overwritten); a seeded rule starts its interval at seeding.
- `scan(id, rule, now)` confines the rule folder with `safeRel` + `inside` + `realInside`, refuses a link as the folder, skips links while walking, filters by name glob (`logTail.globToRegex`) and mtime. `runRule` re-checks with `lstat` before `unlink`, counts locked files (`EBUSY / EPERM / EACCES`), persists `lastRun` in the rule (+ in memory), logs `autoclear:run`, emits `server:autoclear`.
- `tick` skips disabled rules, rules not yet due (`lastRun + intervalMin`), `onlyWhenStopped` rules of running servers and servers with `rt.busy`. Rules are re-sanitised (non-strict: invalid hand-edited rules are dropped) on every read; user input goes through the strict sanitiser (`settings.sanitizeAutoClear`).

### Consoles and RCON (`consoles.js`, `rcon.js`)
- `list(id)` returns `main` (the game console) plus the plugin's `consoles[]`; sources are never returned. `command(id, consoleId, text)` routes: `main` -> `mgr.sendCommand`, `rcon` -> `RconClient`, `log` -> refused. RCON clients are cached per `server:console`, re-created when the resolved port / password changes, closed after 5 idle minutes and when the server is removed; a failed command drops the client so the next command reconnects.
- `resolveRcon(id, source)` parses `rcon:<port>:<password>` (`parseRconSource`) and resolves `{placeholders}` from server settings (whitelist `port, queryPort, maxPlayers, map, ip`) or config files through `configEdit.get`. Host is always `127.0.0.1`.
- `rcon.js`: packets `int32le size | id | type | body | 0 0`; auth (type 3, success = auth response with the same id, `-1` = wrong password), commands (type 2) followed by an empty type-0 packet whose echo marks the end of a (multi-packet) response; if no marker returns, an idle timeout ends it. Limits: 4096-byte command, 4160-byte packet, 1 MB response text, connect / command timeouts. Events of a replaced socket are ignored.
- Output reaches the renderer as the push event `consoleOut { id, consoleId, lines[], reset?, file? }` (log consoles re-emit the `logLines` of `LogTail` with their console id).

### Structured config editing (`configEdit.js`)
Pure functions: `parse(format, text) -> { ok, reason?, entries[{ id, path, key, section, value, type? }] }`, `edit(format, text, ops) -> { text, entries, ok }` (ops `set`/`remove` by entry `id`, `add` by `path` (+ `section` for ini); apply one at a time because line ids shift), `get(format, text, name)`. Line formats keep every other line byte-for-byte; json is re-serialised.

## Data files (`<data>` = `%APPDATA%\NodeGSM`, or the legacy `%APPDATA%\node-wgsm2026\WGSM`)
| Path | Content |
|---|---|
| `settings.json` | app settings (sanitised on read and write by `settings.js`): theme, `ui`, `headerStats`, `discord{ webhookUrl, events, templates, ...}`, `logging{ retentionDays }` |
| `servers/<id>/configs/wgsm.json` | per-server config incl. `discordWebhook`, `discordAlert`, `discordEvents`, old alert flags, `backupKeep`, `autoClear` (rules), `autoClearSeeded` |
| `logs/ngsm-YYYY-MM-DD.log` | NGSM event log, JSONL |
| `logs/crash.log`, `logs/crash-history.json` | app crash handling |
| `clusters.json` | clusters (members, parent, per-cluster rules) - see [TECH-data-formats.md](TECH-data-formats.md) |
| `backups/<id>/backup-*.zip` + `backup-*.json` | backups and their manifests (`<id>.deleted-<ms>` for deleted servers) - see [TECH-data-formats.md](TECH-data-formats.md) |

### Log line
```json
{"ts":"2026-11-24T10:15:02.123Z","level":"error","event":"server:crashed","serverId":"2","serverName":"My server","message":"Server stopped suddenly (crash), exit code 1","detail":{"code":1}}
```

## IPC added in this release
`eventLogQuery(filters)`, `eventLogExport(filters)` (text), `eventLogClear()`, `discordInfo()`, `discordTest(kind, template?)`, `discordPreview(template, sampleVars, event)`.

Backups: `backups()` (all) / `backups(folder)`, `backup(id, opts)`, `backupInfo(id)`, `backupPreview(id, opts)`, `restore(id, file, opts)`, `restoreNew(folder, file, opts)`, `deleteBackup(id, file)`, `backupDownload(folder, file)`, `backupOpenFolder(folder)`.

Configs / auto-clear / consoles: `configParse(format, text)`, `configEdit(format, text, ops)`, `autoClearList(id)`, `autoClearSave(id, rules)`, `autoClearRun(id, ruleIndex?, dryRun?)`, `consolesList(id)`, `consoleCommand(id, consoleId, text)`, `consoleStart(id, consoleId)`, `consoleStop(id, consoleId)`; push channel `consoleOut`. `update(id, validate)` and `bulk("validate", ids)` run Validate.

Clusters: `clusters()`, `clusterCreate({ name, memberIds, parentId, options })`, `clusterSave(id, patch)`, `clusterDelete(id)`, `clusterUpdatePlan(id, opts)`, `clusterUpdate(id, opts)` (`{ validate, onlyChanged, skipParentUpdate, memberIds }`), `clusterConfigPlan(id, { configIds, memberIds })`, `clusterConfigApply(id, ...)`, `clusterClearPlan(id, { memberIds })`, `clusterClear(id, ...)`. Push channel: `cluster:progress` `{ clusterId, phase: parent|member|done|failed, percent, memberId, memberName, memberIndex, memberCount, file?, message }`.
