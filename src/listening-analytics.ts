const SECONDS_PER_DAY = 86_400;
const DEFAULT_SESSION_GAP_MINUTES = 45;

export type AnalyticsScrobble = {
  /** Unix timestamp in seconds. */
  timestamp: number;
  artist: string;
  album?: string;
  track: string;
  loved?: boolean;
};

export type ListeningSession = {
  id: string;
  startedAt: number;
  endedAt: number;
  durationSeconds: number;
  playCount: number;
  scrobbles: AnalyticsScrobble[];
  artists: Array<{ artist: string; plays: number }>;
  albums: Array<{ artist: string; album: string; plays: number }>;
};

export type ArtistAffinityOptions = {
  sessionGapMinutes?: number;
  /** Optional evidence supplied by album analysis; it is reported but deliberately not scored. */
  albumCompletionRate?: number;
};

export type AffinityScoreComponent = {
  value: number;
  weight: number;
  contribution: number;
  explanation: string;
};

export type ArtistAffinityResult = {
  artist: string;
  totalPlays: number;
  activeDays: number;
  activeMonths: number;
  sessionCount: number;
  repeatSessions: number;
  returnAfter30Days: boolean;
  firstPlayedAt: number | null;
  lastPlayedAt: number | null;
  concentration: {
    largestDayShare: number;
    largestSessionShare: number;
    dayHerfindahlIndex: number;
    distributedDayScore: number;
  };
  albumCompletionEvidence: { rate: number; includedInScore: false } | null;
  affinityScore: number;
  scoreComponents: {
    playDepth: AffinityScoreComponent;
    activeDayBreadth: AffinityScoreComponent;
    activeMonthBreadth: AffinityScoreComponent;
    returningSessions: AffinityScoreComponent;
    longitudinalReturn: AffinityScoreComponent;
    distribution: AffinityScoreComponent;
  };
  methodology: string[];
};

export type AlbumExposureOptions = {
  sessionGapMinutes?: number;
  /** Ordered external tracklist. Comparisons are Unicode- and case-normalized. */
  orderedTracklist?: string[];
  nearFullThreshold?: number;
};

export type AlbumExposureRun = {
  startedAt: number;
  endedAt: number;
  tracks: string[];
  uniqueTracks: number;
  knownTracklistTracks: number | null;
  coverageRate: number | null;
  sequentiality: number | null;
  completion: "full" | "near_full" | "partial" | "unknown";
};

export type AlbumExposureResult = {
  artist: string;
  album: string;
  totalPlays: number;
  uniqueTracksHeard: number;
  sessionCount: number;
  runCount: number;
  tracklistSize: number | null;
  knownTracklistTracksHeard: number | null;
  coverageRate: number | null;
  fullRuns: number | null;
  nearFullRuns: number | null;
  sequentiality: {
    score: number | null;
    sequentialTransitions: number;
    evaluatedTransitions: number;
  } | null;
  stopTracks: Array<{ track: string; stops: number }>;
  returnedAfter7Days: boolean;
  returnedAfter30Days: boolean;
  firstPlayedAt: number | null;
  lastPlayedAt: number | null;
  runs: AlbumExposureRun[];
  methodology: string[];
};

export type TimelineBucketUnit = "day" | "week" | "month" | "year";
export type TimelineDimension = "artist" | "album";

export type TimelineOptions = {
  from?: number;
  to?: number;
  bucket: TimelineBucketUnit;
  dimension: TimelineDimension;
  limitPerBucket?: number;
};

export type ListeningTimelineItem = {
  key: string;
  artist: string;
  album: string | null;
  plays: number;
  share: number;
};

export type ListeningTimelineResult = {
  bucket: TimelineBucketUnit;
  dimension: TimelineDimension;
  from: number | null;
  to: number | null;
  scrobblesInRange: number;
  excludedMissingDimension: number;
  buckets: Array<{
    start: number;
    endExclusive: number;
    label: string;
    totalPlays: number;
    items: ListeningTimelineItem[];
    omittedPlays: number;
  }>;
  methodology: string;
};

export type ListeningMatrixOptions = {
  from?: number;
  to?: number;
  bucket: TimelineBucketUnit;
  dimension: TimelineDimension;
  minimumTimestamp?: number;
  minPlays?: number;
  entityOffset?: number;
  limitEntities?: number;
  includeEmptyBuckets?: boolean;
  maxCells?: number;
};

export type ListeningMatrixCell = [
  bucketIndex: number,
  entityIndex: number,
  plays: number,
  activeDays: number,
];

export type ListeningMatrixResult = {
  bucket: TimelineBucketUnit;
  dimension: TimelineDimension;
  from: number | null;
  to: number | null;
  scrobblesInRange: number;
  minimumTimestamp: number | null;
  excludedBeforeMinimumTimestamp: number;
  dimensionPlaysInRange: number;
  excludedMissingDimension: number;
  buckets: Array<{
    index: number;
    start: number;
    endExclusive: number;
    label: string;
    totalPlays: number;
    selectedPlays: number;
    omittedPlays: number;
    activeDays: number;
    entityCount: number;
  }>;
  entities: Array<{
    index: number;
    rank: number;
    key: string;
    artist: string;
    album: string | null;
    totalPlays: number;
    activeDays: number;
    activeBuckets: number;
    firstPlayedAt: number;
    lastPlayedAt: number;
    firstBucketIndex: number;
    lastBucketIndex: number;
    peakBucketIndex: number;
    peakBucketPlays: number;
    peakBucketShare: number;
    maxDayPlays: number;
    maxDayShare: number;
    activeSpanBuckets: number;
    bucketDensity: number;
    playsPerActiveDay: number;
  }>;
  matrix: {
    format: "sparse_coordinate";
    dimensions: { buckets: number; entities: number };
    cellColumns: ["bucketIndex", "entityIndex", "plays", "activeDays"];
    cells: ListeningMatrixCell[];
  };
  filtering: {
    minPlays: number;
    entityOffset: number;
    limitEntities: number | null;
    totalEntities: number;
    eligibleEntities: number;
    excludedByMinPlays: number;
    returnedEntities: number;
    omittedEntities: number;
    omittedBeforePage: number;
    omittedAfterPage: number;
    hasMoreEntities: boolean;
    nextEntityOffset: number | null;
    eligiblePlays: number;
    eligiblePlayCoverage: number;
    includedPlays: number;
    omittedPlays: number;
    playCoverage: number;
    complete: boolean;
  };
  methodology: string[];
};

export type EraDetectionOptions = {
  minDurationDays?: number;
  maxEras?: number;
  adjacentSimilarityThreshold?: number;
  minPlaysPerMonth?: number;
  dominantArtistLimit?: number;
};

export type EraArtistEvidence = {
  artist: string;
  plays: number;
  share: number;
};

export type ListeningEra = {
  id: string;
  start: number;
  endExclusive: number;
  durationDays: number;
  activeMonths: number;
  totalPlays: number;
  dominantArtists: EraArtistEvidence[];
  boundaryFromPrevious: {
    artistDistributionSimilarity: number;
    changeStrength: number;
    inactiveMonthsBetween: number;
  } | null;
};

export type ListeningEraDetectionResult = {
  eras: ListeningEra[];
  monthlyEvidence: Array<{
    month: string;
    start: number;
    endExclusive: number;
    plays: number;
    dominantArtists: EraArtistEvidence[];
    dominantArtistShare: number;
  }>;
  candidateBoundaries: Array<{
    previousMonth: string;
    nextMonth: string;
    artistDistributionSimilarity: number;
    changeStrength: number;
    inactiveMonthsBetween: number;
    splitCandidate: boolean;
    reason: string;
  }>;
  methodology: {
    distribution: string;
    similarity: string;
    initialSegmentation: string;
    merging: string;
    parameters: Required<EraDetectionOptions>;
  };
};

type CountedName = { display: string; count: number };
type MonthEvidenceInternal = ListeningEraDetectionResult["monthlyEvidence"][number] & {
  monthIndex: number;
  counts: Map<string, number>;
  distribution: Map<string, number>;
};
type EraSegment = { months: MonthEvidenceInternal[] };

export function groupListeningSessions(
  scrobbles: readonly AnalyticsScrobble[],
  gapMinutesOrOptions: number | { gapMinutes?: number } = DEFAULT_SESSION_GAP_MINUTES,
): ListeningSession[] {
  const gapMinutes = typeof gapMinutesOrOptions === "number"
    ? gapMinutesOrOptions
    : (gapMinutesOrOptions.gapMinutes ?? DEFAULT_SESSION_GAP_MINUTES);
  assertPositiveFinite(gapMinutes, "gapMinutes");
  const sorted = sortedScrobbles(scrobbles);
  if (sorted.length === 0) return [];

  const gapSeconds = gapMinutes * 60;
  const grouped: AnalyticsScrobble[][] = [];
  let current: AnalyticsScrobble[] = [];
  for (const scrobble of sorted) {
    const previous = current.at(-1);
    if (previous && scrobble.timestamp - previous.timestamp > gapSeconds) {
      grouped.push(current);
      current = [];
    }
    current.push(scrobble);
  }
  if (current.length > 0) grouped.push(current);

  return grouped.map((items, index) => {
    const first = items[0] as AnalyticsScrobble;
    const last = items.at(-1) as AnalyticsScrobble;
    const artistCounts = new Map<string, CountedName>();
    const albumCounts = new Map<string, CountedName & { artist: string }>();
    for (const item of items) {
      incrementNamed(artistCounts, normalize(item.artist), cleanDisplay(item.artist));
      if (hasText(item.album)) {
        const key = `${normalize(item.artist)}\u0000${normalize(item.album)}`;
        const existing = albumCounts.get(key);
        if (existing) existing.count += 1;
        else albumCounts.set(key, { artist: cleanDisplay(item.artist), display: cleanDisplay(item.album), count: 1 });
      }
    }
    return {
      id: `session-${index + 1}`,
      startedAt: first.timestamp,
      endedAt: last.timestamp,
      durationSeconds: last.timestamp - first.timestamp,
      playCount: items.length,
      scrobbles: items,
      artists: [...artistCounts.entries()]
        .map(([key, value]) => ({ key, artist: value.display, plays: value.count }))
        .sort((a, b) => countThenKey(a.plays, b.plays, a.key, b.key))
        .map(({ artist, plays }) => ({ artist, plays })),
      albums: [...albumCounts.entries()]
        .map(([key, value]) => ({ key, artist: value.artist, album: value.display, plays: value.count }))
        .sort((a, b) => countThenKey(a.plays, b.plays, a.key, b.key))
        .map(({ artist, album, plays }) => ({ artist, album, plays })),
    };
  });
}

export function calculateArtistAffinity(
  scrobbles: readonly AnalyticsScrobble[],
  artist: string,
  options: ArtistAffinityOptions = {},
): ArtistAffinityResult {
  const artistKey = normalizeRequired(artist, "artist");
  const matching = sortedScrobbles(scrobbles).filter((item) => normalize(item.artist) === artistKey);
  const totalPlays = matching.length;
  const days = countBy(matching, (item) => utcDay(item.timestamp));
  const months = countBy(matching, (item) => utcMonth(item.timestamp));
  const allSessions = groupListeningSessions(scrobbles, options.sessionGapMinutes ?? DEFAULT_SESSION_GAP_MINUTES);
  const artistSessionPlays = allSessions
    .map((session) => session.scrobbles.filter((item) => normalize(item.artist) === artistKey).length)
    .filter((plays) => plays > 0);
  const sessionCount = artistSessionPlays.length;
  const repeatSessions = artistSessionPlays.filter((plays) => plays >= 2).length;
  const firstPlayedAt = matching[0]?.timestamp ?? null;
  const lastPlayedAt = matching.at(-1)?.timestamp ?? null;
  const returnAfter30Days = firstPlayedAt !== null
    && lastPlayedAt !== null
    && lastPlayedAt - firstPlayedAt >= 30 * SECONDS_PER_DAY;

  const largestDayShare = totalPlays === 0 ? 0 : Math.max(...days.values()) / totalPlays;
  const largestSessionShare = totalPlays === 0 || artistSessionPlays.length === 0
    ? 0
    : Math.max(...artistSessionPlays) / totalPlays;
  const dayHerfindahlIndex = totalPlays === 0
    ? 0
    : [...days.values()].reduce((sum, plays) => sum + (plays / totalPlays) ** 2, 0);
  const distributedDayScore = days.size <= 1
    ? 0
    : clamp01((1 - dayHerfindahlIndex) / (1 - 1 / days.size));

  const values = {
    playDepth: totalPlays === 0 ? 0 : Math.log1p(Math.min(totalPlays, 50)) / Math.log1p(50),
    activeDayBreadth: clamp01(days.size / 12),
    activeMonthBreadth: clamp01(months.size / 6),
    returningSessions: clamp01(Math.max(0, sessionCount - 1) / 7),
    longitudinalReturn: returnAfter30Days ? 1 : 0,
    distribution: totalPlays === 0 ? 0 : clamp01((distributedDayScore + (1 - largestSessionShare)) / 2),
  };
  const weights = {
    playDepth: 0.15,
    activeDayBreadth: 0.2,
    activeMonthBreadth: 0.2,
    returningSessions: 0.2,
    longitudinalReturn: 0.15,
    distribution: 0.1,
  };
  const component = (value: number, weight: number, explanation: string): AffinityScoreComponent => ({
    value: round(value),
    weight,
    contribution: round(value * weight * 100),
    explanation,
  });
  const scoreComponents = {
    playDepth: component(values.playDepth, weights.playDepth, "Log-scaled play depth, capped at 50 plays."),
    activeDayBreadth: component(values.activeDayBreadth, weights.activeDayBreadth, "Distinct UTC listening days, saturated at 12."),
    activeMonthBreadth: component(values.activeMonthBreadth, weights.activeMonthBreadth, "Distinct UTC calendar months, saturated at 6."),
    returningSessions: component(values.returningSessions, weights.returningSessions, "Additional listening sessions after the first, saturated at 8 sessions total."),
    longitudinalReturn: component(values.longitudinalReturn, weights.longitudinalReturn, "Observed span from first to last play is at least 30 days."),
    distribution: component(values.distribution, weights.distribution, "Mean of normalized day dispersion and one minus the largest-session share."),
  };
  const affinityScore = round(Object.values(scoreComponents).reduce((sum, item) => sum + item.contribution, 0));
  const albumCompletionRate = options.albumCompletionRate;
  if (albumCompletionRate !== undefined && (!Number.isFinite(albumCompletionRate) || albumCompletionRate < 0 || albumCompletionRate > 1)) {
    throw new Error("albumCompletionRate must be between 0 and 1");
  }

  return {
    artist: matching[0] ? cleanDisplay(matching[0].artist) : cleanDisplay(artist),
    totalPlays,
    activeDays: days.size,
    activeMonths: months.size,
    sessionCount,
    repeatSessions,
    returnAfter30Days,
    firstPlayedAt,
    lastPlayedAt,
    concentration: {
      largestDayShare: round(largestDayShare),
      largestSessionShare: round(largestSessionShare),
      dayHerfindahlIndex: round(dayHerfindahlIndex),
      distributedDayScore: round(distributedDayScore),
    },
    albumCompletionEvidence: albumCompletionRate === undefined
      ? null
      : { rate: round(albumCompletionRate), includedInScore: false },
    affinityScore,
    scoreComponents,
    methodology: [
      "Artist names are NFKC-normalized, whitespace-collapsed, and case-folded for matching.",
      `Sessions use a gap greater than ${options.sessionGapMinutes ?? DEFAULT_SESSION_GAP_MINUTES} minutes as a boundary; repeatSessions contain at least two artist plays.`,
      "Affinity is a deterministic 0-100 behavioral score, not a probability or confidence estimate.",
      "Optional album completion is evidence only and is excluded from the score so results remain comparable when tracklists are unavailable.",
    ],
  };
}

export function analyzeAlbumExposure(
  scrobbles: readonly AnalyticsScrobble[],
  artist: string,
  album: string,
  options: AlbumExposureOptions = {},
): AlbumExposureResult {
  const artistKey = normalizeRequired(artist, "artist");
  const albumKey = normalizeRequired(album, "album");
  const gapMinutes = options.sessionGapMinutes ?? DEFAULT_SESSION_GAP_MINUTES;
  const nearFullThreshold = options.nearFullThreshold ?? 0.8;
  if (!Number.isFinite(nearFullThreshold) || nearFullThreshold <= 0 || nearFullThreshold >= 1) {
    throw new Error("nearFullThreshold must be greater than 0 and less than 1");
  }
  const tracklist = options.orderedTracklist?.map((track) => cleanDisplay(track)).filter(Boolean);
  if (tracklist && tracklist.length === 0) throw new Error("orderedTracklist must contain at least one non-empty track");
  const trackIndexes = tracklist
    ? new Map(tracklist.map((track, index) => [normalize(track), index] as const))
    : null;
  const isTarget = (item: AnalyticsScrobble) => normalize(item.artist) === artistKey && normalize(item.album ?? "") === albumKey;
  const sessions = groupListeningSessions(scrobbles, gapMinutes);
  const targetSessions = sessions.filter((session) => session.scrobbles.some(isTarget));
  const rawRuns: AnalyticsScrobble[][] = [];
  for (const session of targetSessions) {
    let run: AnalyticsScrobble[] = [];
    for (const item of session.scrobbles) {
      if (isTarget(item)) run.push(item);
      else if (run.length > 0) {
        rawRuns.push(run);
        run = [];
      }
    }
    if (run.length > 0) rawRuns.push(run);
  }

  let aggregateSequential = 0;
  let aggregateEvaluated = 0;
  const runs: AlbumExposureRun[] = rawRuns.map((run) => {
    const normalizedUnique = new Set(run.map((item) => normalize(item.track)));
    const knownUnique = trackIndexes
      ? new Set([...normalizedUnique].filter((track) => trackIndexes.has(track))).size
      : null;
    const coverageRate = knownUnique === null || !tracklist ? null : knownUnique / tracklist.length;
    let sequential = 0;
    let evaluated = 0;
    if (trackIndexes) {
      for (let index = 1; index < run.length; index += 1) {
        const previous = trackIndexes.get(normalize((run[index - 1] as AnalyticsScrobble).track));
        const current = trackIndexes.get(normalize((run[index] as AnalyticsScrobble).track));
        if (previous === undefined || current === undefined || previous === current) continue;
        evaluated += 1;
        if (current === previous + 1) sequential += 1;
      }
      aggregateSequential += sequential;
      aggregateEvaluated += evaluated;
    }
    const completion = coverageRate === null
      ? "unknown"
      : coverageRate >= 1
        ? "full"
        : coverageRate >= nearFullThreshold
          ? "near_full"
          : "partial";
    return {
      startedAt: (run[0] as AnalyticsScrobble).timestamp,
      endedAt: (run.at(-1) as AnalyticsScrobble).timestamp,
      tracks: run.map((item) => cleanDisplay(item.track)),
      uniqueTracks: normalizedUnique.size,
      knownTracklistTracks: knownUnique,
      coverageRate: coverageRate === null ? null : round(coverageRate),
      sequentiality: trackIndexes && evaluated > 0 ? round(sequential / evaluated) : null,
      completion,
    };
  });
  const matching = sortedScrobbles(scrobbles).filter(isTarget);
  const uniqueTracks = new Map<string, string>();
  for (const item of matching) if (!uniqueTracks.has(normalize(item.track))) uniqueTracks.set(normalize(item.track), cleanDisplay(item.track));
  const knownTracklistTracksHeard = trackIndexes
    ? [...uniqueTracks.keys()].filter((track) => trackIndexes.has(track)).length
    : null;
  const sessionStarts = targetSessions.map((session) =>
    (session.scrobbles.find(isTarget) as AnalyticsScrobble).timestamp);
  const firstSessionAt = sessionStarts[0] ?? null;
  const returnedAfter = (days: number) => firstSessionAt !== null
    && sessionStarts.slice(1).some((startedAt) => startedAt - firstSessionAt >= days * SECONDS_PER_DAY);
  const stopCounts = new Map<string, CountedName>();
  for (let index = 0; index < rawRuns.length; index += 1) {
    const run = rawRuns[index] as AnalyticsScrobble[];
    if (runs[index]?.completion === "full") continue;
    const last = run.at(-1);
    if (last) incrementNamed(stopCounts, normalize(last.track), cleanDisplay(last.track));
  }
  const fullRuns = tracklist ? runs.filter((run) => run.completion === "full").length : null;
  const nearFullRuns = tracklist ? runs.filter((run) => run.completion === "near_full").length : null;

  return {
    artist: matching[0] ? cleanDisplay(matching[0].artist) : cleanDisplay(artist),
    album: matching[0]?.album ? cleanDisplay(matching[0].album) : cleanDisplay(album),
    totalPlays: matching.length,
    uniqueTracksHeard: uniqueTracks.size,
    sessionCount: targetSessions.length,
    runCount: runs.length,
    tracklistSize: tracklist?.length ?? null,
    knownTracklistTracksHeard,
    coverageRate: tracklist && knownTracklistTracksHeard !== null
      ? round(knownTracklistTracksHeard / tracklist.length)
      : null,
    fullRuns,
    nearFullRuns,
    sequentiality: tracklist
      ? {
          score: aggregateEvaluated === 0 ? null : round(aggregateSequential / aggregateEvaluated),
          sequentialTransitions: aggregateSequential,
          evaluatedTransitions: aggregateEvaluated,
        }
      : null,
    stopTracks: [...stopCounts.entries()]
      .map(([key, value]) => ({ key, track: value.display, stops: value.count }))
      .sort((a, b) => countThenKey(a.stops, b.stops, a.key, b.key))
      .map(({ track, stops }) => ({ track, stops })),
    returnedAfter7Days: returnedAfter(7),
    returnedAfter30Days: returnedAfter(30),
    firstPlayedAt: matching[0]?.timestamp ?? null,
    lastPlayedAt: matching.at(-1)?.timestamp ?? null,
    runs,
    methodology: [
      `Album runs are contiguous target-album plays inside sessions separated by gaps greater than ${gapMinutes} minutes.`,
      tracklist
        ? `Full means all external-tracklist tracks appeared in a run; near-full means at least ${round(nearFullThreshold * 100)}% appeared. Coverage does not imply correct order.`
        : "No ordered external tracklist was supplied, so completion, coverage, and sequentiality are unknown rather than estimated.",
      "Sequentiality is the share of evaluable adjacent transitions that advance by exactly one tracklist position; repeats are not evaluated.",
      "Stop tracks are final tracks in non-full runs and are behavioral candidates, not proof that playback was deliberately abandoned.",
      "Seven- and thirty-day returns require a later album session that starts at least that long after the first album session.",
    ],
  };
}

export function buildListeningTimeline(
  scrobbles: readonly AnalyticsScrobble[],
  options: TimelineOptions,
): ListeningTimelineResult {
  assertOptionalTimestamp(options.from, "from");
  assertOptionalTimestamp(options.to, "to");
  if (options.from !== undefined && options.to !== undefined && options.from > options.to) {
    throw new Error("from must be less than or equal to to");
  }
  const limit = options.limitPerBucket;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error("limitPerBucket must be a positive integer");
  }
  const sorted = sortedScrobbles(scrobbles).filter((item) =>
    (options.from === undefined || item.timestamp >= options.from)
    && (options.to === undefined || item.timestamp <= options.to));
  type MutableBucket = { start: number; items: Map<string, CountedName & { artist: string; album: string | null }> };
  const bucketMap = new Map<number, MutableBucket>();
  let excludedMissingDimension = 0;
  for (const item of sorted) {
    if (options.dimension === "album" && !hasText(item.album)) {
      excludedMissingDimension += 1;
      continue;
    }
    const start = bucketStart(item.timestamp, options.bucket);
    let bucket = bucketMap.get(start);
    if (!bucket) {
      bucket = { start, items: new Map() };
      bucketMap.set(start, bucket);
    }
    const artist = cleanDisplay(item.artist);
    const album = options.dimension === "album" ? cleanDisplay(item.album as string) : null;
    const key = options.dimension === "artist"
      ? normalize(item.artist)
      : `${normalize(item.artist)}\u0000${normalize(item.album as string)}`;
    const existing = bucket.items.get(key);
    if (existing) existing.count += 1;
    else bucket.items.set(key, { display: options.dimension === "artist" ? artist : album as string, artist, album, count: 1 });
  }
  const buckets = [...bucketMap.values()].sort((a, b) => a.start - b.start).map((bucket) => {
    const allItems = [...bucket.items.entries()]
      .map(([key, value]) => ({
        key,
        artist: value.artist,
        album: value.album,
        plays: value.count,
      }))
      .sort((a, b) => countThenKey(a.plays, b.plays, a.key, b.key));
    const totalPlays = allItems.reduce((sum, item) => sum + item.plays, 0);
    const selected = limit === undefined ? allItems : allItems.slice(0, limit);
    return {
      start: bucket.start,
      endExclusive: nextBucketStart(bucket.start, options.bucket),
      label: bucketLabel(bucket.start, options.bucket),
      totalPlays,
      items: selected.map((item) => ({ ...item, share: round(item.plays / totalPlays) })),
      omittedPlays: totalPlays - selected.reduce((sum, item) => sum + item.plays, 0),
    };
  });
  return {
    bucket: options.bucket,
    dimension: options.dimension,
    from: options.from ?? sorted[0]?.timestamp ?? null,
    to: options.to ?? sorted.at(-1)?.timestamp ?? null,
    scrobblesInRange: sorted.length,
    excludedMissingDimension,
    buckets,
    methodology: `UTC calendar ${options.bucket} buckets; weeks begin Monday. Names are NFKC/case-normalized, and empty buckets are omitted.`,
  };
}

export function buildListeningMatrix(
  scrobbles: readonly AnalyticsScrobble[],
  options: ListeningMatrixOptions,
): ListeningMatrixResult {
  assertOptionalTimestamp(options.from, "from");
  assertOptionalTimestamp(options.to, "to");
  assertOptionalTimestamp(options.minimumTimestamp, "minimumTimestamp");
  if (options.from !== undefined && options.to !== undefined && options.from > options.to) {
    throw new Error("from must be less than or equal to to");
  }
  const minPlays = options.minPlays ?? 1;
  const entityOffset = options.entityOffset ?? 0;
  const includeEmptyBuckets = options.includeEmptyBuckets ?? true;
  const maxCells = options.maxCells ?? 100_000;
  if (!Number.isInteger(minPlays) || minPlays < 1) throw new Error("minPlays must be a positive integer");
  if (!Number.isInteger(entityOffset) || entityOffset < 0) throw new Error("entityOffset must be a non-negative integer");
  if (options.limitEntities !== undefined && (!Number.isInteger(options.limitEntities) || options.limitEntities < 1)) {
    throw new Error("limitEntities must be a positive integer");
  }
  if (!Number.isInteger(maxCells) || maxCells < 1) throw new Error("maxCells must be a positive integer");

  const inRequestedRange = sortedScrobbles(scrobbles).filter((item) =>
    (options.from === undefined || item.timestamp >= options.from)
    && (options.to === undefined || item.timestamp <= options.to));
  const sorted = options.minimumTimestamp === undefined
    ? inRequestedRange
    : inRequestedRange.filter((item) => item.timestamp >= options.minimumTimestamp!);
  const excludedBeforeMinimumTimestamp = inRequestedRange.length - sorted.length;
  type MutableCell = { plays: number; days: Set<string> };
  type MutableEntity = {
    key: string;
    artist: string;
    album: string | null;
    totalPlays: number;
    activeDays: Set<string>;
    dayCounts: Map<string, number>;
    firstPlayedAt: number;
    lastPlayedAt: number;
    cells: Map<number, MutableCell>;
  };
  const entitiesByKey = new Map<string, MutableEntity>();
  const bucketTotals = new Map<number, number>();
  const bucketDays = new Map<number, Set<string>>();
  let excludedMissingDimension = 0;

  for (const item of sorted) {
    if (options.dimension === "album" && !hasText(item.album)) {
      excludedMissingDimension += 1;
      continue;
    }
    const start = bucketStart(item.timestamp, options.bucket);
    const day = utcDay(item.timestamp);
    bucketTotals.set(start, (bucketTotals.get(start) ?? 0) + 1);
    let days = bucketDays.get(start);
    if (!days) {
      days = new Set();
      bucketDays.set(start, days);
    }
    days.add(day);

    const artist = cleanDisplay(item.artist);
    const album = options.dimension === "album" ? cleanDisplay(item.album as string) : null;
    const key = options.dimension === "artist"
      ? normalize(item.artist)
      : `${normalize(item.artist)}\u0000${normalize(item.album as string)}`;
    let entity = entitiesByKey.get(key);
    if (!entity) {
      entity = {
        key,
        artist,
        album,
        totalPlays: 0,
        activeDays: new Set(),
        dayCounts: new Map(),
        firstPlayedAt: item.timestamp,
        lastPlayedAt: item.timestamp,
        cells: new Map(),
      };
      entitiesByKey.set(key, entity);
    }
    entity.totalPlays += 1;
    entity.activeDays.add(day);
    entity.dayCounts.set(day, (entity.dayCounts.get(day) ?? 0) + 1);
    entity.firstPlayedAt = Math.min(entity.firstPlayedAt, item.timestamp);
    entity.lastPlayedAt = Math.max(entity.lastPlayedAt, item.timestamp);
    let cell = entity.cells.get(start);
    if (!cell) {
      cell = { plays: 0, days: new Set() };
      entity.cells.set(start, cell);
    }
    cell.plays += 1;
    cell.days.add(day);
  }

  const from = options.from ?? sorted[0]?.timestamp ?? null;
  const to = options.to ?? sorted.at(-1)?.timestamp ?? null;
  const allBucketStarts: number[] = [];
  if (from !== null && to !== null) {
    let start = bucketStart(from, options.bucket);
    const last = bucketStart(to, options.bucket);
    while (start <= last) {
      allBucketStarts.push(start);
      if (allBucketStarts.length > 10_000) {
        throw new Error("The requested matrix exceeds 10,000 time buckets. Use a coarser bucket or a narrower range.");
      }
      start = nextBucketStart(start, options.bucket);
    }
  }
  const returnedBucketStarts = includeEmptyBuckets
    ? allBucketStarts
    : allBucketStarts.filter((start) => (bucketTotals.get(start) ?? 0) > 0);
  const bucketIndexByStart = new Map(returnedBucketStarts.map((start, index) => [start, index]));
  const fullBucketIndexByStart = new Map(allBucketStarts.map((start, index) => [start, index]));

  const allEntities = [...entitiesByKey.values()]
    .sort((a, b) => countThenKey(a.totalPlays, b.totalPlays, a.key, b.key));
  const eligibleEntities = allEntities.filter((entity) => entity.totalPlays >= minPlays);
  const pageEnd = options.limitEntities === undefined ? undefined : entityOffset + options.limitEntities;
  const selectedEntities = eligibleEntities.slice(entityOffset, pageEnd);
  const selectedPlaysByBucket = new Map<number, number>();
  const entityCountByBucket = new Map<number, number>();
  const cells: ListeningMatrixCell[] = [];

  for (const [entityIndex, entity] of selectedEntities.entries()) {
    for (const [start, cell] of entity.cells) {
      const bucketIndex = bucketIndexByStart.get(start);
      if (bucketIndex === undefined) continue;
      cells.push([bucketIndex, entityIndex, cell.plays, cell.days.size]);
      selectedPlaysByBucket.set(start, (selectedPlaysByBucket.get(start) ?? 0) + cell.plays);
      entityCountByBucket.set(start, (entityCountByBucket.get(start) ?? 0) + 1);
    }
  }
  cells.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (cells.length > maxCells) {
    throw new Error(`The matrix contains ${cells.length} non-zero cells, above maxCells=${maxCells}. Narrow the range, raise minPlays, set limitEntities, or increase maxCells.`);
  }

  const entities = selectedEntities.map((entity, index) => {
    const cellEntries = [...entity.cells.entries()].sort(([a], [b]) => a - b);
    const firstBucketStart = cellEntries[0]?.[0] as number;
    const lastBucketStart = cellEntries.at(-1)?.[0] as number;
    const peakBucket = cellEntries.reduce((best, current) =>
      current[1].plays > best[1].plays ? current : best);
    const maxDayPlays = Math.max(...entity.dayCounts.values());
    const firstBucketIndex = bucketIndexByStart.get(firstBucketStart);
    const lastBucketIndex = bucketIndexByStart.get(lastBucketStart);
    const peakBucketIndex = bucketIndexByStart.get(peakBucket[0]);
    const fullFirstIndex = fullBucketIndexByStart.get(firstBucketStart) ?? 0;
    const fullLastIndex = fullBucketIndexByStart.get(lastBucketStart) ?? fullFirstIndex;
    const activeSpanBuckets = fullLastIndex - fullFirstIndex + 1;
    if (firstBucketIndex === undefined || lastBucketIndex === undefined || peakBucketIndex === undefined) {
      throw new Error("Internal matrix bucket indexing error");
    }
    return {
      index,
      rank: entityOffset + index + 1,
      key: entity.key,
      artist: entity.artist,
      album: entity.album,
      totalPlays: entity.totalPlays,
      activeDays: entity.activeDays.size,
      activeBuckets: entity.cells.size,
      firstPlayedAt: entity.firstPlayedAt,
      lastPlayedAt: entity.lastPlayedAt,
      firstBucketIndex,
      lastBucketIndex,
      peakBucketIndex,
      peakBucketPlays: peakBucket[1].plays,
      peakBucketShare: round(peakBucket[1].plays / entity.totalPlays),
      maxDayPlays,
      maxDayShare: round(maxDayPlays / entity.totalPlays),
      activeSpanBuckets,
      bucketDensity: round(entity.cells.size / activeSpanBuckets),
      playsPerActiveDay: round(entity.totalPlays / entity.activeDays.size),
    };
  });

  const buckets = returnedBucketStarts.map((start, index) => {
    const totalPlays = bucketTotals.get(start) ?? 0;
    const selectedPlays = selectedPlaysByBucket.get(start) ?? 0;
    return {
      index,
      start,
      endExclusive: nextBucketStart(start, options.bucket),
      label: bucketLabel(start, options.bucket),
      totalPlays,
      selectedPlays,
      omittedPlays: totalPlays - selectedPlays,
      activeDays: bucketDays.get(start)?.size ?? 0,
      entityCount: entityCountByBucket.get(start) ?? 0,
    };
  });
  const dimensionPlaysInRange = sorted.length - excludedMissingDimension;
  const eligiblePlays = eligibleEntities.reduce((sum, entity) => sum + entity.totalPlays, 0);
  const includedPlays = selectedEntities.reduce((sum, entity) => sum + entity.totalPlays, 0);
  const omittedPlays = dimensionPlaysInRange - includedPlays;
  const nextEntityOffset = entityOffset + selectedEntities.length < eligibleEntities.length
    ? entityOffset + selectedEntities.length
    : null;

  return {
    bucket: options.bucket,
    dimension: options.dimension,
    from,
    to,
    scrobblesInRange: inRequestedRange.length,
    minimumTimestamp: options.minimumTimestamp ?? null,
    excludedBeforeMinimumTimestamp,
    dimensionPlaysInRange,
    excludedMissingDimension,
    buckets,
    entities,
    matrix: {
      format: "sparse_coordinate",
      dimensions: { buckets: buckets.length, entities: entities.length },
      cellColumns: ["bucketIndex", "entityIndex", "plays", "activeDays"],
      cells,
    },
    filtering: {
      minPlays,
      entityOffset,
      limitEntities: options.limitEntities ?? null,
      totalEntities: allEntities.length,
      eligibleEntities: eligibleEntities.length,
      excludedByMinPlays: allEntities.length - eligibleEntities.length,
      returnedEntities: entities.length,
      omittedEntities: allEntities.length - entities.length,
      omittedBeforePage: Math.min(entityOffset, eligibleEntities.length),
      omittedAfterPage: Math.max(eligibleEntities.length - entityOffset - entities.length, 0),
      hasMoreEntities: nextEntityOffset !== null,
      nextEntityOffset,
      eligiblePlays,
      eligiblePlayCoverage: dimensionPlaysInRange === 0 ? 1 : round(eligiblePlays / dimensionPlaysInRange),
      includedPlays,
      omittedPlays,
      playCoverage: dimensionPlaysInRange === 0 ? 1 : round(includedPlays / dimensionPlaysInRange),
      complete: omittedPlays === 0,
    },
    methodology: [
      `UTC calendar ${options.bucket} buckets; weeks begin Monday. Boundary buckets may cover only part of the requested range.`,
      options.minimumTimestamp === undefined
        ? "No lower plausibility bound was applied to scrobble timestamps."
        : `Scrobbles before ${new Date(options.minimumTimestamp * 1_000).toISOString()} are counted in excludedBeforeMinimumTimestamp but omitted from temporal evidence.`,
      "Entities are selected by total plays across the entire requested range, never independently per bucket. This keeps matrix columns statistically consistent over time.",
      "The matrix uses sparse coordinate rows [bucketIndex, entityIndex, plays, activeDays]. A missing cell means zero plays.",
      "Entity active-day, peak-day, span, and density fields distinguish concentrated bursts from gradual or recurring adoption.",
      "Filtering and playCoverage explicitly report evidence omitted by minPlays or the current entity page. Continue with nextEntityOffset until null to reconstruct all eligible columns; maxCells fails instead of silently truncating.",
    ],
  };
}

export function detectListeningEras(
  scrobbles: readonly AnalyticsScrobble[],
  options: EraDetectionOptions = {},
): ListeningEraDetectionResult {
  const parameters: Required<EraDetectionOptions> = {
    minDurationDays: options.minDurationDays ?? 60,
    maxEras: options.maxEras ?? 12,
    adjacentSimilarityThreshold: options.adjacentSimilarityThreshold ?? 0.35,
    minPlaysPerMonth: options.minPlaysPerMonth ?? 10,
    dominantArtistLimit: options.dominantArtistLimit ?? 10,
  };
  assertPositiveFinite(parameters.minDurationDays, "minDurationDays");
  if (!Number.isInteger(parameters.maxEras) || parameters.maxEras < 1) throw new Error("maxEras must be a positive integer");
  if (!Number.isFinite(parameters.adjacentSimilarityThreshold)
    || parameters.adjacentSimilarityThreshold < 0
    || parameters.adjacentSimilarityThreshold > 1) {
    throw new Error("adjacentSimilarityThreshold must be between 0 and 1");
  }
  if (!Number.isInteger(parameters.minPlaysPerMonth) || parameters.minPlaysPerMonth < 1) {
    throw new Error("minPlaysPerMonth must be a positive integer");
  }
  if (!Number.isInteger(parameters.dominantArtistLimit) || parameters.dominantArtistLimit < 1) {
    throw new Error("dominantArtistLimit must be a positive integer");
  }

  const artistDisplays = new Map<string, string>();
  const monthCounts = new Map<number, Map<string, number>>();
  for (const item of sortedScrobbles(scrobbles)) {
    const key = normalize(item.artist);
    if (!artistDisplays.has(key)) artistDisplays.set(key, cleanDisplay(item.artist));
    const start = bucketStart(item.timestamp, "month");
    let counts = monthCounts.get(start);
    if (!counts) {
      counts = new Map();
      monthCounts.set(start, counts);
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const months: MonthEvidenceInternal[] = [...monthCounts.entries()].sort(([a], [b]) => a - b).map(([start, counts]) => {
    const plays = [...counts.values()].reduce((sum, value) => sum + value, 0);
    const dominant = [...counts.entries()]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => countThenKey(a.count, b.count, a.key, b.key))
      .slice(0, parameters.dominantArtistLimit);
    const dominantTotal = dominant.reduce((sum, item) => sum + item.count, 0);
    const distribution = new Map(dominant.map((item) => [item.key, item.count / dominantTotal]));
    return {
      month: utcMonth(start),
      start,
      endExclusive: nextBucketStart(start, "month"),
      plays,
      dominantArtists: dominant.map((item) => ({
        artist: artistDisplays.get(item.key) ?? item.key,
        plays: item.count,
        share: round(item.count / plays),
      })),
      dominantArtistShare: round(dominantTotal / plays),
      monthIndex: calendarMonthIndex(start),
      counts,
      distribution,
    };
  });
  if (months.length === 0) return emptyEraResult(parameters);

  const candidateBoundaries: ListeningEraDetectionResult["candidateBoundaries"] = [];
  const segments: EraSegment[] = [{ months: [months[0] as MonthEvidenceInternal] }];
  for (let index = 1; index < months.length; index += 1) {
    const previous = months[index - 1] as MonthEvidenceInternal;
    const current = months[index] as MonthEvidenceInternal;
    const inactiveMonthsBetween = Math.max(0, current.monthIndex - previous.monthIndex - 1);
    const similarity = distributionOverlap(previous.distribution, current.distribution);
    const enoughEvidence = previous.plays >= parameters.minPlaysPerMonth && current.plays >= parameters.minPlaysPerMonth;
    const splitCandidate = inactiveMonthsBetween > 0
      || (enoughEvidence && similarity < parameters.adjacentSimilarityThreshold);
    const reason = inactiveMonthsBetween > 0
      ? `${inactiveMonthsBetween} inactive calendar month(s) separate the active buckets.`
      : !enoughEvidence
        ? `Not split: at least one bucket has fewer than ${parameters.minPlaysPerMonth} plays.`
        : splitCandidate
          ? `Dominant-artist overlap ${round(similarity)} is below ${parameters.adjacentSimilarityThreshold}.`
          : `Dominant-artist overlap ${round(similarity)} is at or above ${parameters.adjacentSimilarityThreshold}.`;
    candidateBoundaries.push({
      previousMonth: previous.month,
      nextMonth: current.month,
      artistDistributionSimilarity: round(similarity),
      changeStrength: round(1 - similarity),
      inactiveMonthsBetween,
      splitCandidate,
      reason,
    });
    if (splitCandidate) segments.push({ months: [current] });
    else (segments.at(-1) as EraSegment).months.push(current);
  }

  mergeShortSegments(segments, parameters.minDurationDays);
  mergeSimilarAdjacent(segments, parameters.adjacentSimilarityThreshold);
  while (segments.length > parameters.maxEras) mergeMostSimilarAdjacent(segments);

  const eras: ListeningEra[] = segments.map((segment, index) => {
    const counts = aggregateSegmentCounts(segment);
    const totalPlays = [...counts.values()].reduce((sum, value) => sum + value, 0);
    const start = (segment.months[0] as MonthEvidenceInternal).start;
    const endExclusive = (segment.months.at(-1) as MonthEvidenceInternal).endExclusive;
    const previous = index === 0 ? null : segments[index - 1] as EraSegment;
    const boundarySimilarity = previous === null
      ? null
      : distributionOverlap(normalizedCounts(aggregateSegmentCounts(previous)), normalizedCounts(counts));
    const inactiveMonthsBetween = previous === null
      ? 0
      : Math.max(
          0,
          (segment.months[0] as MonthEvidenceInternal).monthIndex
            - (previous.months.at(-1) as MonthEvidenceInternal).monthIndex
            - 1,
        );
    return {
      id: `era-${index + 1}`,
      start,
      endExclusive,
      durationDays: round((endExclusive - start) / SECONDS_PER_DAY),
      activeMonths: segment.months.length,
      totalPlays,
      dominantArtists: [...counts.entries()]
        .map(([key, plays]) => ({ key, plays }))
        .sort((a, b) => countThenKey(a.plays, b.plays, a.key, b.key))
        .slice(0, parameters.dominantArtistLimit)
        .map((item) => ({ artist: artistDisplays.get(item.key) ?? item.key, plays: item.plays, share: round(item.plays / totalPlays) })),
      boundaryFromPrevious: boundarySimilarity === null
        ? null
        : {
            artistDistributionSimilarity: round(boundarySimilarity),
            changeStrength: round(1 - boundarySimilarity),
            inactiveMonthsBetween,
          },
    };
  });

  return {
    eras,
    monthlyEvidence: months.map(({ monthIndex: _monthIndex, counts: _counts, distribution: _distribution, ...month }) => month),
    candidateBoundaries,
    methodology: methodology(parameters),
  };
}

function mergeShortSegments(segments: EraSegment[], minDurationDays: number): void {
  while (segments.length > 1) {
    const candidates = segments
      .map((segment, index) => ({ index, duration: segmentDurationDays(segment) }))
      .filter((item) => item.duration < minDurationDays && hasCalendarAdjacentNeighbor(segments, item.index))
      .sort((a, b) => a.duration - b.duration || a.index - b.index);
    const candidate = candidates[0];
    if (!candidate) return;
    const index = candidate.index;
    const canMergeLeft = index > 0 && inactiveMonthsBetweenSegments(
      segments[index - 1] as EraSegment,
      segments[index] as EraSegment,
    ) === 0;
    const canMergeRight = index < segments.length - 1 && inactiveMonthsBetweenSegments(
      segments[index] as EraSegment,
      segments[index + 1] as EraSegment,
    ) === 0;
    if (!canMergeLeft) mergeSegmentsAt(segments, index);
    else if (!canMergeRight) mergeSegmentsAt(segments, index - 1);
    else {
      const currentDistribution = normalizedCounts(aggregateSegmentCounts(segments[index] as EraSegment));
      const leftSimilarity = distributionOverlap(
        normalizedCounts(aggregateSegmentCounts(segments[index - 1] as EraSegment)),
        currentDistribution,
      );
      const rightSimilarity = distributionOverlap(
        currentDistribution,
        normalizedCounts(aggregateSegmentCounts(segments[index + 1] as EraSegment)),
      );
      mergeSegmentsAt(segments, rightSimilarity > leftSimilarity ? index : index - 1);
    }
  }
}

function mergeMostSimilarAdjacent(segments: EraSegment[]): void {
  let bestIndex = 0;
  let bestSimilarity = -1;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const similarity = distributionOverlap(
      normalizedCounts(aggregateSegmentCounts(segments[index] as EraSegment)),
      normalizedCounts(aggregateSegmentCounts(segments[index + 1] as EraSegment)),
    );
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      bestIndex = index;
    }
  }
  mergeSegmentsAt(segments, bestIndex);
}

function mergeSimilarAdjacent(segments: EraSegment[], threshold: number): void {
  while (segments.length > 1) {
    let bestIndex = -1;
    let bestSimilarity = threshold;
    for (let index = 0; index < segments.length - 1; index += 1) {
      if (inactiveMonthsBetweenSegments(
        segments[index] as EraSegment,
        segments[index + 1] as EraSegment,
      ) > 0) continue;
      const similarity = distributionOverlap(
        normalizedCounts(aggregateSegmentCounts(segments[index] as EraSegment)),
        normalizedCounts(aggregateSegmentCounts(segments[index + 1] as EraSegment)),
      );
      if (similarity >= bestSimilarity) {
        if (similarity > bestSimilarity || bestIndex === -1) bestIndex = index;
        bestSimilarity = similarity;
      }
    }
    if (bestIndex === -1) return;
    mergeSegmentsAt(segments, bestIndex);
  }
}

function hasCalendarAdjacentNeighbor(segments: EraSegment[], index: number): boolean {
  return (index > 0 && inactiveMonthsBetweenSegments(
    segments[index - 1] as EraSegment,
    segments[index] as EraSegment,
  ) === 0) || (index < segments.length - 1 && inactiveMonthsBetweenSegments(
    segments[index] as EraSegment,
    segments[index + 1] as EraSegment,
  ) === 0);
}

function inactiveMonthsBetweenSegments(left: EraSegment, right: EraSegment): number {
  return Math.max(
    0,
    (right.months[0] as MonthEvidenceInternal).monthIndex
      - (left.months.at(-1) as MonthEvidenceInternal).monthIndex
      - 1,
  );
}

function mergeSegmentsAt(segments: EraSegment[], leftIndex: number): void {
  const left = segments[leftIndex] as EraSegment;
  const right = segments[leftIndex + 1] as EraSegment;
  segments.splice(leftIndex, 2, { months: [...left.months, ...right.months] });
}

function aggregateSegmentCounts(segment: EraSegment): Map<string, number> {
  const result = new Map<string, number>();
  for (const month of segment.months) {
    for (const [artist, plays] of month.counts) {
      result.set(artist, (result.get(artist) ?? 0) + plays);
    }
  }
  return result;
}

function normalizedCounts(counts: Map<string, number>): Map<string, number> {
  const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
  return new Map([...counts].map(([key, value]) => [key, total === 0 ? 0 : value / total]));
}

/** Histogram intersection: 1 means identical distributions, 0 means no shared artists. */
function distributionOverlap(left: Map<string, number>, right: Map<string, number>): number {
  const keys = new Set([...left.keys(), ...right.keys()]);
  let overlap = 0;
  for (const key of keys) overlap += Math.min(left.get(key) ?? 0, right.get(key) ?? 0);
  return clamp01(overlap);
}

function segmentDurationDays(segment: EraSegment): number {
  const first = segment.months[0] as MonthEvidenceInternal;
  const last = segment.months.at(-1) as MonthEvidenceInternal;
  return (last.endExclusive - first.start) / SECONDS_PER_DAY;
}

function emptyEraResult(parameters: Required<EraDetectionOptions>): ListeningEraDetectionResult {
  return { eras: [], monthlyEvidence: [], candidateBoundaries: [], methodology: methodology(parameters) };
}

function methodology(parameters: Required<EraDetectionOptions>): ListeningEraDetectionResult["methodology"] {
  return {
    distribution: `Each active UTC month is represented by its top ${parameters.dominantArtistLimit} artists, renormalized for comparison; raw shares and retained share are returned as evidence.`,
    similarity: "Adjacent similarity is histogram intersection (sum of minimum artist shares): 1 is identical and 0 has no dominant artists in common.",
    initialSegmentation: `A boundary candidate is created after inactive months, or when both months have at least ${parameters.minPlaysPerMonth} plays and similarity is below ${parameters.adjacentSimilarityThreshold}.`,
    merging: `Segments shorter than ${parameters.minDurationDays} days are merged into the more similar calendar-adjacent neighbor, then calendar-adjacent aggregate distributions overlapping by at least ${parameters.adjacentSimilarityThreshold} are coalesced. Inactive-month gaps are preserved unless maxEras forces a merge. If more than ${parameters.maxEras} remain, the most similar adjacent segments are merged first. These are deterministic change points, not confidence claims.`,
    parameters,
  };
}

function sortedScrobbles(scrobbles: readonly AnalyticsScrobble[]): AnalyticsScrobble[] {
  return scrobbles.map((item, index) => {
    assertTimestamp(item.timestamp, `scrobbles[${index}].timestamp`);
    if (!hasText(item.artist)) throw new Error(`scrobbles[${index}].artist must not be empty`);
    if (!hasText(item.track)) throw new Error(`scrobbles[${index}].track must not be empty`);
    return { item, index };
  }).sort((left, right) => left.item.timestamp - right.item.timestamp || left.index - right.index)
    .map(({ item }) => item);
}

function countBy(items: readonly AnalyticsScrobble[], key: (item: AnalyticsScrobble) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const value = key(item);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function incrementNamed(map: Map<string, CountedName>, key: string, display: string): void {
  const existing = map.get(key);
  if (existing) existing.count += 1;
  else map.set(key, { display, count: 1 });
}

function normalize(value: string): string {
  return cleanDisplay(value).toLocaleLowerCase("en-US");
}

function cleanDisplay(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}

function normalizeRequired(value: string, field: string): string {
  if (!hasText(value)) throw new Error(`${field} must not be empty`);
  return normalize(value);
}

function hasText(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

function utcDay(timestamp: number): string {
  return new Date(timestamp * 1_000).toISOString().slice(0, 10);
}

function utcMonth(timestamp: number): string {
  return new Date(timestamp * 1_000).toISOString().slice(0, 7);
}

function bucketStart(timestamp: number, bucket: TimelineBucketUnit): number {
  const date = new Date(timestamp * 1_000);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  if (bucket === "year") return Date.UTC(year, 0, 1) / 1_000;
  if (bucket === "month") return Date.UTC(year, month, 1) / 1_000;
  const dayStart = Date.UTC(year, month, day) / 1_000;
  if (bucket === "day") return dayStart;
  const dayOfWeek = date.getUTCDay();
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  return dayStart - daysSinceMonday * SECONDS_PER_DAY;
}

function nextBucketStart(start: number, bucket: TimelineBucketUnit): number {
  if (bucket === "day") return start + SECONDS_PER_DAY;
  if (bucket === "week") return start + 7 * SECONDS_PER_DAY;
  const date = new Date(start * 1_000);
  return bucket === "month"
    ? Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) / 1_000
    : Date.UTC(date.getUTCFullYear() + 1, 0, 1) / 1_000;
}

function bucketLabel(start: number, bucket: TimelineBucketUnit): string {
  const iso = new Date(start * 1_000).toISOString();
  if (bucket === "year") return iso.slice(0, 4);
  if (bucket === "month") return iso.slice(0, 7);
  return iso.slice(0, 10);
}

function calendarMonthIndex(timestamp: number): number {
  const date = new Date(timestamp * 1_000);
  return date.getUTCFullYear() * 12 + date.getUTCMonth();
}

function countThenKey(leftCount: number, rightCount: number, leftKey: string, rightKey: string): number {
  return rightCount - leftCount || (leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0);
}

function assertTimestamp(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${field} must be a non-negative Unix timestamp in seconds`);
}

function assertOptionalTimestamp(value: number | undefined, field: string): void {
  if (value !== undefined) assertTimestamp(value, field);
}

function assertPositiveFinite(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${field} must be greater than 0`);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
