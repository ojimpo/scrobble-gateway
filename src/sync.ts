import { loadConfig } from "./config.js";
import { HistoryRepository } from "./history-repository.js";
import { HistorySyncService, type SyncMode } from "./history-sync.js";
import { LastFmClient } from "./lastfm-client.js";

const config = loadConfig();
const requestedMode = process.argv[2] ?? "incremental";
if (requestedMode !== "full" && requestedMode !== "incremental") {
  throw new Error("Usage: npm run sync -- [full|incremental] [maxTracks]");
}
const requestedMax = Number.parseInt(process.argv[3] ?? String(config.historyMaxSyncTracks), 10);
if (!Number.isSafeInteger(requestedMax) || requestedMax < 200) {
  throw new Error("maxTracks must be an integer of at least 200");
}

const history = new HistoryRepository(config.historyDbPath);
const lastfm = new LastFmClient({
  apiKey: config.lastfmApiKey,
  username: config.lastfmUsername,
  baseUrl: config.lastfmApiBaseUrl,
  timeoutMs: config.lastfmTimeoutMs,
  maxRetries: config.lastfmMaxRetries,
  minRequestIntervalMs: config.lastfmMinRequestIntervalMs,
  cacheTtlMs: config.lastfmCacheTtlMs,
});

try {
  const sync = new HistorySyncService(lastfm, history, config.lastfmUsername, config.historyMaxSyncTracks);
  const result = await sync.sync(requestedMode as SyncMode, requestedMax);
  console.log(JSON.stringify(result, null, 2));
} finally {
  history.close();
}
