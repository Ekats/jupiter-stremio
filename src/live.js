// Live TV: ERR's linear channels plus a programme guide.
//
// Stremio's Native EPG has no dedicated resource — it reuses catalog/meta/
// stream. See refs/stremio-addon-sdk/docs/epg.md.

import { ID_PREFIX, toStreams } from './map.js';
import { getContent } from './err.js';

const BASE = 'https://services.err.ee';

// Verified clear (isGeoBlocked: false) with a live HLS manifest and a real
// programme schedule.
//
// `r4video` is deliberately excluded: the API advertises it with
// isSpecial: true, but its manifest 404s and it carries no schedule — it is an
// event channel ERR only activates for specific broadcasts.
export const CHANNELS = [
  { key: 'etv', name: 'ETV' },
  { key: 'etv2', name: 'ETV2' },
  { key: 'etvpluss', name: 'ETV+' }
];

const CHANNEL_KEYS = new Set(CHANNELS.map((c) => c.key));

/**
 * Resolve any live id back to its channel.
 *
 * Clicking a programme in the guide makes Stremio ask for that programme's id
 * (`jupiter-etv:epg:<iso>`), but playback identity is always the channel — so
 * everything after the first colon is dropped.
 */
export const channelKey = (id) => String(id).replace(ID_PREFIX, '').split(':')[0];
export const isChannelId = (id) => CHANNEL_KEYS.has(channelKey(id));
export const channelId = (key) => `${ID_PREFIX}${key}`;

/** `jupiter-etv:epg:<iso>` -> { key: 'etv', startIso: '<iso>' } */
export function parseLiveId(id) {
  const rest = String(id).replace(ID_PREFIX, '');
  const [key, marker, ...tail] = rest.split(':');
  return { key, startIso: marker === 'epg' ? tail.join(':') : undefined };
}

const cache = new Map();
async function getJson(url, ttlMs) {
  const hit = cache.get(url);
  if (hit && hit.expires > Date.now()) return hit.value;
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`ERR live ${res.status} for ${url}`);
  const value = await res.json();
  cache.set(url, { value, expires: Date.now() + ttlMs });
  return value;
}

const absolute = (url) => (url ? (url.startsWith('//') ? `https:${url}` : url) : undefined);

export const getLiveMedia = (key) =>
  getJson(`${BASE}/api/live/getLiveMediaData?channelName=${encodeURIComponent(key)}`, 10 * 60 * 1000);

export const getSchedule = (key) =>
  getJson(`${BASE}/api/tvSchedule/getExactSchedules?type=player&channel=${encodeURIComponent(key)}`, 10 * 60 * 1000)
    .catch(() => []);

const iso = (unixSeconds) => new Date(unixSeconds * 1000).toISOString();

/**
 * One EPG entry as a Stremio programme. A video only lands on the guide grid
 * when both startTime and endTime are present and end is strictly after start.
 */
function toProgramme(key, entry) {
  const start = Number(entry.startTime);
  const end = Number(entry.endTime || entry.endSlotTime);
  if (!start || !end || end <= start) return null;

  const title = entry.heading || entry.seriesTitle || entry.nameShort || 'Saade';
  const minutes = Math.round((end - start) / 60);

  return clean({
    id: `${channelId(key)}:epg:${iso(start)}`,
    title,
    overview: entry.lead || entry.extension || undefined,
    thumbnail: absolute(entry.photoUrl || entry.mobilePhotoUrl),
    released: iso(start),
    startTime: iso(start),
    endTime: iso(end),
    runtime: minutes > 0 ? `${minutes} min` : undefined,
    releaseInfo: entry.year ? String(entry.year) : undefined
  });
}

export async function rawEntry(key, startIso) {
  const entries = await getSchedule(key);
  const target = Date.parse(startIso);
  if (!Array.isArray(entries) || Number.isNaN(target)) return undefined;
  return entries.find((entry) => Number(entry.startTime) * 1000 === target);
}

export async function programmesFor(key, date) {
  const entries = await getSchedule(key);
  const all = (Array.isArray(entries) ? entries : [])
    .map((entry) => toProgramme(key, entry))
    .filter(Boolean);
  if (!date) return all;

  // Keep programmes overlapping the requested UTC day. A local day can span
  // two UTC dates; Stremio requests each and merges.
  const from = Date.parse(`${date}T00:00:00.000Z`);
  const to = Date.parse(`${date}T23:59:59.999Z`);
  if (Number.isNaN(from)) return all;
  return all.filter((p) => Date.parse(p.endTime) > from && Date.parse(p.startTime) < to);
}

async function channelArt(key) {
  try {
    const media = await getLiveMedia(key);
    return absolute(media?.config?.imgSrc);
  } catch {
    return undefined;
  }
}

export async function toChannelPreview(channel) {
  return clean({
    id: channelId(channel.key),
    type: 'tv',
    name: channel.name,
    poster: await channelArt(channel.key),
    posterShape: 'square',
    behaviorHints: { isLive: true }
  });
}

export async function toChannelMeta(channel, date) {
  const [poster, videos] = await Promise.all([
    channelArt(channel.key),
    programmesFor(channel.key, date)
  ]);
  return clean({
    id: channelId(channel.key),
    type: 'tv',
    name: channel.name,
    poster,
    posterShape: 'square',
    background: poster,
    description: `${channel.name} — otseülekanne`,
    behaviorHints: { isLive: true, hasScheduledVideos: videos.length > 0 },
    videos
  });
}

async function liveStream(channel) {
  const media = await getLiveMedia(channel.key);
  const url = absolute(media?.src);
  if (!url) return [];
  const bingeGroup = `jupiter-live-${channel.key}`;
  return [
    // Played directly by Stremio's player, which follows the manifest's
    // separate WebVTT subtitle renditions — the same way ERR's own web player
    // does. The streaming-server path below does not: its probe reports zero
    // subtitle tracks for this stream.
    {
      name: 'Jupiter',
      description: `${channel.name}\nOtse · HLS`,
      url,
      behaviorHints: { bingeGroup }
    },
    // Fallback via the local streaming server, for clients that cannot play
    // HLS directly. No subtitles on this one.
    {
      name: 'Jupiter',
      description: `${channel.name}\nOtse · HLS (server, no subs)`,
      url,
      behaviorHints: { notWebReady: true, bingeGroup: `${bingeGroup}-srv` }
    }
  ];
}

/**
 * Streams for a channel, or for one of its programmes.
 *
 * Programmes that have already aired are usually available on demand: the EPG
 * entry carries `mediaExists` and a `contentId` pointing at the ordinary VOD
 * item, so catch-up is resolved through exactly the same path as a film. The
 * live channel is always offered too, so the viewer can jump back to air.
 */
export async function toChannelStreams(channel, startIso) {
  if (!startIso) return liveStream(channel);

  const entry = await rawEntry(channel.key, startIso).catch(() => undefined);
  const aired = entry && Number(entry.endTime) * 1000 < Date.now();
  const catchUp = [];

  if (aired && entry.mediaExists && entry.contentId && !entry.drm) {
    try {
      const { main } = await getContent(entry.contentId);
      for (const stream of toStreams(main)) {
        catchUp.push({
          ...stream,
          name: 'Jupiter',
          description: `${entry.heading || channel.name}\nJärelvaatamine · ${stream.description?.split('\n').pop() || ''}`.trim()
        });
      }
    } catch {
      // Fall through to the live stream rather than returning nothing.
    }
  }

  return [...catchUp, ...(await liveStream(channel))];
}

function clean(object) {
  return Object.fromEntries(Object.entries(object).filter(([, v]) =>
    v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0)));
}
