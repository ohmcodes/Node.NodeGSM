# Contributing

NodeGSM is split into three repositories:

| Repository | What goes there |
|---|---|
| **[NodeGSM](https://github.com/ohmcodes/Node.NodeGSM)** (this one) | the app: Electron UI, server manager, services, the plugin *format* |
| **[Catalogue](https://github.com/ohmcodes/Node.NodeGSM.Catalogue)** | **games**: add a new game or fix an outdated one. See its [CONTRIBUTING.md](https://github.com/ohmcodes/Node.NodeGSM.Catalogue/blob/main/CONTRIBUTING.md) |
| **[Website](https://github.com/ohmcodes/Node.NodeGSM.Website)** | the website, ratings, comments |

## Add or fix a game
Open a pull request in the **Catalogue** repository (copy `plugins/_template`, run `npm test` there). You do not need to build or even download NodeGSM for that. To try your plugin, install the folder in the app: **Games → Install plugin (folder)**. Can't code? Open a [Game request](https://github.com/ohmcodes/Node.NodeGSM.Catalogue/issues/new?template=game-request.md).

Migrating a plugin from **WindowsGSM**? The website has a converter (`/convert.html`, in the Website repository) that turns the C# file into a `plugin.json` + README and can guide or automate the pull request; see the Catalogue's CONTRIBUTING.md (*Migrating a WindowsGSM C# plugin*) for what converts and what does not.

You can also fix a game locally without a PR: put the edited folder in the app's plugins folder (**Games → Plugins folder**) with the same id; it overrides the catalogue copy.

## Change the app
1. Fork, `npm install --ignore-scripts` (skips the large Electron download, enough for tests), branch.
2. For tests you need the plugins: clone the Catalogue next to this repo (`..\Node.NodeGSM.Catalogue`) or set `NODEGSM_BUNDLED_PLUGINS` to its `plugins` folder.
3. `npm test` must pass. With every change update the **Changelog and tables in FEATURES.md**, README.md, PLUGINS.md, this file and any affected guide in `docs/`.
4. If you change the plugin format (`src/main/plugins.js`), also port the rule to the Catalogue's `scripts/lib/validate.js` and mirror [PLUGINS.md](PLUGINS.md) there.
5. Open the pull request; the template has a checklist.
6. Maintainers: to release, run `npm version <patch|minor|major>` then `git push --follow-tags`; `.github/workflows/release.yml` builds the exe and publishes the GitHub Release.

## Project layout (for code contributions)
```
(no plugins/ here: games live in the Catalogue repository)
assets/                logo.svg, logo-wordmark.svg, icon.svg (hand-written) and the generated icon.png / icon-16.png / icon-32.png
build/icon.ico         generated Windows icon (electron-builder reads it; npm run icons)
src/main/              Electron main process
  main.js              Electron only: window, tray, mounts api.js on ipcMain, forwards push events
  core.js              transport-agnostic bootstrap (ServerManager, services, metrics, push-event hub); used by main.js AND the headless server; never requires electron
  platform.js          everything OS specific: process-tree kill, /proc or PowerShell metrics, affinity, SteamCMD location, firewall, default data folder
  api.js               the IPC/API table (name -> function); reference: docs/TECH-api.md
  preload.js           exposes window.wgsm.call / on to the renderer
  serverManager.js     servers: install, start / stop, update, query, scheduler, events bus (mgr.events)
  plugins.js           plugin loader, validation, argument templates, toGame()
  catalogue.js         plugin catalogue client: cached list, sha256-verified install (the list lives in the Catalogue repository)
  installRunner.js, steamcmd.js, logTail.js, query.js   install steps, SteamCMD, live log tailing, A2S / UT3 / FiveM queries
  settings.js          app + per-server settings (sanitised on read and write)
  metrics.js           system + per-server metrics, plugin metrics, tick / latency
  configEdit.js        structured config parse / edit (pure functions)
  rcon.js              Source / Minecraft RCON client (queued, loopback only)
  crash.js             crash-restart policy
  services/            event-driven services, constructed in main.js, subscribe to mgr.events:
                       eventLog.js (NGSM log), discord.js (webhook alerts), discordBot.js (discord.js wiring) +
                       discordCommands.js (pure command handlers, tested with fake interactions), discordPermissions.js (per-user per-server permission rules: parse / sanitise / match),
                       backup.js + zip.js (streaming zip64), cluster.js + clusterMerge.js, autoClear.js, consoles.js
src/server/            headless web server: headless.js (HTTP + WebSocket, `npm run serve`), auth.js (token, sessions, rate limit)
src/renderer/          UI (plain JS / CSS, no framework, no inline scripts):
  index.html, styles.css, theme-boot.js (theme + layout before first paint)
  transport-web.js (window.wgsm over fetch + WebSocket; does nothing inside Electron), login.html + login.js (web-mode sign in)
  app.js (servers, detail tabs, games browser, settings), dashboard.js (table + metrics + views), shell.js (nav, panels, footer),
  tick.js (shared tick helpers, also required by the main process), links.js (footer URLs - placeholders),
  discordView.js, logsView.js, backupsView.js, clustersView.js, configsView.js, autoClearView.js, consolesView.js
scripts/               build-icons.js (logo -> PNG / ICO)
(website)              lives in its own repository: https://github.com/ohmcodes/Node.NodeGSM.Website
docs/                  user guides (GUIDE-*), technical docs (TECH-*), OPEN-QUESTIONS.md, TESTING-CHECKLIST.md - index in docs/README.md
Dockerfile, docker-compose.example.yml, deploy/   Docker image, compose example, systemd unit, nginx config
test/smoke.js          npm test (plugins are read from the Catalogue: NODEGSM_BUNDLED_PLUGINS or a sibling checkout)
```
**Optional plugin info.** Besides the required fields a plugin can declare (all optional, all validated, details and a complete example in [PLUGINS.md](PLUGINS.md)):
- `events` + `logging.patterns` - game events in the Logs screen and Discord, e.g. "player joined" ([docs/GUIDE-logging.md](docs/GUIDE-logging.md), [docs/GUIDE-discord.md](docs/GUIDE-discord.md)).
- `backup.presets` (saves, configs, mods) and `backup.exclude` (logs, temp files) for neat-pick backups ([docs/GUIDE-backups.md](docs/GUIDE-backups.md)).
- `cluster.preserve` (saves and per-server data a cluster update must not overwrite), `cluster.clearFolders`, `cluster.protectedConfigKeys` and `configs[].protect` (ports, passwords) ([docs/GUIDE-clusters.md](docs/GUIDE-clusters.md)).
- `consoles` (an `rcon:<port>:<password>` console, log tails) and `files.autoClear` (only always-safe-to-delete files may be `default: true`) ([docs/GUIDE-configs-files.md](docs/GUIDE-configs-files.md)).
- `metrics` with `"kind": "tick"` (TPS / tick rate / FPS from the console, a log or an RCON command) ([docs/GUIDE-metrics.md](docs/GUIDE-metrics.md)).
- `update.validateArgs` (what the Validate button passes to the installer).
- `platforms`, `run.linux`, `run.env`, `install.linux` (Linux support; plugins are Windows only by default). Only declare `linux` for a game whose Linux server you actually ran, or say clearly in the plugin README that it is *declared, untested* ([PLUGINS.md](PLUGINS.md#platforms-and-linux), [docs/GUIDE-web-linux.md](docs/GUIDE-web-linux.md)).
Only declare what you verified against a real server; say what you tested in the PR. Paths must be relative and regexes must compile.

**App-code changes:** run `npm test`, and update [FEATURES.md](FEATURES.md) (changelog + tables), the README, PLUGINS.md and the affected docs in [docs/](docs/README.md) in the same PR. IPC changes: add the channel to [docs/TECH-api.md](docs/TECH-api.md) (a test fails when a channel is missing there). Logo / icons: edit the SVGs in `assets/` and the matching geometry in `scripts/build-icons.js`, run `npm run icons` and commit the generated files.
