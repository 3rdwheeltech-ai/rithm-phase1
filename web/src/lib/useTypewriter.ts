import { useEffect, useState } from "react";

/**
 * A phrase list, typed out one character at a time and cycled.
 *
 * LIFTED OUT OF `StreamingPrompt` rather than copied beside it. The assistant
 * panel has had this timeline since before voice existed; the Create form's
 * lyric brief wanted the same idea in a different slot, and two hand-rolled
 * typewriters that drift apart in speed is the kind of thing that reads as two
 * different apps.
 *
 * The two callers want different SHAPES of the same timeline, which is what
 * the options are for:
 *
 * - The assistant panel shows a blinking cursor with nothing beside it for a
 *   beat, then a couple of phrases, then the gap again (`gapMs` > 0).
 * - A form placeholder must never be empty, because an input that blanks for
 *   half a second reads as a bug rather than an animation. It erases instead
 *   (`eraseMs` > 0, `gapMs` 0), so there is always something in the box.
 *
 * Returns the current text. The caret, if there is one, belongs to the caller.
 */
export interface TypewriterOptions {
  /** False stops the timers and holds the first phrase. Pass reduced-motion. */
  enabled: boolean;
  /** Per-character typing speed. */
  typeMs?: number;
  /** How long a completed phrase is held, INCLUDING the time spent typing it. */
  slotMs?: number;
  /** Phrases shown between gaps. Defaults to the whole list. */
  phrasesPerCycle?: number;
  /** Blank pause between cycles. 0 never shows an empty string. */
  gapMs?: number;
  /** Per-character erase speed. 0 clears in one step instead. */
  eraseMs?: number;
}

export function useTypewriter(
  phrases: readonly string[],
  {
    enabled,
    typeMs = 45,
    slotMs = 3000,
    phrasesPerCycle = phrases.length,
    gapMs = 0,
    eraseMs = 0,
  }: TypewriterOptions,
): string {
  // The first phrase, not an empty string: this is what a reduced-motion user
  // sees, and it is what renders on the very first frame before any timer has
  // fired. An empty placeholder would flash on every mount otherwise.
  const [text, setText] = useState(phrases[0] ?? "");

  useEffect(() => {
    if (!enabled || phrases.length === 0) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      });
    const set = (v: string) => {
      if (!cancelled) setText(v);
    };

    async function run() {
      let phrase = 0;
      while (!cancelled) {
        if (gapMs > 0) {
          set("");
          await wait(gapMs);
        }

        for (let k = 0; k < phrasesPerCycle && !cancelled; k++) {
          const full = phrases[phrase % phrases.length] ?? "";
          phrase++;

          for (let i = 1; i <= full.length && !cancelled; i++) {
            set(full.slice(0, i));
            await wait(typeMs);
          }
          // Hold what is left of the slot after the typing itself.
          await wait(Math.max(0, slotMs - full.length * typeMs));

          // Erase before the next one, so the box never jumps from a full
          // sentence to a single character. Skipped on the last phrase of a
          // cycle when a blank gap is coming anyway.
          const gapNext = gapMs > 0 && k === phrasesPerCycle - 1;
          if (eraseMs > 0 && !gapNext) {
            // DOWN TO ONE CHARACTER, NOT TO ZERO. Erasing the last one leaves
            // a frame of empty string, which in a form field is the flicker
            // this whole mode exists to avoid — the next phrase's first
            // character overwrites it anyway.
            for (let i = full.length - 1; i >= 1 && !cancelled; i--) {
              set(full.slice(0, i));
              await wait(eraseMs);
            }
          }
        }
      }
    }
    void run();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, phrases, typeMs, slotMs, phrasesPerCycle, gapMs, eraseMs]);

  return text;
}
