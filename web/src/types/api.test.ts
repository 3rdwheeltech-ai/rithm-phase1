import { describe, expect, it } from "vitest";
import { GENRES, MOODS } from "./api";

/**
 * These lists are duplicated across the tree boundary — the other copy is the
 * Genre/Mood StrEnums in `api/app/modules/generation/schemas.py`. Pinning this
 * copy to the literal launch-plan §A6 vocabulary means a drift on either side
 * fails a test rather than producing a 422 in front of a user.
 */
describe("generation vocabulary", () => {
  it("GENRES matches launch-plan §A6 exactly, in order", () => {
    expect([...GENRES]).toEqual([
      "Pop",
      "Hip-Hop",
      "EDM",
      "Lo-Fi",
      "Cinematic",
      "Rock",
      "Country",
      "R&B",
      "Ambient",
    ]);
  });

  it("MOODS matches launch-plan §A6 exactly, in order", () => {
    expect([...MOODS]).toEqual([
      "Happy",
      "Calm",
      "Energetic",
      "Dark",
      "Romantic",
      "Inspirational",
      "Dramatic",
    ]);
  });
});
