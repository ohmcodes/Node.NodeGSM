# Contributing - add or fix a game with a pull request

Every game in NodeGSM is a **plugin**: one folder in [`plugins/`](plugins). Adding a game, or fixing an outdated one, is a pull request that only touches that folder. No app code, no compiling.

> Can't or don't want to code? Open a **[Game request](../../issues/new?template=game-request.md)** issue instead.

## 1. Before you start
- Search [`plugins/registry.json`](plugins/registry.json) (or the in-app **Games** browser) to make sure the game isn't already there.
- You need: Git, Node.js 20+, and the game's dedicated server info (Steam app id, executable, start parameters, ports).
  [SteamDB](https://steamdb.info) shows the app id and install folder; the game's wiki / official docs list the launch options.

## 2. Add a new game

```powershell
# 1. Fork the repo on GitHub, then:
git clone https://github.com/<you>/<your-fork>.git
cd <your-fork>
npm install --ignore-scripts          # skips the large Electron download, enough for validation
git checkout -b add-mygame

# 2. Start from the template (the folder name = the plugin id: lowercase, a-z 0-9 _ -)
Copy-Item -Recurse plugins\_template plugins\mygame
```

3. **Edit `plugins/mygame/plugin.json`.** The comments in [PLUGINS.md](PLUGINS.md) explain every field. The minimum is `id`, `name`, `description`, `author`, `version`, `docs`, `install`, `run.exe`, `defaults`.
   **Add documentation links** (`docs`): official guides first, then unofficial ones (community wikis, forum guides, videos) - each with `title`, `url` and `type` (`official` / `unofficial`). Only add links you opened and checked.
   Optional: `configs`, `logs`, `metrics` (FPS / tick rate from the console, a log or an RCON command - only when you verified what the game prints; mark the server tick with `"kind": "tick"`, see [docs/GUIDE-metrics.md](docs/GUIDE-metrics.md)) and the info for clusters, backups, events, consoles and auto-clear (see "Optional plugin info" in the project layout below).
   Editors with JSON-schema support (VS Code does) autocomplete the fields because of the `$schema` line.
4. **Add the media** next to it:
   - `icon.png` - square PNG, 64x64 up to 256x256 (**required**)
   - `README.md` - what it is, ports to forward, notes (**required**, start from the template)
   - `banner.png`, `screenshots/*.png` - optional; list them under `media` in `plugin.json`
5. **Validate**
   ```powershell
   npm run validate:plugins mygame
   ```
6. **Test it in the app** (please do - say what you tested in the PR):
   ```powershell
   npm start
   ```
   **Games → Install plugin (folder)** → pick `plugins\mygame` → **Add Server** → let it install → **Start**.
   Check: it starts and stops, the **Config Files** tab opens your config files, the **Logs** tab streams the log, the port/query defaults are right.
7. **Rebuild the registry** (used by the website and the in-app browser) and commit:
   ```powershell
   npm run registry
   git add plugins/mygame plugins/registry.json
   git commit -m "Add MyGame dedicated server plugin"
   git push -u origin add-mygame
   ```
8. **Open the pull request** against `main`. The PR template has a checklist; CI runs the same validation and rejects broken plugins.

## 3. Fix an outdated game
Same flow, but edit the existing `plugins/<id>/plugin.json` (new exe path, ports, arguments, app id, config/log paths ...):
1. Bump `version` (e.g. `1.0.0` -> `1.0.1`).
2. Run `npm run validate:plugins <id>` and test in the app (see step 6 above).
3. `npm run registry`, commit, open a PR describing **what changed in the game** and a link proving it (patch notes / SteamDB / wiki).

You can also fix a game **locally without a PR**: put the edited folder in the app's plugins folder (**Games → Plugins folder**) with the same id - it overrides the built-in one.

## 4. Rules for plugins
- **JSON first.** Use `plugin.js` only when JSON cannot express it (e.g. resolving the latest download URL). Explain why in the PR - `plugin.js` runs with full access to the user's machine and gets a security review.
- **No binaries** (`.exe`, `.dll`, archives) and **no secrets** in the plugin folder. Download things at install time from the official source.
- Downloads must come from the vendor's official site/API; installers must not run anything the user didn't expect.
- Only list config/log paths you have verified. Paths are relative to the server files folder, use `/`, and cannot contain `..`.
- Keep images small (icon < 100 KB, screenshots < 1 MB each). Use the game's own icon/logo only as the small icon; don't commit large copyrighted art.
- One game per pull request.

## 5. What reviewers check
- [ ] `npm run validate:plugins` and CI pass
- [ ] Folder name equals `id`; `author`, `version`, `description`, `icon.png`, `README.md` present
- [ ] Install works from a clean state and the server starts (tested by the author or the reviewer)
- [ ] Default ports and `query` type are right (query is `null` when the game has no supported query protocol)
- [ ] Config files and logs open in the app
- [ ] Optional info (if present): `backup.presets` / `exclude`, `cluster.preserve` / `protect`, `consoles` (RCON password source resolves), `metrics` tick patterns, `files.autoClear` (`default: true` only for always-safe files) - each verified against a real server and mentioned in the PR
- [ ] `docs` has at least one working link; official and unofficial are labelled correctly
- [ ] No binaries, secrets or unnecessary `plugin.js`

## Project layout (for code contributions)
```
plugins/<id>/          game plugins: plugin.json, icon.png, README.md, [plugin.js], [templates/], [screenshots/]
plugins/_template/     copy this to start a new plugin
plugins/plugin.schema.json   JSON Schema for plugin.json (editor auto-complete)
plugins/registry.json  generated list of all plugins (npm run registry) - commit it with plugin changes
assets/                logo.svg, logo-wordmark.svg, icon.svg (hand-written) and the generated icon.png / icon-16.png / icon-32.png
build/icon.ico         generated Windows icon (electron-builder reads it; npm run icons)
src/main/              Electron main process
  main.js              window, tray, services, mounts api.js on ipcMain, forwards push events
  api.js               the IPC/API table (name -> function); reference: docs/TECH-api.md
  preload.js           exposes window.wgsm.call / on to the renderer
  serverManager.js     servers: install, start / stop, update, query, scheduler, events bus (mgr.events)
  plugins.js           plugin loader, validation, argument templates, toGame()
  installRunner.js, steamcmd.js, logTail.js, query.js   install steps, SteamCMD, live log tailing, A2S / UT3 / FiveM queries
  settings.js          app + per-server settings (sanitised on read and write)
  metrics.js           system + per-server metrics, plugin metrics, tick / latency
  configEdit.js        structured config parse / edit (pure functions)
  rcon.js              Source / Minecraft RCON client (queued, loopback only)
  crash.js             crash-restart policy
  services/            event-driven services, constructed in main.js, subscribe to mgr.events:
                       eventLog.js (NGSM log), discord.js (webhook alerts), discordBot.js (discord.js wiring) +
                       discordCommands.js (pure command handlers, tested with fake interactions),
                       backup.js + zip.js (streaming zip64), cluster.js + clusterMerge.js, autoClear.js, consoles.js
src/renderer/          UI (plain JS / CSS, no framework, no inline scripts):
  index.html, styles.css, theme-boot.js (theme + layout before first paint)
  app.js (servers, detail tabs, games browser, settings), dashboard.js (table + metrics + views), shell.js (nav, panels, footer),
  tick.js (shared tick helpers, also required by the main process), links.js (footer URLs - placeholders),
  discordView.js, logsView.js, backupsView.js, clustersView.js, configsView.js, autoClearView.js, consolesView.js
scripts/               validate-plugins.js, build-registry.js, build-catalog.js (plugin catalog), build-site.js, build-icons.js (logo -> PNG / ICO)
website/               the website + its community backend (npm run site, npm run site:serve; see website/README.md)
docs/                  user guides (GUIDE-*), technical docs (TECH-*), OPEN-QUESTIONS.md, TESTING-CHECKLIST.md - index in docs/README.md
test/smoke.js          npm test (also runs the plugin validation)
```
**Optional plugin info.** Besides the required fields a plugin can declare (all optional, all validated, details and a complete example in [PLUGINS.md](PLUGINS.md)):
- `events` + `logging.patterns` - game events in the Logs screen and Discord, e.g. "player joined" ([docs/GUIDE-logging.md](docs/GUIDE-logging.md), [docs/GUIDE-discord.md](docs/GUIDE-discord.md)).
- `backup.presets` (saves, configs, mods) and `backup.exclude` (logs, temp files) for neat-pick backups ([docs/GUIDE-backups.md](docs/GUIDE-backups.md)).
- `cluster.preserve` (saves and per-server data a cluster update must not overwrite), `cluster.clearFolders`, `cluster.protectedConfigKeys` and `configs[].protect` (ports, passwords) ([docs/GUIDE-clusters.md](docs/GUIDE-clusters.md)).
- `consoles` (an `rcon:<port>:<password>` console, log tails) and `files.autoClear` (only always-safe-to-delete files may be `default: true`) ([docs/GUIDE-configs-files.md](docs/GUIDE-configs-files.md)).
- `metrics` with `"kind": "tick"` (TPS / tick rate / FPS from the console, a log or an RCON command) ([docs/GUIDE-metrics.md](docs/GUIDE-metrics.md)).
- `update.validateArgs` (what the Validate button passes to the installer).
Only declare what you verified against a real server; say what you tested in the PR. Paths must be relative and regexes must compile.

**App-code changes:** run `npm test`, and update [FEATURES.md](FEATURES.md) (changelog + tables), the README, PLUGINS.md and the affected docs in [docs/](docs/README.md) in the same PR. IPC changes: add the channel to [docs/TECH-api.md](docs/TECH-api.md) (a test fails when a channel is missing there). Logo / icons: edit the SVGs in `assets/` and the matching geometry in `scripts/build-icons.js`, run `npm run icons` and commit the generated files.
