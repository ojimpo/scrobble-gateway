import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RecentTrack } from "../src/domain.js";
import { HistoryRepository } from "../src/history-repository.js";
import { createInternalApi } from "../src/internal-api.js";
import { RangeAnalytics } from "../src/range-analytics.js";

const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

describe("internal API", () => {
  it("returns plays per UTC day, with an inclusive range and the sync status", async () => {
    const day = Date.UTC(2026, 8, 30) / 1_000;
    const base = await start([
      play(day - 1), // 2026-09-29 23:59:59 UTC
      play(day), play(day + 3_600), // 2026-09-30
      play(day + 86_399), // last second of 2026-09-30
      play(day + 86_400), // 2026-10-01
    ]);

    const body = await (await fetch(`${base}/daily-plays?from=2026-09-30&to=2026-09-30`)).json();
    expect(body).toMatchObject({ timezone: "UTC", days: [{ date: "2026-09-30", plays: 3 }], newestScrobbleAt: "2026-10-01T00:00:00.000Z" });

    const all = await (await fetch(`${base}/daily-plays`)).json() as { days: unknown[] };
    expect(all.days).toEqual([
      { date: "2026-09-29", plays: 1 },
      { date: "2026-09-30", plays: 3 },
      { date: "2026-10-01", plays: 1 },
    ]);
  });

  it("rejects a malformed date with 400", async () => {
    const base = await start([]);
    const response = await fetch(`${base}/daily-plays?from=2026-9-1`);
    expect(response.status).toBe(400);
  });
});

async function start(tracks: RecentTrack[]): Promise<string> {
  const path = join(mkdtempSync(join(tmpdir(), "internal-api-")), "history.sqlite");
  const history = new HistoryRepository(path);
  history.upsertTracks("listener", tracks);
  const analytics = new RangeAnalytics(path);
  const server: Server = createServer(createInternalApi(analytics, "listener", () => history.getStatus("listener")));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => {
    server.close();
    analytics.close();
    history.close();
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function play(playedAtUnix: number): RecentTrack {
  return {
    name: `Track ${playedAtUnix}`,
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
