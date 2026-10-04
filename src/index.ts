import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { Request, Response } from "express";
import { resolveOAuthConfig } from "./auth/config.js";
import { loadConfig } from "./config.js";
import { HistoryRepository } from "./history-repository.js";
import { HistorySyncScheduler } from "./history-sync-scheduler.js";
import { createHttpApp } from "./http-app.js";
import { createInternalApi } from "./internal-api.js";
import { IntelligenceRepository } from "./intelligence-repository.js";
import { IntelligenceService } from "./intelligence-service.js";
import { LastFmClient } from "./lastfm-client.js";
import { ListeningService } from "./listening-service.js";
import { createLastFmMcpServer } from "./mcp-server.js";
import { MusicBrainzClient } from "./musicbrainz-client.js";
import { RangeAnalytics } from "./range-analytics.js";
import { RecentLikeLoveSync, type LikeLoveSummary } from "./recent-like-love-sync.js";
import { createMusicRuntime } from "./music-runtime.js";

const config = loadConfig();
const history = new HistoryRepository(config.historyDbPath);
const intelligenceRepository = new IntelligenceRepository(config.historyDbPath);
const lastfm = new LastFmClient({
  apiKey: config.lastfmApiKey,
  username: config.lastfmUsername,
  baseUrl: config.lastfmApiBaseUrl,
  timeoutMs: config.lastfmTimeoutMs,
  maxRetries: config.lastfmMaxRetries,
  minRequestIntervalMs: config.lastfmMinRequestIntervalMs,
  cacheTtlMs: config.lastfmCacheTtlMs,
});
const service = new ListeningService(
  lastfm,
  history,
  config.lastfmUsername,
  config.historyLiveScanLimit,
  config.historyMaxSyncTracks,
  config.mutationsEnabled,
  config.historyIncrementalLookbackSeconds,
);
const musicbrainz = new MusicBrainzClient({
  userAgent: config.musicbrainzUserAgent,
  baseUrl: config.musicbrainzBaseUrl,
  timeoutMs: config.musicbrainzTimeoutMs,
  maxRetries: config.musicbrainzMaxRetries,
  minRequestIntervalMs: config.musicbrainzMinRequestIntervalMs,
});
const intelligence = new IntelligenceService(
  lastfm,
  musicbrainz,
  intelligenceRepository,
  history,
  config.lastfmUsername,
  config.mutationsEnabled,
);

const music = createMusicRuntime(config);
if (config.likeLoveMode !== "off") {
  if (!music.spotify) throw new Error("LIKE_LOVE_SYNC requires SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET");
  // Upstream's whole-library sync would love every liked track at once, which
  // is exactly what the recent-plays-only sync exists to avoid.
  if (music.config.autoSyncEnabled) throw new Error("LIKE_LOVE_SYNC cannot run together with SPOTIFY_AUTO_SYNC_ENABLED=true; set it to false");
}
const likeLove = config.likeLoveMode !== "off" && music.spotify
  ? new RecentLikeLoveSync(config.historyDbPath, config.lastfmUsername, music.spotify, music.lastfm, {
    mode: config.likeLoveMode,
    windowSeconds: config.likeLoveWindowSeconds,
    likedCacheMs: config.likeLoveLikedCacheMs,
  })
  : undefined;
let lastLikeLove: (LikeLoveSummary & { at: string }) | { error: string; at: string } | undefined;

const historyScheduler = config.historyAutoSyncEnabled
  ? new HistorySyncScheduler(
    service.syncService,
    history,
    config.lastfmUsername,
    config.historyMaxSyncTracks,
    config.historyAutoSyncIntervalMs,
    async () => {
      intelligenceRepository.ensureCanonicalIndex(config.lastfmUsername);
      if (!likeLove) return;
      try {
        lastLikeLove = { ...(await likeLove.run()), at: new Date().toISOString() };
      } catch (error) {
        lastLikeLove = { error: error instanceof Error ? error.message : "Like → Love sync failed", at: new Date().toISOString() };
      }
      console.log(JSON.stringify({ event: "like_love_sync", ...lastLikeLove }));
    },
  )
  : undefined;

const rangeAnalytics = new RangeAnalytics(config.historyDbPath);
const handler = createMcpHandler(() => createLastFmMcpServer(service, intelligence, music, {
  analytics: rangeAnalytics,
  username: config.lastfmUsername,
}));
const nodeHandler = toNodeHandler(handler);
const oauthConfig = resolveOAuthConfig();
const trustProxy = process.env.MCP_TRUST_PROXY?.trim();
const { app, oauth } = createHttpApp({
  host: config.host,
  allowedHosts: config.allowedHosts,
  mcpHandler: (request: Request, response: Response) => {
    void nodeHandler(request, response, request.body);
  },
  healthz: () => ({
    status: "ok",
    service: "lastfm-mcp",
    version: "0.3.0",
    username: config.lastfmUsername,
    mutationsEnabled: config.mutationsEnabled,
    history: service.getHistoryStatus(),
    historyAutoSync: historyScheduler?.getStatus() ?? { enabled: false },
    likeLove: { mode: config.likeLoveMode, last: lastLikeLove ?? null },
    oauth: oauthConfig !== undefined,
  }),
  ...(oauthConfig ? { oauth: oauthConfig } : {}),
  allowUnauthenticated: process.env.MCP_ALLOW_UNAUTHENTICATED === "true",
  ...(trustProxy ? { trustProxy: /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy } : {}),
});

const httpServer = app.listen(config.port, config.host, () => {
  console.log(`Last.fm MCP listening on http://${config.host}:${config.port}/mcp for ${config.lastfmUsername}`);
});
// 0 disables it. Not published by compose: reachable only on the Docker network.
const internalServer = config.internalApiPort === 0
  ? undefined
  : createInternalApi(rangeAnalytics, config.lastfmUsername, () => service.getHistoryStatus())
    .listen(config.internalApiPort, config.host, () => {
      console.log(`Internal API listening on http://${config.host}:${config.internalApiPort}`);
    });
historyScheduler?.start();
music.scheduler?.start();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down`);
  httpServer.close();
  internalServer?.close();
  await handler.close();
  oauth?.store.flush();
  await historyScheduler?.stop();
  await music.scheduler?.stop();
  rangeAnalytics.close();
  likeLove?.close();
  intelligenceRepository.close();
  history.close();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
