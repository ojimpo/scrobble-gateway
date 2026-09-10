import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { MusicRuntime } from "./music-runtime.js";

export function registerMusicTools(server: McpServer, runtime: MusicRuntime): void {
  const { spotify, library, scheduler } = runtime;
  if (!runtime.config.toolsEnabled || !spotify || !library) return;
  const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
  const write = { ...read, readOnlyHint: false };
  const playlistWrite = { ...write, idempotentHint: false };
  const outputSchema = z.object({}).loose();
  const limit = z.number().int().min(1).max(1000).default(50);
  const dryRun = z.boolean().default(true);
  const name = z.string().trim().min(1).max(500);
  const tracks = z.array(z.string().regex(/^(?:spotify:track:)?[a-zA-Z0-9]{22}$/u)).max(10000);
  const playlistInput = z.object({ name, description: z.string().max(300).default(""), tracks: tracks.default([]), public: z.boolean().default(false), dryRun });
  const timeRange = z.enum(["short_term", "medium_term", "long_term"]).default("medium_term");
  server.registerTool("spotify_get_liked_tracks", { description: "Read Spotify Liked Songs, paginating internally up to limit.", inputSchema: z.object({ limit }), outputSchema, annotations: read },
    ({ limit }) => run(async () => ({ tracks: await spotify.getLikedTracks(limit), limit })));
  server.registerTool("spotify_get_recent_tracks", { description: "Read recent Spotify plays (Spotify retention applies).", inputSchema: z.object({ limit }), outputSchema, annotations: read },
    ({ limit }) => run(async () => ({ tracks: await spotify.getRecentlyPlayed(limit), limit })));
  server.registerTool("spotify_get_top_tracks", { description: "Read Spotify top tracks by time range.", inputSchema: z.object({ limit, timeRange }), outputSchema, annotations: read },
    ({ limit, timeRange }) => run(async () => ({ tracks: await spotify.getTopTracks(timeRange, limit), timeRange })));
  server.registerTool("spotify_get_top_artists", { description: "Read Spotify top artists by time range.", inputSchema: z.object({ limit, timeRange }), outputSchema, annotations: read },
    ({ limit, timeRange }) => run(async () => ({ artists: await spotify.getTopArtists(timeRange, limit), timeRange })));
  server.registerTool("spotify_get_playlists", { description: "Read the authenticated user's Spotify playlists.", inputSchema: z.object({ limit }), outputSchema, annotations: read },
    ({ limit }) => run(async () => ({ playlists: await spotify.getPlaylists(limit) })));
  server.registerTool("spotify_search_track", { description: "Search Spotify for up to 10 track candidates; this does not assert identity.", inputSchema: z.object({ artist: name, title: name }), outputSchema, annotations: read },
    ({ artist, title }) => run(async () => ({ tracks: await spotify.searchTrack(artist, title) })));
  for (const toolName of ["spotify_create_playlist", "create_spotify_playlist_from_tracks"]) {
    server.registerTool(toolName, { description: "Create a playlist from resolved Spotify IDs/URIs, deduplicating inputs. Defaults to private and dryRun=true. Set dryRun=false to write.",
      inputSchema: playlistInput, outputSchema, annotations: playlistWrite }, (input) => run(() => library.createPlaylistFromTracks(input)));
  }
  server.registerTool("spotify_add_tracks_to_playlist", { description: "Append resolved tracks to a playlist. dryRun=true by default. Repeated writes may add duplicates.",
    inputSchema: z.object({ playlistId: z.string().regex(/^[a-zA-Z0-9]{22}$/u), tracks, dryRun }), outputSchema, annotations: playlistWrite },
    ({ playlistId, tracks, dryRun }) => run(() => library.addTracksToPlaylist(playlistId, tracks, dryRun)));
  for (const [toolName, direction] of [["sync_spotify_likes_to_lastfm", "spotify_to_lastfm"], ["sync_lastfm_loves_to_spotify", "lastfm_to_spotify"]] as const) {
    server.registerTool(toolName, { description: "Reconcile the full liked/loved library, adding only confident missing matches. Never removes likes. dryRun=true by default; set false to write.",
      inputSchema: z.object({ dryRun }), outputSchema, annotations: write }, ({ dryRun }) => run(() => library.sync(direction, dryRun)));
  }
  server.registerTool("compare_spotify_lastfm_library", { description: "Read-only full library comparison and catalog resolution. Returns paged missing, ambiguous and unresolved entries with totals.",
    inputSchema: z.object({ limit, offset: z.number().int().min(0).default(0) }), outputSchema, annotations: read },
    ({ limit, offset }) => run(() => library.compare(limit, offset)));
  server.registerTool("get_music_sync_status", { description: "Inspect the automatic Spotify likes → Last.fm loves scheduler and last result.",
    inputSchema: z.object({}), outputSchema, annotations: { ...read, openWorldHint: false } },
    () => run(async () => scheduler?.getStatus() ?? { enabled: false }));
}

async function run(operation: () => Promise<object>) {
  try {
    const structuredContent = { ...await operation() };
    return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }], structuredContent };
  } catch (error) { return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Unknown music provider error" }], isError: true }; }
}
