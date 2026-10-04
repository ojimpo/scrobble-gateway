export const LASTFM_PERIODS = ["overall", "12month", "6month", "3month", "1month", "7day"] as const;

export type LastFmPeriod = (typeof LASTFM_PERIODS)[number];

export type PageInfo = {
  page: number;
  perPage: number;
  totalPages: number;
  total: number;
};

export type UserProfile = {
  username: string;
  realName: string | null;
  country: string | null;
  profileUrl: string;
  registeredAt: string | null;
  totalScrobbles: number;
  artistCount: number | null;
  albumCount: number | null;
  trackCount: number | null;
};

export type ArtistPlay = {
  rank: number;
  name: string;
  playcount: number;
  mbid: string | null;
  url: string;
};

export type TrackPlay = {
  rank: number;
  name: string;
  artist: string;
  playcount: number;
  mbid: string | null;
  artistMbid: string | null;
  url: string;
};

export type AlbumPlay = {
  rank: number;
  name: string;
  artist: string;
  playcount: number;
  mbid: string | null;
  artistMbid: string | null;
  url: string;
};

export type RecentTrack = {
  name: string;
  artist: string;
  album: string | null;
  mbid: string | null;
  artistMbid: string | null;
  albumMbid: string | null;
  url: string;
  loved: boolean;
  nowPlaying: boolean;
  playedAt: string | null;
  playedAtUnix: number | null;
};

export type LovedTrack = {
  name: string;
  artist: string;
  mbid: string | null;
  artistMbid: string | null;
  url: string;
  lovedAt: string | null;
};

export type ArtistContext = {
  name: string;
  mbid: string | null;
  url: string;
  listeners: number | null;
  playcount: number | null;
  userPlaycount: number | null;
  tags: string[];
  similarArtists: Array<{ name: string; url: string; match: number | null }>;
  bioSummary: string | null;
};

export type RecentTracksPage = {
  tracks: RecentTrack[];
  pageInfo: PageInfo;
};

export interface LastFmApi {
  getUserInfo(): Promise<UserProfile>;
  getTopArtists(period: LastFmPeriod, limit: number): Promise<ArtistPlay[]>;
  getTopTracks(period: LastFmPeriod, limit: number): Promise<TrackPlay[]>;
  getTopAlbums(period: LastFmPeriod, limit: number): Promise<AlbumPlay[]>;
  getLovedTracks(limit: number): Promise<LovedTrack[]>;
  getRecentTracksPage(input: {
    from?: number;
    to?: number;
    page?: number;
    limit?: number;
  }): Promise<RecentTracksPage>;
  getArtistContext(artist: string, autocorrect: boolean): Promise<ArtistContext>;
  getArtistTopTracks(artist: string, limit: number, autocorrect?: boolean): Promise<TrackPlay[]>;
  getArtistTopAlbums(artist: string, limit: number, autocorrect?: boolean): Promise<AlbumPlay[]>;
}
