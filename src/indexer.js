// Builds the local catalogue index. Two passes:
//
//   discover  — page getVodContents2 for the full library (cheap: ~35 requests
//               for 3400 titles). Gives ids, titles, posters, years.
//   enrich    — fetch each item's detail page to learn its playability tier.
//               One request per title, so it is rate limited, resumable, and
//               safe to re-run: only rows with checked_at IS NULL are fetched.

import { searchVod, getCategory, getContent } from './err.js';
import { toRow, toEnrichment, toStreams } from './map.js';
import {
  openDb, upsertDiscovered, markChecked, markFailed,
  setGenres, pendingIds, stats, upsertEpisodes
} from './db.js';

const PAGE_SIZE = 100;

// Deliberately gentle. An earlier version ran concurrency 5 with no pacing and
// tripped ERR's origin protection, after which every request returned 520.
const CONCURRENCY = 2;
const REQUEST_SPACING_MS = 150;
// If this many fetches fail back to back the upstream is down or throttling
// us; abort rather than marching through the whole catalogue recording
// failures.
const BREAKER_THRESHOLD = 15;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class UpstreamDown extends Error {}

/**
 * Bounded, paced worker pool with a circuit breaker.
 *
 * One item failing is normal — expired content, a deleted page. Every item
 * failing means the upstream is refusing us, and continuing would both hammer
 * a service that is already unhappy and fill the index with false negatives.
 */
async function pool(items, worker, concurrency = CONCURRENCY) {
  let cursor = 0;
  let ok = 0;
  let failed = 0;
  let consecutiveFailures = 0;
  let tripped = false;

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length && !tripped) {
      const item = items[cursor++];
      await sleep(REQUEST_SPACING_MS);
      try {
        await worker(item);
        ok++;
        consecutiveFailures = 0;
      } catch {
        failed++;
        consecutiveFailures++;
        if (consecutiveFailures >= BREAKER_THRESHOLD) tripped = true;
      }
    }
  });
  await Promise.all(runners);

  if (tripped) {
    throw new UpstreamDown(
      `aborted after ${BREAKER_THRESHOLD} consecutive failures — ERR is throttling or down. `
      + 'Progress is saved; re-run later to resume.');
  }
  return { ok, failed };
}

export async function discover(viewType) {
  let page = 1;
  let seen = 0;
  let total = 0;

  for (;;) {
    const { items, total: reported } = await searchVod({
      viewTypes: [viewType], page, limit: PAGE_SIZE
    });
    total = reported;
    if (!items.length) break;

    upsertDiscovered(items.map(toRow));
    seen += items.length;
    process.stdout.write(`\r  ${viewType}: ${seen}/${total}`);

    if (seen >= total) break;
    page++;
  }
  process.stdout.write('\n');
  return seen;
}

// ERR's curated front-page rows, stored so the addon can offer them as genres.
export async function discoverGenres(slug = 'filmid') {
  const category = await getCategory(slug);
  let tagged = 0;
  for (const block of category.frontPage) {
    if (!block.header) continue;
    for (const item of block.data || []) {
      setGenres(item.id, [block.header]);
      tagged++;
    }
  }
  return tagged;
}

export async function enrich(type, max = Infinity) {
  let done = 0;
  let failedTotal = 0;

  for (;;) {
    const batch = pendingIds(type, Math.min(PAGE_SIZE, max - done));
    if (!batch.length) break;

    const { failed } = await pool(batch, async (id) => {
      try {
        const { main } = await getContent(id);
        markChecked({ ...toEnrichment(main), streams: toStreams(main) });
      } catch (error) {
        // Deleted, expired or a 500 — record the attempt so we do not retry
        // it on every run.
        markFailed(id);
        throw error;
      }
    });

    done += batch.length;
    failedTotal += failed;
    process.stdout.write(`\r  enriched ${type}: ${done} (${failedTotal} unavailable)`);
    if (done >= max) break;
  }
  process.stdout.write('\n');
  return done;
}

/**
 * Enrich one series: record its tier and walk its season tree.
 *
 * Two traps here. Requesting a series id returns its *first episode*, so
 * `main.id` is an episode id — the tier must be written against the series id
 * we asked for, not against `main.id`. And seasons load lazily: only the
 * season containing that episode arrives populated, so each remaining season
 * costs a fetch via its `firstContentId`.
 */
async function enrichOneSeries(seriesId) {
  const { main, seasonList } = await getContent(seriesId);
  const tier = { ...toEnrichment(main), id: seriesId };
  markChecked({ ...tier, streams: toStreams(main) });

  const seasons = seasonList?.items || [];
  const episodes = [];

  for (const season of seasons) {
    if (season.contents?.length) {
      episodes.push(...season.contents);
      continue;
    }
    if (!season.firstContentId) continue;
    await sleep(REQUEST_SPACING_MS);
    try {
      const nested = await getContent(season.firstContentId);
      const filled = (nested.seasonList?.items || [])
        .find((candidate) => candidate.id === season.id);
      if (filled?.contents?.length) episodes.push(...filled.contents);
    } catch {
      // A missing season should not lose the seasons we did resolve.
    }
  }

  if (episodes.length) upsertEpisodes(seriesId, episodes.map(toRow), tier);
  return episodes.length;
}

export async function enrichSeries(max = Infinity) {
  let done = 0;
  let episodes = 0;
  let failedTotal = 0;

  for (;;) {
    const batch = pendingIds('series', Math.min(PAGE_SIZE, max - done));
    if (!batch.length) break;

    const { failed } = await pool(batch, async (id) => {
      try {
        // NB: `episodes += await ...` would read the counter before
        // suspending, so concurrent workers lose each other's increments.
        const found = await enrichOneSeries(id);
        episodes += found;
      } catch (error) {
        markFailed(id);
        throw error;
      }
    });

    done += batch.length;
    failedTotal += failed;
    process.stdout.write(`\r  series: ${done} done, ${episodes} episodes (${failedTotal} unavailable)`);
    if (done >= max) break;
  }
  process.stdout.write('\n');
  return { done, episodes };
}

function report() {
  console.log('\nIndex:');
  for (const row of stats()) {
    const pct = row.total ? Math.round((row.checked / row.total) * 100) : 0;
    console.log(`  ${row.type.padEnd(7)} ${String(row.total).padStart(5)} total`
      + `  ${String(row.checked).padStart(5)} checked (${pct}%)`
      + `  ${String(row.drm ?? 0).padStart(4)} drm`
      + `  ${String(row.geo ?? 0).padStart(4)} geo`);
  }
}

const COMMANDS = {
  async discover() {
    openDb();
    console.log('Discovering catalogue...');
    await discover('movie');
    await discover('series');
    const tagged = await discoverGenres();
    console.log(`  genres: ${tagged} tags`);
    report();
  },
  async enrich() {
    openDb();
    const max = Number(process.argv[3]) || Infinity;
    const type = process.argv[4] || 'movie';
    console.log(`Enriching ${type} (resumable, re-run to continue)...`);
    try {
      await enrich(type, max);
    } catch (error) {
      if (!(error instanceof UpstreamDown)) throw error;
      console.error(`\n  ${error.message}`);
      report();
      process.exit(2);
    }
    report();
  },
  async series() {
    openDb();
    const max = Number(process.argv[3]) || Infinity;
    console.log('Enriching series + episode trees (resumable)...');
    try {
      await enrichSeries(max);
    } catch (error) {
      if (!(error instanceof UpstreamDown)) throw error;
      console.error(`\n  ${error.message}`);
      report();
      process.exit(2);
    }
    report();
  },
  async stats() {
    openDb();
    report();
  }
};

const command = process.argv[2];
if (command) {
  const run = COMMANDS[command];
  if (!run) {
    console.error(`unknown command: ${command}\nusage: node src/indexer.js <discover|enrich|stats> [max]`);
    process.exit(1);
  }
  await run();
}
