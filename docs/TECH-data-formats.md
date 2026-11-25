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

## `clusters.json` (placeholder - clusters are not implemented yet)
Planned location `<data>/clusters.json`; the shape below is the plan's draft and may change before release:
```json
{ "clusters": [ { "id": "1", "name": "My cluster", "game": "arkse", "parentId": "1", "memberIds": ["1", "2", "3"], "options": {} } ] }
```
Nothing reads or writes this file yet.
