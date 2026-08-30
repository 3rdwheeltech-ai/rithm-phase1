import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useTypewriter } from "./useTypewriter";

/**
 * The typing timeline, shared by the assistant panel and the Create form's
 * lyric brief. Two hand-rolled typewriters drifting apart in speed is what
 * this hook exists to prevent, so the behaviour both callers rely on is
 * pinned here rather than in either of them.
 */

const PHRASES = ["ab", "cd"];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Advance timers inside act, letting the loop's awaited promises settle. */
async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("useTypewriter", () => {
  it("opens on the first phrase rather than on nothing", () => {
    // The very first frame, before a timer has fired. An empty placeholder
    // flashing on every mount is the thing this avoids.
    const { result } = renderHook(() =>
      useTypewriter(PHRASES, { enabled: false }),
    );

    expect(result.current).toBe("ab");
  });

  it("holds the first phrase when motion is not wanted", async () => {
    const { result } = renderHook(() =>
      useTypewriter(PHRASES, { enabled: false }),
    );

    await tick(10_000);

    expect(result.current).toBe("ab");
  });

  it("types a phrase one character at a time", async () => {
    const { result } = renderHook(() =>
      useTypewriter(PHRASES, { enabled: true, typeMs: 10, slotMs: 100 }),
    );

    await tick(5);
    expect(result.current).toBe("a");
    await tick(5);
    expect(result.current).toBe("ab");
  });

  it("moves on to the next phrase, and comes back round", async () => {
    const { result } = renderHook(() =>
      useTypewriter(PHRASES, { enabled: true, typeMs: 10, slotMs: 40 }),
    );

    // "ab" is typed by 20ms and held for the rest of the 40ms slot.
    await tick(25);
    expect(result.current).toBe("ab");

    // At the end of the slot the next phrase takes over.
    await tick(25);
    expect(result.current).toBe("cd");
  });

  it("never shows an empty string when it is erasing rather than gapping", async () => {
    /*
      THE PLACEHOLDER'S REQUIREMENT. An input whose placeholder blanks for half
      a second reads as a bug, not an animation — so the form's configuration
      erases between phrases and the box always has something in it.
    */
    const seen: string[] = [];
    const { result } = renderHook(() =>
      useTypewriter(PHRASES, {
        enabled: true,
        typeMs: 10,
        slotMs: 40,
        eraseMs: 5,
        gapMs: 0,
      }),
    );

    for (let i = 0; i < 40; i++) {
      seen.push(result.current);
      await tick(5);
    }

    expect(seen).not.toContain("");
  });

  it("does show the gap when the caller asks for one", async () => {
    // The assistant panel's shape: a beat of blinking cursor with no text
    // beside it, which is the opposite of what a placeholder wants.
    const seen: string[] = [];
    const { result } = renderHook(() =>
      useTypewriter(PHRASES, {
        enabled: true,
        typeMs: 10,
        slotMs: 40,
        gapMs: 30,
        phrasesPerCycle: 1,
      }),
    );

    for (let i = 0; i < 40; i++) {
      seen.push(result.current);
      await tick(5);
    }

    expect(seen).toContain("");
  });

  it("stops its timers when it is disabled", async () => {
    const { result, rerender } = renderHook(
      ({ on }: { on: boolean }) =>
        useTypewriter(PHRASES, { enabled: on, typeMs: 10, slotMs: 40 }),
      { initialProps: { on: true } },
    );

    await tick(15);
    rerender({ on: false });
    const frozen = result.current;

    await tick(10_000);

    expect(result.current).toBe(frozen);
  });
});
