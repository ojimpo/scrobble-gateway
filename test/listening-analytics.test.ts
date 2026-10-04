import { describe, expect, it } from "vitest";
import {
  analyzeAlbumExposure,
  buildListeningMatrix,
  buildListeningTimeline,
  calculateArtistAffinity,
  detectListeningEras,
  groupListeningSessions,
  type AnalyticsScrobble,
} from "../src/listening-analytics.js";

const at = (iso: string) => Date.parse(iso) / 1_000;

const play = (
  iso: string,
  artist: string,
  track: string,
  album?: string,
): AnalyticsScrobble => ({
  timestamp: at(iso),
  artist,
  track,
  ...(album === undefined ? {} : { album }),
});

describe("groupListeningSessions", () => {
  it("sorts input and starts a new session only when the configured gap is exceeded", () => {
    const scrobbles = [
      play("2026-01-01T01:31:00Z", "Other", "D"),
      play("2026-01-01T00:30:00Z", "  TesseracT ", "B", "War of Being"),
      play("2026-01-01T00:00:00Z", "Tesseract", "A", "War of Being"),
      play("2026-01-01T01:00:00Z", "Tesseract", "C", "War of Being"),
    ];

    const sessions = groupListeningSessions(scrobbles, 30);

    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.scrobbles.map((item) => item.track)).toEqual(["A", "B", "C"]);
    expect(sessions[0]?.artists).toEqual([{ artist: "Tesseract", plays: 3 }]);
    expect(sessions[1]?.startedAt).toBe(at("2026-01-01T01:31:00Z"));
  });

  it("rejects invalid timestamps and gaps", () => {
    expect(() => groupListeningSessions([], 0)).toThrow(/gapMinutes/);
    expect(() => groupListeningSessions([{ timestamp: Number.NaN, artist: "A", track: "T" }])).toThrow(/timestamp/);
  });
});

describe("calculateArtistAffinity", () => {
  it("scores distributed returns above a same-size one-evening burst and exposes every component", () => {
    const burst = Array.from({ length: 8 }, (_, index) =>
      play(`2026-01-01T00:${String(index).padStart(2, "0")}:00Z`, "Loathe", `Burst ${index}`));
    const distributed = Array.from({ length: 8 }, (_, index) =>
      play(`2026-${String(index + 1).padStart(2, "0")}-01T00:00:00Z`, "Loathe", `Return ${index}`));

    const burstAffinity = calculateArtistAffinity(burst, "loathe");
    const distributedAffinity = calculateArtistAffinity(distributed, "LOATHE", { albumCompletionRate: 0.75 });

    expect(burstAffinity.totalPlays).toBe(8);
    expect(burstAffinity.repeatSessions).toBe(1);
    expect(burstAffinity.returnAfter30Days).toBe(false);
    expect(distributedAffinity.activeMonths).toBe(8);
    expect(distributedAffinity.sessionCount).toBe(8);
    expect(distributedAffinity.returnAfter30Days).toBe(true);
    expect(distributedAffinity.affinityScore).toBeGreaterThan(burstAffinity.affinityScore);
    expect(distributedAffinity.albumCompletionEvidence).toEqual({ rate: 0.75, includedInScore: false });
    expect(Object.values(distributedAffinity.scoreComponents).reduce((sum, part) => sum + part.contribution, 0))
      .toBe(distributedAffinity.affinityScore);
  });

  it("returns zero evidence rather than a fabricated affinity for an unheard artist", () => {
    const result = calculateArtistAffinity([], "Unheard");

    expect(result).toMatchObject({ totalPlays: 0, activeDays: 0, affinityScore: 0 });
    expect(result.firstPlayedAt).toBeNull();
  });
});

describe("analyzeAlbumExposure", () => {
  const tracklist = ["One", "Two", "Three", "Four"];
  const history = [
    play("2026-01-01T00:00:00Z", "Artist", "One", "Album"),
    play("2026-01-01T00:04:00Z", "Artist", "Two", "Album"),
    play("2026-01-01T00:08:00Z", "Artist", "Three", "Album"),
    play("2026-01-01T00:12:00Z", "Artist", "Four", "Album"),
    play("2026-01-09T00:00:00Z", "Artist", "One", "Album"),
    play("2026-01-09T00:04:00Z", "Artist", "Two", "Album"),
    play("2026-01-09T00:05:00Z", "Other", "Interruption"),
    play("2026-02-02T00:00:00Z", "Artist", "One", "Album"),
    play("2026-02-02T00:04:00Z", "Artist", "Two", "Album"),
    play("2026-02-02T00:08:00Z", "Artist", "Three", "Album"),
  ];

  it("measures coverage, order, stop candidates, and delayed returns using an ordered tracklist", () => {
    const exposure = analyzeAlbumExposure(history, "artist", "album", {
      orderedTracklist: tracklist,
      nearFullThreshold: 0.75,
    });

    expect(exposure).toMatchObject({
      totalPlays: 9,
      uniqueTracksHeard: 4,
      sessionCount: 3,
      runCount: 3,
      coverageRate: 1,
      fullRuns: 1,
      nearFullRuns: 1,
      returnedAfter7Days: true,
      returnedAfter30Days: true,
    });
    expect(exposure.sequentiality).toEqual({ score: 1, sequentialTransitions: 6, evaluatedTransitions: 6 });
    expect(exposure.stopTracks).toEqual([
      { track: "Three", stops: 1 },
      { track: "Two", stops: 1 },
    ]);
    expect(exposure.runs.map((run) => run.completion)).toEqual(["full", "partial", "near_full"]);
  });

  it("does not claim completion or sequentiality without an external tracklist", () => {
    const exposure = analyzeAlbumExposure(history, "Artist", "Album");

    expect(exposure.tracklistSize).toBeNull();
    expect(exposure.fullRuns).toBeNull();
    expect(exposure.coverageRate).toBeNull();
    expect(exposure.sequentiality).toBeNull();
    expect(exposure.runs.every((run) => run.completion === "unknown")).toBe(true);
  });

  it("reports insufficient transition evidence as null rather than zero sequentiality", () => {
    const exposure = analyzeAlbumExposure([history[0] as AnalyticsScrobble], "Artist", "Album", {
      orderedTracklist: tracklist,
    });

    expect(exposure.sequentiality).toEqual({
      score: null,
      sequentialTransitions: 0,
      evaluatedTransitions: 0,
    });
    expect(exposure.runs[0]?.sequentiality).toBeNull();
  });
});

describe("buildListeningTimeline", () => {
  it("uses UTC ISO weeks, normalizes dimensions, applies ranges, and reports missing albums", () => {
    const history = [
      play("2025-12-31T23:00:00Z", "Ignored", "Old", "Old Album"),
      play("2026-01-04T23:59:00Z", "Artist", "One", "Album"),
      play("2026-01-05T00:01:00Z", "ARTIST", "Two", " album "),
      play("2026-01-05T00:02:00Z", "Artist", "Loose track"),
      play("2026-01-05T00:03:00Z", "Other", "Three", "Album"),
    ];

    const timeline = buildListeningTimeline(history, {
      from: at("2026-01-01T00:00:00Z"),
      bucket: "week",
      dimension: "album",
      limitPerBucket: 1,
    });

    expect(timeline.scrobblesInRange).toBe(4);
    expect(timeline.excludedMissingDimension).toBe(1);
    expect(timeline.buckets.map((bucket) => bucket.label)).toEqual(["2025-12-29", "2026-01-05"]);
    expect(timeline.buckets[1]).toMatchObject({ totalPlays: 2, omittedPlays: 1 });
    expect(timeline.buckets[1]?.items[0]).toMatchObject({ artist: "ARTIST", album: "album", plays: 1, share: 0.5 });
  });
});

describe("buildListeningMatrix", () => {
  it("builds stable global columns, preserves empty buckets, and exposes burst evidence and filtering coverage", () => {
    const history = [
      play("2026-01-20T18:00:00Z", "Alpha", "A1"),
      play("2026-01-20T18:03:00Z", "ALPHA", "A2"),
      play("2026-02-10T12:00:00Z", "Alpha", "A3"),
      play("2026-02-14T20:00:00Z", "Burst", "B1"),
      play("2026-02-14T20:04:00Z", "Burst", "B2"),
      play("2026-04-01T00:00:00Z", "Long Tail", "C1"),
    ];

    const result = buildListeningMatrix(history, {
      from: at("2026-01-15T00:00:00Z"),
      to: at("2026-04-15T23:59:59Z"),
      bucket: "month",
      dimension: "artist",
      limitEntities: 2,
    });

    expect(result.buckets.map((bucket) => bucket.label)).toEqual(["2026-01", "2026-02", "2026-03", "2026-04"]);
    expect(result.entities.map((entity) => [entity.artist, entity.totalPlays])).toEqual([
      ["Alpha", 3],
      ["Burst", 2],
    ]);
    expect(result.entities.map((entity) => entity.rank)).toEqual([1, 2]);
    expect(result.matrix).toMatchObject({
      format: "sparse_coordinate",
      dimensions: { buckets: 4, entities: 2 },
      cellColumns: ["bucketIndex", "entityIndex", "plays", "activeDays"],
      cells: [
        [0, 0, 2, 1],
        [1, 0, 1, 1],
        [1, 1, 2, 1],
      ],
    });
    expect(result.entities[0]).toMatchObject({
      activeDays: 2,
      activeBuckets: 2,
      peakBucketIndex: 0,
      peakBucketShare: 0.6667,
      maxDayPlays: 2,
      maxDayShare: 0.6667,
      activeSpanBuckets: 2,
      bucketDensity: 1,
    });
    expect(result.buckets[2]).toMatchObject({ totalPlays: 0, selectedPlays: 0, omittedPlays: 0 });
    expect(result.buckets[3]).toMatchObject({ totalPlays: 1, selectedPlays: 0, omittedPlays: 1 });
    expect(result.filtering).toMatchObject({
      totalEntities: 3,
      eligibleEntities: 3,
      excludedByMinPlays: 0,
      returnedEntities: 2,
      omittedEntities: 1,
      omittedBeforePage: 0,
      omittedAfterPage: 1,
      hasMoreEntities: true,
      nextEntityOffset: 2,
      eligiblePlays: 6,
      eligiblePlayCoverage: 1,
      includedPlays: 5,
      omittedPlays: 1,
      playCoverage: 0.8333,
      complete: false,
    });
  });

  it("continues stable globally ranked entity columns from an explicit page offset", () => {
    const result = buildListeningMatrix([
      play("2026-01-01T00:00:00Z", "Alpha", "One"),
      play("2026-01-01T00:01:00Z", "Alpha", "Two"),
      play("2026-01-01T00:02:00Z", "Beta", "One"),
      play("2026-01-01T00:03:00Z", "Gamma", "One"),
    ], {
      bucket: "month",
      dimension: "artist",
      entityOffset: 1,
      limitEntities: 1,
    });

    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]).toMatchObject({ artist: "Beta", index: 0, rank: 2 });
    expect(result.matrix.cells).toEqual([[0, 0, 1, 1]]);
    expect(result.filtering).toMatchObject({
      entityOffset: 1,
      omittedBeforePage: 1,
      omittedAfterPage: 1,
      hasMoreEntities: true,
      nextEntityOffset: 2,
    });
  });

  it("reports but does not place implausibly early placeholder timestamps on the temporal axis", () => {
    const result = buildListeningMatrix([
      { timestamp: 1, artist: "Undated", track: "Imported" },
      play("2026-01-01T00:00:00Z", "Dated", "Scrobble"),
    ], {
      bucket: "month",
      dimension: "artist",
      minimumTimestamp: at("2002-01-01T00:00:00Z"),
    });

    expect(result).toMatchObject({
      scrobblesInRange: 2,
      minimumTimestamp: at("2002-01-01T00:00:00Z"),
      excludedBeforeMinimumTimestamp: 1,
      dimensionPlaysInRange: 1,
    });
    expect(result.buckets.map((bucket) => bucket.label)).toEqual(["2026-01"]);
    expect(result.entities.map((entity) => entity.artist)).toEqual(["Dated"]);
  });

  it("fails instead of silently truncating an oversized sparse matrix", () => {
    expect(() => buildListeningMatrix([
      play("2026-01-01T00:00:00Z", "A", "One"),
      play("2026-01-01T00:01:00Z", "B", "Two"),
    ], {
      bucket: "month",
      dimension: "artist",
      maxCells: 1,
    })).toThrow(/above maxCells=1/);
  });
});

describe("detectListeningEras", () => {
  const monthPlays = (month: number, artist: string): AnalyticsScrobble[] =>
    Array.from({ length: 20 }, (_, index) => play(
      `2026-${String(month).padStart(2, "0")}-${String((index % 20) + 1).padStart(2, "0")}T00:00:00Z`,
      artist,
      `${artist} ${index}`,
    ));
  const history = [
    ...monthPlays(1, "Ambient Era"),
    ...monthPlays(2, "Ambient Era"),
    ...monthPlays(3, "Ambient Era"),
    ...monthPlays(4, "Metal Era"),
    ...monthPlays(5, "Metal Era"),
    ...monthPlays(6, "Metal Era"),
  ];

  it("finds a supported change point from adjacent monthly artist distributions", () => {
    const detection = detectListeningEras(history, { minDurationDays: 60, maxEras: 4 });

    expect(detection.eras).toHaveLength(2);
    expect(detection.eras[0]?.dominantArtists[0]).toMatchObject({ artist: "Ambient Era", plays: 60, share: 1 });
    expect(detection.eras[1]?.dominantArtists[0]).toMatchObject({ artist: "Metal Era", plays: 60, share: 1 });
    expect(detection.eras[1]?.boundaryFromPrevious).toMatchObject({
      artistDistributionSimilarity: 0,
      changeStrength: 1,
      inactiveMonthsBetween: 0,
    });
    expect(detection.candidateBoundaries.find((item) => item.previousMonth === "2026-03")).toMatchObject({
      nextMonth: "2026-04",
      splitCandidate: true,
      artistDistributionSimilarity: 0,
    });
  });

  it("deterministically merges the least-separated adjacent eras to honor maxEras", () => {
    const detection = detectListeningEras(history, { minDurationDays: 1, maxEras: 1 });

    expect(detection.eras).toHaveLength(1);
    expect(detection.eras[0]).toMatchObject({ activeMonths: 6, totalPlays: 120 });
    expect(detection.eras[0]?.dominantArtists.map((artist) => artist.share)).toEqual([0.5, 0.5]);
  });

  it("absorbs a short novelty month and re-coalesces matching surrounding distributions", () => {
    const withShortInterlude = [
      ...monthPlays(1, "Long-running taste"),
      ...monthPlays(2, "Long-running taste"),
      ...monthPlays(3, "Long-running taste"),
      ...monthPlays(4, "Short novelty"),
      ...monthPlays(5, "Long-running taste"),
      ...monthPlays(6, "Long-running taste"),
      ...monthPlays(7, "Long-running taste"),
    ];

    const detection = detectListeningEras(withShortInterlude, { minDurationDays: 60 });

    expect(detection.eras).toHaveLength(1);
    expect(detection.eras[0]?.dominantArtists[0]).toMatchObject({ artist: "Long-running taste", plays: 120 });
  });

  it("preserves a long listening hiatus even when the artist distribution later matches", () => {
    const separatedHistory = [
      ...monthPlays(1, "Returned favorite"),
      ...monthPlays(12, "Returned favorite"),
    ];

    const detection = detectListeningEras(separatedHistory, { minDurationDays: 60 });

    expect(detection.eras).toHaveLength(2);
    expect(detection.eras[1]?.boundaryFromPrevious?.inactiveMonthsBetween).toBe(10);
    expect(detection.candidateBoundaries[0]).toMatchObject({ inactiveMonthsBetween: 10, splitCandidate: true });
  });

  it("returns methodology but no invented eras for empty history", () => {
    const detection = detectListeningEras([]);

    expect(detection.eras).toEqual([]);
    expect(detection.methodology.similarity).toMatch(/histogram intersection/);
  });
});
