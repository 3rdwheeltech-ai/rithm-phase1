import { describe, expect, it } from "vitest";
import { sanitizeForSpeech, splitSentences } from "./speech";

describe("sanitizeForSpeech", () => {
  it("strips markdown, emoji and bracket tags before speaking", () => {
    // A TTS engine reading "asterisk asterisk Nice asterisk asterisk" is the
    // kind of thing that ships if nobody writes this down. The bracket tag is
    // not hypothetical either: lyrics leak into replies from a music
    // assistant, and [Verse 1] is how the generator marks song structure.
    expect(sanitizeForSpeech("**Nice** — [Verse 1] what genre? 🎵")).toBe(
      "Nice — what genre?",
    );
  });

  it("leaves ordinary prose completely alone", () => {
    const line = "Tell me about the song you want — a scene, a feeling.";
    expect(sanitizeForSpeech(line)).toBe(line);
  });

  it("removes a multi-code-point emoji whole, joiner and all", () => {
    expect(sanitizeForSpeech("Great 👩‍🎤 pick")).toBe("Great pick");
  });

  it("collapses the whitespace a stripped tag leaves behind", () => {
    expect(sanitizeForSpeech("Nice.   [Chorus]   And the mood?")).toBe(
      "Nice. And the mood?",
    );
  });
});

describe("splitSentences", () => {
  it("splits on sentence ends without splitting an abbreviation or a decimal", () => {
    expect(splitSentences("Lo-fi it is. What mood?")).toEqual([
      "Lo-fi it is.",
      "What mood?",
    ]);
    // A pause mid-tempo is the failure this guards.
    expect(splitSentences("Around 92.5 bpm, e.g. a slow walk.")).toEqual([
      "Around 92.5 bpm, e.g. a slow walk.",
    ]);
  });

  it("returns one chunk for a sentence with no break in it", () => {
    expect(splitSentences("What genre are we going for")).toEqual([
      "What genre are we going for",
    ]);
  });

  it("returns nothing for an empty reply, so no talk stream is opened", () => {
    expect(splitSentences("")).toEqual([]);
    expect(splitSentences("   ")).toEqual([]);
  });
});
