import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { RecentTrack } from "../src/domain.js";
import { HistoryRepository } from "../src/history-repository.js";
import type { IntelligenceService } from "../src/intelligence-service.js";
import type { ListeningService } from "../src/listening-service.js";
import { createLastFmMcpServer } from "../src/mcp-server.js";
import { RangeAnalytics } from "../src/range-analytics.js";

const DAY = 86_400;
const SEP = Date.UTC(2026, 8, 1) / 1_000;
const AUG = Date.UTC(2026, 7, 1) / 1_000;
const closers: Array<{ close(): void }> = [];
afterEach(() => {
  for (const item of closers.splice(0)) item.close();
});

describe("RangeAnalytics", () => {
  it("ranks tracks inside an arbitrary range and ignores plays outside it", () => {
    const analytics = seed([
      play("Spitz", "魚", SEP + DAY),
      play("Spitz", "魚", SEP + 2 * DAY),
      play("spitz", "魚", SEP + 3 * DAY), // spelling variant of the same artist
      play("Oma", "Battlecry - Live", SEP + DAY),
      play("Spitz", "魚", AUG + DAY), // outside
    ]);

    const top = analytics.getTop("listener", { from: SEP, to: SEP + 30 * DAY - 1 }, "track", 10);

    expect(top).toMatchObject({ totalPlays: 4, distinctEntities: 2 });
    expect(top.items[0]).toMatchObject({ rank: 1, track: "魚", plays: 3, share: 0.75 });
    expect(top.items[1]).toMatchObject({ rank: 2, track: "Battlecry - Live", plays: 1 });
  });

  it("compares two ranges by share and lists new and dropped entities", () => {
    const analytics = seed([
      play("Spitz", "a", AUG + DAY), play("Spitz", "b", AUG + DAY + 1), play("Oasis", "c", AUG + DAY + 2), play("Old", "d", AUG + DAY + 3),
      play("Spitz", "a", SEP + DAY), play("Oasis", "c", SEP + DAY + 1), play("Oasis", "c", SEP + DAY + 2), play("Newcomer", "e", SEP + DAY + 3),
    ]);

    const result = analytics.compare(
      "listener",
      { from: SEP, to: SEP + 30 * DAY - 1 },
      { from: AUG, to: AUG + 31 * DAY - 1 },
      "artist",
      10,
    );

    expect(result.current.totalPlays).toBe(4);
    expect(result.previous.totalPlays).toBe(4);
    expect(result.rising.map((item) => item.artist)).toEqual(["Oasis"]);
    expect(result.rising[0]).toMatchObject({ currentShare: 0.5, previousShare: 0.25, shareChange: 0.25 });
    expect(result.falling.map((item) => item.artist)).toEqual(["Spitz"]);
    expect(result.new.map((item) => item.artist)).toEqual(["Newcomer"]);
    expect(result.dropped.map((item) => item.artist)).toEqual(["Old"]);
  });

  it("rejects an inverted range", () => {
    const analytics = seed([]);
    expect(() => analytics.getTop("listener", { from: SEP, to: AUG }, "artist", 10)).toThrow(/from must be/);
  });

  it("exposes the tools over MCP and treats a bare to-date as the end of that day", async () => {
    const analytics = seed([play("Spitz", "魚", SEP + DAY - 1), play("Spitz", "魚", SEP + DAY)]);
    const handler = createMcpHandler(() => createLastFmMcpServer(
      {} as ListeningService,
      {} as IntelligenceService,
      undefined,
      { analytics, username: "listener" },
    ));
    const response = await handler.fetch(new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_top_in_range", arguments: { from: "2026-09-01", to: "2026-09-01", dimension: "track" } },
      }),
    }));
    const raw = await response.text();
    const json = raw.startsWith("event:") ? raw.split("\n").find((line) => line.startsWith("data: "))?.slice(6) : raw;
    const payload = JSON.parse(json ?? "{}") as { result: { structuredContent: { totalPlays: number } } };

    expect(payload.result.structuredContent.totalPlays).toBe(1);
  });
});

function seed(tracks: RecentTrack[]): RangeAnalytics {
  const directory = mkdtempSync(join(tmpdir(), "range-analytics-"));
  const path = join(directory, "history.sqlite");
  const history = new HistoryRepository(path);
  history.upsertTracks("listener", tracks);
  history.close();
  const analytics = new RangeAnalytics(path);
  closers.push(analytics);
  return analytics;
}

function play(artist: string, name: string, playedAtUnix: number): RecentTrack {
  return {
    name,
    artist,
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
