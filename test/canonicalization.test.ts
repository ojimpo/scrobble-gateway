import { describe, expect, it } from "vitest";
import {
  canonicalKey,
  canonicalizeAlbum,
  canonicalizeArtist,
  canonicalizeTrack,
  extractAlbumAliases,
  extractArtistAliases,
  normalizeDisplayName,
} from "../src/canonicalization.js";

describe("name canonicalization", () => {
  it("groups casing variants without inventing display-name casing", () => {
    const stylized = canonicalizeArtist("TesseracT");
    const conventional = canonicalizeArtist("Tesseract");

    expect(stylized).toMatchObject({ canonicalName: "TesseracT", key: "tesseract" });
    expect(conventional).toMatchObject({ canonicalName: "Tesseract", key: "tesseract" });
    expect(stylized.aliases).toEqual(["TesseracT"]);
  });

  it("normalizes compatibility Unicode, whitespace, punctuation glyphs, and case folding", () => {
    const unicode = "  Ｂjörk\u00a0—\u00a0It’s\u200b Oh So Quiet  ";

    expect(normalizeDisplayName(unicode)).toBe("Björk - It's Oh So Quiet");
    expect(canonicalKey(unicode)).toBe(canonicalKey("björk-it's oh so quiet"));
    expect(canonicalKey("STRAẞE")).toBe(canonicalKey("strasse"));
    expect(canonicalKey("ΟΣ")).toBe(canonicalKey("ος"));
  });

  it("extracts only explicit feat./featuring artist credits", () => {
    expect(canonicalizeArtist("Architects feat. Winston McCall")).toEqual({
      canonicalName: "Architects",
      key: "architects",
      aliases: ["Architects feat. Winston McCall", "Architects"],
      featuredArtists: ["Winston McCall"],
    });
    expect(canonicalizeArtist("Spiritbox (featuring Sam Carter)")).toMatchObject({
      canonicalName: "Spiritbox",
      featuredArtists: ["Sam Carter"],
    });
    expect(extractArtistAliases("Northlane ft. Marcus Bridge")).toEqual([
      "Northlane ft. Marcus Bridge",
      "Northlane",
    ]);

    expect(canonicalizeArtist("Earth, Wind & Fire")).toMatchObject({
      canonicalName: "Earth, Wind & Fire",
      featuredArtists: [],
    });
    expect(canonicalizeArtist("Florence + the Machine with Ethel Cain")).toMatchObject({
      canonicalName: "Florence + the Machine with Ethel Cain",
      featuredArtists: [],
    });
  });

  it("folds explicit remaster, deluxe, expanded, and anniversary album suffixes", () => {
    expect(canonicalizeAlbum("Altered State (Remastered 2024)")).toEqual({
      canonicalName: "Altered State",
      key: "altered state",
      aliases: ["Altered State (Remastered 2024)", "Altered State"],
      edition: "Remastered 2024",
    });
    expect(canonicalizeAlbum("Heavener [Deluxe Edition]")).toMatchObject({
      canonicalName: "Heavener",
      key: "heavener",
      edition: "Deluxe Edition",
    });
    expect(canonicalizeAlbum("Polaris - 10th Anniversary Edition")).toMatchObject({
      canonicalName: "Polaris",
      edition: "10th Anniversary Edition",
    });
    expect(canonicalizeAlbum("Language (Expanded)")).toMatchObject({
      canonicalName: "Language",
      edition: "Expanded",
    });
    expect(extractAlbumAliases("Sonder (Deluxe Edition) [2024 Remaster]")).toEqual([
      "Sonder (Deluxe Edition) [2024 Remaster]",
      "Sonder",
    ]);
  });

  it("does not strip ambiguous subtitles or meaningful recording qualifiers", () => {
    expect(canonicalizeAlbum("Deluxe")).toMatchObject({ canonicalName: "Deluxe", edition: null });
    expect(canonicalizeAlbum("The Anniversary")).toMatchObject({ canonicalName: "The Anniversary", edition: null });
    expect(canonicalizeAlbum("Album - Deluxe")).toMatchObject({ canonicalName: "Album - Deluxe", edition: null });
    expect(canonicalizeAlbum("Songs for the Deaf (Live)")).toMatchObject({
      canonicalName: "Songs for the Deaf (Live)",
      edition: null,
    });

    expect(canonicalizeTrack("The Summit (feat. Ryo Kinoshita)")).toMatchObject({
      canonicalName: "The Summit (feat. Ryo Kinoshita)",
    });
    expect(canonicalizeTrack("Alive (Live at Wembley)").key).not.toBe(canonicalizeTrack("Alive").key);
    expect(canonicalizeTrack("P!nk").key).not.toBe(canonicalizeTrack("Pink").key);
    expect(canonicalizeTrack("Love / Hate").key).not.toBe(canonicalizeTrack("Love Hate").key);
  });

  it("handles empty metadata deterministically", () => {
    expect(canonicalizeArtist(" \u200b ")).toEqual({
      canonicalName: "",
      key: "",
      aliases: [],
      featuredArtists: [],
    });
    expect(canonicalizeAlbum("")).toEqual({ canonicalName: "", key: "", aliases: [], edition: null });
    expect(canonicalizeTrack("\u00ad")).toEqual({ canonicalName: "", key: "", aliases: [] });
  });
});
