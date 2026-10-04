import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecentTrack } from "../src/domain.js";
import { HistoryRepository } from "../src/history-repository.js";
import type { SpotifyTrack } from "../src/providers/spotify/client.js";
import { SpotifyApiError } from "../src/providers/spotify/client.js";
import { RecentLikeLoveSync, type LikeLoveMode } from "../src/recent-like-love-sync.js";
import { trackIdentity, type TrackIdentity } from "../src/track-identity.js";

const NOW = Date.UTC(2026, 9, 5, 12);
const HOUR = 3_600;
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

describe("RecentLikeLoveSync", () => {
  it("loves liked tracks played within the window and nothing else", async () => {
    const { sync, lastfm, spotify, path } = setup("on", [
      play("スピッツ", "魚", NOW / 1_000 - 2 * HOUR), // liked, recent → love
      play("Oma", "Battlecry - Live", NOW / 1_000 - HOUR), // not liked
      play("The Cure", "Push", NOW / 1_000 - 100 * HOUR), // liked but outside the window
    ], [liked("スピッツ", "魚"), liked("The Cure", "Push")]);

    const summary = await sync.run();

    expect(summary).toMatchObject({ recentUnloved: 2, matched: 1, loved: 1, errors: [] });
    expect(lastfm.loveTrack).toHaveBeenCalledTimes(1);
    expect(lastfm.loveTrack.mock.calls[0]?.[0]).toMatchObject({ artist: "スピッツ", title: "魚" });
    expect(spotify.getLikedTracks).toHaveBeenCalledTimes(1);
    const row = new DatabaseSync(path).prepare("SELECT loved FROM scrobbles WHERE track = '魚'").get() as { loved: number };
    expect(row.loved).toBe(1);
  });

  it("does not love the same track twice", async () => {
    const { sync, lastfm } = setup("on", [play("スピッツ", "魚", NOW / 1_000 - HOUR)], [liked("スピッツ", "魚")]);
    await sync.run();
    await sync.run();
    expect(lastfm.loveTrack).toHaveBeenCalledTimes(1);
  });

  it("only reports in dry-run, and the real run still loves what dry-run reported", async () => {
    const tracks = [play("スピッツ", "魚", NOW / 1_000 - HOUR)];
    const { sync, lastfm, path } = setup("dry-run", tracks, [liked("スピッツ", "魚")]);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(await sync.run()).toMatchObject({ wouldLove: 1, loved: 0 });
    expect(lastfm.loveTrack).not.toHaveBeenCalled();
    expect(await sync.run()).toMatchObject({ recentUnloved: 0 });

    const live = withMode(path, "on", [liked("スピッツ", "魚")]);
    expect(await live.sync.run()).toMatchObject({ loved: 1 });
  });

  it("skips probable matches such as a missing feature credit", async () => {
    const { sync, lastfm } = setup("on", [play("Nujabes", "Luv(sic) pt3 feat. Shing02", NOW / 1_000 - HOUR)], [liked("Nujabes", "Luv(sic) pt3")]);
    expect(await sync.run()).toMatchObject({ matched: 0 });
    expect(lastfm.loveTrack).not.toHaveBeenCalled();
  });

  it("does not page through the liked library when nothing new was played", async () => {
    const { sync, spotify } = setup("on", [play("Old", "Song", NOW / 1_000 - 200 * HOUR)], []);
    await sync.run();
    expect(spotify.getLikedTracks).not.toHaveBeenCalled();
  });

  it("stops quietly on a Spotify rate limit and keeps the track for the next run", async () => {
    const { sync, spotify, lastfm } = setup("on", [play("スピッツ", "魚", NOW / 1_000 - HOUR)], []);
    spotify.getLikedTracks.mockRejectedValueOnce(new SpotifyApiError(429, 30_000));
    expect(await sync.run()).toMatchObject({ interrupted: "spotify_rate_limit", loved: 0 });
    spotify.getLikedTracks.mockResolvedValueOnce([liked("スピッツ", "魚")]);
    expect(await sync.run()).toMatchObject({ loved: 1 });
    expect(lastfm.loveTrack).toHaveBeenCalledTimes(1);
  });

  it("records a failed love and retries it next time", async () => {
    const { sync, lastfm } = setup("on", [play("スピッツ", "魚", NOW / 1_000 - HOUR)], [liked("スピッツ", "魚")]);
    lastfm.loveTrack.mockRejectedValueOnce(new Error("Last.fm session missing"));
    expect(await sync.run()).toMatchObject({ loved: 0, errors: [{ track: "魚", message: "Last.fm session missing" }] });
    expect(await sync.run()).toMatchObject({ loved: 1 });
  });
});

function setup(mode: LikeLoveMode, tracks: RecentTrack[], likedTracks: SpotifyTrack[]) {
  const path = join(mkdtempSync(join(tmpdir(), "like-love-")), "history.sqlite");
  const history = new HistoryRepository(path);
  history.upsertTracks("listener", tracks);
  closers.push(() => history.close());
  return { ...withMode(path, mode, likedTracks), history, path };
}

function withMode(path: string, mode: LikeLoveMode, likedTracks: SpotifyTrack[]) {
  const spotify = { getLikedTracks: vi.fn(async () => likedTracks) };
  const lastfm = { loveTrack: vi.fn(async (_track: TrackIdentity) => undefined) };
  const sync = new RecentLikeLoveSync(path, "listener", spotify, lastfm, {
    mode, windowSeconds: 72 * HOUR, likedCacheMs: 6 * HOUR * 1_000, now: () => NOW,
  });
  closers.push(() => sync.close());
  return { sync, spotify, lastfm };
}

function play(artist: string, name: string, playedAtUnix: number): RecentTrack {
  return {
    name, artist, album: "Album", playedAtUnix,
    playedAt: new Date(playedAtUnix * 1_000).toISOString(),
    nowPlaying: false, loved: false, mbid: null, artistMbid: null, albumMbid: null, url: "https://last.fm/track",
  };
}

function liked(artist: string, title: string): SpotifyTrack {
  return { ...trackIdentity({ artist, title, spotifyId: `id-${artist}-${title}` }), album: null, durationMs: null, available: true };
}
