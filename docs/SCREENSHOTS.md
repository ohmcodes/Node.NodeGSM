# NodeGSM - screenshots

Real screenshots of the app (dark theme, 1440 x 900) with demo servers. They are used by the [README](../README.md), the changelog in [FEATURES.md](../FEATURES.md) and the **landing page of the website** (the Website repository keeps its own copies in `public/assets/screens/`, see below).

| | |
|---|---|
| ![Server list with live console](screenshots/01-server-list.png) | ![System metrics](screenshots/12-system-metrics.png) |
| **Home > List** - server list, details, live console, quick settings | **System Metrics** - CPU, memory, disk, players, history chart |
| ![Table view](screenshots/07-server-table.png) | ![Backups of all servers](screenshots/10-backups.png) |
| **Home > Table** - WindowsGSM-style table with multi-select and bulk actions | **Home > Backups** - every backup of every server, restore, restore as new server |

## Servers
| Screenshot | What it shows |
|---|---|
| ![](screenshots/01-server-list.png) | **List**: servers on the left, the selected server's console in the middle, details on the right, quick settings below |
| ![](screenshots/02-server-settings.png) | **Settings** tab of a server: ports, map, players, start parameters, CPU priority, firewall |
| ![](screenshots/03-server-automation.png) | **Automation** tab: auto start / restart / update, restart crontab, Discord alerts and per-event overrides |
| ![](screenshots/04-server-backups.png) | **Backups** tab: Full or Neat pick, exclude patterns, retention, **scheduled backups** (cron presets), the backups of this server |
| ![](screenshots/05-server-files.png) | **Files** tab: browse and edit the server files |
| ![](screenshots/06-server-config-files.png) | **Config Files** tab: the plugin's config files in the Structured (key / value) editor |
| ![](screenshots/07-server-table.png) | **Table** view with columns you choose and bulk Start / Stop / Restart / Kill / Update / Backup |

## Home screens
| Screenshot | What it shows |
|---|---|
| ![](screenshots/08-configs.png) | **Configs**: pick any server, edit its config files Structured or Raw |
| ![](screenshots/09-logs.png) | **Logs**: the NodeGSM event log with filters, export and clear |
| ![](screenshots/10-backups.png) | **Backups**: all backups of all servers |
| ![](screenshots/11-clusters.png) | **Clusters**: group same-game servers to update, sync configs and clear folders together |
| ![](screenshots/12-system-metrics.png) | **System Metrics**: the dashboard with the history chart and the server table |

## Games, settings, Discord and the web
| Screenshot | What it shows |
|---|---|
| ![](screenshots/13-games-plugins.png) | **Games / Plugins**: every game is a plugin; README, documentation links, defaults, configs and logs of the selected game |
| ![](screenshots/14-add-server.png) | **Add Server**: install a new server or import an existing folder |
| ![](screenshots/15-settings-appearance.png) | **Settings**: theme, accent colour, animation, header info bar |
| ![](screenshots/16-settings-web-access.png) | **Settings > Web access** (accounts and sessions; the desktop app also shows the enable switch, port, HTTPS and two-factor policy) |
| ![](screenshots/17-discord-webhook.png) | **Discord**: webhook alerts with per-event toggles |
| ![](screenshots/18-discord-embed-editor.png) | **Discord**: embed editor with live preview |
| ![](screenshots/19-discord-bot.png) | **Discord**: the slash-command bot and its per-user, per-server permissions |
| ![](screenshots/20-web-setup.png) | **Web mode, first start**: create the owner account (the access token is needed once) |
| ![](screenshots/21-web-login.png) | **Web mode sign-in** (a second step asks for the authenticator code when two-factor is on) |
| ![](screenshots/22-web-account.png) | **My account**: change password, set up two-factor authentication, sign out other sessions |

## Regenerating them
The images are produced from the real renderer, not mocked up. They contain only demo data (demo servers named after popular games, fake console lines, a stand-in process instead of a real game server). Nothing is read from your own data folder.

1. Start a web server on a **throw-away data folder** (loopback, no authentication):
   ```
   node src/server/headless.js --no-auth --port 8742 --data %TEMP%\nodegsm-shots
   ```
2. Fill it with demo servers, backups, a cluster and log lines (refuses non-loopback addresses):
   ```
   node scripts/seed-demo.js http://127.0.0.1:8742 %TEMP%\nodegsm-shots
   ```
3. Optional, to get *Started* servers and a live console: put any small program that prints lines and ignores its arguments at the executable path of a few of the demo servers (for example `valheim_server.exe` in `servers\4\serverfiles`) and press **Start**. Stopped servers work too, they just look quieter.
4. Optional, for the three sign-in screens: a second server **with** authentication on another throw-away folder (`node src/server/headless.js --port 8743 --data <folder2>`) and `SHOT_AUTH=8743 SHOT_AUTH_DATA=<folder2>` when running step 5.
5. Capture (Electron, hidden window; pass the **port number**, not a URL):
   ```
   npx electron scripts/screenshots.js 8742 docs/screenshots dark
   ```
   `SHOT_SERVER=4` picks the server shown in the first screenshot. The result is `docs/screenshots/NN-name.png`.
6. Stop the servers you started, and delete the throw-away folders.

### Using them on the website
The website's landing page shows the same images. After regenerating, copy `docs/screenshots/*.png` to `public/assets/screens/` in the Website repository (`Node.NodeGSM.Website`) and commit there; the landing page and the Features page read that folder.
