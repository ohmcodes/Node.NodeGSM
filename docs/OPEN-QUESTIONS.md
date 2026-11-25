# Open questions

Decisions deferred while implementing, to confirm with the project owner.

## Phase 1 - app shell
- Footer URLs (Website, Discord, Patreon, PayPal, Buy Me a Coffee) are placeholders in `src/renderer/links.js`.
- Panel scope: the server-list panel shows only in the List view; the details and quick-settings panels also show in Table / System Metrics (following `state.sel`). In the Table view a single click does not change that selection (double-click does). Should Table selection drive them?
- Only List / Table / System Metrics are remembered as the start view (`settings.view`); Games, Settings and Discord are not. Should the start view be extendable?
- Tick header stat is a "-" placeholder until Phase 7.
- Quick settings saves `name/port/map/maxPlayers/param` through the existing `save` IPC with no extra validation (same as the Settings tab).

## Phase 2 - logging and Discord
- **Embed reference image still wanted:** no reference image was supplied, so the default embed templates (title + description + 3 inline fields + footer, colours per event) are a neutral first guess. Send an example of the look you want and the defaults in `src/main/services/discord.js` (`DEFAULT_TEMPLATES`) will be adjusted.
- Discord alerts were never sent to a real webhook (tests use a local HTTP server). Please use **Send test** with a throw-away webhook once.
- Behaviour change to confirm: a webhook that is not `https://discord.com|discordapp.com/api/webhooks/...` is now rejected. Existing per-server webhooks of another form (for example proxies) would need to be re-entered / are refused on the next save. Should a "custom URL" escape hatch exist?
- Defaults for event toggles: started, crashed, restarted, updated are ON; stopped, backup, restore are OFF. Manual restarts are not sent to the per-server webhook (same as before) but are sent to the global one. OK?
- Per-server override covers both webhooks; the old per-server flags only apply to the per-server webhook. Is a per-server override for the *global* webhook only needed?
- Plugin `logging.logFiles` (scanning log files, not just the console) is not implemented yet; only console lines are matched.
- Log retention counts days (default 30, UI control not added - setting `logging.retentionDays` in `settings.json`). Add a field in Settings?
- Logs screen shows the newest 500 entries; export takes up to 5000. Enough?
- The renderer CSP now allows `https:` images (for embed thumbnails in the preview). Acceptable?

## Phase 3 - backups
- **Real-world testing:** backups were tested with small fake servers only. A multi-GB server (the zip64 path is covered by a forced-zip64 unit test and was not opened with an external tool), a running server with locked files and a Neat-pick restore-as-new that really downloads the game (SteamCMD) have not been exercised. Please try one on a real server.
- Full restore overlays the zip on the existing files (files that are not in the backup stay). Should there be an option to **clean** the server folder first (exact copy)? It is riskier for imported servers (`installDir`).
- Plugin `backup.exclude` also applies to **Full** backups (logs / temp files are not stored). Is that wanted, or should Full ignore the plugin list and only honour the user's patterns?
- `includeServerSettings` defaults: Full = on, Neat pick = off. The saved `wgsm.json` contains the Discord webhook URL in plain text; should the webhook be stripped from backups?
- In-place restore keeps the current server settings unless the user says yes in a second prompt; restore-as-new applies them by default (ports moved if taken). OK?
- Retention counts every backup of a server (manual, bulk, on start); there is no "manual backups are never pruned" class. Needed?
- Server ids are reused: when a server is deleted its backups move to `<id>.deleted-<ms>`, and a new server that takes the same id starts with an empty list. The old ones show as "deleted server".
- Restore-as-new for a backup whose plugin was removed is refused with a clear message; there is no way to pick a different plugin yet (only old backups without a manifest ask for the game).
- Preset paths shipped for mc / csgo / rust / palworld / arkse are best-effort from the games' usual layouts; Rust's identity folder depends on `+server.identity`, so that preset takes the whole `server` folder.
- No scheduled (cron) backups yet - only manual, bulk, backup-on-start and retention. Add a per-server schedule?
- "Open folder" reveals the zip in Explorer (the desktop app has no browser-style download). A web build will need a real download endpoint.
- Empty directories are stored; NTFS ACLs, file attributes and alternate data streams are not.

## Phase 4 - clusters
- **Real-world testing:** clusters were tested with fake servers (copy, merge, clear, removal cleanup, running-member stop / start by a stub). A real SteamCMD parent update, a real multi-GB copy and locked files of running servers were not exercised. Please try a small real cluster (and back up first).
- Update distribution copies **everything** in the parent's files folder except the preserved paths, so a plugin without `cluster.preserve` (only `mc`, `arkse` and `rust` ship one) would overwrite per-server data that is not a config file. Should clusters refuse to update (or require a confirmation) when the plugin declares no `cluster.preserve`? Currently the preview lists the preserved paths and the guide says to add them.
- Files that exist only on a member are never deleted (the distribution is additive). Should there be a "mirror" option that removes extra files (mods removed from the parent)?
- `cluster.preserve` / `configs[].path` matching is path based; a pattern without `/` that has `*` / `?` matches by name anywhere. `**` is supported. Is that enough or should plugin authors get explicit `exclude` globs?
- Config sync of `text` / `xml` files replaces the whole file (only `NGSM:ignore` lines are kept, matched by their first word or tag). Real XML / structured merge (attributes, nested tags) is not implemented; the preview shows a warning.
- YAML merge is line based (no YAML library): multi-line strings, anchors and flow style (`{a: 1}`) are only matched line by line. JSON files with comments (JSONC) are rejected as invalid.
- Protected keys that exist only in the member are **kept** (appended at the end, or inside the same ini section); a key that exists only in the parent is added. Member-only keys that are not protected are dropped (the parent file wins). OK?
- A new member (no config file yet) receives the parent's protected values (ports, passwords) with a warning, not defaults. Should new members get an automatic port offset?
- `clearFolders` is non-recursive by default (`recursive: true` per rule opts in) and only matches file names; folders are never removed. Locked files are skipped and counted, but a running server's open log is not rotated first.
- Cluster actions refuse to start while another cluster action runs on the same cluster; they do not block normal single-server actions on the members except that a member that is busy (installing, backing up) is reported as failed for that run.
- Progress is byte based over all members; the parent update (SteamCMD) has no percentage inside the cluster bar yet (it shows "Updating the parent ...").
- The UI edits the cluster clear rules as `path | pattern | days` lines (no `recursive` toggle).
- Clusters of different game versions or branches are not supported (same game only); there is no cluster-level schedule yet (for example "update every Tuesday 04:00").
- The NGSM log shows cluster entries per member server id; there is no cluster filter on the Logs screen yet.

## Phase 5 - configs, auto-clear, consoles, validate
- **Real-world testing:** RCON was tested only against a local fake server (Source style, Minecraft style, no end marker). Please try a real Minecraft server (`enable-rcon=true`, `rcon.password` set) and a Source server (`rcon_password` in `server.cfg`) once. Rust / ARK web-socket RCON and BattlEye / Battlefield-style protocols are not supported.
- Source / Minecraft servers only accept RCON after they have read the saved config; if the password changed, the server has to be restarted. The RCON sub-tab reports "authentication failed" in that case, with no hint of the password.
- RCON commands are written to the NGSM log (as `server:command`) like console commands; commands that carry secrets (for example `rcon_password x`) would be logged. Should RCON commands be logged without arguments, or with a deny-list?
- Structured editor: values of `cfg` / `ini` files are shown raw (quotes included); there is no type-aware widget (checkbox for true / false, number spinner). YAML is the simple subset only (nested maps with space indentation); lists, anchors and block scalars are kept but not editable. JSON files with comments are raw only. Multi-line values and duplicate keys are edited line by line. Is a type-aware editor wanted?
- The Configs screen edits one file at a time; there is no "apply to several servers" (use clusters for that).
- Auto-clear: a seeded `default: true` plugin rule is enabled for every server of that game as soon as the app first looks at the server (its first run is one interval later). Should plugin defaults rather start disabled everywhere and be switched on by the user?
- Auto-clear deletes files directly (no recycle bin) and does not rotate or close a log that a running server holds open (such files are locked and skipped). Folders are never removed, even when empty. There is no per-rule size limit ("keep the newest N files / max X MB").
- Auto-clear counts the age by modified time only; there is no cron-style time of day.
- Consoles: log consoles share the tail of the Logs tab (one tail per server and log at a time), so following the same log in both tabs restarts the tail. The game console of Source / GoldSource engines still has no stdin; use an RCON console for those.
- Validate for games without a SteamCMD step re-runs the plugin install steps (same as Update); only `plugin.js` installers can tell the difference through `helpers.validate`. `update.validateArgs` supports only the key `steamcmd` for now.
- Validate asks for a confirmation (it can overwrite edited game files, configs are normally kept). Auto update never validates.
- The busy state text (`Validating`) was only checked through tests and the status events; the badge colour reuses the "Updating" style.
