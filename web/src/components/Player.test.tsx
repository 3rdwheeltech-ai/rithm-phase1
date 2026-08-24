import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import Player from "./Player";
import { usePlayer } from "../store/player";
import { renderWithProviders, jsonResponse } from "../test-utils";
import type { TrackSummary } from "../types/api";

const TRACK: TrackSummary = {
  id: "01J000000000000000000000T1",
  prompt: "warm lo-fi piano, soft vinyl crackle",
  // Null is the state of every track older than the title column, and what
  // keeps these fixtures exercising trackTitle's prompt derivation.
  title: null,
  genre: "Lo-Fi",
  mood: "Calm",
  bpm: 85,
  vocal: false,
  length_seconds: 30,
  mp3_url: "https://s3.example/stale.mp3?X-Amz-Expires=900",
  created_at: "2026-08-04T12:00:00Z",
};

const TRACK2: TrackSummary = {
  ...TRACK,
  id: "01J000000000000000000000T2",
  prompt: "driving synthwave, neon bass",
  mp3_url: "https://s3.example/second.mp3?X-Amz-Expires=900",
};

let fetchMock: ReturnType<typeof vi.fn>;

function audio(): HTMLAudioElement {
  return screen.getByTestId("player-audio") as HTMLAudioElement;
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  // jsdom has no media stack.
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  usePlayer.setState({ track: TRACK, queue: [TRACK], isPlaying: false, position: 0 });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  usePlayer.setState({ track: null, queue: [], isPlaying: false, position: 0 });
});

describe("Player", () => {
  it("refetches the track exactly once when the presigned URL has expired", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        ...TRACK,
        mp3_url: "https://s3.example/fresh.mp3?X-Amz-Expires=900",
        wav_url: "https://s3.example/fresh.wav",
        waveform_hash: "abc",
        prompt_history: [],
      }),
    );

    renderWithProviders(<Player variant="home" />);

    // The panel reads the track detail for its lyrics, so the raw call count is
    // no longer the recovery's own. Measure the DELTA across the error instead
    // — that is what "exactly once" was ever about.
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const before = fetchMock.mock.calls.length;

    await act(async () => {
      fireEvent.error(audio());
    });

    await waitFor(() =>
      expect(usePlayer.getState().track?.mp3_url).toBe(
        "https://s3.example/fresh.mp3?X-Amz-Expires=900",
      ),
    );
    expect(fetchMock.mock.calls.length - before).toBe(1);
    const last = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string];
    expect(last[0]).toBe(`/api/v1/tracks/${TRACK.id}`);
  });

  it("gives up after the retry rather than looping against a dead link", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        ...TRACK,
        wav_url: "https://s3.example/fresh.wav",
        waveform_hash: "abc",
        prompt_history: [],
      }),
    );

    renderWithProviders(<Player variant="home" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const before = fetchMock.mock.calls.length;

    // First failure: one refetch.
    await act(async () => {
      fireEvent.error(audio());
    });
    await waitFor(() => expect(fetchMock.mock.calls.length - before).toBe(1));
    const afterFirst = fetchMock.mock.calls.length;

    // Second failure on the same track: no further requests, and say so.
    await act(async () => {
      fireEvent.error(audio());
    });

    expect(await screen.findByText("This link expired — refresh the page.")).toBeInTheDocument();
    expect(fetchMock.mock.calls.length).toBe(afterFirst);
  });

  it("shows an empty state and disables play with no track loaded", () => {
    usePlayer.setState({ track: null });
    renderWithProviders(<Player variant="home" />);

    expect(screen.getByText("Select a track to play")).toBeInTheDocument();
  });

  it("exposes the player as a labelled region", () => {
    renderWithProviders(<Player variant="home" />);
    expect(screen.getByRole("region", { name: "Track player" })).toBeInTheDocument();
  });

  it("keeps the transport mounted across timeupdate while playing", async () => {
    usePlayer.setState({ track: TRACK, queue: [TRACK, TRACK2], isPlaying: true });
    renderWithProviders(<Player variant="home" />);

    const before = screen.getByRole("button", { name: "Next track" });
    const seekBefore = screen.getByRole("slider", { name: "Seek" });

    // The regression: ProgressTrack and Transport used to be declared inside
    // Player, so every render was a NEW component type and React remounted
    // them. timeupdate fires several times a second, so the controls were torn
    // down under the pointer and no click or drag could land.
    const el = audio();
    Object.defineProperty(el, "duration", { value: 30, configurable: true });
    for (let i = 0; i < 5; i += 1) {
      Object.defineProperty(el, "currentTime", { value: i, configurable: true });
      await act(async () => {
        fireEvent.timeUpdate(el);
      });
    }

    // Same DOM nodes, not replacements.
    expect(screen.getByRole("button", { name: "Next track" })).toBe(before);
    expect(screen.getByRole("slider", { name: "Seek" })).toBe(seekBefore);
  });

  it("walks the queue with next and previous", async () => {
    usePlayer.setState({ track: TRACK, queue: [TRACK, TRACK2], isPlaying: true });
    renderWithProviders(<Player variant="home" />);

    expect(screen.getByRole("button", { name: "Previous track" })).toBeDisabled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Next track" }));
    });
    expect(usePlayer.getState().track?.id).toBe(TRACK2.id);

    // At the end of the queue Next is honestly disabled rather than inert.
    expect(screen.getByRole("button", { name: "Next track" })).toBeDisabled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Previous track" }));
    });
    expect(usePlayer.getState().track?.id).toBe(TRACK.id);
  });

  it("disables next and previous when the queue holds one track", () => {
    usePlayer.setState({ track: TRACK, queue: [TRACK], isPlaying: false });
    renderWithProviders(<Player variant="home" />);

    expect(screen.getByRole("button", { name: "Next track" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Previous track" })).toBeDisabled();
  });

  it("seeks by dragging the timeline", async () => {
    renderWithProviders(<Player variant="home" />);
    const el = audio();
    Object.defineProperty(el, "duration", { value: 100, configurable: true });
    // The rail refuses to scrub until it knows the duration, exactly as it does
    // before metadata lands in a browser.
    await act(async () => {
      fireEvent.loadedMetadata(el);
    });

    const seek = screen.getByRole("slider", { name: "Seek" });
    // jsdom gives every element a zero-size rect; supply a real one.
    vi.spyOn(seek, "getBoundingClientRect").mockReturnValue({
      left: 0,
      width: 200,
      top: 0,
      height: 8,
      right: 200,
      bottom: 8,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    seek.setPointerCapture = vi.fn();
    seek.hasPointerCapture = vi.fn().mockReturnValue(true);
    seek.releasePointerCapture = vi.fn();

    await act(async () => {
      fireEvent.pointerDown(seek, { clientX: 50, pointerId: 1 });
    });
    expect(el.currentTime).toBe(25);

    // The drag continues past pointerdown — this is what a click-only <button>
    // could never do.
    await act(async () => {
      fireEvent.pointerMove(seek, { clientX: 150, pointerId: 1 });
    });
    expect(el.currentTime).toBe(75);

    // Separate acts on purpose: the browser delivers pointerup and pointermove
    // as separate discrete events and React flushes between them. Batching both
    // into one act would test a sequence that cannot happen.
    await act(async () => {
      fireEvent.pointerUp(seek, { clientX: 150, pointerId: 1 });
    });
    await act(async () => {
      fireEvent.pointerMove(seek, { clientX: 20, pointerId: 1 });
    });
    // Released: further movement must not keep scrubbing.
    expect(el.currentTime).toBe(75);
  });

  it("advances to the next queued track when one ends", async () => {
    usePlayer.setState({ track: TRACK, queue: [TRACK, TRACK2], isPlaying: true });
    renderWithProviders(<Player variant="home" />);

    await act(async () => {
      fireEvent.ended(audio());
    });

    expect(usePlayer.getState().track?.id).toBe(TRACK2.id);
    expect(usePlayer.getState().isPlaying).toBe(true);
  });

  it("stops at the end of the queue rather than looping", async () => {
    usePlayer.setState({ track: TRACK, queue: [TRACK], isPlaying: true });
    renderWithProviders(<Player variant="home" />);

    await act(async () => {
      fireEvent.ended(audio());
    });

    expect(usePlayer.getState().isPlaying).toBe(false);
  });
});
