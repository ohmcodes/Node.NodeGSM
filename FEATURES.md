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
| Optional plugin fields: `cluster`, `configs[].protect`, `backup`, `events`, `logging`, `consoles`, `update.validateArgs`, `files.autoClear` | ✅ | Validated (relative paths only, regexes must compile), in the schema, template, `toGame()` and `registry.json`; the features that read them are ⏳ below |
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
| Backup on start, backup / restore (zip) | ✅ | |
| Restart crontab | ✅ | Standard 5-field cron |
| CPU priority and affinity | ✅ | |
| Server query (A2S, UT3, FiveM): player counts, Starting vs Started | ✅ | |
| Firewall helper (netsh) | 🧪 | Needs Administrator |
| File browser + text editor (any file in the server folder) | ✅ | 2 MB limit, path-traversal protected |
| Discord webhook alerts | ✅ | Start, crash, auto restart, auto update, crontab |
| Steam login for games that need a real account | ⏳ | Anonymous only for now |
| Discord bot remote control | ⏳ | |
| Mod manager | ⏳ | |
| Clusters: same-game server groups, cluster update, config sync (protected keys), clear folders | ⏳ | Foundation (`cluster` plugin fields, `services/cluster.js` skeleton) is in |
| NGSM event log (start/stop/crash/update/backup/restore/commands, retention) | ⏳ | `server:*` events and `services/eventLog.js` skeleton are in; setting `logging.retentionDays` |
| Discord embeds, per-event toggles, test button | ⏳ | Settings `discord.*` keys and `services/discord.js` skeleton are in; the old webhook alerts keep working |
| Discord bot slash commands (`/start`, `/stop`, `/backup` ...) | ⏳ | Settings `discord.botToken/guildId/allowedUserIds/adminRoleIds/allowRawCommands`, `services/discordBot.js` skeleton |
| Neat-pick backups, restore-as-new, backups screen | ⏳ | Plugin `backup` field and `services/backup.js` skeleton |
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
| Collapsible panels, left navigation, header stat checkboxes (`ui`, `headerStats` settings) | ⏳ | Settings keys are in and validated; the UI comes with the new shell |
| Windows installer + portable exe (electron-builder) | ✅ | `npm run dist`; unsigned, default icon; bundles `plugins/` |
| External links open in the default browser; in-app navigation blocked | ✅ | |
| Legacy data folder kept after rename | ✅ | `%APPDATA%\node-wgsm2026\WGSM` if present, else `%APPDATA%\NodeGSM` |

## Changelog
Newest first. Add an entry for every change.

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
