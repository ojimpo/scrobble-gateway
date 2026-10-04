import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { FEEDBACK_VERDICTS, TASTE_DIMENSIONS } from "./intelligence-repository.js";
import { EXPOSURE_LEVELS, RECOMMENDATION_MODES, type IntelligenceService } from "./intelligence-service.js";
import { parseDateTime } from "./time.js";

const jsonObjectSchema = z.object({}).loose();
const name = z.string().trim().min(1);
const targetSchema = z.object({ artist: name.optional(), album: name.optional(), track: name.optional() });
const dimensionsShape = Object.fromEntries(
  TASTE_DIMENSIONS.map((dimension) => [dimension, z.number().min(-5).max(5).optional()]),
) as Record<(typeof TASTE_DIMENSIONS)[number], z.ZodOptional<z.ZodNumber>>;

export function registerIntelligenceTools(server: McpServer, service: IntelligenceService): void {
  server.registerTool(
    "resolve_canonical_entities",
    {
      title: "Resolve canonical music entities",
      description: "Resolve deterministic canonical artist, album, and track identities plus aliases and synced MBIDs.",
      inputSchema: z.object({ artist: name.optional(), album: name.optional(), track: name.optional() }),
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (input) => runTool(() => Promise.resolve(service.canonicalize(cleanTarget(input)))),
  );

  server.registerTool(
    "check_listening_exposure",
    {
      title: "Check prior listening exposure",
      description: "Quickly check whether artists, albums, or tracks are unheard, sampled, explored, established, or favorites in the complete local scrobble index.",
      inputSchema: z.object({
        artists: z.array(name).max(100).optional(),
        albums: z.array(z.object({ artist: name, album: name })).max(100).optional(),
        tracks: z.array(z.object({ artist: name, track: name })).max(100).optional(),
      }),
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ artists, albums, tracks }) => runTool(() => Promise.resolve(service.checkListeningExposure({
      ...(artists === undefined ? {} : { artists }),
      ...(albums === undefined ? {} : { albums }),
      ...(tracks === undefined ? {} : { tracks }),
    }))),
  );

  server.registerTool(
    "get_artist_affinity",
    {
      title: "Measure artist affinity",
      description: "Measure play depth, active days/months, repeated sessions, long-term returns, concentration, and an explainable affinity score from local history.",
      inputSchema: z.object({ artist: name }),
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ artist }) => runTool(() => Promise.resolve(service.getArtistAffinity(artist))),
  );

  server.registerTool(
    "get_listening_sessions",
    {
      title: "Get listening sessions",
      description: "Group scrobbles into sessions to reveal album runs, repeats, artist co-listening, and natural transitions.",
      inputSchema: z.object({
        from: date.optional(),
        to: date.optional(),
        artist: name.optional(),
        gapMinutes: z.number().int().min(5).max(240).default(45),
        limit: z.number().int().min(1).max(1_000).default(100),
      }),
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ from, to, artist, gapMinutes, limit }) => runTool(() => Promise.resolve(service.getListeningSessions({
      ...(from === undefined ? {} : { from: parseDateTime(from, "from") }),
      ...(to === undefined ? {} : { to: parseDateTime(to, "to") }),
      ...(artist === undefined ? {} : { artist }),
      gapMinutes,
      limit,
    }))),
  );

  server.registerTool(
    "get_album_exposure",
    {
      title: "Analyze album exposure",
      description: "Analyze album track coverage, ordered/full/near-full runs, stopping points, and later returns using an ordered MusicBrainz tracklist when available.",
      inputSchema: z.object({ artist: name, album: name }),
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ artist, album }) => runTool(() => service.getAlbumExposure(artist, album)),
  );

  server.registerTool(
    "get_listening_timeline",
    {
      title: "Build arbitrary listening timeline",
      description: "Aggregate local history into exact UTC day, week, month, or year buckets by artist, album, or Last.fm tag.",
      inputSchema: z.object({
        from: date.optional(),
        to: date.optional(),
        bucket: z.enum(["day", "week", "month", "year"]).default("month"),
        dimension: z.enum(["artist", "album", "tag"]).default("artist"),
        limitPerBucket: z.number().int().min(1).max(100).default(20),
      }),
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ from, to, bucket, dimension, limitPerBucket }) => runTool(() => service.getListeningTimeline({
      ...(from === undefined ? {} : { from: parseDateTime(from, "from") }),
      ...(to === undefined ? {} : { to: parseDateTime(to, "to") }),
      bucket,
      dimension,
      limitPerBucket,
    })),
  );

  server.registerTool(
    "get_listening_matrix",
    {
      title: "Build listening matrix",
      description: "Build a statistically consistent, pageable sparse time-bucket by artist or album matrix over any local-history range, with global window totals, active-day evidence, burst/concentration metrics, empty buckets, and explicit filtering coverage. Follow nextEntityOffset until null for every eligible entity.",
      inputSchema: z.object({
        from: date.optional(),
        to: date.optional(),
        bucket: z.enum(["day", "week", "month", "year"]).default("month"),
        dimension: z.enum(["artist", "album"]).default("artist"),
        minPlays: z.number().int().min(1).max(1_000_000).default(1),
        entityOffset: z.number().int().min(0).max(1_000_000).default(0),
        limitEntities: z.number().int().min(1).max(5_000).default(250),
        includeEmptyBuckets: z.boolean().default(true),
        maxCells: z.number().int().min(1).max(500_000).default(100_000),
      }),
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ from, to, bucket, dimension, minPlays, entityOffset, limitEntities, includeEmptyBuckets, maxCells }) => runMatrixTool(() => Promise.resolve(service.getListeningMatrix({
      ...(from === undefined ? {} : { from: parseDateTime(from, "from") }),
      ...(to === undefined ? {} : { to: parseDateTime(to, "to") }),
      bucket,
      dimension,
      minPlays,
      entityOffset,
      limitEntities,
      includeEmptyBuckets,
      maxCells,
    }))),
  );

  server.registerTool(
    "detect_listening_eras",
    {
      title: "Detect listening eras",
      description: "Detect statistically supported changes in monthly artist distributions and preserve real listening hiatuses.",
      inputSchema: z.object({
        minDurationDays: z.number().int().min(30).max(2_000).default(60),
        maxEras: z.number().int().min(1).max(50).default(12),
      }),
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (input) => runTool(() => Promise.resolve(service.detectListeningEras(input))),
  );

  server.registerTool(
    "get_artist_features",
    {
      title: "Get multi-source artist features",
      description: "Combine Last.fm tags/similarity with MusicBrainz genres, active years, country, members, and relationships. Does not fabricate audio features.",
      inputSchema: z.object({ artist: name }),
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ artist }) => runTool(() => service.getArtistFeatures(artist)),
  );

  server.registerTool(
    "build_taste_graph",
    {
      title: "Build personal taste graph",
      description: "Build an evidence graph across artists, albums, tags, listening sessions, detected eras, external similarities, and explicit preference dimensions.",
      inputSchema: z.object({}),
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    () => runTool(() => service.buildTasteGraph()),
  );

  server.registerTool(
    "record_music_feedback",
    {
      title: "Record explicit music feedback",
      description: "Persist a structured verdict for an artist, album, or track. Use not_now to distinguish timing from dislike.",
      inputSchema: z.object({
        artist: name.optional(),
        album: name.optional(),
        track: name.optional(),
        rating: z.number().min(0).max(10).optional(),
        verdict: z.enum(FEEDBACK_VERDICTS),
        notes: z.string().trim().max(4_000).optional(),
      }),
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ artist, album, track, rating, verdict, notes }) => runTool(() => Promise.resolve(service.recordMusicFeedback({
      ...cleanTarget({ artist, album, track }),
      ...(rating === undefined ? {} : { rating }),
      verdict,
      ...(notes === undefined ? {} : { notes }),
    }))),
  );

  server.registerTool(
    "record_preference_signal",
    {
      title: "Record why music works or fails",
      description: "Persist -5..5 signals for atmosphere, rhythm, groove, melody, emotional arc, structure, production, vocals, heaviness, and lyrics.",
      inputSchema: z.object({
        target: targetSchema,
        dimensions: z.object(dimensionsShape),
        notes: z.string().trim().max(4_000).optional(),
      }),
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ target, dimensions, notes }) => runTool(() => Promise.resolve(service.recordPreferenceSignal({
      target: cleanTarget(target),
      dimensions: Object.fromEntries(Object.entries(dimensions).filter(([, value]) => value !== undefined)),
      ...(notes === undefined ? {} : { notes }),
    }))),
  );

  server.registerTool(
    "get_feedback_context",
    {
      title: "Get explicit preference context",
      description: "Return structured feedback, taste-dimension signals, aggregate dimension evidence, and active recommendation exclusions.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(1_000).default(200) }),
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ limit }) => runTool(() => Promise.resolve(service.getFeedbackContext(limit))),
  );

  server.registerTool(
    "get_recommendations",
    {
      title: "Get personal music recommendations",
      description: "Generate safe, bridge, or explore candidates, filter prior exposure/feedback/exclusions, explain evidence and risks, suggest starting points, and record each recommendation for evaluation.",
      inputSchema: z.object({
        count: z.number().int().min(1).max(50).default(20),
        mode: z.enum(RECOMMENDATION_MODES).default("safe"),
        excludeExposureAbove: z.enum(EXPOSURE_LEVELS).default("sampled"),
        targetEra: z.literal("current").optional(),
        explain: z.boolean().default(true),
      }),
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ count, mode, excludeExposureAbove, targetEra, explain }) => runTool(() => service.getRecommendations({
      count,
      mode,
      excludeExposureAbove,
      ...(targetEra === undefined ? {} : { targetEra }),
      explain,
    })),
  );

  server.registerTool(
    "exclude_recommendation",
    {
      title: "Exclude an artist from recommendations",
      description: "Persist a never, six-month, or new-releases-only recommendation exclusion with an explicit reason.",
      inputSchema: z.object({
        artist: name,
        reason: z.string().trim().min(1).max(2_000),
        policy: z.enum(["never", "six_months", "new_releases_only"]).default("never"),
        expiresAt: date.nullable().optional(),
      }),
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ artist, reason, policy, expiresAt }) => runTool(() => Promise.resolve(service.excludeRecommendation({
      artist,
      reason,
      policy,
      ...(expiresAt === undefined ? {} : { expiresAt: expiresAt === null ? null : parseDateTime(expiresAt, "expiresAt") }),
    }))),
  );

  server.registerTool(
    "list_recommendation_exclusions",
    {
      title: "List active recommendation exclusions",
      description: "List active recommendation exclusions and their expiration/policy.",
      inputSchema: z.object({}),
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    () => runTool(() => Promise.resolve(service.listRecommendationExclusions())),
  );

  server.registerTool(
    "record_recommendation",
    {
      title: "Record an external recommendation",
      description: "Record a recommendation event and its baseline exposure so future scrobbles can be evaluated.",
      inputSchema: z.object({
        artist: name,
        recommendedAt: date.optional(),
        reason: z.string().trim().min(1).max(4_000),
        recommendationId: z.string().trim().min(1).max(200).optional(),
        mode: z.enum([...RECOMMENDATION_MODES, "manual"]).default("manual"),
      }),
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ artist, recommendedAt, reason, recommendationId, mode }) => runTool(() => Promise.resolve(service.recordRecommendation({
      artist,
      reason,
      mode,
      ...(recommendedAt === undefined ? {} : { recommendedAt: parseDateTime(recommendedAt, "recommendedAt") }),
      ...(recommendationId === undefined ? {} : { recommendationId }),
    }))),
  );

  server.registerTool(
    "evaluate_recommendations",
    {
      title: "Evaluate recommendation outcomes",
      description: "Measure whether recommendation recipients were untried, sampled, engaged, or revisited using post-recommendation scrobbles.",
      inputSchema: z.object({ since: date.optional() }),
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ since }) => runTool(() => Promise.resolve(service.evaluateRecommendations(since === undefined ? undefined : parseDateTime(since, "since")))),
  );
}

const date = z.string().trim().min(1).describe("Unix seconds, YYYY-MM-DD in UTC, or ISO 8601 with Z/UTC offset.");

async function runTool(operation: () => Promise<unknown>) {
  try {
    const output = await operation();
    const structuredContent = isObject(output) ? output : { value: output };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    };
  } catch (error) {
    return {
      content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Unknown error" }],
      isError: true,
    };
  }
}

async function runMatrixTool(operation: () => Promise<unknown>) {
  try {
    const output = await operation();
    const structuredContent = isObject(output) ? output : { value: output };
    const matrix = isObject(structuredContent.matrix) ? structuredContent.matrix : {};
    const filtering = isObject(structuredContent.filtering) ? structuredContent.filtering : {};
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          message: "The complete listening-matrix page is available in structuredContent.",
          matrix: { format: matrix.format, dimensions: matrix.dimensions },
          filtering,
        }),
      }],
      structuredContent,
    };
  } catch (error) {
    return {
      content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Unknown error" }],
      isError: true,
    };
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cleanTarget(input: { artist?: string | undefined; album?: string | undefined; track?: string | undefined }) {
  return {
    ...(input.artist === undefined ? {} : { artist: input.artist }),
    ...(input.album === undefined ? {} : { album: input.album }),
    ...(input.track === undefined ? {} : { track: input.track }),
  };
}
