import { createMcpHandler } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { createLastFmMcpServer } from "../src/mcp-server.js";
import type { ListeningService } from "../src/listening-service.js";
import type { IntelligenceService } from "../src/intelligence-service.js";
import { loadConfig } from "../src/config.js";
import { createMusicRuntime } from "../src/music-runtime.js";

async function request(method: string, params: object = {}, enabled = true) {
  const config = loadConfig({ LASTFM_API_KEY: "key", LASTFM_USERNAME: "listener", MCP_HOST: "127.0.0.1" });
  const runtime = createMusicRuntime(config, { SPOTIFY_CLIENT_ID: "id", SPOTIFY_CLIENT_SECRET: "secret", SPOTIFY_AUTO_SYNC_ENABLED: "false", MCP_ENABLE_SPOTIFY_TOOLS: String(enabled) });
  const handler = createMcpHandler(() => createLastFmMcpServer({} as ListeningService, {} as IntelligenceService, runtime));
  try {
    const response = await handler.fetch(new Request("http://localhost/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }));
    const raw = await response.text();
    return JSON.parse(raw.startsWith("event:") ? raw.split("\n").find((l) => l.startsWith("data: "))!.slice(6) : raw) as {
      result: { tools: { name: string; annotations: { readOnlyHint: boolean } }[]; structuredContent: { dryRun: boolean }; isError?: boolean; content: { text: string }[] } };
  } finally { await handler.close(); }
}
describe("music MCP tools", () => {
  it("advertises the full optional surface and preserves existing tools", async () => {
    const result = await request("tools/list");
    expect(result.result.tools).toHaveLength(43);
    expect(result.result.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["spotify_get_liked_tracks", "spotify_get_recent_tracks", "spotify_get_top_tracks", "spotify_get_top_artists",
      "spotify_get_playlists", "spotify_search_track", "spotify_create_playlist", "spotify_add_tracks_to_playlist", "create_spotify_playlist_from_tracks", "sync_spotify_likes_to_lastfm", "sync_lastfm_loves_to_spotify", "compare_spotify_lastfm_library", "get_music_sync_status"]));
    expect(result.result.tools.find((t) => t.name === "sync_spotify_likes_to_lastfm")?.annotations.readOnlyHint).toBe(false);
    expect((await request("tools/list", {}, false)).result.tools).toHaveLength(30);
  });
  it("defaults playlist operations to dry-run and rejects disabled real writes", async () => {
    const result = await request("tools/call", { name: "create_spotify_playlist_from_tracks", arguments: { name: "Example", tracks: ["a".repeat(22)] } });
    expect(result.result.structuredContent.dryRun).toBe(true);
    const denied = await request("tools/call", { name: "sync_spotify_likes_to_lastfm", arguments: { dryRun: false } });
    expect(denied.result.isError).toBe(true);
    expect(denied.result.content[0]?.text).toContain("disabled");
  });
});
