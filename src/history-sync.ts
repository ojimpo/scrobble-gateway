import type { LastFmApi, RecentTrack } from "./domain.js";
import { HistoryRepository, normalize } from "./history-repository.js";

export type SyncMode = "incremental" | "full";

export const DEFAULT_INCREMENTAL_LOOKBACK_SECONDS = 72 * 60 * 60;

export type SyncResult = {
  mode: SyncMode;
  startedAt: string;
  finishedAt: string;
  requestedMaxTracks: number;
  scannedTracks: number;
  storedRowsChanged: number;
  pagesFetched: number;
  totalReportedByLastFm: number;
  completedRequestedRange: boolean;
  status: ReturnType<HistoryRepository["getStatus"]>;
};

export class HistorySyncService {
  private activeSync: Promise<SyncResult> | null = null;

  constructor(
    private readonly api: LastFmApi,
    private readonly repository: HistoryRepository,
    private readonly username: string,
    private readonly maxAllowedTracks: number,
    // Incremental runs re-read this many seconds before the newest stored
    // scrobble. Spotify-originated scrobbles reach Last.fm late and out of
    // order, so a cursor at the newest second skips plays that arrive after a
    // newer one was already indexed. Upserts make the overlap harmless.
    private readonly incrementalLookbackSeconds: number = DEFAULT_INCREMENTAL_LOOKBACK_SECONDS,
  ) {}

  sync(mode: SyncMode, requestedMaxTracks: number): Promise<SyncResult> {
    if (this.activeSync) return this.activeSync;
    const maxTracks = Math.min(requestedMaxTracks, this.maxAllowedTracks);
    this.activeSync = this.run(mode, maxTracks).finally(() => {
      this.activeSync = null;
    });
    return this.activeSync;
  }

  isRunning(): boolean {
    return this.activeSync !== null;
  }

  private async run(mode: SyncMode, maxTracks: number): Promise<SyncResult> {
    const startedAtMs = Date.now();
    const startedAtUnix = Math.floor(startedAtMs / 1_000);
    const before = this.repository.getStatus(this.username);
    if (mode === "full" && before.fullHistorySynced && before.coveredThroughAt !== null) {
      return {
        mode,
        startedAt: new Date(startedAtMs).toISOString(),
        finishedAt: new Date().toISOString(),
        requestedMaxTracks: maxTracks,
        scannedTracks: 0,
        storedRowsChanged: 0,
        pagesFetched: 0,
        totalReportedByLastFm: before.indexedScrobbles,
        completedRequestedRange: true,
        status: before,
      };
    }
    const newestUnix = before.newestScrobbleAt ? Math.floor(Date.parse(before.newestScrobbleAt) / 1_000) : undefined;
    const fullProgress = mode === "full" ? this.repository.getFullSyncProgress(this.username) : null;
    const incrementalProgress = mode === "incremental" ? this.repository.getIncrementalSyncProgress(this.username) : null;
    // Freeze the upper boundary until this pass completes. Advancing newestUnix
    // must not move the lookback window past an unfinished slice of history.
    const upperBoundary = mode === "full"
      ? (fullProgress?.upperUnix ?? startedAtUnix)
      : (incrementalProgress?.upperUnix ?? startedAtUnix);
    const to = mode === "full" ? (fullProgress?.cursorUnix ?? upperBoundary) : upperBoundary;
    const lowerBoundary = mode === "full" ? undefined : incrementalProgress
      ? (incrementalProgress.cursorUnix ?? undefined)
      : newestUnix === undefined ? undefined : Math.max(newestUnix - this.incrementalLookbackSeconds, 0);
    // Last.fm documents `from` as "after" a timestamp. Request the preceding
    // second and filter locally so boundary ties survive exclusive endpoints.
    const from = lowerBoundary === undefined ? undefined : Math.max(lowerBoundary - 1, 0);
    const resumedBoundaryKeys = new Set(incrementalProgress?.boundaryKeys ?? []);
    let cursorUnix = lowerBoundary ?? null;
    let boundaryKeys = new Set(resumedBoundaryKeys);
    const saveIncrementalProgress = () => this.repository.setIncrementalSyncProgress(this.username, {
      cursorUnix, upperUnix: upperBoundary, boundaryKeys: [...boundaryKeys],
    });

    let scannedTracks = 0;
    let storedRowsChanged = 0;
    let pagesFetched = 0;
    let totalReportedByLastFm = 0;
    let completedRequestedRange = false;
    let oldestSelectedUnix: number | null = null;

    const first = await this.api.getRecentTracksPage({
      ...(from === undefined ? {} : { from }),
      to,
      page: 1,
      limit: 200,
    });
    pagesFetched += 1;
    totalReportedByLastFm = first.pageInfo.total;
    // Persist before storing any rows, so an error or process restart cannot
    // replace the unfinished window with one based on the updated newest play.
    if (mode === "incremental") saveIncrementalProgress();

    // Incremental pages advance from the oldest edge, even if the whole range
    // fits the budget: a later page may fail after earlier pages were saved.
    const oldestFirst = mode === "incremental";
    let page = oldestFirst ? Math.max(first.pageInfo.totalPages, 1) : 1;
    let response = page === 1
      ? first
      : await this.api.getRecentTracksPage({ ...(from === undefined ? {} : { from }), to, page, limit: 200 });
    if (page !== 1) pagesFetched += 1;

    while (scannedTracks < maxTracks) {
      const historical = response.tracks.filter(isHistorical).filter((track) =>
        lowerBoundary === undefined || (track.playedAtUnix >= lowerBoundary
          && (track.playedAtUnix !== lowerBoundary || !resumedBoundaryKeys.has(scrobbleKey(track)))));
      const remaining = maxTracks - scannedTracks;
      const selected = oldestFirst && remaining < historical.length
        ? historical.slice(-remaining)
        : historical.slice(0, remaining);
      scannedTracks += selected.length;
      storedRowsChanged += this.repository.upsertTracks(this.username, selected);
      for (const track of selected) {
        if (track.playedAtUnix !== null) oldestSelectedUnix = Math.min(oldestSelectedUnix ?? track.playedAtUnix, track.playedAtUnix);
        if (mode === "incremental" && track.playedAtUnix !== null) {
          if (cursorUnix === null || track.playedAtUnix > cursorUnix) {
            cursorUnix = track.playedAtUnix;
            boundaryKeys = new Set();
          }
          if (track.playedAtUnix === cursorUnix) boundaryKeys.add(scrobbleKey(track));
        }
      }
      if (mode === "incremental") saveIncrementalProgress();

      const atRangeEnd = oldestFirst
        ? page <= 1
        : response.pageInfo.totalPages === 0 || page >= response.pageInfo.totalPages || response.tracks.length < response.pageInfo.perPage;
      if (selected.length < historical.length) break;
      if (atRangeEnd) {
        completedRequestedRange = true;
        break;
      }
      if (scannedTracks >= maxTracks) break;
      page += oldestFirst ? -1 : 1;
      response = await this.api.getRecentTracksPage({ ...(from === undefined ? {} : { from }), to, page, limit: 200 });
      pagesFetched += 1;
    }

    const finishedAtUnix = Math.floor(Date.now() / 1_000);
    if (mode === "full") {
      if (completedRequestedRange) {
        this.repository.clearFullSyncProgress(this.username);
        this.repository.markSync(this.username, mode, true, finishedAtUnix, upperBoundary);
      } else if (oldestSelectedUnix !== null) {
        this.repository.setFullSyncProgress(this.username, oldestSelectedUnix, upperBoundary);
        this.repository.markSync(this.username, mode, false, finishedAtUnix);
      }
    } else {
      if (completedRequestedRange) this.repository.clearIncrementalSyncProgress(this.username);
      this.repository.markSync(
        this.username,
        mode,
        false,
        finishedAtUnix,
        completedRequestedRange ? upperBoundary : undefined,
      );
    }
    return {
      mode,
      startedAt: new Date(startedAtMs).toISOString(),
      finishedAt: new Date().toISOString(),
      requestedMaxTracks: maxTracks,
      scannedTracks,
      storedRowsChanged,
      pagesFetched,
      totalReportedByLastFm,
      completedRequestedRange,
      status: this.repository.getStatus(this.username),
    };
  }
}

function isHistorical(track: RecentTrack): track is RecentTrack & { playedAtUnix: number } {
  return !track.nowPlaying && track.playedAtUnix !== null;
}

function scrobbleKey(track: RecentTrack): string {
  // Match the scrobble primary key within a single timestamp. Saving identities
  // rather than an offset also tolerates changes in API ordering at that second.
  return JSON.stringify([normalize(track.artist), normalize(track.album ?? ""), normalize(track.name)]);
}
