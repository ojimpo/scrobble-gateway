/**
 * Deterministic, dependency-free canonicalization for names found in Last.fm
 * scrobbles.
 *
 * A canonical key is suitable for equality/grouping in SQLite. A canonical
 * name is a cleaned display value; its original casing is deliberately kept
 * because choosing the "correct" casing requires an authoritative metadata
 * source such as MusicBrainz.
 */

export type CanonicalizedName = {
  canonicalName: string;
  key: string;
  aliases: string[];
};

export type CanonicalizedArtist = CanonicalizedName & {
  /** The unsplit featured-artist credit. It is kept whole to avoid guessing at band names containing '&' or 'and'. */
  featuredArtists: string[];
};

export type CanonicalizedAlbum = CanonicalizedName & {
  /** A recognized trailing edition label, or null when the title is left intact. */
  edition: string | null;
};

const INVISIBLE_FORMATTING = /[\u00ad\u200b\u2060\ufeff]/gu;
const APOSTROPHES = /[\u2018\u2019\u201a\u201b\u2032\uff07]/gu;
const DOUBLE_QUOTES = /[\u201c\u201d\u201e\u201f\u2033\uff02]/gu;
const DASHES = /[\u058a\u05be\u1400\u1806\u2010-\u2015\u2212\u2e17\u2e1a\u2e3a-\u2e3b\u2e40\u301c\u3030\u30a0\ufe31-\ufe32\ufe58\ufe63\uff0d]/gu;
const SLASHES = /[\u2044\u2215\uff0f]/gu;
const WHITESPACE = /\s+/gu;

/**
 * Cleans a value for display without discarding meaningful punctuation,
 * accents, parenthetical qualifiers, or words.
 */
export function normalizeDisplayName(name: string): string {
  return name
    .normalize("NFKC")
    .replace(INVISIBLE_FORMATTING, "")
    .replace(APOSTROPHES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(DASHES, "-")
    .replace(SLASHES, "/")
    .replace(WHITESPACE, " ")
    .trim();
}

/**
 * Builds a stable lookup key. Spaces around punctuation are insignificant,
 * but punctuation itself is retained: for example, `P!nk` and `Pink` remain
 * different artists, as do `Love/Hate` and `Love Hate`.
 */
export function canonicalKey(name: string): string {
  return unicodeCaseFold(normalizeDisplayName(name))
    .replace(/\s*([!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~])\s*/gu, "$1")
    .replace(WHITESPACE, " ")
    .trim();
}

export function canonicalizeArtist(name: string): CanonicalizedArtist {
  const normalized = normalizeDisplayName(name);
  if (normalized === "") {
    return { canonicalName: "", key: "", aliases: [], featuredArtists: [] };
  }

  const credit = splitFeaturedArtistCredit(normalized);
  const canonicalName = credit?.primary ?? normalized;
  return {
    canonicalName,
    key: canonicalKey(canonicalName),
    aliases: uniqueAliases([normalized, canonicalName]),
    featuredArtists: credit ? [credit.featured] : [],
  };
}

export function canonicalizeAlbum(name: string): CanonicalizedAlbum {
  const normalized = normalizeDisplayName(name);
  if (normalized === "") {
    return { canonicalName: "", key: "", aliases: [], edition: null };
  }

  const stripped = stripAlbumEditionSuffixes(normalized);
  return {
    canonicalName: stripped.base,
    key: canonicalKey(stripped.base),
    aliases: uniqueAliases([normalized, stripped.base]),
    edition: stripped.edition,
  };
}

/** Track qualifiers are never stripped: `Song (Live)` and `Song` are distinct recordings. */
export function canonicalizeTrack(name: string): CanonicalizedName {
  const canonicalName = normalizeDisplayName(name);
  if (canonicalName === "") return { canonicalName: "", key: "", aliases: [] };
  return {
    canonicalName,
    key: canonicalKey(canonicalName),
    aliases: [canonicalName],
  };
}

export function extractArtistAliases(name: string): string[] {
  return canonicalizeArtist(name).aliases;
}

export function extractAlbumAliases(name: string): string[] {
  return canonicalizeAlbum(name).aliases;
}

function unicodeCaseFold(value: string): string {
  // JavaScript does not expose Unicode's CaseFolding.txt directly. Locale-free
  // lowercasing plus the two common multi/contextual folds below gives stable
  // default-case-fold behavior for music metadata without removing accents.
  return value
    .toLocaleLowerCase("und")
    .replace(/\u00df/gu, "ss")
    .replace(/\u03c2/gu, "\u03c3");
}

function splitFeaturedArtistCredit(value: string): { primary: string; featured: string } | null {
  // Bracketed credits must occupy the complete trailing group.
  const bracketed = /^(?<primary>.+?)\s*[([]\s*(?:feat(?:uring)?|ft)\.?\s+(?<featured>[^\])]+)\s*[\])]$/iu.exec(value);
  if (bracketed?.groups) {
    return validCredit(bracketed.groups.primary, bracketed.groups.featured);
  }

  // Do not treat "with", "and", "&", "x", or a mid-word "feat" as a
  // feature credit: those forms are too often part of the actual artist name.
  const plain = /^(?<primary>.+?)\s+(?:feat(?:uring)?|ft)\.?\s+(?<featured>.+)$/iu.exec(value);
  if (!plain?.groups) return null;
  return validCredit(plain.groups.primary, plain.groups.featured);
}

function validCredit(primaryValue: string | undefined, featuredValue: string | undefined): {
  primary: string;
  featured: string;
} | null {
  const primary = normalizeDisplayName(primaryValue ?? "");
  const featured = normalizeDisplayName(featuredValue ?? "");
  return primary !== "" && featured !== "" ? { primary, featured } : null;
}

function stripAlbumEditionSuffixes(value: string): { base: string; edition: string | null } {
  let base = value;
  const editions: string[] = [];

  // Multiple explicit labels occasionally stack, e.g. "Album (Deluxe
  // Edition) [2024 Remaster]". The small limit guarantees bounded behavior.
  for (let index = 0; index < 4; index += 1) {
    const candidate = trailingAlbumSuffix(base);
    if (!candidate || !isEditionLabel(candidate.suffix, candidate.bracketed)) break;
    editions.unshift(candidate.suffix);
    base = candidate.base;
  }

  return {
    base,
    edition: editions.length > 0 ? editions.join("; ") : null,
  };
}

function trailingAlbumSuffix(value: string): { base: string; suffix: string; bracketed: boolean } | null {
  const parenthesized = /^(?<base>.+?)\s*\((?<suffix>[^()]*)\)$/u.exec(value);
  if (parenthesized?.groups) {
    return suffixParts(parenthesized.groups.base, parenthesized.groups.suffix, true);
  }

  const squareBracketed = /^(?<base>.+?)\s*\[(?<suffix>[^\[\]]*)\]$/u.exec(value);
  if (squareBracketed?.groups) {
    return suffixParts(squareBracketed.groups.base, squareBracketed.groups.suffix, true);
  }

  // A spaced dash is treated as a release-label separator. A hyphen inside a
  // title is not. Use the last separator so titles containing earlier dashes
  // remain intact.
  const separator = value.lastIndexOf(" - ");
  if (separator <= 0) return null;
  return suffixParts(value.slice(0, separator), value.slice(separator + 3), false);
}

function suffixParts(baseValue: string | undefined, suffixValue: string | undefined, bracketed: boolean): {
  base: string;
  suffix: string;
  bracketed: boolean;
} | null {
  const base = normalizeDisplayName(baseValue ?? "");
  const suffix = normalizeDisplayName(suffixValue ?? "");
  return base !== "" && suffix !== "" ? { base, suffix, bracketed } : null;
}

function isEditionLabel(value: string, bracketed: boolean): boolean {
  const key = canonicalKey(value);
  const year = "(?:19|20)\\d{2}";
  const ordinal = "\\d{1,3}(?:st|nd|rd|th)";
  const remaster = `(?:${year}\\s+)?remaster(?:ed)?(?:\\s+(?:in\\s+)?${year})?`;
  const anniversary = `(?:${ordinal}\\s+)?anniversary(?:\\s+(?:(?:super\\s+)?deluxe\\s+)?(?:edition|version|remaster(?:ed)?))?`;
  const namedEdition = "(?:(?:super\\s+)?deluxe|expanded|special|limited|extended|legacy|collector'?s|bonus(?:\\s+tracks?)?)\\s+(?:edition|version)";
  const label = new RegExp(`^(?:${remaster}|${anniversary}|${namedEdition})$`, "u");
  if (label.test(key)) return true;

  // Bare labels are accepted only inside an explicit trailing bracket group.
  // "Album - Deluxe" may be a subtitle and is therefore preserved.
  return bracketed && /^(?:(?:super\s+)?deluxe|expanded|remastered?|anniversary)$/u.test(key);
}

function uniqueAliases(values: string[]): string[] {
  const aliases: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeDisplayName(value);
    if (normalized === "" || seen.has(normalized)) continue;
    seen.add(normalized);
    aliases.push(normalized);
  }
  return aliases;
}
