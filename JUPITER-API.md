# ERR Jupiter — platform notes

Reverse-engineered from the Angular bundle at `jupiter.err.ee` (`main-*.js`) and
verified against the live API on 2026-09-20. Undocumented and unversioned in
practice — treat every shape here as subject to change without notice.

**API base: `https://services.err.ee`** — open, unauthenticated, CORS-enabled.
No API key, no session needed for catalog or media metadata.

---

## 1. Endpoints

Exact signatures as the SPA calls them (`domain=jupiter.err.ee`, `page=web`):

| Purpose | Call |
|---|---|
| Category / front page | `GET /api/v2/category/getByUrl?url={slug}&domain={domain}&page=web` |
| VOD content detail | `GET /api/v2/vodContent/getContentPageData?contentId={id}&rootId={rootId}&page=web` |
| …for a logged-in user | `GET /api/v2/vodContent/getContentPageDataForUser?...` |
| TV/live block content | `GET /api/v2/tv/getContentData?contentId={id}&rootId={rootId}` |
| Series listing by type | `GET /api/v2/series/getSeriesData?type={type}` |
| Search | `GET /api/search/getVodContents2/?type={type}&options={json}` |
| Live channel media | `GET /api/live/getLiveMediaData?channelName={name}[&id={id}]` |
| Live/TV schedule (EPG) | `GET /api/tvSchedule/getExactSchedules?type=player&channel={name}` |
| Schedule tail | `GET /api/v2/schedule/getScheduleEnd` |
| Menu / navigation | `GET /api/v2/menu/getMenuById?menuId={id}` |
| Front-page progress | `GET /api/v2/progress/getFrontPageData` |
| Geo data | `GET /api/geoblock/getRegionalData` |
| Server time | `GET /api/time/getTimestamp` |

User-scoped (need auth, not relevant to a public addon): `/api/v1/progress`,
`/api/v1/favourite`, `/api/publicUser/*`, `/api/auth/*`. ERR supports Mobile-ID
and Smart-ID login (`authMobileId`, `authSmartId`).

The `video` root category is **id 4133**; `rootCategoryId 3905` is what most
video items carry.

## 2. Content model

`category.frontPage` is an array of **blocks** (27 on `/video`), each with a
`header` and a `data` array of items. This maps almost 1:1 onto Stremio
catalogs — block header becomes catalog name.

Listing item fields: `id`, `heading`, `lead` (HTML), `type`, `mediaType`,
`canonicalUrl`, `fancyUrl`, `photos` / `verticalPhotos` / `squarePhotos`,
`primaryCategoryId`, `rootCategoryId`, `rootContentId`, `parentContentPath`,
`scheduleStart`, `hasActiveMedia`.

`type` ∈ `movie` | `series` | `episode` | `clip`.

**Listings do not carry media.** `restrictions`, `folder` and stream URLs only
appear in the content-detail response, so you cannot tell from a catalog
payload whether an item is playable. That forces a local index if you want
catalogs that only show playable content — the single biggest design
consequence for the addon.

Detail response (`getContentPageData`) → `data.mainContent` plus
`data.seasonList`, `data.categoryContents`, `data.nextContent`,
`data.futureContent`, `data.pageType`. `mainContent` carries `heading`,
`originalTitle`, `lead`, `body`, `episode`, `parentContentId`, `makers`,
`country`, `publicStart`, `clips`, `galleries`, and `medias[]`.

## 3. The media object

```
medias[0] = {
  id, type: "video", folder, mediaHash, file, filename, version,
  ld/sd/hd/fhd/4k : 0|1          # available rendition tiers
  mediaInfo: { aspectRatio, duration }   # duration in seconds, as a string
  restrictions: { drm: bool, geoBlock: bool }
  subtitles: [ { subId, name, srclang, src } ]
  periods: [ { publicStart, publicEnd, vodReqId } ]   # availability windows
  catchupDays
  src: { hls, hls2, hlsNew, hlsNoSub, dash, dashNew, dashNoSub, file, ratio }
  # DRM only:
  skd, jwt, licenseServerUrl: { widevine, playReady, fairPlay }
}
```

`src.*` values are **protocol-relative** (`//vod.err.ee/...`) — prefix `https:`.

URL shape: `//vod.err.ee/{proto}/{folder}/{mediaHash}[/{version}]/v/master.m3u8`
and `//vod.err.ee/file/{folder}/{mediaHash}.mp4`.

### `folder` is the restriction tier

`folder` is a reliable proxy for what you're allowed to do with an item:

| `folder` | drm | geoBlock | Direct MP4 | HLS |
|---|---|---|---|---|
| `vod`, `uudised`, `etvsaated`, `etvvideod`, `viker`, `erryld` | no | no | ✅ 200 | ✅ |
| `gb`, `gbsec` | no | yes | ❌ 403 | ✅ |
| `drm` | **yes** | yes | ❌ | DRM-encrypted |

Measured on a 60-item sample from the `/video` front page:

- **43 / 60 (72%)** clear, no geo restriction — fully playable
- **10 / 60 (17%)** clear but geo-restricted (`gb`/`gbsec`)
- **7 / 60 (12%)** DRM

DRM is Axinom (Widevine / PlayReady / FairPlay) with a per-media entitlement
JWT. This is licensed third-party content — foreign films and series.
**Stremio has no CDM, so this tier is unplayable, full stop.** It is also not
ERR's own material. Excluding it is both the only thing that works and the
right line to draw: the addon should cover ERR's own freely-published output.

### Verified playback (clear `vod` item)

- `master.m3u8` → 200, `application/vnd.apple.mpegurl`, three renditions
  (704×396, 1280×720, 1920×1080), separate audio group + WebVTT subtitle track.
- `file/vod/{hash}.mp4` → 200, `video/mp4`, `accept-ranges: bytes`,
  `access-control-allow-origin: *`.
- Subtitle → 200, `text/vtt;charset=UTF-8`.

**The direct MP4 is the prize where it exists.** It is seekable, CORS-open, and
needs no `notWebReady` — Stremio plays it natively without a proxy. Prefer
`src.file`; fall back to `src.hls` with `notWebReady: true` when `file` 403s
(i.e. the `gb` tier).

**But see §7:** in the films/series catalogs the `gb` tier *dominates*, so HLS
is the primary path there, not the exception. The MP4 fast path mostly applies
to `vod`/`uudised` (news, ERR's own recent output).

### Correction worth recording

A `gb` item's MP4 returns 403 **even from an Estonian IP** (verified: egress
was Telia Eesti, Tallinn). So the 403 is a path-level restriction on the `file/`
route for that tier, *not* geo enforcement. `gb` HLS serves fine from Estonia.
Don't conflate the two when deciding what to filter.

## 4. Live TV

`GET /api/live/getLiveMediaData?channelName=etv` (also `etv2`, `etvpluss`).

```
src: "//live.err.ee/live/etv.m3u8"        # clear HLS — this is the one to use
srcDash: "http://etvstream.err.ee/live/smil:etv/manifest.mpd"
config.isGeoBlocked: false
config.drm.srcs: { dash, hls }            # separate DRM variant; ignore
config.schedule.url: "/api/tvSchedule/getExactSchedules?type=player&channel=etv"
config.thumbnail.url: "//atlas-th.err.ee/etv/?time=CURRENT_TIME"
config.ndvr: 1                            # network DVR available
```

Verified: `live.err.ee/live/etv.m3u8` → 200, HLS v7, renditions from 320×180 up,
Estonian + `zxx` audio tracks, Estonian and Russian subtitle tracks.
`config.drm` exists alongside but `src` is clear — use `src`.

`isGeoBlocked: false` on ETV, so live channels are the easiest win in the whole
project.

## 5. Mapping onto the Stremio protocol

See `STUDY.md` for the protocol itself. The mapping:

- **IDs.** No IMDb IDs, so use a namespace: `jupiter:{contentId}`, episodes as
  `jupiter:{seriesId}:{episodeId}`. Consequence (per `STUDY.md` §1): a non-`tt`
  prefix means Cinemeta won't resolve metadata, so **you must implement the
  `meta` resource**. Declare `idPrefixes: ["jupiter:"]`.
- **Types.** `movie` → `movie`; `series`/`episode` → `series`; live channels →
  `tv`; `clip` → `movie` or a `channel`-typed catalog.
- **Catalogs.** One per interesting `frontPage` block. `search` extra maps to
  `getVodContents2`. `genre` extra maps to category slugs.
- **Streams.** Prefer `src.file` (webReady MP4). Set
  `behaviorHints.filename` (from `media.filename`) and `videoSize` so subtitle
  addons can match — the SDK warns when `url` is set without `filename`.
- **Subtitles.** `media.subtitles[]` → Stremio `subtitles[]` directly; `srclang`
  is `ET`/`VA`/`EN` (note `VA` appears to be Estonian hard-of-hearing; verify
  before mapping blindly). VTT is served with correct content-type.
- **`bingeGroup`.** Per `STUDY.md` §4: for episodes use something stable per
  series+quality, e.g. `jupiter|{seriesId}|{resolution}`.
- **Geo.** For the `gb` tier set
  `behaviorHints.countryWhitelist: ["est"]` — this is exactly what that hint is
  for.
- **DRM tier.** Either omit, or surface as an explanatory error-stream
  (`STUDY.md` §4) so the user learns *why* a title has no playable source
  rather than seeing an empty list.
- **Live + EPG.** `getExactSchedules` gives programme data, and the SDK
  supports a **Native EPG** layout: set `behaviorHints.epgProvider`, declare a
  `tv` catalog with the `date` extra, return `metasDetailed` with
  `startTime`/`endTime` per programme. Stream requests use the *channel* id.

## 6. Films & series: measured viability

> **Superseded — read section 12 for the real numbers.** The sample below drew
> from curated front-page rows, which over-represent licensed foreign titles.
> A full census of all 2223 films puts DRM at **1.1%**, not 14%.

Sampled 196 titles drawn from **Filmid** (cat 4137), **Sarjad** (cat 4136) and
**Draama** (cat 4431), fetching each detail page and reading
`medias[0].restrictions`.

| Catalog | clear | geo-only | DRM | playable |
|---|---|---|---|---|
| Filmid | 34 | 18 | 4 | **93 %** |
| Sarjad | 14 | 40 | 16 | **77 %** |
| Draama | 32 | 31 | 7 | **90 %** |
| **All** | **80** | **89** | **27** | **86 %** |

Folder distribution: `gb` 78, `vod` 75, `drm` 27, `gbsec` 11, `erryld` 3,
`etvsaated` 1, `etvvideod` 1.

Two consequences that change the design:

1. **`gb`/`gbsec` is the largest tier for films and series (45 %)**, not `vod`.
   Geo-restricted content is fully playable *from Estonia* — but only over HLS,
   since the `file/` MP4 route 403s for that tier regardless of location. So
   the addon's main stream path must be **HLS + `notWebReady: true`**, with the
   MP4 fast path as an opportunistic upgrade when `folder` is `vod`-like.
   Set `behaviorHints.countryWhitelist: ["est"]` on `gb` streams.
2. **DRM is ~14 % and is entirely licensed foreign production** — British and
   French drama and crime series, a handful of foreign films. ERR's own
   material is not DRM-protected. See §8.

## 7. DRM: why it cannot be plugged in

**The addon protocol has no DRM plumbing.** Verified by grepping the SDK docs,
`src/`, and the linter: zero occurrences of `drm`, `widevine`, `playready`,
`fairplay`, `clearkey`, `licenseUrl` or `keySystem`.

The complete set of stream sources is `url`, `ytId`, `infoHash`/`fileIdx`,
`nzbUrl`/`servers`, the archive variants, and `externalUrl`. The complete set
of `behaviorHints` is `bingeGroup`, `countryWhitelist`, `filename`,
`notWebReady`, `proxyHeaders`, `videoHash`, `videoSize`. **There is no field in
which a license-server URL or key system could be expressed**, so even a client
that had a CDM could not be told where to acquire a licence.

Stremio's desktop player is libmpv-based and ships no CDM at all. Stremio Web
runs inside a browser that *does* have Widevine — but with no protocol field to
carry the licence endpoint, there is nothing to wire it to.

### The supported path: `externalUrl` handoff

`externalUrl` exists exactly for this. It is what the official
`addon-helloworld` sample uses to represent a Netflix title: the item appears
in catalogs, search and metadata, and selecting it opens the original service's
player.

So DRM titles need not vanish from the addon. Emit them with full metadata and
a single stream:

```js
{ name: 'Jupiter', title: 'Ava ERR Jupiteris (DRM)',
  externalUrl: `https://jupiter.err.ee/${contentId}` }
```

Catalog stays complete, search still finds the title, and playback hands off to
ERR's own player where the licence is acquired legitimately. Pair it with the
error-stream idiom from `STUDY.md` §4 so the user understands *why*.

**Not doing:** acquiring Axinom licences with a headless CDM to decrypt and
re-serve these streams. That is circumvention of a technical protection
measure — unlawful under the EU Copyright Directive as implemented in Estonian
law — and it is precisely the foreign licensed content ERR is contractually
obliged to protect. It would also be the one thing guaranteed to get the whole
addon killed.

## 8. Series / season / episode structure — solved

One call to `getContentPageData` for **any** episode or the series root returns
the entire tree in `data.seasonList`:

```
seasonList = {
  type: "seasonal",
  contentOrder: "asc",              # or "desc"
  items: [
    { id: 1, name: "1", url, firstContentId,
      contents: [
        { id, heading, subHeading, season, episode, type: "episode",
          scheduleStart, publicStart, updated, primaryCategoryId,
          parentContentPath, photos: [...] },
        ...
      ] },
    ...
  ]
}
```

`season` and `episode` are explicit integers — no parsing of titles required.
This maps straight onto Stremio's `meta.videos[]`:

```js
videos: contents.map(e => ({
  id: `jupiter:${e.id}`,
  title: e.subHeading || e.heading,
  season: e.season,
  episode: e.episode,
  released: new Date(e.publicStart * 1000).toISOString(),
  thumbnail: e.photos?.[0]?.photoTypes?.['34']?.url,
}))
```

`mainContent` on an episode carries `parentContentId` and `rootContentId`
pointing at the series, so series ↔ episode navigation is resolvable in both
directions.

**Caveat:** `seasonList[].contents[]` entries carry **no `medias`**, so per-episode
DRM/geo status is unknown until you fetch that episode's detail page. Building
the season tree costs one request; knowing which episodes are playable costs
one request per episode. This is the concrete case for a local index
(`STUDY.md` §4, Torrentio's resolve-at-index-time model).

## 9. Gotcha: never probe `vod.err.ee` HLS with HEAD

`master.m3u8` returns **403 to a HEAD request** but **200 to a GET** (and 206 to
a ranged GET). The MP4 route answers HEAD normally, so a mixed HEAD sweep will
report HLS as broken while MP4 looks fine — which is wrong.

```
HEAD  /hls/vod/{hash}/3/v/master.m3u8   -> 403 text/html
GET   /hls/vod/{hash}/3/v/master.m3u8   -> 200 application/vnd.apple.mpegurl
GET   (Range: bytes=0-64)               -> 206
```

Any health check or availability prober must use GET, optionally ranged.

---

## 10. `getVodContents2` — the real catalogue API

Captured from the SPA. This is the **only paginated view of the full library**;
category front pages expose a few hundred curated items, this exposes
everything.

```
GET /api/search/getVodContents2/?type=&options={json}
```

`options` (URL-encoded JSON):

```json
{ "page": 1, "limit": 100, "offset": 0, "category": 3905,
  "phrase": "", "types": ["media"], "searchTypes": ["video"],
  "viewTypes": ["movie"], "now": 0 }
```

Response is keyed by search type, each with its own paging block:

```json
{ "video": { "contents": [...], "totalFound": 2223,
             "type": "Video", "page": 1, "limit": 100, "perPage": 100 },
  "audio": { ... } }
```

Verified behaviour:

| Property | Finding |
|---|---|
| Empty `phrase` | lists the entire catalogue — it is a listing API, not just search |
| `viewTypes: ["movie"]` | **2223** titles |
| `viewTypes: ["series"]` | **1211** titles |
| `page` | works — this is how you paginate |
| `offset` | **accepted and silently ignored**; `offset:5` returns page 1 |
| `limit` | at least 500 honoured (100 / 200 / 500 all returned in full) |
| `category` | must be the *root* id `3905`; a menu id such as `4137` returns **500** |
| `category` omitted | same result as `3905` |
| `searchTypes` | `["video","audio"]` searches both; restrict to `video` |
| CORS | `access-control-allow-origin: *` on the GET, so usable server-side |

Catalogue items carry `id`, `heading`, `type`, `season`, `episode`,
`parentContentId`, `publicStart`, `primaryCategory`, `canonicalUrl` and photo
sets — enough to build a Stremio meta preview without a detail fetch. As with
front-page listings they carry **no `medias`**, so playability still needs the
detail call.

### Photo types differ between endpoints

The available crop types are not consistent, so poster selection needs an
ordered fallback rather than a fixed type:

| Source | types present |
|---|---|
| category front page | `t2` 1920×1080, `t17` 600×338, `t34` 324×182, `t60` 180×270, `t80` 400×600 |
| `getVodContents2` | `t1` 120×80, `t49` 0×80, `t60` 180×270; `horizontalPoster` adds `t17`/`t26`/`t34` |
| content detail | `t1`, `t2`, `t6` 800×500, `t8` 400×250, `t11`, `t15` |

So the best portrait poster from the search endpoint is **`t60` (180×270)**,
while front-page listings offer `t80` (400×600).

### `i.err.ee/smartcrop` does not help

```
GET https://i.err.ee/smartcrop?type=optimize&width={w}&aspectratio={w:h}&url={src}
```

It crops and downscales but **does not upscale** — asking for `width=600` from a
180×270 source returns 180×270. It is useful for normalising an odd aspect
ratio, not for manufacturing a larger poster. Note also that the
`photoUrlOriginal` field in payloads **404s at the origin**, so it cannot be
used as a high-resolution source; pass a `/photo/crop/...` URL instead.

## 11. Rate limits — learned the hard way

**ERR's origin will cut you off.** Running the enrichment pass at concurrency 5
with no pacing — roughly 2400 detail requests back to back — caused
`services.err.ee` to return **HTTP 520** (Cloudflare "origin returned an
unknown error") for *everything*: content detail, search, previously-working
ids alike. It did not recover within minutes.

Characteristics observed:

- Not per-item. Ids that had succeeded minutes earlier began returning 520.
- Not fixed by varying `rootId` — every value returned 520.
- Not a short cooldown; still 520 several minutes after all traffic stopped.
- No `Retry-After`, no 429 — it presents as a plain origin error, so naive
  code reads it as "this item is broken" rather than "you are being throttled".

That last point is the dangerous one. A crawler that treats 5xx as a per-item
verdict will march through the entire catalogue recording false negatives,
which is exactly what happened here: 2024 items were marked "checked, no DRM"
when in truth nothing had been checked at all.

### Rules for any crawler against this API

1. **Concurrency 2, with ~150 ms spacing between request starts.** The catalogue
   is ~3400 items; there is no reason to rush.
2. **Circuit-break on consecutive failures.** N failures in a row means the
   upstream is refusing you, not that N items are broken. Abort the pass.
3. **Never record a failed fetch as a successful check.** A failure is
   "unknown", not "clean". Track attempts and a retry-after timestamp
   separately from the checked flag.
4. **Retry 5xx with backoff; fail fast on 4xx.** 520 is transient, 404 is not.
5. Prefer the discovery pass — 35 requests for the whole library via
   `getVodContents2` — and enrich lazily over time rather than in one sweep.

## 12. Full film census — every title, not a sample

All **2223** films discovered via `getVodContents2` were enriched with a detail
fetch. No sampling, no failures.

| Tier | Count | Share | Playable in Stremio |
|---|---|---|---|
| clear (`vod`, `erryld`, `etvsaated`, `etv2saated`, `viker`, `uudised`, …) | 1899 | 85.4% | yes, anywhere — direct MP4 |
| geo-restricted (`gb`, `gbsec`) | 299 | 13.5% | yes from Estonia — HLS only |
| DRM (`drm`) | 25 | 1.1% | no — `externalUrl` handoff |
| no media | 2 | 0.1% | no |
| **Playable total** | **2198** | **98.9%** | |

Folder distribution: `vod` 1729, `gb` 259, `erryld` 70, `etvsaated` 51,
`gbsec` 40, `etv2saated` 33, `drm` 25, `viker` 8, `uudised` 3, `sport` 1,
`r2` 1.

**Why the earlier 196-title sample was wrong.** It was drawn from the curated
front-page rows of Filmid / Sarjad / Draama. Those rows are ERR's *promoted*
shelf, which is exactly where recently-licensed foreign films and imported
drama series sit — so DRM was over-represented roughly 13×. The library as a
whole is dominated by ERR's own archive (`vod` alone is 78% of it), which
carries no DRM at all.

The lesson generalises: **do not estimate catalogue composition from a
recommendation surface.** Front pages are selected for novelty and licensing
spend, not representativeness. The full enumeration cost ~2200 requests and
settled the question definitively.

Note this is the *film* census. Series were not enriched at the time of
writing; the sample suggested they carry proportionally more DRM (imported
crime and period drama), so expect a higher share there.

## 13. Series: three traps and a shortcut

### Trap 1 — a series id resolves to an episode

`getContentPageData?contentId={seriesId}` does **not** return a container. It
returns that series' first episode, so `main.id` is an *episode* id while
`parentContentId` / `rootContentId` hold the series id:

```
requested 1038266  ->  main.id 1022055, main.type "episode",
                       parentContentId 1038266, rootContentId 1038266
```

Anything keyed on `main.id` will therefore write against the wrong record.
Always use the id you asked for.

### Trap 2 — seasons load lazily

The `seasonList` that comes back has `contents` populated **only for the season
containing the returned episode**. Every other season arrives with
`contents: []` and a `firstContentId`:

```
1:10  2:0  3:0  4:0  5:0  6:0  7:0  8:0  9:0  10:0
```

Fetching a season's `firstContentId` returns a `seasonList` with *that* season
populated and the rest empty. So a full tree costs one request per season.

Measured over 20 random series: **1.40 seasons average**, 17/20 single-season.
Full trees for all 1210 series therefore cost roughly **1700 requests**, not
the tens of thousands a per-episode walk would need.

### The shortcut — episodes inherit their series' tier

Sampled 10 series, checking up to 4 episodes each and classifying by tier class
(CLEAR / GEO / DRM rather than by raw `folder` string): **10/10 were uniform.**

The distinction matters. Classifying by `folder` string gives only 5/7 uniform,
because a single series mixes `vod`, `etvsaated` and `erryld` — but those are
all *clear*, so the difference is cosmetic. Tier class is what determines how a
stream must be served, and that is stable within a series.

This collapses the cost: enrich a series once, inherit the tier to its
episodes, and skip ~25 000 per-episode detail fetches.

### Trap 3 — DRM titles may live on another ERR domain

An episode's `canonicalUrl` is not always on `jupiter.err.ee`; children's
content resolves to `lasteekraan.err.ee/{id}`. The `externalUrl` handoff must
use `canonicalUrl`, not a constructed Jupiter URL.

## 14. Complete index census

Every film, series and episode enumerated and classified.

| Type | Total | Clear | Geo | DRM | Playable |
|---|---|---|---|---|---|
| movie | 2223 | 1899 | 299 | 25 | **98.9%** |
| series | 1210 | 903 | 231 | 72 | **94.0%** |
| episode | 25127 | 20785 | 3075 | 1267 | **95.0%** |

Series carry proportionally more DRM than films (6.0% vs 1.1%), which matches
the earlier sample's intuition — imported crime and period drama sit
disproportionately in the series catalogue.

Four series ids returned a genuine 404 and are recorded as unavailable.

## 15. Live TV and the programme guide

```
GET /api/live/getLiveMediaData?channelName={etv|etv2|etvpluss}
GET /api/tvSchedule/getExactSchedules?type=player&channel={channel}
```

Three channels carry a clear HLS manifest with `isGeoBlocked: false`:
`live.err.ee/live/{channel}.m3u8`. Each also advertises a DRM variant under
`config.drm.srcs` — ignore it; the plain `src` is unencrypted.

`getExactSchedules` returns a **flat JSON array** (not an object), ~80-130
entries per channel, each with unix-second `startTime` / `endTime`, `heading`,
`lead`, `photoUrl`, `contentId`, `season` / `episode` and `seriesTitle`. That
is everything Stremio's Native EPG needs, so the addon sets
`behaviorHints.epgProvider` and serves `metasDetailed` for guide requests.

Two conversions are required: Stremio wants **ISO 8601** times, not unix
seconds, and streams resolve by **channel id**, never by programme id.

**`r4video` is advertised but broken.** `getLiveMediaData` returns it with
`isSpecial: true` and a `sb.err.ee/eri/r4video.m3u8` source that 404s, and it
has no schedule. It appears to be an event channel ERR activates only for
specific broadcasts, so it is excluded rather than shipped as a dead entry.
Anything enumerating channels should verify the manifest before trusting it.

## 16. Catch-up: replaying what already aired

EPG entries are not just a timeline — they carry everything needed to play a
past programme on demand:

| Field | Meaning |
|---|---|
| `mediaExists` | a VOD item exists for this broadcast |
| `contentId` | that item's ordinary Jupiter content id |
| `drm` | `1` when the recording is DRM-locked |
| `gb` | `1` when it is geo-restricted |
| `vodSiteUrl` | canonical page, may be on another ERR domain |

So catch-up needs no separate API. When a programme has aired and
`mediaExists` is set, resolve `contentId` through
`getContentPageData` — the same path a film takes — and serve the resulting
streams. Measured over one day:

| Channel | Aired | Replayable | DRM-blocked | No recording |
|---|---|---|---|---|
| ETV | 82 | **60** | 18 | 4 |
| ETV2 | 125 | **92** | 30 | 3 |
| ETV+ | 77 | **68** | 6 | 3 |

Roughly three quarters of the broadcast day is replayable; the shortfall is
almost entirely licensed foreign programming, which is DRM-locked in catch-up
exactly as it is on demand.

The addon returns catch-up streams **first**, then the live channel, so a
viewer can always jump back to air. Catch-up carries subtitles; the live HLS
does not.

Note the `config.ndvr: 1` flag on live channels suggests a network DVR /
timeshift window on the live manifest as well. That was not needed once
`contentId` proved sufficient, and is unexplored.
