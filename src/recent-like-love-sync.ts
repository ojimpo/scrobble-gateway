import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SpotifyTrack } from "./providers/spotify/client.js";
import { SpotifyApiError } from "./providers/spotify/client.js";
import { isSafeMatch, trackIdentity, TrackIdentityIndex, type TrackIdentity } from "./track-identity.js";

// Spotify Like → Last.fm Love, limited to tracks played recently.
//
// Upstream's sync_spotify_likes_to_lastfm reconciles the whole liked library
// at once. Here only tracks scrobbled within the last window are considered:
// when a liked song is played again it gets loved. That keeps every write tied
// to a play the owner can recognize, makes each run small, and leaves the long
// tail of old likes alone. One direction only: removing a like never unloves.

export type LikeLoveMode = "off" | "dry-run" | "on";

export type LikeLoveSummary = {
  mode: LikeLoveMode;
  recentUnloved: number;
  matched: number;
  loved: number;
  wouldLove: number;
  errors: { artist: string; track: string; message: string }[];
  /** Spotify asked us to back off; the rest is retried on the next run. */
  interrupted?: string;
};

type SpotifyLikes = { getLikedTracks(limit?: number, fresh?: boolean): Promise<SpotifyTrack[]> };
type LastFmLoves = { loveTrack(track: TrackIdentity): Promise<void> };

type RecentRow = { artist: string; track: string; artist_key: string; track_key: string };

export class RecentLikeLoveSync {
  private readonly db: DatabaseSync;
  private liked: { index: TrackIdentityIndex<SpotifyTrack>; fetchedAt: number } | undefined;

  constructor(
    dbPath: string,
    private readonly username: string,
    private readonly spotify: SpotifyLikes,
    private readonly lastfm: LastFmLoves,
    private readonly options: { mode: LikeLoveMode; windowSeconds: number; likedCacheMs: number; now?: () => number },
  ) {
    const absolutePath = resolve(dbPath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    this.db = new DatabaseSync(absolutePath);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS like_love_log (
        username TEXT NOT NULL,
        artist_key TEXT NOT NULL,
        track_key TEXT NOT NULL,
        artist TEXT NOT NULL,
        track TEXT NOT NULL,
        spotify_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('loved', 'would_love')),
        recorded_at INTEGER NOT NULL,
        PRIMARY KEY (username, artist_key, track_key)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  async run(): Promise<LikeLoveSummary> {
    const { mode } = this.options;
    const summary: LikeLoveSummary = { mode, recentUnloved: 0, matched: 0, loved: 0, wouldLove: 0, errors: [] };
    if (mode === "off") return summary;

    const recent = this.recentUnloved();
    summary.recentUnloved = recent.length;
    // Nothing new was played: do not page through the whole liked library.
    if (recent.length === 0) return summary;

    let index: TrackIdentityIndex<SpotifyTrack>;
    try {
      index = await this.likedIndex();
    } catch (error) {
      if (error instanceof SpotifyApiError && error.status === 429) {
        summary.interrupted = "spotify_rate_limit";
        return summary;
      }
      throw error;
    }

    for (const row of recent) {
      const scrobbled = trackIdentity({ artist: row.artist, title: row.track });
      const match = index.resolve(scrobbled);
      // Only exact or normalized-exact matches are written. Probable matches
      // (missing feature credits, punctuation) would love the wrong version.
      if (!match.track || !isSafeMatch(match)) continue;
      summary.matched += 1;

      if (mode === "dry-run") {
        this.record(row, match.track.spotifyId, "would_love");
        summary.wouldLove += 1;
        console.log(JSON.stringify({ event: "like_love_would_love", artist: row.artist, track: row.track }));
        continue;
      }
      try {
        // Love the Last.fm spelling: that is what the scrobbles carry.
        await this.lastfm.loveTrack(scrobbled);
        this.record(row, match.track.spotifyId, "loved");
        this.db.prepare("UPDATE scrobbles SET loved = 1 WHERE username = ? AND artist_key = ? AND track_key = ?")
          .run(this.username, row.artist_key, row.track_key);
        summary.loved += 1;
      } catch (error) {
        if (summary.errors.length < 50) {
          summary.errors.push({ artist: row.artist, track: row.track, message: error instanceof Error ? error.message : "Unknown error" });
        }
      }
    }
    return summary;
  }

  private recentUnloved(): RecentRow[] {
    const since = Math.floor(this.now() / 1_000) - this.options.windowSeconds;
    // In dry-run, skip what was already reported; in "on", only skip what was really loved.
    const skipStatuses = this.options.mode === "dry-run" ? ["loved", "would_love"] : ["loved"];
    return this.db.prepare(`
      SELECT MAX(s.artist) AS artist, MAX(s.track) AS track, s.artist_key, s.track_key
      FROM scrobbles s
      WHERE s.username = ? AND s.played_at_unix >= ?
      GROUP BY s.artist_key, s.track_key
      HAVING MAX(s.loved) = 0
        AND NOT EXISTS (
          SELECT 1 FROM like_love_log l
          WHERE l.username = s.username AND l.artist_key = s.artist_key AND l.track_key = s.track_key
            AND l.status IN (${skipStatuses.map(() => "?").join(", ")})
        )
    `).all(this.username, since, ...skipStatuses) as RecentRow[];
  }

  private async likedIndex(): Promise<TrackIdentityIndex<SpotifyTrack>> {
    if (this.liked && this.now() - this.liked.fetchedAt < this.options.likedCacheMs) return this.liked.index;
    const tracks = await this.spotify.getLikedTracks(Infinity, true);
    this.liked = { index: new TrackIdentityIndex(tracks), fetchedAt: this.now() };
    return this.liked.index;
  }

  private record(row: RecentRow, spotifyId: string | undefined, status: "loved" | "would_love"): void {
    this.db.prepare(`
      INSERT INTO like_love_log (username, artist_key, track_key, artist, track, spotify_id, status, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(username, artist_key, track_key) DO UPDATE SET
        status = excluded.status, spotify_id = excluded.spotify_id, recorded_at = excluded.recorded_at
    `).run(this.username, row.artist_key, row.track_key, row.artist, row.track, spotifyId ?? null, status, Math.floor(this.now() / 1_000));
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
