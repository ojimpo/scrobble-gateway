import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const env = { LASTFM_API_KEY: "test-key", LASTFM_USERNAME: "listener", MCP_HOST: "127.0.0.1" };

describe("incremental lookback configuration", () => {
  it("defaults to 72 hours", () => {
    expect(loadConfig(env).historyIncrementalLookbackSeconds).toBe(72 * 3600);
  });

  it.each([0, 24, 720])("converts %i hours to seconds", (hours) => {
    expect(loadConfig({ ...env, HISTORY_INCREMENTAL_LOOKBACK_HOURS: String(hours) }).historyIncrementalLookbackSeconds).toBe(hours * 3600);
  });

  it.each(["-1", "721", "1.5", "invalid"])("rejects %s hours", (hours) => {
    expect(() => loadConfig({ ...env, HISTORY_INCREMENTAL_LOOKBACK_HOURS: hours })).toThrow();
  });
});
