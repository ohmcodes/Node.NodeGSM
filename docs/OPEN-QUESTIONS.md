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
