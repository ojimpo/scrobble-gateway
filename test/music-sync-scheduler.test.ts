import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MusicSyncScheduler } from "../src/music-sync-scheduler.js";
import { SecretStore } from "../src/secret-store.js";
import type { SyncSummary } from "../src/music-library-service.js";
import { loadMusicConfig } from "../src/music-config.js";
afterEach(() => { vi.useRealTimers(); });
describe("automatic sync", () => {
  it("defaults to hourly sync only when Spotify is configured; private tools stay opt-in", () => {
    expect(loadMusicConfig({}, "data/history.sqlite")).toMatchObject({ autoSyncEnabled: false, toolsEnabled: false });
    expect(loadMusicConfig({ SPOTIFY_CLIENT_ID: "id", SPOTIFY_CLIENT_SECRET: "secret" }, "data/history.sqlite"))
      .toMatchObject({ autoSyncEnabled: true, intervalMs: 3600000, toolsEnabled: false });
  });
  it("runs immediately, persists failures, retries after the interval, and stops cleanly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "music-scheduler-"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const run = vi.fn<() => Promise<SyncSummary>>().mockRejectedValue(new Error("auth required"));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const path = join(dir, "status.json");
    const scheduler = new MusicSyncScheduler(run, 3600000, path);
    try {
      scheduler.start();
      // Wait for actual file IO rather than advancing the scheduler before it has armed its timer.
      await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));
      expect(run).toHaveBeenCalledTimes(1);
      expect(await new SecretStore(path).read()).toMatchObject({ error: "auth required", running: false });
      await vi.advanceTimersByTimeAsync(3600000);
      await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(2));
      await scheduler.stop();
      await vi.advanceTimersByTimeAsync(3600000);
      expect(run).toHaveBeenCalledTimes(2);
    } finally { await scheduler.stop(); log.mockRestore(); await rm(dir, { recursive: true, force: true }); }
  });
});
