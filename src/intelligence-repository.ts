import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  canonicalKey,
  canonicalizeAlbum,
  canonicalizeArtist,
  canonicalizeTrack,
  normalizeDisplayName,
} from "./canonicalization.js";
import type { AnalyticsScrobble } from "./listening-analytics.js";
import { toIso } from "./time.js";

type SqlRow = Record<string, unknown>;

export const FEEDBACK_VERDICTS = ["love", "like", "mixed", "boring", "dislike", "not_now"] as const;
export type FeedbackVerdict = (typeof FEEDBACK_VERDICTS)[number];

export const TASTE_DIMENSIONS = [
  "atmosphere",
  "rhythm",
  "groove",
  "melody",
  "emotional_arc",
  "song_structure",
  "production",
  "vocals",
  "heaviness",
  "lyrics",
] as const;
export type TasteDimension = (typeof TASTE_DIMENSIONS)[number];
export type PreferenceDimensions = Partial<Record<TasteDimension, number>>;

export type CanonicalTarget = {
  artist?: string;
  album?: string;
  track?: string;
};

export type IndexedScrobble = AnalyticsScrobble & {
  playedAt: string;
  artistKey: string;
  albumKey: string | null;
  trackKey: string;
  artistMbid: string | null;
  albumMbid: string | null;
  trackMbid: string | null;
};

export type ExposureStats = {
  totalPlays: number;
  firstPlayedAt: string | null;
  lastPlayedAt: string | null;
  albumsPlayed: number;
  tracksPlayed: number;
  activeDays: number;
  activeMonths: number;
  lovedPlays: number;
};

export type RecommendationRecord = {
  recommendationId: string;
  artist: string;
  artistKey: string;
  mode: string;
  reason: string;
  score: number | null;
  confidence: number | null;
  recommendedAt: string;
  recommendedAtUnix: number;
  baselinePlays: number;
  baselineLastPlayedAt: string | null;
  context: Record<string, unknown> | null;
};

export class IntelligenceRepository {
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

  /** Backfills deterministic canonical keys for scrobbles added by the history synchronizer. */
  ensureCanonicalIndex(username: string): { indexed: number; aliases: number } {
    let indexed = 0;
    let aliases = 0;
    const update = this.db.prepare(`
      UPDATE scrobbles SET
        canonical_artist_key = ?, canonical_album_key = ?, canonical_track_key = ?
      WHERE rowid = ?
    `);
    const upsertArtist = this.db.prepare(`
      INSERT INTO canonical_artists (username, canonical_key, canonical_name, mbid)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(username, canonical_key) DO UPDATE SET
        canonical_name = CASE
          WHEN canonical_artists.mbid IS NULL AND excluded.mbid IS NOT NULL THEN excluded.canonical_name
          ELSE canonical_artists.canonical_name
        END,
        mbid = COALESCE(canonical_artists.mbid, excluded.mbid)
    `);
    const upsertAlbum = this.db.prepare(`
      INSERT INTO canonical_albums (username, artist_key, canonical_key, canonical_name, mbid)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(username, artist_key, canonical_key) DO UPDATE SET
        mbid = COALESCE(canonical_albums.mbid, excluded.mbid)
    `);
    const upsertTrack = this.db.prepare(`
      INSERT INTO canonical_tracks (username, artist_key, canonical_key, canonical_name, mbid)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(username, artist_key, canonical_key) DO UPDATE SET
        mbid = COALESCE(canonical_tracks.mbid, excluded.mbid)
    `);
    const insertAlias = this.db.prepare(`
      INSERT OR IGNORE INTO canonical_aliases
        (username, entity_type, artist_key, canonical_key, alias, alias_key)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertAliasVariant = this.db.prepare(`
      INSERT OR IGNORE INTO canonical_alias_variants
        (username, entity_type, artist_key, canonical_key, alias)
      VALUES (?, ?, ?, ?, ?)
    `);
    const findArtistMbid = this.db.prepare(`
      SELECT canonical_key, canonical_name FROM canonical_artists WHERE username = ? AND mbid = ? LIMIT 1
    `);
    const findArtistExact = this.db.prepare(`
      SELECT canonical_key, canonical_name FROM canonical_artists WHERE username = ? AND canonical_key = ? LIMIT 1
    `);
    const findAlbumMbid = this.db.prepare(`
      SELECT canonical_key, canonical_name FROM canonical_albums WHERE username = ? AND mbid = ? LIMIT 1
    `);
    const findAlbumExact = this.db.prepare(`
      SELECT canonical_key, canonical_name FROM canonical_albums
      WHERE username = ? AND artist_key = ? AND canonical_key = ? LIMIT 1
    `);
    const findTrackMbid = this.db.prepare(`
      SELECT canonical_key, canonical_name FROM canonical_tracks WHERE username = ? AND mbid = ? LIMIT 1
    `);
    const findTrackExact = this.db.prepare(`
      SELECT canonical_key, canonical_name FROM canonical_tracks
      WHERE username = ? AND artist_key = ? AND canonical_key = ? LIMIT 1
    `);

    while (true) {
      const rows = this.db.prepare(`
        SELECT rowid AS row_id, artist, album, track, artist_mbid, album_mbid, track_mbid
        FROM scrobbles
        WHERE username = ? AND canonical_artist_key IS NULL
        LIMIT 5000
      `).all(username) as SqlRow[];
      if (rows.length === 0) break;

      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (const row of rows) {
          const artist = canonicalizeArtist(stringOf(row.artist));
          const album = canonicalizeAlbum(nullableString(row.album) ?? "");
          const track = canonicalizeTrack(stringOf(row.track));
          const artistMbid = nullableString(row.artist_mbid);
          const albumMbid = nullableString(row.album_mbid);
          const trackMbid = nullableString(row.track_mbid);
          const knownArtist = artistMbid ? findArtistMbid.get(username, artistMbid) as SqlRow | undefined : undefined;
          const exactArtist = findArtistExact.get(username, artist.key) as SqlRow | undefined;
          const knownAlbum = albumMbid ? findAlbumMbid.get(username, albumMbid) as SqlRow | undefined : undefined;
          const knownTrack = trackMbid ? findTrackMbid.get(username, trackMbid) as SqlRow | undefined : undefined;
          const exactArtistKey = nullableString(exactArtist?.canonical_key);
          const knownArtistKey = nullableString(knownArtist?.canonical_key);
          const artistKey = exactArtistKey ?? knownArtistKey ?? artist.key;
          if (exactArtistKey && knownArtistKey && exactArtistKey !== knownArtistKey) {
            this.mergeArtistCanonical(username, knownArtistKey, exactArtistKey);
          }
          const artistName = nullableString(exactArtist?.canonical_name) ?? nullableString(knownArtist?.canonical_name) ?? artist.canonicalName;
          const exactAlbum = findAlbumExact.get(username, artistKey, album.key) as SqlRow | undefined;
          const exactAlbumKey = nullableString(exactAlbum?.canonical_key);
          const knownAlbumKey = nullableString(knownAlbum?.canonical_key);
          const albumKey = exactAlbumKey ?? knownAlbumKey ?? album.key;
          if (exactAlbumKey && knownAlbumKey && exactAlbumKey !== knownAlbumKey) {
            this.mergeChildCanonical(username, artistKey, "album", knownAlbumKey, exactAlbumKey);
          }
          const albumName = nullableString(exactAlbum?.canonical_name) ?? nullableString(knownAlbum?.canonical_name) ?? album.canonicalName;
          const exactTrack = findTrackExact.get(username, artistKey, track.key) as SqlRow | undefined;
          const exactTrackKey = nullableString(exactTrack?.canonical_key);
          const knownTrackKey = nullableString(knownTrack?.canonical_key);
          const trackKey = exactTrackKey ?? knownTrackKey ?? track.key;
          if (exactTrackKey && knownTrackKey && exactTrackKey !== knownTrackKey) {
            this.mergeChildCanonical(username, artistKey, "track", knownTrackKey, exactTrackKey);
          }
          const trackName = nullableString(exactTrack?.canonical_name) ?? nullableString(knownTrack?.canonical_name) ?? track.canonicalName;
          update.run(artistKey, albumKey, trackKey, numberOf(row.row_id));
          upsertArtist.run(username, artistKey, artistName, artistMbid);
          if (albumKey) {
            upsertAlbum.run(username, artistKey, albumKey, albumName, albumMbid);
          }
          upsertTrack.run(username, artistKey, trackKey, trackName, trackMbid);
          for (const alias of artist.aliases) {
            aliases += Number(insertAlias.run(username, "artist", "", artistKey, alias, canonicalKey(alias)).changes);
            insertAliasVariant.run(username, "artist", "", artistKey, alias);
          }
          for (const alias of album.aliases) {
            aliases += Number(insertAlias.run(username, "album", artistKey, albumKey, alias, canonicalKey(alias)).changes);
            insertAliasVariant.run(username, "album", artistKey, albumKey, alias);
          }
          for (const alias of track.aliases) {
            aliases += Number(insertAlias.run(username, "track", artistKey, trackKey, alias, canonicalKey(alias)).changes);
            insertAliasVariant.run(username, "track", artistKey, trackKey, alias);
          }
          indexed += 1;
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
    this.reconcileMbidDuplicates(username);
    return { indexed, aliases };
  }

  getCanonicalEntities(username: string, input: CanonicalTarget) {
    this.ensureCanonicalIndex(username);
    const artist = input.artist ? canonicalizeArtist(input.artist) : null;
    const album = input.album ? canonicalizeAlbum(input.album) : null;
    const track = input.track ? canonicalizeTrack(input.track) : null;
    const artistKey = artist ? this.resolveAliasKey(username, "artist", "", artist.key) : null;
    const albumKey = artistKey && album ? this.resolveAliasKey(username, "album", artistKey, album.key) : null;
    const trackKey = artistKey && track ? this.resolveAliasKey(username, "track", artistKey, track.key) : null;
    return {
      artist: artist && artistKey ? this.canonicalArtist(username, artistKey, artist.canonicalName, artist.aliases) : null,
      album: artistKey && album && albumKey ? this.canonicalAlbum(username, artistKey, albumKey, album.canonicalName, album.aliases) : null,
      track: artistKey && track && trackKey ? this.canonicalTrack(username, artistKey, trackKey, track.canonicalName, track.aliases) : null,
    };
  }

  resolveArtistKey(username: string, artist: string): string {
    this.ensureCanonicalIndex(username);
    return this.resolveAliasKey(username, "artist", "", canonicalizeArtist(artist).key);
  }

  getScrobbles(
    username: string,
    input: { artist?: string; album?: string; track?: string; from?: number; to?: number; limit?: number } = {},
  ): IndexedScrobble[] {
    this.ensureCanonicalIndex(username);
    const conditions = ["s.username = ?"];
    const values: SQLInputValue[] = [username];
    if (input.artist) {
      conditions.push("s.canonical_artist_key = ?");
      values.push(this.resolveAliasKey(username, "artist", "", canonicalizeArtist(input.artist).key));
    }
    if (input.album) {
      conditions.push("s.canonical_album_key = ?");
      const artistKey = input.artist ? this.resolveAliasKey(username, "artist", "", canonicalizeArtist(input.artist).key) : "";
      values.push(this.resolveAliasKey(username, "album", artistKey, canonicalizeAlbum(input.album).key));
    }
    if (input.track) {
      conditions.push("s.canonical_track_key = ?");
      const artistKey = input.artist ? this.resolveAliasKey(username, "artist", "", canonicalizeArtist(input.artist).key) : "";
      values.push(this.resolveAliasKey(username, "track", artistKey, canonicalizeTrack(input.track).key));
    }
    if (input.from !== undefined) {
      conditions.push("s.played_at_unix >= ?");
      values.push(input.from);
    }
    if (input.to !== undefined) {
      conditions.push("s.played_at_unix <= ?");
      values.push(input.to);
    }
    const sql = `
      SELECT
        s.played_at_unix, s.artist, s.album, s.track, s.loved,
        s.canonical_artist_key, s.canonical_album_key, s.canonical_track_key,
        s.artist_mbid, s.album_mbid, s.track_mbid,
        ca.canonical_name AS canonical_artist,
        cal.canonical_name AS canonical_album,
        ct.canonical_name AS canonical_track
      FROM scrobbles s
      LEFT JOIN canonical_artists ca
        ON ca.username = s.username AND ca.canonical_key = s.canonical_artist_key
      LEFT JOIN canonical_albums cal
        ON cal.username = s.username AND cal.artist_key = s.canonical_artist_key
        AND cal.canonical_key = s.canonical_album_key
      LEFT JOIN canonical_tracks ct
        ON ct.username = s.username AND ct.artist_key = s.canonical_artist_key
        AND ct.canonical_key = s.canonical_track_key
      WHERE ${conditions.join(" AND ")}
      ORDER BY s.played_at_unix ASC
      ${input.limit === undefined ? "" : "LIMIT ?"}
    `;
    const rows = this.db.prepare(sql).all(...values, ...(input.limit === undefined ? [] : [input.limit])) as SqlRow[];
    return rows.map(rowToIndexedScrobble);
  }

  getArtistExposure(username: string, artistName: string, to?: number): ExposureStats {
    return this.exposure(username, { artist: artistName, ...(to === undefined ? {} : { to }) });
  }

  getAlbumExposureStats(username: string, artist: string, album: string): ExposureStats {
    return this.exposure(username, { artist, album });
  }

  getTrackExposure(username: string, artist: string, track: string): ExposureStats {
    return this.exposure(username, { artist, track });
  }

  getTopArtists(username: string, limit = 50): Array<{ artist: string; artistKey: string; plays: number; firstPlayedAt: string | null; lastPlayedAt: string | null }> {
    this.ensureCanonicalIndex(username);
    return (this.db.prepare(`
      SELECT COALESCE(ca.canonical_name, s.artist) AS artist, s.canonical_artist_key AS artist_key,
        COUNT(*) AS plays, MIN(s.played_at_unix) AS first_played, MAX(s.played_at_unix) AS last_played
      FROM scrobbles s
      LEFT JOIN canonical_artists ca
        ON ca.username = s.username AND ca.canonical_key = s.canonical_artist_key
      WHERE s.username = ?
      GROUP BY s.canonical_artist_key
      ORDER BY plays DESC
      LIMIT ?
    `).all(username, limit) as SqlRow[]).map((row) => ({
      artist: stringOf(row.artist),
      artistKey: stringOf(row.artist_key),
      plays: numberOf(row.plays),
      firstPlayedAt: toIso(nullableNumber(row.first_played)),
      lastPlayedAt: toIso(nullableNumber(row.last_played)),
    }));
  }

  recordFeedback(username: string, input: CanonicalTarget & { rating?: number; verdict: FeedbackVerdict; notes?: string }) {
    const keys = this.targetKeys(username, input);
    const id = randomUUID();
    const createdAtUnix = Math.floor(Date.now() / 1000);
    this.db.prepare(`
      INSERT INTO music_feedback (
        id, username, artist, album, track, artist_key, album_key, track_key,
        rating, verdict, notes, created_at_unix
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, username, clean(input.artist), clean(input.album), clean(input.track),
      keys.artistKey, keys.albumKey, keys.trackKey, input.rating ?? null, input.verdict,
      clean(input.notes), createdAtUnix,
    );
    return { id, ...input, createdAt: toIso(createdAtUnix) };
  }

  listFeedback(username: string, limit = 500) {
    return (this.db.prepare(`
      SELECT * FROM music_feedback WHERE username = ? ORDER BY created_at_unix DESC LIMIT ?
    `).all(username, limit) as SqlRow[]).map((row) => ({
      id: stringOf(row.id),
      artist: nullableString(row.artist),
      album: nullableString(row.album),
      track: nullableString(row.track),
      artistKey: nullableString(row.artist_key),
      albumKey: nullableString(row.album_key),
      trackKey: nullableString(row.track_key),
      rating: nullableNumber(row.rating),
      verdict: stringOf(row.verdict),
      notes: nullableString(row.notes),
      createdAt: toIso(numberOf(row.created_at_unix)),
    }));
  }

  recordPreferenceSignal(username: string, input: { target: CanonicalTarget; dimensions: PreferenceDimensions; notes?: string }) {
    const keys = this.targetKeys(username, input.target);
    const id = randomUUID();
    const createdAtUnix = Math.floor(Date.now() / 1000);
    this.db.prepare(`
      INSERT INTO preference_signals (
        id, username, artist, album, track, artist_key, album_key, track_key,
        dimensions_json, notes, created_at_unix
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, username, clean(input.target.artist), clean(input.target.album), clean(input.target.track),
      keys.artistKey, keys.albumKey, keys.trackKey, JSON.stringify(input.dimensions), clean(input.notes), createdAtUnix,
    );
    return { id, ...input, createdAt: toIso(createdAtUnix) };
  }

  listPreferenceSignals(username: string, limit = 500) {
    return (this.db.prepare(`
      SELECT * FROM preference_signals WHERE username = ? ORDER BY created_at_unix DESC LIMIT ?
    `).all(username, limit) as SqlRow[]).map((row) => ({
      id: stringOf(row.id),
      target: { artist: nullableString(row.artist), album: nullableString(row.album), track: nullableString(row.track) },
      targetKeys: { artistKey: nullableString(row.artist_key), albumKey: nullableString(row.album_key), trackKey: nullableString(row.track_key) },
      dimensions: parseObject(row.dimensions_json),
      notes: nullableString(row.notes),
      createdAt: toIso(numberOf(row.created_at_unix)),
    }));
  }

  excludeRecommendation(username: string, input: { artist: string; reason: string; policy: string; expiresAt?: number | null }) {
    const artist = canonicalizeArtist(input.artist);
    const artistKey = this.resolveAliasKey(username, "artist", "", artist.key);
    const id = randomUUID();
    const createdAtUnix = Math.floor(Date.now() / 1000);
    this.db.prepare(`
      INSERT INTO recommendation_exclusions
        (id, username, artist, artist_key, reason, policy, expires_at_unix, created_at_unix)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(username, artist_key) DO UPDATE SET
        artist = excluded.artist, reason = excluded.reason, policy = excluded.policy,
        expires_at_unix = excluded.expires_at_unix, created_at_unix = excluded.created_at_unix
    `).run(id, username, artist.canonicalName, artistKey, input.reason, input.policy, input.expiresAt ?? null, createdAtUnix);
    const persisted = this.db.prepare(`SELECT id FROM recommendation_exclusions WHERE username = ? AND artist_key = ?`).get(username, artistKey) as SqlRow;
    return { id: stringOf(persisted.id), artist: artist.canonicalName, reason: input.reason, policy: input.policy, expiresAt: toIso(input.expiresAt ?? null), createdAt: toIso(createdAtUnix) };
  }

  listActiveExclusions(username: string, nowUnix = Math.floor(Date.now() / 1000)) {
    return (this.db.prepare(`
      SELECT * FROM recommendation_exclusions
      WHERE username = ? AND (expires_at_unix IS NULL OR expires_at_unix > ?)
      ORDER BY created_at_unix DESC
    `).all(username, nowUnix) as SqlRow[]).map((row) => ({
      id: stringOf(row.id),
      artist: stringOf(row.artist),
      artistKey: stringOf(row.artist_key),
      reason: stringOf(row.reason),
      policy: stringOf(row.policy),
      expiresAt: toIso(nullableNumber(row.expires_at_unix)),
      createdAt: toIso(numberOf(row.created_at_unix)),
    }));
  }

  recordRecommendation(username: string, input: {
    artist: string;
    recommendationId?: string;
    recommendedAt?: number;
    reason: string;
    mode?: string;
    score?: number;
    confidence?: number;
    context?: Record<string, unknown>;
  }): RecommendationRecord {
    const artist = canonicalizeArtist(input.artist);
    const artistKey = this.resolveAliasKey(username, "artist", "", artist.key);
    const recommendedAtUnix = input.recommendedAt ?? Math.floor(Date.now() / 1000);
    const baseline = this.getArtistExposure(username, artist.canonicalName, recommendedAtUnix);
    const recommendationId = input.recommendationId ?? randomUUID();
    this.db.prepare(`
      INSERT INTO recommendations (
        recommendation_id, username, artist, artist_key, mode, reason, score, confidence,
        recommended_at_unix, baseline_plays, baseline_last_played_at_unix, context_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(recommendation_id) DO UPDATE SET
        reason = excluded.reason, context_json = COALESCE(excluded.context_json, recommendations.context_json)
    `).run(
      recommendationId, username, artist.canonicalName, artistKey, input.mode ?? "manual", input.reason,
      input.score ?? null, input.confidence ?? null, recommendedAtUnix, baseline.totalPlays,
      baseline.lastPlayedAt ? Math.floor(Date.parse(baseline.lastPlayedAt) / 1000) : null,
      input.context ? JSON.stringify(input.context) : null,
    );
    return this.listRecommendations(username).find((item) => item.recommendationId === recommendationId)!;
  }

  listRecommendations(username: string, since?: number): RecommendationRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM recommendations
      WHERE username = ? AND recommended_at_unix >= ?
      ORDER BY recommended_at_unix DESC
    `).all(username, since ?? 0) as SqlRow[];
    return rows.map((row) => ({
      recommendationId: stringOf(row.recommendation_id),
      artist: stringOf(row.artist),
      artistKey: stringOf(row.artist_key),
      mode: stringOf(row.mode),
      reason: stringOf(row.reason),
      score: nullableNumber(row.score),
      confidence: nullableNumber(row.confidence),
      recommendedAt: toIso(numberOf(row.recommended_at_unix)) ?? "",
      recommendedAtUnix: numberOf(row.recommended_at_unix),
      baselinePlays: numberOf(row.baseline_plays),
      baselineLastPlayedAt: toIso(nullableNumber(row.baseline_last_played_at_unix)),
      context: parseNullableObject(row.context_json),
    }));
  }

  private exposure(username: string, input: { artist: string; album?: string; track?: string; to?: number }): ExposureStats {
    this.ensureCanonicalIndex(username);
    const conditions = ["username = ?", "canonical_artist_key = ?"];
    const artistKey = this.resolveAliasKey(username, "artist", "", canonicalizeArtist(input.artist).key);
    const values: SQLInputValue[] = [username, artistKey];
    if (input.album) {
      conditions.push("canonical_album_key = ?");
      values.push(this.resolveAliasKey(username, "album", artistKey, canonicalizeAlbum(input.album).key));
    }
    if (input.track) {
      conditions.push("canonical_track_key = ?");
      values.push(this.resolveAliasKey(username, "track", artistKey, canonicalizeTrack(input.track).key));
    }
    if (input.to !== undefined) {
      conditions.push("played_at_unix <= ?");
      values.push(input.to);
    }
    const row = this.db.prepare(`
      SELECT COUNT(*) AS plays, MIN(played_at_unix) AS first_played, MAX(played_at_unix) AS last_played,
        COUNT(DISTINCT CASE WHEN canonical_album_key <> '' THEN canonical_album_key END) AS albums,
        COUNT(DISTINCT canonical_track_key) AS tracks,
        COUNT(DISTINCT date(played_at_unix, 'unixepoch')) AS active_days,
        COUNT(DISTINCT strftime('%Y-%m', played_at_unix, 'unixepoch')) AS active_months,
        SUM(loved) AS loved_plays
      FROM scrobbles WHERE ${conditions.join(" AND ")}
    `).get(...values) as SqlRow;
    return {
      totalPlays: numberOf(row.plays),
      firstPlayedAt: toIso(nullableNumber(row.first_played)),
      lastPlayedAt: toIso(nullableNumber(row.last_played)),
      albumsPlayed: numberOf(row.albums),
      tracksPlayed: numberOf(row.tracks),
      activeDays: numberOf(row.active_days),
      activeMonths: numberOf(row.active_months),
      lovedPlays: numberOf(row.loved_plays),
    };
  }

  private canonicalArtist(username: string, key: string, fallback: string, inputAliases: string[]) {
    const row = this.db.prepare("SELECT * FROM canonical_artists WHERE username = ? AND canonical_key = ?").get(username, key) as SqlRow | undefined;
    const aliases = this.entityAliases(username, "artist", "", key, inputAliases);
    const mbid = nullableString(row?.mbid);
    return { id: mbid ? `artist:mbid:${mbid}` : `artist:${key}`, canonicalName: nullableString(row?.canonical_name) ?? fallback, mbid, aliases };
  }

  private canonicalAlbum(username: string, artistKey: string, key: string, fallback: string, inputAliases: string[]) {
    const row = this.db.prepare(`SELECT * FROM canonical_albums WHERE username = ? AND artist_key = ? AND canonical_key = ?`).get(username, artistKey, key) as SqlRow | undefined;
    const aliases = this.entityAliases(username, "album", artistKey, key, inputAliases);
    const mbid = nullableString(row?.mbid);
    return { id: mbid ? `album:mbid:${mbid}` : `album:${artistKey}:${key}`, canonicalName: nullableString(row?.canonical_name) ?? fallback, mbid, aliases };
  }

  private canonicalTrack(username: string, artistKey: string, key: string, fallback: string, inputAliases: string[]) {
    const row = this.db.prepare(`SELECT * FROM canonical_tracks WHERE username = ? AND artist_key = ? AND canonical_key = ?`).get(username, artistKey, key) as SqlRow | undefined;
    const aliases = this.entityAliases(username, "track", artistKey, key, inputAliases);
    const mbid = nullableString(row?.mbid);
    return { id: mbid ? `track:mbid:${mbid}` : `track:${artistKey}:${key}`, canonicalName: nullableString(row?.canonical_name) ?? fallback, mbid, aliases };
  }

  private entityAliases(username: string, type: string, artistKey: string, key: string, fallback: string[]): string[] {
    const rows = this.db.prepare(`
      SELECT alias FROM canonical_alias_variants
      WHERE username = ? AND entity_type = ? AND artist_key = ? AND canonical_key = ?
      ORDER BY alias
    `).all(username, type, artistKey, key) as SqlRow[];
    return rows.length > 0 ? rows.map((row) => stringOf(row.alias)) : [...new Set(fallback)];
  }

  private resolveAliasKey(username: string, type: string, artistKey: string, inputKey: string): string {
    const row = this.db.prepare(`
      SELECT canonical_key FROM canonical_aliases
      WHERE username = ? AND entity_type = ? AND artist_key = ? AND alias_key = ?
      LIMIT 1
    `).get(username, type, artistKey, inputKey) as SqlRow | undefined;
    return nullableString(row?.canonical_key) ?? inputKey;
  }

  private targetKeys(username: string, input: CanonicalTarget) {
    const rawArtistKey = input.artist ? canonicalizeArtist(input.artist).key : null;
    const artistKey = rawArtistKey ? this.resolveAliasKey(username, "artist", "", rawArtistKey) : null;
    return {
      artistKey,
      albumKey: input.album && artistKey
        ? this.resolveAliasKey(username, "album", artistKey, canonicalizeAlbum(input.album).key)
        : null,
      trackKey: input.track && artistKey
        ? this.resolveAliasKey(username, "track", artistKey, canonicalizeTrack(input.track).key)
        : null,
    };
  }

  private mergeArtistCanonical(username: string, losingKey: string, winningKey: string): void {
    this.db.prepare(`
      UPDATE scrobbles SET canonical_artist_key = ?
      WHERE username = ? AND canonical_artist_key = ?
    `).run(winningKey, username, losingKey);
    this.db.prepare(`
      INSERT OR IGNORE INTO canonical_aliases
        (username, entity_type, artist_key, canonical_key, alias, alias_key)
      SELECT username, entity_type,
        CASE WHEN entity_type = 'artist' THEN '' ELSE ? END,
        CASE WHEN entity_type = 'artist' THEN ? ELSE canonical_key END,
        alias, alias_key
      FROM canonical_aliases
      WHERE username = ? AND (
        (entity_type = 'artist' AND canonical_key = ?)
        OR (entity_type <> 'artist' AND artist_key = ?)
      )
    `).run(winningKey, winningKey, username, losingKey, losingKey);
    this.db.prepare(`
      INSERT OR IGNORE INTO canonical_alias_variants
        (username, entity_type, artist_key, canonical_key, alias)
      SELECT username, entity_type,
        CASE WHEN entity_type = 'artist' THEN '' ELSE ? END,
        CASE WHEN entity_type = 'artist' THEN ? ELSE canonical_key END,
        alias
      FROM canonical_alias_variants
      WHERE username = ? AND (
        (entity_type = 'artist' AND canonical_key = ?)
        OR (entity_type <> 'artist' AND artist_key = ?)
      )
    `).run(winningKey, winningKey, username, losingKey, losingKey);
    this.db.prepare(`
      INSERT OR IGNORE INTO canonical_albums (username, artist_key, canonical_key, canonical_name, mbid)
      SELECT username, ?, canonical_key, canonical_name, mbid
      FROM canonical_albums WHERE username = ? AND artist_key = ?
    `).run(winningKey, username, losingKey);
    this.db.prepare(`
      INSERT OR IGNORE INTO canonical_tracks (username, artist_key, canonical_key, canonical_name, mbid)
      SELECT username, ?, canonical_key, canonical_name, mbid
      FROM canonical_tracks WHERE username = ? AND artist_key = ?
    `).run(winningKey, username, losingKey);
    this.db.prepare(`DELETE FROM canonical_aliases WHERE username = ? AND (
      (entity_type = 'artist' AND canonical_key = ?) OR (entity_type <> 'artist' AND artist_key = ?)
    )`).run(username, losingKey, losingKey);
    this.db.prepare(`DELETE FROM canonical_alias_variants WHERE username = ? AND (
      (entity_type = 'artist' AND canonical_key = ?) OR (entity_type <> 'artist' AND artist_key = ?)
    )`).run(username, losingKey, losingKey);
    this.db.prepare(`DELETE FROM canonical_albums WHERE username = ? AND artist_key = ?`).run(username, losingKey);
    this.db.prepare(`DELETE FROM canonical_tracks WHERE username = ? AND artist_key = ?`).run(username, losingKey);
    this.db.prepare(`UPDATE music_feedback SET artist_key = ? WHERE username = ? AND artist_key = ?`)
      .run(winningKey, username, losingKey);
    this.db.prepare(`UPDATE preference_signals SET artist_key = ? WHERE username = ? AND artist_key = ?`)
      .run(winningKey, username, losingKey);
    this.db.prepare(`
      DELETE FROM recommendation_exclusions
      WHERE username = ? AND artist_key = ? AND EXISTS (
        SELECT 1 FROM recommendation_exclusions winner WHERE winner.username = ? AND winner.artist_key = ?
      )
    `).run(username, losingKey, username, winningKey);
    this.db.prepare(`UPDATE recommendation_exclusions SET artist_key = ? WHERE username = ? AND artist_key = ?`)
      .run(winningKey, username, losingKey);
    this.db.prepare(`UPDATE recommendations SET artist_key = ? WHERE username = ? AND artist_key = ?`)
      .run(winningKey, username, losingKey);
    this.db.prepare(`DELETE FROM canonical_artists WHERE username = ? AND canonical_key = ?`).run(username, losingKey);
  }

  private mergeChildCanonical(
    username: string,
    artistKey: string,
    type: "album" | "track",
    losingKey: string,
    winningKey: string,
  ): void {
    const column = type === "album" ? "canonical_album_key" : "canonical_track_key";
    const table = type === "album" ? "canonical_albums" : "canonical_tracks";
    this.db.prepare(`
      UPDATE scrobbles SET ${column} = ?
      WHERE username = ? AND canonical_artist_key = ? AND ${column} = ?
    `).run(winningKey, username, artistKey, losingKey);
    this.db.prepare(`
      INSERT OR IGNORE INTO canonical_aliases
        (username, entity_type, artist_key, canonical_key, alias, alias_key)
      SELECT username, entity_type, artist_key, ?, alias, alias_key
      FROM canonical_aliases
      WHERE username = ? AND entity_type = ? AND artist_key = ? AND canonical_key = ?
    `).run(winningKey, username, type, artistKey, losingKey);
    this.db.prepare(`
      INSERT OR IGNORE INTO canonical_alias_variants
        (username, entity_type, artist_key, canonical_key, alias)
      SELECT username, entity_type, artist_key, ?, alias
      FROM canonical_alias_variants
      WHERE username = ? AND entity_type = ? AND artist_key = ? AND canonical_key = ?
    `).run(winningKey, username, type, artistKey, losingKey);
    this.db.prepare(`
      UPDATE ${table} SET mbid = COALESCE(mbid, (
        SELECT mbid FROM ${table} loser
        WHERE loser.username = ? AND loser.artist_key = ? AND loser.canonical_key = ?
      ))
      WHERE username = ? AND artist_key = ? AND canonical_key = ?
    `).run(username, artistKey, losingKey, username, artistKey, winningKey);
    this.db.prepare(`
      DELETE FROM canonical_aliases
      WHERE username = ? AND entity_type = ? AND artist_key = ? AND canonical_key = ?
    `).run(username, type, artistKey, losingKey);
    this.db.prepare(`
      DELETE FROM canonical_alias_variants
      WHERE username = ? AND entity_type = ? AND artist_key = ? AND canonical_key = ?
    `).run(username, type, artistKey, losingKey);
    this.db.prepare(`DELETE FROM ${table} WHERE username = ? AND artist_key = ? AND canonical_key = ?`)
      .run(username, artistKey, losingKey);
    const dependentColumn = type === "album" ? "album_key" : "track_key";
    this.db.prepare(`
      UPDATE music_feedback SET ${dependentColumn} = ?
      WHERE username = ? AND artist_key = ? AND ${dependentColumn} = ?
    `).run(winningKey, username, artistKey, losingKey);
    this.db.prepare(`
      UPDATE preference_signals SET ${dependentColumn} = ?
      WHERE username = ? AND artist_key = ? AND ${dependentColumn} = ?
    `).run(winningKey, username, artistKey, losingKey);
  }

  private reconcileMbidDuplicates(username: string): void {
    const artistMbids = this.db.prepare(`
      SELECT mbid FROM canonical_artists
      WHERE username = ? AND mbid IS NOT NULL AND mbid <> ''
      GROUP BY mbid HAVING COUNT(*) > 1
    `).all(username) as SqlRow[];
    for (const { mbid } of artistMbids) {
      const rows = this.db.prepare(`
        SELECT ca.canonical_key, COUNT(s.played_at_unix) AS plays
        FROM canonical_artists ca
        LEFT JOIN scrobbles s ON s.username = ca.username AND s.canonical_artist_key = ca.canonical_key
        WHERE ca.username = ? AND ca.mbid = ?
        GROUP BY ca.canonical_key ORDER BY plays DESC, ca.canonical_key ASC
      `).all(username, mbid as SQLInputValue) as SqlRow[];
      const winner = nullableString(rows[0]?.canonical_key);
      if (!winner) continue;
      for (const row of rows.slice(1)) {
        const loser = nullableString(row.canonical_key);
        if (loser && loser !== winner) this.mergeArtistCanonical(username, loser, winner);
      }
    }

    for (const type of ["album", "track"] as const) {
      const table = type === "album" ? "canonical_albums" : "canonical_tracks";
      const column = type === "album" ? "canonical_album_key" : "canonical_track_key";
      const duplicateMbids = this.db.prepare(`
        SELECT artist_key, mbid FROM ${table}
        WHERE username = ? AND mbid IS NOT NULL AND mbid <> ''
        GROUP BY artist_key, mbid HAVING COUNT(*) > 1
      `).all(username) as SqlRow[];
      for (const duplicate of duplicateMbids) {
        const artistKey = stringOf(duplicate.artist_key);
        const rows = this.db.prepare(`
          SELECT entity.canonical_key, COUNT(s.played_at_unix) AS plays
          FROM ${table} entity
          LEFT JOIN scrobbles s ON s.username = entity.username
            AND s.canonical_artist_key = entity.artist_key AND s.${column} = entity.canonical_key
          WHERE entity.username = ? AND entity.artist_key = ? AND entity.mbid = ?
          GROUP BY entity.canonical_key ORDER BY plays DESC, entity.canonical_key ASC
        `).all(username, artistKey, duplicate.mbid as SQLInputValue) as SqlRow[];
        const winner = nullableString(rows[0]?.canonical_key);
        if (!winner) continue;
        for (const row of rows.slice(1)) {
          const loser = nullableString(row.canonical_key);
          if (loser && loser !== winner) this.mergeChildCanonical(username, artistKey, type, loser, winner);
        }
      }
    }
  }

  private migrate(): void {
    // HistoryRepository normally creates scrobbles first, but this makes the
    // repository safe for standalone tests and migrations.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scrobbles (
        username TEXT NOT NULL, played_at_unix INTEGER NOT NULL,
        artist TEXT NOT NULL, artist_key TEXT NOT NULL, album TEXT, album_key TEXT NOT NULL,
        track TEXT NOT NULL, track_key TEXT NOT NULL, artist_mbid TEXT, album_mbid TEXT,
        track_mbid TEXT, url TEXT NOT NULL, loved INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (username, played_at_unix, artist_key, album_key, track_key)
      );
    `);
    const columns = new Set((this.db.prepare("PRAGMA table_info(scrobbles)").all() as SqlRow[]).map((row) => stringOf(row.name)));
    if (!columns.has("canonical_artist_key")) this.db.exec("ALTER TABLE scrobbles ADD COLUMN canonical_artist_key TEXT");
    if (!columns.has("canonical_album_key")) this.db.exec("ALTER TABLE scrobbles ADD COLUMN canonical_album_key TEXT");
    if (!columns.has("canonical_track_key")) this.db.exec("ALTER TABLE scrobbles ADD COLUMN canonical_track_key TEXT");
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_scrobbles_user_canonical_artist
        ON scrobbles (username, canonical_artist_key, played_at_unix);
      CREATE INDEX IF NOT EXISTS idx_scrobbles_user_canonical_album
        ON scrobbles (username, canonical_artist_key, canonical_album_key, played_at_unix);
      CREATE INDEX IF NOT EXISTS idx_scrobbles_user_canonical_track
        ON scrobbles (username, canonical_artist_key, canonical_track_key, played_at_unix);
      CREATE TABLE IF NOT EXISTS canonical_artists (
        username TEXT NOT NULL, canonical_key TEXT NOT NULL, canonical_name TEXT NOT NULL, mbid TEXT,
        PRIMARY KEY (username, canonical_key)
      );
      CREATE TABLE IF NOT EXISTS canonical_albums (
        username TEXT NOT NULL, artist_key TEXT NOT NULL, canonical_key TEXT NOT NULL,
        canonical_name TEXT NOT NULL, mbid TEXT,
        PRIMARY KEY (username, artist_key, canonical_key)
      );
      CREATE TABLE IF NOT EXISTS canonical_tracks (
        username TEXT NOT NULL, artist_key TEXT NOT NULL, canonical_key TEXT NOT NULL,
        canonical_name TEXT NOT NULL, mbid TEXT,
        PRIMARY KEY (username, artist_key, canonical_key)
      );
      CREATE TABLE IF NOT EXISTS canonical_aliases (
        username TEXT NOT NULL, entity_type TEXT NOT NULL, artist_key TEXT NOT NULL,
        canonical_key TEXT NOT NULL, alias TEXT NOT NULL, alias_key TEXT NOT NULL,
        PRIMARY KEY (username, entity_type, artist_key, canonical_key, alias_key)
      );
      CREATE INDEX IF NOT EXISTS idx_canonical_alias_lookup
        ON canonical_aliases (username, entity_type, alias_key);
      CREATE TABLE IF NOT EXISTS canonical_alias_variants (
        username TEXT NOT NULL, entity_type TEXT NOT NULL, artist_key TEXT NOT NULL,
        canonical_key TEXT NOT NULL, alias TEXT NOT NULL,
        PRIMARY KEY (username, entity_type, artist_key, canonical_key, alias)
      );
      CREATE TABLE IF NOT EXISTS music_feedback (
        id TEXT PRIMARY KEY, username TEXT NOT NULL, artist TEXT, album TEXT, track TEXT,
        artist_key TEXT, album_key TEXT, track_key TEXT, rating REAL, verdict TEXT NOT NULL,
        notes TEXT, created_at_unix INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_feedback_user_target
        ON music_feedback (username, artist_key, album_key, track_key, created_at_unix DESC);
      CREATE TABLE IF NOT EXISTS preference_signals (
        id TEXT PRIMARY KEY, username TEXT NOT NULL, artist TEXT, album TEXT, track TEXT,
        artist_key TEXT, album_key TEXT, track_key TEXT, dimensions_json TEXT NOT NULL,
        notes TEXT, created_at_unix INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_preferences_user_target
        ON preference_signals (username, artist_key, album_key, track_key, created_at_unix DESC);
      CREATE TABLE IF NOT EXISTS recommendation_exclusions (
        id TEXT PRIMARY KEY, username TEXT NOT NULL, artist TEXT NOT NULL, artist_key TEXT NOT NULL,
        reason TEXT NOT NULL, policy TEXT NOT NULL, expires_at_unix INTEGER, created_at_unix INTEGER NOT NULL,
        UNIQUE (username, artist_key)
      );
      CREATE TABLE IF NOT EXISTS recommendations (
        recommendation_id TEXT PRIMARY KEY, username TEXT NOT NULL, artist TEXT NOT NULL,
        artist_key TEXT NOT NULL, mode TEXT NOT NULL, reason TEXT NOT NULL, score REAL,
        confidence REAL, recommended_at_unix INTEGER NOT NULL, baseline_plays INTEGER NOT NULL,
        baseline_last_played_at_unix INTEGER, context_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_recommendations_user_time
        ON recommendations (username, recommended_at_unix DESC);
    `);
    this.db.exec(`
      INSERT OR IGNORE INTO canonical_alias_variants
        (username, entity_type, artist_key, canonical_key, alias)
      SELECT username, entity_type, artist_key, canonical_key, alias FROM canonical_aliases;
    `);
  }
}

function rowToIndexedScrobble(row: SqlRow): IndexedScrobble {
  const timestamp = numberOf(row.played_at_unix);
  const album = nullableString(row.canonical_album) ?? nullableString(row.album);
  return {
    timestamp,
    playedAt: toIso(timestamp) ?? "",
    artist: nullableString(row.canonical_artist) ?? stringOf(row.artist),
    ...(album ? { album } : {}),
    track: nullableString(row.canonical_track) ?? stringOf(row.track),
    loved: numberOf(row.loved) === 1,
    artistKey: stringOf(row.canonical_artist_key),
    albumKey: nullableString(row.canonical_album_key),
    trackKey: stringOf(row.canonical_track_key),
    artistMbid: nullableString(row.artist_mbid),
    albumMbid: nullableString(row.album_mbid),
    trackMbid: nullableString(row.track_mbid),
  };
}

function clean(value: string | undefined): string | null {
  if (value === undefined) return null;
  const normalized = normalizeDisplayName(value);
  return normalized || null;
}

function parseObject(value: unknown): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(stringOf(value));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
  } catch {
    return {};
  }
}

function parseNullableObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || value === "") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function numberOf(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : numberOf(value);
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}
