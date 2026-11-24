# NodeGSM - Features

Single source of truth for what NodeGSM can do. Updated with every change (see [Changelog](#changelog)).
Status: ✅ done · 🧪 done but not tested against a real server · ⏳ planned

## Plugins (every game is a plugin)
| Feature | Status | Notes |
|---|---|---|
| All 46 games are plugins in `plugins/<id>/` | ✅ | Edit/fix a game with a pull request - [CONTRIBUTING.md](CONTRIBUTING.md) |
| Declarative `plugin.json` + JSON Schema (`plugins/plugin.schema.json`) | ✅ | Editor auto-complete; format reference in [PLUGINS.md](PLUGINS.md) |
| Listing metadata: title, description, author, version, tags, url, icon, banner, README, screenshots | ✅ | Shown in the in-app **Games** browser and the website |
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
| Converter for WindowsGSM C# plugins | ⏳ | Manual mapping table in PLUGINS.md for now |
| Online plugin repository / one-click install from the website | ⏳ | |

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

## App
| Feature | Status | Notes |
|---|---|---|
| Electron UI (dark theme) | ✅ | |
| Start on Windows login, minimize to tray | ✅ | |
| System metrics in header | ✅ | |
| Windows installer + portable exe (electron-builder) | ✅ | `npm run dist`; unsigned, default icon; bundles `plugins/` |
| External links open in the default browser; in-app navigation blocked | ✅ | |
| Legacy data folder kept after rename | ✅ | `%APPDATA%\node-wgsm2026\WGSM` if present, else `%APPDATA%\NodeGSM` |

## Changelog
Newest first. Add an entry for every change.

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
