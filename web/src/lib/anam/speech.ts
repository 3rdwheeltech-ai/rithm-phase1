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
 * Dashes a TTS engine has no word for.
 *
 * An em- or en-dash is the single most common thing a chat model reaches for
 * mid-sentence, and it is not punctuation the engine can voice — it either
 * swallows it, or names it. A comma is what the sentence meant anyway.
 *
 * The model is ALSO told not to write them (see agent.py's voice delivery
 * block), and this is here because the prompt is a request and this is not.
 */
const DASHES = /\s*[—–]\s*/g;

/**
 * Ellipses, which get read out as "dot dot dot".
 *
 * Both the three-period form and the single U+2026 character. A comma keeps
 * the beat the trailing-off was there for without spelling it.
 */
const ELLIPSES = /\s*(?:\.{3,}|…)\s*/g;

/**
 * The product name, which is an ACRONYM to a TTS engine and a word to us.
 *
 * All-caps tokens get spelled out letter by letter — "R, I, T, H, M" — and no
 * amount of prompting reliably stops a model echoing the casing it was shown.
 * The wordmark stays RITHM everywhere it is READ; this is only the path where
 * it is said aloud.
 */
const SHOUTED_BRAND = /\bRITHM\b/g;

/**
 * Everything a TTS engine should not try to pronounce, removed.
 *
 * Markdown emphasis, emoji, and `[Verse 1]`-style tags — the last of which is
 * not hypothetical: lyrics leak into replies from a music assistant, and the
 * tags are how the generator marks song structure. Then the three things that
 * were actually being MISPRONOUNCED rather than merely read: the brand as an
 * initialism, dashes, and ellipses.
 *
 * Order matters once: dashes and ellipses collapse to commas BEFORE the
 * whitespace squeeze, so `"a drive — at night"` lands as `"a drive, at night"`
 * and not with a space in front of the comma.
 */
export function sanitizeForSpeech(reply: string): string {
  return reply
    .replace(BRACKET_TAG, " ")
    .replace(PICTOGRAPHIC, " ")
    .replace(JOINERS, "")
    .replace(EMPHASIS, "")
    .replace(SHOUTED_BRAND, "Rithm")
    .replace(ELLIPSES, ", ")
    .replace(DASHES, ", ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/,\s*([.!?])/g, "$1")
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
 *
 * A chunk with NO LETTER OR DIGIT IN IT is dropped rather than spoken. The
 * split keeps terminal punctuation with the text before it, so a stray `". ."`
 * survives as a chunk made only of punctuation — and an engine handed that
 * says its name out loud. Emptiness is not the only thing worth refusing to
 * send; unpronounceability is the other.
 */
const SPEAKABLE = /[a-z0-9]/i;

export function splitSentences(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed === "") return [];
  return trimmed
    .split(/(?<=[.!?…])\s+(?=["'“‘(]?[A-Z])/u)
    .map((part) => part.trim())
    .filter((part) => SPEAKABLE.test(part));
}
