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
