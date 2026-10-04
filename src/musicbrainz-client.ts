type FetchLike = typeof fetch;
type JsonRecord = Record<string, unknown>;

export type MusicBrainzClientOptions = {
  /** MusicBrainz requires an identifiable value such as `my-app/1.0 (me@example.com)`. */
  userAgent: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Defaults to 1.1 seconds, keeping the client below MusicBrainz's one-request-per-second limit. */
  minRequestIntervalMs?: number;
  fetchImpl?: FetchLike;
};

export type MusicBrainzLifeSpan = {
  begin: string | null;
  end: string | null;
  ended: boolean;
};

export type MusicBrainzArea = {
  mbid: string;
  name: string;
  sortName: string | null;
  countryCodes: string[];
};

export type ResolvedArtist = {
  mbid: string;
  name: string;
  sortName: string | null;
  disambiguation: string | null;
  type: string | null;
  country: string | null;
  area: MusicBrainzArea | null;
  beginArea: MusicBrainzArea | null;
  endArea: MusicBrainzArea | null;
  lifeSpan: MusicBrainzLifeSpan;
  /** Present for search results and null for direct MBID lookups. */
  score: number | null;
};

export type MusicBrainzTag = {
  name: string;
  count: number;
  disambiguation: string | null;
};

export type MusicBrainzRelationTarget = {
  type: string;
  mbid: string | null;
  name: string | null;
  disambiguation: string | null;
  url: string | null;
};

export type MusicBrainzRelation = {
  type: string;
  targetType: string;
  direction: string | null;
  begin: string | null;
  end: string | null;
  ended: boolean;
  attributes: string[];
  target: MusicBrainzRelationTarget;
};

export type ArtistFeatures = {
  artist: ResolvedArtist;
  genres: MusicBrainzTag[];
  tags: MusicBrainzTag[];
  relations: MusicBrainzRelation[];
};

export type MusicBrainzArtistCredit = {
  name: string;
  joinPhrase: string;
  artistMbid: string | null;
  artistName: string | null;
};

export type ResolvedReleaseGroup = {
  mbid: string;
  title: string;
  disambiguation: string | null;
  primaryType: string | null;
  secondaryTypes: string[];
  firstReleaseDate: string | null;
  artistCredit: string;
  artists: MusicBrainzArtistCredit[];
  /** Present for search results and null for direct MBID lookups. */
  score: number | null;
};

export type MusicBrainzTrack = {
  position: number;
  number: string | null;
  /** Recording title when available, otherwise the release track title. */
  title: string;
  trackTitle: string | null;
  recordingTitle: string | null;
  recordingMbid: string | null;
  durationMs: number | null;
  artistCredit: string | null;
  artists: MusicBrainzArtistCredit[];
};

export type MusicBrainzMedium = {
  position: number;
  title: string | null;
  format: string | null;
  trackCount: number;
  tracks: MusicBrainzTrack[];
};

export type MusicBrainzRelease = {
  mbid: string;
  title: string;
  disambiguation: string | null;
  status: string | null;
  date: string | null;
  country: string | null;
  barcode: string | null;
  packaging: string | null;
  mediumCount: number;
  trackCount: number;
};

export type AlbumTracklist = {
  releaseGroup: ResolvedReleaseGroup;
  release: MusicBrainzRelease;
  media: MusicBrainzMedium[];
  totalTracks: number;
};

export class MusicBrainzApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retriable: boolean,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "MusicBrainzApiError";
  }
}

type ResolvedReleaseGroupReference = {
  releaseGroup: ResolvedReleaseGroup;
  exactReleaseMbid: string | null;
};

const DEFAULT_BASE_URL = "https://musicbrainz.org/ws/2/";

/** A small, keyless client for the public MusicBrainz WS/2 JSON API. */
export class MusicBrainzClient {
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly minRequestIntervalMs: number;
  private requestQueue: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(private readonly options: MusicBrainzClientOptions) {
    const userAgent = options.userAgent.trim();
    if (!userAgent) throw new Error("A meaningful MusicBrainz userAgent is required");

    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = ensureTrailingSlash(options.baseUrl ?? DEFAULT_BASE_URL);
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.minRequestIntervalMs = options.minRequestIntervalMs ?? 1_100;

    if (this.timeoutMs <= 0) throw new Error("MusicBrainz timeoutMs must be positive");
    if (this.maxRetries < 0) throw new Error("MusicBrainz maxRetries cannot be negative");
    if (this.minRequestIntervalMs < 0) throw new Error("MusicBrainz minRequestIntervalMs cannot be negative");
  }

  async resolveArtist(name: string, mbid?: string | null): Promise<ResolvedArtist | null> {
    if (mbid?.trim()) {
      const response = await this.lookupOrNull("artist", mbid.trim());
      return response ? normalizeArtist(response, null) : null;
    }

    const queryName = name.trim();
    if (!queryName) return null;
    const response = await this.request("artist", {
      query: `artist:${lucenePhrase(queryName)}`,
      limit: 10,
    });
    const artists = array(response.artists)
      .map((item) => normalizeArtist(record(item), integer(record(item).score)))
      .filter(hasIdentity);
    return bestNamedMatch(artists, queryName, (artist) => artist.name);
  }

  async getArtistFeatures(name: string, mbid?: string | null): Promise<ArtistFeatures | null> {
    const resolved = mbid?.trim() ? null : await this.resolveArtist(name);
    const artistMbid = mbid?.trim() || resolved?.mbid;
    if (!artistMbid) return null;

    const response = await this.lookupOrNull("artist", artistMbid, {
      inc: "genres+tags+url-rels+artist-rels+work-rels+release-group-rels",
    });
    if (!response) return null;

    return {
      artist: normalizeArtist(response, null),
      genres: normalizeTags(response.genres),
      tags: normalizeTags(response.tags),
      relations: array(response.relations).map(normalizeRelation).filter((relation) => relation.type.length > 0),
    };
  }

  async getArtistReleaseGroups(
    name: string,
    mbid?: string | null,
    limit = 25,
  ): Promise<ResolvedReleaseGroup[]> {
    const resolved = mbid?.trim() ? null : await this.resolveArtist(name);
    const artistMbid = mbid?.trim() || resolved?.mbid;
    if (!artistMbid) return [];
    const response = await this.request("release-group", {
      artist: artistMbid,
      inc: "artist-credits",
      limit: Math.min(Math.max(Math.trunc(limit), 1), 100),
    });
    return array(response["release-groups"])
      .map((item) => normalizeReleaseGroup(record(item), null))
      .filter((group) => group.primaryType === "Album" || group.primaryType === "EP")
      .sort((left, right) => sortableDate(right.firstReleaseDate) - sortableDate(left.firstReleaseDate))
      .slice(0, limit);
  }

  async resolveReleaseGroup(
    artist: string,
    album: string,
    mbid?: string | null,
  ): Promise<ResolvedReleaseGroup | null> {
    return (await this.resolveReleaseGroupReference(artist, album, mbid))?.releaseGroup ?? null;
  }

  async getAlbumTracklist(
    artist: string,
    album: string,
    mbid?: string | null,
  ): Promise<AlbumTracklist | null> {
    const reference = await this.resolveReleaseGroupReference(artist, album, mbid);
    if (!reference) return null;

    let releaseMbid = reference.exactReleaseMbid;
    if (!releaseMbid) {
      const response = await this.request("release", {
        "release-group": reference.releaseGroup.mbid,
        inc: "artist-credits",
        limit: 100,
      });
      releaseMbid = chooseRelease(array(response.releases), album, reference.releaseGroup.firstReleaseDate);
    }
    if (!releaseMbid) return null;

    const response = await this.lookupOrNull("release", releaseMbid, {
      inc: "recordings+artist-credits",
    });
    if (!response) return null;

    const media = array(response.media)
      .map((item, index) => normalizeMedium(record(item), index))
      .sort(byPosition);
    const totalTracks = media.reduce((sum, medium) => sum + medium.tracks.length, 0);
    return {
      releaseGroup: reference.releaseGroup,
      release: normalizeRelease(response, media.length, totalTracks),
      media,
      totalTracks,
    };
  }

  private async resolveReleaseGroupReference(
    artist: string,
    album: string,
    mbid?: string | null,
  ): Promise<ResolvedReleaseGroupReference | null> {
    const suppliedMbid = mbid?.trim();
    if (suppliedMbid) {
      const releaseGroup = await this.lookupOrNull("release-group", suppliedMbid, { inc: "artist-credits" });
      if (releaseGroup) {
        return { releaseGroup: normalizeReleaseGroup(releaseGroup, null), exactReleaseMbid: null };
      }

      // Last.fm album MBIDs are often release MBIDs rather than release-group MBIDs.
      const release = await this.lookupOrNull("release", suppliedMbid, {
        inc: "release-groups+artist-credits",
      });
      const nestedReleaseGroup = release ? record(release["release-group"]) : {};
      if (text(nestedReleaseGroup.id)) {
        return {
          releaseGroup: normalizeReleaseGroup(nestedReleaseGroup, null),
          exactReleaseMbid: suppliedMbid,
        };
      }
      return null;
    }

    const artistName = artist.trim();
    const albumTitle = album.trim();
    if (!artistName || !albumTitle) return null;
    const response = await this.request("release-group", {
      query: `releasegroup:${lucenePhrase(albumTitle)} AND artist:${lucenePhrase(artistName)}`,
      limit: 10,
    });
    const releaseGroups = array(response["release-groups"])
      .map((item) => normalizeReleaseGroup(record(item), integer(record(item).score)))
      .filter(hasIdentity);
    const best = bestNamedMatch(releaseGroups, albumTitle, (group) => group.title);
    return best ? { releaseGroup: best, exactReleaseMbid: null } : null;
  }

  private async lookupOrNull(
    entity: string,
    mbid: string,
    params: Record<string, string | number | undefined> = {},
  ): Promise<JsonRecord | null> {
    try {
      return await this.request(`${entity}/${encodeURIComponent(mbid)}`, params);
    } catch (error) {
      if (error instanceof MusicBrainzApiError && error.status === 404) return null;
      throw error;
    }
  }

  private async request(
    resource: string,
    params: Record<string, string | number | undefined>,
  ): Promise<JsonRecord> {
    const url = new URL(resource.replace(/^\/+/, ""), this.baseUrl);
    url.searchParams.set("fmt", "json");
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        await this.waitForRateLimit();
        const response = await this.fetchImpl(url, {
          headers: {
            accept: "application/json",
            "user-agent": this.options.userAgent.trim(),
          },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const body = await parseJsonResponse(response);
        if (!response.ok) {
          const retriable = response.status === 429 || response.status >= 500;
          throw new MusicBrainzApiError(
            text(body.error) || text(body.message) || `MusicBrainz returned HTTP ${response.status}`,
            response.status,
            retriable,
            parseRetryAfter(response.headers.get("retry-after")),
          );
        }
        return body;
      } catch (error) {
        lastError = error;
        const retriable = error instanceof MusicBrainzApiError ? error.retriable : isNetworkError(error);
        if (!retriable || attempt >= this.maxRetries) break;
        const retryAfterMs = error instanceof MusicBrainzApiError ? error.retryAfterMs : null;
        await delay(retryAfterMs ?? Math.min(5_000, 250 * 2 ** attempt));
      }
    }

    if (lastError instanceof MusicBrainzApiError) throw lastError;
    const message = lastError instanceof Error ? lastError.message : "Unknown MusicBrainz request error";
    throw new MusicBrainzApiError(`MusicBrainz request failed: ${message}`, null, isNetworkError(lastError));
  }

  private async waitForRateLimit(): Promise<void> {
    const previous = this.requestQueue;
    let release: () => void = () => undefined;
    this.requestQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const waitMs = Math.max(0, this.lastRequestAt + this.minRequestIntervalMs - Date.now());
      if (waitMs > 0) await delay(waitMs);
      this.lastRequestAt = Date.now();
    } finally {
      release();
    }
  }
}

function normalizeArtist(value: JsonRecord, score: number | null): ResolvedArtist {
  return {
    mbid: text(value.id),
    name: text(value.name),
    sortName: nullableText(value["sort-name"]),
    disambiguation: nullableText(value.disambiguation),
    type: nullableText(value.type),
    country: nullableText(value.country),
    area: normalizeArea(value.area),
    beginArea: normalizeArea(value["begin-area"]),
    endArea: normalizeArea(value["end-area"]),
    lifeSpan: normalizeLifeSpan(value["life-span"]),
    score,
  };
}

function normalizeArea(value: unknown): MusicBrainzArea | null {
  const area = record(value);
  if (!text(area.id) && !text(area.name)) return null;
  return {
    mbid: text(area.id),
    name: text(area.name),
    sortName: nullableText(area["sort-name"]),
    countryCodes: stringArray(area["iso-3166-1-codes"]),
  };
}

function normalizeLifeSpan(value: unknown): MusicBrainzLifeSpan {
  const lifeSpan = record(value);
  return {
    begin: nullableText(lifeSpan.begin),
    end: nullableText(lifeSpan.end),
    ended: boolean(lifeSpan.ended),
  };
}

function normalizeTags(value: unknown): MusicBrainzTag[] {
  return array(value)
    .map((item) => {
      const tag = record(item);
      return {
        name: text(tag.name),
        count: integer(tag.count) ?? 0,
        disambiguation: nullableText(tag.disambiguation),
      };
    })
    .filter((tag) => tag.name.length > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function normalizeRelation(value: unknown): MusicBrainzRelation {
  const relation = record(value);
  const targetType = text(relation["target-type"]);
  const targetValue = relationTarget(relation, targetType);
  const target = record(targetValue);
  const isUrl = targetType === "url";
  return {
    type: text(relation.type),
    targetType,
    direction: nullableText(relation.direction),
    begin: nullableText(relation.begin),
    end: nullableText(relation.end),
    ended: boolean(relation.ended),
    attributes: stringArray(relation.attributes),
    target: {
      type: targetType,
      mbid: nullableText(target.id),
      name: nullableText(target.name) ?? nullableText(target.title),
      disambiguation: nullableText(target.disambiguation),
      url: isUrl ? nullableText(target.resource) : null,
    },
  };
}

function relationTarget(relation: JsonRecord, targetType: string): unknown {
  const candidates = [targetType, targetType.replaceAll("-", "_"), targetType.replaceAll("_", "-")];
  for (const candidate of candidates) {
    if (relation[candidate] !== undefined) return relation[candidate];
  }
  return undefined;
}

function normalizeReleaseGroup(value: JsonRecord, score: number | null): ResolvedReleaseGroup {
  const artists = normalizeArtistCredits(value["artist-credit"]);
  return {
    mbid: text(value.id),
    title: text(value.title),
    disambiguation: nullableText(value.disambiguation),
    primaryType: nullableText(value["primary-type"]),
    secondaryTypes: stringArray(value["secondary-types"]),
    firstReleaseDate: nullableText(value["first-release-date"]),
    artistCredit: renderArtistCredit(artists),
    artists,
    score,
  };
}

function normalizeArtistCredits(value: unknown): MusicBrainzArtistCredit[] {
  return array(value)
    .map((item) => {
      const credit = record(item);
      const artist = record(credit.artist);
      return {
        name: text(credit.name) || text(artist.name),
        joinPhrase: text(credit.joinphrase),
        artistMbid: nullableText(artist.id),
        artistName: nullableText(artist.name),
      };
    })
    .filter((credit) => credit.name.length > 0);
}

function renderArtistCredit(credits: MusicBrainzArtistCredit[]): string {
  return credits.map((credit) => `${credit.name}${credit.joinPhrase}`).join("");
}

function chooseRelease(releases: unknown[], album: string, firstReleaseDate: string | null): string | null {
  const normalizedAlbum = comparable(album);
  return releases
    .map((item) => record(item))
    .filter((release) => text(release.id).length > 0)
    .map((release) => ({
      release,
      score:
        (comparable(text(release.status)) === "official" ? 100 : 0) +
        (comparable(text(release.title)) === normalizedAlbum ? 40 : 0) +
        (firstReleaseDate && text(release.date) === firstReleaseDate ? 20 : 0) +
        (array(release.media).length > 0 ? 5 : 0),
    }))
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      const aDate = text(a.release.date) || "9999";
      const bDate = text(b.release.date) || "9999";
      return aDate.localeCompare(bDate) || text(a.release.id).localeCompare(text(b.release.id));
    })[0]
    ?.release.id?.toString() ?? null;
}

function normalizeMedium(value: JsonRecord, index: number): MusicBrainzMedium {
  const tracks = array(value.tracks)
    .map((item, trackIndex) => normalizeTrack(record(item), trackIndex))
    .sort(byPosition);
  return {
    position: integer(value.position) ?? index + 1,
    title: nullableText(value.title),
    format: nullableText(value.format),
    trackCount: integer(value["track-count"]) ?? tracks.length,
    tracks,
  };
}

function normalizeTrack(value: JsonRecord, index: number): MusicBrainzTrack {
  const recording = record(value.recording);
  const trackTitle = nullableText(value.title);
  const recordingTitle = nullableText(recording.title);
  const artists = normalizeArtistCredits(recording["artist-credit"] ?? value["artist-credit"]);
  return {
    position: integer(value.position) ?? index + 1,
    number: nullableText(value.number),
    title: recordingTitle ?? trackTitle ?? "",
    trackTitle,
    recordingTitle,
    recordingMbid: nullableText(recording.id),
    durationMs: integer(value.length) ?? integer(recording.length),
    artistCredit: nullableText(renderArtistCredit(artists)),
    artists,
  };
}

function normalizeRelease(value: JsonRecord, mediumCount: number, trackCount: number): MusicBrainzRelease {
  return {
    mbid: text(value.id),
    title: text(value.title),
    disambiguation: nullableText(value.disambiguation),
    status: nullableText(value.status),
    date: nullableText(value.date),
    country: nullableText(value.country),
    barcode: nullableText(value.barcode),
    packaging: nullableText(value.packaging),
    mediumCount,
    trackCount,
  };
}

function bestNamedMatch<T extends { score: number | null }>(
  candidates: T[],
  expected: string,
  nameOf: (candidate: T) => string,
): T | null {
  const normalizedExpected = comparable(expected);
  return [...candidates].sort((a, b) => {
    const aExact = comparable(nameOf(a)) === normalizedExpected ? 1 : 0;
    const bExact = comparable(nameOf(b)) === normalizedExpected ? 1 : 0;
    return bExact - aExact || (b.score ?? 0) - (a.score ?? 0);
  })[0] ?? null;
}

function comparable(value: string): string {
  return value.trim().normalize("NFKC").toLocaleLowerCase("en");
}

function lucenePhrase(value: string): string {
  return `"${value.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, "\\$&")}"`;
}

function hasIdentity(value: { mbid: string }): boolean {
  return value.mbid.length > 0;
}

function byPosition<T extends { position: number }>(a: T, b: T): number {
  return a.position - b.position;
}

async function parseJsonResponse(response: Response): Promise<JsonRecord> {
  const raw = await response.text();
  if (!raw.trim()) return {};
  try {
    return record(JSON.parse(raw));
  } catch {
    if (!response.ok) return {};
    throw new MusicBrainzApiError("MusicBrainz returned invalid JSON", response.status, false);
  }
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name));
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

function nullableText(value: unknown): string | null {
  return text(value) || null;
}

function stringArray(value: unknown): string[] {
  return array(value).map(text).filter(Boolean);
}

function integer(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function boolean(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sortableDate(value: string | null): number {
  if (!value) return 0;
  const normalized = value.length === 4 ? `${value}-01-01` : value.length === 7 ? `${value}-01` : value;
  const milliseconds = Date.parse(normalized);
  return Number.isFinite(milliseconds) ? milliseconds : 0;
}
