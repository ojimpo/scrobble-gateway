import { createMcpExpressApp } from "@modelcontextprotocol/express";
import type { Express, Request, RequestHandler, Response } from "express";
import type { OAuthConfig } from "./auth/config.js";
import { setupOAuth, type OAuthWiring } from "./auth/index.js";

export type HttpAppOptions = {
  host: string;
  allowedHosts: string[];
  /** Serves /mcp. Runs only after the bearer check when OAuth is on. */
  mcpHandler: RequestHandler;
  healthz: () => object;
  oauth?: OAuthConfig;
  /** Starting HTTP without authentication must be asked for explicitly. */
  allowUnauthenticated?: boolean;
  /** Passed to Express `trust proxy` so rate limiting sees the real client IP behind cloudflared. */
  trustProxy?: string | number | boolean;
};

export function createHttpApp(options: HttpAppOptions): { app: Express; oauth?: OAuthWiring } {
  if (!options.oauth && !options.allowUnauthenticated) {
    // cosense-mcp once went public with auth configured but not mounted. Make
    // "no auth" a deliberate choice rather than a missing variable.
    throw new Error(
      "Refusing to start the HTTP transport without authentication. "
      + "Set MCP_PUBLIC_URL + MCP_OAUTH_PASSPHRASE to enable OAuth, or MCP_ALLOW_UNAUTHENTICATED=true to opt out.",
    );
  }

  const app = createMcpExpressApp({ host: options.host, allowedHosts: options.allowedHosts });
  if (options.trustProxy !== undefined) app.set("trust proxy", options.trustProxy);

  // Log before the OAuth routers: mounted after them, /authorize, /token and
  // the consent POST never show up and a failed authorization cannot be traced.
  app.use((request: Request, _response: Response, next) => {
    if (request.path !== "/healthz") console.log(`[http] ${request.method} ${request.path}`);
    next();
  });

  app.get("/healthz", (_request: Request, response: Response) => {
    response.json(options.healthz());
  });

  let wiring: OAuthWiring | undefined;
  let requireAuth: RequestHandler | undefined;
  if (options.oauth) {
    wiring = setupOAuth(options.oauth);
    for (const router of wiring.routers) app.use(router);
    requireAuth = wiring.requireAuth;
    console.log(`[oauth] enabled: issuer=${options.oauth.issuerUrl.href} resource=${options.oauth.resourceUrl.href}`);
  } else {
    console.log("[auth] WARNING: no authentication configured; /mcp is open to anyone who can reach it");
  }

  if (requireAuth) app.all("/mcp", requireAuth, options.mcpHandler);
  else app.all("/mcp", options.mcpHandler);

  return { app, ...(wiring ? { oauth: wiring } : {}) };
}
