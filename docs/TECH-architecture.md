# NodeGSM - architecture (work in progress)

This document grows with each release. It describes what exists today.

## Process layout
- `src/main/core.js` - **transport-agnostic bootstrap**: `createCore({ dataDir, mode })` builds the `ServerManager`, the services (event log, Discord, bot, backups, clusters, auto-clear, consoles), the `MetricsCollector` and a push-event hub (`core.hub.on((channel, payload) => ...)`), and offers `core.buildApi(extraCtx)`, `core.start()` and `core.stop()`. It never loads `electron`.
- `src/main/main.js` - Electron main process: creates the window/tray, calls `createCore({ mode: 'desktop' })`, subscribes the window to the hub and mounts the API table on `ipcMain` (behaviour unchanged).
- `src/server/headless.js` + `auth.js` - the web server (see [Web mode](#web-mode-headless-server)). Uses `core.js` with `headlessHost()` stand-ins for the Electron-only ctx members.
- `src/main/platform.js` - the OS layer (see [Platform layer](#platform-layer)).
- `src/main/dataLocation.js` - the `data-location.txt` pointer and the safe copy used by Settings -> Data location (plan, copy with progress, switch; never deletes).
- `src/main/api.js` - **transport-agnostic API table** `{ name: fn }` (`buildApi(ctx)`). Functions return data or throw; the transport wraps the result as `{ ok, data }` / `{ ok: false, error }`. A future HTTP/WebSocket server mounts the same table.
- `src/main/preload.js` - exposes `window.wgsm.call(name, ...args)` / `on(channel, cb)`.
- `src/renderer/` - plain JS/HTML/CSS, no framework, no inline scripts (CSP).

## Web mode (headless server)
`npm run serve` runs `src/server/headless.js`: Node `http` + `ws`, no Electron. One process = one `createCore({ mode: 'web' })`.

- **Mounting:** `POST /api/<channel>` calls `api[channel](...args)` from the same table the IPC uses (own properties only; the name must match `^[A-Za-z][A-Za-z0-9:]*$`). The hub's events are broadcast as `{ ch, payload }` over `/ws`. Protocol: [TECH-api.md](TECH-api.md#http-and-websocket-transport-web-mode).
- **Electron stand-ins** (`headlessHost()` in `core.js`): `shell` / `dialog` throw "not available in web mode" (folder picker, open in Explorer, plugin install dialogs), `app` / `nativeTheme` are no-ops, `beforeRelaunch` throws a restart hint. The renderer learns what to hide from the `platformInfo` channel and `window.wgsm.mode`.
- **Server scope** (`src/server/scope.js`): operator / viewer accounts may carry `servers: [ids]` (null = all). `WebAccess.authorize(name, actor, args)` checks the role and then `scope.check` (first-argument server ids, backup folders, bulk ids, event-log filter; cluster actions refused); `scopeResult` filters `list`, `backups`, `eventLogQuery`, `clusters`, `metricsState` after the call; `scopePush` filters the WebSocket events per connection. Owners, admins, the desktop window and the shared token are never limited.
- **Steam account** (`steamcmd.js`): `login()` runs `+login user pass [code] +quit` once (stdin closed, 90 s limit, output parsed by `parseLogin`) so SteamCMD caches its token; installs of steps with `account: true` run `+login user` without a password. Only `settings.steam.username` is saved.
- **Background start** (`src/main/service.js`): writes `<data>/service/nodegsm-web.ps1` (sets `ELECTRON_RUN_AS_NODE`, runs `headless.js` with the web settings, loops with a 30 s pause) and registers it with `schtasks` (ONLOGON as the user, or ONSTART as SYSTEM).
- **Auth model** (`auth.js`, `users.js`, `totp.js`, `webAccess.js`): **accounts** in `<data>/web-users.json` (mode 0600): username, role (owner / admin / viewer), scrypt password hash (N=16384, r=8, p=1; an unknown user still costs one scrypt run, so timing does not reveal names), optional TOTP secret + SHA-256 hashed one-time recovery codes + last used step (no replay). The shared **token** (env `NODEGSM_TOKEN`, else `<data>/web-token`, 0600) only authorises first-time setup (`POST /setup` creates the first owner) and, while no account exists, the legacy token sign-in; afterwards it works only as a Bearer token from a direct loopback client (no proxy headers). `POST /login` takes `{username, password}` and answers either a session cookie or `{need2fa, challenge}` (5 minute, 5 tries, bound to the user); the second call sends `{challenge, code}`. A session is a random 24-byte id kept **in memory** (account, role, created / last used, address, browser, `limited`) with absolute and idle expiry; the cookie is `id.HMAC-SHA256(secret, id)` with a per-process secret, `HttpOnly; SameSite=Strict; Path=/`, `Secure` when `--https` or `X-Forwarded-Proto: https`. Failed attempts count per client address (5 -> 15 minute lock) and per account (5 -> 15 minute lock). `WebAccess.authorize(channel, actor)` applies the roles to every channel; `web*` channels are served by `WebAccess.api(actor)` (the actor is the session, or `{ local: true }` for the desktop window = owner). `require2fa` makes sessions of accounts without 2FA `limited` (only `LIMITED_OK` channels, `/account.html`). The same `WebAccess` instance serves the HTTP server and the desktop IPC when the app embeds the web server (`main.js` `applyWeb()` -> `startServer({ core, webAccess })`; `close()` then leaves the core running). `saveSettings` from a browser drops the `web` key (bind address / port / HTTPS are desktop-only). Security events go to the NGSM event log through `core.eventLog`.
- **CSRF / cross-site:** no CORS headers. Cookie and no-auth requests must carry an `Origin` equal to `Host` (403 otherwise), also for the WebSocket upgrade; `Content-Type: application/json` is required; bearer requests are exempt (not ambient credentials).
- **Static files:** only `src/renderer/*` and `assets/*`, known extensions, no dot segments / `..` / backslashes / NUL, `realpath` must stay inside the root. Everything except the login page, `styles.css`, `theme-boot.js` and the logo needs a session. The CSP header is the app's policy plus `connect-src 'self' ws://host wss://host`, `frame-ancestors 'none'`.
- **Bind rule:** a non-loopback `--host` is refused when authentication is off (`--no-auth` is loopback only).
- **Limits:** request body 4 MiB (configurable), 50 WebSocket clients, 8 MiB WebSocket send buffer per client (frames are dropped above it), 30 s heartbeat.
- **Shutdown:** SIGINT / SIGTERM -> close sockets and HTTP server -> `core.stop()` (collector, services, `mgr.shutdown()` = the same path as quitting the desktop app). A second signal forces exit.
- **Logging:** tokens and cookies are never logged; there is no access log. Crashes go to `<data>/logs/crash.log`.

## Platform layer
`src/main/platform.js` isolates everything OS specific; the other modules call it instead of `taskkill` / PowerShell / `.exe` paths. Windows behaviour is unchanged; Linux is unit-tested with injected fakes only.

| Concern | Windows | Linux |
|---|---|---|
| Data folder | `NODEGSM_DATA`, else the folder in `data-location.txt` (Settings / installer), else the pre-NodeGSM `%APPDATA%\node-wgsm2026\WGSM` if it exists, else `%APPDATA%\NodeGSM` | `$XDG_DATA_HOME/NodeGSM` or `~/.local/share/NodeGSM` |
| Spawn | `windowsHide` | `detached: true` (own process group) |
| Stop / kill tree | `taskkill /T` then `/T /F` | `kill(-pgid, SIGTERM)` then `SIGKILL` (falls back to the pid) |
| CPU / RAM / threads | one PowerShell CIM call | `/proc/<pid>/stat` (+ `status` VmRSS) scan, clock ticks from `getconf CLK_TCK`, summed through ppid |
| CPU affinity | PowerShell `ProcessorAffinity` | `taskset -a -p <hexmask> <pid>` |
| Priority | `os.setPriority` | `os.setPriority` |
| SteamCMD | `steamcmd.zip` -> `steamcmd.exe` | `steamcmd_linux.tar.gz` (tar) -> `steamcmd.sh`; `+@sSteamCmdForcePlatformType` first when a step asks for another platform |
| Extract | AdmZip / Windows `tar` | AdmZip / GNU `tar` (`-xzf` for gzip) |
| Executable | - | `chmod 755` before start |
| Firewall | `netsh advfirewall` | not managed: returns `{ ok: false, unsupported: true, message }` with a `ufw` hint |

Plugins: `toGame(manifest, dir, source, platform)` resolves `exe` / `command` / `args` / `env` / install steps for one platform (`run.linux`, `install.linux`) and sets `platforms` / `supported`; `ServerManager.create` / `importServer` refuse unsupported games.

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
| `consoles.js` (+ `../rcon.js`, `../webrcon.js`, `../configEdit.js`) | **done** - injected consoles (log tail, RCON), structured config helpers |
| `discordBot.js` + `discordCommands.js` + `discordPermissions.js` | **done** (not tested against real Discord) - slash-command bot: discord.js client wiring + pure command handlers + the per-user per-server permission rules (parse / sanitise / match) |

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

### Discord bot (`discordBot.js`, `discordCommands.js`)
- `discordCommands.js` has no discord.js import. `COMMANDS` / `registrationJson()` are plain JSON in Discord's API shape (option types 3 string, 5 boolean; names lowercase <= 32, descriptions <= 100). `createHandlers({ mgr, getSettings, getCollector, version, now, bootTime })` returns `{ handle(interaction), autocomplete(interaction) }`; an interaction only needs `commandName`, `user{id,tag}`, `member.roles`, `options.getString / getBoolean / getFocused`, `reply / deferReply / editReply / followUp / deleteReply`, `respond`. Tests use fakes.
- Order inside `handle`: rate limit (per user id, 5 / 10 s) -> `authorize()` (who the bot knows: admin role, deprecated `allowedUserIds`, or at least one permission rule; default deny) -> `authorizeAction()` for the command -> the action. `authorizeAction`: admin = everything; else a rule of the user (`settings.discord.permissions`, from `discordPermissions.js`) decides: `check` / `list` / `stats` need any rule listing that action, `start` / `stop` / `restart` / `update` / `send` / `backup` need a rule for that server id **or for 0 (all)** (rules for one server and for 0 are a union); else a legacy `allowedUserIds` user may do everything, narrowed by the per-server `discordAllowedUserIds` (the narrowing never applies to rule users: rules are authoritative); else deny. `/list` and `/stats` show only the servers a rules-only user has any permission for (`ctx.canSee`); `autocomplete()` offers only servers `authorizeAction` allows for that command. `/send` additionally needs `settings.discord.allowRawCommands` (checked inside the action, after the permission). Denials are ephemeral ("You do not have permission to use /restart on server 4.", no rule list) and logged with `detail.required` (the action) and `serverId`; successful attempts log `detail.via` (`admin` / `rule` / `legacy`). The rules are read live through `getSettings`; the bot's reconnect signature does not include them. Pre-validation refusals (unknown id, busy, wrong state, `/send` off) are ephemeral replies before any defer; after a defer an error deletes the placeholder and follows up ephemerally. Each attempt calls `mgr.eventLog.log({ event: 'discord:command', detail: { userId, userTag, command, serverId, result } })` and emits `discord:command` on `mgr.events`.
- `discordBot.js` owns the client: lazy `require('discord.js')` (injectable `loadDiscord` for tests), Guilds intent, `apply()` compares a signature of `botEnabled | token | applicationId | guildId` and only then reconnects; registration uses `buildCommands()` (SlashCommandBuilder from the same definitions) with `application.commands.set(payload, guildId?)`; `status()` / `onStatus` feed IPC `discordBotStatus` and the pushed `discordBot` event; `stop()` destroys the client. `main.js` sets `bot.collector` (for `/stats`) and `bot.onStatus`.
- The token lives in `settings.discord.botToken` (plain text). `api.js` masks it: `settings` / `saveSettings` return `discord.botTokenSet` only; a blank token in a patch keeps the saved one, `clearBotToken: true` clears it.

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

### Consoles and RCON (`consoles.js`, `rcon.js`, `webrcon.js`)
- `webrcon.js` is the WebSocket client (Rust): same interface as `RconClient` (`connect`, `send`, `close`, `connected`); `clientFor()` picks the class from the source scheme (`rcon:` / `webrcon:`). `{param:name}` placeholders read the start parameters (`paramValue()`).
- `Consoles.run(id, text, consoleId?)` is the automation path (scheduled commands): first rcon console, else the game console. `ServerManager.scheduledCommandTick()` runs from `cronTick`; `ServerManager.stop()` sends the plugin's `run.stopRcon` first (silent `poll`, 6 s send cap, 20 s exit wait).
- `list(id)` returns `main` (the game console) plus the plugin's `consoles[]`; sources are never returned. `command(id, consoleId, text)` routes: `main` -> `mgr.sendCommand`, `rcon` -> `RconClient`, `log` -> refused. RCON clients are cached per `server:console`, re-created when the resolved port / password changes, closed after 5 idle minutes and when the server is removed; a failed command drops the client so the next command reconnects.
- `resolveRcon(id, source)` parses `rcon:<port>:<password>` (`parseRconSource`) and resolves `{placeholders}` from server settings (whitelist `port, queryPort, maxPlayers, map, ip`) or config files through `configEdit.get`. Host is always `127.0.0.1`.
- `rcon.js`: packets `int32le size | id | type | body | 0 0`; auth (type 3, success = auth response with the same id, `-1` = wrong password), commands (type 2) followed by an empty type-0 packet whose echo marks the end of a (multi-packet) response; if no marker returns, an idle timeout ends it. Limits: 4096-byte command, 4160-byte packet, 1 MB response text, connect / command timeouts. Events of a replaced socket are ignored.
- Output reaches the renderer as the push event `consoleOut { id, consoleId, lines[], reset?, file? }` (log consoles re-emit the `logLines` of `LogTail` with their console id).

### Metrics, tick and latency (`metrics.js`, `renderer/tick.js`, `query.js`)
- `MetricsCollector` samples every 5 s (`tick()` - not the game tick). Plugin `metrics[]` values come from `feed()` (console / log lines) or `pollRcon()` (`source: "rcon:<command>"`, timer per server+metric, one poll in flight at a time, errors kept in `pollErrors` without secrets). `record()` matches the metric regex (`patternFlags`, default `i`); tick metrics are colour-stripped and parsed with `parseTickNumber`, other metrics keep the old `parseFloat` behaviour.
- `Consoles.poll(id, command, { consoleId, source })` is the silent RCON path (no `consoleOut`, no `server:command` event); inline sources use the pool key `<id>:~poll`. `RconClient.send()` queues commands per connection.
- A row has `metrics` (`m:<id>` -> `{ value, unit, kind?, cls?, higherIsBetter? }`, plus `latency`), `tick` (first fresh tick metric) and history points `{ k, l }`. `defs` lists metric columns (`kind` only for tick metrics; defs are keyed by metric id across games).
- `tick.js` is UMD (renderer `<script>` -> `window.NGSMTick`, main `require`): `stripColours`, `parseTickNumber`, `classify` (thresholds / `tickTarget`), `aggregateTick` (header stat, mode `worst` | `avg`).
- Latency: `query.js` returns `ping` (ms of the last answered request, UDP / HTTP); `pollAll()` stores `rt.latency = { ms, t }`; `latencyFor()` exposes it only for games without a tick metric and while younger than 60 s.

### Structured config editing (`configEdit.js`)
Pure functions: `parse(format, text) -> { ok, reason?, entries[{ id, path, key, section, value, type? }] }`, `edit(format, text, ops) -> { text, entries, ok }` (ops `set`/`remove` by entry `id`, `add` by `path` (+ `section` for ini); apply one at a time because line ids shift), `get(format, text, name)`. Line formats keep every other line byte-for-byte; json is re-serialised.

## Data files (`<data>` = `%APPDATA%\NodeGSM`, or the legacy `%APPDATA%\node-wgsm2026\WGSM`)
| Path | Content |
|---|---|
| `settings.json` | app settings (sanitised on read and write by `settings.js`): theme, `ui`, `headerStats`, `discord{ webhookUrl, botEnabled, botToken (plain text!), applicationId, guildId, allowedUserIds (deprecated), adminRoleIds, permissions[{ userId, serverId, actions[] }], allowRawCommands, events, templates }`, `logging{ retentionDays }` |
| `servers/<id>/configs/wgsm.json` | per-server config incl. `backupSchedule` (`{ enabled, cron, options }`, scheduled backups), `discordWebhook`, `discordAlert`, `discordEvents`, `discordAllowedUserIds` (bot: restrict who may control this server), old alert flags, `backupKeep`, `autoClear` (rules), `autoClearSeeded` |
| `logs/ngsm-YYYY-MM-DD.log` | NGSM event log, JSONL |
| `logs/crash.log`, `logs/crash-history.json` | app crash handling |
| `clusters.json` | clusters (members, parent, per-cluster rules) - see [TECH-data-formats.md](TECH-data-formats.md) |
| `backups/<id>/backup-*.zip` + `backup-*.json` | backups and their manifests (`<id>.deleted-<ms>` for deleted servers) - see [TECH-data-formats.md](TECH-data-formats.md) |

### Log line
```json
{"ts":"2026-11-24T10:15:02.123Z","level":"error","event":"server:crashed","serverId":"2","serverName":"My server","message":"Server stopped suddenly (crash), exit code 1","detail":{"code":1}}
```

## IPC added in this release
The complete channel list (all 84, with arguments, results and push events) is in [TECH-api.md](TECH-api.md); the summary below only lists what was added with the services.

`eventLogQuery(filters)`, `eventLogExport(filters)` (text), `eventLogClear()`, `discordInfo()`, `discordTest(kind, template?)`, `discordPreview(template, sampleVars, event)`, `discordPermParse(text)`, `discordPermFormat(rules)`.

Backups: `backups()` (all) / `backups(folder)`, `backup(id, opts)`, `backupInfo(id)`, `backupPreview(id, opts)`, `restore(id, file, opts)`, `restoreNew(folder, file, opts)`, `deleteBackup(id, file)`, `backupDownload(folder, file)`, `backupOpenFolder(folder)`.

Configs / auto-clear / consoles: `configParse(format, text)`, `configEdit(format, text, ops)`, `autoClearList(id)`, `autoClearSave(id, rules)`, `autoClearRun(id, ruleIndex?, dryRun?)`, `consolesList(id)`, `consoleCommand(id, consoleId, text)`, `consoleStart(id, consoleId)`, `consoleStop(id, consoleId)`; push channel `consoleOut`. `update(id, validate)` and `bulk("validate", ids)` run Validate.

Clusters: `clusters()`, `clusterCreate({ name, memberIds, parentId, options })`, `clusterSave(id, patch)`, `clusterDelete(id)`, `clusterUpdatePlan(id, opts)`, `clusterUpdate(id, opts)` (`{ validate, onlyChanged, skipParentUpdate, memberIds }`), `clusterConfigPlan(id, { configIds, memberIds })`, `clusterConfigApply(id, ...)`, `clusterClearPlan(id, { memberIds })`, `clusterClear(id, ...)`. Push channel: `cluster:progress` `{ clusterId, phase: parent|member|done|failed, percent, memberId, memberName, memberIndex, memberCount, file?, message }`.
