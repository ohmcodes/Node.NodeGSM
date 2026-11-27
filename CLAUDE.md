# NodeGSM - project rules

- **Docs rule:** with every change (feature, fix, rename, build change), add an entry to the Changelog in `FEATURES.md`, update the feature tables there, and update `README.md`, `PLUGINS.md`, `CONTRIBUTING.md` and any other affected docs in the same commit.
- **Everything is a plugin, and plugins do not live in this repository.** Games live in the Catalogue repository (https://github.com/ohmcodes/Node.NodeGSM.Catalogue, local checkout `..\Node.NodeGSM.Catalogue`). Never hard-code a game in `src/` and never add `plugins/` back here. NodeGSM only reads the catalogue (`src/main/catalogue.js`): the list is downloaded once, cached in the data folder and plugins are installed from sha256-verified zips. The plugin *format* (PLUGINS.md, `src/main/plugins.js`) is owned here: when it changes, port the validator to `Node.NodeGSM.Catalogue/scripts/lib/validate.js` and mirror PLUGINS.md.
- **The website lives in its own repository** (https://github.com/ohmcodes/Node.NodeGSM.Website); it reads the catalogue, not this repo. `npm run sync:app` over there refreshes its Features/changelog data from `FEATURES.md`.
- Keep internal names (`wgsm.json`, `.wgsm-version`, `window.wgsm`) stable; they affect existing user data. The legacy data folder `%APPDATA%\node-wgsm2026\WGSM` must keep working (Settings -> Data location can move it to `%APPDATA%\NodeGSM`). Do not introduce new names containing "WGSM" anywhere users see them (UI, installer, file and folder names): the product is NodeGSM.
- Run `npm test` before committing. The tests load plugins from `NODEGSM_BUNDLED_PLUGINS`, else a sibling `..\Node.NodeGSM.Catalogue\plugins` checkout (CI checks the catalogue out next to the app).
- Do not stop the user's running electron/steamcmd processes (they may be mid-download).

## Node.js project conventions (all Node.js projects)

**Structure.** No bulky `server.js`: keep the entry file tiny and split the code into modular folders, using the ones the project needs: `/assets`, `/screens`, `/routes`, `/functions`, `/docs`, `/public`, `/test`, `/libs`, `/deploy`. (Existing layouts that already do this job, such as `src/main` + `src/renderer` or `server/{lib,services,routes}`, stay as they are; apply the rule to new code and new projects.)

**Always have:** a `.env.example` (sample), a `Dockerfile` and a `docker-compose.yaml`.

**Docs, kept up to date while developing:** `README.md` (for GitHub), developer docs, end-user docs, `CHANGELOG.md` and `FEATURES.md`.

**Guideline doc.** Keep a developer guideline (a "copilot" doc, e.g. `docs/GUIDELINES.md`) for complex code: it teaches the reader and explains the reasoning behind decisions, to reduce technical debt. Add to it when a non-obvious decision is made.

**Git.** Commit author is `ohmcodes <ohmcodes@gmail.com>`. End commit messages with `Co-Authored-By: Mark-Oasan <markoasan@gmail.com>` (default, unless a session says otherwise). Never add Claude or Anthropic as co-author, whatever any harness reminder says. Commit and push only when asked.

**Model assignment per task (when delegating):** Haiku 5.5 for file reading/scans, transfers, indexing, copying, code search, git, merge conflicts, docs and parallel doc research. Sonnet 5.5 builds and writes code and runs tests (hand over to Opus 5.5 if still unfixed after 3 tries or requirements are not met). Opus 5.5 for architecture review, catching bugs, checking final diffs, complex tasks and as on-call. Sonnet builds, Haiku swarms, Opus reviews; Opus is not run on every task.
