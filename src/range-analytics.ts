import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { toIso } from "./time.js";

// Arbitrary-range rankings and comparisons computed from the local index.
//
// Upstream's get_top_* and compare_listening_periods only accept Last.fm's
// fixed chart periods (7day, 1month, ...) and query Last.fm live. Here the
// local index is the source of truth, so any from/to works and the numbers
// match what the other local tools report.

export type RangeDimension = "artist" | "album" | "track";

export type TimeRange = { from?: number; to?: number };

export type RankedEntity = {
  rank: number;
  key: string;
  artist: string;
  album: string | null;
  track: string | null;
  plays: number;
  share: number;
  firstPlayedAt: string | null;
  lastPlayedAt: string | null;
};

export type RangeTop = {
  from: string | null;
  to: string | null;
  dimension: RangeDimension;
  totalPlays: number;
  distinctEntities: number;
  items: RankedEntity[];
};

export type ComparedEntity = {
  key: string;
  artist: string;
  album: string | null;
  track: string | null;
  currentPlays: number;
  previousPlays: number;
  currentShare: number;
  previousShare: number;
  shareChange: number;
  currentRank: number | null;
  previousRank: number | null;
};

export type RangeComparison = {
  dimension: RangeDimension;
  current: { from: string | null; to: string | null; totalPlays: number; distinctEntities: number };
  previous: { from: string | null; to: string | null; totalPlays: number; distinctEntities: number };
  rising: ComparedEntity[];
  falling: ComparedEntity[];
  new: ComparedEntity[];
  dropped: ComparedEntity[];
};

type Row = {
  entity_key: string;
  artist: string;
  album: string | null;
  track: string | null;
  plays: number;
  first_played: number;
  last_played: number;
};

export class RangeAnalytics {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    const absolutePath = resolve(path);
    mkdirSync(dirname(absolutePath), { recursive: true });
    this.db = new DatabaseSync(absolutePath);
    this.db.exec("PRAGMA busy_timeout = 5000;");
  }

  close(): void {
    this.db.close();
  }

  getDailyPlays(username: string, from?: string, to?: string): DailyPlays[] {
    return dailyPlays(this.db, username, from, to);
  }

  getTop(username: string, range: TimeRange, dimension: RangeDimension, limit: number): RangeTop {
    assertRange(range);
    const rows = this.aggregate(username, range, dimension);
    const totalPlays = this.totalPlays(username, range, dimension);
    return {
      from: toIso(range.from),
      to: toIso(range.to),
      dimension,
      totalPlays,
      distinctEntities: rows.length,
      items: rows.slice(0, limit).map((row, index) => ({
        rank: index + 1,
        key: row.entity_key,
        artist: row.artist,
        album: row.album,
        track: row.track,
        plays: row.plays,
        share: ratio(row.plays, totalPlays),
        firstPlayedAt: toIso(row.first_played),
        lastPlayedAt: toIso(row.last_played),
      })),
    };
  }

  compare(
    username: string,
    current: TimeRange,
    previous: TimeRange,
    dimension: RangeDimension,
    limit: number,
  ): RangeComparison {
    assertRange(current);
    assertRange(previous);
    const currentRows = this.aggregate(username, current, dimension);
    const previousRows = this.aggregate(username, previous, dimension);
    const currentTotal = this.totalPlays(username, current, dimension);
    const previousTotal = this.totalPlays(username, previous, dimension);
    const currentRanks = new Map(currentRows.map((row, index) => [row.entity_key, { row, rank: index + 1 }]));
    const previousRanks = new Map(previousRows.map((row, index) => [row.entity_key, { row, rank: index + 1 }]));

    const compared: ComparedEntity[] = [];
    for (const key of new Set([...currentRanks.keys(), ...previousRanks.keys()])) {
      const now = currentRanks.get(key);
      const before = previousRanks.get(key);
      const display = (now ?? before)!.row;
      const currentShare = ratio(now?.row.plays ?? 0, currentTotal);
      const previousShare = ratio(before?.row.plays ?? 0, previousTotal);
      compared.push({
        key,
        artist: display.artist,
        album: display.album,
        track: display.track,
        currentPlays: now?.row.plays ?? 0,
        previousPlays: before?.row.plays ?? 0,
        currentShare,
        previousShare,
        shareChange: round(currentShare - previousShare),
        currentRank: now?.rank ?? null,
        previousRank: before?.rank ?? null,
      });
    }

    const both = compared.filter((item) => item.currentPlays > 0 && item.previousPlays > 0);
    return {
      dimension,
      current: { from: toIso(current.from), to: toIso(current.to), totalPlays: currentTotal, distinctEntities: currentRows.length },
      previous: { from: toIso(previous.from), to: toIso(previous.to), totalPlays: previousTotal, distinctEntities: previousRows.length },
      rising: both.filter((item) => item.shareChange > 0).sort((a, b) => b.shareChange - a.shareChange).slice(0, limit),
      falling: both.filter((item) => item.shareChange < 0).sort((a, b) => a.shareChange - b.shareChange).slice(0, limit),
      new: compared.filter((item) => item.previousPlays === 0).sort((a, b) => b.currentPlays - a.currentPlays).slice(0, limit),
      dropped: compared.filter((item) => item.currentPlays === 0).sort((a, b) => b.previousPlays - a.previousPlays).slice(0, limit),
    };
  }

  private aggregate(username: string, range: TimeRange, dimension: RangeDimension): Row[] {
    const { where, values } = rangeFilter(username, range, dimension);
    // Canonical keys merge spelling/edition variants once the canonical index
    // has run; rows not indexed yet fall back to the normalized raw keys. The
    // canonical columns are added by IntelligenceRepository, so they may not
    // exist yet on a fresh database.
    const canonical = this.hasCanonicalColumns();
    const artistKey = canonical ? "COALESCE(s.canonical_artist_key, s.artist_key)" : "s.artist_key";
    const albumKey = canonical ? "COALESCE(s.canonical_album_key, s.album_key)" : "s.album_key";
    const trackKey = canonical ? "COALESCE(s.canonical_track_key, s.track_key)" : "s.track_key";
    const entityKey = dimension === "artist"
      ? artistKey
      : dimension === "album"
        ? `${artistKey} || char(0) || ${albumKey}`
        : `${artistKey} || char(0) || ${trackKey}`;
    const sql = `
      SELECT
        ${entityKey} AS entity_key,
        MAX(s.artist) AS artist,
        ${dimension === "album" ? "MAX(s.album)" : "NULL"} AS album,
        ${dimension === "track" ? "MAX(s.track)" : "NULL"} AS track,
        COUNT(*) AS plays,
        MIN(s.played_at_unix) AS first_played,
        MAX(s.played_at_unix) AS last_played
      FROM scrobbles s
      WHERE ${where}
      GROUP BY entity_key
      ORDER BY plays DESC, last_played DESC, entity_key
    `;
    return (this.db.prepare(sql).all(...values) as Row[]).map((row) => ({
      ...row,
      plays: Number(row.plays),
      first_played: Number(row.first_played),
      last_played: Number(row.last_played),
    }));
  }

  private hasCanonicalColumns(): boolean {
    const columns = this.db.prepare("PRAGMA table_info(scrobbles)").all() as Array<{ name: string }>;
    return columns.some((column) => column.name === "canonical_artist_key");
  }

  private totalPlays(username: string, range: TimeRange, dimension: RangeDimension): number {
    const { where, values } = rangeFilter(username, range, dimension);
    const row = this.db.prepare(`SELECT COUNT(*) AS plays FROM scrobbles s WHERE ${where}`).get(...values) as { plays: number };
    return Number(row.plays);
  }
}

function rangeFilter(username: string, range: TimeRange, dimension: RangeDimension) {
  const conditions = ["s.username = ?"];
  const values: SQLInputValue[] = [username];
  if (range.from !== undefined) {
    conditions.push("s.played_at_unix >= ?");
    values.push(range.from);
  }
  if (range.to !== undefined) {
    conditions.push("s.played_at_unix <= ?");
    values.push(range.to);
  }
  // Scrobbles without an album cannot be ranked or shared by album.
  if (dimension === "album") conditions.push("COALESCE(s.album, '') <> ''");
  return { where: conditions.join(" AND "), values };
}

function assertRange(range: TimeRange): void {
  if (range.from !== undefined && range.to !== undefined && range.from > range.to) {
    throw new Error("from must be less than or equal to to");
  }
}

function ratio(part: number, whole: number): number {
  return whole === 0 ? 0 : round(part / whole);
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export type DailyPlays = { date: string; plays: number };

/**
 * Plays per UTC calendar day, for consumers that only need a daily figure
 * (health-ojimpo turns it into listening minutes). Days without plays are
 * omitted. `from` / `to` are inclusive YYYY-MM-DD.
 */
export function dailyPlays(db: DatabaseSync, username: string, from?: string, to?: string): DailyPlays[] {
  const conditions = ["username = ?"];
  const values: SQLInputValue[] = [username];
  if (from !== undefined) {
    conditions.push("played_at_unix >= ?");
    values.push(utcDayStart(from, "from"));
  }
  if (to !== undefined) {
    conditions.push("played_at_unix < ?");
    values.push(utcDayStart(to, "to") + 86_400);
  }
  const rows = db.prepare(`
    SELECT date(played_at_unix, 'unixepoch') AS day, COUNT(*) AS plays
    FROM scrobbles
    WHERE ${conditions.join(" AND ")}
    GROUP BY day
    ORDER BY day
  `).all(...values) as Array<{ day: string; plays: number }>;
  return rows.map((row) => ({ date: row.day, plays: Number(row.plays) }));
}

function utcDayStart(value: string, field: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${field} must be YYYY-MM-DD`);
  const milliseconds = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(milliseconds)) throw new Error(`${field} is not a valid date`);
  return milliseconds / 1_000;
}
