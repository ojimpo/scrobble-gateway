import { SecretStore } from "./secret-store.js";
import type { SyncSummary } from "./music-library-service.js";

export class MusicSyncScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active: Promise<void> | undefined;
  private stopped = true;
  private status: { running: boolean; lastStartedAt?: string; lastFinishedAt?: string; nextRunAt?: string; result?: SyncSummary; error?: string } = { running: false };
  private readonly store: SecretStore;
  constructor(private readonly run: () => Promise<SyncSummary>, private readonly intervalMs: number, statusPath: string) {
    this.store = new SecretStore(statusPath);
  }
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.tick();
  }
  getStatus() { return { enabled: !this.stopped, intervalSeconds: this.intervalMs / 1000, ...this.status }; }
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.active;
  }
  private tick(): void {
    this.active = this.execute().finally(() => {
      this.active = undefined;
      if (!this.stopped) { this.timer = setTimeout(() => this.tick(), this.intervalMs); this.timer.unref(); }
    });
  }
  private async execute(): Promise<void> {
    this.status = { running: true, lastStartedAt: new Date().toISOString() };
    try { this.status.result = await this.run(); }
    catch (error) { this.status.error = error instanceof Error ? error.message : "Automatic music sync failed"; }
    finally {
      this.status.running = false;
      this.status.lastFinishedAt = new Date().toISOString();
      this.status.nextRunAt = new Date(Date.now() + this.intervalMs).toISOString();
      try { await this.store.write(this.status); }
      catch { this.status.error = "Cannot persist music sync status; check data directory permissions"; }
      console.log(JSON.stringify({ event: "spotify_lastfm_auto_sync", ...this.status }));
    }
  }
}
