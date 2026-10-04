import { randomBytes } from "node:crypto";
import * as z from "zod/v4";
import { SecretStore } from "../../secret-store.js";

export const SPOTIFY_SCOPES = ["user-library-read", "user-library-modify", "user-read-recently-played", "user-top-read",
  "playlist-read-private", "playlist-read-collaborative", "playlist-modify-private", "playlist-modify-public"];
const tokenSchema = z.object({ accessToken: z.string().min(1), refreshToken: z.string().min(1), expiresAt: z.number(), scope: z.string() });
const pendingSchema = z.object({ state: z.string(), expiresAt: z.number(), redirectUri: z.string(), clientId: z.string() });
export type SpotifyAuthOptions = { clientId: string; clientSecret: string; redirectUri: string; tokenPath: string; fetchImpl?: typeof fetch };

export class SpotifyAuth {
  private readonly store: SecretStore;
  private readonly pending: SecretStore;
  private refreshInFlight: Promise<string> | undefined;
  constructor(private readonly options: SpotifyAuthOptions) {
    this.store = new SecretStore(options.tokenPath);
    this.pending = new SecretStore(`${options.tokenPath}.pending`);
  }

  async begin(): Promise<string> {
    const redirect = new URL(this.options.redirectUri);
    if (redirect.protocol !== "https:" && !(redirect.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(redirect.hostname))) {
      throw new Error("Spotify redirect URI requires HTTPS or an explicit loopback IP (not localhost)");
    }
    const state = randomBytes(32).toString("hex");
    await this.pending.write({ state, expiresAt: Date.now() + 10 * 60_000, redirectUri: this.options.redirectUri, clientId: this.options.clientId });
    return `https://accounts.spotify.com/authorize?${new URLSearchParams({ client_id: this.options.clientId,
      response_type: "code", redirect_uri: this.options.redirectUri, scope: SPOTIFY_SCOPES.join(" "), state })}`;
  }

  async complete(callbackUrl: string): Promise<void> {
    const pending = pendingSchema.parse(await this.pending.read());
    const callback = new URL(callbackUrl);
    const expected = new URL(this.options.redirectUri);
    if (pending.expiresAt < Date.now() || callback.searchParams.get("state") !== pending.state
      || callback.origin !== expected.origin || callback.pathname !== expected.pathname
      || pending.clientId !== this.options.clientId || pending.redirectUri !== this.options.redirectUri) {
      throw new Error("Invalid or expired Spotify OAuth state/redirect; start authentication again");
    }
    if (callback.searchParams.has("error")) throw new Error("Spotify authorization was denied; start authentication again");
    const code = callback.searchParams.get("code");
    if (!code) throw new Error("Spotify callback is missing code");
    await this.pending.write(null); // One-time state, including failed exchanges.
    await this.exchange({ grant_type: "authorization_code", code, redirect_uri: this.options.redirectUri });
  }

  async accessToken(rejectedToken?: string): Promise<string> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const parsed = tokenSchema.safeParse(await this.store.read());
    if (!parsed.success) throw new Error("Spotify is not authenticated; run npm run auth -- spotify");
    const token = parsed.data;
    if (token.expiresAt > Date.now() + 60_000 && token.accessToken !== rejectedToken) return token.accessToken;
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.exchange({ grant_type: "refresh_token", refresh_token: token.refreshToken }, token.refreshToken, token.scope)
        .finally(() => { this.refreshInFlight = undefined; });
    }
    return this.refreshInFlight;
  }

  private async exchange(params: Record<string, string>, oldRefresh?: string, oldScope = ""): Promise<string> {
    const response = await (this.options.fetchImpl ?? fetch)("https://accounts.spotify.com/api/token", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Basic ${Buffer.from(`${this.options.clientId}:${this.options.clientSecret}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params),
    });
    if (!response.ok) throw new Error(`Spotify token exchange failed (HTTP ${response.status}); check credentials or authenticate again`);
    const data = z.object({ access_token: z.string().min(1), refresh_token: z.string().optional(), expires_in: z.number().positive(), scope: z.string().optional() }).parse(await response.json());
    const token = tokenSchema.parse({ accessToken: data.access_token, refreshToken: data.refresh_token ?? oldRefresh,
      expiresAt: Date.now() + data.expires_in * 1_000, scope: data.scope ?? oldScope });
    const missing = SPOTIFY_SCOPES.filter((scope) => !token.scope.split(" ").includes(scope));
    if (missing.length) throw new Error(`Spotify authorization missing scopes: ${missing.join(", ")}; authenticate again`);
    await this.store.write(token);
    return token.accessToken;
  }
}
