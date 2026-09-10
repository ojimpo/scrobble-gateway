import { setTimeout as delay } from "node:timers/promises";
import * as z from "zod/v4";
import { trackIdentity, stripRemaster, type TrackIdentity } from "../../track-identity.js";

export type SpotifyTrack = TrackIdentity & { album: string | null; durationMs: number | null; addedAt?: string; playedAt?: string; available: boolean };
export type SpotifyPlaylist = { spotifyId: string; name: string; url: string | null; public: boolean | null };
export type TimeRange = "short_term" | "medium_term" | "long_term";
const recordSchema = z.record(z.string(), z.unknown());
const pageSchema = z.object({ items: z.array(z.unknown()), next: z.string().nullable() });
const rawTrackSchema = z.object({ id: z.string().nullable(), name: z.string(), uri: z.string().optional(),
  artists: z.array(z.object({ name: z.string() })), album: z.object({ name: z.string() }).optional(),
  duration_ms: z.number().optional(), is_local: z.boolean().optional(), is_playable: z.boolean().optional() });
export function spotifyTrack(value: unknown): SpotifyTrack {
  const raw = rawTrackSchema.safeParse(value);
  if (!raw.success) return { ...trackIdentity({ artist: "", title: "" }), album: null, durationMs: null, available: false };
  const t = raw.data;
  return { ...trackIdentity({ artist: t.artists[0]?.name ?? "", title: t.name,
    ...(t.id ? { spotifyId: t.id, spotifyUri: `spotify:track:${t.id}` } : {}) }),
    album: t.album?.name ?? null, durationMs: t.duration_ms ?? null, available: Boolean(t.id && !t.is_local && t.is_playable !== false) };
}
function playlist(value: unknown): SpotifyPlaylist {
  const p = z.object({ id: z.string(), name: z.string(), public: z.boolean().nullable().optional(),
    external_urls: z.object({ spotify: z.string().optional() }).optional() }).parse(value);
  return { spotifyId: p.id, name: p.name, public: p.public ?? null, url: p.external_urls?.spotify ?? null };
}

export function spotifyTrackUri(value: string): string {
  const id = value.replace(/^spotify:track:/u, "");
  if (!/^[a-zA-Z0-9]{22}$/u.test(id)) throw new Error("Expected a Spotify track ID (22 characters) or spotify:track:ID URI");
  return `spotify:track:${id}`;
}

export class SpotifyApiError extends Error {
  constructor(readonly status: number, readonly retryAfterMs: number, readonly quotaExceeded = false) {
    super(`Spotify HTTP ${status}${status === 403 ? "; check app access, Premium and granted scopes" : ""}${status === 429 ? `; ${quotaExceeded ? "account quota exceeded; " : ""}retry after ${Math.ceil(retryAfterMs / 1000)} seconds` : ""}`);
  }
}

export class SpotifyClient {
  private blockedUntil = 0;
  constructor(private readonly auth: { accessToken(rejectedToken?: string): Promise<string> },
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<unknown> = delay) {}

  async getLikedTracks(limit = Infinity): Promise<SpotifyTrack[]> {
    return (await this.pages("me/tracks?limit=50", limit)).map((item) => {
      const saved = recordSchema.parse(item);
      return { ...spotifyTrack(saved.track), ...(typeof saved.added_at === "string" ? { addedAt: saved.added_at } : {}) };
    });
  }
  async getRecentlyPlayed(limit = 50): Promise<SpotifyTrack[]> {
    return (await this.pages("me/player/recently-played?limit=50", limit)).map((item) => {
      const played = recordSchema.parse(item);
      return { ...spotifyTrack(played.track), ...(typeof played.played_at === "string" ? { playedAt: played.played_at } : {}) };
    });
  }
  async getTopTracks(timeRange: TimeRange = "medium_term", limit = 50): Promise<SpotifyTrack[]> {
    return (await this.pages(`me/top/tracks?limit=50&time_range=${timeRange}`, limit)).map(spotifyTrack);
  }
  async getTopArtists(timeRange: TimeRange = "medium_term", limit = 50) {
    return (await this.pages(`me/top/artists?limit=50&time_range=${timeRange}`, limit)).map((value) => {
      const artist = z.object({ id: z.string(), name: z.string() }).parse(value);
      return { name: artist.name, spotifyId: artist.id };
    });
  }
  async getPlaylists(limit = Infinity): Promise<SpotifyPlaylist[]> {
    return (await this.pages("me/playlists?limit=50", limit)).filter((p) => p !== null).map(playlist);
  }
  async searchTrack(artist: string, title: string): Promise<SpotifyTrack[]> {
    const clean = (s: string) => s.replace(/["\\]/gu, " ").trim();
    const query = new URLSearchParams({ q: `artist:"${clean(artist)}" track:"${clean(stripRemaster(title))}"`, type: "track", limit: "10" });
    const result = recordSchema.parse(await this.request(`search?${query}`));
    return z.object({ items: z.array(z.unknown()) }).parse(result.tracks).items.map(spotifyTrack).filter((t) => t.available);
  }
  async saveTracks(tracks: string[]): Promise<void> {
    const uris = [...new Set(tracks.map(spotifyTrackUri))];
    for (let i = 0; i < uris.length; i += 40) {
      await this.request(`me/library?${new URLSearchParams({ uris: uris.slice(i, i + 40).join(",") })}`, "PUT");
    }
  }
  async createPlaylist(name: string, description = "", isPublic = false): Promise<SpotifyPlaylist> {
    return playlist(await this.request("me/playlists", "POST", { name, description, public: isPublic }));
  }
  async addTracksToPlaylist(playlistId: string, tracks: string[]): Promise<{ added: number }> {
    if (!/^[a-zA-Z0-9]{22}$/u.test(playlistId)) throw new Error("Invalid Spotify playlist ID");
    const uris = tracks.map(spotifyTrackUri);
    let added = 0;
    try {
      for (let i = 0; i < uris.length; i += 100) {
        const batch = uris.slice(i, i + 100);
        await this.request(`playlists/${playlistId}/items`, "POST", { uris: batch });
        added += batch.length;
      }
    } catch (error) {
      throw new Error(`Playlist ${playlistId}: ${added} items confirmed added; failed batch may have applied. Inspect before retrying. ${error instanceof Error ? error.message : "Request failed"}`);
    }
    return { added };
  }

  private async pages(path: string, limit: number): Promise<unknown[]> {
    const items: unknown[] = [];
    const seen = new Set<string>();
    let next: string | null = path;
    while (next && items.length < limit) {
      if (seen.has(next)) throw new Error("Spotify returned a repeated pagination cursor; library scan incomplete");
      seen.add(next);
      const page = pageSchema.parse(await this.request(next));
      items.push(...page.items.slice(0, limit - items.length));
      next = page.next;
    }
    return items;
  }

  private async request(path: string, method = "GET", body?: unknown): Promise<unknown> {
    const url = new URL(path, "https://api.spotify.com/v1/");
    if (url.origin !== "https://api.spotify.com" || !url.pathname.startsWith("/v1/") || url.username || url.password) {
      throw new Error("Spotify returned an unsafe pagination URL");
    }
    let token = await this.auth.accessToken();
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const wait = this.blockedUntil - Date.now();
      if (wait > 60_000) throw new SpotifyApiError(429, wait);
      if (wait > 0) await this.sleep(wait);
      const response = await this.fetchImpl(url, { method, redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (response.status === 401 && !refreshed) {
        token = await this.auth.accessToken(token); refreshed = true; continue;
      }
      if (response.ok) {
        const raw = await response.text();
        return raw ? JSON.parse(raw) as unknown : {};
      }
      const raw: unknown = await response.json().catch(() => ({}));
      const parsed = z.object({ error: z.object({ reason: z.string().optional() }).optional() }).safeParse(raw);
      const quota = parsed.success && parsed.data.error?.reason === "QUOTA_EXCEEDED";
      const retrySeconds = Number(response.headers.get("retry-after") ?? "1");
      const retryMs = Number.isFinite(retrySeconds) && retrySeconds >= 0 ? Math.max(1000, retrySeconds * 1000) : 1000;
      if (response.status === 429) this.blockedUntil = Date.now() + retryMs;
      // POSTs are not replayed after a server error: playlist creation/appends are not idempotent.
      if (attempt < 3 && !quota && ((response.status === 429 && retryMs <= 60_000) || (response.status >= 500 && method !== "POST"))) {
        if (response.status !== 429) await this.sleep(300 * 2 ** attempt);
        continue;
      }
      throw new SpotifyApiError(response.status, response.status === 429 ? retryMs : 0, quota);
    }
  }
}
