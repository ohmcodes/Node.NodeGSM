# NodeGSM website

Dark-mode site: **Home**, **Features & changelog**, **Plugins** (forgiving search, download, ratings, comments, community-editable game info) and **Download**. Static front end plus its **own small backend** for the community data. It is independent of the app: it only reads the published plugin **catalog**.

## Run it
```
npm run registry     # plugins/registry.json (after changing anything in plugins/)
npm run site         # website/catalog/ (plugin index, zips, icons) + website/data/site.json
npm run site:serve   # site + community API on http://localhost:8080
npm run test:site    # backend tests
```
Everything under `website/catalog/` and `website/data/` is generated (gitignored). `python -m http.server --directory website` also works for the static part, but then the community data stays in the visitor's browser (no backend).

## Where the plugins come from (catalog)
The site never hard-codes games. It reads `CATALOG_URL` (in `config.js`) + `/index.json`:

| File | |
|---|---|
| `index.json` | `{ schema, count, tags, plugins:[{ id, name, version, description, tags, docs, ports, configs, logs, hasScript, minAppVersion, sha256, size, zip, icon, readme, source }] }` - URLs are relative to `index.json` |
| `zips/<id>.zip` | the plugin folder, deterministic (the `sha256` only changes when the plugin changes) |
| `icons/<id>.png` | |

`scripts/build-catalog.js` (`npm run catalog`) builds it from `plugins/`. It is written so it can move unchanged into a separate plugins repository whose CI publishes the catalog (e.g. GitHub Pages). Then set `CATALOG_URL` to that address and the site (and, later, the app's online mode) updates itself when a plugin PR is merged. No website redeploy needed.

## Community backend (`website/server/`)
`server.js` serves the static site **and** the API, with no dependencies (Node 18+). Data is one JSON file (`server/data/community.json`, atomic writes): back it up. IPs are only stored hashed.

```
PORT=8080 ADMIN_TOKEN=<long random> node website/server/server.js
```
| Env | |
|---|---|
| `PORT`, `DATA_DIR` | listen port; where `community.json` lives |
| `CATALOG_INDEX` | catalog index used to accept only real plugin ids (default `website/catalog/index.json`) |
| `ADMIN_TOKEN` | enables moderation; unset = disabled |
| `ALLOWED_ORIGINS` | CORS allow-list when the API is on another origin (default `*`) |
| `TRUST_PROXY=1` | take the client IP from `X-Forwarded-For` (only behind your own reverse proxy) |
| `SERVE_STATIC=0` | API only |

Site config `API_URL`: `'auto'` (default; use `./api` if the server answers, else local-only), an absolute URL (API on another host), or `''` (force local-only).

### API (JSON, all under `/api`)
| Method + path | Body | Notes |
|---|---|---|
| `GET /health` | | `{ ok, service:'nodegsm-community' }` |
| `GET /ratings` | | `{ "<id>": { avg, count, downloads } }` for the plugin list |
| `GET /plugins/:id/community` | | `{ rating:{avg,count,mine}, downloads, comments:[{id,name,text,at}], info:{text,rev,by,at,summary,history:[{rev,by,at,summary}]} }` |
| `PUT /plugins/:id/rating` | `{ value: 1-5 }` | one rating per `X-Client-Id` (a random id the browser generates) |
| `POST /plugins/:id/comments` | `{ text, name }` | max 2000 chars, max 2 links, duplicates rejected |
| `PUT /plugins/:id/info` | `{ text, name, summary }` | Markdown, max 20000 chars; every save is a revision (last 50 kept) |
| `POST /plugins/:id/download` | | download counter, once per IP per plugin per 10 min |
| `DELETE /plugins/:id/comments/:cid` | | admin (`Authorization: Bearer <ADMIN_TOKEN>`) |
| `POST /plugins/:id/info/revert` | `{ rev }` | admin: restore an older info revision |

Protections: per-IP rate limits (comments 5/10 min, info edits 6/10 min, ratings 30/h), 64 KB body limit, control characters stripped, only catalog plugin ids accepted. The site escapes all user text on render, and Markdown goes through an allow-list renderer (no raw HTML, http(s) links only).
Not built yet: accounts, per-IP bans, a moderation UI (use the admin endpoints), a stronger spam filter. Add them before heavy public traffic. Ratings are per browser id, so they can be gamed by clearing storage; accounts or a CAPTCHA would be the next step.

## Deploy
- **Full site (recommended):** run `server.js` (e.g. `node`, a service, Docker or a small VPS) behind a reverse proxy with HTTPS; build with `npm run site` first. One process serves pages and API.
- **Static only:** `.github/workflows/site.yml` publishes `website/` to GitHub Pages. GitHub Pages cannot run the backend, so set `API_URL` in `config.js` to your hosted API and `ALLOWED_ORIGINS` on it to the Pages domain.

## Files
`index.html`, `features.html`, `download.html`, `plugins.html` (+ `plugins.js`: search, drawer), `layout.js` (nav, footer, safe Markdown), `community.js` (API client with local fallback), `style.css`, `config.js`, `server/` (`server.js`, `store.js`, `test.js`).
