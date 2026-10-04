import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpotifyAuth, SPOTIFY_SCOPES } from "../src/providers/spotify/auth.js";
import { SecretStore } from "../src/secret-store.js";
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "spotify-auth-")); dirs.push(dir);
  const tokenPath = join(dir, "tokens.json");
  const fetchImpl = vi.fn<typeof fetch>();
  const auth = new SpotifyAuth({ clientId: "client", clientSecret: "secret", redirectUri: "http://127.0.0.1:8888/callback", tokenPath, fetchImpl });
  return { auth, fetchImpl, store: new SecretStore(tokenPath), tokenPath };
}
describe("SpotifyAuth", () => {
  it("refreshes expired tokens once across concurrent calls and preserves refresh tokens", async () => {
    const { auth, fetchImpl, store, tokenPath } = await setup();
    await store.write({ accessToken: "old", refreshToken: "refresh", expiresAt: 1, scope: SPOTIFY_SCOPES.join(" ") });
    fetchImpl.mockResolvedValueOnce(Response.json({ access_token: "new", expires_in: 3600 }));
    expect(await Promise.all([auth.accessToken(), auth.accessToken(), auth.accessToken()])).toEqual(["new", "new", "new"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await store.read()).toMatchObject({ accessToken: "new", refreshToken: "refresh" });
    expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
    expect(await auth.accessToken()).toBe("new");
  });
  it("validates OAuth state and consumes a successful callback once", async () => {
    const { auth, fetchImpl, store } = await setup();
    const url = new URL(await auth.begin());
    const callback = `http://127.0.0.1:8888/callback?code=code&state=${url.searchParams.get("state")}`;
    await expect(auth.complete("http://127.0.0.1:8888/callback?code=x&state=wrong")).rejects.toThrow("state");
    expect(fetchImpl).not.toHaveBeenCalled();
    fetchImpl.mockResolvedValueOnce(Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: SPOTIFY_SCOPES.join(" ") }));
    await auth.complete(callback);
    expect(await store.read()).toMatchObject({ refreshToken: "refresh" });
    await expect(auth.complete(callback)).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("rejects missing permissions without storing a token", async () => {
    const { auth, fetchImpl, store } = await setup();
    const url = new URL(await auth.begin());
    fetchImpl.mockResolvedValueOnce(Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: "user-library-read" }));
    await expect(auth.complete(`http://127.0.0.1:8888/callback?code=code&state=${url.searchParams.get("state")}`)).rejects.toThrow("missing scopes");
    expect(await store.read()).toBeNull();
  });
  it("does not expose a failed token response body", async () => {
    const { auth, fetchImpl, store } = await setup();
    await store.write({ accessToken: "old", refreshToken: "refresh", expiresAt: 1, scope: SPOTIFY_SCOPES.join(" ") });
    fetchImpl.mockResolvedValueOnce(Response.json({ error: "invalid_grant", secret: "never-display" }, { status: 400 }));
    await expect(auth.accessToken()).rejects.toThrow("authenticate again");
    expect(await store.read()).toMatchObject({ accessToken: "old" });
  });
});
