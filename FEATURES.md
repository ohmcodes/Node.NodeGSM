# NodeGSM - Features

Single source of truth for what NodeGSM can do. Updated with every change (see [Changelog](#changelog)).
Status: ✅ done · 🧪 done but not tested against a real server · ⏳ planned

## Server management
| Feature | Status | Notes |
|---|---|---|
| Game catalog (45 built-in games ported from WindowsGSM) | ✅ | Source, GoldSource, Unreal, Unity, Minecraft, FiveM, etc. See `src/main/games.js` |
| One-click install via SteamCMD | ✅ | SteamCMD auto-downloaded and self-updated on first use |
| Install progress (percent + GB) | ✅ | Shown in sidebar and header; console logs 1 line per 1% |
| Strict install check | ✅ | Install fails if SteamCMD exit code != 0 or the server exe is missing |
| Custom installers: Minecraft Java, Vintage Story, FiveM | 🧪 | FiveM extraction uses Windows `tar` (7z) |
| Minecraft Bedrock auto-install | ⏳ | Import an existing install for now |
| Import existing server folder | ✅ | Points at the folder, no copy; delete never removes imported files |
| Multiple servers, per-server config | ✅ | Stored in `servers/<id>/configs/wgsm.json` |
| Automatic free-port suggestion | ✅ | Respects plugin `portIncrement` |
| Start / Stop / Restart | ✅ | Stop = stdin command, then `taskkill`, then force kill after 15 s |
| Live console + command input | ✅ | Not for Source/GoldSource (stdin breaks srcds, same as original) |
| Auto restart on crash | ✅ | |
| Auto start with app | ✅ | |
| Update check + manual update | ✅ | SteamCMD build id compare |
| Auto update (every 30 min) | ✅ | |
| Update on start / Backup on start | ✅ | |
| Restart crontab | ✅ | Standard 5-field cron |
| Backup / restore (zip) | ✅ | |
| CPU priority and affinity | ✅ | |
| Server query (A2S, UT3, FiveM) | ✅ | Player count, Starting vs Started |
| Firewall helper (netsh) | 🧪 | Needs Administrator |
| File browser + text config editor | ✅ | 2 MB limit, path-traversal protected |
| Discord webhook alerts | ✅ | Start, crash, auto restart, auto update, crontab |
| Discord bot remote control | ⏳ | |
| Mod manager | ⏳ | |
| Cloud/remote access, multi-machine | ⏳ | |

## App
| Feature | Status | Notes |
|---|---|---|
| Electron UI (dark theme) | ✅ | |
| Start on Windows login, minimize to tray | ✅ | |
| System metrics in header | ✅ | |
| Windows installer + portable exe (electron-builder) | ✅ | `npm run dist`; unsigned, default icon |
| Legacy data folder kept after rename | ✅ | `%APPDATA%\node-wgsm2026\WGSM` if present, else `%APPDATA%\NodeGSM` |

## Plugins
| Feature | Status | Notes |
|---|---|---|
| Declarative `plugin.json` plugins | ✅ | Add games without an app update. Guide: [PLUGINS.md](PLUGINS.md) |
| Optional `plugin.js` hooks (`args`, `install`, `latest`, `local`) | ✅ | Full Node access - trusted plugins only |
| Install from ZIP / folder, Reload, Open folder | ✅ | Plugins dialog |
| Plugin validation with visible errors | ✅ | |
| Plugin icons | ✅ | `icon.png` in plugin folder |
| Examples | ✅ | `examples/palworld`, `examples/_template` |
| Converter for WindowsGSM C# plugins | ⏳ | |
| Plugin browser / online repository | ⏳ | |

## Changelog
Newest first. Add an entry for every change.

### 2026-11-24
- **Renamed to NodeGSM.** User-visible names changed; internal names (`wgsm.json`, `.wgsm-version`) kept. Legacy data folder still used if it exists. Firewall rules are now named `NodeGSM #...`.
- **Install progress and honest results.** Percent/GB progress; install fails if the download did not complete or the exe is missing; SteamCMD self-updates on first run (previously exit code 7 was wrongly treated as success).
- **Plugin system** (`plugin.json` + optional `plugin.js`), Plugins dialog, Palworld example, [PLUGINS.md](PLUGINS.md).
- **Windows exe builds** via electron-builder (installer + portable).
- **Initial Electron port** of WindowsGSM: catalog, SteamCMD, server manager, query, UI, smoke test.
