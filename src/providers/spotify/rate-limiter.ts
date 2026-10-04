import { setTimeout as delay } from "node:timers/promises";
import * as z from "zod/v4";
import { SecretStore } from "../../secret-store.js";

export class SpotifyApiError extends Error {
  constructor(readonly status: number, readonly retryAfterMs: number, readonly quotaExceeded = false) {
    super(`Spotify HTTP ${status}${status === 403 ? "; check app access, Premium and granted scopes" : ""}${status === 429 ? `; ${quotaExceeded ? "account quota exceeded; " : ""}retry after ${Math.ceil(retryAfterMs / 1000)} seconds` : ""}`);
  }
}

export type RateLimiterOptions = {
  minIntervalMs?: number;
  maxQueueWaitMs?: number;
  cooldownPath?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
};
const cooldownSchema = z.object({ blockedUntil: z.number().finite(), quotaExceeded: z.boolean() });

/** One serialized queue per runtime, shared by MCP requests and the scheduler. */
export class SpotifyRateLimiter {
  private tail: Promise<unknown> = Promise.resolve();
  private ready: Promise<void> | undefined;
  private nextRequestAt = 0;
  private blockedUntil = 0;
  private quotaExceeded = false;
  private queued = 0;
  private requests = 0;
  private rateLimitedResponses = 0;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<unknown>;
  private readonly store: SecretStore | undefined;
  readonly minIntervalMs: number;
  readonly maxQueueWaitMs: number;

  constructor(options: RateLimiterOptions = {}) {
    this.minIntervalMs = options.minIntervalMs ?? 2000;
    this.maxQueueWaitMs = options.maxQueueWaitMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? delay;
    this.store = options.cooldownPath ? new SecretStore(options.cooldownPath) : undefined;
  }

  async getStatus() {
    await this.load();
    return { minRequestIntervalMs: this.minIntervalMs, maxQueueWaitMs: this.maxQueueWaitMs,
      queued: this.queued, requests: this.requests, rateLimitedResponses: this.rateLimitedResponses,
      blockedUntil: this.blockedUntil > this.now() ? new Date(this.blockedUntil).toISOString() : null,
      retryAfterSeconds: Math.max(0, Math.ceil((this.blockedUntil - this.now()) / 1000)),
      quotaExceeded: this.blockedUntil > this.now() && this.quotaExceeded };
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.load();
    this.assertNotBlocked();
    // Bound queue size as well as the time spent waiting; never build an unlimited backlog.
    if (this.queued >= Math.min(100, Math.max(1, Math.floor(this.maxQueueWaitMs / Math.max(1, this.minIntervalMs))))) {
      throw new Error("Spotify request queue is full; try again later");
    }
    const deadline = this.now() + this.maxQueueWaitMs;
    this.queued++;
    const task = this.tail.then(async () => {
      this.assertNotBlocked();
      const wait = Math.max(0, this.nextRequestAt - this.now());
      if (this.now() + wait > deadline) throw new Error("Spotify request queue wait exceeded; try again later");
      if (wait > 0) await this.sleep(wait);
      this.assertNotBlocked();
      if (this.now() > deadline) throw new Error("Spotify request queue wait exceeded; try again later");
      this.requests++;
      try { return await operation(); }
      finally { this.nextRequestAt = this.now() + this.minIntervalMs; }
    }).finally(() => { this.queued--; });
    this.tail = task.catch(() => undefined);
    return task;
  }

  async block(retryAfter: string | null, quotaExceeded: boolean): Promise<SpotifyApiError> {
    const seconds = retryAfter?.trim() ? Number(retryAfter) : NaN;
    const date = retryAfter && !Number.isFinite(seconds) ? Date.parse(retryAfter) : NaN;
    const requestedMs = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : date - this.now();
    const fallback = quotaExceeded ? 3_600_000 : 60_000;
    const retryMs = Number.isFinite(requestedMs) && requestedMs > 0 ? Math.max(1000, requestedMs) : fallback;
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + retryMs);
    this.quotaExceeded = quotaExceeded;
    this.rateLimitedResponses++;
    if (this.store) await this.store.write({ blockedUntil: this.blockedUntil, quotaExceeded });
    return new SpotifyApiError(429, this.blockedUntil - this.now(), quotaExceeded);
  }

  private load(): Promise<void> {
    this.ready ??= (async () => {
      const raw = await this.store?.read();
      if (raw === undefined || raw === null) return;
      const state = cooldownSchema.parse(raw);
      this.blockedUntil = state.blockedUntil;
      this.quotaExceeded = state.quotaExceeded;
    })();
    return this.ready;
  }
  private assertNotBlocked(): void {
    if (this.blockedUntil > this.now()) throw new SpotifyApiError(429, this.blockedUntil - this.now(), this.quotaExceeded);
  }
}
