import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OAuthConfigError, passphraseVerifier, resolveOAuthConfig, type OAuthConfig } from "../src/auth/config.js";
import { canonicalizeResource } from "../src/auth/provider.js";
import { createHttpApp } from "../src/http-app.js";

const PASSPHRASE = "correct horse battery staple";
const REDIRECT = "https://client.example/callback";
const servers: Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

describe("OAuth config", () => {
  it("is off when nothing is set and refuses half a configuration", () => {
    expect(resolveOAuthConfig({})).toBeUndefined();
    expect(() => resolveOAuthConfig({ MCP_PUBLIC_URL: "https://x.example" })).toThrow(OAuthConfigError);
    expect(() => resolveOAuthConfig({ MCP_OAUTH_PASSPHRASE: PASSPHRASE })).toThrow(OAuthConfigError);
    expect(() => resolveOAuthConfig({ MCP_PUBLIC_URL: "https://x.example", MCP_OAUTH_PASSPHRASE: "short" })).toThrow(/12 characters/);
    expect(() => resolveOAuthConfig({ MCP_PUBLIC_URL: "http://x.example", MCP_OAUTH_PASSPHRASE: PASSPHRASE })).toThrow(/https/);
  });

  it("derives the issuer from the origin and the resource from /mcp", () => {
    const config = resolveOAuthConfig({ MCP_PUBLIC_URL: "https://scrobble.example/", MCP_OAUTH_PASSPHRASE: PASSPHRASE })!;
    expect(config.issuerUrl.href).toBe("https://scrobble.example/");
    expect(config.resourceUrl.href).toBe("https://scrobble.example/mcp");
    expect(config.verifyPassphrase(PASSPHRASE)).toBe(true);
    expect(config.verifyPassphrase("wrong")).toBe(false);
  });

  it("normalizes resources for audience comparison", () => {
    expect(canonicalizeResource("https://a.example/mcp/")).toBe("https://a.example/mcp");
    expect(canonicalizeResource("https://a.example/mcp#x")).toBe("https://a.example/mcp");
  });
});

describe("HTTP + OAuth", () => {
  it("refuses to start without authentication unless asked to", () => {
    expect(() => createHttpApp({ host: "127.0.0.1", allowedHosts: [], mcpHandler: vi.fn(), healthz: () => ({}) }))
      .toThrow(/Refusing to start/);
    quiet();
    expect(() => createHttpApp({ host: "127.0.0.1", allowedHosts: [], mcpHandler: vi.fn(), healthz: () => ({}), allowUnauthenticated: true }))
      .not.toThrow();
  });

  it("keeps /healthz open and answers anonymous /mcp with 401 + WWW-Authenticate", async () => {
    const { base } = await start();
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    const response = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("resource_metadata=");
  });

  it("serves protected-resource metadata with and without the path suffix", async () => {
    const { base, config } = await start();
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const body = await (await fetch(`${base}${path}`)).json() as { resource: string };
      expect(body.resource).toBe(config.resourceUrl.href);
    }
  });

  it("advertises iss support, which ChatGPT needs to keep one redirect URI", async () => {
    const { base, config } = await start();
    const body = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json() as Record<string, unknown>;
    expect(body).toMatchObject({
      issuer: config.issuerUrl.href,
      authorization_response_iss_parameter_supported: true,
      code_challenge_methods_supported: ["S256"],
    });
    expect(body.registration_endpoint).toBeDefined();
  });

  it("goes from registration to a token that opens /mcp", async () => {
    const { base, config, mcp } = await start();
    const tokens = await authorize(base, config);
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokens.access_token}` },
      body: "{}",
    });
    expect(response.status).toBe(200);
    expect(mcp).toHaveBeenCalledTimes(1);
  });

  it("puts iss exactly equal to the issuer on the redirect", async () => {
    const { base, config } = await start();
    const { location } = await approve(base, config, PASSPHRASE);
    expect(new URL(location).searchParams.get("iss")).toBe(config.issuerUrl.href);
  });

  it("shows the consent form again with 401 on a wrong passphrase", async () => {
    const { base, config } = await start();
    const client = await register(base);
    const { pendingId } = await openConsent(base, config, client);
    const response = await consent(base, { pending_id: pendingId, passphrase: "nope", action: "approve" });
    expect(response.status).toBe(401);
    expect(await response.text()).toContain("Incorrect passphrase");
  });

  it("treats a submit without action (Enter) as approval", async () => {
    const { base, config } = await start();
    const client = await register(base);
    const { pendingId } = await openConsent(base, config, client);
    const response = await consent(base, { pending_id: pendingId, passphrase: PASSPHRASE });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("code=");
  });

  it("allows the redirect origin in the consent page CSP form-action", async () => {
    const { base, config } = await start();
    const client = await register(base);
    const { csp } = await openConsent(base, config, client);
    expect(csp).toContain(`form-action 'self' ${new URL(REDIRECT).origin}`);
  });

  it("rotates refresh tokens", async () => {
    const { base, config } = await start();
    const tokens = await authorize(base, config);
    const refreshed = await token(base, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: tokens.clientId });
    expect(refreshed.status).toBe(200);
    const again = await token(base, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: tokens.clientId });
    expect(again.status).toBe(400);
  });

  it("rejects a token request for another resource with invalid_target", async () => {
    const { base, config } = await start();
    const { location, verifier, client } = await approve(base, config, PASSPHRASE);
    const response = await token(base, {
      grant_type: "authorization_code",
      code: new URL(location).searchParams.get("code")!,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: client.client_id,
      resource: "https://elsewhere.example/mcp",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_target" });
  });

  it("revokes the client's tokens when an authorization code is replayed", async () => {
    const { base, config } = await start();
    const { location, verifier, client } = await approve(base, config, PASSPHRASE);
    const exchange = () => token(base, {
      grant_type: "authorization_code",
      code: new URL(location).searchParams.get("code")!,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: client.client_id,
    });
    const first = await (await exchange()).json() as { access_token: string };
    expect((await exchange()).status).toBe(400);
    const response = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${first.access_token}` } });
    expect(response.status).toBe(401);
  });

  it("rejects a made-up bearer token", async () => {
    const { base } = await start();
    const response = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: "Bearer not-a-token" } });
    expect(response.status).toBe(401);
  });

  it("stops accepting passphrases after repeated failures", async () => {
    const { base, config } = await start();
    const client = await register(base);
    const { pendingId } = await openConsent(base, config, client);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await consent(base, { pending_id: pendingId, passphrase: "nope", action: "approve" });
    }
    const response = await consent(base, { pending_id: pendingId, passphrase: PASSPHRASE, action: "approve" });
    expect(response.status).toBe(401);
    expect(await response.text()).toContain("Too many attempts");
  });
});

function quiet() {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
}

async function start() {
  quiet();
  // Claim a port first: the issuer and resource must carry it, and the OAuth
  // router reads them once when it is built.
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  const config: OAuthConfig = {
    issuerUrl: new URL(`http://localhost:${port}/`),
    resourceUrl: new URL(`http://localhost:${port}/mcp`),
    verifyPassphrase: passphraseVerifier(PASSPHRASE),
    accessTokenTtlSec: 3600,
    refreshTokenTtlSec: 86400,
    resourceName: "test",
    scopesSupported: ["mcp"],
  };
  const mcp = vi.fn((_request, response) => response.json({ ok: true }));
  const { app } = createHttpApp({ host: "127.0.0.1", allowedHosts: ["localhost", "127.0.0.1"], mcpHandler: mcp, healthz: () => ({ ok: true }), oauth: config });
  server.on("request", app);
  return { base: `http://localhost:${port}`, config, mcp };
}

type Client = { client_id: string };

async function register(base: string): Promise<Client> {
  const response = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "Test", token_endpoint_auth_method: "none" }),
  });
  expect(response.status).toBe(201);
  return await response.json() as Client;
}

async function openConsent(base: string, config: OAuthConfig, client: Client, verifier = randomBytes(32).toString("base64url")) {
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = new URL(`${base}/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "xyz",
    resource: config.resourceUrl.href,
  }).toString();
  const response = await fetch(url, { redirect: "manual" });
  expect(response.status).toBe(200);
  const html = await response.text();
  const pendingId = /name="pending_id" value="([^"]+)"/.exec(html)?.[1];
  expect(pendingId).toBeDefined();
  return { pendingId: pendingId!, verifier, csp: response.headers.get("content-security-policy") ?? "" };
}

function consent(base: string, fields: Record<string, string>) {
  return fetch(`${base}/oauth/consent`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
    redirect: "manual",
  });
}

async function approve(base: string, config: OAuthConfig, passphrase: string) {
  const client = await register(base);
  const { pendingId, verifier } = await openConsent(base, config, client);
  const response = await consent(base, { pending_id: pendingId, passphrase, action: "approve" });
  expect(response.status).toBe(302);
  return { location: response.headers.get("location")!, verifier, client };
}

function token(base: string, fields: Record<string, string>) {
  return fetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

async function authorize(base: string, config: OAuthConfig) {
  const { location, verifier, client } = await approve(base, config, PASSPHRASE);
  const code = new URL(location).searchParams.get("code")!;
  const response = await token(base, {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT,
    client_id: client.client_id,
    resource: config.resourceUrl.href,
  });
  expect(response.status).toBe(200);
  return { ...(await response.json() as { access_token: string; refresh_token: string }), clientId: client.client_id };
}
