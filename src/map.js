// Maps ERR Jupiter payloads onto Stremio protocol objects.
// Protocol reference: ../STUDY.md, ERR payload shapes: ../JUPITER-API.md

export const ID_PREFIX = 'jupiter-';

export const toStremioId = (contentId) => `${ID_PREFIX}${contentId}`;
export const toContentId = (stremioId) => stremioId.replace(ID_PREFIX, '').split(':')[0];

// ERR photo crop types, by role. Listings expose 2/17/34/60/80, detail pages
// expose 1/2/6/8/11/15, so each role needs an ordered fallback.
const POSTER_TYPES = ['80', '60', '2', '6', '17'];
const BACKGROUND_TYPES = ['2', '6', '17', '15'];

function pickPhoto(sources, preferredTypes) {
  for (const type of preferredTypes) {
    for (const source of sources) {
      const list = Array.isArray(source) ? source : source ? [source] : [];
      for (const photo of list) {
        const url = photo?.photoTypes?.[type]?.url;
        if (url) return absolute(url);
      }
    }
  }
  return undefined;
}

function absolute(url) {
  if (!url) return undefined;
  return url.startsWith('//') ? `https:${url}` : url;
}

function stripHtml(html) {
  if (!html) return undefined;
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim() || undefined;
}

function year(item) {
  const ts = item.publicStart || item.scheduleStart;
  return ts ? String(new Date(ts * 1000).getUTCFullYear()) : undefined;
}

// A catalog row: the lightweight object Stremio renders in a grid.
export function toMetaPreview(item) {
  return clean({
    id: toStremioId(item.id),
    type: 'movie',
    name: item.heading,
    poster: pickPhoto([item.verticalPhotos, item.photos, item.squarePhotos], POSTER_TYPES),
    posterShape: 'poster',
    description: stripHtml(item.lead),
    releaseInfo: year(item)
  });
}

// An ERR listing item flattened into an index row.
export function toRow(item) {
  return {
    id: item.id,
    type: item.type,
    heading: item.heading,
    lead: stripHtml(item.lead) ?? null,
    year: year(item) ? Number(year(item)) : null,
    poster: pickPhoto([item.verticalPhotos, item.photos, item.squarePhotos], POSTER_TYPES) ?? null,
    background: pickPhoto([item.heroImage, item.horizontalPoster, item.photos], BACKGROUND_TYPES) ?? null,
    parentId: item.parentContentId || null,
    season: Number.isInteger(item.season) ? item.season : null,
    episode: Number.isInteger(item.episode) ? item.episode : null
  };
}

// The playability fields enrichment extracts from a detail payload.
export function toEnrichment(main) {
  const media = main.medias?.[0];
  const duration = Number(media?.mediaInfo?.duration);
  return {
    id: main.id,
    folder: media?.folder ?? null,
    drm: Boolean(media?.restrictions?.drm || media?.folder === 'drm'),
    geoBlock: Boolean(media?.restrictions?.geoBlock || (media?.folder || '').startsWith('gb')),
    duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
    // Detail pages carry larger crops than the search endpoint does.
    poster: pickPhoto([main.verticalPhotos, main.photos, main.heroImage], POSTER_TYPES) ?? null,
    background: pickPhoto([main.heroImage, main.photos, main.horizontalPhotos], BACKGROUND_TYPES) ?? null,
    // Stream URLs are NOT derivable from the content id: the path component is
    // mediaHash on newer items and media.id on older ones. They can only be
    // learned from a detail fetch, so store the built stream objects outright.
    streams: toStreams(main)
  };
}

// An index row rendered back out as a Stremio meta preview.
export function rowToPreview(row) {
  return clean({
    id: toStremioId(row.id),
    type: row.type === 'series' ? 'series' : 'movie',
    name: row.heading,
    poster: row.poster || undefined,
    posterShape: 'poster',
    description: row.lead || undefined,
    releaseInfo: row.year ? String(row.year) : undefined
  });
}

const MAKER_ROLES = {
  'Režissöör': 'director',
  'Lavastaja': 'director',
  'Stsenarist': 'writer',
  'Stsenaarium': 'writer',
  'Osades': 'cast',
  'Osatäitja': 'cast',
  'Näitleja': 'cast'
};

function makers(main) {
  const out = { director: [], writer: [], cast: [] };
  for (const maker of main.makers || []) {
    const role = MAKER_ROLES[maker?.type];
    if (role && maker.name) out[role].push(maker.name);
  }
  return out;
}

// The full detail object behind a Stremio detail page.
export function toMeta(main) {
  const media = main.medias?.[0];
  const duration = Number(media?.mediaInfo?.duration);
  const roles = makers(main);

  return clean({
    id: toStremioId(main.id),
    type: 'movie',
    name: main.heading,
    poster: pickPhoto([main.verticalPhotos, main.photos, main.heroImage], POSTER_TYPES),
    posterShape: 'poster',
    background: pickPhoto([main.heroImage, main.photos, main.horizontalPhotos], BACKGROUND_TYPES),
    description: stripHtml(main.lead) || stripHtml(main.body),
    releaseInfo: year(main),
    runtime: Number.isFinite(duration) && duration > 0 ? `${Math.round(duration / 60)} min` : undefined,
    country: main.country || undefined,
    director: roles.director.length ? roles.director : undefined,
    writer: roles.writer.length ? roles.writer : undefined,
    cast: roles.cast.length ? roles.cast : undefined,
    website: main.canonicalUrl || undefined
  });
}

// ERR subtitle language tags -> ISO 639-2, which is what Stremio expects.
const SUBTITLE_LANG = { ET: 'est', VA: 'est', EN: 'eng', RU: 'rus' };

export function toSubtitles(media) {
  return (media.subtitles || [])
    .filter((sub) => sub.src)
    .map((sub, index) => clean({
      id: String(sub.subId ?? index),
      url: sub.src,
      lang: SUBTITLE_LANG[sub.srclang] || sub.srclang?.toLowerCase(),
      // VA is the hard-of-hearing track; without a label it is indistinguishable
      // from the plain Estonian one in the picker.
      label: sub.srclang === 'VA' ? 'eesti (vaegkuuljatele)' : undefined
    }));
}

/**
 * Build the stream list for one media object.
 *
 * Three tiers, keyed on `folder` (see JUPITER-API.md §3):
 *   drm      -> no playable source; hand off to ERR's own player
 *   gb/gbsec -> HLS only (the direct MP4 route 403s for this tier)
 *   other    -> direct MP4 (webReady) plus an HLS alternative
 */
export function toStreams(main) {
  const media = main.medias?.[0];
  if (!media) return [];

  const folder = media.folder || '';
  const pageUrl = main.canonicalUrl || `https://jupiter.err.ee/${main.id}`;

  if (media.restrictions?.drm || folder === 'drm') {
    return [{
      name: 'Jupiter',
      description: 'DRM-kaitsega sisu — ava ERR Jupiteris\nDRM protected — opens in ERR Jupiter',
      externalUrl: pageUrl
    }];
  }

  const geoBlocked = Boolean(media.restrictions?.geoBlock) || folder.startsWith('gb');
  const subtitles = toSubtitles(media);
  const hls = absolute(media.src?.hls || media.src?.hls2 || media.src?.hlsNew);
  const file = absolute(media.src?.file);
  const streams = [];

  const hints = (extra) => clean({
    filename: media.filename || media.file || undefined,
    countryWhitelist: geoBlocked ? ['est'] : undefined,
    ...extra
  });

  // Direct MP4 is seekable and webReady, so prefer it — but it is not served
  // for the geo-restricted tier.
  if (file && !geoBlocked) {
    streams.push(clean({
      name: 'Jupiter',
      description: `${main.heading}\nMP4`,
      url: file,
      subtitles,
      behaviorHints: hints()
    }));
  }

  if (hls) {
    streams.push(clean({
      name: 'Jupiter',
      description: `${main.heading}\nHLS`,
      url: hls,
      subtitles,
      behaviorHints: hints({ notWebReady: true })
    }));
  }

  return streams;
}

function clean(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) =>
      value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0))
  );
}

/**
 * Series detail, assembled from the index rather than from a live fetch:
 * the season tree costs several upstream requests, and it is already stored.
 *
 * `released` is year-precision only — the index keeps the year, not the
 * original publish timestamp.
 */
export function toSeriesMeta(row, episodes) {
  return clean({
    id: toStremioId(row.id),
    type: 'series',
    name: row.heading,
    poster: row.poster || undefined,
    posterShape: 'poster',
    background: row.background || undefined,
    description: row.lead || undefined,
    releaseInfo: row.year ? String(row.year) : undefined,
    videos: episodes.map((episode, index) => clean({
      id: toStremioId(episode.id),
      title: episode.heading || `Episode ${index + 1}`,
      season: Number.isInteger(episode.season) ? episode.season : 1,
      episode: Number.isInteger(episode.episode) ? episode.episode : index + 1,
      released: episode.year ? `${episode.year}-01-01T00:00:00.000Z` : undefined,
      thumbnail: episode.poster || undefined
    }))
  });
}

/** Subtitles for the dedicated `subtitles` resource, from a detail payload. */
export function subtitlesFor(main) {
  return toSubtitles(main.medias?.[0] || {});
}
