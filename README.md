# NodeGSM - Node Game Server Manager

An Electron rewrite of [WindowsGSM](https://github.com/WindowsGSM/WindowsGSM) - manage game servers with a GUI: install, import, start, stop, restart, update and automate multiple servers.

**Every supported game is a plugin** (a folder with a `plugin.json` in [`plugins/`](plugins)). New games and fixes for outdated ones are added by pull request - no app code, no compiling. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Run
```
npm install
npm start
npm test        # tests + plugin validation
```

## Build an exe
```
npm run dist    # installer + portable exe in dist/
npm run pack    # unpacked folder only (faster, for testing)
```
Builds are unsigned and use the default Electron icon. To use a custom icon, enable Windows Developer Mode, add `build/icon.ico` and remove `signAndEditExecutable: false` from `package.json`.

## Highlights
- **46 built-in games** as plugins; one-click SteamCMD install with progress; Minecraft/Bedrock/Vintage Story/FiveM download installers
- **Plugins can**: download/install other apps and extract them anywhere in the server folder, declare **any number of config files** (INI, JSON, ...) edited in the app, declare **any number of logs** viewed live, and carry a title, description, icon, banner, README, screenshots and **documentation links (official + unofficial guides)** for the in-app **Games** browser and the website
- Start/stop/restart, live console, auto restart, auto start, auto update, restart crontab
- **Backups:** Full or Neat pick (game presets + tick-box file tree + exclude patterns), retention, restore, **restore as new server**, and a **Backups** screen for all servers - [docs/GUIDE-backups.md](docs/GUIDE-backups.md)
- CPU priority/affinity, firewall helper, file editor
- **Clusters:** group same-game servers; **update** them together (parent first, then its files are copied, configs and saves are kept), **sync config files** with protected keys and `NGSM:ignore` lines, **clear folders** - [docs/GUIDE-clusters.md](docs/GUIDE-clusters.md)
- **NGSM event log** (start / stop / crash / update / backup / restore / commands / config edits, daily files, retention) with a **Logs** screen: filter, export, clear - [docs/GUIDE-logging.md](docs/GUIDE-logging.md)
- **Discord bot** (optional): slash commands `/check /list /start /stop /restart /update /backup /stats` (and `/send`, off by default) for allowed users and admin roles; every command is logged - [docs/GUIDE-discord.md](docs/GUIDE-discord.md)
- **Discord alerts** as embeds or simple messages: global + per-server webhook, per-event toggles and overrides, an embed editor with live preview and a Send-test button - [docs/GUIDE-discord.md](docs/GUIDE-discord.md)
- Player counts via A2S/UT3/FiveM queries; start on login and tray support
- **Views:** *List* (sidebar + details), *Table* (WindowsGSM-style horizontal table with **multi-select and bulk Start / Stop / Restart / Kill / Update / Backup**), *Dashboard* (system CPU / memory / disk, server counts, active players, history chart, running-server table). You choose the columns (CPU, memory, players, uptime, map, ports ... and plugin metrics like FPS) in Settings
- **Configs, Files auto-clear, consoles, Validate:** edit plugin config files **Structured** (key / value, comments kept) or **Raw** (**Home > Configs** and the server tab), delete old files on a schedule (Files tab), extra console tabs (RCON, log tail) next to the game console, and separate **Update** / **Validate** buttons - [docs/GUIDE-configs-files.md](docs/GUIDE-configs-files.md)
- **Server tick:** plugins can declare a `tick` metric (TPS, tick rate, FPS or ms per tick, read from the console, a log or an RCON command); it shows as a coloured **Tick** column, dashboard tile and chart and a header stat. Games without one get a **Latency** estimate (query round trip) - [docs/GUIDE-metrics.md](docs/GUIDE-metrics.md)
- **App shell:** left navigation (Home > List/Table/Configs/Logs/Backups/Clusters, System Metrics, Games / Plugins, Settings, Discord), collapsible server-list / details / quick-settings panels (state remembered, no flash on start), a configurable header info bar (CPU, RAM, Disk, Servers, Players, Tick) and footer links - see [docs/GUIDE-ui.md](docs/GUIDE-ui.md)
- **Settings:** Dark / Light / follow-Windows theme, accent colour palette (+ custom), UI animation, hardware acceleration, minimize to tray, auto restart on crash - no telemetry

## Docs
| | |
|---|---|
| [FEATURES.md](FEATURES.md) | full feature list with status, and the changelog |
| [docs/GUIDE-ui.md](docs/GUIDE-ui.md) | user guide for the app layout: navigation, panels, header bar, footer |
| [docs/GUIDE-configs-files.md](docs/GUIDE-configs-files.md) | the Configs editor (structured / raw), Files auto-clear, injected consoles (RCON / log), Update vs Validate |
| [docs/GUIDE-metrics.md](docs/GUIDE-metrics.md) | table / dashboard metrics, the server tick (TPS / tick rate), Latency, and how plugin authors add a tick metric |
| [docs/GUIDE-backups.md](docs/GUIDE-backups.md) | full / neat-pick backups, retention, restore, restore as new server, the Backups screen |
| [docs/GUIDE-clusters.md](docs/GUIDE-clusters.md) | clusters: create, update, config sync (protected keys, `NGSM:ignore`), clear folders |
| [docs/GUIDE-logging.md](docs/GUIDE-logging.md) | the NGSM event log: where it is, the format, retention, plugin patterns, the Logs screen |
| [docs/GUIDE-discord.md](docs/GUIDE-discord.md) | Discord webhook alerts, the embed editor, per-server overrides, the slash-command bot (setup, permissions, token warning) |
| [docs/TECH-architecture.md](docs/TECH-architecture.md) | event bus, services, log format, data files (for contributors) |
| [docs/TECH-data-formats.md](docs/TECH-data-formats.md) | backup manifest, event log line, `clusters.json`, auto-clear rules, `rcon:` sources |
| [PLUGINS.md](PLUGINS.md) | the `plugin.json` format, install steps, configs, logs, `plugin.js`, converting WindowsGSM plugins |
| [CONTRIBUTING.md](CONTRIBUTING.md) | **how to open a pull request to add or fix a game** |
| [plugins/registry.json](plugins/registry.json) | machine-readable list of all games (for the website) |
| [website/](website) | the NodeGSM website with its own community backend (ratings, comments, editable game info). Reads a plugin catalog (`npm run catalog`); `npm run site` then `npm run site:serve`. See [website/README.md](website/README.md) |

## Data location
Servers, backups, user plugins and SteamCMD live in `%APPDATA%\NodeGSM` (override with the `NODEGSM_DATA` env var).
If you ran the app before the rename, the old folder `%APPDATA%\node-wgsm2026\WGSM` is still used.

## Not done yet
Mod manager, Steam account login. See [FEATURES.md](FEATURES.md).

## Notes
- The Minecraft installer writes `eula.txt` with `eula=true`; using it means you accept Mojang's EULA.
- Firewall changes require running the app as Administrator.
- Game icons come from the original WindowsGSM repository (MIT).
