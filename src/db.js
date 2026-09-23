// Local catalogue index.
//
// Why this exists: ERR listing payloads carry no `medias`, so playability
// (DRM / geo tier) is unknown until a per-item detail fetch. Resolving that at
// request time would mean one upstream call per catalogue row. Instead we
// resolve it once, ahead of time, and serve catalogues from here — the
// index-then-serve model from STUDY.md section 4.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DB_PATH = process.env.JUPITER_DB || 'data/jupiter.db';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS item (
  id            INTEGER PRIMARY KEY,   -- ERR contentId
  type          TEXT    NOT NULL,      -- movie | series | episode
  heading       TEXT    NOT NULL,
  lead          TEXT,
  year          INTEGER,
  poster        TEXT,
  background    TEXT,
  parent_id     INTEGER,               -- series id, for episodes
  season        INTEGER,
  episode       INTEGER,
  folder        TEXT,                  -- vod | gb | gbsec | drm | ...
  drm           INTEGER,               -- 1 = unplayable inline
  geo_block     INTEGER,
  duration      INTEGER,               -- seconds
  discovered_at INTEGER NOT NULL,
  checked_at    INTEGER,               -- NULL = detail never fetched
  streams_json  TEXT,                  -- rendered Stremio streams, for static export
  attempts      INTEGER NOT NULL DEFAULT 0,
  failed_at     INTEGER                -- last failed detail fetch
);
CREATE INDEX IF NOT EXISTS idx_item_type    ON item(type, drm);
CREATE INDEX IF NOT EXISTS idx_item_parent  ON item(parent_id, season, episode);
CREATE INDEX IF NOT EXISTS idx_item_checked ON item(checked_at);

CREATE TABLE IF NOT EXISTS item_genre (
  item_id INTEGER NOT NULL,
  genre   TEXT    NOT NULL,
  PRIMARY KEY (item_id, genre)
);
CREATE INDEX IF NOT EXISTS idx_genre ON item_genre(genre);
`;

let db;

export function openDb() {
  if (db) return db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}

// Discovery writes catalogue-level fields and must not clobber the richer
// values that enrichment later fills in.
export function upsertDiscovered(rows) {
  const handle = openDb();
  const statement = handle.prepare(`
    INSERT INTO item (id, type, heading, lead, year, poster, background,
                      parent_id, season, episode, discovered_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(id) DO UPDATE SET
      type       = excluded.type,
      heading    = excluded.heading,
      lead       = COALESCE(excluded.lead, item.lead),
      year       = COALESCE(excluded.year, item.year),
      poster     = COALESCE(item.poster, excluded.poster),
      background = COALESCE(item.background, excluded.background),
      parent_id  = COALESCE(excluded.parent_id, item.parent_id),
      season     = COALESCE(excluded.season, item.season),
      episode    = COALESCE(excluded.episode, item.episode)
  `);
  handle.exec('BEGIN');
  try {
    for (const r of rows) {
      statement.run(r.id, r.type, r.heading, r.lead ?? null, r.year ?? null,
        r.poster ?? null, r.background ?? null, r.parentId ?? null,
        r.season ?? null, r.episode ?? null);
    }
    handle.exec('COMMIT');
  } catch (error) {
    handle.exec('ROLLBACK');
    throw error;
  }
}

export function markChecked(row) {
  openDb().prepare(`
    UPDATE item SET folder = ?, drm = ?, geo_block = ?, duration = ?,
                    poster = COALESCE(?, poster),
                    background = COALESCE(?, background),
                    streams_json = COALESCE(?, streams_json),
                    checked_at = unixepoch()
    WHERE id = ?
  `).run(row.folder ?? 'none', row.drm ? 1 : 0, row.geoBlock ? 1 : 0,
    row.duration ?? null, row.poster ?? null, row.background ?? null,
    row.streams ? JSON.stringify(row.streams) : null, row.id);
}

// Items still missing baked stream URLs. Episodes inherit tier from their
// parent but each still needs its own media reference, which is not derivable
// from the content id.
export function pendingStreamIds(type, limit) {
  return openDb().prepare(`
    SELECT id FROM item
    WHERE type = ? AND drm = 0 AND streams_json IS NULL
      AND attempts < 4
      AND (failed_at IS NULL OR failed_at < unixepoch() - 3600)
    LIMIT ?
  `).all(type, limit).map((r) => r.id);
}

/**
 * Detail fetch failed. Deliberately does NOT set checked_at: a failure means
 * "unknown", not "checked and clean". Setting checked_at here would bake a
 * transient upstream outage into the index as permanent truth.
 */
export function markFailed(id) {
  openDb().prepare(
    'UPDATE item SET attempts = attempts + 1, failed_at = unixepoch() WHERE id = ?'
  ).run(id);
}

export function setGenres(itemId, genres) {
  const handle = openDb();
  const statement = handle.prepare(
    'INSERT OR IGNORE INTO item_genre (item_id, genre) VALUES (?, ?)');
  for (const genre of genres) statement.run(itemId, genre);
}

const RETRY_AFTER = 3600; // seconds before a failed item is tried again
const MAX_ATTEMPTS = 4;

export function pendingIds(type, limit) {
  return openDb().prepare(`
    SELECT id FROM item
    WHERE type = ? AND checked_at IS NULL
      AND attempts < ?
      AND (failed_at IS NULL OR failed_at < unixepoch() - ?)
    ORDER BY attempts ASC
    LIMIT ?
  `).all(type, MAX_ATTEMPTS, RETRY_AFTER, limit).map((row) => row.id);
}

// Undo rows that a failed pass wrongly recorded as checked-with-no-data.
export function repairUncheckedRows() {
  const result = openDb().prepare(
    'UPDATE item SET checked_at = NULL WHERE checked_at IS NOT NULL AND folder IS NULL'
  ).run();
  return result.changes;
}

/**
 * Catalogue query.
 *
 * DRM titles are listed rather than hidden: they are real catalogue entries
 * with metadata, and selecting one hands off to ERR's own player. Hiding them
 * made that handoff unreachable and the catalogue silently incomplete.
 */
export function listItems({ type = 'movie', genre, search, skip = 0, limit = 100 }) {
  const where = ['type = ?'];
  const params = [type];

  if (genre) {
    where.push('id IN (SELECT item_id FROM item_genre WHERE genre = ?)');
    params.push(genre);
  }
  if (search) {
    where.push('heading LIKE ?');
    params.push(`%${search}%`);
  }
  params.push(limit, skip);

  return openDb().prepare(`
    SELECT * FROM item WHERE ${where.join(' AND ')}
    ORDER BY year DESC, heading ASC LIMIT ? OFFSET ?
  `).all(...params);
}

export function getItem(id) {
  return openDb().prepare('SELECT * FROM item WHERE id = ?').get(id);
}

export function genres() {
  return openDb()
    .prepare('SELECT genre, count(*) n FROM item_genre GROUP BY genre ORDER BY n DESC')
    .all();
}

export function stats() {
  return openDb().prepare(`
    SELECT type,
           count(*)                                      AS total,
           sum(checked_at IS NOT NULL)                   AS checked,
           sum(failed_at IS NOT NULL AND checked_at IS NULL) AS failing,
           sum(drm = 1)                                  AS drm,
           sum(geo_block = 1)                            AS geo
    FROM item GROUP BY type
  `).all();
}

/**
 * Episodes discovered from a series' seasonList.
 *
 * Tier is inherited from the parent rather than fetched per episode: sampling
 * found episode tier class uniform within a series in 10/10 cases, so one
 * fetch per series replaces one per episode. `checked_at` is set so the
 * enrichment pass skips them.
 */
export function upsertEpisodes(seriesId, episodes, tier) {
  const handle = openDb();
  const statement = handle.prepare(`
    INSERT INTO item (id, type, heading, lead, year, poster, background,
                      parent_id, season, episode, folder, drm, geo_block,
                      discovered_at, checked_at)
    VALUES (?, 'episode', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
    ON CONFLICT(id) DO UPDATE SET
      heading    = excluded.heading,
      parent_id  = excluded.parent_id,
      season     = excluded.season,
      episode    = excluded.episode,
      poster     = COALESCE(item.poster, excluded.poster),
      folder     = excluded.folder,
      drm        = excluded.drm,
      geo_block  = excluded.geo_block,
      checked_at = unixepoch()
  `);
  handle.exec('BEGIN');
  try {
    for (const e of episodes) {
      statement.run(e.id, e.heading, e.lead ?? null, e.year ?? null,
        e.poster ?? null, e.background ?? null, seriesId,
        e.season ?? null, e.episode ?? null,
        tier.folder ?? 'none', tier.drm ? 1 : 0, tier.geoBlock ? 1 : 0);
    }
    handle.exec('COMMIT');
  } catch (error) {
    handle.exec('ROLLBACK');
    throw error;
  }
}

export function listEpisodes(seriesId) {
  return openDb().prepare(`
    SELECT * FROM item WHERE parent_id = ? AND type = 'episode'
    ORDER BY season ASC, episode ASC
  `).all(seriesId);
}

// Every item that has stored stream objects, for the static export.
export function itemsWithStreams(type) {
  return openDb().prepare(
    "SELECT id, type, streams_json FROM item WHERE type = ? AND streams_json IS NOT NULL"
  ).all(type);
}
