import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { Request, Response } from "express";
import { resolveOAuthConfig } from "./auth/config.js";
import { loadConfig } from "./config.js";
import { HistoryRepository } from "./history-repository.js";
import { HistorySyncScheduler } from "./history-sync-scheduler.js";
import { createHttpApp } from "./http-app.js";
import { IntelligenceRepository } from "./intelligence-repository.js";
import { IntelligenceService } from "./intelligence-service.js";
import { LastFmClient } from "./lastfm-client.js";
import { ListeningService } from "./listening-service.js";
import { createLastFmMcpServer } from "./mcp-server.js";
import { MusicBrainzClient } from "./musicbrainz-client.js";
import { RangeAnalytics } from "./range-analytics.js";
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

const historyScheduler = config.historyAutoSyncEnabled
  ? new HistorySyncScheduler(
    service.syncService,
    history,
    config.lastfmUsername,
    config.historyMaxSyncTracks,
    config.historyAutoSyncIntervalMs,
    () => intelligenceRepository.ensureCanonicalIndex(config.lastfmUsername),
  )
  : undefined;

const music = createMusicRuntime(config);
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
    oauth: oauthConfig !== undefined,
  }),
  ...(oauthConfig ? { oauth: oauthConfig } : {}),
  allowUnauthenticated: process.env.MCP_ALLOW_UNAUTHENTICATED === "true",
  ...(trustProxy ? { trustProxy: /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy } : {}),
});

const httpServer = app.listen(config.port, config.host, () => {
  console.log(`Last.fm MCP listening on http://${config.host}:${config.port}/mcp for ${config.lastfmUsername}`);
});
historyScheduler?.start();
music.scheduler?.start();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down`);
  httpServer.close();
  await handler.close();
  oauth?.store.flush();
  await historyScheduler?.stop();
  await music.scheduler?.stop();
  rangeAnalytics.close();
  intelligenceRepository.close();
  history.close();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
