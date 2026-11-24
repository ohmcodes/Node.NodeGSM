# Node.WGSM2026

An Electron rewrite of [WindowsGSM](https://github.com/WindowsGSM/WindowsGSM) - manage game servers with a GUI: install, import, start, stop, restart, update and automate multiple servers.

## Run
```
npm install
npm start
npm test      # headless smoke test of the server manager
```
Data (servers, backups, SteamCMD) lives in `%APPDATA%/node-wgsm2026/WGSM` (override with the `WGSM_DATA` env var).

## Feature status (vs. original)
| Feature | Status |
|---|---|
| 45 game catalog ported from the C# source (Source, GoldSource, Unreal, Unity, Minecraft, FiveM, ...) | ✅ |
| One-click install via SteamCMD (auto-downloaded); Minecraft Java, Vintage Story, FiveM custom installers | ✅ |
| Import existing server folder | ✅ |
| Manage multiple servers, per-server config | ✅ |
| Start / Stop / Restart, live console, command input | ✅ (stdin commands not for srcds/hlds, as in original) |
| Auto restart on crash, auto start, update on start, auto update (30 min) | ✅ |
| Restart crontab | ✅ |
| Backup / restore (zip) | ✅ |
| Discord alerts (webhook) | ✅ |
| CPU priority & affinity | ✅ |
| Start on login, minimize to tray | ✅ |
| Server query (A2S, UT3, FiveM) -> player counts / Starting vs Started | ✅ |
| Firewall rule helper (netsh) | ✅ |
| File browser / config editor | ✅ |
| Discord bot remote control, mod manager, Bedrock auto-install, GTA5/FiveM 7z extraction w/o tar | ⏳ not yet |

## Notes
- Minecraft installer writes `eula.txt` with `eula=true`; using it means you accept Mojang's EULA.
- Firewall changes require running the app as Administrator.
- Game icons are copied from the original WindowsGSM repository (MIT).
