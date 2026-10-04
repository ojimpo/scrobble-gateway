// OAuth 2.1 authorization server and resource server for the MCP endpoint.
//
// Ported from ojimpo/cosense-mcp and trimmed to one owner. The authorization
// server lives in-process instead of delegating to an external IdP: few IdPs
// accept dynamic client registration out of the box, and a passphrase is
// enough to authenticate a single owner.

import { randomUUID } from "node:crypto";
import type { Response } from "express";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import {
  AUTHORIZATION_CODE_TTL_SEC,
  DEFAULT_SCOPE,
  PENDING_AUTHORIZATION_TTL_SEC,
  type OAuthConfig,
} from "./config.js";
import type { ConsentPageParams } from "./pages.js";
import { FixedWindowRateLimiter } from "./rate-limit.js";
import { OAuthStore, generateToken } from "./store.js";

/** The consent form should be shown again (wrong passphrase etc.). */
export class ConsentError extends Error {}

/** The consent form cannot even be shown (unknown or expired request). */
export class PendingNotFoundError extends Error {}

type PendingAuthorization = {
  id: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
  /** Code already issued for this request, returned again on a resubmit. */
  issuedCode?: string;
};

type AuthorizationCode = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
};

/**
 * Normalizes a resource for audience comparison: drops the fragment and the
 * trailing slash, since /mcp and /mcp/ are the same endpoint.
 */
export function canonicalizeResource(value: string | URL): string {
  const url = new URL(value.toString());
  url.hash = "";
  const href = url.href;
  return href.endsWith("/") ? href.slice(0, -1) : href;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function isAllowedRedirectUri(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  // RFC 8252: plain http only for native clients on loopback.
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
}

export class GatewayOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;

  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly codes = new Map<string, AuthorizationCode>();
  /** Remembers spent codes for their TTL so a replay can be detected. */
  private readonly usedCodes = new Map<string, { clientId: string; expiresAt: number }>();
  private readonly loginLimiter = new FixedWindowRateLimiter(10, 15 * 60 * 1000);
  private readonly canonicalResource: string;

  constructor(
    private readonly config: OAuthConfig,
    private readonly store: OAuthStore,
    private readonly consentPath: string,
    private readonly renderConsent: (params: ConsentPageParams) => string,
  ) {
    this.canonicalResource = canonicalizeResource(config.resourceUrl);
    this.clientsStore = {
      getClient: (clientId) => this.store.getClient(clientId),
      registerClient: (client) => {
        const full = client as OAuthClientInformationFull;
        if (!full.redirect_uris || full.redirect_uris.length === 0) {
          throw new InvalidClientMetadataError("At least one redirect_uri is required");
        }
        const bad = full.redirect_uris.find((uri) => !isAllowedRedirectUri(uri));
        if (bad) throw new InvalidClientMetadataError(`redirect_uri must be https (or http on loopback): ${bad}`);
        this.store.saveClient(full);
        console.error(`[oauth] registered client ${full.client_id} (${full.client_name ?? "unnamed"})`);
        return full;
      },
    };
  }

  // --- Authorization request ---

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (params.resource !== undefined && canonicalizeResource(params.resource) !== this.canonicalResource) {
      // Letting this through would mint tokens for some other resource.
      throw new InvalidTargetError(`Unsupported resource: ${params.resource.href}`);
    }
    this.sweep();

    const pending: PendingAuthorization = {
      id: randomUUID(),
      clientId: client.client_id,
      clientName: client.client_name ?? client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      ...(params.state !== undefined ? { state: params.state } : {}),
      scopes: params.scopes && params.scopes.length > 0 ? params.scopes : [DEFAULT_SCOPE],
      ...(params.resource !== undefined ? { resource: canonicalizeResource(params.resource) } : {}),
      expiresAt: nowSec() + PENDING_AUTHORIZATION_TTL_SEC,
    };
    this.pending.set(pending.id, pending);

    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Frame-Options", "DENY");
    // form-action also governs where the form's response may redirect. With
    // only 'self' the browser blocks the 302 back to the client after Approve,
    // and the button seems to do nothing (curl ignores CSP, so only a real
    // browser shows this).
    const redirectOrigin = new URL(params.redirectUri).origin;
    res.setHeader("Content-Security-Policy", `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${redirectOrigin}`);
    res.status(200).type("html").send(this.renderConsent(this.consentParams(pending)));
  }

  /** The consent form again, optionally with an error message. */
  renderConsentFor(pendingId: string, error?: string): string {
    return this.renderConsent({ ...this.consentParams(this.requirePending(pendingId)), ...(error !== undefined ? { error } : {}) });
  }

  /**
   * Approves the consent form and returns the redirect URL. Always carries
   * `iss`: ChatGPT uses it to keep a fixed redirect URI.
   */
  approve(pendingId: string, passphrase: string, rateLimitKey: string): string {
    const pending = this.requirePending(pendingId);
    if (!this.loginLimiter.tryConsume(rateLimitKey)) throw new ConsentError("Too many attempts. Try again later.");
    if (!this.config.verifyPassphrase(passphrase)) throw new ConsentError("Incorrect passphrase.");
    this.loginLimiter.reset(rateLimitKey);

    // A resubmitted approval (browser re-POST, or pressing again because the
    // redirect was not visible) must not dead-end on "expired". Reuse the code;
    // its single use is enforced at the token endpoint.
    let code = pending.issuedCode;
    if (code === undefined) {
      code = generateToken();
      pending.issuedCode = code;
      this.codes.set(code, {
        clientId: pending.clientId,
        redirectUri: pending.redirectUri,
        codeChallenge: pending.codeChallenge,
        scopes: pending.scopes,
        ...(pending.resource !== undefined ? { resource: pending.resource } : {}),
        expiresAt: nowSec() + AUTHORIZATION_CODE_TTL_SEC,
      });
    }

    const redirect = new URL(pending.redirectUri);
    redirect.searchParams.set("code", code);
    if (pending.state !== undefined) redirect.searchParams.set("state", pending.state);
    // `iss` must equal the metadata `issuer` exactly (RFC 9207). issuerUrl.href
    // keeps the trailing slash that .origin drops; ChatGPT compares strictly and
    // on a mismatch silently discards the redirect and restarts at /authorize.
    redirect.searchParams.set("iss", this.config.issuerUrl.href);
    return redirect.href;
  }

  deny(pendingId: string): string {
    const pending = this.requirePending(pendingId);
    this.pending.delete(pendingId);
    const redirect = new URL(pending.redirectUri);
    redirect.searchParams.set("error", "access_denied");
    redirect.searchParams.set("error_description", "The user denied the request");
    if (pending.state !== undefined) redirect.searchParams.set("state", pending.state);
    redirect.searchParams.set("iss", this.config.issuerUrl.href);
    return redirect.href;
  }

  private consentParams(pending: PendingAuthorization): ConsentPageParams {
    return {
      pendingId: pending.id,
      clientName: pending.clientName,
      redirectUri: pending.redirectUri,
      scopes: pending.scopes,
      resource: this.config.resourceUrl.href,
      resourceHost: this.config.resourceUrl.host,
      actionPath: this.consentPath,
    };
  }

  private requirePending(pendingId: string): PendingAuthorization {
    this.sweep();
    const pending = this.pending.get(pendingId);
    if (!pending) throw new PendingNotFoundError("This authorization request has expired. Start over from the client.");
    return pending;
  }

  // --- Token endpoint ---

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const record = this.codes.get(authorizationCode);
    if (!record || record.clientId !== client.client_id) {
      this.detectCodeReuse(authorizationCode, client.client_id);
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    if (record.expiresAt <= nowSec()) {
      this.codes.delete(authorizationCode);
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    return record.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const record = this.codes.get(authorizationCode);
    if (!record || record.clientId !== client.client_id || record.expiresAt <= nowSec()) {
      this.detectCodeReuse(authorizationCode, client.client_id);
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    // Single use; any later presentation counts as a replay.
    this.codes.delete(authorizationCode);
    this.usedCodes.set(authorizationCode, { clientId: client.client_id, expiresAt: nowSec() + AUTHORIZATION_CODE_TTL_SEC });

    if (redirectUri !== undefined && redirectUri !== record.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    const requested = resource !== undefined ? canonicalizeResource(resource) : undefined;
    if (requested !== undefined && requested !== this.canonicalResource) {
      throw new InvalidTargetError(`Unsupported resource: ${resource!.href}`);
    }
    if (requested !== undefined && record.resource !== undefined && requested !== record.resource) {
      throw new InvalidTargetError("resource does not match the authorization request");
    }
    return this.issueTokens(client.client_id, record.scopes, requested ?? record.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const record = this.store.consumeRefreshToken(refreshToken);
    if (!record || record.clientId !== client.client_id) throw new InvalidGrantError("Invalid or expired refresh token");

    const requested = resource !== undefined ? canonicalizeResource(resource) : undefined;
    if (requested !== undefined && requested !== this.canonicalResource) {
      throw new InvalidTargetError(`Unsupported resource: ${resource!.href}`);
    }
    // A refresh may narrow the scopes but never widen them.
    let granted = record.scopes;
    if (scopes && scopes.length > 0) {
      const widened = scopes.filter((scope) => !record.scopes.includes(scope));
      if (widened.length > 0) throw new InvalidGrantError(`Cannot widen scope: ${widened.join(", ")}`);
      granted = scopes;
    }
    // Keep the grant id across rotation so revocation still reaches every generation.
    return this.issueTokens(client.client_id, granted, requested ?? record.resource, record.grantId);
  }

  private issueTokens(clientId: string, scopes: string[], resource: string | undefined, grantId: string = randomUUID()): OAuthTokens {
    const accessToken = generateToken();
    const refreshToken = generateToken();
    const issuedAt = nowSec();
    const base = { clientId, scopes, grantId, ...(resource !== undefined ? { resource } : {}) };
    this.store.saveAccessToken(accessToken, { ...base, expiresAt: issuedAt + this.config.accessTokenTtlSec });
    this.store.saveRefreshToken(refreshToken, { ...base, expiresAt: issuedAt + this.config.refreshTokenTtlSec });
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: this.config.accessTokenTtlSec,
      scope: scopes.join(" "),
      refresh_token: refreshToken,
    };
  }

  /**
   * A replayed authorization code may mean it leaked and was exchanged first
   * by someone else, so drop every token of that client (RFC 6749 4.1.2).
   */
  private detectCodeReuse(authorizationCode: string, clientId: string): void {
    const used = this.usedCodes.get(authorizationCode);
    if (used && used.clientId === clientId) {
      console.error(`[oauth] authorization code reuse detected for client ${clientId}; revoking its tokens`);
      this.store.revokeClientTokens(clientId);
    }
  }

  // --- Resource server ---

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = this.store.getAccessToken(token);
    if (!record) throw new InvalidTokenError("Token is invalid or expired");
    if (record.resource !== undefined && record.resource !== this.canonicalResource) {
      // RFC 8707: never accept a token minted for another resource.
      throw new InvalidTokenError("Token was not issued for this resource server");
    }
    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: record.expiresAt,
      ...(record.resource !== undefined ? { resource: new URL(record.resource) } : {}),
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    // RFC 7009: revoking either token revokes the whole grant; unknown tokens are not an error.
    const grantId = this.store.findGrantId(request.token);
    if (grantId !== undefined) this.store.revokeGrant(grantId);
  }

  private sweep(): void {
    const cutoff = nowSec();
    for (const [id, entry] of this.pending) if (entry.expiresAt <= cutoff) this.pending.delete(id);
    for (const [code, entry] of this.codes) if (entry.expiresAt <= cutoff) this.codes.delete(code);
    for (const [code, entry] of this.usedCodes) if (entry.expiresAt <= cutoff) this.usedCodes.delete(code);
  }
}
