# NodeGSM - the app layout

## Navigation (left)
- **Home** - expands to **List** (server list + details with tabs), **Table** (WindowsGSM-style table with multi-select and bulk actions: Start, Stop, Restart, Kill, Update, Validate, Backup) **Configs** (edit the config files of a server, see [GUIDE-configs-files.md](GUIDE-configs-files.md)) **Logs** (the NodeGSM event log, see [GUIDE-logging.md](GUIDE-logging.md)) **Backups** (all backups of all servers, see [GUIDE-backups.md](GUIDE-backups.md)) and **Clusters** (group same-game servers: update, config sync, clear folders - see [GUIDE-clusters.md](GUIDE-clusters.md)).
- **System Metrics** - the dashboard (system CPU / memory / disk, server counts, history chart).
- **Games / Plugins** - the game browser: search, README, install plugins from ZIP or folder, **Add server**.
- **Settings** - theme, accent, animation, header info bar, table columns, startup and performance.
- **Discord** - webhook alerts, per-event toggles and the embed editor, see [GUIDE-discord.md](GUIDE-discord.md). The **Bot** section sets up the slash-command bot.

The button at the top left (hamburger) shrinks the navigation to an icon rail.

## Panels
Three buttons in the header toggle the panels. Everything you collapse is remembered and applied before the window paints, so there is no flash on start. Collapse them all to give the main area the whole window.
- **Server list** (left, List view only).
- **Details** (right): status, PID, game, address, players, map, uptime, CPU, memory for the selected server.
- **Quick settings** (bottom): name, port, map, max players and start parameters with **Save**, next to the status details. Changes apply on the next start. Your unsaved edits are not overwritten while the server status updates. The right and bottom panels also appear in the Table and System Metrics views, following the last selected server.

## Header info bar
Settings > **Header info bar**: pick any of CPU, RAM, Disk, Servers (running/total), Players, Tick. Tick shows the worst tick metric (TPS, tick rate, FPS or ms per tick, coloured) of the running servers whose game declares one; hover it for the server names. It shows `n/a` when no running server reports one - see [GUIDE-metrics.md](GUIDE-metrics.md).

## Footer
**Website**, **Discord** and **Donate** (Patreon, PayPal, Buy Me a Coffee) open in your default browser. The addresses are PLACEHOLDERS in `src/renderer/links.js` - replace each `...-replace-me` URL.
