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
    for (let attempt = 0; attempt < 4; attempt += 1) results.push(await sync.sync("incremental", 2));

    expect(repository.getStatus("listener")).toMatchObject({ indexedScrobbles: 5, fullHistorySynced: true });
    expect(results.slice(0, 3).every((result) => !result.completedRequestedRange)).toBe(true);
    expect(results[3]?.completedRequestedRange).toBe(true);
    expect(results[2]?.status.coveredThroughAt).toBe(new Date(100 * 1000).toISOString());
    expect(results[3]?.status.coveredThroughAt).not.toBe(new Date(100 * 1000).toISOString());
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
      from: base + 600 - DEFAULT_INCREMENTAL_LOOKBACK_SECONDS,
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
});

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

function recentApi(allTracks: RecentTrack[]): LastFmApi {
  return {
    getRecentTracksPage: vi.fn(async ({ from, to, page = 1 }) => {
      const matching = allTracks.filter((item) =>
        item.playedAtUnix !== null
        && (from === undefined || item.playedAtUnix >= from)
        && (to === undefined || item.playedAtUnix <= to));
      return {
        tracks: page === 1 ? matching : [],
        pageInfo: { page, perPage: matching.length, totalPages: matching.length === 0 ? 0 : 1, total: matching.length },
      };
    }),
  } as unknown as LastFmApi;
}
