import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { createMusicRuntime } from "./music-runtime.js";

async function main(): Promise<void> {
  const runtime = createMusicRuntime(loadConfig());
  const provider = process.argv[2];
  if (!existsSync("/.dockerenv") && (runtime.config.spotifyTokenPath.startsWith("/app/") || runtime.config.lastfmSessionPath.startsWith("/app/"))) {
    console.warn("You are authenticating on the host with /app credential paths. These files are NOT shared with the Docker volume.");
    console.warn("For Docker use: docker compose exec lastfm-mcp npm run auth:built -- " + (provider === "spotify" ? "spotify" : "lastfm"));
  }
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    if (provider === "spotify") {
      if (!runtime.auth) throw new Error("Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET first");
      console.log("Open this URL in your browser:\n" + await runtime.auth.begin());
      console.log("After approval, copy the full redirect URL from the address bar. The callback page may fail to load; no callback listener is required.");
      await runtime.auth.complete((await prompt.question("Paste redirect URL: ")).trim());
      console.log(`Spotify authorization saved to ${resolve(runtime.config.spotifyTokenPath)}. Access tokens refresh automatically.`);
    } else if (provider === "lastfm") {
      const token = await runtime.lastfm.beginAuth();
      console.log("Open this URL and approve access:\nhttps://www.last.fm/api/auth/?" + new URLSearchParams({ api_key: loadConfig().lastfmApiKey, token }));
      await prompt.question("Press Enter after approving: ");
      await runtime.sessionStore.write(await runtime.lastfm.completeAuth(token));
      console.log(`Last.fm session saved to ${resolve(runtime.config.lastfmSessionPath)} for the configured username.`);
    } else throw new Error("Usage: npm run auth -- spotify|lastfm");
  } finally { prompt.close(); }
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Authentication failed"); process.exitCode = 1; });
