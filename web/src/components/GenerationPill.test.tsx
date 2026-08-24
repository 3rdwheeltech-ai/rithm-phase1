import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { JobStreamState } from "../hooks/useJobStream";

/**
 * The pill owns the stream, so the stream is what has to be driven. Everything
 * below is about what the pill SAYS and whether it blocks the app; how the
 * EventSource gets there is `useJobStream`'s business.
 */
let streamState: JobStreamState = { phase: "idle", jobId: null, connection: "closed" };
const setStream = (next: Partial<JobStreamState>) => {
  streamState = { ...streamState, ...next };
};

vi.mock("../hooks/useJobStream", () => ({
  useJobStream: () => streamState,
}));

const { default: GenerationPill } = await import("./GenerationPill");
const { renderWithProviders } = await import("../test-utils");
const { useGeneration } = await import("../store/generation");

/** Puts a job in flight, as `useGenerate` would on a 202. */
function start(writesLyrics = false) {
  act(() => {
    useGeneration.getState().begin(writesLyrics);
    useGeneration.getState().accept({ jobId: "job-1", sseUrl: "/jobs/job-1/stream?t=x" });
  });
}

/** Nudges the pill to re-read the mocked stream. */
function flush() {
  act(() => {
    useGeneration.getState().publish(streamState);
  });
}

afterEach(() => {
  streamState = { phase: "idle", jobId: null, connection: "closed" };
  act(() => useGeneration.getState().reset());
});

describe("GenerationPill", () => {
  it("stays out of the way until something is generating", () => {
    renderWithProviders(<GenerationPill />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("is a status, not a modal — the whole point of replacing the scrim", async () => {
    renderWithProviders(<GenerationPill />);
    setStream({ phase: "running", jobId: "job-1" });
    start();

    const pill = await screen.findByRole("status");
    // The two properties that made the old JobProgress blocking.
    expect(pill).not.toHaveAttribute("aria-modal");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // And the wrapper it sits in must not swallow clicks meant for the app.
    expect(pill.parentElement).toHaveClass("pointer-events-none");
  });

  it("reports the phase it is handed", async () => {
    renderWithProviders(<GenerationPill />);
    start(true);

    setStream({ phase: "queued", jobId: "job-1" });
    flush();
    expect(await screen.findByText("Queued…")).toBeInTheDocument();

    setStream({ estimatedStartSeconds: 90 });
    flush();
    expect(await screen.findByText("Warming up…")).toBeInTheDocument();

    setStream({ phase: "running" });
    flush();
    expect(await screen.findByText("Generating lyrics…")).toBeInTheDocument();
  });

  it("never claims to be writing lyrics the user supplied", async () => {
    renderWithProviders(<GenerationPill />);
    start(false);
    setStream({ phase: "running", jobId: "job-1" });
    flush();

    expect(await screen.findByText("Composing the song…")).toBeInTheDocument();
    expect(screen.queryByText("Generating lyrics…")).not.toBeInTheDocument();
  });

  it("carries an elapsed counter while a job is in flight", async () => {
    renderWithProviders(<GenerationPill />);
    setStream({ phase: "running", jobId: "job-1" });
    start();

    expect(await screen.findByText("0:00")).toBeInTheDocument();
  });

  it("offers a way out of a dead end, and no way to dismiss a live job", async () => {
    const user = userEvent.setup();
    renderWithProviders(<GenerationPill />);
    setStream({ phase: "running", jobId: "job-1" });
    start();

    await screen.findByRole("status");
    expect(screen.queryByRole("button", { name: "Dismiss" })).not.toBeInTheDocument();

    setStream({ phase: "lost" });
    flush();
    expect(await screen.findByText("We lost track of this one")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });
});
