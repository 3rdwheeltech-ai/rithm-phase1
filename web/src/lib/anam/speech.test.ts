import { describe, expect, it } from "vitest";
import { sanitizeForSpeech, splitSentences } from "./speech";

describe("sanitizeForSpeech", () => {
  it("strips markdown, emoji and bracket tags before speaking", () => {
    // A TTS engine reading "asterisk asterisk Nice asterisk asterisk" is the
    // kind of thing that ships if nobody writes this down. The bracket tag is
    // not hypothetical either: lyrics leak into replies from a music
    // assistant, and [Verse 1] is how the generator marks song structure.
    expect(sanitizeForSpeech("**Nice** — [Verse 1] what genre? 🎵")).toBe(
      "Nice, what genre?",
    );
  });

  it("leaves ordinary prose completely alone", () => {
    const line = "Tell me about the song you want. A scene, a feeling.";
    expect(sanitizeForSpeech(line)).toBe(line);
  });

  it("says the brand instead of spelling it", () => {
    // An all-caps token is an initialism to a TTS engine, so RITHM came out as
    // "R, I, T, H, M". The wordmark stays RITHM everywhere it is read; this is
    // the one path where it is said out loud.
    expect(sanitizeForSpeech("RITHM will write the rest.")).toBe(
      "Rithm will write the rest.",
    );
    // Only the shout. A word that merely contains it is left alone.
    expect(sanitizeForSpeech("algoRITHMic")).toBe("algoRITHMic");
  });

  it("turns dashes into the comma they meant", () => {
    // The engine has no word for an em-dash, and the model reaches for one
    // constantly because the prompt used to be full of them.
    expect(sanitizeForSpeech("A rainy drive — at night.")).toBe(
      "A rainy drive, at night.",
    );
    expect(sanitizeForSpeech("Dark and EDM – good pick.")).toBe(
      "Dark and EDM, good pick.",
    );
  });

  it("does not read an ellipsis out as dots", () => {
    expect(sanitizeForSpeech("Well... what mood?")).toBe("Well, what mood?");
    expect(sanitizeForSpeech("Well… what mood?")).toBe("Well, what mood?");
  });

  it("never leaves a comma stranded against a full stop", () => {
    // The dash and ellipsis rules both insert a comma, and a trailing one
    // would land as ", ." — which is worse aloud than what it replaced.
    expect(sanitizeForSpeech("That is everything —.")).toBe("That is everything.");
  });

  it("drops a chunk with nothing pronounceable in it", () => {
    // The split keeps terminal punctuation with the text before it, so a stray
    // fragment can survive as pure punctuation — and an engine handed that
    // says the character's NAME out loud.
    // The split fires on terminal punctuation followed by a capital, so a
    // leading "..." becomes a chunk of its own with no letters in it.
    expect(splitSentences("... Nice, what mood?")).toEqual(["Nice, what mood?"]);
    expect(splitSentences("...")).toEqual([]);
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
