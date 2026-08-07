import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { CHIPS_ENTER_MS, CHIPS_EXIT_MS, useShuffledPicks } from "./useShuffledPicks";

const POOL = Array.from({ length: 20 }, (_, i) => `item-${i}`);
const ROTATE_MS = 60_000;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Advance through a full rotation, settling the exit and enter phases. */
async function rotate() {
  await act(async () => {
    vi.advanceTimersByTime(ROTATE_MS);
  });
  await act(async () => {
    vi.advanceTimersByTime(CHIPS_EXIT_MS);
  });
  await act(async () => {
    vi.advanceTimersByTime(CHIPS_ENTER_MS);
  });
}

describe("useShuffledPicks", () => {
  it("opens with the requested number of distinct picks from the pool", () => {
    const { result } = renderHook(() => useShuffledPicks(POOL, 3));

    expect(result.current.picks).toHaveLength(3);
    expect(new Set(result.current.picks).size).toBe(3);
    for (const pick of result.current.picks) expect(POOL).toContain(pick);
  });

  it("swaps only the picked chip, leaving its neighbours in place", () => {
    const { result } = renderHook(() => useShuffledPicks(POOL, 3));
    const [first, second, third] = result.current.picks;

    act(() => {
      result.current.replace(second!);
    });

    // Taking one suggestion must not yank the other two out from under the
    // pointer that just clicked.
    expect(result.current.picks[0]).toBe(first);
    expect(result.current.picks[2]).toBe(third);
    expect(result.current.picks[1]).not.toBe(second);
    expect(new Set(result.current.picks).size).toBe(3);
  });

  it("rotates the whole row on the interval, out then in", async () => {
    const { result } = renderHook(() => useShuffledPicks(POOL, 3, { rotateMs: ROTATE_MS }));
    const before = [...result.current.picks];

    expect(result.current.phase).toBe("idle");

    await act(async () => {
      vi.advanceTimersByTime(ROTATE_MS);
    });
    // The old set leaves first — swapping here would cut the animation short.
    expect(result.current.phase).toBe("out");
    expect(result.current.picks).toEqual(before);

    await act(async () => {
      vi.advanceTimersByTime(CHIPS_EXIT_MS);
    });
    expect(result.current.phase).toBe("in");
    expect(result.current.picks).not.toEqual(before);

    await act(async () => {
      vi.advanceTimersByTime(CHIPS_ENTER_MS);
    });
    expect(result.current.phase).toBe("idle");
  });

  it("shows an entirely new set on rotation", async () => {
    const { result } = renderHook(() => useShuffledPicks(POOL, 3, { rotateMs: ROTATE_MS }));
    const before = new Set(result.current.picks);

    await rotate();

    // A rotation nobody can see is a rotation that did not happen.
    for (const pick of result.current.picks) expect(before.has(pick)).toBe(false);
    expect(new Set(result.current.picks).size).toBe(3);
  });

  it("bumps the cycle so callers can re-key and re-animate", async () => {
    const { result } = renderHook(() => useShuffledPicks(POOL, 3, { rotateMs: ROTATE_MS }));
    expect(result.current.cycle).toBe(0);

    await rotate();
    expect(result.current.cycle).toBe(1);
  });

  it("never surfaces an excluded item", async () => {
    const excluded = POOL.slice(0, 10);
    const { result } = renderHook(() =>
      useShuffledPicks(POOL, 3, { rotateMs: ROTATE_MS, exclude: excluded }),
    );

    for (const pick of result.current.picks) expect(excluded).not.toContain(pick);
    await rotate();
    for (const pick of result.current.picks) expect(excluded).not.toContain(pick);
  });

  it("drops a visible pick that becomes excluded", () => {
    // The Create-page case: an instrument typed by hand rather than tapped.
    const { result, rerender } = renderHook(
      ({ exclude }: { exclude: string[] }) => useShuffledPicks(POOL, 3, { exclude }),
      { initialProps: { exclude: [] as string[] } },
    );

    const taken = result.current.picks[1]!;
    rerender({ exclude: [taken] });

    expect(result.current.picks).not.toContain(taken);
    expect(result.current.picks).toHaveLength(3);
    expect(new Set(result.current.picks).size).toBe(3);
  });

  it("stops rotating once unmounted", async () => {
    const { result, unmount } = renderHook(() =>
      useShuffledPicks(POOL, 3, { rotateMs: ROTATE_MS }),
    );
    const before = [...result.current.picks];
    unmount();

    await act(async () => {
      vi.advanceTimersByTime(ROTATE_MS * 3);
    });
    expect(result.current.picks).toEqual(before);
  });
});
