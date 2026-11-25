# Open questions

Decisions deferred while implementing, to confirm with the project owner.

## Phase 1 - app shell
- Footer URLs (Website, Discord, Patreon, PayPal, Buy Me a Coffee) are placeholders in `src/renderer/links.js`.
- Panel scope: the server-list panel shows only in the List view; the details and quick-settings panels also show in Table / System Metrics (following `state.sel`). In the Table view a single click does not change that selection (double-click does). Should Table selection drive them?
- Only List / Table / System Metrics are remembered as the start view (`settings.view`); Games, Settings and Discord are not. Should the start view be extendable?
- Tick header stat is a "-" placeholder until Phase 7.
- Quick settings saves `name/port/map/maxPlayers/param` through the existing `save` IPC with no extra validation (same as the Settings tab).
