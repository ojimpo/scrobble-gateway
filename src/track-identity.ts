import { canonicalKey, canonicalizeArtist, normalizeDisplayName } from "./canonicalization.js";

export interface TrackIdentity {
  artist: string;
  title: string;
  spotifyId?: string;
  spotifyUri?: string;
  mbid?: string;
  lastfmUrl?: string;
  normalizedArtist: string;
  normalizedTitle: string;
}

export type MatchStatus = "exact" | "normalized_exact" | "probable" | "ambiguous" | "unmatched";
export type TrackMatch<T extends TrackIdentity = TrackIdentity> = { status: MatchStatus; candidates: T[]; track?: T };

/** Only explicit remaster labels are interchangeable. Live/remix/acoustic/edits stay distinct. */
export function stripRemaster(title: string): string {
  let result = normalizeDisplayName(title);
  const label = "(?:(?:19|20)\\d{2}\\s+)?remaster(?:ed)?(?:\\s+(?:in\\s+)?(?:19|20)\\d{2})?";
  const suffix = new RegExp(`(?:\\s*\\(${label}\\)|\\s*\\[${label}\\]|\\s+-\\s+${label})$`, "iu");
  for (let i = 0; i < 4; i++) result = result.replace(suffix, "").trim();
  return result;
}

function titleKey(title: string): string {
  return canonicalKey(stripRemaster(title)).replace(/\b(?:featuring|feat|ft)\.?\s*/gu, "feat ");
}

export function trackIdentity(input: Omit<TrackIdentity, "normalizedArtist" | "normalizedTitle">): TrackIdentity {
  return { ...input, normalizedArtist: canonicalKey(input.artist), normalizedTitle: titleKey(input.title) };
}

export function identityKey(track: TrackIdentity): string {
  return JSON.stringify([track.normalizedArtist, track.normalizedTitle]);
}

export function uniqueTracks<T extends TrackIdentity>(tracks: T[]): T[] {
  return [...new Map(tracks.map((track) => [track.spotifyId || track.mbid || identityKey(track), track])).values()];
}

function probableKey(track: TrackIdentity): string {
  const loose = (s: string) => canonicalKey(s).replace(/[\p{P}\p{Z}]/gu, "");
  return JSON.stringify([loose(canonicalizeArtist(track.artist).canonicalName),
    loose(canonicalizeArtist(stripRemaster(track.title)).canonicalName)]);
}

/** Restrict candidate scoring to indexed identities instead of quadratic full-library comparisons. */
export class TrackIdentityIndex<T extends TrackIdentity = TrackIdentity> {
  private readonly buckets = new Map<string, T[]>();
  constructor(tracks: T[]) { for (const track of tracks) this.add(track); }
  add(track: T): void {
    for (const key of this.keys(track)) {
      const bucket = this.buckets.get(key) ?? [];
      bucket.push(track); this.buckets.set(key, bucket);
    }
  }
  resolve(source: TrackIdentity): TrackMatch<T> {
    return resolveTrack(source, [...new Set(this.keys(source).flatMap((key) => this.buckets.get(key) ?? []))]);
  }
  private keys(track: TrackIdentity): string[] {
    return [`normalized:${identityKey(track)}`, `probable:${probableKey(track)}`,
      ...(track.spotifyId ? [`spotify:${track.spotifyId}`] : []), ...(track.mbid ? [`mbid:${track.mbid}`] : [])];
  }
}

function score(a: TrackIdentity, b: TrackIdentity): number {
  if (a.spotifyId && b.spotifyId && a.spotifyId === b.spotifyId) return 3;
  if (a.mbid && b.mbid) return a.mbid === b.mbid ? 3 : 0;
  if (!a.normalizedArtist || !a.normalizedTitle || !b.normalizedArtist || !b.normalizedTitle) return 0;
  if (a.artist === b.artist && a.title === b.title) return 3;
  if (a.normalizedArtist === b.normalizedArtist && a.normalizedTitle === b.normalizedTitle) return 2;
  // Missing feature credits and punctuation differences are evidence for review, never automatic writes.
  if (probableKey(a) === probableKey(b)) return 1;
  return 0;
}

export function resolveTrack<T extends TrackIdentity>(source: TrackIdentity, candidates: T[]): TrackMatch<T> {
  const ranked = uniqueTracks(candidates).map((track) => ({ track, score: score(source, track) })).filter((item) => item.score > 0);
  const best = Math.max(0, ...ranked.map((item) => item.score));
  const matches = ranked.filter((item) => item.score === best).map((item) => item.track);
  if (matches.length === 0) return { status: "unmatched", candidates: [] };
  if (matches.length > 1) return { status: "ambiguous", candidates: matches };
  const track = matches[0]!;
  return { status: best === 3 ? "exact" : best === 2 ? "normalized_exact" : "probable", candidates: matches, track };
}

export function isSafeMatch(match: TrackMatch): boolean {
  return match.status === "exact" || match.status === "normalized_exact";
}
