import * as z from "zod/v4";
import type { AppConfig } from "./config.js";
import { LastFmClient } from "./lastfm-client.js";
import { loadMusicConfig } from "./music-config.js";
import { MusicLibraryService } from "./music-library-service.js";
import { MusicSyncScheduler } from "./music-sync-scheduler.js";
import { SecretStore } from "./secret-store.js";
import { SpotifyAuth } from "./providers/spotify/auth.js";
import { SpotifyClient } from "./providers/spotify/client.js";

export function createMusicRuntime(config: AppConfig, env: NodeJS.ProcessEnv = process.env) {
  const music = loadMusicConfig(env, config.historyDbPath);
  const sessionStore = new SecretStore(music.lastfmSessionPath);
  const getSessionKey = async () => {
    if (!music.lastfmApiSecret) throw new Error("LASTFM_API_SECRET is required for Last.fm writes");
    const session = z.object({ username: z.string(), sessionKey: z.string().min(1) }).safeParse(await sessionStore.read());
    if (!session.success) throw new Error(`Last.fm session missing or invalid at ${music.lastfmSessionPath}; in Docker run docker compose exec lastfm-mcp npm run auth:built -- lastfm; locally run npm run auth -- lastfm`);
    if (session.data.username.toLowerCase() !== config.lastfmUsername.toLowerCase()) throw new Error("Last.fm session belongs to another username; authenticate again");
    return session.data.sessionKey;
  };
  const lastfm = new LastFmClient({ apiKey: config.lastfmApiKey, username: config.lastfmUsername,
    baseUrl: config.lastfmApiBaseUrl, timeoutMs: config.lastfmTimeoutMs, maxRetries: config.lastfmMaxRetries,
    minRequestIntervalMs: config.lastfmMinRequestIntervalMs, cacheTtlMs: config.lastfmCacheTtlMs,
    ...(music.lastfmApiSecret ? { apiSecret: music.lastfmApiSecret } : {}),
    getSessionKey });
  const auth = music.spotifyClientId && music.spotifyClientSecret ? new SpotifyAuth({ clientId: music.spotifyClientId,
    clientSecret: music.spotifyClientSecret, redirectUri: music.spotifyRedirectUri, tokenPath: music.spotifyTokenPath }) : undefined;
  const spotify = auth ? new SpotifyClient(auth) : undefined;
  const library = spotify ? new MusicLibraryService(spotify, lastfm, config.mutationsEnabled, music.autoSyncEnabled) : undefined;
  const scheduler = library && music.autoSyncEnabled ? new MusicSyncScheduler(async () => {
    await getSessionKey(); // Fail once before scanning a large library if authorization is missing.
    return library.sync("spotify_to_lastfm", false, true);
  }, music.intervalMs, music.statusPath) : undefined;
  return { config: music, lastfm, sessionStore, auth, spotify, library, scheduler };
}
export type MusicRuntime = ReturnType<typeof createMusicRuntime>;
