import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import QuickGenerate from "./QuickGenerate";
import CreateForm from "./create/CreateForm";
import { renderWithProviders, jsonResponse } from "../test-utils";
import { PROMPT_SUGGESTIONS } from "../lib/suggestions";
import { CHIPS_ENTER_MS, CHIPS_EXIT_MS } from "../lib/useShuffledPicks";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(
    jsonResponse(202, {
      job_id: "01J000000000000000000000J1",
      status: "QUEUED",
      sse_url: "/api/v1/jobs/01J000000000000000000000J1/events?token=tok",
      created_at: "2026-08-04T12:00:00Z",
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal(
    "EventSource",
    class {
      close() {}
      addEventListener() {}
    },
  );
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

describe("QuickGenerate doors", () => {
  it("offers two doors, labelled Make rather than Vocals", () => {
    renderWithProviders(<QuickGenerate />);

    // Three became two: "Generate" and "Instrumental" were never really a
    // choice on a surface with no lyrics box, and "Write lyrics" was never a
    // mode at all.
    const tabs = screen.getAllByRole("tab").map((tab) => tab.textContent?.trim());
    expect(tabs).toEqual(["Music", "Write lyrics"]);
    expect(screen.getByText("Make")).toBeInTheDocument();
    expect(screen.queryByText("Vocals")).not.toBeInTheDocument();
  });

  it("sends an instrumental with no name, so the server writes one", async () => {
    const user = userEvent.setup();
    renderWithProviders(<QuickGenerate />);

    await user.type(screen.getByLabelText("Describe the music you want"), "rain on glass");
    await user.click(screen.getByRole("button", { name: "Generate" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const call = fetchMock.mock.calls.find(([url]) => url === "/api/v1/tracks/generate")!;
    const body = JSON.parse((call[1] as RequestInit).body as string) as Record<
      string,
      unknown
    >;

    // Home's Music door means instrumental, and the two fields that say so
    // must agree — the API 422s them otherwise.
    expect(body.vocal).toBe(false);
    expect(body.lyrics_mode).toBe("instrumental");
    expect(body.voice).toBe("auto");
    // Null title is what triggers the server-side naming, which is how Home
    // tracks get a real name for free.
    expect(body.title).toBeNull();
    expect(body.lyrics).toBeNull();
    expect(body.lyrics_prompt).toBeNull();
  });

  it("carries the typed prompt through the Write lyrics door", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <Routes>
        <Route path="/" element={<QuickGenerate />} />
        <Route path="/create" element={<CreateForm />} />
      </Routes>,
    );

    await user.type(screen.getByLabelText("Describe the music you want"), "opera metal");
    await user.click(screen.getByRole("tab", { name: "Write lyrics" }));

    // Silently discarding what the user already typed is the one thing about
    // the old three-door row that was a bug rather than a design choice.
    expect(screen.getByLabelText("Describe the track")).toHaveValue("opera metal");
  });
});
