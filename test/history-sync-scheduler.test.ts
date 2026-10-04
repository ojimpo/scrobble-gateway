import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { HistoryRepository } from "../src/history-repository.js";
import type { HistorySyncService, SyncResult } from "../src/history-sync.js";
import { HistorySyncScheduler } from "../src/history-sync-scheduler.js";

const repositories: HistoryRepository[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const repository of repositories.splice(0)) repository.close();
});

describe("HistorySyncScheduler", () => {
  it("backfills first, then runs incremental syncs on the interval, and stops cleanly", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const repository = createRepository();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const sync = vi.fn(async (mode: string) => {
      if (mode === "full") repository.markSync("listener", "full", true, 100, 100);
      return result();
    });
    const scheduler = new HistorySyncScheduler({ sync } as unknown as HistorySyncService, repository, "listener", 1_000, 3_600_000);
    try {
      scheduler.start();
      await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));
      expect(sync).toHaveBeenLastCalledWith("full", 1_000);

      await vi.advanceTimersByTimeAsync(3_600_000);
      await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(2));
      expect(sync).toHaveBeenLastCalledWith("incremental", 1_000);
      expect(scheduler.getStatus()).toMatchObject({ running: false, lastMode: "incremental", lastResult: { scannedTracks: 1 } });

      await scheduler.stop();
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(sync).toHaveBeenCalledTimes(2);
    } finally {
      await scheduler.stop();
      log.mockRestore();
    }
  });

  it("runs the after-sync hook only when the sync succeeds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const repository = createRepository();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const sync = vi.fn().mockResolvedValueOnce(result()).mockRejectedValueOnce(new Error("down"));
    const afterSync = vi.fn();
    const scheduler = new HistorySyncScheduler({ sync } as unknown as HistorySyncService, repository, "listener", 1_000, 60_000, afterSync);
    try {
      scheduler.start();
      await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));
      expect(afterSync).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(2));
      expect(afterSync).toHaveBeenCalledTimes(1);
    } finally {
      await scheduler.stop();
      log.mockRestore();
    }
  });

  it("records a failure and keeps the schedule", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const repository = createRepository();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const sync = vi.fn().mockRejectedValueOnce(new Error("Last.fm unavailable")).mockResolvedValue(result());
    const scheduler = new HistorySyncScheduler({ sync } as unknown as HistorySyncService, repository, "listener", 1_000, 60_000);
    try {
      scheduler.start();
      await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));
      expect(scheduler.getStatus()).toMatchObject({ error: "Last.fm unavailable", running: false });

      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(2));
      expect(scheduler.getStatus().error).toBeUndefined();
    } finally {
      await scheduler.stop();
      log.mockRestore();
    }
  });

  it("is enabled hourly by default", () => {
    const config = loadConfig({ LASTFM_API_KEY: "key", LASTFM_USERNAME: "listener", MCP_HOST: "127.0.0.1" });
    expect(config).toMatchObject({ historyAutoSyncEnabled: true, historyAutoSyncIntervalMs: 3_600_000 });
  });
});

function createRepository(): HistoryRepository {
  const directory = mkdtempSync(join(tmpdir(), "lastfm-mcp-scheduler-"));
  const repository = new HistoryRepository(join(directory, "history.sqlite"));
  repositories.push(repository);
  return repository;
}

function result(): SyncResult {
  return {
    mode: "incremental",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    requestedMaxTracks: 1_000,
    scannedTracks: 1,
    storedRowsChanged: 1,
    pagesFetched: 1,
    totalReportedByLastFm: 1,
    completedRequestedRange: true,
    status: {} as SyncResult["status"],
  };
}
