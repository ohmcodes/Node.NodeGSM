# NodeGSM - architecture (work in progress)

This document grows with each release. It describes what exists today.

## Process layout
- `src/main/main.js` - Electron main process: creates the window/tray, builds the services, mounts the API table on `ipcMain`.
- `src/main/api.js` - **transport-agnostic API table** `{ name: fn }` (`buildApi(ctx)`). Functions return data or throw; the transport wraps the result as `{ ok, data }` / `{ ok: false, error }`. A future HTTP/WebSocket server mounts the same table.
- `src/main/preload.js` - exposes `window.wgsm.call(name, ...args)` / `on(channel, cb)`.
- `src/renderer/` - plain JS/HTML/CSS, no framework, no inline scripts (CSP).

## Event bus
`ServerManager` owns `mgr.events` (an `EventEmitter`). `mgr.emitEvent(type, id, detail)` emits `{ id, name, game, ts, detail }` and never throws into the caller.

| Event | detail |
|---|---|
| `server:started` | `{ pid }` |
| `server:stopped` | `{ code }` |
| `server:crashed` | `{ code }` - process ended while not stopping |
| `server:restarted` | `{ reason: manual, crash or cron }` |
| `server:updated` | `{ validate, auto?, from?, to? }` |
| `server:backup`, `server:restore` | `{ file }` |
| `server:command` | `{ command, silent }` |
| `server:config` | `{ config, path }` |
| `plugins:reloaded` | - |
| `ngsm:log` | the entry written by the event log (payload is the entry itself) |

`mgr` itself emits UI events (`status`, `console`, `removed`, `logLines`) that `main.js` forwards to the renderer.

## Services (`src/main/services/`)
Each service is a class `new S(mgr, plugins, settings, dataDir)` with `start()` / `stop()`; they read `mgr.settings` at use time (the settings object is replaced on save).

| Service | State |
|---|---|
| `eventLog.js` | **done** - subscribes to `server:*` and console lines, writes JSONL, query / export / clear / retention |
| `discord.js` | **done** - webhook alerts: templates, toggles, queue, 429 handling |
| `discordBot.js`, `backup.js`, `cluster.js`, `autoClear.js` | skeletons |

### Event log (`eventLog.js`)
- `log({ level, event, serverId, serverName, message, detail })` - fills `ts`, validates `level` (`info|warn|error`), caps message (1000 chars) and detail (4000 chars), appends to today's file and emits `ngsm:log`. Never throws.
- `query({ serverId, level, event, text, since, limit })` newest first; `export({ format })`; `clear()`; `prune()`.
- Console patterns: per game compiled from `logging.patterns`; cache cleared on `plugins:reloaded`; cool-down 10 s per `(server, pattern)`.
- Constructor takes `{ now }` so tests can move the clock.

### Discord (`discord.js`)
- `render(template, vars, now)` - pure; template -> webhook JSON (`allowed_mentions.parse = []`, length caps).
- `targets(event, serverId, detail)` - which webhook URLs get an event: global toggle (`settings.discord.events`, default from the catalog), per-server override (`discordEvents`), legacy per-server flags (`legacyFlag`).
- `enqueue(url, body)` -> `{ ok, status, error? }`; a single queue with `delayMs` between sends; 429 waits `retry_after` (max 30 s), 5xx retried, max 3 retries; unreachable hosts return `{ ok:false, status:0 }`.
- Production accepts only `isDiscordWebhook()` URLs. Tests pass `{ allowAnyUrl: true, agent }` to talk to a local HTTP server.
- `info()` feeds the Discord view; `preview()` and `test()` back the IPC calls.

## Data files (`<data>` = `%APPDATA%\NodeGSM`, or the legacy `%APPDATA%\node-wgsm2026\WGSM`)
| Path | Content |
|---|---|
| `settings.json` | app settings (sanitised on read and write by `settings.js`): theme, `ui`, `headerStats`, `discord{ webhookUrl, events, templates, ...}`, `logging{ retentionDays }` |
| `servers/<id>/configs/wgsm.json` | per-server config incl. `discordWebhook`, `discordAlert`, `discordEvents`, old alert flags |
| `logs/ngsm-YYYY-MM-DD.log` | NGSM event log, JSONL |
| `logs/crash.log`, `logs/crash-history.json` | app crash handling |
| `backups/<id>/*.zip` | backups |

### Log line
```json
{"ts":"2026-11-24T10:15:02.123Z","level":"error","event":"server:crashed","serverId":"2","serverName":"My server","message":"Server stopped suddenly (crash), exit code 1","detail":{"code":1}}
```

## IPC added in this release
`eventLogQuery(filters)`, `eventLogExport(filters)` (text), `eventLogClear()`, `discordInfo()`, `discordTest(kind, template?)`, `discordPreview(template, sampleVars, event)`.
