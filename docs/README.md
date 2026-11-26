# NodeGSM documentation

<p align="center"><img src="../assets/logo-wordmark.svg" alt="NodeGSM" height="64"></p>

Start with the project [README](../README.md). This folder holds the user guides, the technical references for contributors, and the open decisions / manual test list for the project owner.

## User guides
| Guide | What it covers |
|---|---|
| [GUIDE-ui.md](GUIDE-ui.md) | App layout: left navigation, collapsible panels, header info bar, footer links |
| [SCREENSHOTS.md](SCREENSHOTS.md) | Screenshot gallery (README, website landing page) and how to regenerate it; the images are in [screenshots/](screenshots) |
| [GUIDE-configs-files.md](GUIDE-configs-files.md) | Configs editor (Structured / Raw), Files auto-clear, injected consoles (RCON / log), Update vs Validate |
| [GUIDE-metrics.md](GUIDE-metrics.md) | Table / dashboard metrics, the server tick (TPS / tick rate), Latency, how plugin authors add a tick metric |
| [GUIDE-backups.md](GUIDE-backups.md) | Full and neat-pick backups, retention, restore, restore as new server, the Backups screen |
| [GUIDE-clusters.md](GUIDE-clusters.md) | Clusters: create, update, config sync (protected keys, `NGSM:ignore`), clear folders |
| [GUIDE-logging.md](GUIDE-logging.md) | The NGSM event log: location, format, retention, plugin patterns, the Logs screen |
| [GUIDE-discord.md](GUIDE-discord.md) | Webhook alerts, the embed editor, per-server overrides, the slash-command bot |
| [GUIDE-web-linux.md](GUIDE-web-linux.md) | Web mode (headless server) and Linux: install, systemd, Docker, nginx + TLS, first login, hardening checklist, limits of web mode, per-game Linux caveats |

## Technical documentation
| Document | What it covers |
|---|---|
| [TECH-architecture.md](TECH-architecture.md) | Process layout, core bootstrap, web mode and auth model, platform layer, event bus, services, data files |
| [TECH-api.md](TECH-api.md) | Every IPC channel (name, arguments, result), every push event, the HTTP / WebSocket protocol of web mode |
| [TECH-data-formats.md](TECH-data-formats.md) | Backup manifest, event log line, `clusters.json`, auto-clear rules, `rcon:` sources |
| [../PLUGINS.md](../PLUGINS.md) | The complete `plugin.json` reference (all fields, one place) with a full example |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | How to add or fix a game by pull request; project layout |
| [../FEATURES.md](../FEATURES.md) | Feature list with status and the changelog |

## For the project owner
| Document | What it is |
|---|---|
| [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md) | Decisions deferred while building, grouped by topic, with a short "needs your input first" list |
| [TESTING-CHECKLIST.md](TESTING-CHECKLIST.md) | Manual checks to run in the real app (things the automated tests cannot cover) |
