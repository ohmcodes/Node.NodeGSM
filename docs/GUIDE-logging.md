# NodeGSM - event log

NodeGSM writes an **NGSM event log** of everything that happens to your servers. Open it with **Home > Logs**.

## What is logged
| Event | Level | When |
|---|---|---|
| `server:started` | info | the server process was started |
| `server:stopped` | info | stopped on purpose (Stop, Kill, shutdown) |
| `server:crashed` | error | the process ended without being stopped ("stopped suddenly") |
| `server:restarted` | info | manual, scheduled (crontab) or after a crash; the message says which |
| `server:updated` | info | an update finished (auto updates show the build change) |
| `server:backup` / `server:restore` | info / warn | a backup was created / restored |
| `server:command` | info | a console command you sent (commands NodeGSM sends by itself are skipped) |
| `server:config` | info | you saved a config file in the Config Files tab |
| `pattern:<id>` / `game:<id>` | per pattern | a console line matched a plugin pattern (see below) |
| `log:cleared` | info | the log was cleared |

## The Logs screen
Filters: server, level, event, text. **Auto refresh** polls every 3 seconds. **Export** saves the filtered entries as a text file (oldest first); **Clear** deletes all log files after a confirmation. The newest 500 entries are shown. Hover a row to see its details.

## Files and retention
- Files: `<data folder>\logs\ngsm-YYYY-MM-DD.log`, one per day (local date). `crash.log` (app crashes) is separate and never touched.
- Format: one JSON object per line - `{"ts":"2026-11-24T10:15:02.123Z","level":"error","event":"server:crashed","serverId":"2","serverName":"My server","message":"Server stopped suddenly (crash), exit code 1","detail":{"code":1}}`.
- Retention: files older than `logging.retentionDays` (default **30**) are deleted when NodeGSM starts and then once a day. Change it in `settings.json` (`"logging": { "retentionDays": 14 }`).

## Plugin patterns
Patterns are matched against console lines **and** against the new lines of the files in `logging.logFiles` (checked every 2 seconds while the server runs; history from before the server started is not replayed).

A game plugin can declare `logging.patterns` - regular expressions matched against the server's **console output**. A match creates a log entry (level from the pattern) so, for example, "stopped suddenly" or "player joined" lines appear in the Logs screen. The same pattern is logged at most once per 10 seconds per server so a noisy line cannot flood the log. If a pattern has the same id as one of the plugin's `events`, it is also available as a Discord alert. See [PLUGINS.md](../PLUGINS.md).
