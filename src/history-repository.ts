import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { RecentTrack } from "./domain.js";
import { toIso } from "./time.js";

type SqlRow = Record<string, unknown>;

export type HistoryStatus = {
  username: string;
  indexedScrobbles: number;
  oldestScrobbleAt: string | null;
  newestScrobbleAt: string | null;
  fullHistorySynced: boolean;
  coveredThroughAt: string | null;
  lastSyncAt: string | null;
  lastSyncMode: string | null;
  fullSyncInProgress: boolean;
};

export type HistorySearch = {
  tracks: RecentTrack[];
  matched: number;
  status: HistoryStatus;
};

export type HistoryAggregate = {
  total: number;
  uniqueArtists: number;
  uniqueAlbums: number;
  uniqueTracks: number;
  tracksWithAlbum: number;
  topTrackPlays: number;
  topTenTrackPlays: number;
};

export type WindowArtistCount = { artist: string; plays: number };

export class HistoryRepository {
  private readonly db: DatabaseSync;

  constructor(readonly path: string) {
    const absolutePath = resolve(path);
    mkdirSync(dirname(absolutePath), { recursive: true });
    this.db = new DatabaseSync(absolutePath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  upsertTracks(username: string, tracks: RecentTrack[]): number {
    const scrobbles = tracks.filter((track) => !track.nowPlaying && track.playedAtUnix !== null);
    if (scrobbles.length === 0) return 0;

    const insert = this.db.prepare(`
      INSERT INTO scrobbles (
        username, played_at_unix, artist, artist_key, album, album_key,
        track, track_key, artist_mbid, album_mbid, track_mbid, url, loved
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(username, played_at_unix, artist_key, album_key, track_key)
      DO UPDATE SET
        artist_mbid = excluded.artist_mbid,
        album_mbid = excluded.album_mbid,
        track_mbid = excluded.track_mbid,
        url = excluded.url,
        loved = MAX(scrobbles.loved, excluded.loved)
    `);

    let changed = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const track of scrobbles) {
        const result = insert.run(
          username,
          track.playedAtUnix,
          track.artist,
          normalize(track.artist),
          track.album,
          normalize(track.album ?? ""),
          track.name,
          normalize(track.name),
          track.artistMbid,
          track.albumMbid,
          track.mbid,
          track.url,
          track.loved ? 1 : 0,
        );
        changed += Number(result.changes);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return changed;
  }

  getStatus(username: string): HistoryStatus {
    const aggregate = this.db
      .prepare(`
        SELECT COUNT(*) AS count, MIN(played_at_unix) AS oldest, MAX(played_at_unix) AS newest
        FROM scrobbles WHERE username = ?
      `)
      .get(username) as SqlRow;
    const sync = this.db.prepare("SELECT * FROM sync_state WHERE username = ?").get(username) as SqlRow | undefined;
    return {
      username,
      indexedScrobbles: numberOf(aggregate.count),
      oldestScrobbleAt: toIso(nullableNumber(aggregate.oldest)),
      newestScrobbleAt: toIso(nullableNumber(aggregate.newest)),
      fullHistorySynced: numberOf(sync?.full_history_synced) === 1,
      coveredThroughAt: toIso(nullableNumber(sync?.coverage_through_unix)),
      lastSyncAt: toIso(nullableNumber(sync?.last_sync_at_unix)),
      lastSyncMode: nullableString(sync?.last_sync_mode),
      fullSyncInProgress: nullableNumber(sync?.full_sync_cursor_unix) !== null,
    };
  }

  markSync(
    username: string,
    mode: string,
    completedFullHistory: boolean,
    nowUnix: number,
    coverageThroughUnix?: number,
  ): void {
    this.db.prepare(`
      INSERT INTO sync_state (username, full_history_synced, last_sync_at_unix, last_sync_mode, coverage_through_unix)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(username) DO UPDATE SET
        full_history_synced = MAX(sync_state.full_history_synced, excluded.full_history_synced),
        last_sync_at_unix = excluded.last_sync_at_unix,
        last_sync_mode = excluded.last_sync_mode,
        coverage_through_unix = CASE
          WHEN excluded.coverage_through_unix IS NULL THEN sync_state.coverage_through_unix
          WHEN sync_state.coverage_through_unix IS NULL THEN excluded.coverage_through_unix
          ELSE MAX(sync_state.coverage_through_unix, excluded.coverage_through_unix)
        END
    `).run(username, completedFullHistory ? 1 : 0, nowUnix, mode, coverageThroughUnix ?? null);
  }

  getFullSyncProgress(username: string): { cursorUnix: number; upperUnix: number } | null {
    const row = this.db.prepare(`
      SELECT full_sync_cursor_unix, full_sync_upper_unix FROM sync_state WHERE username = ?
    `).get(username) as SqlRow | undefined;
    const cursorUnix = nullableNumber(row?.full_sync_cursor_unix);
    const upperUnix = nullableNumber(row?.full_sync_upper_unix);
    return cursorUnix === null || upperUnix === null ? null : { cursorUnix, upperUnix };
  }

  setFullSyncProgress(username: string, cursorUnix: number, upperUnix: number): void {
    this.db.prepare(`
      INSERT INTO sync_state (username, full_history_synced, full_sync_cursor_unix, full_sync_upper_unix)
      VALUES (?, 0, ?, ?)
      ON CONFLICT(username) DO UPDATE SET
        full_sync_cursor_unix = excluded.full_sync_cursor_unix,
        full_sync_upper_unix = excluded.full_sync_upper_unix
    `).run(username, cursorUnix, upperUnix);
  }

  clearFullSyncProgress(username: string): void {
    this.db.prepare(`
      UPDATE sync_state SET full_sync_cursor_unix = NULL, full_sync_upper_unix = NULL WHERE username = ?
    `).run(username);
  }

  search(
    username: string,
    input: {
      artist?: string;
      album?: string;
      track?: string;
      from?: number;
      to?: number;
      exactMatch: boolean;
      limit: number;
    },
  ): HistorySearch {
    const conditions = ["username = ?"];
    const values: SQLInputValue[] = [username];
    addTextFilter(conditions, values, "artist_key", input.artist, input.exactMatch);
    addTextFilter(conditions, values, "album_key", input.album, input.exactMatch);
    addTextFilter(conditions, values, "track_key", input.track, input.exactMatch);
    if (input.from !== undefined) {
      conditions.push("played_at_unix >= ?");
      values.push(input.from);
    }
    if (input.to !== undefined) {
      conditions.push("played_at_unix <= ?");
      values.push(input.to);
    }

    const where = conditions.join(" AND ");
    const countRow = this.db.prepare(`SELECT COUNT(*) AS count FROM scrobbles WHERE ${where}`).get(...values) as SqlRow;
    const rows = this.db
      .prepare(`SELECT * FROM scrobbles WHERE ${where} ORDER BY played_at_unix DESC LIMIT ?`)
      .all(...values, input.limit) as SqlRow[];

    return {
      tracks: rows.map(rowToTrack),
      matched: numberOf(countRow.count),
      status: this.getStatus(username),
    };
  }

  aggregate(username: string, from: number, to: number): HistoryAggregate {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        COUNT(DISTINCT artist_key) AS unique_artists,
        COUNT(DISTINCT CASE WHEN album_key <> '' THEN artist_key || char(0) || album_key END) AS unique_albums,
        COUNT(DISTINCT artist_key || char(0) || track_key) AS unique_tracks,
        SUM(CASE WHEN album_key <> '' THEN 1 ELSE 0 END) AS tracks_with_album
      FROM scrobbles
      WHERE username = ? AND played_at_unix BETWEEN ? AND ?
    `).get(username, from, to) as SqlRow;
    const concentrations = this.db.prepare(`
      SELECT plays FROM (
        SELECT COUNT(*) AS plays
        FROM scrobbles
        WHERE username = ? AND played_at_unix BETWEEN ? AND ?
        GROUP BY artist_key, track_key
        ORDER BY plays DESC
        LIMIT 10
      )
    `).all(username, from, to) as SqlRow[];
    return {
      total: numberOf(row.total),
      uniqueArtists: numberOf(row.unique_artists),
      uniqueAlbums: numberOf(row.unique_albums),
      uniqueTracks: numberOf(row.unique_tracks),
      tracksWithAlbum: numberOf(row.tracks_with_album),
      topTrackPlays: numberOf(concentrations[0]?.plays),
      topTenTrackPlays: concentrations.reduce((sum, item) => sum + numberOf(item.plays), 0),
    };
  }

  artistCounts(username: string, from: number, to: number, limit = 200): WindowArtistCount[] {
    return (this.db.prepare(`
      SELECT artist, COUNT(*) AS plays
      FROM scrobbles
      WHERE username = ? AND played_at_unix BETWEEN ? AND ?
      GROUP BY artist_key
      ORDER BY plays DESC
      LIMIT ?
    `).all(username, from, to, limit) as SqlRow[]).map((row) => ({
      artist: String(row.artist),
      plays: numberOf(row.plays),
    }));
  }

  recentSequence(username: string, from: number, to: number, limit = 10_000): RecentTrack[] {
    return (this.db.prepare(`
      SELECT * FROM scrobbles
      WHERE username = ? AND played_at_unix BETWEEN ? AND ?
      ORDER BY played_at_unix ASC
      LIMIT ?
    `).all(username, from, to, limit) as SqlRow[]).map(rowToTrack);
  }

  recentDiscoveries(username: string, since: number, limit = 20): Array<{ artist: string; firstPlayedAt: string; playsSince: number }> {
    return (this.db.prepare(`
      SELECT artist, MIN(played_at_unix) AS first_played, COUNT(*) AS plays_since
      FROM scrobbles
      WHERE username = ?
      GROUP BY artist_key
      HAVING MIN(played_at_unix) >= ?
      ORDER BY plays_since DESC, first_played DESC
      LIMIT ?
    `).all(username, since, limit) as SqlRow[]).map((row) => ({
      artist: String(row.artist),
      firstPlayedAt: toIso(numberOf(row.first_played)) ?? "",
      playsSince: numberOf(row.plays_since),
    }));
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scrobbles (
        username TEXT NOT NULL,
        played_at_unix INTEGER NOT NULL,
        artist TEXT NOT NULL,
        artist_key TEXT NOT NULL,
        album TEXT,
        album_key TEXT NOT NULL,
        track TEXT NOT NULL,
        track_key TEXT NOT NULL,
        artist_mbid TEXT,
        album_mbid TEXT,
        track_mbid TEXT,
        url TEXT NOT NULL,
        loved INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (username, played_at_unix, artist_key, album_key, track_key)
      );
      CREATE INDEX IF NOT EXISTS idx_scrobbles_user_time
        ON scrobbles (username, played_at_unix DESC);
      CREATE INDEX IF NOT EXISTS idx_scrobbles_user_artist
        ON scrobbles (username, artist_key, played_at_unix DESC);
      CREATE INDEX IF NOT EXISTS idx_scrobbles_user_album
        ON scrobbles (username, album_key, played_at_unix DESC);
      CREATE INDEX IF NOT EXISTS idx_scrobbles_user_track
        ON scrobbles (username, track_key, played_at_unix DESC);
      CREATE TABLE IF NOT EXISTS sync_state (
        username TEXT PRIMARY KEY,
        full_history_synced INTEGER NOT NULL DEFAULT 0,
        last_sync_at_unix INTEGER,
        last_sync_mode TEXT,
        coverage_through_unix INTEGER,
        full_sync_cursor_unix INTEGER,
        full_sync_upper_unix INTEGER
      );
    `);
    const syncColumns = new Set((this.db.prepare("PRAGMA table_info(sync_state)").all() as SqlRow[]).map((row) => String(row.name)));
    if (!syncColumns.has("coverage_through_unix")) this.db.exec("ALTER TABLE sync_state ADD COLUMN coverage_through_unix INTEGER");
    if (!syncColumns.has("full_sync_cursor_unix")) this.db.exec("ALTER TABLE sync_state ADD COLUMN full_sync_cursor_unix INTEGER");
    if (!syncColumns.has("full_sync_upper_unix")) this.db.exec("ALTER TABLE sync_state ADD COLUMN full_sync_upper_unix INTEGER");
  }
}

function addTextFilter(
  conditions: string[],
  values: SQLInputValue[],
  column: string,
  rawValue: string | undefined,
  exactMatch: boolean,
): void {
  if (!rawValue) return;
  const value = normalize(rawValue);
  if (exactMatch) {
    conditions.push(`${column} = ?`);
    values.push(value);
  } else {
    conditions.push(`${column} LIKE ? ESCAPE '\\'`);
    values.push(`%${escapeLike(value)}%`);
  }
}

function rowToTrack(row: SqlRow): RecentTrack {
  const unix = numberOf(row.played_at_unix);
  return {
    name: String(row.track),
    artist: String(row.artist),
    album: nullableString(row.album),
    mbid: nullableString(row.track_mbid),
    artistMbid: nullableString(row.artist_mbid),
    albumMbid: nullableString(row.album_mbid),
    url: String(row.url),
    loved: numberOf(row.loved) === 1,
    nowPlaying: false,
    playedAt: toIso(unix),
    playedAtUnix: unix,
  };
}

export function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("und").normalize("NFKC");
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function numberOf(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : numberOf(value);
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}
