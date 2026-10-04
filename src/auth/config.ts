// OAuth 2.1 settings for the public MCP endpoint.
//
// Ported from ojimpo/cosense-mcp (src/auth), trimmed to a single owner: there
// is one passphrase and no per-user directory, invites, or stored secrets.
//
// OAuth is the only remote option: ChatGPT connectors accept nothing else, and
// claude.ai custom connectors do not send static bearer tokens. Both clients
// need RFC 9728 resource metadata, PKCE S256, dynamic client registration,
// 401 + WWW-Authenticate, and audience (RFC 8707 resource) checks, so one
// implementation serves both.

import { scryptSync, timingSafeEqual, randomBytes } from "node:crypto";

const DEFAULT_ACCESS_TOKEN_TTL_SEC = 60 * 60;
const DEFAULT_REFRESH_TOKEN_TTL_SEC = 60 * 60 * 24 * 30;
/** RFC 6749 recommends at most ten minutes. */
export const AUTHORIZATION_CODE_TTL_SEC = 10 * 60;
export const PENDING_AUTHORIZATION_TTL_SEC = 10 * 60;
export const DEFAULT_SCOPE = "mcp";
const MIN_PASSPHRASE_LENGTH = 12;

export type OAuthConfig = {
  /** Authorization server issuer. Origin only. */
  issuerUrl: URL;
  /**
   * Protected resource identifier. It must equal the URL users paste into the
   * client; claude.ai and ChatGPT loop on re-authorization if a single
   * character differs.
   */
  resourceUrl: URL;
  /** Checks the owner's passphrase in constant time. */
  verifyPassphrase: (candidate: string) => boolean;
  /** Where client registrations and token hashes persist. Memory only when unset. */
  storePath?: string;
  accessTokenTtlSec: number;
  refreshTokenTtlSec: number;
  resourceName: string;
  scopesSupported: string[];
};

export class OAuthConfigError extends Error {}

/**
 * Builds the OAuth settings from the environment.
 *
 * Enabled only when both MCP_PUBLIC_URL and MCP_OAUTH_PASSPHRASE are set.
 * Exactly one of them is the "meant to authenticate but it is not on"
 * accident, so it throws instead of silently disabling OAuth.
 */
export function resolveOAuthConfig(env: NodeJS.ProcessEnv = process.env): OAuthConfig | undefined {
  const publicUrl = env.MCP_PUBLIC_URL?.trim();
  const passphrase = env.MCP_OAUTH_PASSPHRASE;

  if (!publicUrl && !passphrase) return undefined;
  if (!publicUrl) throw new OAuthConfigError("MCP_OAUTH_PASSPHRASE is set but MCP_PUBLIC_URL is missing; OAuth cannot be enabled");
  if (!passphrase) throw new OAuthConfigError("MCP_PUBLIC_URL is set but MCP_OAUTH_PASSPHRASE is missing; OAuth cannot be enabled");
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new OAuthConfigError(`MCP_OAUTH_PASSPHRASE must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
  }

  let base: URL;
  try {
    base = new URL(publicUrl);
  } catch {
    throw new OAuthConfigError(`MCP_PUBLIC_URL is not a valid URL: ${publicUrl}`);
  }
  const isLoopback = base.hostname === "localhost" || base.hostname === "127.0.0.1";
  if (base.protocol !== "https:" && !isLoopback) {
    throw new OAuthConfigError(`MCP_PUBLIC_URL must use https (got: ${base.protocol}//)`);
  }
  if (base.search || base.hash) throw new OAuthConfigError("MCP_PUBLIC_URL must not contain a query string or fragment");

  const storePath = env.MCP_OAUTH_STORE?.trim();
  return {
    issuerUrl: new URL(base.origin),
    resourceUrl: new URL("/mcp", base.origin),
    verifyPassphrase: passphraseVerifier(passphrase),
    ...(storePath ? { storePath } : {}),
    accessTokenTtlSec: parsePositiveInt(env.MCP_OAUTH_ACCESS_TTL, DEFAULT_ACCESS_TOKEN_TTL_SEC, "MCP_OAUTH_ACCESS_TTL"),
    refreshTokenTtlSec: parsePositiveInt(env.MCP_OAUTH_REFRESH_TTL, DEFAULT_REFRESH_TOKEN_TTL_SEC, "MCP_OAUTH_REFRESH_TTL"),
    resourceName: env.MCP_OAUTH_RESOURCE_NAME?.trim() || "scrobble-gateway",
    scopesSupported: [DEFAULT_SCOPE],
  };
}

/**
 * Compares through scrypt so the comparison is constant time regardless of
 * length, and the plaintext is not kept around longer than needed.
 */
export function passphraseVerifier(passphrase: string): (candidate: string) => boolean {
  const salt = randomBytes(16);
  const expected = scryptSync(passphrase, salt, 32);
  return (candidate) => timingSafeEqual(scryptSync(candidate, salt, 32), expected);
}

function parsePositiveInt(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) throw new OAuthConfigError(`${label} must be a positive integer (got: ${value})`);
  return parsed;
}
