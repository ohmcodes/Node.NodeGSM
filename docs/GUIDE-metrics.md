# Metrics, server tick and latency

## What you see
Every server has CPU, memory, threads, uptime, PID, players and map. Games can add more (FPS, TPS, entities ...). Pick the columns in **Settings > Server table columns** (also on the Table toolbar and the System Metrics view).

### Server tick
The **tick** is how fast the game loop runs: **TPS** (Minecraft, target 20), **tick rate / FPS** (Source games, Rust) or **milliseconds per tick** (lower is better). It shows up in:
- the **Tick** column of the Table and System Metrics tables (and the game's own metric column, for example *Server TPS*);
- the **Tick** stat of the header info bar (Settings > Header info bar > Tick): the *worst* value of the running servers that have one, the server names in the tooltip; `n/a` when no running server reports a tick;
- the **Server tick** tile and the **Tick** option of the history chart on System Metrics;
- the **Tick** row of the details panel.

Values are green when healthy, yellow when below / above the warning threshold and red when bad. Without thresholds the plugin's `tickTarget` is used (higher is better: yellow below 90 %, red below 75 % of the target; lower is better: yellow above the target, red above twice the target).

### Latency (built-in fallback)
A game without a tick metric still gets **Latency** (ms): how long its query port takes to answer (A2S, Minecraft query, FiveM). It is measured every 15 s while the server runs and needs a game with a query protocol. It is labelled *Latency*, never *Tick*: it shows how responsive the server's main loop is, not the game's tick rate, and it does not feed the header Tick stat (a column and the *Latency* chart option only).

## How the tick is obtained per game
NodeGSM cannot read a tick rate by itself; the plugin tells it which command prints it.

| Game | Source | Notes |
|---|---|---|
| Minecraft: Java, Paper / Spigot / Purpur | RCON `tps` (metric `tps`) | First number = last minute. Colour codes (`§a`) are stripped. |
| Minecraft: Java, vanilla 1.20.3+ | RCON `tick query` (metric `mspt`, ms, lower is better) | "Average time per tick" - 50 ms equals 20 TPS. Older vanilla has no tick command: use Paper, or a mod / Spark. |
| CS:GO (and other Source games) | RCON `stats` (metric `fps`) | The FPS column of the first numeric row. Needs `rcon_password` in `server.cfg`. |
| Rust | console `fps` (metric `fps`) | Prints something like `60 FPS`; the console must be reachable. |

For Minecraft turn RCON on in `server.properties` (`enable-rcon=true`, `rcon.password=...`, `rcon.port=25575`) and restart the server. For Source games set `rcon_password` in `cfg/server.cfg` and restart. NodeGSM only ever connects to `127.0.0.1` and never writes the password to a log; a failing poll just shows no value (check the **RCON** console tab for the reason).

## For plugin authors
Add a metric with `"kind": "tick"` to `metrics[]` in `plugin.json` (full field list in [PLUGINS.md](../PLUGINS.md)):
```json
{ "id": "fps", "name": "Server FPS", "unit": "fps", "kind": "tick",
  "source": "console", "command": "fps", "pattern": "([0-9.]+) FPS",
  "intervalSec": 15, "tickTarget": 30, "warnBelow": 25, "badBelow": 15 }
```
1. **Find out what the game prints.** Run the command in the game console / RCON and copy the output.
2. **Choose the source.**
   - `console` + `command`: written to the server's stdin every `intervalSec` (min 2). Needs `run.stdin` (not srcds / hlds).
   - `log:<id>`: a declared log that the game fills by itself (add `command` to provoke it).
   - `rcon:<command>`: sent through RCON; uses the first `consoles[]` entry of type `rcon` (or `rconConsole` / an inline `rconSource`). Nothing is written to the Console tab or the NGSM log.
3. **Write a pattern with exactly one capture group** around the number. It is matched case-insensitively (`patternFlags` changes that) against each line of the reply; the first / newest match wins. The captured text may contain colour codes, ANSI escapes, a `*` marker, thousands separators, a decimal comma or units - the first number is used.
4. **Set the colours**: `tickTarget` alone is enough (20 for TPS, 64 for tick rate, 50 for ms per tick with `"higherIsBetter": false`), or give `warnBelow` / `badBelow` (higher is better) / `warnAbove` / `badAbove` (times).
5. Run `npm run validate <id>` in the Catalogue repository. Only ship patterns you have verified on a real server.

Metric ids are global across games in the column list (`m:<id>`): use a distinct id (`tps`, `mspt`, `fps`) and the same meaning everywhere. Several tick metrics per game are fine; the first one with a fresh value is the *Tick* of that server.

## Not covered
- Games with no console or RCON (stdin-less servers without RCON, logs-only servers) only get Latency. Mod based sources (Spark, Oxide / uMod plugins writing a stats file) can be added with a `log:` source - see [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md).
- Rust's WebSocket RCON and BattlEye-style RCON are not supported by the RCON client.
