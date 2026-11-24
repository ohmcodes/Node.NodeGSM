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
- **Plugins can**: download/install other apps and extract them anywhere in the server folder, declare **any number of config files** (INI, JSON, ...) edited in the app, declare **any number of logs** viewed live, and carry a title, description, icon, banner, README and screenshots for the in-app **Games** browser and the website
- Start/stop/restart, live console, auto restart, auto start, auto update, restart crontab
- Backup/restore, Discord webhook alerts, CPU priority/affinity, firewall helper, file editor
- Player counts via A2S/UT3/FiveM queries; start on login and tray support

## Docs
| | |
|---|---|
| [FEATURES.md](FEATURES.md) | full feature list with status, and the changelog |
| [PLUGINS.md](PLUGINS.md) | the `plugin.json` format, install steps, configs, logs, `plugin.js`, converting WindowsGSM plugins |
| [CONTRIBUTING.md](CONTRIBUTING.md) | **how to open a pull request to add or fix a game** |
| [plugins/registry.json](plugins/registry.json) | machine-readable list of all games (for the website) |

## Data location
Servers, backups, user plugins and SteamCMD live in `%APPDATA%\NodeGSM` (override with the `NODEGSM_DATA` env var).
If you ran the app before the rename, the old folder `%APPDATA%\node-wgsm2026\WGSM` is still used.

## Not done yet
Discord bot remote control, mod manager, Steam account login. See [FEATURES.md](FEATURES.md).

## Notes
- The Minecraft installer writes `eula.txt` with `eula=true`; using it means you accept Mojang's EULA.
- Firewall changes require running the app as Administrator.
- Game icons come from the original WindowsGSM repository (MIT).
