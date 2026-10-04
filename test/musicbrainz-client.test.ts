import { describe, expect, it, vi } from "vitest";
import { MusicBrainzClient } from "../src/musicbrainz-client.js";

function client(fetchImpl: typeof fetch, maxRetries = 0) {
  return new MusicBrainzClient({
    userAgent: "lastfm-mcp/0.2.0 (maintainer@example.com)",
    baseUrl: "https://musicbrainz.example/ws/2/",
    timeoutMs: 1_000,
    maxRetries,
    minRequestIntervalMs: 0,
    fetchImpl,
  });
}

describe("MusicBrainzClient", () => {
  it("resolves an artist and prefers an exact normalized name over a higher search score", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        artists: [
          { id: "similar-id", name: "Low Roar", score: 100 },
          {
            id: "exact-id",
            name: "LoW ",
            score: "87",
            "sort-name": "Low",
            country: "US",
            area: {
              id: "area-id",
              name: "United States",
              "iso-3166-1-codes": ["US"],
            },
            "life-span": { begin: "1993", ended: false },
          },
        ],
      }),
    );

    const artist = await client(fetchImpl).resolveArtist("Low");

    expect(artist).toMatchObject({
      mbid: "exact-id",
      name: "LoW",
      country: "US",
      score: 87,
      area: { mbid: "area-id", countryCodes: ["US"] },
      lifeSpan: { begin: "1993", end: null, ended: false },
    });
    const [input, init] = fetchImpl.mock.calls[0] ?? [];
    const requested = new URL(String(input));
    expect(requested.pathname).toBe("/ws/2/artist");
    expect(requested.searchParams.get("fmt")).toBe("json");
    expect(requested.searchParams.get("query")).toBe('artist:"Low"');
    expect(new Headers(init?.headers).get("user-agent")).toBe("lastfm-mcp/0.2.0 (maintainer@example.com)");
  });

  it("normalizes artist genres, tags, life span, and heterogeneous relation targets", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        id: "artist-id",
        name: "Invent Animate",
        type: "Group",
        country: "US",
        "life-span": { begin: "2011", end: null, ended: false },
        genres: [
          { name: "metalcore", count: 12 },
          { name: "progressive metal", count: "24" },
        ],
        tags: [{ name: "djent", count: "8" }],
        relations: [
          {
            type: "official homepage",
            "target-type": "url",
            direction: "forward",
            url: { id: "url-id", resource: "https://inventanimate.com" },
          },
          {
            type: "member of band",
            "target-type": "artist",
            attributes: ["vocal"],
            artist: { id: "member-id", name: "A Member" },
          },
          {
            type: "producer",
            "target-type": "release-group",
            release_group: { id: "group-id", title: "An Album" },
          },
        ],
      }),
    );

    const features = await client(fetchImpl).getArtistFeatures("ignored", "artist-id");

    expect(features?.genres.map((genre) => genre.name)).toEqual(["progressive metal", "metalcore"]);
    expect(features?.tags).toEqual([{ name: "djent", count: 8, disambiguation: null }]);
    expect(features?.relations).toEqual([
      expect.objectContaining({
        type: "official homepage",
        target: expect.objectContaining({ url: "https://inventanimate.com" }),
      }),
      expect.objectContaining({
        type: "member of band",
        attributes: ["vocal"],
        target: expect.objectContaining({ mbid: "member-id", name: "A Member" }),
      }),
      expect.objectContaining({
        type: "producer",
        target: expect.objectContaining({ mbid: "group-id", name: "An Album" }),
      }),
    ]);
    const requested = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(requested.pathname).toBe("/ws/2/artist/artist-id");
    expect(requested.searchParams.get("inc")).toContain("genres+tags");
  });

  it("selects an official release and returns ordered media and recording metadata", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          "release-groups": [
            {
              id: "group-id",
              title: "Heavener",
              score: "100",
              "primary-type": "Album",
              "first-release-date": "2023-03-17",
              "artist-credit": [
                { name: "Invent Animate", artist: { id: "artist-id", name: "Invent Animate" } },
              ],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          releases: [
            { id: "bootleg-id", title: "Heavener", status: "Bootleg", date: "2023-03-01" },
            { id: "official-id", title: "Heavener", status: "Official", date: "2023-03-17" },
          ],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          id: "official-id",
          title: "Heavener",
          status: "Official",
          date: "2023-03-17",
          country: "US",
          media: [
            {
              position: 2,
              format: "Digital Media",
              tracks: [
                {
                  position: 2,
                  number: "4",
                  title: "Release Track Four",
                  length: "222000",
                  recording: { id: "recording-4", title: "Recording Four" },
                },
                {
                  position: 1,
                  number: "3",
                  recording: { id: "recording-3", title: "Recording Three", length: 201000 },
                },
              ],
            },
            {
              position: 1,
              format: "Digital Media",
              "track-count": 2,
              tracks: [
                { position: 2, number: "2", recording: { id: "recording-2", title: "Track Two" } },
                {
                  position: 1,
                  number: "1",
                  recording: {
                    id: "recording-1",
                    title: "Track One",
                    "artist-credit": [
                      { name: "Invent Animate", joinphrase: "", artist: { id: "artist-id", name: "Invent Animate" } },
                    ],
                  },
                },
              ],
            },
          ],
        }),
      );

    const result = await client(fetchImpl).getAlbumTracklist("Invent Animate", "Heavener");

    expect(result?.releaseGroup).toMatchObject({ mbid: "group-id", primaryType: "Album" });
    expect(result?.release).toMatchObject({ mbid: "official-id", mediumCount: 2, trackCount: 4 });
    expect(result?.media.map((medium) => medium.position)).toEqual([1, 2]);
    expect(result?.media[0]?.tracks.map((track) => track.recordingMbid)).toEqual(["recording-1", "recording-2"]);
    expect(result?.media[1]?.tracks[0]).toMatchObject({
      title: "Recording Three",
      durationMs: 201000,
      recordingMbid: "recording-3",
    });
    expect(result?.media[1]?.tracks[1]).toMatchObject({
      title: "Recording Four",
      trackTitle: "Release Track Four",
      durationMs: 222000,
    });

    const browseRequest = new URL(String(fetchImpl.mock.calls[1]?.[0]));
    expect(browseRequest.pathname).toBe("/ws/2/release");
    expect(browseRequest.searchParams.get("release-group")).toBe("group-id");
    const releaseRequest = new URL(String(fetchImpl.mock.calls[2]?.[0]));
    expect(releaseRequest.pathname).toBe("/ws/2/release/official-id");
    expect(releaseRequest.searchParams.get("inc")).toBe("recordings+artist-credits");
  });

  it("retries transient MusicBrainz failures", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ error: "temporarily unavailable" }, { status: 503, headers: { "retry-after": "0" } }),
      )
      .mockResolvedValueOnce(Response.json({ artists: [{ id: "artist-id", name: "Loathe", score: 100 }] }));

    const result = await client(fetchImpl, 1).resolveArtist("Loathe");

    expect(result?.mbid).toBe("artist-id");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("browses and orders recent album/EP release groups for an artist", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      "release-groups": [
        { id: "old", title: "Old Album", "primary-type": "Album", "first-release-date": "2019" },
        { id: "single", title: "Single", "primary-type": "Single", "first-release-date": "2026-07-01" },
        { id: "new", title: "New EP", "primary-type": "EP", "first-release-date": "2026-06-01" },
      ],
    }));

    const groups = await client(fetchImpl).getArtistReleaseGroups("ignored", "artist-id", 10);

    expect(groups.map((group) => group.mbid)).toEqual(["new", "old"]);
    const requested = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(requested.pathname).toBe("/ws/2/release-group");
    expect(requested.searchParams.get("artist")).toBe("artist-id");
  });
});
