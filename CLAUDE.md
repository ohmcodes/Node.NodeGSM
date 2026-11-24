# NodeGSM - project rules

- **Docs rule:** with every change (feature, fix, rename, build change), add an entry to the Changelog in `FEATURES.md`, update the feature tables there, and update `README.md`, `PLUGINS.md`, `CONTRIBUTING.md` and any other affected docs in the same commit.
- **Everything is a plugin.** Games live in `plugins/<id>/` (plugin.json, icon.png, README.md, optional plugin.js). Never hard-code a game in `src/`. After changing anything under `plugins/`, run `npm run registry` and commit `plugins/registry.json`.
- Keep internal names (`wgsm.json`, `.wgsm-version`, `window.wgsm`) stable; they affect existing user data. The legacy data folder `%APPDATA%\node-wgsm2026\WGSM` must keep working.
- Run `npm test` (smoke tests + plugin validation) before committing.
- Do not stop the user's running electron/steamcmd processes (they may be mid-download).
