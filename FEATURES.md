# NodeGSM - Features

Single source of truth for what NodeGSM can do. Updated with every change (see [Changelog](#changelog)).
Status: ✅ done · 🧪 done but not tested against a real server · ⏳ planned

## Plugins (every game is a plugin)
| Feature | Status | Notes |
|---|---|---|
| All 46 games are plugins in `plugins/<id>/` | ✅ | Edit/fix a game with a pull request - [CONTRIBUTING.md](CONTRIBUTING.md) |
| Declarative `plugin.json` + JSON Schema (`plugins/plugin.schema.json`) | ✅ | Editor auto-complete; format reference in [PLUGINS.md](PLUGINS.md) |
| Listing metadata: title, description, author, version, tags, url, icon, banner, README, screenshots | ✅ | Shown in the in-app **Games** browser and the website |
| Plugin `metrics`: game-specific live numbers (FPS, tick rate, entities ...) read with a regex from the console or a log, optionally polled with a console command | ✅ | Become selectable columns on Table / Dashboard; no built-in plugin ships one yet (a game must print the value - add only verified patterns) |
| Documentation links (`docs`): official and unofficial guides per game | ✅ | Grouped Official / Unofficial in the **Games** browser; exported in `registry.json`; at least one required for repository plugins. All 46 built-ins have links (Valve/SteamDB patterns + well-known guides) |
| Install steps: `steamcmd`, `download`, `extract`, `run` (other installers), `write`, `mkdir`, `script` | ✅ | Confined to the server folder; zip built in, 7z/tar.gz via Windows `tar` |
| Config files: any number per game (INI, JSON, XML, properties, cfg, YAML, text) | ✅ | **Config Files** tab: edit, JSON validation + format, `.bak` of previous version, create from template |
| Log files: any number per game, live view | ✅ | **Logs** tab: list of logs, live tail, wildcard (newest file), rotation handled, filter, pause, error/warn highlight |
| Argument templates (`{port}`, groups, optional `[...]`, `{param}`, `{paramRaw}`, `{port+10}`) | ✅ | Missing values drop their argument automatically |
| Optional `plugin.js` hooks: `install`, `latest`, `local`, `args` | ✅ | Full Node access - reviewed in PRs; used by Minecraft, Bedrock, Vintage Story, FiveM |
| Install plugin from ZIP / folder, Reload, open plugins folder | ✅ | In **Games** dialog |
| Local plugin overrides a built-in one with the same id | ✅ | Fix an obsolete game without waiting for a PR |
| Validation with visible errors; `npm run validate:plugins` | ✅ | Same checks run in CI on pull requests |
| `plugins/registry.json` for the website (`npm run registry`) | ✅ | id, metadata, ports, configs, logs and relative media paths |
| Game browser in the app (search, README, screenshots, defaults, configs/logs) | ✅ | **Games** button → **Add server** |
| PR guide, PR template, game-request issue template, CI | ✅ | `CONTRIBUTING.md`, `.github/` |
| Optional plugin fields: `cluster`, `configs[].protect`, `backup`, `events`, `logging`, `consoles`, `update.validateArgs`, `files.autoClear` | ✅ | Validated (relative paths only, regexes must compile), in the schema, template, `toGame()` and `registry.json`; `backup`, `events`, `logging` and `cluster` (+ `configs[].protect`) are used by the app; `consoles`, `update.validateArgs` and `files.autoClear` are ⏳ |
| Converter for WindowsGSM C# plugins | ⏳ | Manual mapping table in PLUGINS.md for now |
| Online plugin repository / one-click install from the website | ⏳ | |

## Website (`website/`)
| Feature | Status | Notes |
|---|---|---|
| Dark futuristic site: Home, Features & changelog, Plugins, Download | ✅ | No framework; `npm run site:serve` to run it |
| Plugin **catalog** (`index.json` + `zips/` + `icons/`, sha256, `hasScript`, docs links) built by `npm run catalog` / `npm run site` | ✅ | Site reads `CATALOG_URL`, so it can use a catalog published from a separate plugins repo; nothing is hard-coded |
| Feature tables + changelog generated from `FEATURES.md` | ✅ | |
| Plugins page: forgiving search ("7daytodie", "7 days to die", "7dtd", typos), tag filter, sort (name / rating / downloads / players), detail drawer, official + unofficial doc links, zip download, `plugin.js` warning | ✅ | Deep links like `plugins.html#rust` |
| **Own backend** (`website/server/`, no dependencies): ratings, comments, editable community info with revisions, download counts, admin moderation | ✅ | Rate limits, size limits, link-spam limit, hashed IPs; tests: `npm run test:site`. No accounts/CAPTCHA/moderation UI yet |
| Same UI without the backend | ✅ | Falls back to per-browser storage (shown with a notice) |
| GitHub Pages deploy workflow (static part only) | 🧪 | `.github/workflows/site.yml`; Pages cannot run the backend, so set `API_URL` to a hosted API |
| Online plugin catalog in the app (enable online, install, update from the catalog) | ⏳ | Designed: same `index.json`, sha256-verified, warn on `plugin.js` |
| Separate plugins repository with PR validation + catalog publish | ⏳ | `scripts/build-catalog.js` is ready to move |
| Releases / download buttons | ⏳ | Link to GitHub Releases; no release has been published yet |

## Server management
| Feature | Status | Notes |
|---|---|---|
| 46 built-in games (ported from WindowsGSM + Palworld) | ✅ | Source, GoldSource, Unreal, Unity, Minecraft, FiveM, ... |
| GoldSource games install through HLDS (app 90 + mod, 5 passes, `steam_appid.txt`) | ✅ | Matches WindowsGSM (earlier builds used the wrong app ids) |
| One-click install, progress (percent + GB), strict success check | ✅ | Fails if a step fails or the server exe is missing afterwards |
| SteamCMD auto-download + first-run self-update | ✅ | |
| Custom installers: Minecraft Java, Minecraft Bedrock, Vintage Story, FiveM | 🧪 | Implemented as plugin.js; Bedrock/FiveM/VS not run against the real download servers yet |
| Import existing server folder | ✅ | Points at the folder, no copy; delete never removes imported files |
| Multiple servers, per-server config | ✅ | `servers/<id>/configs/wgsm.json` |
| Automatic free-port suggestion | ✅ | Respects `portIncrement` |
| Start / Stop / Restart | ✅ | Stop = console command, then `taskkill`, then force kill after 15 s |
| Live console + command input | ✅ | Not for Source/GoldSource (`stdin: false`) |
| Auto restart on crash, auto start with app | ✅ | |
| Update check, manual update, auto update (every 30 min), update on start | ✅ | Steam build id, or plugin `latest`/`local` |
| Backup on start, backup / restore (zip) | ✅ | Now streamed (memory use does not depend on server size) and with a manifest; see the backup rows below |
| Restart crontab | ✅ | Standard 5-field cron |
| CPU priority and affinity | ✅ | |
| Server query (A2S, UT3, FiveM): player counts, Starting vs Started | ✅ | |
| Firewall helper (netsh) | 🧪 | Needs Administrator |
| File browser + text editor (any file in the server folder) | ✅ | 2 MB limit, path-traversal protected |
| Discord webhook alerts (per-server webhook with the old flags) | ✅ | Start, crash, auto restart, auto update, crontab; now sent by `services/discord.js` |
| Steam login for games that need a real account | ⏳ | Anonymous only for now |
| Discord bot remote control | ⏳ | |
| Mod manager | ⏳ | |
| **Clusters** (Home > Clusters): same-game server groups with a parent, create / rename / change parent / add and remove servers, delete (never deletes servers) | 🧪 | `services/cluster.js`, `<data>/clusters.json`; tested headless with fake servers, not yet used on a real multi-server setup - [docs/GUIDE-clusters.md](docs/GUIDE-clusters.md) |
| Cluster **update**: update the parent (validate option), then copy its game files to every member without overwriting configs / saves / `cluster.preserve`; dry-run plan, only-changed option, sequential with progress, running members stopped and restarted, one failing member does not stop the rest | 🧪 | Links are never followed, paths are confined; per-member report |
| Cluster **config sync**: copy chosen plugin config files, keeping protected keys (`configs[].protect`, `cluster.protectedConfigKeys`, cluster rules, globs like `rcon.*`) and `NGSM:ignore` lines; ini / properties / cfg / yaml line merge, json deep merge, text / xml whole copy; diff preview, `.bak` on apply | 🧪 | YAML is line-matched without a YAML library |
| Cluster **clear folders**: plugin `cluster.clearFolders` + per-cluster rules, `*` / `?` pattern, age by mtime, dry run, files only, locked files skipped and counted | 🧪 | |
| NGSM event log: start / stop / crash / restart / update / backup / restore / console commands / config edits, daily rotated JSONL, retention (`logging.retentionDays`, default 30 days) | 🧪 | `services/eventLog.js`; `<data>/logs/ngsm-YYYY-MM-DD.log`; tested headless, not yet observed in a long-running real session. Format: [docs/GUIDE-logging.md](docs/GUIDE-logging.md) |
| Plugin `logging.patterns`: console regex -> log entry (rate limited, 1 per pattern per server per 10 s); a pattern id that matches an `events[]` id becomes a Discord-able event `game:<id>` | 🧪 | Console lines only; `logging.logFiles` scanning is ⏳ |
| **Logs** screen (Home > Logs): filter by server / level / event / text, auto refresh, Export (text), Clear | ✅ | |
| Discord webhook alerts as embeds or simple messages, per event: started, stopped, crashed, restarted, updated, backup, restore + plugin events | 🧪 | `services/discord.js`; global webhook (`discord.webhookUrl`) plus the per-server webhook; send queue with 429 / `retry_after` handling; tested against a local HTTP server only - never sent to a real Discord yet |
| Embed editor (title, description, colour, thumbnail, image, footer, fields) with live Discord-style preview, placeholders `{server} {event} {game} {ip} {port} {players} {time}`, Send test, Reset to default | ✅ | **Discord** view; templates stored in `settings.discord.templates` |
| Per-event toggles (global) and per-server overrides (Default / On / Off); the old per-server flags (Start, Auto restart, Auto update, Crontab restart, Crash) keep working | ✅ | Per-server overrides in the server's **Automation** tab |
| Webhook URL safety: only `https://discord.com` / `discordapp.com` `/api/webhooks/...` accepted; mentions disabled in messages | ✅ | Validated in `settings.js` and again at send time |
| Discord bot slash commands (`/start`, `/stop`, `/backup` ...) | ⏳ | Settings `discord.botToken/guildId/allowedUserIds/adminRoleIds/allowRawCommands`, `services/discordBot.js` skeleton |
| **Backups: Full or Neat pick** (plugin presets + a tick-box tree of folders/files + exclude patterns, optional server settings), size estimate | 🧪 | **Backups** tab of a server; `services/backup.js`; streaming zip (`services/zip.js`, zip64), manifest `<backup>.json`; tested headless with fake servers, not yet on a real multi-GB server |
| Backup retention (keep the newest N per server, `backupKeep`) | ✅ | 0 = unlimited |
| Restore (Full: extract over; Neat pick: only when the game is installed) with zip-slip / symlink protection | ✅ | Server is stopped first; optional restore of the saved server settings |
| **Restore as new server** (Full: create + extract; Neat pick: create + install + apply; settings with port-conflict resolution) | 🧪 | Needs the game plugin; old backups without a manifest need the game chosen; Neat pick install needs internet |
| **Backups** screen (Home > Backups): all servers, deleted servers marked, filters, Restore / Restore as new / Open folder / Delete | ✅ | |
| Plugin `backup.presets` / `backup.exclude` shipped for Minecraft Java, CS:GO, Rust, Palworld, ARK: SE | ✅ | Paths are best-effort (not checked against live servers) |
| Files auto-clear rules | ⏳ | Plugin `files.autoClear` and `services/autoClear.js` skeleton |

## App
| Feature | Status | Notes |
|---|---|---|
| Electron UI (dark theme) | ✅ | |
| Start on Windows login, minimize to tray | ✅ | |
| Table view: WindowsGSM-style horizontal server table | ✅ | ID, PID, game icon, status, name, IP, port, query port, map, players, CPU, memory, uptime ... sortable; double-click opens details |
| Multi-select + bulk actions: Start, Stop, Restart, **Kill** (force), Update, Backup | ✅ | Checkboxes, header "select all", Ctrl/Shift click; Stop/Restart/Kill run in parallel, Start/Update/Backup one after another; buttons enable only when they apply; skipped (not applicable) servers are reported |
| Choose which columns to show (Settings, Table and Dashboard) | ✅ | Built-in columns + plugin metrics; saved; reset to default |
| Dashboard: system CPU / memory / disk, installed + online servers, active players | ✅ | Refreshes every 5 s |
| Dashboard: per-server CPU, memory (whole process tree), threads, uptime, players | ✅ | One PowerShell process table read per tick, only while servers run |
| Dashboard: history chart (players / CPU / memory, per server) | ✅ | Last 30 minutes, canvas, follows the theme |
| Theme: Dark / Light / follow Windows | ✅ | **Settings**; applied instantly, no flash on start; native dialogs follow the theme |
| Accent colour: 11-colour palette + custom colour picker | ✅ | Not locked behind a donor tier |
| UI animation on/off | ✅ | Transitions, dialog/toast animations |
| Hardware acceleration on/off | ✅ | Applies after a restart (**Restart now** button stops servers gracefully first) |
| Auto restart NodeGSM on crash | ✅ | Relaunches at most 3x per 10 min (no crash loops); crashes logged to `logs/crash.log`; renderer crashes reload the window |
| Telemetry / "send statistics" | - | Deliberately none |
| System metrics in header | ✅ | |
| Left navigation: Home (List, Table), System Metrics, Games / Plugins, Settings, Discord | ✅ | Replaces the header view switch; Games and Settings are full views now (no longer dialogs); the nav itself collapses to an icon rail |
| Collapsible server-list, details and quick-settings panels (`ui` setting) | ✅ | Toggle buttons in the header; state saved in settings and mirrored to localStorage so `theme-boot.js` applies it before first paint; collapsing maximises the main area |
| Details panel (status, PID, address, players, map, uptime, CPU, memory) and quick-settings bottom panel (name, port, map, max players, start parameters, Save) | ✅ | Follow the selected server; unsaved quick-settings edits are not overwritten by status updates |
| Header info bar: CPU, RAM, Disk, Servers (running/total), Players, Tick (`headerStats` setting) | ✅ | Chosen with checkboxes in Settings; Tick shows "-" until servers report a tick rate (planned) |
| Footer links: Website, Discord, Donate (Patreon, PayPal, Buy Me a Coffee) | 🧪 | All URLs live in `src/renderer/links.js` and are PLACEHOLDERS to replace |
| Discord view: webhook + Send test, event toggles, embed editor + preview (bot settings: coming) | ✅ | |
| Logs screen under Home | ✅ | See server management table |
| Windows installer + portable exe (electron-builder) | ✅ | `npm run dist`; unsigned, default icon; bundles `plugins/` |
| External links open in the default browser; in-app navigation blocked | ✅ | |
| Legacy data folder kept after rename | ✅ | `%APPDATA%\node-wgsm2026\WGSM` if present, else `%APPDATA%\NodeGSM` |

## Changelog
Newest first. Add an entry for every change.

### 2026-11-24 - Clusters: update, config sync, clear folders
- **`services/cluster.js`** (`Cluster`, also `mgr._cluster`) and **`<data>/clusters.json`** (`{ version: 1, clusters: [{ id, name, game, parentId, memberIds[], createdAt, options }] }`, atomic writes, a corrupt file is set aside as `clusters.json.corrupt-<ms>`). Create needs at least 2 servers, **all the same game**, the parent must be a member, a server can be in **one** cluster only. Rename / set parent / add / remove members / delete (servers are never deleted). When a server is removed it leaves its cluster (`mgr 'removed'`); a deleted parent is replaced by the first remaining member; fewer than 2 servers dissolve the cluster (logged).
- **Cluster update:** updates the parent through `mgr.update(id, validate, { cluster })` (plugin `update.validateArgs` applies), then copies the parent's files to every member **without overwriting** plugin config files (`configs[].path` and `.bak`), `cluster.preserve`, the cluster's own preserve rules and `configs/wgsm.json`. `onlyChanged` skips files with identical size + mtime (copies keep the parent's mtime). Members are processed one after another, running ones are stopped first and restarted afterwards; progress is pushed as `cluster:progress` (`phase`, `percent`, `memberId`, `memberName`, `memberIndex`, `memberCount`, `message`). Dry-run `clusterUpdatePlan` returns counts, sizes and the preserve list per member. Files are copied through a temp name and renamed; symlinks / junctions are never followed (source or destination); a failing member (busy, locked file, blocked path) is reported and the others continue.
- **Config sync** (`services/clusterMerge.js`, pure functions): merge rules for ini, properties, cfg, yaml (line aware), json (deep key paths, 2-space output) and text / xml (whole file). Protected keys are globs (`port`, `rcon.*`, case-insensitive) from `configs[].protect`, `cluster.protectedConfigKeys` and the cluster's own list; lines containing `NGSM:ignore` (`#`, `//`, `;`, `<!-- -->`) keep the member's line, in the parent's or the member's file. A member without the file gets the parent's copy with a `protected key not present in member` warning. `clusterConfigPlan` returns a unified-style diff per member and file (nothing written), `clusterConfigApply` writes with a `.bak` and logs (`cluster:config-sync`, plus `server:config`).
- **Clear folders:** plugin `cluster.clearFolders` + `options.clearFolders` (`{ path, pattern, olderThanDays, recursive? }`); paths confined with `safeRel` / `inside` / `realpath`, links not followed, files only (folders stay), locked files skipped and counted, dry-run plan with files and bytes. New optional rule field `recursive` (schema + validator).
- **Events / log:** `cluster:created`, `cluster:deleted`, `cluster:update-started`, `cluster:update-finished`, `cluster:update-failed`, `cluster:config-synced`, `cluster:cleared` on `mgr.events` (payload `{ id: parentId, name, game, ts, detail }`); NGSM log entries `cluster:*` (see the guide).
- **IPC:** `clusters`, `clusterCreate`, `clusterSave`, `clusterDelete`, `clusterUpdatePlan`, `clusterUpdate`, `clusterConfigPlan`, `clusterConfigApply`, `clusterClearPlan`, `clusterClear`; push event `cluster:progress`.
- **UI:** **Home > Clusters** (`clustersView.js`): cluster list with member status, *Create cluster* dialog (servers grouped by game, parent, name), detail with **Update** (validate / only changed / parent-first, preview, progress bar, per-member result), **Config sync** (file picker, diff preview with warnings, apply), **Clear folders** (rules, preview, run) and **Edit** (name, parent, servers, protected keys, preserve paths, clear rules), delete. Both themes.
- **Plugins:** `cluster` blocks and `configs[].protect` added to `mc`, `arkse` (config protect + saves preserved) and `rust` (`registry.json` regenerated).
- **Tests:** merge for ini / properties / json / yaml / cfg / text / xml (protect globs, every `NGSM:ignore` style, CRLF, missing member file, member-only keys, broken JSON), diff, option sanitising, create validation (mixed games, single member, duplicates, double membership, parent), persistence, config plan / apply (unique ports and rcon kept, `.bak`), update distribution (configs, preserve paths, `wgsm.json` untouched, links not followed, onlyChanged, parent update via `mgr.update(validate)`, busy / blocked member does not stop the others, stop-before / start-after for running members, one operation per cluster), clear folders (pattern, age, no sub-folders, folder kept, path escape and link rejection), member removal cleanup, events and log entries, IPC table, corrupt file.
- Docs: [docs/GUIDE-clusters.md](docs/GUIDE-clusters.md), [docs/TECH-architecture.md](docs/TECH-architecture.md), [docs/TECH-data-formats.md](docs/TECH-data-formats.md), [PLUGINS.md](PLUGINS.md), [docs/OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md).

### 2026-11-24 - Backups: full/neat pick, restore, restore as new, backup list
- **`services/backup.js`** (`BackupService`, also reachable as `mgr.bk()`): modes `full` (whole server folder) and `neatpick` (plugin `backup.presets` ids + chosen relative folders/files, optionally the server's `wgsm.json`). Exclude patterns = plugin `backup.exclude` + user patterns (`*`, `**`, `?`; no `/` = match by name anywhere, with `/` = from the server root). `ServerManager.backup / backupList / restore / deleteBackup` now delegate to it (same names; bulk backup, backup-on-start and old backups keep working).
- **Streaming zip** (`services/zip.js`, no new dependency): files are read, deflated and written chunk by chunk, zip64 when needed, written to `*.partial` and renamed when complete; the reader extracts entry by entry with CRC and size checks. AdmZip is no longer used for backups.
- **Manifest** `backup-<ISO>.json` next to every zip (`version, mode, game, serverName, serverId, createdAt, paths, presets, exclude, sizeBytes, uncompressedBytes, fileCount, gameVersion, includesServerSettings, skipped?, missing?`); backups without one are treated as `full`. Format in [docs/TECH-data-formats.md](docs/TECH-data-formats.md).
- **Safety:** all selection paths are normalised (no `..`, absolute paths, drive letters or `:`), symlinks / junctions are never followed, and every zip entry name is validated before anything is extracted (zip-slip), including through links already in the server folder. Locked files are skipped and counted.
- **Retention:** new per-server setting `backupKeep` (0 = unlimited, max 1000) in `wgsm.json`, sanitised in `settings.js`; old backups and manifests are deleted after each new backup (`backup:pruned` log entry).
- **Restore:** Full extracts over the files (server stopped first); Neat pick requires an installed server ("install the game first, then restore"); a backup of another game is refused; `restoreSettings` optionally re-applies the saved `wgsm.json`. **Restore as new server** (`restoreAsNew`) creates a new server from the manifest's game (Full: extract; Neat pick: run the install, then apply), applies the saved settings except `id / game / installDir`, moves a taken port to the next free one, removes the new server again on failure and reports a missing plugin clearly. Old backups without a manifest need `game`.
- **Events:** `server:backup` detail now has `mode, sizeBytes, fileCount, skipped`; `server:restore` has `mode, fileCount` and, for restore-as-new, `asNew, from`. Extra NGSM log entries `backup:pruned / backup:skipped / backup:failed / backup:restore-failed` (the event log registers itself as `mgr.eventLog`).
- **IPC:** `backups()` = all backups of all servers (server name, game, `deleted`, `legacy`, manifest), `backups(folder)`, `backup(id, opts)`, `backupInfo(id)` (presets, plugin excludes, retention), `backupPreview(id, opts)`, `restore(id, file, opts)`, `restoreNew(folder, file, opts)`, `deleteBackup`, `backupDownload(folder, file)` (reveals the zip), `backupOpenFolder(folder)`.
- **UI:** server **Backups** tab with the Full / Neat pick chooser (presets, tick-box tree, exclude patterns, settings tick, size estimate, retention, list with actions) and the new **Home > Backups** screen with filters; "Restore as new server" dialog. Both themes. The tab is no longer re-rendered on status updates (it would reset the selection).
- **Plugins:** `backup.presets` / `backup.exclude` added to `mc`, `csgo`, `rust`, `palworld`, `arkse` (`registry.json` regenerated).
- **Tests:** helpers (paths, excludes, crc32, zip64 + corruption), full roundtrip, neat pick with presets / exclude / settings, preview, path confinement, symlink skip, zip-slip (6 variants, nothing written, no server created), legacy backup, retention, bulk backup, restore-as-new (full, neat pick with install, legacy, missing plugin, failing install, from a deleted server), neat pick refused when not installed, wrong game refused, events and log entries, all-backups listing, IPC.
- Docs: [docs/GUIDE-backups.md](docs/GUIDE-backups.md), [docs/TECH-data-formats.md](docs/TECH-data-formats.md), [docs/TECH-architecture.md](docs/TECH-architecture.md).

### 2026-11-24 - NGSM event log, Discord alerts and embed editor
- **Event log** (`src/main/services/eventLog.js`): subscribes to `mgr.events` (started, stopped, crashed = "stopped suddenly", restarted, updated, backup, restore, console command, config edit) and exposes `log(entry)` for other services. Entries `{ ts, level, event, serverId, serverName, message, detail }` are appended to `<data>/logs/ngsm-YYYY-MM-DD.log` (JSONL, one file per day), pruned on start and daily by `settings.logging.retentionDays`. `query({ serverId, level, event, text, since, limit })`, `export()` (text or JSONL) and `clear()`.
- **Plugin `logging.patterns`** now work: each console line of a server is matched against its game's patterns; hits become entries (`pattern:<id>`, or `game:<id>` when the id is also declared in `events[]`), at most once per pattern per server per 10 s.
- **Logs screen** (Home > Logs) and IPC `eventLogQuery`, `eventLogExport` (returns text), `eventLogClear`.
- **Discord service** (`src/main/services/discord.js`) replaces `ServerManager.alert()`: per-event embeds or simple messages to the global webhook and the per-server webhook; per-event toggles (`settings.discord.events`) with a per-server override (`discordEvents` in `wgsm.json`); the old per-server flags still decide the per-server webhook for start / crash / auto restart / crontab restart / auto update. Send queue with a small delay, 429 handling (`retry_after`), retries on 5xx, never throws; the sender is injectable for tests (`allowAnyUrl`, `agent`).
- **Templates** in `settings.discord.templates` (mode `simple` | `embed`, title, description, colour, thumbnail, image, footer, up to 10 fields) with placeholders `{server} {event} {game} {ip} {port} {players} {time}` (also `{id} {reason} {file} {message}`); defaults: started green, stopped grey, crashed red, restarted/updated blue, backup/restore teal. Mentions are disabled in every message.
- **Settings hardening:** `settings.discord.templates`, the webhook URL and the per-server `discordWebhook` / `discordEvents` / `discordMessage` are sanitised (strict types, length caps, https-only image URLs, webhook host allow-list). **Behaviour change:** a webhook that is not a Discord webhook URL is now rejected (global: dropped; per server: the save fails with a message). `ServerManager.saveConfig` runs the per-server check.
- **IPC:** `discordInfo`, `discordTest(kind, template)` (sends to the saved global webhook, returns `{ ok, status }`), `discordPreview(template, sampleVars, event)` (rendered embed JSON).
- **UI:** Discord view (webhook + Send test, event toggles, embed editor with a live Discord-style preview, light and dark), Logs screen, per-server **Discord event overrides** in the Automation tab. The renderer CSP now allows `https:` images so thumbnails/images show in the preview.
- **Bus:** new events `server:config` and `plugins:reloaded`, `ngsm:log` (every logged entry); `server:restarted` carries `reason` (`manual` | `crash` | `cron`), `server:updated` carries `auto/from/to` for auto updates.
- **Tests:** event log write / query / rotation / retention / patterns / rate limit / export / clear; Discord rendering, placeholders, toggle logic, legacy flag mapping, 429 retry, test-send and queue order against a local HTTP server (never a real Discord); settings sanitising; API table.
- Docs: [docs/GUIDE-logging.md](docs/GUIDE-logging.md), [docs/GUIDE-discord.md](docs/GUIDE-discord.md), [docs/TECH-architecture.md](docs/TECH-architecture.md).

### 2026-11-24 - New app shell: collapsible nav, panels, header stats, footer
- **Left navigation** (Home > List / Table, System Metrics, Games / Plugins, Settings, Discord) replaces the header view switch. `body[data-view]` now takes `servers | table | dashboard | plugins | settings | discord`; only the first three are remembered in `settings.view`.
- **Games browser and Settings** moved from dialogs to full views (same render code and handlers). **Add Server** stays a dialog. The Discord view is a placeholder.
- **Panels:** collapsible server list (left), details (right) and quick settings (bottom) with toggle buttons in the header and a collapsible nav. State is saved in `settings.ui` and mirrored to `localStorage` (`nodegsm.ui`) so `theme-boot.js` applies it before first paint. New file `src/renderer/shell.js`.
- **Header info bar** driven by `settings.headerStats` (CPU, RAM, Disk, Servers, Players, Tick); checkboxes in Settings. Tick shows "-" for now.
- **Footer** with Website / Discord / Donate links; URLs are placeholders in `src/renderer/links.js`, opened through `openExternal` (http/https only).
- **Tests:** ui/headerStats round trip, `links.js` constants are http(s), `index.html` has no inline scripts and contains the nav, panels and footer elements, `theme-boot.js` applies the layout.
- Guide: [docs/GUIDE-ui.md](docs/GUIDE-ui.md).

### 2026-11-24 - Foundation for clusters, Discord and backups
- **`src/main/api.js`:** the IPC `handle()` table moved out of `main.js` into `buildApi(ctx)` (`{ name: fn }`); `main.js` mounts it on `ipcMain` with the same channel names and `{ ok, data }` / `{ ok: false, error }` wrapping. No behaviour change; a web transport can mount the same table later.
- **Event bus:** `ServerManager.events` (EventEmitter) emits `server:started | stopped | crashed | restarted | updated | backup | restore | command` with `{ id, name, game, ts, detail }`. The existing Discord `alert()` calls are unchanged.
- **Service skeletons** in `src/main/services/` (`eventLog`, `discord`, `discordBot`, `backup`, `cluster`, `autoClear`): constructed and started/stopped from `main.js`, no behaviour yet.
- **New settings keys** (validated in `settings.js`): `ui` (panel collapse flags), `headerStats` (cpu, ram, disk, servers, players, tick), `discord` (webhook, bot token, application/guild id, allowed user ids, admin role ids, `allowRawCommands`, per-event toggles) and `logging.retentionDays`. Nested patches merge key-wise. Note: the bot token is stored as plain text in `settings.json`.
- **Optional plugin fields** (all backward compatible): `cluster`, `configs[].protect`, `backup`, `events`, `logging`, `consoles`, `update.validateArgs`, `files.autoClear`. Added to `plugin.schema.json`, validation (relative paths without `..`, regexes compile, ids unique), `toGame()`, `registry.json` (only when present), `plugins/_template` and PLUGINS.md.
- **Fixed:** a console command written while a server was being stopped could raise an unhandled `EPIPE` on the process stdin; stdin errors are now ignored.
- **Tests:** new fields accepted/rejected, settings sanitising of the new keys, `server:*` events from a fake server (start, command, stop, backup, restore, kill, crash), API table and service skeletons.

### 2026-11-24 - Dashboard, server table and bulk actions
- **Views:** header switch *List / Table / Dashboard* (last view remembered). **Table** is the horizontal WindowsGSM-style list with checkboxes; **Dashboard** shows system CPU/memory/disk, server counts, active players, a 30-minute history chart (players / CPU / memory) and the running-server table.
- **Multi-select bulk actions:** Start, Stop, Restart, Kill, Update, Backup on any number of selected servers (new `kill` = force-stop the whole process tree; `bulk` runner with per-server results).
- **Column picker** in Settings (also on the Table toolbar and Dashboard): ID, PID, icon, status, name, game, IP, port, query port, map, players, CPU, memory, uptime, threads, restarts + plugin metrics. One list for Table and Dashboard; reset to default.
- **Plugin `metrics`** (FPS, tick rate, entities ...): regex on console or a declared log, optional console command polled on a timer; validated, in the schema and template.
- **Fixed:** PID / CPU / memory stayed empty for servers without a query port (the first Started event fired before the process existed); deleting a server no longer leaves its backups for a new server that reuses the id (they are moved aside as `<id>.deleted-<time>`).
- **Tests:** process-tree totals, collector (CPU/memory/threads, console + command + log metrics, history), bulk start/stop/kill/backup incl. skipped and unknown actions, settings sanitising.

### 2026-11-24 - Themes, settings and documentation links
- **Settings dialog rebuilt:** theme (Dark / Light / Windows), accent colour (11 presets + custom picker), UI animation, hardware acceleration (restart button), start on login, minimize to tray, auto restart on crash. Changes apply and save immediately; values are validated (`src/main/settings.js`). The light theme covers the whole UI (terminal, dialogs, badges, logs).
- **Auto restart on crash:** uncaught main-process errors are logged and the app relaunches (max 3 per 10 minutes, servers stopped gracefully first); a crashed renderer reloads the window.
- **Plugin `docs` array:** official and unofficial documentation links per game (`title`, `url`, `type`, optional `description`). Validated (http/https only), shown in the **Games** browser grouped Official / Unofficial, exported in `registry.json`, required for repository plugins (validator + PR checklist). Added to all 46 built-in plugins and `plugins/_template`.
- **Tests:** docs validation, settings sanitising/persistence, crash-restart policy.

### 2026-11-24 - Website
- **New `website/`**: futuristic dark-mode static site (Home, Features & changelog, Plugins, Download). Layout inspired by the WindowsGSM site, written from scratch.
- **Plugins page** with forgiving search (fixed: "7daytodie" / "7 days to die" now find 7 Days to Die; matches names, ids, abbreviations, tags, app ids and small typos, ranked by relevance), tag filter, sort, per-plugin drawer (details, README, official/unofficial docs, how to install), zip download, star rating, comments and a Markdown **community info** page anyone can edit (revision history).
- **Own backend** `website/server/` (dependency-free Node server: static site + `/api`): shared ratings, comments, community info with revisions, download counts, admin moderation (delete comment, revert info), rate/size/link limits, hashed IPs, CORS allow-list; 17 tests (`npm run test:site`). Falls back to per-browser storage when it is not reachable.
- **Plugin catalog** `scripts/build-catalog.js` (`npm run catalog`): `index.json` + deterministic per-plugin zips (sha256) + icons, with `hasScript`, `minAppVersion` and docs links. The site reads it from `CATALOG_URL`, so it can be served from a separate plugins repo; the same file is what the app's future online mode will use.
- **`npm run site`** (`scripts/build-site.js`) generates `website/catalog/` and `website/data/site.json` (both gitignored); `.github/workflows/site.yml` publishes the static part to GitHub Pages.

### 2026-11-24 - Everything is a plugin
- **All games converted to plugins** (`plugins/<id>/plugin.json`, icon, README); the hard-coded catalog (`games.js`) and built-in installers are gone. Palworld added as a built-in plugin.
- **New plugin format (v2):** `install.steps` (steamcmd / download / extract / run / write / mkdir / script), `run` (exe, args templates, stdin, stopCommand), `defaults`, `configs`, `logs`, `media`. Breaking change for the short-lived v1 format (flat `exe`/`args`); local plugins must be updated - see PLUGINS.md.
- **Config Files tab** for plugin-declared INI/JSON/etc files; **Logs tab** with live tail of multiple logs.
- **Games browser** with README, screenshots, defaults, configs and logs; plugin install from ZIP/folder; local overrides of built-ins.
- **Fixed:** GoldSource games (CS 1.6, CZ, DoD, DMC, HLOF, Ricochet, TFC) now install via HLDS app 90 like WindowsGSM; EGS launches with `-startDedi`; PocketMine uses `-c bin/php`; 7DTD log path; ARK/Insurgency map strings.
- **Contributor tooling:** `CONTRIBUTING.md` (how to PR a game), PR + issue templates, CI workflow, `npm run validate:plugins`, `npm run registry` (`plugins/registry.json`), JSON Schema, `plugins/_template`.
- **Tests:** template expansion, install steps against a local HTTP server (download/extract/write, path-traversal blocked), config read/write/validate/backup, live log tail (append, rotation, wildcard), plugin install/override, run a fake server.

### 2026-11-24 - Earlier
- **Docs rule:** FEATURES.md, README.md, CLAUDE.md added; every change updates docs.
- **Renamed to NodeGSM.** User-visible names changed; internal names (`wgsm.json`, `.wgsm-version`) kept. Legacy data folder still used if it exists. Firewall rules are now named `NodeGSM #...`.
- **Install progress and honest results.** Percent/GB progress; install fails if the download did not complete or the exe is missing; SteamCMD self-updates on first run (previously exit code 7 was wrongly treated as success).
- **First plugin system** (flat `plugin.json`), Plugins dialog, Palworld example.
- **Windows exe builds** via electron-builder (installer + portable).
- **Initial Electron port** of WindowsGSM: catalog, SteamCMD, server manager, query, UI, smoke test.
