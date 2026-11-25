# NodeGSM - data formats

Files NodeGSM writes under `<data>` (`%APPDATA%\NodeGSM`, or the legacy `%APPDATA%\node-wgsm2026\WGSM`). Internal names (`wgsm.json`, `.wgsm-version`) are stable.

## Backup manifest (`backups/<folder>/backup-<ISO>.json`)
Written next to the zip by `services/backup.js` after the zip is complete. `<folder>` is the server id, or `<id>.deleted-<ms>` for a deleted server. A zip without a manifest is a legacy backup (mode `full`).

```json
{
  "version": 1,
  "mode": "neatpick",
  "game": "mc",
  "serverName": "Survival World",
  "serverId": "1",
  "createdAt": "2026-11-24T18:50:33.120Z",
  "paths": ["world", "world_nether", "world_the_end", "plugins/x.jar"],
  "presets": ["world"],
  "exclude": ["logs", "crash-reports", "*.tmp", "*.mca"],
  "sizeBytes": 1342,
  "uncompressedBytes": 70123,
  "fileCount": 3,
  "gameVersion": null,
  "includesServerSettings": false,
  "skipped": 1,
  "missing": ["world_the_end"]
}
```
| Field | Meaning |
|---|---|
| `version` | manifest format, currently `1`; unknown versions are treated as "no manifest" |
| `mode` | `full` (whole server folder) or `neatpick` |
| `game`, `serverName`, `serverId` | plugin id, name and id of the server when the backup was made (used by *Restore as new server* and the Backups screen) |
| `createdAt` | ISO time |
| `paths` | neat pick: the selected roots (preset paths + chosen folders/files), relative to the server files folder, `/` separators; `[]` for full |
| `presets` | plugin `backup.presets` ids that were ticked |
| `exclude` | the effective exclude patterns (plugin + user) |
| `sizeBytes` / `uncompressedBytes` / `fileCount` | zip size, summed size of the stored files, number of files written |
| `gameVersion` | Steam build id (or plugin `local` hook result) when known, else `null` |
| `includesServerSettings` | the zip holds `__nodegsm/wgsm.json` |
| `skipped`, `missing` | optional: number of files not stored (locked, unreadable, links); neat-pick paths that did not exist |

### Zip layout
Entries are the server files with paths relative to the server folder (`/`, UTF-8, deflate; empty folders as `name/`). The reserved folder `__nodegsm/` holds NodeGSM metadata (`__nodegsm/wgsm.json` = the server's `configs/wgsm.json`); it is never extracted into the server files. The zip is written in a streaming layout (data descriptors) with zip64 records where needed (entries of 2 GB or more, archives past 4 GB, more than 65535 entries).

## NGSM event log line (`logs/ngsm-YYYY-MM-DD.log`, JSONL)
```json
{"ts":"2026-11-24T18:50:33.456Z","level":"info","event":"server:backup","serverId":"1","serverName":"Survival World","message":"Backup created: backup-2026-11-24T18-50-33-120Z.zip (neat pick)","detail":{"file":"backup-2026-11-24T18-50-33-120Z.zip","mode":"neatpick","sizeBytes":1342,"fileCount":3,"skipped":0}}
```
`level` is `info | warn | error`; `message` is capped at 1000 characters and `detail` at 4000. See [GUIDE-logging.md](GUIDE-logging.md).

## `clusters.json`
`<data>/clusters.json`, written atomically by `services/cluster.js`. Servers are referenced by id (the number of `servers/<id>`).
```json
{
  "version": 1,
  "clusters": [
    {
      "id": "1",
      "name": "Minecraft network",
      "game": "mc",
      "parentId": "1",
      "memberIds": ["1", "2", "3"],
      "createdAt": "2026-11-24T18:50:33.120Z",
      "options": {
        "protect": ["motd"],
        "preserve": ["data/keep.dat"],
        "clearFolders": [{ "path": "logs", "pattern": "*.log", "olderThanDays": 7, "recursive": false }],
        "onlyChanged": false
      }
    }
  ]
}
```
| Field | Meaning |
|---|---|
| `id` | cluster id (string, lowest free number) |
| `game` | plugin id; all members have this game |
| `parentId` | a member; it is updated first and is the source of file / config copies |
| `memberIds` | at least 2 servers (including the parent); a server is in at most one cluster |
| `options.protect` | extra protected config key globs (on top of `configs[].protect` and `cluster.protectedConfigKeys`) |
| `options.preserve` | extra relative paths never overwritten by a cluster update |
| `options.clearFolders` | extra clear rules `{ path, pattern, olderThanDays, recursive? }`, added to the plugin's |
| `options.onlyChanged` | default of the "copy only changed files" option |

All paths are relative to the server files folder (`safeRel`: no `..`, drive letters, `:`). A missing or corrupt file starts with no clusters (the corrupt one is kept as `clusters.json.corrupt-<ms>`). Unknown versions are not migrated yet.

## Auto-clear rules (`servers/<id>/configs/wgsm.json`)
```json
"autoClear": [
  { "path": "logs", "pattern": "*.log.gz", "olderThanDays": 14, "intervalMin": 1440, "enabled": true, "recursive": false, "onlyWhenStopped": false, "lastRun": 1795577684830 }
],
"autoClearSeeded": ["logs|*.log.gz", "crash-reports|*.txt"]
```
| Field | Meaning |
|---|---|
| `path` | folder relative to the server files folder; `/` separators, no `..`, no absolute path, drive letter, `:` or NUL (`settings.relFolder`) |
| `pattern` | file-name wildcard (`*` `?`, case-insensitive), no `/` or `\`; default `*` |
| `olderThanDays` | 0 to 3650 (0 = any age); compared with the last-modified time |
| `intervalMin` | 1 to 525600; a rule runs at most once per interval (checked every minute) |
| `enabled`, `recursive`, `onlyWhenStopped` | booleans (default true / false / false) |
| `lastRun` | ms since epoch of the last run (also kept in memory); 0 = never |
| `autoClearSeeded` | `<path lower-case>|<pattern>` keys of plugin rules already copied to this server (so deleted rules stay deleted) |

At most 50 rules. Invalid rules are refused when saving through the app and dropped when read from a hand-edited file.

## Plugin `consoles[]` RCON source
`rcon:<port>:<password>`; `<port>` is 1-5 digits or a `{placeholder}`, `<password>` is everything after the second `:` (literal or a `{placeholder}`). Placeholders: `{port}` `{queryPort}` `{maxPlayers}` `{map}` `{ip}`, `{configId:key}`, `{key}` (first config file with that key). See [PLUGINS.md](../PLUGINS.md).

### Config merge markers
`NGSM:ignore` anywhere in a line of a config file (in the parent's or the member's copy) keeps the member's line during config sync, whatever the comment style: `# NGSM:ignore`, `// NGSM:ignore`, `; NGSM:ignore`, `<!-- NGSM:ignore -->`.
