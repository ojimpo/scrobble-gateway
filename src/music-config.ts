import * as z from "zod/v4";
import { dirname, join } from "node:path";

const optional = z.preprocess((v) => v === "" ? undefined : v, z.string().min(1).optional());
const bool = z.enum(["true", "false"]).transform((v) => v === "true");
const schema = z.object({
  SPOTIFY_CLIENT_ID: optional, SPOTIFY_CLIENT_SECRET: optional,
  SPOTIFY_REDIRECT_URI: z.url().default("http://127.0.0.1:8888/callback"),
  SPOTIFY_TOKEN_PATH: optional, LASTFM_API_SECRET: optional, LASTFM_SESSION_PATH: optional,
  MCP_ENABLE_SPOTIFY_TOOLS: bool.default(false),
  SPOTIFY_AUTO_SYNC_ENABLED: bool.default(true),
  SPOTIFY_AUTO_SYNC_INTERVAL_SECONDS: z.coerce.number().int().min(60).max(86400).default(3600),
});

export function loadMusicConfig(env: NodeJS.ProcessEnv, historyDbPath: string) {
  const p = schema.parse(env);
  if (Boolean(p.SPOTIFY_CLIENT_ID) !== Boolean(p.SPOTIFY_CLIENT_SECRET)) throw new Error("Set both SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET");
  if (p.MCP_ENABLE_SPOTIFY_TOOLS && !p.SPOTIFY_CLIENT_ID) throw new Error("MCP_ENABLE_SPOTIFY_TOOLS requires Spotify credentials");
  const dir = dirname(historyDbPath);
  return { spotifyClientId: p.SPOTIFY_CLIENT_ID, spotifyClientSecret: p.SPOTIFY_CLIENT_SECRET,
    spotifyRedirectUri: p.SPOTIFY_REDIRECT_URI, spotifyTokenPath: p.SPOTIFY_TOKEN_PATH ?? join(dir, "spotify-tokens.json"),
    lastfmApiSecret: p.LASTFM_API_SECRET, lastfmSessionPath: p.LASTFM_SESSION_PATH ?? join(dir, "lastfm-session.json"),
    toolsEnabled: p.MCP_ENABLE_SPOTIFY_TOOLS, autoSyncEnabled: Boolean(p.SPOTIFY_CLIENT_ID) && p.SPOTIFY_AUTO_SYNC_ENABLED,
    intervalMs: p.SPOTIFY_AUTO_SYNC_INTERVAL_SECONDS * 1000, statusPath: join(dir, "music-sync-status.json") };
}
