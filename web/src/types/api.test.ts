import { describe, expect, it } from "vitest";
import {
  GENRES,
  LYRICS_MAX_LENGTH,
  LYRICS_PROMPT_MAX_LENGTH,
  MOODS,
  PROMPT_MAX_LENGTH,
  TITLE_MAX_LENGTH,
} from "./api";

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

  /**
   * The other copy of each of these is a module constant in
   * `api/app/modules/generation/schemas.py`. A client bound looser than the
   * server's is a 422 the user sees; tighter is a control that stops short of
   * what the API accepts. Both are silent without a pin.
   */
  it("length bounds match the server's field constraints", () => {
    expect(PROMPT_MAX_LENGTH).toBe(2000);
    expect(LYRICS_MAX_LENGTH).toBe(3000);
    expect(TITLE_MAX_LENGTH).toBe(80);
    expect(LYRICS_PROMPT_MAX_LENGTH).toBe(600);
  });
});
