import type { LastFmApi, RecentTrack } from "./domain.js";
import { HistoryRepository } from "./history-repository.js";

export type SyncMode = "incremental" | "full";

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
    // Incremental runs re-read the newest second inclusively. Full runs keep a
    // persistent oldest cursor so a capped backfill resumes instead of
    // repeatedly downloading the same newest slice.
    const from = mode === "incremental" && newestUnix !== undefined ? newestUnix : undefined;
    const upperBoundary = mode === "full" ? (fullProgress?.upperUnix ?? startedAtUnix) : startedAtUnix;
    const to = mode === "full" ? (fullProgress?.cursorUnix ?? upperBoundary) : upperBoundary;

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

    // A capped incremental run must advance from the oldest edge of the
    // backlog. If it stored the newest slice, the next `from` cursor would
    // skip the unprocessed middle forever.
    const oldestFirst = mode === "incremental" && first.pageInfo.total > maxTracks;
    let page = oldestFirst ? Math.max(first.pageInfo.totalPages, 1) : 1;
    let response = page === 1
      ? first
      : await this.api.getRecentTracksPage({ ...(from === undefined ? {} : { from }), to, page, limit: 200 });
    if (page !== 1) pagesFetched += 1;

    while (scannedTracks < maxTracks) {
      const historical = response.tracks.filter(isHistorical);
      const remaining = maxTracks - scannedTracks;
      const selected = oldestFirst && remaining < historical.length
        ? historical.slice(-remaining)
        : historical.slice(0, remaining);
      scannedTracks += selected.length;
      storedRowsChanged += this.repository.upsertTracks(this.username, selected);
      for (const track of selected) {
        if (track.playedAtUnix !== null) oldestSelectedUnix = Math.min(oldestSelectedUnix ?? track.playedAtUnix, track.playedAtUnix);
      }

      const atRangeEnd = oldestFirst
        ? page <= 1
        : response.pageInfo.totalPages === 0 || page >= response.pageInfo.totalPages || response.tracks.length < response.pageInfo.perPage;
      if (historical.length === 0) {
        completedRequestedRange = true;
        break;
      }
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

function isHistorical(track: RecentTrack): boolean {
  return !track.nowPlaying && track.playedAtUnix !== null;
}
