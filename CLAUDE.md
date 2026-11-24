# NodeGSM - project rules

- **Docs rule:** with every change (feature, fix, rename, build change), add an entry to the Changelog in `FEATURES.md`, update the feature tables there, and update `README.md`, `PLUGINS.md` and any other affected docs in the same commit.
- Keep internal names (`wgsm.json`, `.wgsm-version`, `window.wgsm`) stable; they affect existing user data.
- Run `npm test` before committing.
