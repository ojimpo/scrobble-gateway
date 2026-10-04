import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpotifyRateLimiter } from "../src/providers/spotify/rate-limiter.js";
import { SpotifyClient } from "../src/providers/spotify/client.js";
import { SecretStore } from "../src/secret-store.js";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe("Spotify request queue", () => {
  it("serializes concurrent endpoints and pagination through one interval", async () => {
    vi.useFakeTimers();
    const starts: number[] = [];
    let active = 0;
    let maxActive = 0;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      starts.push(Date.now()); active++; maxActive = Math.max(active, maxActive);
      await new Promise((resolve) => setTimeout(resolve, 100));
      active--;
      const next = String(url).endsWith("me/tracks?limit=50") ? "https://api.spotify.com/v1/me/tracks?offset=1" : null;
      return Response.json({ items: [], next });
    });
    const client = new SpotifyClient({ accessToken: async () => "token" }, fetchImpl,
      (ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const all = Promise.all([client.getLikedTracks(), client.getPlaylists(), client.getTopTracks()]);
    await vi.runAllTimersAsync(); await all;
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(maxActive).toBe(1);
    expect(starts.slice(1).every((time, i) => time - starts[i]! >= 2000)).toBe(true);
  });
  it("applies a 429 before releasing any already queued calls", async () => {
    vi.useFakeTimers(); vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}, { status: 429, headers: { "retry-after": "30" } }));
    const client = new SpotifyClient({ accessToken: async () => "token" }, fetchImpl);
    const all = Promise.allSettled([client.getLikedTracks(), client.getPlaylists(), client.getTopTracks()]);
    await vi.runAllTimersAsync();
    expect((await all).every((r) => r.status === "rejected")).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await client.getRequestStatus()).toMatchObject({ retryAfterSeconds: 30, queued: 0 });
  });
  it("persists server cooldown across restarts and resumes only after its deadline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spotify-rate-limit-"));
    const path = join(dir, "cooldown.json");
    let now = 1000;
    try {
      const first = new SpotifyRateLimiter({ cooldownPath: path, now: () => now });
      await first.run(async () => { throw await first.block("300", false); }).catch(() => undefined);
      expect(await new SecretStore(path).read()).toMatchObject({ blockedUntil: 301000 });
      const restarted = new SpotifyRateLimiter({ cooldownPath: path, now: () => now });
      const operation = vi.fn(async () => "ok");
      await expect(restarted.run(operation)).rejects.toThrow("300 seconds");
      expect(operation).not.toHaveBeenCalled();
      now = 301000;
      expect(await restarted.run(operation)).toBe("ok");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("uses conservative fallbacks when Retry-After is absent or malformed", async () => {
    const ordinary = new SpotifyRateLimiter({ now: () => 0 });
    await ordinary.block(null, false);
    expect(await ordinary.getStatus()).toMatchObject({ retryAfterSeconds: 60 });
    const quota = new SpotifyRateLimiter({ now: () => 0 });
    await quota.block("garbage", true);
    expect(await quota.getStatus()).toMatchObject({ retryAfterSeconds: 3600, quotaExceeded: true });
    const date = new SpotifyRateLimiter({ now: () => 0 });
    await date.block(new Date(120000).toUTCString(), false);
    expect(await date.getStatus()).toMatchObject({ retryAfterSeconds: 120 });
  });
  it("bounds the backlog and recovers after a failed operation", async () => {
    const limiter = new SpotifyRateLimiter({ minIntervalMs: 2000, maxQueueWaitMs: 2000, sleep: async () => undefined });
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const first = limiter.run(async () => { started(); await new Promise<void>((resolve) => { release = resolve; }); throw new Error("network"); });
    await ready;
    await expect(limiter.run(async () => undefined)).rejects.toThrow("queue is full");
    release(); await expect(first).rejects.toThrow("network");
    await expect(limiter.run(async () => "ok")).resolves.toBe("ok");
  });
  it("expires a queued request instead of executing it after its deadline", async () => {
    let now = 0;
    const limiter = new SpotifyRateLimiter({ minIntervalMs: 100, maxQueueWaitMs: 1000, now: () => now, sleep: async (ms) => { now += ms; } });
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const first = limiter.run(async () => { started(); await new Promise<void>((resolve) => { release = resolve; }); });
    await ready;
    const operation = vi.fn(async () => "late");
    const next = limiter.run(operation);
    await Promise.resolve();
    now = 2000; release(); await first;
    await expect(next).rejects.toThrow("wait exceeded");
    expect(operation).not.toHaveBeenCalled();
  });
});
