import { describe, expect, it } from "vitest";
import COVERS from "../data/covers.json";
import { coverGradient, coverImage } from "./covers";

/** UUIDv7s, the shape `TrackSummary.id` actually arrives in. */
const IDS = Array.from(
  { length: 400 },
  (_, i) => `0192f0a1-7c3e-7b21-9d44-${String(i).padStart(12, "0")}`,
);

describe("coverImage", () => {
  it("returns the same url for the same id every time", () => {
    // The whole persistence story: no storage, just a pure function of the id.
    const id = IDS[7]!;
    expect(coverImage(id)).toBe(coverImage(id));
  });

  it("only ever returns a url that is in covers.json", () => {
    const known = new Set(COVERS.map((c) => c.url));
    for (const id of IDS) expect(known.has(coverImage(id)!)).toBe(true);
  });

  it("spreads ids across the whole catalogue rather than clustering", () => {
    const used = new Set(IDS.map((id) => coverImage(id)));
    // 400 ids over 77 covers: a hash worth having lands on nearly all of them.
    expect(used.size).toBeGreaterThan(COVERS.length * 0.85);
  });

  it("does not track the gradient — two ids sharing a gradient can differ", () => {
    // If the photo were derived from the same hash, this would be one bucket.
    const perGradient = new Map<string, Set<string | undefined>>();
    for (const id of IDS) {
      const g = coverGradient(id);
      if (!perGradient.has(g)) perGradient.set(g, new Set());
      perGradient.get(g)!.add(coverImage(id));
    }
    for (const images of perGradient.values()) expect(images.size).toBeGreaterThan(1);
  });
});

describe("covers.json", () => {
  it("is numbered 1..N with no gaps", () => {
    expect(COVERS.map((c) => c.n)).toEqual(COVERS.map((_, i) => i + 1));
  });

  it("has no duplicate images", () => {
    expect(new Set(COVERS.map((c) => c.url)).size).toBe(COVERS.length);
  });
});
