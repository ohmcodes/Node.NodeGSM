# Guide - Clusters

A **cluster** groups two or more servers of the **same game** (for example three Minecraft servers, or the maps of an ARK cluster). One of them is the **parent**. With a cluster you can

* **Update** all servers at once (the parent is updated, its game files are copied to the others),
* **Sync config files** from the parent while every server keeps its own port, passwords and name,
* **Clear folders** (old logs, crash dumps ...) on all servers.

Deleting a cluster only removes the grouping. **Servers and their files are never deleted by cluster actions** (clearing only deletes the files that match a rule).

Open **Home > Clusters**. The data is stored in `<data>\clusters.json` ([format](TECH-data-formats.md)).

## Create a cluster
**Create cluster** - pick the game (only games with at least two servers that are not in a cluster yet are offered), tick at least two servers, choose the **parent** and a name. Rules:

* all servers must run the same game,
* the parent must be one of the servers,
* a server can belong to only **one** cluster.

If a server of a cluster is deleted it leaves the cluster. If the parent is deleted, the first remaining server becomes the parent. A cluster that has fewer than two servers left is removed (the remaining server is untouched). **Edit** lets you rename, change the parent and add or remove servers.

## Update
1. *(optional)* **Preview** shows, per member, how many files and bytes would be copied, how many are skipped because they are preserved or identical, and the list of **never overwritten** paths. Nothing is changed.
2. **Run update** - first the parent is updated like a normal update (SteamCMD or the plugin's installer; tick **Validate** for a full file check; untick **Update the parent first** to only distribute what the parent already has). Then, one server after another:
   * a running member is **stopped**, the files are copied, and it is **started again** (only if it was running),
   * a progress bar shows the overall percentage and the current server.
3. A member that fails (for example it is busy, or a file is locked) is reported in the result table, **the other members are still updated**.

### What is never overwritten
* every **config file** the plugin declares (`configs[].path`, and its `.bak`),
* the plugin's **`cluster.preserve`** paths (saves, per-server data) and your own **Never overwritten** paths for the cluster (Edit),
* the server's NodeGSM settings `configs/wgsm.json` (they are outside the game files anyway).

Only files that exist in the parent are copied; files that exist only on a member are left alone. Links (symlinks / junctions) are **never followed**, neither in the parent nor in a member. **Copy only changed files** skips files with the same size and modification time (the copy keeps the parent's time, so the second run is fast).

## Config sync
Pick one or more config files (the list comes from the game plugin) and press **Preview changes**. For every member you see a diff (`-` removed, `+` added) and warnings. **Apply** writes the files; the previous member file is kept as `<name>.bak` (like the config editor). Servers must be restarted to read the new values.

What a member keeps:

* keys listed in the plugin (`configs[].protect` and `cluster.protectedConfigKeys`) and in your cluster rules (Edit > Protected config keys). Patterns are case-insensitive, `*` and `?` work: `port`, `rcon.*`, `Server?Name`. A name without a dot also matches the last part of a longer key (`port` matches `network.port`).
* every **line that contains `NGSM:ignore`**, in any comment style. Put the marker in the parent's file (or in the member's own file) on the line that must stay different:

```ini
; GameUserSettings.ini
ServerPassword=secret          ; NGSM:ignore
SessionName=My Map             ; NGSM:ignore
```
```properties
# server.properties
level-name=world # NGSM:ignore
motd=Welcome # NGSM:ignore
```
```yaml
motd: Hello   # NGSM:ignore
```
```cfg
hostname "My server" // NGSM:ignore
```
```xml
<port>7777</port> <!-- NGSM:ignore -->
```

How each format is merged:

| Format | Merge |
|---|---|
| `ini` | line by line, keys are looked up inside their `[section]`; protected member-only keys are kept in their section |
| `properties` | line by line (`key=value`) |
| `cfg` | line by line (`key value` or `key=value`); repeated keys (`exec a.cfg`) are matched in order |
| `yaml` | line by line (indentation decides the key path, `a.b.c`); protecting a block key protects everything below it. No YAML library is used, so complex YAML (multi-line strings, anchors) is only line-matched |
| `json` | parsed, keys merged by path (`network.port`), written with 2-space indentation (formatting and key order of the parent) |
| `text`, `xml` | the **whole file is replaced** by the parent's copy. Nothing can be protected except lines with `NGSM:ignore`, which are matched by their first word / tag; the preview warns about it |

If a member has **no file yet**, it is created from the parent's. The parent's value is used for protected keys and the preview warns *protected key not present in member*, so check the port and passwords of new members. A broken JSON file on a member is reported and left alone.

Member keys that are protected but missing in the parent are kept (an RCON password is never lost because the parent does not have the key).

## Clear folders
The rules come from the plugin (`cluster.clearFolders`) plus your own (Edit > Clear folders, one rule per line: `path | pattern | older than days`). **Preview** shows files and size per server and rule; **Delete these files** removes them. Details:

* the path must stay inside the server's files folder (no `..`, no absolute path, no links),
* `pattern` matches the **file name** (`*`, `?`), default `*`; `older than` uses the modified time,
* only files directly in the folder are deleted (plugin rules with `"recursive": true` also look in sub-folders); **folders are never deleted**,
* locked files (a running server may hold its log open) are skipped and counted,
* the result is written to the NGSM log.

## Log and events
Every step is written to the Logs screen: `cluster:created`, `cluster:update-started`, `cluster:update-member`, `cluster:update-member-failed`, `cluster:update-finished`, `cluster:update-failed`, `cluster:config-sync`, `cluster:clear`, `cluster:member-removed`, `cluster:dissolved`.

## Tips
* Make a **backup** before the first cluster update on a real server (Home > Backups).
* Keep per-server saves out of the update: they must be listed in the plugin's `cluster.preserve` (or in the cluster's own rules). Plugins ship these for Minecraft, ARK: Survival Evolved and Rust; for other games add your own paths first (**Edit > Never overwritten**).
* Use **Preview** first, always.
