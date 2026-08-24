import { describe, expect, it } from "vitest";
import { trackTitle } from "./track";

/**
 * The derivation is the FLOOR under `catalog.tracks.title`, not a stand-in for
 * it: every track created before that column existed has `title === null`, and
 * there are more of those than of the named ones. So it is pinned rather than
 * left to drift — and `api/app/modules/generation/authoring.py` carries a port
 * of it that reuses these exact cases, so the two can never disagree about
 * what a track is called.
 */
const title = (prompt: string) => trackTitle({ prompt, title: null });

describe("trackTitle", () => {
  it("takes the first clause of a descriptive prompt", () => {
    expect(title("warm lo-fi piano, soft vinyl crackle, rain")).toBe("Warm lo-fi piano");
  });

  it("strips the instruction wrapper people type around a prompt", () => {
    expect(title("create a song about rainy nights")).toBe("Rainy nights");
    expect(title("make me a track for studying")).toBe("Studying");
    expect(title("Please generate an upbeat synthwave loop")).toBe("Upbeat synthwave loop");
    expect(title("e.g. opera metal, hard-hitting drums")).toBe("Opera metal");
  });

  it("keeps leading words that actually describe the music", () => {
    // The trap: "instrumental" and "ambient" open the prompt but are the point
    // of it. Only generic nouns followed by a connector are filler.
    expect(title("instrumental lo-fi beat")).toBe("Instrumental lo-fi beat");
    expect(title("ambient drone for deep focus")).toBe("Ambient drone for deep focus");
    expect(title("song of the summer")).toBe("Song of the summer");
  });

  it("truncates on a word boundary rather than mid-word", () => {
    const long = "a sweeping cinematic orchestral build with enormous timpani hits";
    const result = title(long);
    expect(result.endsWith("…")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(49);
    // The give-away of the old mid-word cut was a severed final token, so the
    // last surviving word must still be a whole word from the prompt.
    const lastWord = result.slice(0, -1).trim().split(" ").pop()!.toLowerCase();
    expect(long.split(/\s+/)).toContain(lastWord);
    expect(result).toBe("Sweeping cinematic orchestral build with…");
  });

  it("still cuts a single unbroken word", () => {
    expect(title("x".repeat(80))).toBe(`X${"x".repeat(47)}…`);
  });

  it("collapses whitespace and trailing punctuation", () => {
    expect(title("  dreamy   lo-fi  \n  piano  ")).toBe("Dreamy lo-fi piano");
    expect(title("midnight drive -")).toBe("Midnight drive");
  });

  it("preserves casing after the first character", () => {
    expect(title("EDM festival anthem")).toBe("EDM festival anthem");
    expect(title("lo-fi study beat")).toBe("Lo-fi study beat");
  });

  it("falls back rather than returning an empty name", () => {
    expect(title("")).toBe("Untitled track");
    expect(title("   ")).toBe("Untitled track");
    expect(title(",,,")).toBe("Untitled track");
    // Peeling must not consume a prompt that is nothing but filler.
    expect(title("a song about")).toBe("A song about");
  });

  it("prefers a real title over anything derived from the prompt", () => {
    expect(trackTitle({ prompt: "warm lo-fi piano, rain", title: "Vinyl Rain" })).toBe(
      "Vinyl Rain",
    );
    // No capitalisation, no clause-splitting, no peeling — a name the user
    // typed is theirs, and the derivation's rules are not applied to it.
    expect(trackTitle({ prompt: "anything", title: "a song about, sort of" })).toBe(
      "a song about, sort of",
    );
  });

  it("falls through to the derivation for a blank or missing title", () => {
    // Null is the state of every track older than the column.
    expect(trackTitle({ prompt: "warm lo-fi piano, rain", title: null })).toBe(
      "Warm lo-fi piano",
    );
    // A title of pure whitespace is not a name, whatever the server stored.
    expect(trackTitle({ prompt: "warm lo-fi piano, rain", title: "   " })).toBe(
      "Warm lo-fi piano",
    );
  });

  it("clips an over-long real title at the column bound", () => {
    const long = `${"Antidisestablishmentarianism ".repeat(4)}End`;

    const result = trackTitle({ prompt: "x", title: long });

    expect(result.length).toBeLessThanOrEqual(81);
    expect(result.endsWith("…")).toBe(true);
  });
});
