# NodeGSM - Node Game Server Manager

An Electron rewrite of [WindowsGSM](https://github.com/WindowsGSM/WindowsGSM) - manage game servers with a GUI: install, import, start, stop, restart, update and automate multiple servers. Support for more games is added through [plugins](PLUGINS.md), no app update needed.

## Run
```
npm install
npm start
npm test        # headless smoke test of the server manager
```

## Build an exe
```
npm run dist    # installer + portable exe in dist/
npm run pack    # unpacked folder only (faster, for testing)
```
Builds are unsigned and use the default Electron icon. To use a custom icon, enable Windows Developer Mode, add `build/icon.ico` and remove `signAndEditExecutable: false` from `package.json`.

## Data location
Servers, backups, plugins and SteamCMD live in `%APPDATA%\NodeGSM` (override with the `NODEGSM_DATA` env var).
If you ran the app before the rename, the old folder `%APPDATA%\node-wgsm2026\WGSM` is still used.

## Docs
- [FEATURES.md](FEATURES.md) - full feature list with status, and the changelog
- [PLUGINS.md](PLUGINS.md) - how to write a plugin (add a game server)

## Highlights
- 45 built-in games plus plugins; one-click SteamCMD install with progress
- Start/stop/restart, live console, auto restart, auto start, auto update, restart crontab
- Backup/restore, Discord webhook alerts, CPU priority/affinity, firewall helper, file editor
- Player counts via A2S/UT3/FiveM queries; start on login and tray support

Not yet done: Discord bot remote control, mod manager, Bedrock auto-install. See [FEATURES.md](FEATURES.md).

## Notes
- The Minecraft installer writes `eula.txt` with `eula=true`; using it means you accept Mojang's EULA.
- Firewall changes require running the app as Administrator.
- Game icons are copied from the original WindowsGSM repository (MIT).
