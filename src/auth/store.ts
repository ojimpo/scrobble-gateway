// Persistence for OAuth client registrations and tokens (ported from cosense-mcp).
//
// Tokens are stored only as SHA-256 hashes, so a leaked store file does not
// contain usable tokens. Authorization codes and pending consent screens live
// ten minutes and stay in memory: a restart just makes the client re-authorize.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

export type GrantRecord = {
  clientId: string;
  scopes: string[];
  /** Unix seconds. */
  expiresAt: number;
  /** RFC 8707 audience, checked against this server's resource on every request. */
  resource?: string;
  /**
   * Ties the access and refresh tokens of one authorization together. RFC 7009
   * says revoking a refresh token should revoke its access tokens too, which
   * cannot be traced from token values alone.
   */
  grantId: string;
};

type StoreData = {
  version: 1;
  clients: Record<string, OAuthClientInformationFull>;
  accessTokens: Record<string, GrantRecord>;
  refreshTokens: Record<string, GrantRecord>;
};

function emptyData(): StoreData {
  return { version: 1, clients: {}, accessTokens: {}, refreshTokens: {} };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** URL-safe opaque token. */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export class OAuthStore {
  private data: StoreData = emptyData();
  private flushTimer: NodeJS.Timeout | undefined;

  constructor(private readonly filePath?: string) {
    this.load();
  }

  private load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf-8")) as Partial<StoreData>;
      if (parsed.version !== 1) {
        console.error(`[oauth] ignoring store with unsupported version: ${String(parsed.version)}`);
        return;
      }
      this.data = {
        version: 1,
        clients: parsed.clients ?? {},
        accessTokens: parsed.accessTokens ?? {},
        refreshTokens: parsed.refreshTokens ?? {},
      };
      this.pruneExpired();
    } catch (error) {
      // Do not refuse to start over a broken store; clients re-register and re-authorize.
      console.error("[oauth] failed to read store, starting empty:", error);
      this.data = emptyData();
    }
  }

  /** Batches writes made in the same tick. Tests and shutdown call flush() directly. */
  private schedulePersist(): void {
    if (!this.filePath || this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), 50);
    this.flushTimer.unref?.();
  }

  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (!this.filePath) return;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      // temp + rename so a crash mid-write does not corrupt the existing file.
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
      renameSync(tmp, this.filePath);
    } catch (error) {
      console.error("[oauth] failed to persist store:", error);
    }
  }

  pruneExpired(): void {
    const cutoff = nowSec();
    let changed = false;
    for (const bucket of [this.data.accessTokens, this.data.refreshTokens]) {
      for (const [key, record] of Object.entries(bucket)) {
        if (record.expiresAt <= cutoff) {
          delete bucket[key];
          changed = true;
        }
      }
    }
    if (changed) this.schedulePersist();
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.data.clients[clientId];
  }

  saveClient(client: OAuthClientInformationFull): void {
    this.data.clients[client.client_id] = client;
    this.schedulePersist();
  }

  saveAccessToken(token: string, record: GrantRecord): void {
    this.data.accessTokens[hashToken(token)] = record;
    this.schedulePersist();
  }

  getAccessToken(token: string): GrantRecord | undefined {
    const key = hashToken(token);
    const record = this.data.accessTokens[key];
    if (!record) return undefined;
    if (record.expiresAt <= nowSec()) {
      delete this.data.accessTokens[key];
      this.schedulePersist();
      return undefined;
    }
    return record;
  }

  saveRefreshToken(token: string, record: GrantRecord): void {
    this.data.refreshTokens[hashToken(token)] = record;
    this.schedulePersist();
  }

  /** One-time use (rotation): reading a refresh token invalidates it. */
  consumeRefreshToken(token: string): GrantRecord | undefined {
    const key = hashToken(token);
    const record = this.data.refreshTokens[key];
    if (!record) return undefined;
    delete this.data.refreshTokens[key];
    this.schedulePersist();
    return record.expiresAt <= nowSec() ? undefined : record;
  }

  findGrantId(token: string): string | undefined {
    const key = hashToken(token);
    return this.data.accessTokens[key]?.grantId ?? this.data.refreshTokens[key]?.grantId;
  }

  revokeGrant(grantId: string): number {
    let removed = 0;
    for (const bucket of [this.data.accessTokens, this.data.refreshTokens]) {
      for (const [key, record] of Object.entries(bucket)) {
        if (record.grantId === grantId) {
          delete bucket[key];
          removed += 1;
        }
      }
    }
    if (removed > 0) this.schedulePersist();
    return removed;
  }

  revokeClientTokens(clientId: string): void {
    for (const bucket of [this.data.accessTokens, this.data.refreshTokens]) {
      for (const [key, record] of Object.entries(bucket)) {
        if (record.clientId === clientId) delete bucket[key];
      }
    }
    this.schedulePersist();
  }
}
