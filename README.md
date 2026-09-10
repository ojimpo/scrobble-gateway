# Last.fm Taste MCP

A personal Last.fm MCP server built with Node.js and TypeScript. It uses stateless Streamable HTTP, maintains a canonical local listening index, combines Last.fm with MusicBrainz metadata, records explicit preferences, and produces evidence-backed taste analytics and recommendations.

The default deployment uses read-only Last.fm and MusicBrainz methods. Optional Spotify integration adds private library reads, playlist creation, and bidirectional likes/loves synchronization. Spotify likes can automatically become Last.fm loves on startup and hourly. API credentials stay inside the container and are never returned through MCP. Feedback, exclusions, and recommendation events are written only to the local SQLite database.

See [Spotify setup and automatic likes sync](#spotify-setup-and-automatic-likes-sync) for the optional integration.

## Features

| MCP tool | Purpose |
| --- | --- |
| `get_user_profile` | Public profile, total play count, and library size |
| `get_listening_summary` | Compact summary for `overall`, `12month`, `6month`, `3month`, `1month`, or `7day` |
| `get_top_artists` | Top artists for a period |
| `get_top_tracks` | Top tracks for a period |
| `get_top_albums` | Top albums for a period |
| `get_recent_tracks` | Recent scrobbles with optional time filtering |
| `search_listening_history` | Artist, album, or track search using the local index or a bounded live scan |
| `get_history_status` | SQLite index coverage and freshness |
| `sync_listening_history` | Full history backfill or incremental sync |
| `compare_listening_periods` | Artist and track share changes between two periods |
| `get_taste_profile` | Core artists, favorite tracks and albums, discoveries, forgotten favorites, and listening patterns |
| `get_artist_context` | Tags, similar artists, play counts, and a short biography context |
| `resolve_canonical_entities` | Canonical artist/album/track identities, aliases, and known MBIDs |
| `check_listening_exposure` | Fast unheard/sample/explored/established/favorite checks |
| `get_artist_affinity` | Active days/months, sessions, returns, concentration, and explainable affinity |
| `get_listening_sessions` | Session grouping with configurable inactivity gap |
| `get_album_exposure` | Track coverage, ordered runs, stopping points, and returns using MusicBrainz tracklists |
| `get_listening_timeline` | Arbitrary UTC ranges and day/week/month/year buckets by artist, album, or tag |
| `get_listening_matrix` | Pageable sparse time-bucket × artist/album matrix with global window totals, active days, concentration, and explicit coverage |
| `detect_listening_eras` | Statistical change points in monthly listening distributions |
| `get_artist_features` | Combined Last.fm tags/similarity and MusicBrainz metadata/relationships |
| `build_taste_graph` | Artists, albums, tags, sessions, eras, external similarity, and preference edges |
| `record_music_feedback` | Structured love/like/mixed/boring/dislike/not-now feedback |
| `record_preference_signal` | Explicit -5..5 signals for atmosphere, groove, melody, structure, vocals, and more |
| `get_feedback_context` | Feedback, dimension summaries, and active exclusions |
| `get_recommendations` | Safe, bridge, or explore recommendations with evidence, risks, and starting points |
| `exclude_recommendation` | Permanent, six-month, or new-releases-only artist exclusion |
| `list_recommendation_exclusions` | Active recommendation exclusions |
| `record_recommendation` | Store an externally issued recommendation and its exposure baseline |
| `evaluate_recommendations` | Measure post-recommendation sampling, engagement, and later returns |

Informational tools are marked read-only. `sync_listening_history`, feedback/preference recording, exclusions, and recommendation recording are explicitly annotated as local writes. `get_recommendations` also records every emitted recommendation so it can be evaluated later.

## 1. Get a Last.fm API key

1. Sign in to your Last.fm account.
2. Open [Last.fm Create API account](https://www.last.fm/api/account/create).
3. Enter an application name and description. This server does not require a callback URL.
4. Copy the **API key**.
5. Get your username from your profile URL: `https://www.last.fm/user/<username>`.

Last.fm also displays a shared secret. The original read-only tools do not need it: `user.getInfo`, `user.getTop*`, `user.getRecentTracks`, `user.getLovedTracks`, and `artist.getInfo` do not require a user session. To sync Spotify likes into Last.fm loves, set `LASTFM_API_SECRET` and authorize Last.fm using the CLI described below.

MusicBrainz does not require an API key. It does require a meaningful `User-Agent`; set `MUSICBRAINZ_USER_AGENT` to an application name/version plus your public URL or email. The client serializes calls and defaults to one request every 1.1 seconds.

## 2. Configure and run with Docker Compose

```bash
cp .env.example .env
```

At minimum, set:

```dotenv
LASTFM_API_KEY=your-api-key
LASTFM_USERNAME=your-lastfm-username
MCP_ALLOWED_HOSTS=localhost,127.0.0.1
MCP_ENABLE_MUTATIONS=false
MUSICBRAINZ_USER_AGENT=lastfm-mcp/0.3.0 (https://your-domain.example/)
```

Start the service:

```bash
docker compose up -d --build
docker compose ps
curl http://127.0.0.1:3000/healthz
```

MCP endpoint: `http://127.0.0.1:3000/mcp`.

Test protocol and tool discovery:

```bash
curl -sS http://127.0.0.1:3000/mcp \
  -X POST \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The response may be JSON or an SSE `event: message`; both are valid Streamable HTTP MCP responses.

## 3. Index your listening history once

Summary, top-chart, recent-track, and taste tools work immediately without an index. However, Last.fm does not provide server-side listening-history search by artist, album, or track. Exact search and reliable `recentDiscoveries` therefore require a full backfill:

```bash
docker compose exec lastfm-mcp node dist/src/sync.js full 250000
```

Afterward, periodically fetch new scrobbles:

```bash
docker compose exec lastfm-mcp node dist/src/sync.js incremental 10000
```

You can also invoke the MCP tool `sync_listening_history` (when `MCP_ENABLE_MUTATIONS=true`) and inspect progress with `get_history_status`. The container CLI remains available regardless of that MCP safety flag.

If a full sync reaches `HISTORY_MAX_SYNC_TRACKS`, call it again. The server persists the oldest backfill cursor and resumes from it; it does not redownload the same newest slice. Incremental syncs with a capped backlog advance oldest-first so no middle segment is skipped. `coveredThroughAt` advances only after the requested range is complete.

The index is stored in the `lastfm-data` named volume as normalized SQLite data rather than raw Last.fm responses. Intelligence tools lazily backfill canonical entity keys and alias catalogs after each sync, so an existing v0.1 database is migrated in place.

The full sync is foundational: without it, first-listen dates, long-term returns, eras, exposure filtering, and recommendation evaluation can be incomplete. Every affected response includes the current history status and a caveat when `fullHistorySynced=false`.

### Exact window and era analysis

`get_listening_matrix` is the raw statistical surface for custom era analysis. It selects artist or album columns using totals across the complete requested window—not a separate top list inside each bucket—and returns a compact sparse coordinate matrix:

- `buckets` contains UTC boundaries, total plays, active days, selected plays, and omitted plays;
- `entities` contains whole-window totals, active days/buckets, first and last play, peak bucket/day concentration, active span, and bucket density;
- `matrix.cells` uses `[bucketIndex, entityIndex, plays, activeDays]`; a missing cell means zero plays;
- `filtering` reports exact play coverage, page position, and every omission caused by `minPlays` or entity pagination.

The default `bucket=month`, `dimension=artist`, and `minPlays=1` starts an exact month × artist matrix in globally ranked pages of 250 entities. No per-month top-N truncation is applied. Re-call the tool with `entityOffset=filtering.nextEntityOffset` until that value is `null`; entity `rank` remains global while `index` addresses the current page's matrix cells. Increase `limitEntities` up to 5,000 when the client can accept a larger response. The ordinary text result stays compact while the complete page is returned in `structuredContent`, preserving ChatGPT context. If a sparse page exceeds `maxCells`, the call fails with narrowing options instead of silently dropping evidence. `activeDays`, `maxDayShare`, and `bucketDensity` help distinguish a one-evening spike from gradual discovery and recurring affinity.

Last.fm can expose imported or undated records with placeholder Unix timestamps near the 1970 epoch. The matrix and era detector keep those rows in the local history but exclude timestamps before `2002-01-01T00:00:00Z` from temporal evidence. Responses expose `minimumTimestamp` and `excludedBeforeMinimumTimestamp`, so this cleanup is explicit rather than silently rewriting dates or deleting plays.

## 4. Make the endpoint reachable by ChatGPT

ChatGPT cannot connect directly to `localhost`; it needs a remote HTTPS endpoint. The recommended setup is to keep the Compose port bound to `127.0.0.1` and run a reverse proxy such as Caddy on the same server:

```caddyfile
mcp.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

Add the public hostname to `.env` without a scheme or port:

```dotenv
MCP_ALLOWED_HOSTS=mcp.example.com,localhost,127.0.0.1
```

Apply the change and verify HTTPS:

```bash
docker compose up -d --build
curl https://mcp.example.com/healthz
```

If the server remains on a private network or local machine, use [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) instead of exposing an arbitrary public port.

## 5. Connect it to ChatGPT

Current flow in ChatGPT web:

1. Enable Developer mode under `Settings → Apps → Advanced Settings`. A workspace admin or owner may need to allow it first.
2. Open `Settings → Apps → Create`.
3. Enter a name such as `My Last.fm` and the endpoint `https://mcp.example.com/mcp`. For this deployment, use `https://lastfm.mcp.sptm.online/mcp`.
4. Select **No authentication** only for a read-only deployment or an endpoint already protected by a private tunnel. Use an OAuth 2.1 gateway before enabling mutations on a public hostname.
5. Click **Scan Tools**, wait for all 30 tools to appear, and create the app. If the app was created against an older version, rescan or recreate it so ChatGPT discovers the new tools.
6. Enable the app from the tools menu in a new chat.

Example first prompt:

> Call get_history_status first. If fullHistorySynced=true, build a detailed music taste profile with get_taste_profile and compare_listening_periods for 12month versus 3month. Separate facts from interpretations.

Recommendation-oriented prompt:

> Check my exposure and explicit feedback first. Then call get_recommendations in bridge mode, exclude anything above sampled exposure, explain each evidence path and risk, and give me one album plus three tracks to start with.

Deep-history prompt:

> Call get_listening_matrix for my complete history with bucket=month, dimension=artist, and minPlays=1. Continue through entityOffset pages until filtering.nextEntityOffset is null. Combine columns by entity rank/key, then use the sparse matrix, active-day evidence, and normalized monthly shares to calculate change points, identify artists shared by adjacent eras, and distinguish one-evening spikes from gradual discoveries. Report aggregate coverage before interpreting the result, then compare your boundaries with detect_listening_eras.

Developer mode and custom MCP app availability depend on your plan and workspace settings. See the [official ChatGPT instructions](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt-beta) for current details.

### Authentication and mutation safety

ChatGPT custom apps should not rely on an arbitrary user-supplied API key or header. `LASTFM_API_KEY` remains server-side, but it is not client authentication.

`MCP_ENABLE_MUTATIONS=false` is the safe default. The server still advertises all original Last.fm tools, but sync, feedback, preference, exclusion, recommendation generation/recording, and private feedback/recommendation reads reject calls; the taste graph omits explicit preference edges. Enable them only behind trusted access control such as a private Secure MCP Tunnel or OAuth 2.1 gateway. A public no-auth endpoint with mutations enabled lets any caller read or alter your local preference database and trigger expensive syncs. Query-string tokens are intentionally unsupported because URLs are commonly recorded in logs and browser history.

Spotify tools are separately opt-in with `MCP_ENABLE_SPOTIFY_TOOLS=true`, because even their read operations expose private account data. Manual Spotify/Last.fm writes additionally require `MCP_ENABLE_MUTATIONS=true`. The automatic Spotify → Last.fm scheduler is controlled independently by `SPOTIFY_AUTO_SYNC_ENABLED`; it does not expose a public trigger or require enabling MCP writes.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `LASTFM_API_KEY` | required | Last.fm API key |
| `LASTFM_USERNAME` | required | Fixed user whose data is exposed by the MCP server |
| `LASTFM_API_BASE_URL` | official endpoint | Primarily useful for tests |
| `MCP_HOST` | `0.0.0.0` | Bind address inside the container |
| `MCP_PORT` | `3000` | Port inside the container |
| `MCP_BIND_ADDRESS` | `127.0.0.1` | Host address used to publish the Compose port |
| `MCP_PUBLIC_PORT` | `3000` | Published host port |
| `MCP_ALLOWED_HOSTS` | required for `0.0.0.0` | Host and Origin allowlist for DNS rebinding protection |
| `MCP_ENABLE_MUTATIONS` | `false` | Enable sync, feedback, exclusions, and recommendation recording only behind trusted access control |
| `LASTFM_TIMEOUT_MS` | `10000` | Timeout for one API request |
| `LASTFM_MAX_RETRIES` | `3` | Retry count for temporary and rate-limit errors |
| `LASTFM_MIN_REQUEST_INTERVAL_MS` | `250` | Minimum delay between Last.fm requests, approximately four requests per second |
| `LASTFM_CACHE_TTL_SECONDS` | `300` | In-memory cache duration for chart and info calls |
| `MUSICBRAINZ_BASE_URL` | official WS/2 endpoint | Primarily useful for tests |
| `MUSICBRAINZ_USER_AGENT` | project URL | Required MusicBrainz application identity/contact |
| `MUSICBRAINZ_TIMEOUT_MS` | `10000` | Timeout for one MusicBrainz request |
| `MUSICBRAINZ_MAX_RETRIES` | `2` | Retry count for temporary MusicBrainz errors |
| `MUSICBRAINZ_MIN_REQUEST_INTERVAL_MS` | `1100` | Serialized MusicBrainz request interval |
| `HISTORY_DB_PATH` | `/app/data/lastfm.sqlite` | SQLite database path |
| `HISTORY_LIVE_SCAN_LIMIT` | `5000` | Maximum live scan size when no index exists |
| `HISTORY_MAX_SYNC_TRACKS` | `250000` | Safety cap for one resumable sync call |

The `from` and `to` parameters accept Unix seconds, a UTC date such as `2026-08-01`, or ISO 8601 with an explicit timezone such as `2026-08-01T00:00:00Z`. A date-only `from` means 00:00:00 UTC; a date-only inclusive `to` means 23:59:59 UTC. Ambiguous local date-times without `Z` or a UTC offset are rejected.

## Intelligence methodology

- Canonicalization uses NFKC Unicode normalization, locale-independent case folding, punctuation spacing normalization, conservative trailing `feat.` removal for artist credits, and conservative remaster/deluxe suffix removal for albums. Track qualifiers remain distinct.
- Exposure levels are explicit heuristics: zero plays is `unheard`, 1–10 is `sampled`, and a one-track/one-day repeat remains `sampled` even above ten plays. Broader trials are `explored`, distributed returns are `established`, and high sustained exposure is `favorite`.
- Artist affinity scores play depth, active-day/month breadth, returning sessions, 30-day returns, and distribution. Each component and weight is returned; album-completion evidence is reported separately rather than silently folded into the score.
- Sessions default to a 45-minute inactivity gap. Album completion is only classified when MusicBrainz supplies an ordered tracklist; otherwise completion remains unknown rather than fabricated.
- Timeline buckets use UTC. Era boundaries compare monthly artist distributions statistically and preserve genuine inactive-month gaps.
- Recommendation `confidence` measures evidence coverage/consistency, not the probability that the user will like an artist. Risks always disclose missing audio-feature evidence and weak/single-cluster support.
- `safe` favors strong similarity to established seeds, `bridge` requires links to at least two tag-derived/provisional seed clusters, and `explore` favors grounded but more moderate similarity. Prior recommendation outcomes and artist-level feedback adjust ranking; album/track dislikes only remove that starting item, not the whole artist.

## Persistent local data

The SQLite volume stores:

- complete normalized scrobbles and sync status;
- canonical artist, album, and track catalogs plus aliases;
- explicit feedback and taste-dimension signals;
- recommendation exclusions and expiration policies;
- recommendation events, baseline exposure, and evaluation inputs.

This data is personal. Back up the `lastfm-data` Docker volume, and do not expose a no-auth deployment if its listening history or feedback should remain private.

## Taste profile methodology

- `coreArtists`: all-time top artists with play counts for the last three months.
- `trend`: when the local index has sufficient coverage, the most recent 30 days are compared with the preceding non-overlapping 30 days. Otherwise, the server approximately compares normalized three-month and overall shares.
- `favoriteTracks`: all-time top tracks, recent plays, and the `loved` signal.
- `recentDiscoveries`: the exact first-listen date is available only after a complete, current sync; otherwise the result is explicitly marked as an approximation.
- `forgottenFavorites`: strong all-time artists with almost no plays in the recent three-month chart.
- `repeatHeavy`: unique-track ratio and the top-ten track share across the last 90 days or the available sample.
- `albumOriented`: album metadata coverage and the share of consecutive transitions within the same album.

Every profile response contains `confidence` and `caveat` fields so the model can distinguish evidence from heuristics.

## Last.fm API limitations

- `user.getRecentTracks` returns at most 200 items per page and may include a now-playing item without a timestamp.
- Artist, album, and track history search is performed locally because Last.fm provides no equivalent server-side filter.
- MBIDs are frequently empty; the fallback identity is built from normalized names.
- MusicBrainz metadata is community-edited and may not resolve local files, obscure editions, or ambiguous names. The response reports when no ordered tracklist is available.
- MusicBrainz relationships are metadata, not a general similarity graph. Candidate generation currently uses Last.fm similar artists and the local taste graph.
- Spotify audio features and scraped recommendation sites are intentionally not used. They require separate credentials, licensing, or scraping decisions and should be integrated explicitly rather than silently.
- Last.fm does not publish a fixed numeric rate limit. The client limits its request rate and retries temporary errors `11`, `16`, and `29`, as well as HTTP `429` and `5xx`, with backoff.
- Images are intentionally neither returned nor cached because the API Terms place separate restrictions on artwork and image use.
- For commercial or research use, review the [Last.fm API Terms](https://www.last.fm/api/tos) and contact Last.fm if required.

Official methods and APIs: [Last.fm REST API](https://www.last.fm/api/rest), [user.getRecentTracks](https://www.last.fm/api/show/user.getRecentTracks), [user.getTopArtists](https://www.last.fm/api/show/user.getTopArtists), [user.getTopTracks](https://www.last.fm/api/show/user.getTopTracks), [user.getTopAlbums](https://www.last.fm/api/show/user.getTopAlbums), [user.getLovedTracks](https://www.last.fm/api/show/user.getLovedTracks), [user.getInfo](https://www.last.fm/api/show/user.getInfo), and [MusicBrainz Web Service](https://musicbrainz.org/doc/MusicBrainz_API).

## Local development

```bash
npm install
cp .env.example .env
npm run dev
```

Run checks:

```bash
npm run check
npm audit --omit=dev
docker compose build
```

The project uses the official MCP TypeScript SDK v2, the Express adapter with Host and Origin validation, Node.js 24, and the built-in `node:sqlite` module.

## Spotify setup and automatic likes sync

### Configuration and authorization

1. Create an app with Web API access in the [Spotify developer dashboard](https://developer.spotify.com/dashboard). In Development Mode, the app owner needs Premium and the account using the app must have access in its user settings. See the [Development Mode migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide).
2. Register the exact redirect URI `http://127.0.0.1:8888/callback`. Spotify permits HTTP for explicit loopback IPs, but not `localhost`; other redirects require HTTPS. See [redirect URI rules](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri).
3. Set `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, and `SPOTIFY_REDIRECT_URI` in `.env`. Set `LASTFM_API_SECRET` to the shared secret belonging to your existing `LASTFM_API_KEY`.
4. Authorize both services once. For local development, set `HISTORY_DB_PATH=./data/lastfm.sqlite` so credential files are written into the local ignored `data/` directory:

```bash
npm run auth -- spotify
npm run auth -- lastfm
```

For Docker, rebuild/recreate the service to apply code and `.env` changes, then use the same persistent container volume:

```bash
docker compose up -d --build
docker compose exec lastfm-mcp npm run auth:built -- spotify
docker compose exec lastfm-mcp npm run auth:built -- lastfm
docker compose restart lastfm-mcp
```

Spotify authorization prints a browser URL. Approve it, then paste the **full redirect URL** into the waiting CLI prompt within ten minutes. The browser may show connection refused at `127.0.0.1:8888`; that is expected because this flow reads the URL manually and opens no callback listener. It works when the CLI runs over SSH or in Docker and the browser runs on your computer. Do not paste the URL into a chat or put it in shell history. OAuth state is random, expires, and is consumed once.

The Last.fm command prints an authorization link and waits for Enter after approval. It exchanges the authorized token for a session and refuses to save a session belonging to a different `LASTFM_USERNAME`. Last.fm passwords are never requested. See [Last.fm desktop authentication](https://www.last.fm/api/authspec) and [track.love](https://www.last.fm/api/show/track.love).

If authentication succeeds but Docker reports a missing session, check where the CLI ran. `/app/data` on the host and `/app/data` inside the container are different storage locations: Compose mounts a named volume only inside the container. Run the `auth:built` commands via `docker compose exec` above so the server reads the same files. The CLI prints the saved file path and warns when host authentication uses Docker-style `/app/` paths.

Spotify requests these scopes:

```text
user-library-read user-library-modify user-read-recently-played user-top-read
playlist-read-private playlist-read-collaborative
playlist-modify-private playlist-modify-public
```

The access token refreshes automatically, including one refresh after an API `401`. Rotated refresh tokens are saved; an omitted refresh token preserves the existing one. Revoked authorization requires running the CLI again. Tokens/session keys use atomic files with mode `0600`, defaulting to `spotify-tokens.json` and `lastfm-session.json` beside `HISTORY_DB_PATH`. Docker's `/app/data` volume preserves them across restarts. Custom paths must also be private, persistent, and excluded from source control. Tokens are not encrypted on disk.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` | Unset | Both required to enable the integration |
| `SPOTIFY_REDIRECT_URI` | `http://127.0.0.1:8888/callback` | Exact registered OAuth redirect |
| `SPOTIFY_TOKEN_PATH` | Beside `HISTORY_DB_PATH` | Persistent Spotify token file |
| `LASTFM_API_SECRET` | Unset | Required for Last.fm authentication and loving tracks |
| `LASTFM_SESSION_PATH` | Beside `HISTORY_DB_PATH` | Persistent authorized Last.fm session |
| `SPOTIFY_AUTO_SYNC_ENABLED` | `true` when Spotify is configured | Automatic **Spotify → Last.fm** writes |
| `SPOTIFY_AUTO_SYNC_INTERVAL_SECONDS` | `3600` | Delay after each completed run; range 60–86400 |
| `MCP_ENABLE_SPOTIFY_TOOLS` | `false` | Expose private Spotify and cross-provider MCP tools |
| `MCP_ENABLE_MUTATIONS` | `false` | Permit manual remote writes with `dryRun=false` |

### Automatic synchronization

With both accounts authorized and `SPOTIFY_AUTO_SYNC_ENABLED=true`, the server reconciles Spotify Liked Songs with Last.fm loved tracks on startup, then one hour after each completed run. Set the interval to `300` for polling about every five minutes. This implementation polls [saved tracks](https://developer.spotify.com/documentation/web-api/reference/get-users-saved-tracks); it does not receive an instant like notification.

The first successful run imports the **entire existing liked library**, not just future likes. To preview first, set `SPOTIFY_AUTO_SYNC_ENABLED=false`, authorize, enable Spotify MCP tools behind trusted access, and call `sync_spotify_likes_to_lastfm` with `dryRun=true`. Then set the flag to `true` and recreate the container. Updating `.env` requires `docker compose up -d`; `restart` alone does not reload container environment variables.

Both directions are additive: no likes/loves are removed. If you manually unlove a track on Last.fm while keeping it liked on Spotify, the next automatic run can love it again. Last.fm → Spotify runs only when explicitly called. Automatic runs do not require enabling public MCP tools or `MCP_ENABLE_MUTATIONS`.

Each run reads full libraries with pagination, resolves missing identities, and writes only confident matches. Source duplicates are collapsed. A process-wide service guard prevents overlapping syncs; the scheduler waits for a run to finish before arming the next timer. Failed/unresolved items are reconsidered next time. A restart always reconciles current libraries, so there is no fragile timestamp watermark that can miss older likes. Run one server replica per credential store; no distributed lock is implemented.

The latest automatic result is available through `get_music_sync_status` when Spotify tools are enabled, in the log event `spotify_lastfm_auto_sync`, and in `music-sync-status.json` beside the history database. For a deployment with Spotify tools disabled:

```bash
docker compose exec lastfm-mcp cat /app/data/music-sync-status.json
```

The status file survives restarts; the MCP status describes the current process. A failed scan does not start writes. Per-track failures appear in the summary; `errorCount` is complete and `errors` contains at most 100 details. The scheduler retries on the next interval and stops scheduling new runs on shutdown.

### New MCP tools

All 13 tools below require `MCP_ENABLE_SPOTIFY_TOOLS=true`. The original 30 Last.fm tools retain their existing behavior. Put the endpoint behind trusted access before exposing Spotify's private data; Spotify account OAuth authorizes this server, not callers of `/mcp`.

| Tool | Main inputs / behavior |
| --- | --- |
| `spotify_get_liked_tracks` | `limit` (default 50, max 1000) |
| `spotify_get_recent_tracks` | `limit`; bounded by Spotify's retained recent history |
| `spotify_get_top_tracks` | `limit`, `timeRange`: `short_term`, `medium_term`, `long_term` |
| `spotify_get_top_artists` | Same range/limit inputs |
| `spotify_get_playlists` | `limit`; current user's playlists |
| `spotify_search_track` | `artist`, `title`; up to 10 catalog candidates |
| `spotify_create_playlist` | `name`, optional `description`, `tracks`, `public`, `dryRun` |
| `spotify_add_tracks_to_playlist` | `playlistId`, `tracks`, `dryRun` |
| `create_spotify_playlist_from_tracks` | `name`, `tracks`, optional `description`, `public`, `dryRun` |
| `sync_spotify_likes_to_lastfm` | `dryRun`; complete library reconciliation |
| `sync_lastfm_loves_to_spotify` | `dryRun`; complete reverse reconciliation |
| `compare_spotify_lastfm_library` | Read-only differences, ambiguity/unresolved counts; `limit` and `offset` paginate returned details |
| `get_music_sync_status` | No inputs; scheduler status and most recent result |

Read tools paginate internally up to their requested result limit; sync and comparison load all available library pages. Returned tracks contain artist, title, provider identity, album/duration when available, and timestamps where relevant. Search results are candidates rather than asserted matches.

Example MCP arguments (use these objects when calling the named tool):

```json
{"name":"sync_spotify_likes_to_lastfm","arguments":{"dryRun":true}}
```

```json
{"name":"sync_lastfm_loves_to_spotify","arguments":{"dryRun":false}}
```

```json
{"name":"compare_spotify_lastfm_library","arguments":{"limit":100,"offset":0}}
```

```json
{"name":"create_spotify_playlist_from_tracks","arguments":{"name":"Favorites","tracks":["spotify:track:4iV5W9uYEdYUVa79Axb7Rh"],"public":false,"dryRun":true}}
```

All mutating tools default to `dryRun=true`. Real manual writes require `MCP_ENABLE_MUTATIONS=true`. Sync summaries include `scanned`, `duplicates`, `alreadySynced`, `wouldAdd`, `added`, `unmatched`, `ambiguous`, `probable`, `errorCount`, and bounded `errors`. `wouldAdd` counts planned unique additions; `added` counts confirmed writes and stays zero during a dry run. `probable` is a subset of `unmatched`. `duplicates` includes repeated source identities and distinct source entries resolving to the same planned destination; counters should not be blindly summed.

Playlist creation deduplicates input IDs/URIs; explicit appends preserve supplied ordering and duplicates. Playlist creation/appending is not idempotent. If appending fails after creation, the result includes `partial=true` and the created playlist, so inspect/resume it rather than creating another playlist. Failed appends report how many items were confirmed before the failed batch; a timeout can leave that batch's outcome unknown.

### Matching and API limits

- Unicode NFKC/case folding, whitespace, typographic punctuation, equivalent `feat.`/`ft.`/`featuring` title markers, and explicit remaster suffixes are normalized. Generic edition/version labels, live, acoustic, remix, radio-edit and other recording qualifiers remain significant.
- Matching MBIDs or Spotify IDs are strong identity evidence. Conflicting MBIDs are rejected. Spotify does not supply MBIDs, so no MBID is invented from an artist/title pair.
- Only `exact` and `normalized_exact` matches can be written. Multiple equally strong candidates are `ambiguous`. Missing feature credits or lossy punctuation matches are `probable` and skipped. Different featured performers are not silently equated.
- Last.fm resolution uses `track.getInfo` with autocorrection disabled and may retry an explicit remaster title without its label. Spotify resolution searches up to ten candidates. Catalog aliases, absent metadata, region restrictions and multiple releases can remain unresolved; catalog-wide uniqueness is not guaranteed by a bounded search.
- Last.fm may canonicalize names when saving loves (for example, Latin `Flëur` becomes `Flёur` with Cyrillic `ё`). Before writing a resolved missing track, `track.getCorrection` checks whether its provider-confirmed canonical identity is already loved. This prevents repeated writes without globally equating lookalike characters or relaxing the matching rules for new writes.
- Full-library polling favors recovery and correctness over minimum API traffic. The first import and comparisons can be slow for large libraries. Libraries can change while offset pages are fetched; subsequent automatic runs reconcile again. No cross-provider transaction or removal propagation is implemented.
- The client uses the current [save-library endpoint](https://developer.spotify.com/documentation/web-api/reference/save-library-items) (`PUT /me/library`, up to 40 URIs), [current-user playlist creation](https://developer.spotify.com/documentation/web-api/reference/create-playlist) (`POST /me/playlists`), and [playlist items endpoint](https://developer.spotify.com/documentation/web-api/reference/add-items-to-playlist) (`POST /playlists/{id}/items`, up to 100 items). Deprecated write routes are not used.
- `429 Retry-After` is respected with bounded retries; waits over 60 seconds fail the current operation and retain a client cooldown. Account `QUOTA_EXCEEDED` fails immediately. Since July 2026, Development Mode quotas are [shared per developer account](https://developer.spotify.com/documentation/web-api/references/changes/july-2026).
- Playlists default to `public=false`. Spotify's [playlist visibility documentation](https://developer.spotify.com/documentation/web-api/concepts/playlists) distinguishes profile publication from link access; this setting is not a guarantee that a playlist link is inaccessible to others.

### Implementation and validation

`src/providers/spotify/` owns OAuth, token refresh, normalized API responses, pagination, and write batching. `LastFmClient` adds full loved-library reads, track resolution and signed writes without replacing existing reads. `track-identity.ts` implements conservative cross-provider identity; it deliberately does not change the existing history canonicalization rules. `MusicLibraryService` owns sync, comparison and playlist orchestration; `MusicSyncScheduler` owns background execution. MCP registration only validates inputs and delegates. No new dependencies were added.

Mock API tests cover OAuth state/scopes and refresh-token preservation, concurrent refresh, pagination, unsafe/repeated pagination links, current Spotify write routes/batches, rate limits, Last.fm signatures and account validation, normalization/version/feature cases, ambiguity, duplicate inputs, idempotent syncs in both directions, dry-run, partial failures, MCP flags/defaults, scheduler persistence/retry/shutdown, and the original Last.fm surface. Run `npm run check` for strict type checking, the full test suite, and build. Real-account OAuth and live writes must be verified after configuring credentials.

Potential next steps are a reviewed mapping-override store for ambiguous tracks and a durable resolution cache to reduce repeated catalog lookups. Recommendation algorithms and new analytics playlist logic are intentionally left for later.
