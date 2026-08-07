import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import QuickGenerate from "./QuickGenerate";
import { renderWithProviders } from "../test-utils";
import { PROMPT_SUGGESTIONS } from "../lib/suggestions";
import { CHIPS_ENTER_MS, CHIPS_EXIT_MS } from "../lib/useShuffledPicks";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** The suggestion chips, by their visible text. */
function chips(): string[] {
  return screen
    .getAllByRole("button")
    .map((b) => b.textContent?.trim() ?? "")
    .filter((text) => PROMPT_SUGGESTIONS.includes(text));
}

describe("QuickGenerate suggestions", () => {
  it("shows three distinct prompts drawn from the pool", () => {
    renderWithProviders(<QuickGenerate />);

    const shown = chips();
    expect(shown).toHaveLength(3);
    expect(new Set(shown).size).toBe(3);
  });

  it("fills the box and swaps only the chip that was picked", async () => {
    const user = userEvent.setup();
    renderWithProviders(<QuickGenerate />);

    const before = chips();
    const picked = before[1]!;
    await user.click(screen.getByRole("button", { name: picked }));

    expect(screen.getByLabelText("Describe the music you want")).toHaveValue(picked);

    const after = chips();
    expect(after).toHaveLength(3);
    expect(after).not.toContain(picked);
    // The two the user did not touch stay put.
    expect(after[0]).toBe(before[0]);
    expect(after[2]).toBe(before[2]);
  });

  it("rotates the whole row on the timer, sliding out before sliding in", async () => {
    vi.useFakeTimers();
    renderWithProviders(<QuickGenerate />);
    const before = chips();

    const row = () => screen.getByRole("button", { name: before[0]! }).parentElement!;

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    // Old set leaves first, still on screen while it animates out.
    expect(row().className).toContain("chips-out");
    expect(chips()).toEqual(before);

    await act(async () => {
      vi.advanceTimersByTime(CHIPS_EXIT_MS);
    });
    const after = chips();
    expect(after).toHaveLength(3);
    for (const chip of after) expect(before).not.toContain(chip);

    await act(async () => {
      vi.advanceTimersByTime(CHIPS_ENTER_MS);
    });
    const settled = screen.getByRole("button", { name: after[0]! }).parentElement!;
    expect(settled.className).not.toContain("chips-out");
    expect(settled.className).not.toContain("chips-in");
  });
});
