import { describe, expect, it, vi } from "vitest";
import { SpotifyClient } from "../src/providers/spotify/client.js";

const id = "a".repeat(22);
const rawTrack = { id, name: "Song", artists: [{ name: "Artist" }], album: { name: "Album" }, duration_ms: 1234 };
function setup() {
  const fetchImpl = vi.fn<typeof fetch>();
  const auth = { accessToken: vi.fn(async () => "token") };
  const sleep = vi.fn(async (_ms: number) => undefined);
  return { client: new SpotifyClient(auth, fetchImpl, sleep), fetchImpl, auth, sleep };
}

describe("SpotifyClient", () => {
  it("paginates all likes and preserves null/unavailable entries for reporting", async () => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValueOnce(Response.json({ items: [{ track: rawTrack, added_at: "2026-01-01" }], next: "https://api.spotify.com/v1/me/tracks?offset=1" }))
      .mockResolvedValueOnce(Response.json({ items: [{ track: null }], next: null }));
    const result = await client.getLikedTracks();
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ artist: "Artist", title: "Song", spotifyId: id, addedAt: "2026-01-01" });
    expect(result[1]?.available).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("honors bounded reads without fetching another page", async () => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValue(Response.json({ items: [{ track: rawTrack }, { track: rawTrack }], next: "https://api.spotify.com/v1/me/tracks?offset=2" }));
    expect(await client.getLikedTracks(1)).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("does not forward bearer tokens to untrusted pagination URLs", async () => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValueOnce(Response.json({ items: [], next: "https://evil.example/v1/tracks" }));
    await expect(client.getLikedTracks()).rejects.toThrow("unsafe pagination");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("fails an incomplete scan with repeated cursors", async () => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockImplementation(async () => Response.json({ items: [], next: "me/tracks?limit=50" }));
    await expect(client.getLikedTracks()).rejects.toThrow("repeated pagination");
  });
  it("refreshes a rejected token once", async () => {
    const { client, fetchImpl, auth } = setup();
    fetchImpl.mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ items: [], next: null }));
    await client.getLikedTracks();
    expect(auth.accessToken).toHaveBeenCalledWith("token");
  });
  it("honors Retry-After and stops on long cooldowns", async () => {
    const { client, fetchImpl, sleep } = setup();
    fetchImpl.mockResolvedValueOnce(Response.json({}, { status: 429, headers: { "retry-after": "2" } }))
      .mockResolvedValueOnce(Response.json({ items: [], next: null }));
    await client.getLikedTracks();
    expect(sleep.mock.calls[0]?.[0]).toBeGreaterThan(1500);
    const other = setup();
    other.fetchImpl.mockResolvedValueOnce(Response.json({}, { status: 429, headers: { "retry-after": "3600" } }));
    await expect(other.client.getLikedTracks()).rejects.toThrow("3600 seconds");
    expect(other.fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("does not retry exhausted account quota", async () => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValueOnce(Response.json({ error: { reason: "QUOTA_EXCEEDED" } }, { status: 429 }));
    await expect(client.getLikedTracks()).rejects.toThrow("account quota exceeded");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("uses generic library endpoint with batches of 40 and deduplicated URIs", async () => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockImplementation(async () => new Response(null, { status: 200 }));
    const ids = Array.from({ length: 41 }, (_, i) => String(i).padStart(22, "0"));
    await client.saveTracks([...ids, ids[0]!]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const url = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/v1/me/library");
    expect(url.searchParams.get("uris")?.split(",")).toHaveLength(40);
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe("PUT");
  });
  it("batches playlist appends at 100 and uses /items", async () => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockImplementation(async () => Response.json({ snapshot_id: "snapshot" }));
    expect(await client.addTracksToPlaylist(id, Array(101).fill(id) as string[])).toEqual({ added: 101 });
    expect(new URL(String(fetchImpl.mock.calls[0]?.[0])).pathname).toBe(`/v1/playlists/${id}/items`);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("does not retry non-idempotent playlist writes after server failures", async () => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValueOnce(Response.json({}, { status: 500 }));
    await expect(client.createPlaylist("Example")).rejects.toThrow("500");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("creates private playlists with the current-user route", async () => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValueOnce(Response.json({ id, name: "Example", public: false }));
    await client.createPlaylist("Example");
    expect(new URL(String(fetchImpl.mock.calls[0]?.[0])).pathname).toBe("/v1/me/playlists");
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({ public: false });
  });
});
