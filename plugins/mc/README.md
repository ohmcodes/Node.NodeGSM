# Minecraft: Java Edition Server

Dedicated server support for Minecraft: Java Edition. Install, run, configure and monitor it from NodeGSM.

## Install
Downloaded automatically by the plugin (see `plugin.js`).

## Defaults
| | |
|---|---|
| Game port | 25565 |
| Query port | 25565 |
| Max players | 20 |
| Query protocol | ut3 |

## Config files
- **server.properties** (`server.properties`, properties) - Ports, difficulty, MOTD, whitelist, ...
- **ops.json** (`ops.json`, json) - Operators
- **whitelist.json** (`whitelist.json`, json)

## Logs
- **latest.log** (`logs/latest.log`)

## Notes
Needs Java on the PATH. The installer downloads the latest release server.jar from Mojang and writes `eula.txt` with `eula=true` - using it means you accept the [Minecraft EULA](https://aka.ms/MinecraftEULA).

## Contributing
Found something outdated (exe path, ports, arguments)? Edit `plugin.json` and open a pull request - see [CONTRIBUTING.md](../../CONTRIBUTING.md).
