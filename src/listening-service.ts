import type {
  AlbumPlay,
  ArtistPlay,
  LastFmApi,
  LastFmPeriod,
  RecentTrack,
  TrackPlay,
} from "./domain.js";
import { HistoryRepository, normalize } from "./history-repository.js";
import { HistorySyncService, type SyncMode } from "./history-sync.js";
import { assertDateRange, periodStart, toIso } from "./time.js";

export class ListeningService {
  readonly syncService: HistorySyncService;

  constructor(
    private readonly api: LastFmApi,
    private readonly history: HistoryRepository,
    private readonly username: string,
    private readonly liveScanLimit: number,
    maxSyncTracks: number,
    private readonly mutationsEnabled = true,
  ) {
    this.syncService = new HistorySyncService(api, history, username, maxSyncTracks);
  }

  getUserProfile() {
    return this.api.getUserInfo();
  }

  async getTopArtists(period: LastFmPeriod, limit: number) {
    return { username: this.username, period, artists: await this.api.getTopArtists(period, limit) };
  }

  async getTopTracks(period: LastFmPeriod, limit: number) {
    return { username: this.username, period, tracks: await this.api.getTopTracks(period, limit) };
  }

  async getTopAlbums(period: LastFmPeriod, limit: number) {
    return { username: this.username, period, albums: await this.api.getTopAlbums(period, limit) };
  }

  async getRecentTracks(input: { from?: number; to?: number; limit: number }) {
    assertDateRange(input.from, input.to);
    const result = await this.fetchRecentTracks(input);
    return {
      username: this.username,
      from: toIso(input.from),
      to: toIso(input.to),
      tracks: result.tracks,
      returned: result.tracks.length,
      totalInWindow: result.total,
      truncated: result.tracks.length < result.total,
    };
  }

  async getListeningSummary(period: LastFmPeriod) {
    const now = Math.floor(Date.now() / 1_000);
    const from = periodStart(period, now);
    const [user, artists, tracks, albums, recent] = await Promise.all([
      this.api.getUserInfo(),
      this.api.getTopArtists(period, 15),
      this.api.getTopTracks(period, 15),
      this.api.getTopAlbums(period, 15),
      this.api.getRecentTracksPage({ ...(from === undefined ? {} : { from }), to: now, page: 1, limit: 50 }),
    ]);
    const historicalRecent = recent.tracks.filter((track) => !track.nowPlaying);
    const uniqueArtists = new Set(historicalRecent.map((track) => normalize(track.artist))).size;
    const uniqueTracks = new Set(historicalRecent.map(trackKey)).size;
    return {
      generatedAt: new Date().toISOString(),
      username: this.username,
      period,
      window: { from: toIso(from), to: toIso(now) },
      scrobbles: {
        inPeriod: period === "overall" ? user.totalScrobbles : recent.pageInfo.total,
        overall: user.totalScrobbles,
      },
      account: user,
      topArtists: artists,
      topTracks: tracks,
      topAlbums: albums,
      recentActivity: {
        nowPlaying: recent.tracks.find((track) => track.nowPlaying) ?? null,
        lastScrobbleAt: historicalRecent[0]?.playedAt ?? null,
        sampledScrobbles: historicalRecent.length,
        uniqueArtistsInSample: uniqueArtists,
        uniqueTracksInSample: uniqueTracks,
      },
    };
  }

  async searchListeningHistory(input: {
    artist?: string;
    album?: string;
    track?: string;
    from?: number;
    to?: number;
    exactMatch: boolean;
    limit: number;
    scanLimit?: number;
  }) {
    assertDateRange(input.from, input.to);
    if (!input.artist && !input.album && !input.track) {
      throw new Error("Provide at least one of artist, album, or track. Use get_recent_tracks for time-only queries.");
    }

    const status = this.history.getStatus(this.username);
    if (status.indexedScrobbles > 0) {
      const result = this.history.search(this.username, input);
      const coveredThroughUnix = result.status.coveredThroughAt === null
        ? 0
        : Math.floor(Date.parse(result.status.coveredThroughAt) / 1_000);
      const requestedTo = input.to ?? Math.floor(Date.now() / 1_000);
      const completeForRequestedRange = result.status.fullHistorySynced && requestedTo <= coveredThroughUnix;
      return {
        username: this.username,
        source: "local_index",
        query: queryEcho(input),
        tracks: result.tracks,
        matchesInIndex: result.matched,
        returned: result.tracks.length,
        truncated: result.matched > result.tracks.length,
        completeForRequestedRange,
        indexStatus: result.status,
        caveat: completeForRequestedRange
          ? null
          : "The local index is not confirmed complete through the requested end time; matches outside its coverage may be missing.",
      };
    }

    return this.searchLive(input);
  }

  getHistoryStatus() {
    return { ...this.history.getStatus(this.username), syncRunning: this.syncService.isRunning() };
  }

  syncHistory(mode: SyncMode, maxTracks: number) {
    if (!this.mutationsEnabled) throw new Error("Local MCP mutations are disabled. Set MCP_ENABLE_MUTATIONS=true only behind trusted access control.");
    return this.syncService.sync(mode, maxTracks);
  }

  async comparePeriods(periodA: LastFmPeriod, periodB: LastFmPeriod, limit: number) {
    const [artistsA, artistsB, tracksA, tracksB] = await Promise.all([
      this.api.getTopArtists(periodA, 200),
      this.api.getTopArtists(periodB, 200),
      this.api.getTopTracks(periodA, 200),
      this.api.getTopTracks(periodB, 200),
    ]);
    return {
      username: this.username,
      periodA,
      periodB,
      artists: compareRanked(artistsA, artistsB, (item) => normalize(item.name), limit),
      tracks: compareRanked(tracksA, tracksB, (item) => trackKey(item), limit),
      methodology: "Changes compare normalized play shares inside each returned top-200 chart, not raw counts alone.",
    };
  }

  async getTasteProfile() {
    const now = Math.floor(Date.now() / 1_000);
    const recent90Start = now - 90 * 86_400;
    const recent30Start = now - 30 * 86_400;
    const previous30Start = now - 60 * 86_400;
    const [overallArtists, recentArtists, overallTracks, recentTracks, overallAlbums, lovedTracks, rawRecent] =
      await Promise.all([
        this.api.getTopArtists("overall", 100),
        this.api.getTopArtists("3month", 100),
        this.api.getTopTracks("overall", 100),
        this.api.getTopTracks("3month", 100),
        this.api.getTopAlbums("overall", 100),
        this.api.getLovedTracks(200),
        this.api.getRecentTracksPage({ page: 1, limit: 200 }),
      ]);

    const status = this.history.getStatus(this.username);
    const indexIsCurrent = status.lastSyncAt !== null && Date.parse(status.lastSyncAt) / 1_000 >= now - 2 * 86_400;
    const indexCovers90Days =
      indexIsCurrent && status.oldestScrobbleAt !== null && Date.parse(status.oldestScrobbleAt) / 1_000 <= recent90Start;
    const indexCoversTrendWindows =
      indexIsCurrent && status.oldestScrobbleAt !== null && Date.parse(status.oldestScrobbleAt) / 1_000 <= previous30Start;
    const recentArtistMap = new Map(recentArtists.map((item) => [normalize(item.name), item]));
    const recentTrackMap = new Map(recentTracks.map((item) => [trackKey(item), item]));
    const loved = new Set(lovedTracks.map(trackKey));

    const recent30 = indexCoversTrendWindows ? this.history.artistCounts(this.username, recent30Start, now) : [];
    const previous30 = indexCoversTrendWindows
      ? this.history.artistCounts(this.username, previous30Start, recent30Start - 1)
      : [];
    const recent30Map = new Map(recent30.map((item) => [normalize(item.artist), item.plays]));
    const previous30Map = new Map(previous30.map((item) => [normalize(item.artist), item.plays]));

    const coreArtists = overallArtists.slice(0, 25).map((artist) => {
      const key = normalize(artist.name);
      const recent = recentArtistMap.get(key)?.playcount ?? 0;
      const trend = indexCoversTrendWindows
        ? trendFromCounts(recent30Map.get(key) ?? 0, previous30Map.get(key) ?? 0)
        : trendFromShares(artist, recentArtistMap.get(key), overallArtists, recentArtists);
      return { name: artist.name, plays: artist.playcount, recentPlays: recent, trend };
    });

    const favoriteTracks = overallTracks.slice(0, 25).map((track) => ({
      name: track.name,
      artist: track.artist,
      plays: track.playcount,
      recentPlays: recentTrackMap.get(trackKey(track))?.playcount ?? 0,
      loved: loved.has(trackKey(track)),
    }));

    const recentDiscoveries = status.fullHistorySynced && indexIsCurrent
      ? this.history.recentDiscoveries(this.username, recent90Start, 20).map((item) => ({ ...item, approximate: false }))
      : approximateDiscoveries(overallArtists, recentArtists);

    const forgottenFavorites = overallArtists
      .slice(0, 40)
      .filter((artist) => (recentArtistMap.get(normalize(artist.name))?.playcount ?? 0) <= 1)
      .slice(0, 20)
      .map((artist) => ({
        name: artist.name,
        overallPlays: artist.playcount,
        recentPlays: recentArtistMap.get(normalize(artist.name))?.playcount ?? 0,
      }));

    const sample = status.indexedScrobbles > 0 && indexCovers90Days
      ? this.history.recentSequence(this.username, recent90Start, now)
      : rawRecent.tracks.filter((track) => !track.nowPlaying);
    const aggregate = status.indexedScrobbles > 0 && indexCovers90Days
      ? this.history.aggregate(this.username, recent90Start, now)
      : aggregateTracks(sample);
    const transitions = albumTransitionRate(sample);
    const repeatConcentration = ratio(aggregate.topTenTrackPlays, aggregate.total);
    const uniqueTrackRatio = ratio(aggregate.uniqueTracks, aggregate.total);
    const albumMetadataShare = ratio(aggregate.tracksWithAlbum, aggregate.total);

    return {
      generatedAt: new Date().toISOString(),
      username: this.username,
      coreArtists,
      favoriteTracks,
      recentDiscoveries,
      forgottenFavorites,
      favoriteAlbums: overallAlbums.slice(0, 20),
      listeningPatterns: {
        repeatHeavy: aggregate.total >= 20 && (repeatConcentration >= 0.35 || uniqueTrackRatio <= 0.35),
        albumOriented: aggregate.total >= 20 && albumMetadataShare >= 0.7 && transitions >= 0.3,
        recentScrobblesAnalyzed: aggregate.total,
        uniqueArtistRatio: round(ratio(aggregate.uniqueArtists, aggregate.total)),
        uniqueTrackRatio: round(uniqueTrackRatio),
        topTenTrackShare: round(repeatConcentration),
        albumMetadataShare: round(albumMetadataShare),
        sameAlbumTransitionShare: round(transitions),
      },
      confidence: {
        source: status.indexedScrobbles > 0 && indexCovers90Days ? "local_index" : "lastfm_api_sample",
        fullHistorySynced: status.fullHistorySynced,
        trendMethod: indexCoversTrendWindows
          ? "last 30 days versus the previous non-overlapping 30 days"
          : "approximate normalized 3-month share versus overall share",
        discoveriesExact: status.fullHistorySynced && indexIsCurrent,
        caveat:
          status.fullHistorySynced && indexIsCurrent
            ? null
            : "Run sync_listening_history with mode=full, then incremental, for exact first-listen discoveries and stronger pattern evidence.",
      },
    };
  }

  getArtistContext(artist: string, autocorrect: boolean) {
    return this.api.getArtistContext(artist, autocorrect);
  }

  private async searchLive(input: {
    artist?: string;
    album?: string;
    track?: string;
    from?: number;
    to?: number;
    exactMatch: boolean;
    limit: number;
    scanLimit?: number;
  }) {
    const scanLimit = Math.min(input.scanLimit ?? this.liveScanLimit, this.liveScanLimit);
    const matches: RecentTrack[] = [];
    let scanned = 0;
    let page = 1;
    let total = 0;
    let totalPages = 0;
    while (scanned < scanLimit && matches.length < input.limit) {
      const response = await this.api.getRecentTracksPage({
        ...(input.from === undefined ? {} : { from: input.from }),
        ...(input.to === undefined ? {} : { to: input.to }),
        page,
        limit: 200,
      });
      if (page === 1) {
        total = response.pageInfo.total;
        totalPages = response.pageInfo.totalPages;
      }
      const tracks = response.tracks.filter((track) => !track.nowPlaying);
      for (const candidate of tracks) {
        if (scanned >= scanLimit || matches.length >= input.limit) break;
        scanned += 1;
        if (matchesQuery(candidate, input)) matches.push(candidate);
      }
      if (tracks.length === 0 || page >= response.pageInfo.totalPages) break;
      page += 1;
    }
    const searchExhausted = page >= totalPages && scanned >= Math.min(total, scanLimit);
    return {
      username: this.username,
      source: "live_lastfm_scan",
      query: queryEcho(input),
      tracks: matches,
      returned: matches.length,
      scannedScrobbles: scanned,
      totalScrobblesInWindow: total,
      truncated: !searchExhausted || matches.length >= input.limit,
      completeForRequestedRange: searchExhausted,
      caveat: searchExhausted
        ? null
        : "Last.fm has no server-side artist/album/track history filter. This result is from a bounded newest-first scan and may omit older matches.",
    };
  }

  private async fetchRecentTracks(input: { from?: number; to?: number; limit: number }) {
    const tracks: RecentTrack[] = [];
    let page = 1;
    let total = 0;
    while (tracks.length < input.limit) {
      const response = await this.api.getRecentTracksPage({
        ...(input.from === undefined ? {} : { from: input.from }),
        ...(input.to === undefined ? {} : { to: input.to }),
        page,
        // Keep a stable page size: Last.fm page offsets depend on perPage.
        limit: 200,
      });
      if (page === 1) total = response.pageInfo.total;
      tracks.push(...response.tracks.slice(0, input.limit - tracks.length));
      if (response.tracks.length === 0 || page >= response.pageInfo.totalPages) break;
      page += 1;
    }
    return { tracks, total };
  }
}

function compareRanked<T extends { rank: number; playcount: number }>(
  a: T[],
  b: T[],
  keyOf: (value: T) => string,
  limit: number,
) {
  const totalA = sumPlays(a);
  const totalB = sumPlays(b);
  const mapA = new Map(a.map((item) => [keyOf(item), item]));
  const mapB = new Map(b.map((item) => [keyOf(item), item]));
  const keys = new Set([...mapA.keys(), ...mapB.keys()]);
  return [...keys]
    .map((key) => {
      const itemA = mapA.get(key);
      const itemB = mapB.get(key);
      const shareA = ratio(itemA?.playcount ?? 0, totalA);
      const shareB = ratio(itemB?.playcount ?? 0, totalB);
      return {
        item: itemA ?? itemB,
        periodA: itemA ? { rank: itemA.rank, plays: itemA.playcount, share: round(shareA) } : null,
        periodB: itemB ? { rank: itemB.rank, plays: itemB.playcount, share: round(shareB) } : null,
        shareChange: round(shareB - shareA),
      };
    })
    .sort((left, right) => Math.abs(right.shareChange) - Math.abs(left.shareChange))
    .slice(0, limit);
}

function trendFromCounts(recent: number, previous: number): "rising" | "stable" | "cooling" {
  if (recent >= previous * 1.5 && recent - previous >= 3) return "rising";
  if (previous >= recent * 1.5 && previous - recent >= 3) return "cooling";
  return "stable";
}

function trendFromShares(
  overall: ArtistPlay,
  recent: ArtistPlay | undefined,
  overallChart: ArtistPlay[],
  recentChart: ArtistPlay[],
): "rising" | "stable" | "cooling" {
  const overallShare = ratio(overall.playcount, sumPlays(overallChart));
  const recentShare = ratio(recent?.playcount ?? 0, sumPlays(recentChart));
  if ((recent?.playcount ?? 0) >= 3 && recentShare >= overallShare * 1.5) return "rising";
  if (recentShare <= overallShare * 0.5) return "cooling";
  return "stable";
}

function approximateDiscoveries(overall: ArtistPlay[], recent: ArtistPlay[]) {
  const established = new Set(overall.slice(0, 50).map((artist) => normalize(artist.name)));
  return recent
    .filter((artist) => !established.has(normalize(artist.name)))
    .slice(0, 20)
    .map((artist) => ({
      artist: artist.name,
      recentPlays: artist.playcount,
      approximate: true,
      reason: "Appears in the recent top chart but not the all-time top 50; first-listen date is unknown without full sync.",
    }));
}

function aggregateTracks(tracks: RecentTrack[]) {
  const artistCounts = new Map<string, number>();
  const trackCounts = new Map<string, number>();
  const albumKeys = new Set<string>();
  let tracksWithAlbum = 0;
  for (const track of tracks) {
    const artist = normalize(track.artist);
    artistCounts.set(artist, (artistCounts.get(artist) ?? 0) + 1);
    const key = trackKey(track);
    trackCounts.set(key, (trackCounts.get(key) ?? 0) + 1);
    if (track.album) {
      tracksWithAlbum += 1;
      albumKeys.add(`${artist}\0${normalize(track.album)}`);
    }
  }
  const counts = [...trackCounts.values()].sort((a, b) => b - a);
  return {
    total: tracks.length,
    uniqueArtists: artistCounts.size,
    uniqueAlbums: albumKeys.size,
    uniqueTracks: trackCounts.size,
    tracksWithAlbum,
    topTrackPlays: counts[0] ?? 0,
    topTenTrackPlays: counts.slice(0, 10).reduce((sum, value) => sum + value, 0),
  };
}

function albumTransitionRate(tracks: RecentTrack[]): number {
  if (tracks.length < 2) return 0;
  let eligible = 0;
  let sameAlbum = 0;
  for (let index = 1; index < tracks.length; index += 1) {
    const previous = tracks[index - 1];
    const current = tracks[index];
    if (!previous?.album || !current?.album) continue;
    eligible += 1;
    if (
      normalize(previous.artist) === normalize(current.artist) &&
      normalize(previous.album) === normalize(current.album)
    ) {
      sameAlbum += 1;
    }
  }
  return ratio(sameAlbum, eligible);
}

function matchesQuery(
  track: RecentTrack,
  query: { artist?: string; album?: string; track?: string; exactMatch: boolean },
): boolean {
  return (
    textMatches(track.artist, query.artist, query.exactMatch) &&
    textMatches(track.album ?? "", query.album, query.exactMatch) &&
    textMatches(track.name, query.track, query.exactMatch)
  );
}

function textMatches(value: string, query: string | undefined, exact: boolean): boolean {
  if (!query) return true;
  const normalizedValue = normalize(value);
  const normalizedQuery = normalize(query);
  return exact ? normalizedValue === normalizedQuery : normalizedValue.includes(normalizedQuery);
}

function queryEcho(input: {
  artist?: string;
  album?: string;
  track?: string;
  from?: number;
  to?: number;
  exactMatch: boolean;
}) {
  return {
    artist: input.artist ?? null,
    album: input.album ?? null,
    track: input.track ?? null,
    from: toIso(input.from),
    to: toIso(input.to),
    exactMatch: input.exactMatch,
  };
}

function trackKey(track: { artist: string; name: string }): string {
  return `${normalize(track.artist)}\0${normalize(track.name)}`;
}

function sumPlays(items: Array<{ playcount: number }>): number {
  return items.reduce((sum, item) => sum + item.playcount, 0);
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
