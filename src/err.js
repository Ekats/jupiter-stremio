// Thin client for the ERR services API, with a small in-process TTL cache.
// Endpoint shapes are documented in ../JUPITER-API.md

const BASE = 'https://services.err.ee';
const DOMAIN = 'jupiter.err.ee';

// Category ids used by the addon
export const CATEGORY = {
  video: 4133,
  films: 4137
};

const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expires < Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet(key, value, ttlMs) {
  cache.set(key, { value, expires: Date.now() + ttlMs });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A 5xx from this API is usually transient (Cloudflare 520 when the origin is
 * unhappy), so retry those with backoff. A 4xx means the item is genuinely
 * gone, so fail immediately rather than burning attempts.
 */
async function getJson(url, ttlMs, retries = 2) {
  const cached = cacheGet(url);
  if (cached !== undefined) return cached;

  let lastStatus = 0;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await sleep(500 * 2 ** (attempt - 1));

    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(20000)
    });

    if (res.ok) {
      const body = await res.json();
      cacheSet(url, body, ttlMs);
      return body;
    }

    lastStatus = res.status;
    if (res.status < 500) break; // client error: not worth retrying
  }
  const error = new Error(`ERR API ${lastStatus} for ${url}`);
  error.status = lastStatus;
  throw error;
}

const CATEGORY_TTL = 30 * 60 * 1000; // 30 min — front pages change slowly
const CONTENT_TTL = 60 * 60 * 1000; // 1 hour
const SEARCH_TTL = 10 * 60 * 1000; // 10 min

// rootCategoryId that all Jupiter video content carries. The search endpoint
// rejects menu category ids (e.g. 4137 Filmid) with a 500.
export const VIDEO_ROOT = 3905;

// A category front page: blocks of items, each block a themed row.
export async function getCategory(slug) {
  const url = `${BASE}/api/v2/category/getByUrl?url=${encodeURIComponent(slug)}`
    + `&domain=${DOMAIN}&page=web`;
  const body = await getJson(url, CATEGORY_TTL);
  const category = body?.data?.category;
  if (!category) throw new Error(`no category in response for ${slug}`);
  return category;
}

// Detail page for one content item: metadata plus medias[] with stream URLs.
export async function getContent(contentId, rootId = CATEGORY.video) {
  const url = `${BASE}/api/v2/vodContent/getContentPageData`
    + `?contentId=${encodeURIComponent(contentId)}&rootId=${rootId}&page=web`;
  const body = await getJson(url, CONTENT_TTL);
  const main = body?.data?.mainContent;
  if (!main) throw new Error(`no mainContent for ${contentId}`);
  return { main, seasonList: body.data.seasonList, data: body.data };
}

/**
 * Full catalogue search / listing.
 *
 * This is the only paginated view of the library — category front pages only
 * expose a few hundred curated items, while this reports 2223 movies and 1211
 * series. An empty `phrase` lists everything.
 *
 * Paginate with `page`; `offset` is accepted but silently ignored by the API.
 */
export async function searchVod({ phrase = '', viewTypes = ['movie'], page = 1, limit = 100 } = {}) {
  const options = {
    page,
    limit,
    offset: 0,
    category: VIDEO_ROOT,
    phrase,
    types: ['media'],
    searchTypes: ['video'],
    viewTypes,
    now: 0
  };
  const url = `${BASE}/api/search/getVodContents2/?type=`
    + `&options=${encodeURIComponent(JSON.stringify(options))}`;
  const body = await getJson(url, SEARCH_TTL);
  const video = body?.video || {};
  return {
    items: video.contents || [],
    total: video.totalFound || 0
  };
}
