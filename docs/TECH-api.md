# NodeGSM - API reference (IPC channels and push events)

Every function of the app backend is one entry of the table returned by `buildApi(ctx)` in [`src/main/api.js`](../src/main/api.js). `main.js` mounts the table on Electron's `ipcMain` (one channel per name); the headless server (`src/server/headless.js`, web mode) mounts the same table on `POST /api/<channel>` (see [HTTP and WebSocket transport](#http-and-websocket-transport-web-mode)). The channel names below are the exact keys of that table (82 channels). `test/smoke.js` checks that every channel of the table is listed in this file.

## Calling convention
- **Renderer:** `await window.wgsm.call(name, ...args)` (see `src/main/preload.js`). It resolves with the `data` of the reply or throws `Error(message)`.
- **Wire format:** the main process answers every invoke with `{ ok: true, data }` or `{ ok: false, error: "<message>" }`. API functions return plain data or throw; they never return `{ ok }` themselves.
- **IDs:** a server id is the numeric id as a string (`"3"`); ids are reused after a server is deleted. A *folder* argument of the backup channels is the server id or `<id>.deleted-<ms>` for deleted servers.
- **Paths** arguments are relative to the server files folder and are confined by the backend (`..`, absolute paths and links are refused).
- **Secrets:** the Discord bot token, RCON passwords and plugin `rcon:` sources never leave the main process. `settings` / `saveSettings` return `discord.botTokenSet` instead of the token.
- **Push events** go the other way: `const off = window.wgsm.on(channel, cb)` returns an unsubscribe function. They are listed at the end.

`server view` below means the object returned by `mgr.view(id)`: the saved config (`id, name, game, port, queryPort, map, maxPlayers, ip, param, ...`) plus `gameName, icon, status, pid, startedAt, players, maxPlayersLive, liveMap, restarts, pending, progress, ip_display`.

## Servers
| Channel | Args | Returns | Notes |
|---|---|---|---|
| `games` | - | public game list | Id, name, icon, description, tags, ports, default map / players, `appId`, `query`, `gslt`, `source`, `author`, `version`, `overrides`, `platforms[]` and `supported` (false = the plugin does not declare the current OS; `create` / `import` refuse it) of every plugin (no secrets, no code) |
| `list` | - | server view[] | All servers with live status |
| `get` | `id` | config object | The saved `wgsm.json` of the server (not the live view) |
| `create` | `game, name` | server view | Creates the server record (ports picked free); does not install |
| `import` | `game, name, dir` | server view | Points a server at an existing folder (no copy; delete never removes imported files) |
| `install` | `id` | - | Runs the plugin install steps; progress arrives as `status` events (`pending`, `progress`) |
| `save` | `id, patch` | server view | Validates and merges the patch into `wgsm.json` (name, ports, param, flags, per-server Discord webhook / overrides, `backupKeep`, ...). Throws on an invalid value |
| `start` / `stop` / `restart` | `id` | - | Stop = console command, then `taskkill` (Windows) or SIGTERM to the process group (Linux), then force-kill after 15 s |
| `kill` | `id` | - | Force-kills the whole process tree (no save) |
| `remove` | `id, files` | - | Deletes the server; `files` (default true) also deletes the files folder (imported folders are never deleted). Emits `removed` |
| `console` | `id` | string[] | Buffered game-console lines (the live ones arrive as `console` events) |
| `command` | `id, text` | - | Writes a line to the game console (logged as `server:command`) |
| `checkUpdate` | `id` | `{ local, remote, available }` | Steam build id or the plugin's `latest` / `local` hooks; `available: false` when the game has neither |
| `update` | `id, validate` | - | Updates (or validates when `validate` is true) through the game's installer; busy text `Updating` / `Validating` |
| `bulk` | `action, ids[]` | per-server results | `action`: `start`, `stop`, `restart`, `kill`, `update`, `validate`, `backup`. Not-applicable servers are reported as `skipped`; Stop / Restart / Kill run in parallel, the rest one after another |
| `firewall` | `id, on` | - | Adds / removes the `NodeGSM #...` netsh rules (needs Administrator) |
| `openFolder` | `id` | - | Opens the server files folder in Explorer |
| `listDir` | `id, rel` | `[{ name, dir }]` | File browser (one folder level) |
| `readFile` | `id, rel` | `{ text, ... }` | Text file up to 2 MB |
| `writeFile` | `id, rel, text` | - | Writes a text file in the server folder |
| `metrics` | - | `{ cpuCount, load, mem, uptime }` | Basic host numbers (the header bar uses `metricsState` instead) |
| `metricsState` | - | `{ snapshot, history }` | Last collector snapshot (system, game totals, `defs`, per-server `servers[]` rows incl. `tick`, `metrics`) and the last 30 minutes of history points |

## Config files, logs and consoles
| Channel | Args | Returns | Notes |
|---|---|---|---|
| `configList` | `id` | `[{ id, name, path, format, description, exists, size, hasTemplate }]` | The plugin's `configs[]` for this server |
| `configRead` | `id, configId` | `{ id, name, format, path, exists, text }` | BOM removed; refuses files over 2 MB |
| `configWrite` | `id, configId, text` | - | Validates JSON, keeps `.bak`, emits `server:config` |
| `configCreate` | `id, configId` | - | Creates a missing file from the plugin template (or empty) |
| `configParse` | `format, text` | `{ ok, reason?, entries[] }` | Pure structured parse for the editor (`ini properties cfg json yaml`); `ok: false` = raw only, with the reason |
| `configEdit` | `format, text, ops[]` | `{ ok, text, entries }` | Pure: applies `set` / `remove` (by entry id) and `add` (by path) operations, keeping comments, CRLF, BOM |
| `logsList` | `id` | `[{ id, name, path, exists, ... }]` | The plugin's `logs[]` |
| `logStart` / `logStop` | `id, logId` | - | Starts / stops the live tail of a log; lines arrive as `logLines` |
| `consolesList` | `id` | `[{ id, name, type, readOnly }]` | `main` (game console) plus `consoles[]`; sources / passwords are never returned |
| `consoleCommand` | `id, consoleId, text` | `{ output }` | `main` -> game stdin, `rcon` -> RCON (loopback only); `log` consoles refuse commands |
| `consoleStart` / `consoleStop` | `id, consoleId` | - | Start / stop a `log` console tail; output arrives as `consoleOut` |
| `autoClearList` | `id` | rule[] | `{ path, pattern, olderThanDays, intervalMin, enabled, recursive, onlyWhenStopped, lastRun, index, fromPlugin, nextRun }` |
| `autoClearSave` | `id, rules[]` | rule[] | Replaces the rule list with strict validation (relative folders, 0..3650 days, 1..525600 min, at most 50 rules) |
| `autoClearRun` | `id, ruleIndex?, dryRun?` | `{ id, dryRun, results[], matched, deleted, freed, ... }` | No `ruleIndex` = all enabled rules; `dryRun` lists without deleting |

## Backups
| Channel | Args | Returns | Notes |
|---|---|---|---|
| `backups` | `folder?` | backup[] | No argument = every backup of every server (with `serverName`, `game`, `deleted`, `legacy`, manifest); a folder = that server's |
| `backup` | `id, opts` | backup entry | `opts`: `{ mode: "full" or "neatpick", presets[], paths[], exclude[], includeServerSettings }`; streamed zip + manifest, retention applied |
| `backupInfo` | `id` | `{ presets, excludes, keep, ... }` | What the Backups tab offers: plugin presets, plugin excludes, retention |
| `backupPreview` | `id, opts` | `{ fileCount, bytes, ... }` | Size estimate without writing |
| `restore` | `id, file, opts` | - | `opts.restoreSettings` re-applies the saved `wgsm.json`; the server is stopped first; every entry name is validated (zip-slip) |
| `restoreNew` | `folder, file, opts` | `{ id, ..., server }` | Restore as new server; `opts`: `{ game?, name?, restoreSettings }` (`game` only for old backups without a manifest) |
| `deleteBackup` | `id, file` | - | Deletes zip and manifest |
| `backupDownload` | `folder, file` | - | Reveals the zip in Explorer |
| `backupOpenFolder` | `folder` | - | Opens the backup folder |

## Clusters
`opts` of the cluster calls are all optional objects. Only one operation per cluster runs at a time.

| Channel | Args | Returns | Notes |
|---|---|---|---|
| `clusters` | - | cluster[] | `{ id, name, game, parentId, memberIds[], createdAt, options }` plus resolved member names / status |
| `clusterCreate` | `{ name, memberIds[], parentId, options }` | cluster | At least 2 servers, all the same game, parent must be a member, one cluster per server |
| `clusterSave` | `id, patch` | cluster | Rename, change parent, add / remove members, options (`protect`, `preserve`, `clearFolders`, `onlyChanged`, ...) |
| `clusterDelete` | `id` | - | Removes the cluster only, never the servers |
| `clusterUpdatePlan` | `id, { onlyChanged, memberIds }` | plan | Dry run: counts, sizes and the preserved paths per member |
| `clusterUpdate` | `id, { validate, onlyChanged, skipParentUpdate, memberIds }` | per-member report | Updates the parent, then copies its files to the members; progress as `cluster:progress` |
| `clusterConfigPlan` | `id, { configIds, memberIds }` | diffs + warnings | Nothing is written |
| `clusterConfigApply` | `id, { configIds, memberIds }` | `{ written, errors }` | Writes with `.bak`; logged as `cluster:config-sync` |
| `clusterClearPlan` | `id, { memberIds }` | files + bytes per member | Dry run of the clear-folder rules |
| `clusterClear` | `id, { memberIds }` | `{ files, bytes, locked }` | Deletes matching old files (never folders) |

## Event log and Discord
| Channel | Args | Returns | Notes |
|---|---|---|---|
| `eventLogQuery` | `{ serverId, level, event, text, since, limit }` | entry[] | Newest first, limit 1..5000 (default 500). Entry: `{ ts, level, event, serverId, serverName, message, detail }` |
| `eventLogExport` | `{ ..filters, format: "text" or "jsonl" }` | string | Up to 5000 rows, oldest first |
| `eventLogClear` | - | number | Deletes every `ngsm-*.log` file, returns how many |
| `discordInfo` | - | `{ events[], defaults, templates, variables, sample }` | Everything the Discord view needs (event catalogue incl. plugin events) |
| `discordTest` | `kind, template?` | `{ ok, status, error? }` | Sends a test message to the **saved** global webhook (`kind` `"plain"` or an event key renders that template) |
| `discordPreview` | `template, sampleVars, event` | embed JSON | Rendered webhook body for the live preview; sends nothing |
| `discordBotStatus` | - | `{ state, user, error, guilds, registered }` | `state`: `off`, `connecting`, `online`, `error` |
| `discordBotRestart` | - | status | Disconnects and reconnects (re-registers commands) |
| `discordBotTest` | `candidate?` | `{ ok, error? }` | Token **format** check only (no network); without an argument checks the saved token |
| `discordBotCommands` | - | command JSON[] | The slash-command definitions in Discord's API shape (for the preview list) |

## Plugins and settings
| Channel | Args | Returns | Notes |
|---|---|---|---|
| `pluginDetail` | `id` | detail object | Listing data, README text, base64 icon / banner / screenshots, `docs` links, ports / defaults, and a trimmed `configs` / `logs` / `metrics` list |
| `pluginsInfo` | - | `{ loaded, errors[] }` | Result of the last plugin load |
| `pluginsReload` | - | plugin info | Re-reads bundled and user plugins; emits `plugins:reloaded` on the bus |
| `pluginsInstallZip` / `pluginsInstallFolder` | - | plugin id or `null` | Opens a file / folder dialog; `null` = cancelled |
| `pluginsFolder` | - | - | Opens the user plugins folder |
| `settings` | - | settings | Sanitised settings (bot token masked: `discord.botTokenSet`) |
| `saveSettings` | `patch` | settings | Validates, merges (nested objects merge key-wise), applies theme / login item / bot. A blank `botToken` keeps the saved token, `discord.clearBotToken: true` removes it |
| `settingsDefaults` | - | settings | `DEFAULTS` of `settings.js` (reset buttons) |
| `openExternal` | `url` | - | Opens an `http(s)` link in the default browser; anything else throws |
| `pickFolder` | - | path or `null` | Folder dialog. Web mode: throws ("not available in web mode"); the UI hides the button and lets the user type the path |
| `relaunch` | - | - | Stops the servers gracefully and relaunches the app. Web mode: throws a hint to restart the service yourself |
| `platformInfo` | - | `{ mode, platform, features }` | `mode` = `desktop` or `web`; `platform` = `windows`, `linux` or `macos`; `features` = booleans the UI uses to hide what cannot work: `pickFolder`, `openFolder`, `revealBackup`, `backupDownload` (web only), `relaunch`, `tray`, `startOnLogin`, `hardwareAcceleration`, `installPluginFile`, `pluginsFolder`, `firewall` (Windows only) |

## Push events (main -> renderer)
Subscribe with `window.wgsm.on(channel, cb)`.

| Channel | Payload | When |
|---|---|---|
| `status` | server view | Any change of a server: status, PID, players, progress, busy text, settings saved |
| `console` | `{ id, line }` | A line of the game console (stdout / stderr, or an echoed command) |
| `consoleOut` | `{ id, consoleId, lines[], reset?, file? }` | Output of an injected console: a `log` console tail, or the answer of an RCON command. `reset: true` = replace the buffer (the tail restarted) |
| `logLines` | `{ id, logId, lines[], reset?, file? }` | New lines of a followed log (Logs tab); `reset` after rotation / (re)start, `file` = the file actually followed |
| `removed` | `id` (string) | A server was deleted |
| `metrics` | `{ snapshot, point }` | Every 5 s while the collector runs: the full snapshot (`system`, `game`, `defs`, `servers[]`) and the new history point (`players`, `cpu`, `mem`, `k` tick, `l` latency) |
| `cluster:progress` | `{ phase, percent, memberId, memberName, memberIndex, memberCount, message }` | During a cluster update (parent update, then each member) |
| `discordBot` | `{ state, user, error, guilds, registered }` | The bot's connection state changed (the token is redacted from `error`) |

## Server-side event bus (not IPC)
Services subscribe to `mgr.events` (`server:*`, `cluster:*`, `plugins:reloaded`, `ngsm:log`); the list with payloads is in [TECH-architecture.md](TECH-architecture.md). These events are not forwarded to the renderer; the UI sees their effect through the push events above and the Logs screen.

## HTTP and WebSocket transport (web mode)
The headless server ([`src/server/headless.js`](../src/server/headless.js), `npm run serve`) exposes the same API table and the same push events. `src/renderer/transport-web.js` implements `window.wgsm = { call, on, mode: 'web' }` on top of it, so the renderer code is identical in both modes.

| Endpoint | Auth | Description |
|---|---|---|
| `GET /healthz` | none | `{ "ok": true }` and nothing else (Docker / monitoring health check) |
| `POST /login` | none (rate limited) | Body `{ "token": "..." }`. 200 sets the session cookie; 401 wrong token; 429 locked (`Retry-After` seconds); 403 cross-origin; 415 not JSON |
| `POST /logout` | cookie | Destroys the session and clears the cookie |
| `POST /api/<channel>` | cookie or bearer | Body `{ "args": [ ... ] }` (JSON, `Content-Type: application/json`). Reply `200 { "ok": true, "data": ... }` or `200 { "ok": false, "error": "..." }` (same shape as IPC). Protocol errors use HTTP codes: 400 bad JSON / `args` not an array, 401, 403 cross-origin, 404 unknown channel, 405 not POST, 413 body too large (default 4 MiB, `NODEGSM_MAX_BODY`), 415, 429 |
| `GET /download/backup?folder=<id>&file=<name>.zip` | cookie or bearer | Streams a backup zip as an attachment. `folder` / `file` are validated by the backup service (`^\d+(\.deleted-\d+)?$` and `^[A-Za-z0-9._-]+\.zip$`), so nothing outside `<data>/backups` can be read |
| `GET /ws` (upgrade) | cookie or bearer, same-origin | Push channel. Every message is a JSON text frame `{ "ch": "<event>", "payload": ... }` for the events listed below (`status`, `console`, `consoleOut`, `logLines`, `removed`, `metrics`, `cluster:progress`, `discordBot`). Client frames are ignored. The server pings every 30 s; close code 4401 = session expired, 1001 = shutting down |
| `GET /`, `/index.html` and the other renderer files, `/assets/*` | cookie or bearer (except the login page, `styles.css`, `theme-boot.js`, the logo) | Static files with strict path confinement; unauthenticated `/` redirects to `/login.html` |

- **Credentials:** the browser uses the `nodegsm_session` cookie (`HttpOnly; SameSite=Strict; Path=/`, `Secure` when `--https` or `X-Forwarded-Proto: https`). Scripts can send `Authorization: Bearer <token>` instead (no Origin header needed, no cookie).
- **CSRF:** for cookie (and no-auth) requests the `Origin` header must be present and equal to `Host`; otherwise 403. JSON content type only; there is no CORS (no `Access-Control-*` headers).
- **Not available in web mode** (they throw an error, the UI hides them): `pickFolder`, `openFolder`, `backupOpenFolder`, `backupDownload` (use the HTTP download above), `pluginsInstallZip`, `pluginsInstallFolder`, `pluginsFolder`, `openExternal` (the browser opens links itself), `relaunch`.
- **Example:** `curl -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"args":["1"]}' http://127.0.0.1:8730/api/start`
