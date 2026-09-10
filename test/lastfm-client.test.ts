import { describe, expect, it, vi } from "vitest";
import { LastFmClient } from "../src/lastfm-client.js";
import { createHash } from "node:crypto";
import { trackIdentity } from "../src/track-identity.js";

function client(fetchImpl: typeof fetch) {
  return new LastFmClient({
    apiKey: "secret-api-key",
    username: "listener",
    baseUrl: "https://ws.audioscrobbler.com/2.0/",
    timeoutMs: 1_000,
    maxRetries: 1,
    minRequestIntervalMs: 0,
    cacheTtlMs: 0,
    fetchImpl,
  });
}

describe("LastFmClient", () => {
  it("normalizes Last.fm's explicit track correction response", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ corrections: { correction: {
      track: { name: "Мост над туманным заливом", artist: { name: "Flёur" }, mbid: "47814edc-6608-3841-ad7f-8f30d7c085c3" },
      "@attr": { artistcorrected: "1", trackcorrected: "0" },
    } } }));
    const corrections = await client(fetchImpl).getTrackCorrections(trackIdentity({ artist: "Flëur", title: "Мост над туманным заливом" }));
    expect(corrections).toEqual([expect.objectContaining({ artist: "Flёur", title: "Мост над туманным заливом", mbid: "47814edc-6608-3841-ad7f-8f30d7c085c3" })]);
    expect(new URL(String(fetchImpl.mock.calls[0]?.[0])).searchParams.get("method")).toBe("track.getCorrection");
  });

  it("reads every loved-track page without caching reconciliation snapshots", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      const page = new URL(String(url)).searchParams.get("page");
      return Response.json({ lovedtracks: { track: [{ name: `Song ${page}`, artist: { name: "Artist" } }], "@attr": { totalPages: "2" } } });
    });
    const api = client(fetchImpl);
    expect(await api.getAllLovedTracks()).toHaveLength(2);
    expect(await api.getAllLovedTracks()).toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("sends signed loves in POST body without exposing session credentials in the URL", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}));
    const api = new LastFmClient({ apiKey: "key", apiSecret: "secret", username: "listener", baseUrl: "https://ws.audioscrobbler.com/2.0/",
      timeoutMs: 1000, maxRetries: 0, minRequestIntervalMs: 0, cacheTtlMs: 0, fetchImpl, getSessionKey: async () => "session" });
    await api.loveTrack(trackIdentity({ artist: "Björk", title: "Jóga" }));
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(new URL(String(url)).search).toBe("");
    expect(init?.method).toBe("POST");
    const body = init?.body as URLSearchParams;
    expect(body.get("sk")).toBe("session");
    expect(body.get("api_sig")).toBe(createHash("md5").update("api_keykeyartistBjörkmethodtrack.lovesksessiontrackJógasecret").digest("hex"));
  });

  it("refuses authorization for a different Last.fm account", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ session: { name: "someone-else", key: "secret" } }));
    const api = new LastFmClient({ apiKey: "key", apiSecret: "secret", username: "listener", baseUrl: "https://ws.audioscrobbler.com/2.0/",
      timeoutMs: 1000, maxRetries: 0, minRequestIntervalMs: 0, cacheTtlMs: 0, fetchImpl });
    await expect(api.completeAuth("token")).rejects.toThrow("does not match");
  });

  it("normalizes current and historical recent tracks", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        recenttracks: {
          track: [
            {
              name: "Current Song",
              artist: { name: "Current Artist", mbid: "" },
              album: { name: "Current Album", mbid: "" },
              mbid: "",
              url: "https://last.fm/current",
              loved: "0",
              "@attr": { nowplaying: "true" },
            },
            {
              name: "Older Song",
              artist: { name: "Older Artist", mbid: "artist-mbid" },
              album: { name: "Older Album", mbid: "album-mbid" },
              mbid: "track-mbid",
              url: "https://last.fm/older",
              loved: "1",
              date: { uts: "1722470400" },
            },
          ],
          "@attr": { page: "1", perPage: "2", totalPages: "5", total: "10" },
        },
      }),
    );

    const result = await client(fetchImpl).getRecentTracksPage({ page: 1, limit: 2 });

    expect(result.pageInfo).toEqual({ page: 1, perPage: 2, totalPages: 5, total: 10 });
    expect(result.tracks[0]).toMatchObject({ nowPlaying: true, playedAt: null, mbid: null });
    expect(result.tracks[1]).toMatchObject({
      nowPlaying: false,
      loved: true,
      artist: "Older Artist",
      album: "Older Album",
      playedAt: "2024-08-01T00:00:00.000Z",
    });
    const requested = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(requested.searchParams.get("api_key")).toBe("secret-api-key");
    expect(requested.searchParams.get("extended")).toBe("1");
  });

  it("retries Last.fm rate-limit errors", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: 29, message: "Rate limit exceeded" }))
      .mockResolvedValueOnce(
        Response.json({
          topartists: {
            artist: [{ name: "Invent Animate", playcount: "842", mbid: "", url: "https://last.fm/a", "@attr": { rank: "1" } }],
          },
        }),
      );

    const result = await client(fetchImpl).getTopArtists("overall", 1);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result).toEqual([
      { rank: 1, name: "Invent Animate", playcount: 842, mbid: null, url: "https://last.fm/a" },
    ]);
  });
});
