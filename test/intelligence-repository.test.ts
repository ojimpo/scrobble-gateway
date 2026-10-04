import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HistoryRepository } from "../src/history-repository.js";
import { IntelligenceRepository } from "../src/intelligence-repository.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("IntelligenceRepository", () => {
  it("backfills canonical aliases and aggregates exposure across spelling and edition variants", () => {
    const directory = mkdtempSync(join(tmpdir(), "lastfm-intelligence-"));
    directories.push(directory);
    const path = join(directory, "history.sqlite");
    const history = new HistoryRepository(path);
    history.upsertTracks("listener", [
      recent({ artist: "TesseracT", album: "War of Being (Deluxe Edition)", track: "Natural Disaster", at: 1_700_000_000 }),
      recent({ artist: "Tesseract", album: "War of Being", track: "Legion", at: 1_700_086_400 }),
      recent({
        artist: "Tesserakt",
        album: "Broken Local Album Tag",
        track: "Broken Local Track Tag",
        at: 1_700_172_800,
        artistMbid: "artist-mbid",
        albumMbid: "album-mbid",
        trackMbid: "track-mbid",
      }),
      recent({
        artist: "TesseracT",
        album: "War of Being",
        track: "Legion",
        at: 1_700_259_200,
        artistMbid: "artist-mbid",
        albumMbid: "album-mbid",
        trackMbid: "track-mbid",
      }),
    ]);
    const repository = new IntelligenceRepository(path);

    expect(repository.ensureCanonicalIndex("listener").indexed).toBe(4);
    expect(repository.getArtistExposure("listener", "TESSERACT")).toMatchObject({
      totalPlays: 4,
      albumsPlayed: 1,
      tracksPlayed: 2,
      activeDays: 4,
    });
    expect(repository.getCanonicalEntities("listener", { artist: "Tesseract", album: "War of Being" })).toMatchObject({
      artist: { canonicalName: "TesseracT", aliases: expect.arrayContaining(["TesseracT", "Tesseract"]) },
      album: { canonicalName: "War of Being", aliases: expect.arrayContaining(["War of Being (Deluxe Edition)", "War of Being"]) },
    });

    repository.close();
    history.close();
  });

  it("persists feedback, exclusions, and recommendation baselines", () => {
    const directory = mkdtempSync(join(tmpdir(), "lastfm-intelligence-"));
    directories.push(directory);
    const path = join(directory, "history.sqlite");
    const history = new HistoryRepository(path);
    const repository = new IntelligenceRepository(path);

    repository.recordFeedback("listener", { artist: "Resolve", verdict: "boring", notes: "low interest" });
    repository.recordPreferenceSignal("listener", {
      target: { artist: "Resolve" },
      dimensions: { melody: -2, production: 1 },
    });
    const firstExclusion = repository.excludeRecommendation("listener", { artist: "Resolve", reason: "already tried", policy: "never" });
    const updatedExclusion = repository.excludeRecommendation("listener", { artist: "resolve", reason: "still no", policy: "six_months" });
    const recommendation = repository.recordRecommendation("listener", { artist: "Karnivool", reason: "bridge", mode: "bridge" });
    const repeatedRecommendation = repository.recordRecommendation("listener", {
      artist: "Different Artist",
      recommendationId: recommendation.recommendationId,
      reason: "updated reason",
      mode: "safe",
    });

    expect(repository.listFeedback("listener")).toHaveLength(1);
    expect(repository.listPreferenceSignals("listener")[0]?.dimensions).toEqual({ melody: -2, production: 1 });
    expect(repository.listActiveExclusions("listener")[0]).toMatchObject({ artist: "resolve", policy: "six_months" });
    expect(updatedExclusion.id).toBe(firstExclusion.id);
    expect(repository.listRecommendations("listener")[0]).toMatchObject({
      recommendationId: recommendation.recommendationId,
      artist: "Karnivool",
      mode: "bridge",
      reason: "updated reason",
      baselinePlays: 0,
    });
    expect(repeatedRecommendation).toMatchObject({ artist: "Karnivool", mode: "bridge" });

    repository.close();
    history.close();
  });

  it("rewrites dependent preference and recommendation keys when an MBID merges aliases", () => {
    const directory = mkdtempSync(join(tmpdir(), "lastfm-intelligence-"));
    directories.push(directory);
    const path = join(directory, "history.sqlite");
    const history = new HistoryRepository(path);
    history.upsertTracks("listener", [
      recent({ artist: "Proper Name", album: "Album", track: "One", at: 1_700_000_000 }),
      recent({ artist: "Odd Local Alias", album: "Album", track: "Two", at: 1_700_000_100, artistMbid: "shared-mbid" }),
    ]);
    const repository = new IntelligenceRepository(path);
    repository.ensureCanonicalIndex("listener");
    repository.recordFeedback("listener", { artist: "Odd Local Alias", verdict: "like" });
    repository.recordPreferenceSignal("listener", { target: { artist: "Odd Local Alias" }, dimensions: { atmosphere: 3 } });
    repository.excludeRecommendation("listener", { artist: "Odd Local Alias", reason: "later", policy: "never" });
    repository.recordRecommendation("listener", { artist: "Odd Local Alias", reason: "test" });

    history.upsertTracks("listener", [
      recent({ artist: "Proper Name", album: "Album", track: "Three", at: 1_700_000_200, artistMbid: "shared-mbid" }),
    ]);
    repository.ensureCanonicalIndex("listener");
    const winningKey = repository.resolveArtistKey("listener", "Proper Name");

    expect(repository.listFeedback("listener")[0]?.artistKey).toBe(winningKey);
    expect(repository.listPreferenceSignals("listener")[0]?.targetKeys.artistKey).toBe(winningKey);
    expect(repository.listActiveExclusions("listener")[0]?.artistKey).toBe(winningKey);
    expect(repository.listRecommendations("listener")[0]?.artistKey).toBe(winningKey);

    repository.close();
    history.close();
  });
});

function recent(input: {
  artist: string;
  album: string;
  track: string;
  at: number;
  artistMbid?: string;
  albumMbid?: string;
  trackMbid?: string;
}) {
  return {
    name: input.track,
    artist: input.artist,
    album: input.album,
    mbid: input.trackMbid ?? null,
    artistMbid: input.artistMbid ?? null,
    albumMbid: input.albumMbid ?? null,
    url: "https://last.fm/track",
    loved: false,
    nowPlaying: false,
    playedAt: new Date(input.at * 1000).toISOString(),
    playedAtUnix: input.at,
  };
}
