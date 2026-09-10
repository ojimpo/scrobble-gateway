import { identityKey, isSafeMatch, resolveTrack, uniqueTracks, TrackIdentityIndex, type TrackIdentity, type MatchStatus } from "./track-identity.js";
import { spotifyTrackUri, SpotifyApiError, type SpotifyTrack, type SpotifyPlaylist } from "./providers/spotify/client.js";

export interface SpotifyLibrary {
  getLikedTracks(limit?: number, fresh?: boolean): Promise<SpotifyTrack[]>;
  searchTrack(artist: string, title: string): Promise<SpotifyTrack[]>;
  saveTracks(tracks: string[]): Promise<void>;
  createPlaylist(name: string, description?: string, isPublic?: boolean): Promise<SpotifyPlaylist>;
  addTracksToPlaylist(id: string, tracks: string[]): Promise<{ added: number }>;
}
export interface LastFmLibrary {
  getAllLovedTracks(): Promise<TrackIdentity[]>;
  findTrack(track: TrackIdentity): Promise<TrackIdentity[]>;
  getTrackCorrections(track: TrackIdentity): Promise<TrackIdentity[]>;
  loveTrack(track: TrackIdentity): Promise<void>;
}
export type SyncDirection = "spotify_to_lastfm" | "lastfm_to_spotify";
type Entry = { source: TrackIdentity; status: MatchStatus | "already_synced" | "error"; target?: TrackIdentity; error?: string };
export type SyncSummary = {
  direction: SyncDirection; dryRun: boolean; scanned: number; duplicates: number; alreadySynced: number;
  added: number; wouldAdd: number; unmatched: number; ambiguous: number; probable: number;
  errorCount: number; errors: { artist: string; title: string; message: string }[];
  interrupted?: { reason: "spotify_rate_limit"; retryAfterSeconds: number };
};

export class MusicLibraryService {
  private running = false;
  constructor(private readonly spotify: SpotifyLibrary, private readonly lastfm: LastFmLibrary,
    private readonly mutationsEnabled: boolean, private readonly autoSyncEnabled: boolean) {}

  async sync(direction: SyncDirection, dryRun = true, automatic = false): Promise<SyncSummary> {
    if (!dryRun && !(automatic && direction === "spotify_to_lastfm" ? this.autoSyncEnabled : this.mutationsEnabled)) {
      throw new Error("Music writes are disabled; enable MCP_ENABLE_MUTATIONS for manual writes or SPOTIFY_AUTO_SYNC_ENABLED for automatic Spotify → Last.fm sync");
    }
    if (this.running) throw new Error("Music library sync is already running; try again after it finishes");
    this.running = true;
    try {
      const [spotify, lastfm] = await Promise.all([this.spotify.getLikedTracks(Infinity, true), this.lastfm.getAllLovedTracks()]);
      const source = direction === "spotify_to_lastfm" ? spotify : lastfm;
      const target = direction === "spotify_to_lastfm" ? lastfm : spotify;
      const targetIndex = new TrackIdentityIndex(target);
      const result: SyncSummary = { direction, dryRun, scanned: source.length, duplicates: source.length - uniqueTracks(source).length,
        alreadySynced: 0, added: 0, wouldAdd: 0, unmatched: 0, ambiguous: 0, probable: 0, errorCount: 0, errors: [] };
      const planned = new Set<string>();
      const pending: TrackIdentity[] = [];
      for (const track of uniqueTracks(source)) {
        const entry = await this.resolveEntry(track, targetIndex, direction);
        if (entry.status === "already_synced") { result.alreadySynced++; continue; }
        if (entry.status === "error") { this.addError(result, track, entry.error ?? "Resolution failed"); continue; }
        if (!entry.target || !["exact", "normalized_exact"].includes(entry.status)) {
          if (entry.status === "probable") { result.probable++; result.unmatched++; }
          else if (entry.status === "ambiguous") result.ambiguous++;
          else result.unmatched++;
          continue;
        }
        const key = direction === "lastfm_to_spotify" ? entry.target.spotifyId! : identityKey(entry.target);
        if (planned.has(key)) { result.duplicates++; continue; }
        planned.add(key);
        result.wouldAdd++;
        if (dryRun) continue;
        if (direction === "lastfm_to_spotify") pending.push(entry.target);
        else {
          try { await this.lastfm.loveTrack(entry.target); result.added++; targetIndex.add(entry.target); }
          catch (error) { this.addError(result, track, message(error)); }
        }
      }
      for (let i = 0; i < pending.length; i += 40) {
        const batch = pending.slice(i, i + 40);
        try { await this.spotify.saveTracks(batch.map((t) => t.spotifyId!)); result.added += batch.length; }
        catch (error) {
          for (const track of batch) this.addError(result, track, message(error));
          if (error instanceof SpotifyApiError && error.status === 429) {
            result.interrupted = { reason: "spotify_rate_limit", retryAfterSeconds: Math.ceil(error.retryAfterMs / 1000) };
            break;
          }
        }
      }
      return result;
    } finally { this.running = false; }
  }

  async compare(limit = 100, offset = 0) {
    const [spotify, lastfm] = await Promise.all([this.spotify.getLikedTracks(), this.lastfm.getAllLovedTracks()]);
    const compareDirection = async (source: TrackIdentity[], target: TrackIdentity[], direction: SyncDirection) => {
      const entries: Entry[] = [];
      const targetIndex = new TrackIdentityIndex(target);
      for (const track of uniqueTracks(source)) entries.push(await this.resolveEntry(track, targetIndex, direction));
      const missing = entries.filter((entry) => entry.status !== "already_synced");
      return { scanned: source.length, alreadySynced: entries.length - missing.length, missing: missing.length,
        ambiguous: entries.filter((e) => e.status === "ambiguous").length,
        unresolved: entries.filter((e) => ["unmatched", "probable"].includes(e.status)).length,
        errors: entries.filter((e) => e.status === "error").length,
        entries: missing.slice(offset, offset + limit), nextOffset: offset + limit < missing.length ? offset + limit : null };
    };
    return { spotifyLikedNotLastfmLoved: await compareDirection(spotify, lastfm, "spotify_to_lastfm"),
      lastfmLovedNotSpotifyLiked: await compareDirection(lastfm, spotify, "lastfm_to_spotify"), offset, limit };
  }

  async createPlaylistFromTracks(input: { name: string; description?: string; tracks: string[]; public?: boolean; dryRun?: boolean }) {
    const uris = [...new Set(input.tracks.map(spotifyTrackUri))];
    const dryRun = input.dryRun ?? true;
    if (dryRun) return { dryRun, name: input.name, public: input.public ?? false, trackCount: uris.length };
    this.requireManualWrites();
    const playlist = await this.spotify.createPlaylist(input.name, input.description ?? "", input.public ?? false);
    try {
      const result = await this.spotify.addTracksToPlaylist(playlist.spotifyId, uris);
      return { dryRun, playlist, ...result };
    } catch (error) {
      // Return the created resource so the caller can resume without creating another playlist.
      return { dryRun, playlist, partial: true, error: message(error) };
    }
  }

  async addTracksToPlaylist(id: string, tracks: string[], dryRun = true) {
    const uris = tracks.map(spotifyTrackUri);
    if (dryRun) return { dryRun, playlistId: id, wouldAdd: uris.length };
    this.requireManualWrites();
    return { dryRun, playlistId: id, ...await this.spotify.addTracksToPlaylist(id, uris) };
  }

  private requireManualWrites(): void {
    if (!this.mutationsEnabled) throw new Error("MCP_ENABLE_MUTATIONS=true is required for manual music writes");
  }

  private async resolveEntry(source: TrackIdentity, target: TrackIdentityIndex, direction: SyncDirection): Promise<Entry> {
    if (!source.artist || !source.title || ("available" in source && !source.available)) return { source, status: "unmatched" };
    const existing = target.resolve(source);
    if (isSafeMatch(existing)) return { source, status: "already_synced", target: existing.track! };
    if (existing.status === "ambiguous" || existing.status === "probable") return { source, status: existing.status };
    try {
      const candidates = direction === "spotify_to_lastfm" ? await this.lastfm.findTrack(source)
        : await this.spotify.searchTrack(source.artist, source.title);
      const match = resolveTrack(source, candidates);
      if (match.track && isSafeMatch(match)) {
        const canonicalExisting = target.resolve(match.track);
        if (isSafeMatch(canonicalExisting)) return { source, status: "already_synced", target: canonicalExisting.track! };
        if (canonicalExisting.status === "ambiguous" || canonicalExisting.status === "probable") return { source, status: canonicalExisting.status };
        if (direction === "spotify_to_lastfm") {
          // Use provider-confirmed corrections only to recognize existing loves, never to loosen write matching.
          const corrections = uniqueTracks(await this.lastfm.getTrackCorrections(match.track));
          if (corrections.length > 1) return { source, status: "ambiguous" };
          if (corrections[0]) {
            const correctedExisting = target.resolve(corrections[0]);
            if (isSafeMatch(correctedExisting)) return { source, status: "already_synced", target: correctedExisting.track! };
            if (correctedExisting.status === "ambiguous" || correctedExisting.status === "probable") return { source, status: correctedExisting.status };
          }
        }
      }
      return { source, status: match.status, ...(match.track ? { target: match.track } : {}) };
    } catch (error) {
      // A provider-wide block is not an unmatched track. Stop scanning instead of retrying every remaining item.
      if (error instanceof SpotifyApiError && error.status === 429) throw error;
      return { source, status: "error", error: message(error) };
    }
  }
  private addError(result: SyncSummary, track: TrackIdentity, error: string): void {
    result.errorCount++;
    if (result.errors.length < 100) result.errors.push({ artist: track.artist, title: track.title, message: error });
  }
}

function message(error: unknown): string { return error instanceof Error ? error.message : "Unknown provider error"; }
