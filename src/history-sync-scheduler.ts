import type { HistorySyncService, SyncMode, SyncResult } from "./history-sync.js";
import type { HistoryRepository } from "./history-repository.js";

type SchedulerStatus = {
  running: boolean;
  lastMode?: SyncMode;
  lastStartedAt?: string;
  lastFinishedAt?: string;
  nextRunAt?: string;
  lastResult?: Pick<SyncResult, "scannedTracks" | "storedRowsChanged" | "pagesFetched" | "completedRequestedRange">;
  error?: string;
};

// Keeps the local index current without anyone calling sync_listening_history.
// The first run backfills the whole history (resumable across restarts); every
// later run is incremental.
export class HistorySyncScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active: Promise<void> | undefined;
  private stopped = true;
  private status: SchedulerStatus = { running: false };

  constructor(
    private readonly sync: HistorySyncService,
    private readonly history: HistoryRepository,
    private readonly username: string,
    private readonly maxTracks: number,
    private readonly intervalMs: number,
    // Runs after every successful sync. Used to build the canonical index in
    // the background so the first analytics tool call does not pay for it.
    private readonly afterSync?: () => void | Promise<void>,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.tick();
  }

  getStatus() {
    return { enabled: !this.stopped, intervalSeconds: this.intervalMs / 1_000, ...this.status };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.active;
  }

  private tick(): void {
    this.active = this.execute().finally(() => {
      this.active = undefined;
      if (!this.stopped) {
        this.timer = setTimeout(() => this.tick(), this.intervalMs);
        this.timer.unref();
      }
    });
  }

  private async execute(): Promise<void> {
    const mode: SyncMode = this.history.getStatus(this.username).fullHistorySynced ? "incremental" : "full";
    this.status = { running: true, lastMode: mode, lastStartedAt: new Date().toISOString() };
    try {
      const result = await this.sync.sync(mode, this.maxTracks);
      this.status.lastResult = {
        scannedTracks: result.scannedTracks,
        storedRowsChanged: result.storedRowsChanged,
        pagesFetched: result.pagesFetched,
        completedRequestedRange: result.completedRequestedRange,
      };
      await this.afterSync?.();
    } catch (error) {
      this.status.error = error instanceof Error ? error.message : "Automatic history sync failed";
    } finally {
      this.status.running = false;
      this.status.lastFinishedAt = new Date().toISOString();
      this.status.nextRunAt = new Date(Date.now() + this.intervalMs).toISOString();
      console.log(JSON.stringify({ event: "history_auto_sync", ...this.status }));
    }
  }
}
