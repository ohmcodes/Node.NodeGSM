# Guide - Backups

NodeGSM can back up a server completely (**Full**) or only the parts you care about (**Neat pick**), restore a backup into the same server, or create a **new server** from a backup.

## Where backups are
`<data>\backups\<server id>\backup-<date>.zip` plus a small `backup-<date>.json` next to it (the *manifest*: mode, game, server name, size, file count, what was included - format in [TECH-data-formats.md](TECH-data-formats.md)). The zip is a normal zip file; you can open it with any tool. Backups of a server you delete are kept in `<id>.deleted-<time>` and stay in the list marked **deleted server**.

Old backups made by earlier NodeGSM versions have no manifest. They are listed as **Full** and restore as before.

## Make a backup
Open a server, tab **Backups**.

* **Full** - the whole server folder. Anything the game plugin lists in `backup.exclude` (logs, temp files ...) and your own exclude patterns are left out.
* **Neat pick** - only what you choose:
  * **Presets** from the game plugin (for example Minecraft: *World saves*, *Settings and player lists*, *Plugins and mods*).
  * **Folders and files** - a tick-box tree of the server folder. Tick a folder to take everything in it.
  * Missing paths are reported and skipped. A neat-pick backup needs at least one preset, folder or file (or the server settings).
* **Exclude patterns** (one per line): `*.log` matches any file or folder with that name anywhere; `Saved/Logs` (contains `/`) is read from the server folder; `*` / `**` / `?` are wildcards. Case does not matter.
* **Include server settings** - also stores NodeGSM's `wgsm.json` for this server (name, ports, parameters, Discord webhook ...). On by default for Full, off for Neat pick. The file is stored inside the zip; keep backups private if you use a webhook.
* **Estimate size** shows the file count and the size before compression.
* **Keep the newest N backups** - retention per server. Older ones (and their manifests) are deleted after each new backup. 0 keeps everything.

Backups are written as a stream, so they do not need to fit in memory. Files that are locked by the running server are skipped and counted (`skipped` in the manifest and a warning in the Logs screen). Symbolic links and junctions are never followed. **Stop the server first** if you need a perfectly consistent save.

The Table view's **Backup** button and *Backup on start* make a Full backup.

## Scheduled backups

Backups tab > **Scheduled backup**: tick **Back up automatically**, choose how often (every day at 04:00, every 6 / 12 hours, hourly, every Sunday, or **Custom (cron)** with five fields: minute hour day-of-month month day-of-week) and press **Save schedule**.
- The schedule uses the options set on the same tab when you press Save schedule: **Full**, or **Neat pick** with its presets / folders / exclude patterns and the "Include server settings" tick. Change the options, press Save schedule again.
- Times are in this computer's local time. The tab shows the next run.
- It runs whether the server is running or stopped. If the server is busy (updating, installing, another backup) that run is skipped and noted in the server console.
- A run that was due while NodeGSM was not running is **not** made up.
- **Keep the newest N backups** applies to scheduled backups too; set it, otherwise the disk fills up.
- Each backup shows up in the Logs screen as `server:backup`. Failures are written to the server console ("Scheduled backup failed: ...").

## Restore
* **Restore** (into the same server): the server is stopped, then the files from the zip are written over the current ones. Files that are not in the backup stay. Full restores everything; Neat pick only touches the backed-up files and **needs the game to be installed** ("install the game first, then restore"). If the backup holds server settings you are asked whether to restore them too (default: keep the current ones).
* **Restore as new server**: creates a new server (new id) from the backup's game and name (you can rename it).
  * Full: the files are extracted into the new server.
  * Neat pick: the game is installed first (internet needed), then the backed-up files are applied over it.
  * If the backup has server settings and you leave the box ticked they are applied; a port that is already used by another server moves to the next free one (the message tells you).
  * The game plugin must be installed ("plugin for ... is not installed" otherwise). Old backups without a manifest ask you for the game.

Every backup file is checked before anything is written: names with `..`, absolute paths, drive letters or links that leave the server folder make the restore fail without touching your files.

## Backups screen (Home > Backups)
All backups of all servers: server, date, size, mode, contents, with filters (server, deleted servers, mode, text) and the actions **Restore**, **Restore as new server**, **Open folder**, **Delete**. Restore is disabled for deleted servers (use *Restore as new server*).

## Events
`server:backup` and `server:restore` are written to the NGSM log ([GUIDE-logging.md](GUIDE-logging.md)) and can be sent to Discord ([GUIDE-discord.md](GUIDE-discord.md)); retention writes `backup:pruned`, skipped files `backup:skipped`, errors `backup:failed` / `backup:restore-failed`.

## For plugin authors
Add `backup.presets` and `backup.exclude` to `plugin.json` - see [PLUGINS.md](../PLUGINS.md). Bundled examples: `mc`, `csgo`, `rust`, `palworld`, `arkse`.
