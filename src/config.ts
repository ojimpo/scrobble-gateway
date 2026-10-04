import "dotenv/config";
import * as z from "zod/v4";

const optionalString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().optional(),
);

const envSchema = z.object({
  LASTFM_API_KEY: z.string().trim().min(1, "LASTFM_API_KEY is required"),
  LASTFM_USERNAME: z.string().trim().min(1, "LASTFM_USERNAME is required"),
  LASTFM_API_BASE_URL: z.url().default("https://ws.audioscrobbler.com/2.0/"),
  LASTFM_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(10_000),
  LASTFM_MAX_RETRIES: z.coerce.number().int().min(0).max(8).default(3),
  LASTFM_MIN_REQUEST_INTERVAL_MS: z.coerce.number().int().min(0).max(10_000).default(250),
  LASTFM_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).max(86_400).default(300),
  MUSICBRAINZ_BASE_URL: z.url().default("https://musicbrainz.org/ws/2/"),
  MUSICBRAINZ_USER_AGENT: z.string().trim().min(1).default("lastfm-mcp/0.3.0 (https://lastfm.mcp.sptm.online/)"),
  MUSICBRAINZ_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(10_000),
  MUSICBRAINZ_MAX_RETRIES: z.coerce.number().int().min(0).max(8).default(2),
  MUSICBRAINZ_MIN_REQUEST_INTERVAL_MS: z.coerce.number().int().min(1_000).max(30_000).default(1_100),
  MCP_HOST: z.string().trim().min(1).default("0.0.0.0"),
  MCP_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  MCP_ALLOWED_HOSTS: optionalString,
  MCP_ENABLE_MUTATIONS: z.string().trim().toLowerCase().pipe(z.enum(["true", "false"])).transform((value) => value === "true").default(false),
  HISTORY_DB_PATH: z.string().trim().min(1).default("./data/lastfm.sqlite"),
  HISTORY_LIVE_SCAN_LIMIT: z.coerce.number().int().min(200).max(50_000).default(5_000),
  HISTORY_MAX_SYNC_TRACKS: z.coerce.number().int().min(200).max(2_000_000).default(250_000),
});

export type AppConfig = {
  lastfmApiKey: string;
  lastfmUsername: string;
  lastfmApiBaseUrl: string;
  lastfmTimeoutMs: number;
  lastfmMaxRetries: number;
  lastfmMinRequestIntervalMs: number;
  lastfmCacheTtlMs: number;
  musicbrainzBaseUrl: string;
  musicbrainzUserAgent: string;
  musicbrainzTimeoutMs: number;
  musicbrainzMaxRetries: number;
  musicbrainzMinRequestIntervalMs: number;
  host: string;
  port: number;
  allowedHosts: string[];
  mutationsEnabled: boolean;
  historyDbPath: string;
  historyLiveScanLimit: number;
  historyMaxSyncTracks: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  const allowedHosts = parseCsv(parsed.MCP_ALLOWED_HOSTS);

  if (parsed.MCP_HOST === "0.0.0.0" && allowedHosts.length === 0) {
    throw new Error("MCP_ALLOWED_HOSTS is required when MCP_HOST=0.0.0.0");
  }

  return {
    lastfmApiKey: parsed.LASTFM_API_KEY,
    lastfmUsername: parsed.LASTFM_USERNAME,
    lastfmApiBaseUrl: parsed.LASTFM_API_BASE_URL,
    lastfmTimeoutMs: parsed.LASTFM_TIMEOUT_MS,
    lastfmMaxRetries: parsed.LASTFM_MAX_RETRIES,
    lastfmMinRequestIntervalMs: parsed.LASTFM_MIN_REQUEST_INTERVAL_MS,
    lastfmCacheTtlMs: parsed.LASTFM_CACHE_TTL_SECONDS * 1_000,
    musicbrainzBaseUrl: parsed.MUSICBRAINZ_BASE_URL,
    musicbrainzUserAgent: parsed.MUSICBRAINZ_USER_AGENT,
    musicbrainzTimeoutMs: parsed.MUSICBRAINZ_TIMEOUT_MS,
    musicbrainzMaxRetries: parsed.MUSICBRAINZ_MAX_RETRIES,
    musicbrainzMinRequestIntervalMs: parsed.MUSICBRAINZ_MIN_REQUEST_INTERVAL_MS,
    host: parsed.MCP_HOST,
    port: parsed.MCP_PORT,
    allowedHosts,
    mutationsEnabled: parsed.MCP_ENABLE_MUTATIONS,
    historyDbPath: parsed.HISTORY_DB_PATH,
    historyLiveScanLimit: parsed.HISTORY_LIVE_SCAN_LIMIT,
    historyMaxSyncTracks: parsed.HISTORY_MAX_SYNC_TRACKS,
  };
}

function parseCsv(value: string | undefined): string[] {
  return [
    ...new Set(
      value
        ?.split(",")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean) ?? [],
    ),
  ];
}
