# Palworld Dedicated Server

Palworld Dedicated Server

## Install
Installed with SteamCMD, app id [2394010](https://steamdb.info/app/2394010/info/).

## Defaults
| | |
|---|---|
| Game port | 8211 |
| Query port | 8212 |
| Max players | 32 |
| Query protocol | none |

## Config files
- **PalWorldSettings.ini** (`Pal/Saved/Config/WindowsServer/PalWorldSettings.ini`, ini) - World/gameplay options. Copy the OptionSettings line from DefaultPalWorldSettings.ini in the server root.

## Logs
- **Server logs** (`Pal/Saved/Logs/*.log`)

## Notes
Game port is also used as the public port. The query port is reserved for the REST API (Palworld has no A2S query).

## Contributing
Found something outdated (exe path, ports, arguments)? Edit `plugin.json` and open a pull request - see [CONTRIBUTING.md](../../CONTRIBUTING.md).
