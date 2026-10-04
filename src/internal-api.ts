import express, { type Express, type Request, type Response } from "express";
import type { HistoryStatus } from "./history-repository.js";
import type { RangeAnalytics } from "./range-analytics.js";

// REST for other services on the same Docker network (health-ojimpo first).
//
// It listens on its own port that compose does not publish, so it never goes
// through Cloudflare Tunnel and needs no OAuth. Keep what it returns to derived
// figures: consumers should not rebuild a second copy of the scrobble history.
export function createInternalApi(analytics: RangeAnalytics, username: string, status: () => HistoryStatus): Express {
  const app = express();

  app.get("/healthz", (_request: Request, response: Response) => {
    response.json({ status: "ok" });
  });

  // GET /daily-plays?from=YYYY-MM-DD&to=YYYY-MM-DD (UTC days, both optional, inclusive)
  app.get("/daily-plays", (request: Request, response: Response) => {
    const from = typeof request.query.from === "string" ? request.query.from : undefined;
    const to = typeof request.query.to === "string" ? request.query.to : undefined;
    try {
      const history = status();
      response.json({
        timezone: "UTC",
        days: analytics.getDailyPlays(username, from, to),
        // Lets the consumer tell "no plays" from "not synced yet".
        newestScrobbleAt: history.newestScrobbleAt,
        coveredThroughAt: history.coveredThroughAt,
        fullHistorySynced: history.fullHistorySynced,
      });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Invalid request" });
    }
  });

  return app;
}
