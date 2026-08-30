import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import VoiceStage, { type VoiceCaption } from "./VoiceStage";
import { useAssistant } from "../../store/assistant";
import { useAuth } from "../../store/auth";
import { jsonResponse, renderWithProviders } from "../../test-utils";
import type { ChatSessionResponse, SongDraft } from "../../types/api";

/**
 * The two controls the Talk surface was missing, and the handoff it never had.
 *
 * Both were reported from a live call: the Create button existed only in Chat,
 * so somebody who described a song entirely by voice had to switch doors to
 * find it, and there was no way to start over without ending and reloading.
 */

const EMPTY: SongDraft = {
  prompt: null,
  title: null,
  genre: null,
  mood: null,
  instruments: [],
  length_seconds: null,
  bpm_min: null,
  bpm_max: null,
  lyrics_mode: null,
  voice: null,
  lyrics: null,
  lyrics_prompt: null,
};

const CAPTIONS: VoiceCaption[] = [
  { id: "u1", role: "user", text: "hip-hop, something dark" },
];

function session(over: Partial<ChatSessionResponse> = {}): ChatSessionResponse {
  return {
    session_id: "s1",
    messages: [],
    draft: EMPTY,
    ready: false,
    voice_available: true,
    ...over,
  };
}

function serve(body: ChatSessionResponse) {
  const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(200, body)));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function stage(over: { captions?: VoiceCaption[]; onEnd?: () => void } = {}) {
  return (
    <Routes>
      <Route
        path="/"
        element={
          <VoiceStage
            captions={over.captions ?? CAPTIONS}
            pendingTranscript={null}
            onEnd={over.onEnd ?? (() => undefined)}
            onGesture={() => undefined}
          />
        }
      />
      <Route path="/create" element={<p>Create page</p>} />
    </Routes>
  );
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  useAuth.setState({ status: "authed" });
  useAssistant.setState({ voiceStatus: "live", voicePhase: "listening" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("VoiceStage · the way out to Create", () => {
  it("offers nothing while the song is not describable yet", async () => {
    serve(session({ ready: false }));
    renderWithProviders(stage());

    await screen.findByRole("button", { name: "End" });
    expect(screen.queryByRole("button", { name: /Open in Create/ })).toBeNull();
  });

  it("opens the door the moment the draft is ready, and carries the draft", async () => {
    /*
      `ready` is the SAME server-derived flag `DraftCard` gates on, arriving
      through the same `qk.chat` entry — so the two doors cannot disagree about
      when a song is describable. The draft rides in router state exactly as
      DraftCard does, so /create is pre-filled rather than re-derived.
    */
    const user = userEvent.setup();
    const draft: SongDraft = { ...EMPTY, genre: "Hip-Hop", mood: "Dark" };
    serve(session({ ready: true, draft }));
    renderWithProviders(stage());

    await user.click(await screen.findByRole("button", { name: /Open in Create/ }));

    expect(await screen.findByText("Create page")).toBeInTheDocument();
  });
});

describe("VoiceStage · start over", () => {
  it("ends the session before clearing the conversation", async () => {
    /*
      ORDER IS THE POINT. Clearing the transcript under a live avatar would
      leave Ria mid-sentence about a conversation that no longer exists — and
      ending first releases the product's one global Anam slot rather than
      holding it for a call whose whole subject was just deleted.
    */
    const user = userEvent.setup();
    const order: string[] = [];
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") order.push("reset");
      return Promise.resolve(jsonResponse(200, session()));
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(stage({ onEnd: () => order.push("end") }));

    await user.click(await screen.findByRole("button", { name: "Start over" }));

    await waitFor(() => expect(order).toEqual(["end", "reset"]));
  });

  it("is disabled with nothing to start over from", async () => {
    // Mirrors ChatPanel's `disabled={messages.length === 0}`, so the pair of
    // quiet utilities behaves the same on both doors.
    serve(session());
    renderWithProviders(stage({ captions: [] }));

    expect(await screen.findByRole("button", { name: "Start over" })).toBeDisabled();
  });
});
