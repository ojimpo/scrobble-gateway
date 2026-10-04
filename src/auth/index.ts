// Wires the OAuth routes into the Express app (ported from cosense-mcp).
//
// The MCP handler itself runs on SDK v2, which ships only the resource-server
// half of OAuth. The authorization server (registration, /authorize, /token)
// comes from SDK v1's mcpAuthRouter, which must sit at the app root because it
// serves the .well-known documents.

import express, { type Request, type RequestHandler, type Response } from "express";
import { createOAuthMetadata, getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { metadataHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/metadata.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { OAuthConfig } from "./config.js";
import { renderConsentPage, renderErrorPage } from "./pages.js";
import { ConsentError, GatewayOAuthProvider, PendingNotFoundError } from "./provider.js";
import { OAuthStore } from "./store.js";

const CONSENT_PATH = "/oauth/consent";

export type OAuthWiring = {
  /** Mount at the app root, before /mcp. */
  routers: RequestHandler[];
  /** Bearer check to put in front of /mcp. */
  requireAuth: RequestHandler;
  provider: GatewayOAuthProvider;
  store: OAuthStore;
};

export function setupOAuth(config: OAuthConfig): OAuthWiring {
  const store = new OAuthStore(config.storePath);
  const provider = new GatewayOAuthProvider(config, store, CONSENT_PATH, renderConsentPage);

  // The SDK's metadata lacks authorization_response_iss_parameter_supported;
  // without it ChatGPT uses a different redirect URI on every callback.
  const oauthMetadata = {
    ...createOAuthMetadata({ provider, issuerUrl: config.issuerUrl, scopesSupported: config.scopesSupported }),
    authorization_response_iss_parameter_supported: true,
    response_modes_supported: ["query"],
  };

  const overrides = express.Router();
  // Mounted before mcpAuthRouter so the extended metadata wins. Swapping the
  // order lets the SDK's plain metadata take over.
  overrides.use("/.well-known/oauth-authorization-server", metadataHandler(oauthMetadata));
  // mcpAuthRouter serves the RFC 9728 path-suffixed URL; some clients look at
  // the bare one, so serve the same document there too.
  overrides.use(
    "/.well-known/oauth-protected-resource",
    metadataHandler({
      resource: config.resourceUrl.href,
      authorization_servers: [config.issuerUrl.href],
      scopes_supported: config.scopesSupported,
      resource_name: config.resourceName,
    }),
  );
  overrides.post(CONSENT_PATH, express.urlencoded({ extended: false }), createConsentHandler(provider));

  const authRouter = mcpAuthRouter({
    provider,
    issuerUrl: config.issuerUrl,
    resourceServerUrl: config.resourceUrl,
    scopesSupported: config.scopesSupported,
    resourceName: config.resourceName,
  });

  const requireAuth = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(config.resourceUrl),
  });

  return { routers: [overrides, authRouter], requireAuth, provider, store };
}

function createConsentHandler(provider: GatewayOAuthProvider): RequestHandler {
  return (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    const body = req.body as { pending_id?: unknown; passphrase?: unknown; action?: unknown };
    const pendingId = typeof body.pending_id === "string" ? body.pending_id : "";
    const passphrase = typeof body.passphrase === "string" ? body.passphrase : "";
    try {
      if (body.action === "deny") {
        console.error(`[oauth] consent denied (pending=${pendingId.slice(0, 8)})`);
        res.redirect(302, provider.deny(pendingId));
        return;
      }
      // A submit without `action` (Enter in the field) counts as approval.
      // The only identity available for rate limiting is the client IP.
      const redirectTo = provider.approve(pendingId, passphrase, req.ip ?? "unknown");
      console.error(`[oauth] consent approved (pending=${pendingId.slice(0, 8)})`);
      res.redirect(302, redirectTo);
    } catch (error) {
      if (error instanceof ConsentError) {
        console.error(`[oauth] consent rejected (pending=${pendingId.slice(0, 8)}): ${error.message}`);
        res.status(401).type("html").send(provider.renderConsentFor(pendingId, error.message));
        return;
      }
      if (error instanceof PendingNotFoundError) {
        console.error(`[oauth] consent for unknown/expired pending=${pendingId.slice(0, 8) || "(empty)"}`);
        res.status(400).type("html").send(renderErrorPage(error.message));
        return;
      }
      console.error("[oauth] consent handler failed:", error);
      res.status(500).type("html").send(renderErrorPage("Internal server error"));
    }
  };
}
