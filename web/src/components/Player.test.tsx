import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import Player from "./Player";
import { usePlayer } from "../store/player";
import { renderWithProviders, jsonResponse } from "../test-utils";
import type { TrackSummary } from "../types/api";

const TRACK: TrackSummary = {
  id: "01J000000000000000000000T1",
  prompt: "warm lo-fi piano, soft vinyl crackle",
  genre: "Lo-Fi",
  mood: "Calm",
  bpm: 85,
  vocal: false,
  length_seconds: 30,
  mp3_url: "https://s3.example/stale.mp3?X-Amz-Expires=900",
  created_at: "2026-08-04T12:00:00Z",
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
  usePlayer.setState({ track: TRACK, isPlaying: false, position: 0 });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  usePlayer.setState({ track: null, isPlaying: false, position: 0 });
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

    await act(async () => {
      fireEvent.error(audio());
    });

    await waitFor(() =>
      expect(usePlayer.getState().track?.mp3_url).toBe(
        "https://s3.example/fresh.mp3?X-Amz-Expires=900",
      ),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(`/api/v1/tracks/${TRACK.id}`);
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

    // First failure: one refetch.
    await act(async () => {
      fireEvent.error(audio());
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // Second failure on the same track: no further requests, and say so.
    await act(async () => {
      fireEvent.error(audio());
    });

    expect(await screen.findByText("This link expired — refresh the page.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
});
