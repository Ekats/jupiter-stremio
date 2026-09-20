import pkg from 'stremio-addon-sdk';
import { getCategory, getContent, searchVod, CATEGORY } from './err.js';
import { toMetaPreview, rowToPreview, toMeta, toSeriesMeta, toStreams, subtitlesFor, toContentId, ID_PREFIX } from './map.js';
import { openDb, listItems, listEpisodes, getItem, genres as indexGenres, stats } from './db.js';
import { CHANNELS, isChannelId, channelKey, parseLiveId, toChannelPreview, toChannelMeta, toChannelStreams } from './live.js';

const { addonBuilder } = pkg;

const CATALOG_ID = 'jupiter-films';
const SERIES_CATALOG_ID = 'jupiter-series';
const TV_CATALOG_ID = 'jupiter-tv';
const PAGE_SIZE = 100;

const CATALOG_CACHE_AGE = 30 * 60; // 30 min
const META_CACHE_AGE = 60 * 60; // 1 hour
const STREAM_CACHE_AGE = 30 * 60; // 30 min — shorter, URLs can rotate
const EPG_CACHE_AGE = 10 * 60; // 10 min — the guide moves
const LIVE_CACHE_AGE = 5 * 60; // 5 min

// Blocks on the Filmid front page become the catalog's genre filter.
function genresOf(category) {
  return category.frontPage
    .filter((block) => block.header && (block.data || []).length)
    .map((block) => block.header);
}

/**
 * Full-text search through ERR, minus anything the index knows is DRM-locked.
 * Titles absent from the index are kept: unknown is not the same as blocked.
 */
async function searchCatalog(viewType, phrase, skip) {
  const { items } = await searchVod({
    phrase,
    viewTypes: [viewType],
    page: Math.floor(skip / PAGE_SIZE) + 1,
    limit: PAGE_SIZE
  });
  return items
    .filter((item) => getItem(item.id)?.drm !== 1)
    .map(toMetaPreview);
}

function indexedMovieCount() {
  return stats().find((row) => row.type === 'movie')?.total ?? 0;
}

// Items for one genre, or every item across blocks (deduplicated) when no
// genre is selected. Listings carry no media, so playability is unknown here;
// that is resolved per item in the stream handler.
function itemsFor(category, genre) {
  const blocks = genre
    ? category.frontPage.filter((block) => block.header === genre)
    : category.frontPage;

  const seen = new Set();
  const items = [];
  for (const block of blocks) {
    for (const item of block.data || []) {
      if (item.type !== 'movie' || seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
  }
  return items;
}

export async function buildAddon() {
  openDb();
  const indexed = indexedMovieCount();

  // Prefer the index for genre options so startup does not depend on ERR
  // being reachable; fall back to a live category fetch on a cold index.
  const genreOptions = indexed
    ? indexGenres().map((row) => row.genre)
    : genresOf(await getCategory('filmid'));

  const manifest = {
    id: 'ee.err.jupiter',
    version: '0.1.0',
    name: 'ERR Jupiter',
    description:
      'Films from ERR Jupiter, the Estonian public broadcaster\'s streaming service. '
      + 'DRM-protected licensed titles open in ERR Jupiter instead of playing inline.',
    logo: 'https://s.err.ee/photo/crop/2020/04/22/772148h6e52t6.png',
    resources: [
      'catalog',
      'meta',
      'stream',
      // Declared explicitly: Stremio drives its subtitle picker from this
      // resource, and subtitles embedded in stream objects alone are not
      // reliably surfaced (notably for notWebReady/HLS playback).
      { name: 'subtitles', types: ['movie', 'series'], idPrefixes: [ID_PREFIX] }
    ],
    types: ['movie', 'series', 'tv'],
    idPrefixes: [ID_PREFIX],
    catalogs: [
      {
        type: 'movie',
        id: CATALOG_ID,
        name: 'Jupiter Filmid',
        extra: [
          { name: 'genre', options: genreOptions, isRequired: false },
          { name: 'search', isRequired: false },
          { name: 'skip', isRequired: false }
        ]
      },
      {
        type: 'series',
        id: SERIES_CATALOG_ID,
        name: 'Jupiter Sarjad',
        extra: [
          { name: 'search', isRequired: false },
          { name: 'skip', isRequired: false }
        ]
      },
      {
        type: 'tv',
        id: TV_CATALOG_ID,
        name: 'ERR Otse',
        // `date` marks this as a guide catalog; keeping it optional lets
        // Discover still load a plain channel list.
        extra: [
          { name: 'skip', isRequired: false },
          { name: 'date', isRequired: false }
        ]
      }
    ],
    // Only set because real startTime/endTime data is returned (3 of 4 channels).
    behaviorHints: { configurable: false, epgProvider: true }
  };

  const builder = new addonBuilder(manifest);

  builder.defineCatalogHandler(async ({ id, extra = {} }) => {
    const skip = Number(extra.skip) || 0;

    if (id === TV_CATALOG_ID) {
      // Stremio pages the guide by advancing skip; end by returning empty.
      if (skip >= CHANNELS.length) {
        return extra.date ? { metasDetailed: [] } : { metas: [] };
      }
      const channels = CHANNELS.slice(skip);
      if (extra.date) {
        return {
          metasDetailed: await Promise.all(channels.map((c) => toChannelMeta(c, extra.date))),
          cacheMaxAge: EPG_CACHE_AGE
        };
      }
      return {
        metas: await Promise.all(channels.map(toChannelPreview)),
        cacheMaxAge: EPG_CACHE_AGE
      };
    }

    if (id === SERIES_CATALOG_ID) {
      if (extra.search) {
        return {
          metas: await searchCatalog('series', extra.search, skip),
          cacheMaxAge: CATALOG_CACHE_AGE
        };
      }
      const rows = listItems({ type: 'series', skip, limit: PAGE_SIZE });
      return { metas: rows.map(rowToPreview), cacheMaxAge: CATALOG_CACHE_AGE };
    }

    if (id !== CATALOG_ID) return { metas: [] };

    // Search goes to ERR's own endpoint: it is full-text over titles and
    // descriptions, which a LIKE over indexed headings cannot match. Results
    // are then filtered against the index, which is the only thing that knows
    // what is DRM-locked.
    if (extra.search) {
      return {
        metas: await searchCatalog('movie', extra.search, skip),
        cacheMaxAge: CATALOG_CACHE_AGE
      };
    }

    // Browsing is served from the local index: instant, already DRM-filtered,
    // and it keeps working when ERR is slow or refusing requests.
    if (indexedMovieCount()) {
      const rows = listItems({ type: 'movie', genre: extra.genre, skip, limit: PAGE_SIZE });
      return { metas: rows.map(rowToPreview), cacheMaxAge: CATALOG_CACHE_AGE };
    }

    // Cold index: fall back to live calls so the addon still works unindexed.
    if (extra.genre) {
      const category = await getCategory('filmid');
      const items = itemsFor(category, extra.genre);
      return {
        metas: items.slice(skip, skip + PAGE_SIZE).map(toMetaPreview),
        cacheMaxAge: CATALOG_CACHE_AGE
      };
    }

    const { items } = await searchVod({
      phrase: extra.search || '',
      viewTypes: ['movie'],
      page: Math.floor(skip / PAGE_SIZE) + 1,
      limit: PAGE_SIZE
    });
    return { metas: items.map(toMetaPreview), cacheMaxAge: CATALOG_CACHE_AGE };
  });

  builder.defineMetaHandler(async ({ id }) => {
    if (isChannelId(id)) {
      const channel = CHANNELS.find((c) => c.key === channelKey(id));
      return { meta: await toChannelMeta(channel), cacheMaxAge: EPG_CACHE_AGE };
    }
    const contentId = Number(toContentId(id));
    const row = getItem(contentId);

    // The season tree is already indexed; rebuilding it live would cost one
    // request per season.
    if (row?.type === 'series') {
      return {
        meta: toSeriesMeta(row, listEpisodes(contentId)),
        cacheMaxAge: META_CACHE_AGE
      };
    }

    const { main } = await getContent(contentId, CATEGORY.video);
    return { meta: toMeta(main), cacheMaxAge: META_CACHE_AGE };
  });

  builder.defineSubtitlesHandler(async ({ id }) => {
    // Live channels carry their subtitle tracks inside the HLS manifest.
    if (isChannelId(id)) return { subtitles: [] };
    try {
      const { main } = await getContent(toContentId(id), CATEGORY.video);
      return { subtitles: subtitlesFor(main), cacheMaxAge: META_CACHE_AGE };
    } catch {
      return { subtitles: [] };
    }
  });

  builder.defineStreamHandler(async ({ id }) => {
    if (isChannelId(id)) {
      const { key, startIso } = parseLiveId(id);
      const channel = CHANNELS.find((c) => c.key === key);
      return {
        streams: await toChannelStreams(channel, startIso),
        cacheMaxAge: LIVE_CACHE_AGE
      };
    }
    const { main } = await getContent(toContentId(id), CATEGORY.video);
    return { streams: toStreams(main), cacheMaxAge: STREAM_CACHE_AGE };
  });

  return builder.getInterface();
}
