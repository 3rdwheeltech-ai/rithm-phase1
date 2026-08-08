import { demoGradient } from "./covers";

/**
 * Discover's sample catalogue.
 *
 * None of this is real. There is no publish endpoint, no community, no play
 * counts — the page exists to show the shape of what is coming, and it says so
 * in a banner above the fold. Kept in one module so nobody has to grep JSX to
 * find out which parts of the app are pretend.
 *
 * Play counts are numbers rather than pre-formatted strings so "Trending" can
 * actually sort by them; a chip that does nothing is worse than no chip.
 */

export interface DemoTrack {
  id: string;
  title: string;
  artist: string;
  genre: DemoGenre;
  /** Seconds — formatted at the edge, like every real track. */
  lengthSeconds: number;
  plays: number;
  /** Tailwind gradient stops, assigned by catalogue position. */
  gradient: string;
}

export interface DemoArtist {
  id: string;
  name: string;
  followers: number;
  genre: DemoGenre;
  gradient: string;
}

export const DEMO_GENRES = ["Lo-fi", "Synthwave", "Ambient", "Hip-hop", "Cinematic"] as const;
export type DemoGenre = (typeof DEMO_GENRES)[number];

/** The chip row. The first two are views over everything, not genres. */
export const DISCOVER_FILTERS = ["For You", "Trending", ...DEMO_GENRES] as const;
export type DiscoverFilter = (typeof DISCOVER_FILTERS)[number];

type SeedTrack = Omit<DemoTrack, "gradient">;

const SEED: SeedTrack[] = [
  { id: "d1", title: "Midnight Bloom", artist: "Aurora Vale", genre: "Lo-fi", lengthSeconds: 201, plays: 248_000 },
  { id: "d2", title: "Glass Cathedral", artist: "Vesper", genre: "Ambient", lengthSeconds: 248, plays: 192_000 },
  { id: "d3", title: "Ember Drive", artist: "KAIRO", genre: "Synthwave", lengthSeconds: 182, plays: 176_000 },
  { id: "d4", title: "Paper Skies", artist: "Halcyon Bloom", genre: "Lo-fi", lengthSeconds: 217, plays: 154_000 },
  { id: "d5", title: "Static Bloom", artist: "Echo District", genre: "Hip-hop", lengthSeconds: 174, plays: 131_000 },
  { id: "d6", title: "Violet Hours", artist: "Low Tide", genre: "Lo-fi", lengthSeconds: 229, plays: 118_000 },
  { id: "d7", title: "Cobalt Room", artist: "Mara Quinn", genre: "Cinematic", lengthSeconds: 263, plays: 104_000 },
  { id: "d8", title: "Neon Vespers", artist: "Neon Atlas", genre: "Synthwave", lengthSeconds: 226, plays: 97_400 },
  { id: "d9", title: "Salt and Signal", artist: "Vesper", genre: "Ambient", lengthSeconds: 291, plays: 88_200 },
  { id: "d10", title: "Slow Cartography", artist: "Aurora Vale", genre: "Ambient", lengthSeconds: 254, plays: 76_800 },

  { id: "d11", title: "Tape Weather", artist: "Low Tide", genre: "Lo-fi", lengthSeconds: 193, plays: 41_300 },
  { id: "d12", title: "Chrome Orchard", artist: "KAIRO", genre: "Synthwave", lengthSeconds: 211, plays: 38_900 },
  { id: "d13", title: "Ninth Avenue", artist: "Echo District", genre: "Hip-hop", lengthSeconds: 165, plays: 33_100 },
  { id: "d14", title: "Long Exposure", artist: "Mara Quinn", genre: "Cinematic", lengthSeconds: 278, plays: 29_700 },
  { id: "d15", title: "Quiet Machines", artist: "Halcyon Bloom", genre: "Ambient", lengthSeconds: 302, plays: 24_500 },
  { id: "d16", title: "Copper Rain", artist: "Aurora Vale", genre: "Lo-fi", lengthSeconds: 187, plays: 21_800 },
  { id: "d17", title: "Signal Fires", artist: "Neon Atlas", genre: "Cinematic", lengthSeconds: 241, plays: 18_200 },
  { id: "d18", title: "Basement Sun", artist: "Echo District", genre: "Hip-hop", lengthSeconds: 158, plays: 15_600 },
  { id: "d19", title: "Winter Palette", artist: "Vesper", genre: "Ambient", lengthSeconds: 267, plays: 12_400 },
  { id: "d20", title: "Half Light", artist: "Low Tide", genre: "Synthwave", lengthSeconds: 205, plays: 9_800 },
];

/** Gradient by catalogue position, so no two neighbours share a face. */
export const DEMO_CATALOGUE: DemoTrack[] = SEED.map((track, i) => ({
  ...track,
  gradient: demoGradient(i),
}));

export const FEATURED: DemoTrack = {
  id: "d0",
  title: "Solar Tides",
  artist: "Neon Atlas",
  genre: "Synthwave",
  lengthSeconds: 231,
  plays: 412_000,
  gradient: "from-amber-300/60 via-orange-700/45 to-slate-950/80",
};

export const DEMO_ARTISTS: DemoArtist[] = [
  { id: "a1", name: "Aurora Vale", followers: 1_200_000, genre: "Synthwave" },
  { id: "a2", name: "KAIRO", followers: 842_000, genre: "Synthwave" },
  { id: "a3", name: "Mara Quinn", followers: 613_000, genre: "Cinematic" },
  { id: "a4", name: "Neon Atlas", followers: 1_900_000, genre: "Synthwave" },
  { id: "a5", name: "Low Tide", followers: 458_000, genre: "Lo-fi" },
  { id: "a6", name: "Vesper", followers: 327_000, genre: "Ambient" },
  { id: "a7", name: "Echo District", followers: 284_000, genre: "Hip-hop" },
  { id: "a8", name: "Halcyon Bloom", followers: 176_000, genre: "Lo-fi" },
].map((artist, i) => ({ ...artist, gradient: demoGradient(i + 3) }) as DemoArtist);

/** 1_200_000 → "1.2M". Drops the decimal when it would read as ".0". */
export function formatCount(value: number): string {
  if (value >= 1_000_000) {
    const m = value / 1_000_000;
    return `${m >= 10 || Number.isInteger(m) ? Math.round(m) : m.toFixed(1)}M`;
  }
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

/**
 * The catalogue as the chip row leaves it.
 *
 * "For You" is the catalogue's own order, "Trending" re-sorts by plays, and
 * everything else is a genre. Sorting on a copy — `sort` mutates, and this
 * array is module state shared by every section.
 */
export function filterCatalogue(filter: DiscoverFilter): DemoTrack[] {
  if (filter === "For You") return DEMO_CATALOGUE;
  if (filter === "Trending") return [...DEMO_CATALOGUE].sort((a, b) => b.plays - a.plays);
  return DEMO_CATALOGUE.filter((track) => track.genre === filter);
}
