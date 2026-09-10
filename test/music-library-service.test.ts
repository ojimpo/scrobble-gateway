import { describe, expect, it, vi } from "vitest";
import { MusicLibraryService, type LastFmLibrary, type SpotifyLibrary } from "../src/music-library-service.js";
import { trackIdentity as t } from "../src/track-identity.js";
import type { SpotifyTrack } from "../src/providers/spotify/client.js";
import { SpotifyApiError } from "../src/providers/spotify/client.js";
const id = "a".repeat(22);
const source: SpotifyTrack = { ...t({ artist: "Artist", title: "Song", spotifyId: id }), album: "Album", durationMs: 123, available: true };
function setup(mutations = true, automatic = true) {
  const saved: SpotifyTrack[] = [];
  const loved = [t({ artist: "Other", title: "Other song" })];
  const spotify = { getLikedTracks: vi.fn(async () => [...saved]), searchTrack: vi.fn(async () => [source]),
    saveTracks: vi.fn(async (_ids: string[]) => { saved.push(source); }),
    createPlaylist: vi.fn(async () => ({ spotifyId: id, name: "Example", url: null, public: false })),
    addTracksToPlaylist: vi.fn(async (_id: string, tracks: string[]) => ({ added: tracks.length })) } satisfies SpotifyLibrary;
  const lastfm = { getAllLovedTracks: vi.fn(async () => [...loved]), findTrack: vi.fn(async () => [t({ artist: "Artist", title: "Song" })]),
    getTrackCorrections: vi.fn<LastFmLibrary["getTrackCorrections"]>(async () => []),
    loveTrack: vi.fn(async (track) => { loved.push(track); }) } satisfies LastFmLibrary;
  return { saved, loved, spotify, lastfm, service: new MusicLibraryService(spotify, lastfm, mutations, automatic) };
}
describe("MusicLibraryService", () => {
  it("stops bulk catalog resolution on a provider-wide 429", async () => {
    const { service, loved, spotify } = setup();
    loved.push(t({ artist: "Another", title: "Track" }));
    spotify.searchTrack.mockRejectedValueOnce(new SpotifyApiError(429, 60000));
    await expect(service.sync("lastfm_to_spotify")).rejects.toThrow("429");
    expect(spotify.searchTrack).toHaveBeenCalledTimes(1);
    expect(spotify.saveTracks).not.toHaveBeenCalled();
    expect(spotify.getLikedTracks).toHaveBeenCalledWith(Infinity, true);
  });
  it("recognizes existing Flёur loves through Last.fm's explicit Flëur correction despite different MBIDs", async () => {
    const { service, saved, loved, lastfm } = setup();
    const title = "Мы никогда не умрём";
    saved.push({ ...source, ...t({ artist: "Flëur", title, spotifyId: id }) });
    const original = t({ artist: "Flëur", title, mbid: "5d792472-ee53-4e35-9fd3-32e98267e0f4" });
    const corrected = t({ artist: "Flёur", title, mbid: "2f6de2ac-09bc-3560-8d8f-af9b24e07752" });
    loved.splice(0, loved.length, corrected);
    lastfm.findTrack.mockResolvedValue([original]);
    lastfm.getTrackCorrections.mockResolvedValue([corrected]);
    expect(await service.sync("spotify_to_lastfm", false)).toMatchObject({ alreadySynced: 1, wouldAdd: 0, added: 0 });
    expect(lastfm.loveTrack).not.toHaveBeenCalled();
  });

  it("defaults to dry-run and deduplicates source likes", async () => {
    const { service, saved, lastfm } = setup(); saved.push(source, source);
    expect(await service.sync("spotify_to_lastfm")).toMatchObject({ dryRun: true, scanned: 2, duplicates: 1, wouldAdd: 1, added: 0 });
    expect(lastfm.loveTrack).not.toHaveBeenCalled();
  });
  it("is idempotent across repeated Spotify → Last.fm runs", async () => {
    const { service, saved, lastfm } = setup(); saved.push(source);
    expect(await service.sync("spotify_to_lastfm", false)).toMatchObject({ added: 1 });
    expect(await service.sync("spotify_to_lastfm", false)).toMatchObject({ added: 0, alreadySynced: 1 });
    expect(lastfm.loveTrack).toHaveBeenCalledTimes(1);
  });
  it("is idempotent across repeated Last.fm → Spotify runs", async () => {
    const { service, loved, spotify } = setup(); loved.splice(0, 1, t({ artist: "Artist", title: "Song" }));
    expect(await service.sync("lastfm_to_spotify", false)).toMatchObject({ added: 1 });
    expect(await service.sync("lastfm_to_spotify", false)).toMatchObject({ added: 0, alreadySynced: 1 });
    expect(spotify.saveTracks).toHaveBeenCalledTimes(1);
  });
  it("does not write in reverse dry-run", async () => {
    const { service, loved, spotify } = setup(); loved.splice(0, 1, t({ artist: "Artist", title: "Song" }));
    expect(await service.sync("lastfm_to_spotify")).toMatchObject({ added: 0, wouldAdd: 1 });
    expect(spotify.saveTracks).not.toHaveBeenCalled();
  });
  it("skips ambiguous, probable, and unavailable sources", async () => {
    const { service, loved, spotify } = setup(); loved.splice(0, 1, t({ artist: "Artist", title: "Song" }));
    spotify.searchTrack.mockResolvedValueOnce([source, { ...source, spotifyId: "b".repeat(22) }]);
    expect(await service.sync("lastfm_to_spotify", false)).toMatchObject({ ambiguous: 1, added: 0 });
    spotify.searchTrack.mockResolvedValueOnce([{ ...source, ...t({ artist: "Artist feat. Guest", title: "Song" }) }]);
    expect(await service.sync("lastfm_to_spotify", false)).toMatchObject({ probable: 1, unmatched: 1, added: 0 });
    expect(spotify.saveTracks).not.toHaveBeenCalled();
  });
  it("separates background authorization from public MCP writes", async () => {
    const { service, saved } = setup(false, true); saved.push(source);
    await expect(service.sync("spotify_to_lastfm", false)).rejects.toThrow("disabled");
    expect(await service.sync("spotify_to_lastfm", false, true)).toMatchObject({ added: 1 });
    await expect(service.sync("lastfm_to_spotify", false, true)).rejects.toThrow("disabled");
  });
  it("reports per-track errors and retries missing tracks on the next run", async () => {
    const { service, saved, lastfm } = setup(); saved.push(source);
    lastfm.loveTrack.mockRejectedValueOnce(new Error("temporary failure"));
    expect(await service.sync("spotify_to_lastfm", false)).toMatchObject({ added: 0, errorCount: 1 });
    expect(await service.sync("spotify_to_lastfm", false)).toMatchObject({ added: 1, errorCount: 0 });
  });
  it("does not overlap a manual and an automatic sync", async () => {
    const { service, spotify } = setup();
    let release!: (value: SpotifyTrack[]) => void;
    spotify.getLikedTracks.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const first = service.sync("spotify_to_lastfm");
    await expect(service.sync("spotify_to_lastfm", false, true)).rejects.toThrow("already running");
    release([]); await first;
    await expect(service.sync("spotify_to_lastfm")).resolves.toMatchObject({ scanned: 0 });
  });
  it("comparison is read-only and reports both differences", async () => {
    const { service, saved, lastfm, spotify } = setup(); saved.push(source);
    const comparison = await service.compare();
    expect(comparison.spotifyLikedNotLastfmLoved.missing).toBe(1);
    expect(comparison.lastfmLovedNotSpotifyLiked.unresolved).toBe(1);
    expect(lastfm.loveTrack).not.toHaveBeenCalled(); expect(spotify.saveTracks).not.toHaveBeenCalled();
  });
  it("validates all playlist inputs before creating and returns partial resource on append failure", async () => {
    const { service, spotify } = setup();
    await expect(service.createPlaylistFromTracks({ name: "Example", tracks: ["invalid"], dryRun: false })).rejects.toThrow("Spotify track ID");
    expect(spotify.createPlaylist).not.toHaveBeenCalled();
    expect(await service.createPlaylistFromTracks({ name: "Example", tracks: [id, id] })).toMatchObject({ dryRun: true, trackCount: 1 });
    spotify.addTracksToPlaylist.mockRejectedValueOnce(new Error("timeout; inspect before retrying"));
    expect(await service.createPlaylistFromTracks({ name: "Example", tracks: [id], dryRun: false })).toMatchObject({ partial: true, playlist: { spotifyId: id } });
  });
});
