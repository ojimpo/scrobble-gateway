import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { RangeAnalytics } from "./range-analytics.js";
import { parseDateTime } from "./time.js";

const date = z.string().trim().min(1).describe(
  "Unix seconds, YYYY-MM-DD (a whole UTC day), or ISO 8601 with an offset such as 2026-10-01T00:00:00+09:00.",
);
const dimension = z.enum(["artist", "album", "track"]).default("artist");
const jsonObjectSchema = z.object({}).loose();
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function registerRangeTools(server: McpServer, analytics: RangeAnalytics, username: string): void {
  server.registerTool(
    "get_top_in_range",
    {
      title: "Rank artists, albums, or tracks in any date range",
      description:
        "Rank artists, albums, or tracks by play count between any two dates, from the local scrobble index. "
        + "Use this instead of get_top_* when the range is not one of Last.fm's fixed periods (e.g. a calendar month, a trip, a season). "
        + "Omitting from/to means all time. Dates without an offset are UTC days; pass +09:00 for Japan-local days.",
      inputSchema: z.object({
        from: date.optional(),
        to: date.optional(),
        dimension,
        limit: z.number().int().min(1).max(500).default(20),
      }),
      outputSchema: jsonObjectSchema,
      annotations: readOnly,
    },
    ({ from, to, dimension, limit }) => runTool(() =>
      analytics.getTop(username, range(from, to), dimension, limit)),
  );

  server.registerTool(
    "compare_ranges",
    {
      title: "Compare listening between any two date ranges",
      description:
        "Compare two arbitrary date ranges from the local scrobble index: what rose or fell in share of plays, what is new, and what dropped out. "
        + "Use this instead of compare_listening_periods when the ranges are not Last.fm's fixed periods (e.g. September vs August, this year vs last year). "
        + "Dates without an offset are UTC days; pass +09:00 for Japan-local days.",
      inputSchema: z.object({
        currentFrom: date,
        currentTo: date,
        previousFrom: date,
        previousTo: date,
        dimension,
        limit: z.number().int().min(1).max(100).default(10),
      }),
      outputSchema: jsonObjectSchema,
      annotations: readOnly,
    },
    ({ currentFrom, currentTo, previousFrom, previousTo, dimension, limit }) => runTool(() =>
      analytics.compare(username, range(currentFrom, currentTo), range(previousFrom, previousTo), dimension, limit)),
  );
}

function range(from: string | undefined, to: string | undefined) {
  // parseDateTime treats a bare YYYY-MM-DD as the end of that day only when the field is named "to".
  const parsedFrom = from === undefined ? undefined : parseDateTime(from, "from");
  const parsedTo = to === undefined ? undefined : parseDateTime(to, "to");
  return {
    ...(parsedFrom === undefined ? {} : { from: parsedFrom }),
    ...(parsedTo === undefined ? {} : { to: parsedTo }),
  };
}

async function runTool(operation: () => object) {
  try {
    const structuredContent = { ...operation() };
    return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }], structuredContent };
  } catch (error) {
    return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Unknown range analytics error" }], isError: true };
  }
}
