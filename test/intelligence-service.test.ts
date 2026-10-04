import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ArtistContext, LastFmApi } from "../src/domain.js";
import { HistoryRepository } from "../src/history-repository.js";
import { IntelligenceRepository } from "../src/intelligence-repository.js";
import { IntelligenceService } from "../src/intelligence-service.js";
import type { MusicBrainzClient } from "../src/musicbrainz-client.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("IntelligenceService recommendations", () => {
  it("builds bridge candidates from multiple personal seeds, records them, and evaluates later plays", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lastfm-recommendations-"));
    directories.push(directory);
    const path = join(directory, "history.sqlite");
    const history = new HistoryRepository(path);
    const now = Math.floor(Date.now() / 1000);
    history.upsertTracks("listener", [
      ...plays("Alpha", 20, now - 10_000),
      ...plays("Beta", 15, now - 20_000),
    ]);
    history.markSync("listener", "full", true, now);
    const repository = new IntelligenceRepository(path);
    const api = {
      getArtistContext: async (artist: string) => context(artist, artist === "Alpha"
        ? [{ name: "Bridge Artist", match: 0.8 }, { name: "Solo Neighbor", match: 0.95 }]
        : [{ name: "Bridge Artist", match: 0.7 }]),
      getArtistTopAlbums: async (artist: string) => [{ rank: 1, name: "Start Album", artist, playcount: 100, mbid: null, artistMbid: null, url: "" }],
      getArtistTopTracks: async (artist: string) => [{ rank: 1, name: "Start Track", artist, playcount: 100, mbid: null, artistMbid: null, url: "" }],
    } as unknown as LastFmApi;
    const musicbrainz = { getArtistFeatures: async () => null } as unknown as MusicBrainzClient;
    const service = new IntelligenceService(api, musicbrainz, repository, history, "listener");

    const output = await service.getRecommendations({
      count: 5,
      mode: "bridge",
      excludeExposureAbove: "sampled",
      explain: true,
    });

    expect(output.recommendations).toHaveLength(1);
    expect(output.recommendations[0]).toMatchObject({
      artist: "Bridge Artist",
      exposure: "unheard",
      startWith: { album: "Start Album", tracks: ["Start Track"] },
    });
    expect(repository.listRecommendations("listener")).toHaveLength(1);

    history.upsertTracks("listener", [singlePlay("Bridge Artist", now + 60)]);
    expect(service.evaluateRecommendations().outcomes[0]).toMatchObject({
      artist: "Bridge Artist",
      outcome: "sampled",
      playsAfterRecommendation: 1,
    });

    repository.close();
    history.close();
  });

  it("keeps full session context and resolves canonical query variants for affinity and album runs", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lastfm-context-"));
    directories.push(directory);
    const path = join(directory, "history.sqlite");
    const history = new HistoryRepository(path);
    const start = 1_700_000_000;
    history.upsertTracks("listener", [
      { ...singlePlay("Artist", start), name: "One", album: "Album" },
      { ...singlePlay("Other", start + 60), name: "Interruption", album: "Elsewhere" },
      { ...singlePlay("Artist", start + 120), name: "Two", album: "Album" },
    ]);
    history.markSync("listener", "full", true, start + 1_000, start + 1_000);
    const repository = new IntelligenceRepository(path);
    const musicbrainz = {
      getAlbumTracklist: async () => ({
        releaseGroup: { mbid: "rg" },
        release: { mbid: "release", title: "Album" },
        media: [{ tracks: [{ title: "One" }, { title: "Two" }] }],
        totalTracks: 2,
      }),
    } as unknown as MusicBrainzClient;
    const service = new IntelligenceService({} as LastFmApi, musicbrainz, repository, history, "listener");

    const affinity = await service.getArtistAffinity("Artist feat. Guest");
    const exposure = await service.getAlbumExposure("Artist feat. Guest", "Album (Deluxe Edition)");
    const sessions = service.getListeningSessions({ artist: "Artist", gapMinutes: 45, limit: 10 });
    const matrix = service.getListeningMatrix({
      from: start,
      to: start + 180,
      bucket: "day",
      dimension: "artist",
      minPlays: 1,
      entityOffset: 0,
      includeEmptyBuckets: true,
      maxCells: 100,
    });

    expect(affinity.totalPlays).toBe(2);
    expect(exposure).toMatchObject({ runCount: 2, fullRuns: 0, nearFullRuns: 0 });
    expect(sessions.sessions[0]?.artists).toEqual(expect.arrayContaining([
      { artist: "Artist", plays: 2 },
      { artist: "Other", plays: 1 },
    ]));
    expect(matrix).toMatchObject({
      from: new Date(start * 1000).toISOString(),
      to: new Date((start + 180) * 1000).toISOString(),
      minimumTimestamp: "2002-01-01T00:00:00.000Z",
      matrix: { dimensions: { buckets: 1, entities: 2 } },
      filtering: { complete: true, playCoverage: 1 },
      history: { fullHistorySynced: true },
    });
    expect(matrix.entities[0]?.firstPlayedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const locked = new IntelligenceService({} as LastFmApi, musicbrainz, repository, history, "listener", false);
    expect(() => locked.recordMusicFeedback({ artist: "Artist", verdict: "like" })).toThrow(/mutations are disabled/i);
    expect(() => locked.getFeedbackContext(10)).toThrow(/private preference data is disabled/i);
    expect(() => service.recordPreferenceSignal({ target: { album: "Album" }, dimensions: { atmosphere: 2 } }))
      .toThrow(/artist is required/i);

    repository.close();
    history.close();
  });
});

function plays(artist: string, count: number, start: number) {
  return Array.from({ length: count }, (_, index) => singlePlay(artist, start + index * 60));
}

function singlePlay(artist: string, at: number) {
  return {
    name: "Track",
    artist,
    album: "Album",
    mbid: null,
    artistMbid: null,
    albumMbid: null,
    url: "",
    loved: false,
    nowPlaying: false,
    playedAt: new Date(at * 1000).toISOString(),
    playedAtUnix: at,
  };
}

function context(artist: string, similar: Array<{ name: string; match: number }>): ArtistContext {
  return {
    name: artist,
    mbid: null,
    url: "",
    listeners: null,
    playcount: null,
    userPlaycount: null,
    tags: [],
    similarArtists: similar.map((item) => ({ ...item, url: "" })),
    bioSummary: null,
  };
}
