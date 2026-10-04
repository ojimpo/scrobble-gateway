import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { LASTFM_PERIODS } from "./domain.js";
import type { IntelligenceService } from "./intelligence-service.js";
import type { ListeningService } from "./listening-service.js";
import { registerIntelligenceTools } from "./register-intelligence-tools.js";
import { parseDateTime } from "./time.js";
import { registerMusicTools } from "./register-music-tools.js";
import type { MusicRuntime } from "./music-runtime.js";
import type { RangeAnalytics } from "./range-analytics.js";
import { registerRangeTools } from "./register-range-tools.js";

const periodSchema = z.enum(LASTFM_PERIODS).describe("Last.fm chart period.");
const topLimitSchema = z.number().int().min(1).max(1_000).default(100);
const jsonObjectSchema = z.object({}).loose();

export function createLastFmMcpServer(
  service: ListeningService,
  intelligence: IntelligenceService,
  music?: MusicRuntime,
  range?: { analytics: RangeAnalytics; username: string },
): McpServer {
  const server = new McpServer({ name: "lastfm-taste", version: "0.3.0" });

  server.registerTool(
    "get_user_profile",
    {
      title: "Get Last.fm profile",
      description: "Get the configured user's public Last.fm account totals and registration metadata.",
      inputSchema: z.object({}),
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    () => runTool(async () => ({ profile: await service.getUserProfile() })),
  );

  server.registerTool(
    "get_listening_summary",
    {
      title: "Get listening summary",
      description:
        "Summarize scrobbles, top artists, tracks, albums, and current/recent activity for one standard Last.fm period. Start here for a compact overview.",
      inputSchema: z.object({ period: periodSchema.default("overall") }),
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ period }) => runTool(() => service.getListeningSummary(period)),
  );

  server.registerTool(
    "get_top_artists",
    {
      title: "Get top artists",
      description: "Return the configured user's ranked Last.fm artists and play counts for a standard chart period.",
      inputSchema: z.object({ period: periodSchema.default("overall"), limit: topLimitSchema }),
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ period, limit }) => runTool(() => service.getTopArtists(period, limit)),
  );

  server.registerTool(
    "get_top_tracks",
    {
      title: "Get top tracks",
      description: "Return the configured user's ranked Last.fm tracks and play counts for a standard chart period.",
      inputSchema: z.object({ period: periodSchema.default("overall"), limit: topLimitSchema }),
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ period, limit }) => runTool(() => service.getTopTracks(period, limit)),
  );

  server.registerTool(
    "get_top_albums",
    {
      title: "Get top albums",
      description: "Return the configured user's ranked Last.fm albums and play counts; useful for album-oriented taste analysis.",
      inputSchema: z.object({ period: periodSchema.default("overall"), limit: topLimitSchema }),
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ period, limit }) => runTool(() => service.getTopAlbums(period, limit)),
  );

  server.registerTool(
    "get_recent_tracks",
    {
      title: "Get recent tracks",
      description: "Get recent scrobbles newest-first, optionally constrained to an exact UTC time window.",
      inputSchema: z.object({
        from: dateSchema("Inclusive lower bound"),
        to: dateSchema("Inclusive upper bound"),
        limit: z.number().int().min(1).max(1_000).default(100),
      }),
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ from, to, limit }) =>
      runTool(() => service.getRecentTracks({
        ...(from === undefined ? {} : { from: parseDateTime(from, "from") }),
        ...(to === undefined ? {} : { to: parseDateTime(to, "to") }),
        limit,
      })),
  );

  server.registerTool(
    "search_listening_history",
    {
      title: "Search listening history",
      description:
        "Search scrobbles by artist, album, and/or track. Uses the persistent index when available; otherwise performs a bounded newest-first Last.fm scan and reports completeness.",
      inputSchema: z.object({
        artist: z.string().trim().min(1).optional().describe("Artist name or substring."),
        album: z.string().trim().min(1).optional().describe("Album name or substring."),
        track: z.string().trim().min(1).optional().describe("Track name or substring."),
        from: dateSchema("Inclusive lower bound"),
        to: dateSchema("Inclusive upper bound"),
        exactMatch: z.boolean().default(false).describe("Match normalized names exactly instead of by substring."),
        limit: z.number().int().min(1).max(500).default(100),
        scanLimit: z.number().int().min(200).max(50_000).optional().describe("Maximum live scrobbles to scan when no local index exists."),
      }),
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ artist, album, track, from, to, exactMatch, limit, scanLimit }) =>
      runTool(() => service.searchListeningHistory({
        ...(artist === undefined ? {} : { artist }),
        ...(album === undefined ? {} : { album }),
        ...(track === undefined ? {} : { track }),
        ...(from === undefined ? {} : { from: parseDateTime(from, "from") }),
        ...(to === undefined ? {} : { to: parseDateTime(to, "to") }),
        exactMatch,
        limit,
        ...(scanLimit === undefined ? {} : { scanLimit }),
      })),
  );

  server.registerTool(
    "get_history_status",
    {
      title: "Get history index status",
      description: "Report local SQLite history coverage and whether a complete backfill has been confirmed.",
      inputSchema: z.object({}),
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    () => runTool(async () => service.getHistoryStatus()),
  );

  server.registerTool(
    "sync_listening_history",
    {
      title: "Sync listening history",
      description:
        "Populate the local scrobble index. Use full once for an exact backfill, then incremental to fetch only newer plays. The operation may take minutes for large libraries.",
      inputSchema: z.object({
        mode: z.enum(["incremental", "full"]).default("incremental"),
        maxTracks: z.number().int().min(200).max(2_000_000).default(50_000),
      }),
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ mode, maxTracks }) => runTool(() => service.syncHistory(mode, maxTracks)),
  );

  server.registerTool(
    "compare_listening_periods",
    {
      title: "Compare listening periods",
      description:
        "Compare artist and track prominence between two standard Last.fm chart periods using normalized play shares.",
      inputSchema: z.object({
        periodA: periodSchema,
        periodB: periodSchema,
        limit: z.number().int().min(1).max(100).default(25),
      }),
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ periodA, periodB, limit }) => runTool(() => service.comparePeriods(periodA, periodB, limit)),
  );

  server.registerTool(
    "get_taste_profile",
    {
      title: "Build taste profile",
      description:
        "Build an evidence-backed music taste profile with core artists, favorite tracks/albums, discoveries, forgotten favorites, trends, repeat concentration, and album orientation. Includes confidence and methodology.",
      inputSchema: z.object({}),
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    () => runTool(() => service.getTasteProfile()),
  );

  server.registerTool(
    "get_artist_context",
    {
      title: "Get artist context",
      description:
        "Get Last.fm context for an artist: global and user play counts, tags, similar artists, and a short Last.fm bio summary.",
      inputSchema: z.object({
        artist: z.string().trim().min(1),
        autocorrect: z.boolean().default(true),
      }),
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ artist, autocorrect }) => runTool(() => service.getArtistContext(artist, autocorrect)),
  );

  registerIntelligenceTools(server, intelligence);
  if (music) registerMusicTools(server, music);
  if (range) registerRangeTools(server, range.analytics, range.username);

  return server;
}

function dateSchema(description: string) {
  return z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(`${description}: Unix seconds, YYYY-MM-DD in UTC, or ISO 8601 including Z/UTC offset.`);
}

async function runTool(operation: () => Promise<unknown>) {
  try {
    const output = await operation();
    const structuredContent = isObject(output) ? output : { value: output };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      content: [{ type: "text" as const, text: message }],
      isError: true,
    };
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
