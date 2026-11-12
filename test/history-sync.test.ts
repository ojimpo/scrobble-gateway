import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LastFmApi, RecentTrack } from "../src/domain.js";
import { HistoryRepository } from "../src/history-repository.js";
import { DEFAULT_INCREMENTAL_LOOKBACK_SECONDS, HistorySyncService } from "../src/history-sync.js";

const repositories: HistoryRepository[] = [];
afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
  vi.restoreAllMocks();
});

describe("HistorySyncService", () => {
  it("backfills pages and marks a complete full history", async () => {
    const repository = createRepository();
    const getRecentTracksPage = vi
      .fn<LastFmApi["getRecentTracksPage"]>()
      .mockResolvedValueOnce({
        tracks: [track("A", 300), track("B", 200)],
        pageInfo: { page: 1, perPage: 2, totalPages: 2, total: 3 },
      })
      .mockResolvedValueOnce({
        tracks: [track("C", 100)],
        pageInfo: { page: 2, perPage: 2, totalPages: 2, total: 3 },
      });
    const api = { getRecentTracksPage } as unknown as LastFmApi;
    const sync = new HistorySyncService(api, repository, "listener", 1_000);

    const result = await sync.sync("full", 1_000);

    expect(result).toMatchObject({ scannedTracks: 3, pagesFetched: 2, completedRequestedRange: true });
    expect(result.status).toMatchObject({ indexedScrobbles: 3, fullHistorySynced: true });
    expect(getRecentTracksPage.mock.calls[0]?.[0]).toMatchObject({ page: 1, limit: 200 });
  });

  it("resumes a capped full backfill from its persisted oldest cursor", async () => {
    const repository = createRepository();
    const api = recentApi([track("Newest", 300), track("Middle", 200), track("Oldest", 100)]);
    const sync = new HistorySyncService(api, repository, "listener", 2);

    const first = await sync.sync("full", 2);
    expect(first).toMatchObject({ scannedTracks: 2, completedRequestedRange: false });
    expect(first.status).toMatchObject({ indexedScrobbles: 2, fullHistorySynced: false, fullSyncInProgress: true });

    const second = await sync.sync("full", 2);
    expect(second).toMatchObject({ completedRequestedRange: true });
    expect(second.status).toMatchObject({ indexedScrobbles: 3, fullHistorySynced: true, fullSyncInProgress: false });
    expect(second.status.coveredThroughAt).not.toBeNull();
  });

  it("advances a capped incremental backlog oldest-first without skipping the middle", async () => {
    const repository = createRepository();
    repository.upsertTracks("listener", [track("Boundary", 100)]);
    repository.markSync("listener", "full", true, 100, 100);
    const api = recentApi([
      track("Newest", 500),
      track("Newer", 400),
      track("Middle", 300),
      track("Older", 200),
      track("Boundary", 100),
    ]);
    const sync = new HistorySyncService(api, repository, "listener", 2);

    const results = [];
    for (let attempt = 0; attempt < 3; attempt += 1) results.push(await sync.sync("incremental", 2));

    expect(repository.getStatus("listener")).toMatchObject({ indexedScrobbles: 5, fullHistorySynced: true });
    expect(results.slice(0, 2).every((result) => !result.completedRequestedRange)).toBe(true);
    expect(results[2]?.completedRequestedRange).toBe(true);
    expect(results[1]?.status.coveredThroughAt).toBe(new Date(100 * 1000).toISOString());
    expect(results[2]?.status.coveredThroughAt).not.toBe(new Date(100 * 1000).toISOString());
  });

  it("picks up a late scrobble older than the newest indexed one", async () => {
    // Spotify scrobbles reach Last.fm late and out of order. A cursor at the
    // newest second skipped them for good (12 plays in 2026-09).
    const base = 1_790_000_000;
    const repository = createRepository();
    repository.upsertTracks("listener", [track("Earlier", base), track("Newest", base + 600)]);
    repository.markSync("listener", "full", true, base + 600, base + 600);
    const api = recentApi([track("Newest", base + 600), track("Late", base + 300), track("Earlier", base)]);
    const sync = new HistorySyncService(api, repository, "listener", 1_000);

    await sync.sync("incremental", 1_000);

    expect(repository.getStatus("listener")).toMatchObject({ indexedScrobbles: 3 });
    expect(vi.mocked(api.getRecentTracksPage).mock.calls[0]?.[0]).toMatchObject({
      from: base + 600 - DEFAULT_INCREMENTAL_LOOKBACK_SECONDS - 1,
    });
  });

  it("does not re-read the window when the lookback is disabled", async () => {
    const base = 1_790_000_000;
    const repository = createRepository();
    repository.upsertTracks("listener", [track("Newest", base + 600)]);
    repository.markSync("listener", "full", true, base + 600, base + 600);
    const api = recentApi([track("Newest", base + 600), track("Late", base + 300)]);
    const sync = new HistorySyncService(api, repository, "listener", 1_000, 0);

    await sync.sync("incremental", 1_000);

    expect(repository.getStatus("listener")).toMatchObject({ indexedScrobbles: 1 });
  });

  it("resumes a dense lookback after restart without dropping a late play or moving coverage early", async () => {
    const base = 1_790_000_000;
    vi.spyOn(Date, "now").mockReturnValue((base + 600) * 1000);
    let repository = createRepository();
    const existing = Array.from({ length: 300 }, (_, i) => track(`Existing ${i}`, base - i * 60));
    repository.upsertTracks("listener", existing);
    repository.markSync("listener", "full", true, base, base);
    const api = recentApi([...existing, track("Late", base - 90)]);
    const first = await new HistorySyncService(api, repository, "listener", 200).sync("incremental", 200);
    expect(first).toMatchObject({ scannedTracks: 200, completedRequestedRange: false,
      status: { indexedScrobbles: 300, incrementalSyncInProgress: true, coveredThroughAt: new Date(base * 1000).toISOString() } });

    repository = reopenRepository(repository);
    vi.spyOn(Date, "now").mockReturnValue((base + 3600) * 1000);
    // Changing the setting does not abandon an unfinished lookback pass.
    const second = await new HistorySyncService(api, repository, "listener", 200, 0).sync("incremental", 200);
    expect(second).toMatchObject({ completedRequestedRange: true,
      status: { indexedScrobbles: 301, incrementalSyncInProgress: false, coveredThroughAt: new Date((base + 600) * 1000).toISOString() } });
    expect(second.scannedTracks).toBeLessThanOrEqual(200);
    expect(vi.mocked(api.getRecentTracksPage).mock.calls.every(([input]) => input.to === base + 600)).toBe(true);
  });

  it("finishes a capped backlog and catches a play arriving behind its cursor on the next lookback pass", async () => {
    const base = 1_790_000_000;
    vi.spyOn(Date, "now").mockReturnValue((base + 60_000) * 1000);
    const repository = createRepository();
    repository.upsertTracks("listener", [track("Boundary", base)]);
    repository.markSync("listener", "full", true, base, base);
    const allTracks = Array.from({ length: 451 }, (_, i) => track(`Play ${i}`, base + i * 60));
    const api = recentApi(allTracks);
    const sync = new HistorySyncService(api, repository, "listener", 200);
    const first = await sync.sync("incremental", 200);
    expect(first.completedRequestedRange).toBe(false);
    expect(first.status.newestScrobbleAt).toBe(new Date((base + 199 * 60) * 1000).toISOString());
    allTracks.push(track("Late during catch-up", base + 90));

    const results = [first];
    // Finish the fixed catch-up range, then reconcile it again to see the
    // arrival behind the previous cursor. All plays remain within 72 hours.
    for (let attempt = 0; attempt < 5; attempt++) results.push(await sync.sync("incremental", 200));
    expect(results.every(result => result.scannedTracks <= 200)).toBe(true);
    expect(results.filter(result => result.completedRequestedRange)).toHaveLength(2);
    expect(repository.getStatus("listener").indexedScrobbles).toBe(453);
  });

  it("preserves an empty-index incremental range when newer plays arrive between capped runs", async () => {
    const base = 1_790_000_000;
    vi.spyOn(Date, "now").mockReturnValue((base + 1000) * 1000);
    let repository = createRepository();
    const allTracks = Array.from({ length: 450 }, (_, i) => track(`Play ${i}`, base + i));
    const api = recentApi(allTracks);
    await new HistorySyncService(api, repository, "listener", 200).sync("incremental", 200);
    allTracks.push(track("After the original upper bound", base + 1500));
    repository = reopenRepository(repository);
    vi.spyOn(Date, "now").mockReturnValue((base + 2000) * 1000);
    const sync = new HistorySyncService(api, repository, "listener", 200);
    await sync.sync("incremental", 200);
    const completed = await sync.sync("incremental", 200);
    expect(completed).toMatchObject({ completedRequestedRange: true,
      status: { indexedScrobbles: 450, fullHistorySynced: false, coveredThroughAt: new Date((base + 1000) * 1000).toISOString() } });
    for (let attempt = 0; attempt < 3; attempt++) await sync.sync("incremental", 200);
    expect(repository.getStatus("listener").indexedScrobbles).toBe(451);
  });

  it("resumes after a page failure without skipping the unfinished middle even with a large budget", async () => {
    const base = 1_790_000_000;
    vi.spyOn(Date, "now").mockReturnValue((base + 1000) * 1000);
    let repository = createRepository();
    const allTracks = Array.from({ length: 450 }, (_, i) => track(`Play ${i}`, base + i));
    const api = recentApi(allTracks);
    const fetchPage = api.getRecentTracksPage;
    let fail = true;
    api.getRecentTracksPage = vi.fn(async (input) => {
      if (fail && input.page === 2) { fail = false; throw new Error("page failed"); }
      return fetchPage(input);
    });
    await expect(new HistorySyncService(api, repository, "listener", 1000).sync("incremental", 1000)).rejects.toThrow("page failed");
    expect(repository.getStatus("listener")).toMatchObject({ indexedScrobbles: 50, coveredThroughAt: null, incrementalSyncInProgress: true });
    repository = reopenRepository(repository);
    const completed = await new HistorySyncService(api, repository, "listener", 1000).sync("incremental", 1000);
    expect(completed).toMatchObject({ completedRequestedRange: true, status: { indexedScrobbles: 450, incrementalSyncInProgress: false } });
  });

  it.each([false, true])("advances through same-second ties with reordered results (exclusive from=%s)", async (exclusiveFrom) => {
    const base = 1_790_000_000;
    vi.spyOn(Date, "now").mockReturnValue((base + 600) * 1000);
    let repository = createRepository();
    const allTracks = Array.from({ length: 450 }, (_, i) => track(`Same second ${i}`, base));
    allTracks.push(track("Newer", base + 60));
    const api = recentApi(allTracks, exclusiveFrom);
    const sync = new HistorySyncService(api, repository, "listener", 200);
    const first = await sync.sync("incremental", 200);
    expect(first).toMatchObject({ scannedTracks: 200, completedRequestedRange: false });
    allTracks.reverse();
    repository = reopenRepository(repository);
    const resumed = new HistorySyncService(api, repository, "listener", 200);
    const second = await resumed.sync("incremental", 200);
    expect(second.completedRequestedRange).toBe(false);
    const third = await resumed.sync("incremental", 200);
    expect(third).toMatchObject({ completedRequestedRange: true, status: { indexedScrobbles: 451 } });
    expect([first, second, third].every(result => result.scannedTracks <= 200)).toBe(true);
  });
});

function reopenRepository(repository: HistoryRepository): HistoryRepository {
  const path = repository.path;
  repositories.splice(repositories.indexOf(repository), 1);
  repository.close();
  const reopened = new HistoryRepository(path);
  repositories.push(reopened);
  return reopened;
}

function createRepository(): HistoryRepository {
  const directory = mkdtempSync(join(tmpdir(), "lastfm-mcp-sync-"));
  const repository = new HistoryRepository(join(directory, "history.sqlite"));
  repositories.push(repository);
  return repository;
}

function track(name: string, playedAtUnix: number): RecentTrack {
  return {
    name,
    artist: "Artist",
    album: "Album",
    playedAtUnix,
    playedAt: new Date(playedAtUnix * 1_000).toISOString(),
    nowPlaying: false,
    loved: false,
    mbid: null,
    artistMbid: null,
    albumMbid: null,
    url: "https://last.fm/track",
  };
}

function recentApi(allTracks: RecentTrack[], exclusiveFrom = false): LastFmApi {
  return {
    getRecentTracksPage: vi.fn(async ({ from, to, page = 1, limit = 200 }) => {
      const matching = allTracks.filter((item) =>
        item.playedAtUnix !== null
        && (from === undefined || (exclusiveFrom ? item.playedAtUnix > from : item.playedAtUnix >= from))
        && (to === undefined || item.playedAtUnix <= to))
        .sort((a, b) => b.playedAtUnix! - a.playedAtUnix!);
      return {
        tracks: matching.slice((page - 1) * limit, page * limit),
        pageInfo: { page, perPage: limit, totalPages: Math.ceil(matching.length / limit), total: matching.length },
      };
    }),
  } as unknown as LastFmApi;
}
