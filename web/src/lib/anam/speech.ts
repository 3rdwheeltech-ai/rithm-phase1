/**
 * Turning an assistant reply into something a TTS engine should say aloud.
 *
 * Pure functions, in their own file, because they are the part of the voice
 * path that is easiest to get wrong and cheapest to test — and because a TTS
 * engine reading *"asterisk asterisk Nice asterisk asterisk"* is exactly the
 * kind of thing that ships if nobody writes it down.
 */

/** Bracket tags a music assistant genuinely emits: [Verse 1], [Chorus], … */
const BRACKET_TAG = /\[[^\]\n]{0,40}\]/g;

/** Markdown emphasis and inline code: **bold**, *italic*, __x__, _x_, `code`. */
const EMPHASIS = /(\*\*|\*|__|_|`)/g;

/**
 * Emoji and the pictographic block around them.
 *
 * Explicit ranges rather than `\p{Extended_Pictographic}`: the ranges below are
 * the ones a chat model actually reaches for, and they need no lib target this
 * tsconfig has not committed to.
 *
 * The zero-width joiner and variation-selector-16 are stripped SEPARATELY
 * rather than added to the class above. Inside a character class they read as
 * independent code points, which is exactly the misleading-character-class
 * lint: `👩‍🎤` is one grapheme made of three code points, and a class would
 * happily match its middle. Removing the ranges first and the joiners after
 * leaves nothing of it either way, and says what it means.
 */
const PICTOGRAPHIC = /[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2600}-\u{27BF}]/gu;
const JOINERS = /\u{FE0F}|\u{200D}/gu;

/**
 * Everything a TTS engine should not try to pronounce, removed.
 *
 * Markdown emphasis, emoji, and `[Verse 1]`-style tags — the last of which is
 * not hypothetical: lyrics leak into replies from a music assistant, and the
 * tags are how the generator marks song structure.
 */
export function sanitizeForSpeech(reply: string): string {
  return reply
    .replace(BRACKET_TAG, " ")
    .replace(PICTOGRAPHIC, " ")
    .replace(JOINERS, "")
    .replace(EMPHASIS, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Sentence-ish chunks, for `streamMessageChunk`.
 *
 * Split on terminal punctuation followed by whitespace and a capital or an
 * opening quote. That deliberately does NOT split "e.g." or "3.5" — an
 * abbreviation or a decimal followed by a lowercase letter or a digit stays
 * whole, which is what stops the avatar pausing mid-tempo.
 *
 * Returns the whole string as one chunk when it has no sentence break, and an
 * empty array for an empty string — the caller must not open a talk stream
 * with nothing in it.
 */
export function splitSentences(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed === "") return [];
  return trimmed
    .split(/(?<=[.!?…])\s+(?=["'“‘(]?[A-Z])/u)
    .map((part) => part.trim())
    .filter((part) => part !== "");
}
