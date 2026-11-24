# Counter-Strike: Global Offensive Dedicated Server

Dedicated server support for Counter-Strike: Global Offensive. Install, run, configure and monitor it from NodeGSM.

## Install
Installed with SteamCMD, app id [740](https://steamdb.info/app/740/info/).

## Defaults
| | |
|---|---|
| Game port | 27015 |
| Query port | 27015 |
| Max players | 24 |
| Query protocol | a2s |

## Config files
- **server.cfg** (`csgo/cfg/server.cfg`, cfg) - Main server config (hostname, rcon_password, ...)

## Logs
- **Server logs** (`csgo/logs/*.log`)

## Notes
Requires a Game Server Login Token (GSLT) to be listed publicly.

## Contributing
Found something outdated (exe path, ports, arguments)? Edit `plugin.json` and open a pull request - see [CONTRIBUTING.md](../../CONTRIBUTING.md).
