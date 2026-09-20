# jupiter-stremio

A Stremio addon for [ERR Jupiter](https://jupiter.err.ee), Estonia's public
broadcaster. Films, series, and live TV with a programme guide and catch-up.

- **2223 films** and **1210 series** (25 127 episodes)
- **Live TV** — ETV, ETV2, ETV+ with a native EPG
- **Catch-up** — aired programmes play on demand, with subtitles
- ~99% of films are playable; the rest is DRM-locked licensed content, which
  no Stremio addon can play

## Run

```sh
docker compose up -d           # or: npm ci && npm start
```

Paste this into Stremio → Addons:

```
http://127.0.0.1:7000/manifest.json
```

Needs Node 22+ if running without containers. Opening
http://127.0.0.1:7000/ in a browser gives the same URL with a copy button,
which is useful when connecting from another machine.

## Build the index

Works without it, but browsing is slower and DRM titles aren't filtered out.

```sh
npm run index                  # ~40 min, resumable
npm run index:stats
```

Re-run occasionally to pick up new content. It's rate-limited on purpose —
read [JUPITER-API.md](JUPITER-API.md) section 11 before changing that.

## Other devices

Phones and TVs can't run the addon; they connect to a machine that does.
Stremio needs HTTPS for anything that isn't localhost:

```sh
tailscale serve --bg 7000      # private, real certificate
```

Or point `Caddyfile` at your domain and use the bundled compose stack.

## Configuration

| Variable | Default | |
|---|---|---|
| `PORT` | `7000` | |
| `HOST` | `0.0.0.0` | `127.0.0.1` to keep it local |
| `JUPITER_DB` | `data/jupiter.db` | index location |

## Layout

```
src/server.js   entry point
src/addon.js    manifest + catalog/meta/stream handlers
src/live.js     live TV, EPG, catch-up
src/err.js      ERR API client
src/map.js      ERR payloads -> Stremio objects
src/db.js       SQLite index
src/indexer.js  index builder
```

[JUPITER-API.md](JUPITER-API.md) documents the ERR API — endpoints, content
tiers, DRM, rate limits.

Self-hosted by design: a public instance would republish a broadcaster's
catalogue under whoever runs it.
