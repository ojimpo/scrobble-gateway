import { canonicalKey, canonicalizeAlbum, canonicalizeArtist } from "./canonicalization.js";
import type { LastFmApi } from "./domain.js";
import type { HistoryRepository } from "./history-repository.js";
import {
  IntelligenceRepository,
  type CanonicalTarget,
  type FeedbackVerdict,
  type PreferenceDimensions,
} from "./intelligence-repository.js";
import {
  analyzeAlbumExposure,
  buildListeningMatrix,
  buildListeningTimeline,
  calculateArtistAffinity,
  detectListeningEras,
  groupListeningSessions,
  type AnalyticsScrobble,
  type TimelineBucketUnit,
} from "./listening-analytics.js";
import type { MusicBrainzClient } from "./musicbrainz-client.js";
import { assertDateRange, toIso } from "./time.js";

export const EXPOSURE_LEVELS = ["unheard", "sampled", "explored", "established", "favorite"] as const;
export type ExposureLevel = (typeof EXPOSURE_LEVELS)[number];
export const RECOMMENDATION_MODES = ["safe", "bridge", "explore"] as const;
export type RecommendationMode = (typeof RECOMMENDATION_MODES)[number];
const MIN_PLAUSIBLE_LASTFM_TIMESTAMP = Date.UTC(2002, 0, 1) / 1_000;

export class IntelligenceService {
  constructor(
    private readonly api: LastFmApi,
    private readonly musicbrainz: MusicBrainzClient,
    private readonly repository: IntelligenceRepository,
    private readonly history: HistoryRepository,
    private readonly username: string,
    private readonly mutationsEnabled = true,
  ) {}

  canonicalize(input: CanonicalTarget) {
    if ((input.album || input.track) && !input.artist) throw new Error("artist is required when resolving an album or track");
    return {
      username: this.username,
      entities: this.repository.getCanonicalEntities(this.username, input),
      methodology: "Deterministic NFKC/case/punctuation normalization with conservative featured-artist and album-edition handling; MBIDs are retained when present in synced history.",
    };
  }

  checkListeningExposure(input: {
    artists?: string[];
    albums?: Array<{ artist: string; album: string }>;
    tracks?: Array<{ artist: string; track: string }>;
  }) {
    const artists = input.artists ?? [];
    const albums = input.albums ?? [];
    const tracks = input.tracks ?? [];
    if (artists.length + albums.length + tracks.length === 0) throw new Error("Provide at least one artist, album, or track.");
    const artistResults = artists.map((artist) => ({
      type: "artist" as const,
      artist,
      ...withExposure(this.repository.getArtistExposure(this.username, artist)),
    }));
    const albumResults = albums.map(({ artist, album }) => ({
      type: "album" as const,
      artist,
      album,
      ...withExposure(this.repository.getAlbumExposureStats(this.username, artist, album)),
    }));
    const trackResults = tracks.map(({ artist, track }) => ({
      type: "track" as const,
      artist,
      track,
      ...withExposure(this.repository.getTrackExposure(this.username, artist, track)),
    }));
    return {
      username: this.username,
      artists: artistResults,
      albums: albumResults,
      tracks: trackResults,
      history: this.historyEvidence(),
      methodology: exposureMethodology,
    };
  }

  async getArtistAffinity(artist: string) {
    const allScrobbles = this.requireScrobbles();
    const canonicalArtist = this.repository.getCanonicalEntities(this.username, { artist }).artist?.canonicalName ?? artist;
    const requestedArtistKey = this.repository.resolveArtistKey(this.username, artist);
    const scrobbles = allScrobbles.filter((item) => item.artistKey === requestedArtistKey);
    const albumCounts = countBy(scrobbles.filter((item) => item.album), (item) => canonicalKey(item.album ?? ""));
    const albumEvidence = [];
    for (const counted of [...albumCounts.values()].sort((a, b) => b.count - a.count).slice(0, 3)) {
      const album = counted.sample.album;
      if (!album) continue;
      const indexed = this.repository.getScrobbles(this.username, { artist, album, limit: 1 })[0];
      const tracklist = await this.musicbrainz.getAlbumTracklist(canonicalArtist, album, indexed?.albumMbid).catch(() => null);
      if (!tracklist) continue;
      const analysis = analyzeAlbumExposure(allScrobbles, canonicalArtist, album, {
        orderedTracklist: tracklist.media.flatMap((medium) => medium.tracks.map((track) => track.title)),
      });
      albumEvidence.push({
        album,
        releaseGroupMbid: tracklist.releaseGroup.mbid,
        runCount: analysis.runCount,
        completedRuns: (analysis.fullRuns ?? 0) + (analysis.nearFullRuns ?? 0),
      });
    }
    const totalRuns = albumEvidence.reduce((sum, item) => sum + item.runCount, 0);
    const completedRuns = albumEvidence.reduce((sum, item) => sum + item.completedRuns, 0);
    const albumCompletionRate = totalRuns > 0 ? completedRuns / totalRuns : undefined;
    const result = calculateArtistAffinity(allScrobbles, canonicalArtist, albumCompletionRate === undefined ? {} : { albumCompletionRate });
    const feedback = this.mutationsEnabled
      ? this.repository.listFeedback(this.username, 1_000)
        .filter((item) => item.artist && (item.artistKey ?? canonicalizeArtist(item.artist).key) === requestedArtistKey)
      : [];
    const positive = feedback.filter((item) => ["love", "like"].includes(item.verdict)).length;
    const negative = feedback.filter((item) => ["boring", "dislike"].includes(item.verdict)).length;
    return {
      ...result,
      firstPlayedAt: toIso(result.firstPlayedAt),
      lastPlayedAt: toIso(result.lastPlayedAt),
      exposure: classifyExposure({
        totalPlays: result.totalPlays,
        activeDays: result.activeDays,
        activeMonths: result.activeMonths,
        tracksPlayed: new Set(scrobbles.map((item) => canonicalKey(item.track))).size,
        lovedPlays: scrobbles.filter((item) => item.loved).length,
      }),
      albumCompletionRate: albumCompletionRate === undefined ? null : round(albumCompletionRate),
      albumCompletionSources: albumEvidence,
      explicitFeedback: {
        available: this.mutationsEnabled,
        positive,
        negative,
        mixed: feedback.filter((item) => item.verdict === "mixed").length,
        notNow: feedback.filter((item) => item.verdict === "not_now").length,
        netSignal: positive - negative,
      },
      skipLikeSignals: null,
      signalCaveat: "Last.fm does not expose skip events here. Explicit feedback is reported separately and is not silently inferred from play count.",
      history: this.historyEvidence(),
    };
  }

  getListeningSessions(input: { from?: number; to?: number; artist?: string; gapMinutes: number; limit: number }) {
    assertDateRange(input.from, input.to);
    const scrobbles = this.requireScrobbles({
      ...(input.from === undefined ? {} : { from: input.from }),
      ...(input.to === undefined ? {} : { to: input.to }),
    });
    const requestedArtistKey = input.artist ? this.repository.resolveArtistKey(this.username, input.artist) : null;
    const allSessions = groupListeningSessions(scrobbles, input.gapMinutes)
      .filter((session) => requestedArtistKey === null || session.scrobbles.some((item) => "artistKey" in item && item.artistKey === requestedArtistKey));
    const sessions = allSessions.slice(-input.limit).reverse().map((session) => ({
      ...session,
      startedAt: toIso(session.startedAt),
      endedAt: toIso(session.endedAt),
      scrobbles: session.scrobbles.map((item) => ({ ...item, playedAt: toIso(item.timestamp) })),
    }));
    return {
      username: this.username,
      gapMinutes: input.gapMinutes,
      totalSessions: allSessions.length,
      returned: sessions.length,
      sessions,
      history: this.historyEvidence(),
      methodology: `A new session starts after a gap greater than ${input.gapMinutes} minutes.`,
    };
  }

  async getAlbumExposure(artist: string, album: string) {
    const scrobbles = this.requireScrobbles();
    const canonical = this.repository.getCanonicalEntities(this.username, { artist, album });
    const canonicalArtist = canonical.artist?.canonicalName ?? artist;
    const canonicalAlbum = canonical.album?.canonicalName ?? album;
    const albumMbid = this.repository.getScrobbles(this.username, { artist, album, limit: 1 })[0]?.albumMbid;
    let tracklist: Awaited<ReturnType<MusicBrainzClient["getAlbumTracklist"]>> = null;
    let metadataError: string | null = null;
    try {
      tracklist = await this.musicbrainz.getAlbumTracklist(canonicalArtist, canonicalAlbum, albumMbid);
    } catch (error) {
      metadataError = errorMessage(error);
    }
    const orderedTracklist = tracklist?.media.flatMap((medium) => medium.tracks.map((track) => track.title));
    const result = analyzeAlbumExposure(scrobbles, canonicalArtist, canonicalAlbum, orderedTracklist ? { orderedTracklist } : {});
    return {
      ...result,
      firstPlayedAt: toIso(result.firstPlayedAt),
      lastPlayedAt: toIso(result.lastPlayedAt),
      runs: result.runs.map((run) => ({ ...run, startedAt: toIso(run.startedAt), endedAt: toIso(run.endedAt) })),
      tracklistSource: tracklist ? {
        source: "MusicBrainz",
        releaseGroupMbid: tracklist.releaseGroup.mbid,
        releaseMbid: tracklist.release.mbid,
        releaseTitle: tracklist.release.title,
        totalTracks: tracklist.totalTracks,
      } : null,
      metadataError,
      caveat: tracklist
        ? null
        : "MusicBrainz did not provide a usable ordered tracklist. Run counts and returns are still measured, but completion is reported as unknown/approximate.",
      history: this.historyEvidence(),
    };
  }

  async getListeningTimeline(input: {
    from?: number;
    to?: number;
    bucket: TimelineBucketUnit;
    dimension: "artist" | "album" | "tag";
    limitPerBucket: number;
  }) {
    assertDateRange(input.from, input.to);
    const scrobbles = this.requireScrobbles({
      ...(input.from === undefined ? {} : { from: input.from }),
      ...(input.to === undefined ? {} : { to: input.to }),
    });
    const common = {
      ...(input.from === undefined ? {} : { from: input.from }),
      ...(input.to === undefined ? {} : { to: input.to }),
      bucket: input.bucket,
      limitPerBucket: input.limitPerBucket,
    };
    if (input.dimension !== "tag") {
      return {
        ...buildListeningTimeline(scrobbles, { ...common, dimension: input.dimension }),
        history: this.historyEvidence(),
      };
    }
    return { ...(await this.buildTagTimeline(scrobbles, common)), history: this.historyEvidence() };
  }

  getListeningMatrix(input: {
    from?: number;
    to?: number;
    bucket: TimelineBucketUnit;
    dimension: "artist" | "album";
    minPlays: number;
    entityOffset: number;
    limitEntities?: number;
    includeEmptyBuckets: boolean;
    maxCells: number;
  }) {
    assertDateRange(input.from, input.to);
    const scrobbles = this.requireScrobbles({
      ...(input.from === undefined ? {} : { from: input.from }),
      ...(input.to === undefined ? {} : { to: input.to }),
    });
    const result = buildListeningMatrix(scrobbles, {
      ...(input.from === undefined ? {} : { from: input.from }),
      ...(input.to === undefined ? {} : { to: input.to }),
      bucket: input.bucket,
      dimension: input.dimension,
      minimumTimestamp: MIN_PLAUSIBLE_LASTFM_TIMESTAMP,
      minPlays: input.minPlays,
      entityOffset: input.entityOffset,
      ...(input.limitEntities === undefined ? {} : { limitEntities: input.limitEntities }),
      includeEmptyBuckets: input.includeEmptyBuckets,
      maxCells: input.maxCells,
    });
    return {
      ...result,
      from: toIso(result.from),
      to: toIso(result.to),
      minimumTimestamp: toIso(result.minimumTimestamp),
      buckets: result.buckets.map((bucket) => ({
        ...bucket,
        start: toIso(bucket.start),
        endExclusive: toIso(bucket.endExclusive),
      })),
      entities: result.entities.map((entity) => ({
        ...entity,
        firstPlayedAt: toIso(entity.firstPlayedAt),
        lastPlayedAt: toIso(entity.lastPlayedAt),
      })),
      history: this.historyEvidence(),
    };
  }

  detectListeningEras(input: { minDurationDays: number; maxEras: number }) {
    const scrobbles = this.requireScrobbles();
    const datedScrobbles = scrobbles.filter((item) => item.timestamp >= MIN_PLAUSIBLE_LASTFM_TIMESTAMP);
    const result = detectListeningEras(datedScrobbles, input);
    return {
      ...result,
      minimumTimestamp: toIso(MIN_PLAUSIBLE_LASTFM_TIMESTAMP),
      excludedBeforeMinimumTimestamp: scrobbles.length - datedScrobbles.length,
      eras: result.eras.map((era) => ({ ...era, start: toIso(era.start), endExclusive: toIso(era.endExclusive) })),
      monthlyEvidence: result.monthlyEvidence.map((month) => ({ ...month, start: toIso(month.start), endExclusive: toIso(month.endExclusive) })),
      history: this.historyEvidence(),
    };
  }

  async getArtistFeatures(artist: string) {
    const local = this.repository.getCanonicalEntities(this.username, { artist }).artist;
    const [lastfm, musicbrainz] = await Promise.all([
      this.api.getArtistContext(artist, true).catch(() => null),
      this.musicbrainz.getArtistFeatures(artist, local?.mbid).catch(() => null),
    ]);
    const tags: Record<string, number> = {};
    for (const [index, tag] of (lastfm?.tags ?? []).entries()) tags[tag] = Math.max(tags[tag] ?? 0, Math.max(1, 100 - index * 5));
    for (const tag of musicbrainz?.tags ?? []) tags[tag.name] = Math.max(tags[tag.name] ?? 0, tag.count);
    for (const genre of musicbrainz?.genres ?? []) tags[genre.name] = Math.max(tags[genre.name] ?? 0, genre.count);
    const members = (musicbrainz?.relations ?? [])
      .filter((relation) => relation.targetType === "artist" && /member|founder/i.test(relation.type))
      .map((relation) => relation.target.name)
      .filter((name): name is string => Boolean(name));
    const begin = yearOf(musicbrainz?.artist.lifeSpan.begin);
    const end = yearOf(musicbrainz?.artist.lifeSpan.end);
    return {
      artist: musicbrainz?.artist.name ?? lastfm?.name ?? artist,
      mbid: musicbrainz?.artist.mbid ?? lastfm?.mbid ?? local?.mbid ?? null,
      tags,
      genres: (musicbrainz?.genres ?? []).map((genre) => genre.name),
      similarArtists: (lastfm?.similarArtists ?? []).map((similar) => ({
        id: `artist:${canonicalizeArtist(similar.name).key}`,
        name: similar.name,
        weight: similar.match,
        source: "lastfm",
      })),
      activeYears: begin === null ? null : [begin, end] as [number, number | null],
      country: musicbrainz?.artist.country ?? musicbrainz?.artist.area?.name ?? null,
      members: [...new Set(members)],
      relationships: musicbrainz?.relations ?? [],
      sources: {
        lastfm: lastfm ? lastfm.url : null,
        musicbrainz: musicbrainz ? `https://musicbrainz.org/artist/${musicbrainz.artist.mbid}` : null,
      },
      caveat: "Tags and relationships are editorial metadata, not measured audio features. No Spotify audio analysis or scraped recommendation source is used.",
    };
  }

  async buildTasteGraph() {
    const scrobbles = this.requireScrobbles();
    const topArtists = this.repository.getTopArtists(this.username, 40);
    const topKeys = new Set(topArtists.map((artist) => artist.artistKey));
    const nodes = new Map<string, Record<string, unknown>>();
    const edges = new Map<string, Record<string, unknown>>();
    for (const artist of topArtists) nodes.set(`artist:${artist.artistKey}`, { id: `artist:${artist.artistKey}`, type: "artist", ...artist });
    const discoveryOrder = [...topArtists].filter((artist) => artist.firstPlayedAt).sort((a, b) => Date.parse(a.firstPlayedAt ?? "") - Date.parse(b.firstPlayedAt ?? ""));
    for (let index = 1; index < discoveryOrder.length; index += 1) {
      const previous = discoveryOrder[index - 1];
      const current = discoveryOrder[index];
      if (previous && current) {
        addEdge(edges, `artist:${previous.artistKey}`, `artist:${current.artistKey}`, "discovered_after", 1, "local_history");
      }
    }

    const albumCounts = countBy(scrobbles.filter((item) => item.album), (item) => `${canonicalizeArtist(item.artist).key}\0${canonicalKey(item.album ?? "")}`);
    for (const item of [...albumCounts.values()].sort((a, b) => b.count - a.count).slice(0, 40)) {
      const sample = item.sample;
      const id = `album:${canonicalizeArtist(sample.artist).key}:${canonicalKey(sample.album ?? "")}`;
      nodes.set(id, { id, type: "album", artist: sample.artist, album: sample.album, plays: item.count });
      addEdge(edges, `artist:${canonicalizeArtist(sample.artist).key}`, id, "contains_listening", item.count, "local_history");
    }

    for (const session of groupListeningSessions(scrobbles)) {
      const artists = session.artists.map((item) => canonicalizeArtist(item.artist).key).filter((key) => topKeys.has(key));
      for (let left = 0; left < artists.length; left += 1) {
        for (let right = left + 1; right < artists.length; right += 1) {
          const a = artists[left];
          const b = artists[right];
          if (a && b && a !== b) addEdge(edges, `artist:${a}`, `artist:${b}`, "co_session", 1, "local_history");
        }
      }
    }

    const externalContexts = await Promise.all(topArtists.slice(0, 15).map(async (artist) => ({
      seed: artist,
      context: await this.api.getArtistContext(artist.artist, true).catch(() => null),
    })));
    for (const { seed, context } of externalContexts) {
      if (!context) continue;
      for (const tag of context.tags.slice(0, 8)) {
        const id = `tag:${canonicalKey(tag)}`;
        nodes.set(id, { id, type: "tag", name: tag });
        addEdge(edges, `artist:${seed.artistKey}`, id, "tagged", 1, "lastfm");
      }
      for (const similar of context.similarArtists.slice(0, 10)) {
        const key = canonicalizeArtist(similar.name).key;
        const id = `artist:${key}`;
        if (!nodes.has(id)) nodes.set(id, { id, type: "artist", artist: similar.name, externalCandidate: true });
        addEdge(edges, `artist:${seed.artistKey}`, id, "similar", similar.match ?? 0, "lastfm");
      }
    }

    const musicbrainzContexts = await Promise.all(topArtists.slice(0, 5).map(async (artist) => {
      const canonical = this.repository.getCanonicalEntities(this.username, { artist: artist.artist }).artist;
      return {
        seed: artist,
        features: await this.musicbrainz.getArtistFeatures(artist.artist, canonical?.mbid).catch(() => null),
      };
    }));
    for (const { seed, features } of musicbrainzContexts) {
      for (const genre of features?.genres.slice(0, 8) ?? []) {
        const id = `tag:${canonicalKey(genre.name)}`;
        nodes.set(id, { id, type: "tag", name: genre.name, source: "musicbrainz_genre" });
        addEdge(edges, `artist:${seed.artistKey}`, id, "genre", Math.max(genre.count, 1), "musicbrainz");
      }
      for (const relation of features?.relations ?? []) {
        if (relation.targetType !== "artist" || !relation.target.name) continue;
        const key = canonicalizeArtist(relation.target.name).key;
        const id = `artist:${key}`;
        if (!nodes.has(id)) nodes.set(id, { id, type: "artist", artist: relation.target.name, externalCandidate: true });
        addEdge(edges, `artist:${seed.artistKey}`, id, `musicbrainz_${relation.type}`, 1, "musicbrainz");
      }
    }

    const eras = detectListeningEras(scrobbles, { maxEras: 12, minDurationDays: 60 });
    for (const era of eras.eras) {
      const eraId = `era:${era.id}`;
      nodes.set(eraId, { id: eraId, type: "era", start: toIso(era.start), endExclusive: toIso(era.endExclusive), plays: era.totalPlays });
      for (const artist of era.dominantArtists) {
        addEdge(edges, `artist:${canonicalizeArtist(artist.artist).key}`, eraId, "dominant_in_era", artist.share, "local_history");
      }
    }

    for (const signal of this.mutationsEnabled ? this.repository.listPreferenceSignals(this.username) : []) {
      const target = signal.target.artist ? `artist:${signal.targetKeys.artistKey ?? canonicalizeArtist(signal.target.artist).key}` : null;
      if (!target) continue;
      for (const [dimension, value] of Object.entries(signal.dimensions)) {
        const id = `preference:${dimension}`;
        nodes.set(id, { id, type: "preference_dimension", name: dimension });
        addEdge(edges, target, id, "preference_signal", value, "explicit_feedback");
      }
    }

    return {
      generatedAt: new Date().toISOString(),
      username: this.username,
      graph: { nodes: [...nodes.values()], edges: [...edges.values()] },
      summary: { nodes: nodes.size, edges: edges.size, eras: eras.eras.length, coreArtists: topArtists.length },
      sources: [
        "local Last.fm scrobble history",
        "Last.fm tags and similar artists",
        "MusicBrainz genres and relationships",
        ...(this.mutationsEnabled ? ["explicit local preference signals"] : []),
      ],
      caveat: "The graph is evidence for retrieval and explanation, not a trained embedding model. External similarity currently uses authorized Last.fm and MusicBrainz metadata only.",
      history: this.historyEvidence(),
    };
  }

  recordMusicFeedback(input: CanonicalTarget & { rating?: number; verdict: FeedbackVerdict; notes?: string }) {
    this.assertMutationsEnabled();
    if (!input.artist && !input.album && !input.track) throw new Error("Feedback must target at least one artist, album, or track.");
    if ((input.album || input.track) && !input.artist) throw new Error("artist is required for album or track feedback.");
    return this.repository.recordFeedback(this.username, input);
  }

  recordPreferenceSignal(input: { target: CanonicalTarget; dimensions: PreferenceDimensions; notes?: string }) {
    this.assertMutationsEnabled();
    if (!input.target.artist && !input.target.album && !input.target.track) throw new Error("Preference signal must have a target.");
    if ((input.target.album || input.target.track) && !input.target.artist) throw new Error("artist is required for album or track preference signals.");
    if (Object.keys(input.dimensions).length === 0) throw new Error("Provide at least one taste dimension.");
    return this.repository.recordPreferenceSignal(this.username, input);
  }

  getFeedbackContext(limit: number) {
    this.assertPrivateAccess();
    const feedback = this.repository.listFeedback(this.username, limit);
    const preferenceSignals = this.repository.listPreferenceSignals(this.username, limit);
    const dimensionValues = new Map<string, number[]>();
    for (const signal of preferenceSignals) {
      for (const [dimension, value] of Object.entries(signal.dimensions)) {
        const values = dimensionValues.get(dimension) ?? [];
        values.push(value);
        dimensionValues.set(dimension, values);
      }
    }
    return {
      feedback,
      preferenceSignals,
      dimensionSummary: Object.fromEntries([...dimensionValues].map(([name, values]) => [name, {
        observations: values.length,
        average: round(values.reduce((sum, value) => sum + value, 0) / values.length),
      }])),
      exclusions: this.repository.listActiveExclusions(this.username),
    };
  }

  excludeRecommendation(input: { artist: string; reason: string; policy: string; expiresAt?: number | null }) {
    this.assertMutationsEnabled();
    const expiresAt = input.policy === "six_months" && (input.expiresAt === undefined || input.expiresAt === null)
      ? Math.floor(Date.now() / 1000) + 180 * 86_400
      : input.expiresAt;
    return this.repository.excludeRecommendation(this.username, { ...input, ...(expiresAt === undefined ? {} : { expiresAt }) });
  }

  listRecommendationExclusions() {
    this.assertPrivateAccess();
    return { username: this.username, exclusions: this.repository.listActiveExclusions(this.username) };
  }

  recordRecommendation(input: {
    artist: string;
    recommendedAt?: number;
    reason: string;
    recommendationId?: string;
    mode?: string;
  }) {
    this.assertMutationsEnabled();
    return this.repository.recordRecommendation(this.username, input);
  }

  async getRecommendations(input: {
    count: number;
    mode: RecommendationMode;
    excludeExposureAbove: ExposureLevel;
    targetEra?: "current";
    explain: boolean;
  }) {
    this.assertMutationsEnabled();
    const now = Math.floor(Date.now() / 1000);
    const completeScrobbles = this.requireScrobbles();
    const currentEra = input.targetEra === "current"
      ? detectListeningEras(completeScrobbles, { minDurationDays: 60, maxEras: 12 }).eras.at(-1)
      : undefined;
    const allScrobbles = currentEra
      ? completeScrobbles.filter((scrobble) => scrobble.timestamp >= currentEra.start)
      : completeScrobbles;
    const seedCounts = countBy(allScrobbles, (item) => item.artistKey);
    const seeds = [...seedCounts.values()].sort((a, b) => b.count - a.count).slice(0, 12).map((item) => ({
      artist: item.sample.artist,
      artistKey: item.sample.artistKey,
      plays: item.count,
    }));
    if (seeds.length === 0) throw new Error("No listening-history seeds are available. Run sync_listening_history first.");

    const feedback = this.repository.listFeedback(this.username, 1_000);
    const artistFeedback = feedback.filter((item) => item.artist && item.album === null && item.track === null);
    const rejected = new Set(artistFeedback.filter((item) => ["boring", "dislike"].includes(item.verdict)).map((item) => item.artistKey ?? canonicalizeArtist(item.artist ?? "").key));
    const exclusions = new Map(this.repository.listActiveExclusions(this.username).map((item) => [item.artistKey, item]));
    const hardExclusions = new Set([...exclusions].filter(([, item]) => item.policy !== "new_releases_only").map(([key]) => key));
    const newReleaseRestrictions = new Set([...exclusions].filter(([, item]) => item.policy === "new_releases_only").map(([key]) => key));
    const seedContexts = await Promise.all(seeds.map(async (seed) => ({
      seed,
      context: await this.api.getArtistContext(seed.artist, true).catch(() => null),
    })));
    const seedClusters = clusterSeeds(seedContexts);
    const candidates = new Map<string, Candidate>();
    for (const { seed, context } of seedContexts) {
      for (const similar of context?.similarArtists ?? []) {
        const artistKey = canonicalizeArtist(similar.name).key;
        if (seeds.some((item) => item.artistKey === artistKey)) continue;
        addCandidateLink(candidates, similar.name, { ...seed, clusterId: seedClusters.get(seed.artistKey) ?? `provisional:${seed.artistKey}` }, similar.match ?? 0, "lastfm_similar_artists");
      }
    }

    const musicbrainzSeeds = await Promise.all(seeds.slice(0, 4).map(async (seed) => {
      const canonical = this.repository.getCanonicalEntities(this.username, { artist: seed.artist }).artist;
      return {
        seed,
        features: await this.musicbrainz.getArtistFeatures(seed.artist, canonical?.mbid).catch(() => null),
      };
    }));
    for (const { seed, features } of musicbrainzSeeds) {
      for (const relation of features?.relations ?? []) {
        if (relation.targetType !== "artist" || !relation.target.name) continue;
        if (!/collaboration|support|tribute|remix|touring/i.test(relation.type)) continue;
        const relatedKey = canonicalizeArtist(relation.target.name).key;
        if (seeds.some((item) => item.artistKey === relatedKey)) continue;
        addCandidateLink(candidates, relation.target.name, { ...seed, clusterId: seedClusters.get(seed.artistKey) ?? `provisional:${seed.artistKey}` }, 0.25, `musicbrainz_${relation.type}`);
      }
    }

    const mergedCandidates = new Map<string, Candidate>();
    for (const candidate of candidates.values()) {
      const persistentKey = this.repository.resolveArtistKey(this.username, candidate.artist);
      const existing = mergedCandidates.get(persistentKey);
      if (existing) {
        for (const link of candidate.seedLinks) {
          const duplicate = existing.seedLinks.find((item) => canonicalizeArtist(item.seed).key === canonicalizeArtist(link.seed).key);
          if (duplicate) duplicate.weight = Math.max(duplicate.weight, link.weight);
          else existing.seedLinks.push(link);
        }
        for (const source of candidate.sources) existing.sources.add(source);
      } else {
        candidate.artistKey = persistentKey;
        mergedCandidates.set(persistentKey, candidate);
      }
    }
    candidates.clear();
    for (const [key, candidate] of mergedCandidates) candidates.set(key, candidate);

    const previousRecommendations = new Map<string, ReturnType<IntelligenceRepository["listRecommendations"]>[number]>();
    for (const recommendation of this.repository.listRecommendations(this.username)) {
      if (!previousRecommendations.has(recommendation.artistKey)) previousRecommendations.set(recommendation.artistKey, recommendation);
    }
    for (const candidate of candidates.values()) {
      const previous = previousRecommendations.get(candidate.artistKey);
      if (!previous) continue;
      const currentPlays = this.repository.getArtistExposure(this.username, candidate.artist).totalPlays;
      candidate.outcomeAdjustment = currentPlays > previous.baselinePlays
        ? 0.08
        : now - previous.recommendedAtUnix >= 30 * 86_400 ? -0.15 : 0;
      candidate.priorOutcome = currentPlays > previous.baselinePlays
        ? "observed_listening_after_prior_recommendation"
        : now - previous.recommendedAtUnix >= 30 * 86_400 ? "no_scrobbles_within_30_days" : "pending";
    }
    const preferenceSignals = this.repository.listPreferenceSignals(this.username, 1_000);
    const seedDimensions = new Map<string, Map<string, number[]>>();
    for (const signal of preferenceSignals) {
      if (!signal.target.artist || signal.target.album || signal.target.track) continue;
      const key = signal.targetKeys.artistKey ?? canonicalizeArtist(signal.target.artist).key;
      const dimensions = seedDimensions.get(key) ?? new Map<string, number[]>();
      for (const [dimension, value] of Object.entries(signal.dimensions)) {
        const values = dimensions.get(dimension) ?? [];
        values.push(value);
        dimensions.set(dimension, values);
      }
      seedDimensions.set(key, dimensions);
    }
    for (const candidate of candidates.values()) {
      const direct = artistFeedback.filter((item) => (item.artistKey ?? canonicalizeArtist(item.artist ?? "").key) === candidate.artistKey);
      candidate.feedbackAdjustment = direct.reduce((sum, item) => {
        const verdict = item.verdict === "love" ? 0.12 : item.verdict === "like" ? 0.07 : item.verdict === "mixed" ? -0.02 : item.verdict === "not_now" ? -0.08 : 0;
        const rating = item.rating === null ? 0 : (item.rating - 5) / 50;
        return sum + verdict + rating;
      }, 0);
      const linkedDimensions = new Map<string, number[]>();
      for (const link of candidate.seedLinks) {
        for (const [dimension, values] of seedDimensions.get(canonicalizeArtist(link.seed).key) ?? []) {
          const target = linkedDimensions.get(dimension) ?? [];
          target.push(...values);
          linkedDimensions.set(dimension, target);
        }
      }
      candidate.dimensionEvidence = [...linkedDimensions]
        .map(([dimension, values]) => ({ dimension, average: values.reduce((sum, value) => sum + value, 0) / values.length }))
        .filter((item) => Math.abs(item.average) >= 1)
        .sort((a, b) => Math.abs(b.average) - Math.abs(a.average))
        .slice(0, 4);
      candidate.preferenceAdjustment = candidate.dimensionEvidence.reduce((sum, item) => sum + item.average / 250, 0);
    }

    const exposureThreshold = EXPOSURE_LEVELS.indexOf(input.excludeExposureAbove);
    const eligible = [...candidates.values()].filter((candidate) => {
      if (rejected.has(candidate.artistKey) || hardExclusions.has(candidate.artistKey)) return false;
      const exposure = classifyExposure(this.repository.getArtistExposure(this.username, candidate.artist));
      return EXPOSURE_LEVELS.indexOf(exposure) <= exposureThreshold;
    });
    const ranked = eligible.map((candidate) => scoreCandidate(candidate, input.mode, seeds[0]?.plays ?? 1))
      .filter((candidate) => input.mode !== "bridge" || distinctClusters(candidate) >= 2)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(eligible.length, input.count * 3));

    const recommendations = [];
    for (const candidate of ranked) {
      if (recommendations.length >= input.count) break;
      const exposure = withExposure(this.repository.getArtistExposure(this.username, candidate.artist));
      const [albums, tracks] = await Promise.all([
        this.api.getArtistTopAlbums(candidate.artist, 1).catch(() => []),
        this.api.getArtistTopTracks(candidate.artist, 3).catch(() => []),
      ]);
      const blockedAlbums = new Set(feedback.filter((item) => item.artist && item.album && ["boring", "dislike"].includes(item.verdict)
        && (item.artistKey ?? canonicalizeArtist(item.artist).key) === candidate.artistKey).map((item) => item.albumKey ?? canonicalKey(item.album ?? "")));
      const blockedTracks = new Set(feedback.filter((item) => item.artist && item.track && ["boring", "dislike"].includes(item.verdict)
        && (item.artistKey ?? canonicalizeArtist(item.artist).key) === candidate.artistKey).map((item) => item.trackKey ?? canonicalKey(item.track ?? "")));
      let startingAlbumName = albums.find((album) => !blockedAlbums.has(canonicalizeAlbum(album.name).key))?.name ?? null;
      let startingTrackNames = tracks.filter((track) => !blockedTracks.has(canonicalKey(track.name))).slice(0, 3).map((track) => track.name);
      if (newReleaseRestrictions.has(candidate.artistKey)) {
        const canonical = this.repository.getCanonicalEntities(this.username, { artist: candidate.artist }).artist;
        const releases = await this.musicbrainz.getArtistReleaseGroups(candidate.artist, canonical?.mbid, 25).catch(() => []);
        const recentRelease = releases.find((release) =>
          isRecentRelease(release.firstReleaseDate, now, 365)
          && !blockedAlbums.has(canonicalizeAlbum(release.title).key));
        if (!recentRelease) continue;
        startingAlbumName = recentRelease.title;
        const tracklist = await this.musicbrainz.getAlbumTracklist(candidate.artist, recentRelease.title, recentRelease.mbid).catch(() => null);
        startingTrackNames = (tracklist?.media.flatMap((medium) => medium.tracks.map((track) => track.title)) ?? [])
          .filter((track) => !blockedTracks.has(canonicalKey(track)))
          .slice(0, 3);
      }
      const seedNames = candidate.seedLinks.sort((a, b) => b.weight - a.weight).map((link) => link.seed);
      const reasons = input.explain ? [
        distinctClusters(candidate) >= 2
          ? `Connects ${distinctClusters(candidate)} tag-derived/provisional taste clusters through seeds: ${seedNames.slice(0, 3).join(", ")}.`
          : candidate.seedLinks.length >= 2
            ? `Connected to multiple seeds inside one inferred taste cluster: ${seedNames.slice(0, 3).join(", ")}.`
          : `Connected by Last.fm similarity to ${seedNames[0] ?? "a listening seed"}.`,
        `${exposure.exposure} exposure in the local history (${exposure.totalPlays} plays).`,
        ...(candidate.priorOutcome === "observed_listening_after_prior_recommendation"
          ? ["A prior recommendation was followed by new listening activity."] : []),
        ...(candidate.dimensionEvidence?.filter((item) => item.average > 0).length
          ? [`Linked seeds have explicit positive preference evidence for ${candidate.dimensionEvidence.filter((item) => item.average > 0).map((item) => item.dimension).join(", ")}.`] : []),
        ...(newReleaseRestrictions.has(candidate.artistKey) ? ["An active exclusion allows this artist only because the suggested album is a MusicBrainz-verified release from the last 365 days."] : []),
      ] : [];
      const risks = input.explain ? [
        ...(candidate.seedLinks.length < 2 ? ["Candidate evidence comes from one seed cluster only."] : []),
        ...(Math.max(...candidate.seedLinks.map((link) => link.weight)) < 0.4 ? ["Last.fm similarity weight is modest."] : []),
        ...(candidate.priorOutcome === "no_scrobbles_within_30_days"
          ? ["A prior recommendation produced no observed scrobbles within 30 days, so the score is penalized."] : []),
        ...(candidate.dimensionEvidence?.filter((item) => item.average < 0).length
          ? [`Linked seeds carry negative explicit signals for ${candidate.dimensionEvidence.filter((item) => item.average < 0).map((item) => item.dimension).join(", ")}; the score is reduced.`] : []),
        "No audio-feature model is used; vocals, production, groove, and composition must be validated by listening.",
      ] : [];
      const record = this.repository.recordRecommendation(this.username, {
        artist: candidate.artist,
        reason: reasons[0] ?? `Generated in ${input.mode} mode.`,
        mode: input.mode,
        score: candidate.score,
        confidence: candidate.confidence,
        context: { seeds: seedNames, sources: [...candidate.sources], risks },
      });
      recommendations.push({
        recommendationId: record.recommendationId,
        artist: candidate.artist,
        score: candidate.score,
        confidence: candidate.confidence,
        confidenceMeaning: "Evidence coverage/consistency, not a probability that the recommendation will be liked.",
        exposure: exposure.exposure,
        reasons,
        risks,
        startWith: { album: startingAlbumName, tracks: startingTrackNames },
        evidence: { seedLinks: candidate.seedLinks, sources: [...candidate.sources] },
      });
    }
    return {
      generatedAt: new Date().toISOString(),
      username: this.username,
      mode: input.mode,
      recommendations,
      consideredCandidates: candidates.size,
      eligibleCandidates: eligible.length,
      seeds: seeds.map((seed) => ({ ...seed, clusterId: seedClusters.get(seed.artistKey) ?? `provisional:${seed.artistKey}` })),
      seedWindow: currentEra ? { targetEra: "current", from: toIso(currentEra.start), to: toIso(currentEra.endExclusive) } : { targetEra: null, from: null, to: null },
      excluded: { hard: hardExclusions.size, newReleasesOnly: newReleaseRestrictions.size, negativeArtistFeedback: rejected.size, exposureThreshold: input.excludeExposureAbove },
      methodology: recommendationMethodology[input.mode],
      sourceLimitations: "Candidate generation currently uses Last.fm similar artists plus the local taste graph. MusicBrainz enriches identity/genres/relationships but does not expose a general similarity API. Spotify and scraped sites are not queried.",
      history: this.historyEvidence(),
    };
  }

  evaluateRecommendations(since?: number) {
    this.assertPrivateAccess();
    const recommendations = this.repository.listRecommendations(this.username, since);
    return {
      username: this.username,
      evaluatedAt: new Date().toISOString(),
      outcomes: recommendations.map((recommendation) => {
        const scrobbles = this.repository.getScrobbles(this.username, {
          artist: recommendation.artist,
          from: recommendation.recommendedAtUnix + 1,
        });
        const activeDays = new Set(scrobbles.map((item) => new Date(item.timestamp * 1000).toISOString().slice(0, 10))).size;
        const elapsed = scrobbles.length > 1 ? scrobbles.at(-1)!.timestamp - scrobbles[0]!.timestamp : 0;
        const status = scrobbles.length === 0 ? "untried"
          : elapsed >= 7 * 86_400 && activeDays >= 2 ? "returned"
          : scrobbles.length >= 10 || activeDays >= 2 ? "engaged"
          : "sampled";
        const albums = countBy(scrobbles.filter((item) => item.album), (item) => canonicalKey(item.album ?? ""));
        const tracks = countBy(scrobbles, (item) => canonicalKey(item.track));
        return {
          recommendationId: recommendation.recommendationId,
          artist: recommendation.artist,
          recommendedAt: recommendation.recommendedAt,
          outcome: status,
          playsAfterRecommendation: scrobbles.length,
          activeDays,
          firstPlayedAfterRecommendationAt: toIso(scrobbles[0]?.timestamp),
          lastPlayedAfterRecommendationAt: toIso(scrobbles.at(-1)?.timestamp),
          returnedAfter7Days: elapsed >= 7 * 86_400 && activeDays >= 2,
          returnedAfter30Days: elapsed >= 30 * 86_400 && activeDays >= 2,
          topAlbum: topCount(albums)?.sample.album ?? null,
          topTrack: topCount(tracks)?.sample.track ?? null,
          baselinePlays: recommendation.baselinePlays,
        };
      }),
      methodology: "Outcomes are measured only from scrobbles strictly after each recommendation timestamp: untried, sampled, engaged, then returned after at least seven days on multiple active days.",
      history: this.historyEvidence(),
    };
  }

  private requireScrobbles(input: { artist?: string; album?: string; from?: number; to?: number } = {}) {
    const tracks = this.repository.getScrobbles(this.username, input);
    if (this.history.getStatus(this.username).indexedScrobbles === 0) {
      throw new Error("The local listening history is empty. Run sync_listening_history with mode=full first.");
    }
    return tracks;
  }

  private historyEvidence() {
    const status = this.history.getStatus(this.username);
    const coveredThroughUnix = status.coveredThroughAt === null ? null : Math.floor(Date.parse(status.coveredThroughAt) / 1000);
    const stale = coveredThroughUnix === null || coveredThroughUnix < Math.floor(Date.now() / 1000) - 2 * 86_400;
    return {
      ...status,
      coverageCurrent: status.fullHistorySynced && !stale,
      caveat: !status.fullHistorySynced
        ? "The local backfill is not confirmed complete, so early exposure, returns, eras, and exclusions by past listening may be incomplete."
        : stale
          ? "The full backfill is complete, but coveredThroughAt is missing or older than 48 hours. Recent exposure and recommendation outcomes may be stale; run an incremental sync."
          : null,
    };
  }

  private assertMutationsEnabled(): void {
    if (!this.mutationsEnabled) {
      throw new Error("Local MCP mutations are disabled. Set MCP_ENABLE_MUTATIONS=true only behind trusted access control (for example OAuth or a private tunnel).");
    }
  }

  private assertPrivateAccess(): void {
    if (!this.mutationsEnabled) {
      throw new Error("Private preference data is disabled on this MCP endpoint. Enable MCP mutations/private data only behind trusted access control.");
    }
  }

  private async buildTagTimeline(
    scrobbles: AnalyticsScrobble[],
    options: { from?: number; to?: number; bucket: TimelineBucketUnit; limitPerBucket: number },
  ) {
    const artistTimeline = buildListeningTimeline(scrobbles, { ...options, dimension: "artist", limitPerBucket: 100 });
    const artistCounts = countBy(scrobbles, (item) => canonicalizeArtist(item.artist).key);
    const topArtists = [...artistCounts.values()].sort((a, b) => b.count - a.count).slice(0, 25);
    const tagsByArtist = new Map<string, string[]>();
    for (const item of topArtists) {
      const context = await this.api.getArtistContext(item.sample.artist, true).catch(() => null);
      tagsByArtist.set(canonicalizeArtist(item.sample.artist).key, context?.tags.slice(0, 5) ?? []);
    }
    const buckets = artistTimeline.buckets.map((bucket) => {
      const tagCounts = new Map<string, { name: string; count: number }>();
      for (const item of bucket.items) {
        for (const tag of tagsByArtist.get(canonicalizeArtist(item.artist).key) ?? []) {
          const key = canonicalKey(tag);
          const current = tagCounts.get(key) ?? { name: tag, count: 0 };
          current.count += item.plays;
          tagCounts.set(key, current);
        }
      }
      const total = [...tagCounts.values()].reduce((sum, item) => sum + item.count, 0);
      const items = [...tagCounts.values()].sort((a, b) => b.count - a.count).slice(0, options.limitPerBucket)
        .map((item) => ({ tag: item.name, plays: item.count, share: round(item.count / Math.max(total, 1)) }));
      return { ...bucket, items, totalTagAssignments: total };
    });
    const coveredPlays = topArtists.reduce((sum, item) => sum + item.count, 0);
    return {
      bucket: options.bucket,
      dimension: "tag" as const,
      from: options.from ?? null,
      to: options.to ?? null,
      scrobblesInRange: scrobbles.length,
      tagMetadataArtistLimit: 25,
      tagMetadataPlayCoverage: round(coveredPlays / Math.max(scrobbles.length, 1)),
      buckets,
      methodology: "Each play contributes to up to five Last.fm tags of its artist. Tag totals are assignments and can exceed scrobble totals; coverage is reported explicitly.",
    };
  }
}

type Candidate = {
  artist: string;
  artistKey: string;
  seedLinks: Array<{ seed: string; weight: number; seedPlays: number; clusterId: string }>;
  sources: Set<string>;
  outcomeAdjustment?: number;
  priorOutcome?: "observed_listening_after_prior_recommendation" | "no_scrobbles_within_30_days" | "pending";
  feedbackAdjustment?: number;
  preferenceAdjustment?: number;
  dimensionEvidence?: Array<{ dimension: string; average: number }>;
};

function scoreCandidate(candidate: Candidate, mode: RecommendationMode, maxSeedPlays: number) {
  const strongest = Math.max(...candidate.seedLinks.map((link) => link.weight), 0);
  const seedBreadth = Math.min(distinctClusters(candidate) / 3, 1);
  const seedDepth = Math.max(...candidate.seedLinks.map((link) => link.seedPlays), 0) / Math.max(maxSeedPlays, 1);
  const raw = mode === "safe"
    ? strongest * 0.65 + seedBreadth * 0.2 + seedDepth * 0.15
    : mode === "bridge"
      ? seedBreadth * 0.55 + strongest * 0.3 + seedDepth * 0.15
      : (1 - Math.abs(strongest - 0.35)) * 0.55 + seedBreadth * 0.2 + seedDepth * 0.25;
  const confidence = Math.min(0.95, 0.25 + Math.min(distinctClusters(candidate), 3) * 0.15 + (strongest >= 0.5 ? 0.2 : 0.1));
  return {
    ...candidate,
    score: round(Math.max(0, Math.min(
      raw + (candidate.outcomeAdjustment ?? 0) + (candidate.feedbackAdjustment ?? 0) + (candidate.preferenceAdjustment ?? 0),
      1,
    ))),
    confidence: round(confidence),
  };
}

function addCandidateLink(
  candidates: Map<string, Candidate>,
  artist: string,
  seed: { artist: string; plays: number; clusterId: string },
  weight: number,
  source: string,
) {
  const artistKey = canonicalizeArtist(artist).key;
  const candidate = candidates.get(artistKey) ?? { artist, artistKey, seedLinks: [], sources: new Set<string>() };
  const existing = candidate.seedLinks.find((link) => canonicalizeArtist(link.seed).key === canonicalizeArtist(seed.artist).key);
  if (existing) {
    existing.weight = Math.max(existing.weight, weight);
  } else {
    candidate.seedLinks.push({ seed: seed.artist, weight, seedPlays: seed.plays, clusterId: seed.clusterId });
  }
  candidate.sources.add(source);
  candidates.set(artistKey, candidate);
}

function distinctClusters(candidate: Candidate): number {
  return new Set(candidate.seedLinks.map((link) => link.clusterId)).size;
}

function clusterSeeds(
  contexts: Array<{ seed: { artist: string; artistKey: string }; context: { tags: string[] } | null }>,
): Map<string, string> {
  const parent = new Map(contexts.map(({ seed }) => [seed.artistKey, seed.artistKey]));
  const find = (key: string): string => {
    const current = parent.get(key) ?? key;
    if (current === key) return key;
    const root = find(current);
    parent.set(key, root);
    return root;
  };
  const union = (left: string, right: string) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };
  for (let left = 0; left < contexts.length; left += 1) {
    for (let right = left + 1; right < contexts.length; right += 1) {
      const a = contexts[left];
      const b = contexts[right];
      if (!a || !b) continue;
      const aTags = new Set((a.context?.tags ?? []).slice(0, 8).map(canonicalKey));
      const bTags = new Set((b.context?.tags ?? []).slice(0, 8).map(canonicalKey));
      if (aTags.size === 0 || bTags.size === 0) continue;
      const intersection = [...aTags].filter((tag) => bTags.has(tag)).length;
      const unionSize = new Set([...aTags, ...bTags]).size;
      if (intersection / Math.max(unionSize, 1) >= 0.25) union(a.seed.artistKey, b.seed.artistKey);
    }
  }
  return new Map(contexts.map(({ seed }) => [seed.artistKey, `cluster:${find(seed.artistKey)}`]));
}

function classifyExposure(stats: { totalPlays: number; activeDays?: number; activeMonths?: number; tracksPlayed?: number; lovedPlays?: number }): ExposureLevel {
  if (stats.totalPlays === 0) return "unheard";
  if (stats.totalPlays <= 10) return "sampled";
  const activeDays = stats.activeDays ?? 0;
  const activeMonths = stats.activeMonths ?? 0;
  if ((stats.tracksPlayed ?? 0) <= 1 && activeDays <= 1) return "sampled";
  if ((stats.totalPlays >= 100 && activeMonths >= 6) || (stats.totalPlays >= 50 && activeMonths >= 6 && (stats.lovedPlays ?? 0) > 0)) return "favorite";
  if ((activeMonths >= 3 && activeDays >= 5) || (activeMonths >= 2 && stats.totalPlays >= 40)) return "established";
  return "explored";
}

function withExposure(stats: ReturnType<IntelligenceRepository["getArtistExposure"]>) {
  return { ...stats, exposure: classifyExposure(stats) };
}

function countBy<T>(items: T[], keyOf: (item: T) => string): Map<string, { count: number; sample: T }> {
  const result = new Map<string, { count: number; sample: T }>();
  for (const item of items) {
    const key = keyOf(item);
    const current = result.get(key);
    result.set(key, current ? { ...current, count: current.count + 1 } : { count: 1, sample: item });
  }
  return result;
}

function topCount<T>(counts: Map<string, { count: number; sample: T }>) {
  return [...counts.values()].sort((a, b) => b.count - a.count)[0];
}

function addEdge(edges: Map<string, Record<string, unknown>>, source: string, target: string, type: string, weight: number, evidenceSource: string) {
  const [left, right] = source < target ? [source, target] : [target, source];
  const key = `${left}\0${right}\0${type}`;
  const current = edges.get(key);
  edges.set(key, current
    ? { ...current, weight: round(Number(current.weight ?? 0) + weight) }
    : { id: key, source, target, type, weight: round(weight), evidenceSource });
}

function yearOf(value: string | null | undefined): number | null {
  if (!value) return null;
  const year = Number.parseInt(value.slice(0, 4), 10);
  return Number.isFinite(year) ? year : null;
}

function isRecentRelease(value: string | null, nowUnix: number, maxAgeDays: number): boolean {
  if (!value) return false;
  const normalized = value.length === 4 ? `${value}-01-01` : value.length === 7 ? `${value}-01` : value;
  const milliseconds = Date.parse(normalized);
  return Number.isFinite(milliseconds)
    && milliseconds <= nowUnix * 1000
    && milliseconds >= (nowUnix - maxAgeDays * 86_400) * 1000;
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown metadata error";
}

const exposureMethodology = "unheard=0; sampled=1-10; explored=deeper trial; established=returns across multiple active days/months; favorite=high, sustained exposure (with loved plays able to strengthen it).";
const recommendationMethodology: Record<RecommendationMode, string> = {
  safe: "Ranks strong Last.fm similarity to high-play personal seeds, with evidence breadth as a secondary signal.",
  bridge: "Requires links to at least two personal seeds and prioritizes multi-seed breadth over one very strong similarity edge.",
  explore: "Prioritizes moderate rather than maximal similarity while retaining a grounded link to the listening history.",
};
