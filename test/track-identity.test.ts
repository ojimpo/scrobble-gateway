import { describe, expect, it } from "vitest";
import { isSafeMatch, resolveTrack, TrackIdentityIndex, trackIdentity as t } from "../src/track-identity.js";

describe("cross-provider identity", () => {
  it.each([
    ["Björk", "Jóga", "BJÖRK", "Jóga", "normalized_exact"],
    ["Artist", " Song   Name ", "artist", "song name", "normalized_exact"],
    ["Artist", "Song - 2011 Remaster", "Artist", "Song", "normalized_exact"],
    ["Artist", "Song (Remastered 2011)", "Artist", "Song", "normalized_exact"],
    ["Artist", "Song (feat. Guest)", "Artist", "Song (ft. Guest)", "normalized_exact"],
    ["Artist", "Song (feat. Guest)", "Artist", "Song", "probable"],
    ["Artist feat. Guest", "Song", "Artist", "Song", "probable"],
    ["P!nk", "Song", "Pink", "Song", "unmatched"],
    ["Artist!", "Song", "Artist", "Song", "probable"],
    ["Artist", "Song (Live)", "Artist", "Song", "unmatched"],
    ["Artist", "Song (Acoustic)", "Artist", "Song", "unmatched"],
    ["Artist", "Song - Radio Edit", "Artist", "Song", "unmatched"],
    ["Artist", "Song (Deluxe Version)", "Artist", "Song", "unmatched"],
    ["Artist", "Song - Remix", "Artist", "Song", "unmatched"],
    ["Beyoncé", "Song", "Beyonce", "Song", "unmatched"],
  ])("%s / %s versus %s / %s → %s", (artist, title, otherArtist, otherTitle, status) => {
    const result = resolveTrack(t({ artist, title }), [t({ artist: otherArtist, title: otherTitle })]);
    expect(result.status).toBe(status);
    expect(new TrackIdentityIndex([t({ artist: otherArtist, title: otherTitle })]).resolve(t({ artist, title })).status).toBe(status);
    expect(isSafeMatch(result)).toBe(status === "normalized_exact");
  });
  it("rejects ambiguous distinct Spotify recordings but deduplicates repeated IDs", () => {
    const source = t({ artist: "Artist", title: "Song" });
    const a = t({ ...source, spotifyId: "a" });
    const b = t({ ...source, spotifyId: "b" });
    expect(resolveTrack(source, [a, b]).status).toBe("ambiguous");
    expect(resolveTrack(source, [a, a]).status).toBe("exact");
  });
  it("uses matching MBIDs and rejects conflicting MBIDs", () => {
    const a = t({ artist: "Artist", title: "Song", mbid: "recording-a" });
    expect(resolveTrack(a, [t({ artist: "Alias", title: "Other spelling", mbid: "recording-a" })]).status).toBe("exact");
    expect(resolveTrack(a, [t({ ...a, mbid: "recording-b" })]).status).toBe("unmatched");
  });
});
