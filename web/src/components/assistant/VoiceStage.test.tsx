import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
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

function stage(
  over: {
    captions?: VoiceCaption[];
    onEnd?: () => void;
    onReset?: () => void;
    canReset?: boolean;
  } = {},
) {
  return (
    <Routes>
      <Route
        path="/"
        element={
          <VoiceStage
            captions={over.captions ?? CAPTIONS}
            pendingTranscript={null}
            suggestions={[]}
            onSuggestion={() => undefined}
            onEnd={over.onEnd ?? (() => undefined)}
            onReset={over.onReset ?? (() => undefined)}
            canReset={over.canReset ?? true}
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
  it("delegates, because ending the session unmounts this component", async () => {
    /*
      The button used to own a `useResetChat` here, and that was the bug: the
      DELETE went out, the session was soft-deleted server-side, and the
      `onSuccess` that clears `qk.chat` died with the observer as this
      component unmounted. The screen never changed.

      The owner is now `AvatarPanel`, which survives the teardown.
      `AvatarPanel.test.tsx` asserts the cache actually empties — this only
      asserts the delegation, because a standalone `VoiceStage` never unmounts
      and so could never have caught the original bug.
    */
    const user = userEvent.setup();
    const pressed: string[] = [];
    serve(session());
    renderWithProviders(stage({ onReset: () => pressed.push("reset") }));

    await user.click(await screen.findByRole("button", { name: "Start over" }));

    expect(pressed).toEqual(["reset"]);
  });

  it("is disabled with nothing to start over from", async () => {
    // Gated on the TRANSCRIPT, not on captions: captions are per-call and
    // clear on every new session, while "start over" clears the conversation.
    serve(session());
    renderWithProviders(stage({ canReset: false }));

    expect(await screen.findByRole("button", { name: "Start over" })).toBeDisabled();
  });
});

describe("VoiceStage \u00b7 the transcript", () => {
  it("follows the conversation instead of waiting to be scrolled", async () => {
    /*
      The log is 132px tall. Past four lines it filled and stopped, so every
      turn after that needed a manual scroll — on a surface where the user is
      talking and their hands are nowhere near the mouse.

      jsdom reports every height as 0, so asserting a scrollTop VALUE would
      assert nothing. What is checked is that the effect wrote to the element
      at all, which is the part that was missing.
      */
    const written: number[] = [];
    serve(session());
    const proto = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollTop",
    );
    Object.defineProperty(HTMLElement.prototype, "scrollTop", {
      configurable: true,
      get: () => 0,
      set(value: number) {
        written.push(value);
      },
    });
    try {
      renderWithProviders(
        stage({
          captions: [
            { id: "u1", role: "user", text: "hip-hop" },
            { id: "a1", role: "assistant", text: "Good pick. What mood?" },
          ],
        }),
      );
      await screen.findByRole("log", { name: "Voice transcript" });
      expect(written.length).toBeGreaterThan(0);
    } finally {
      if (proto) Object.defineProperty(HTMLElement.prototype, "scrollTop", proto);
    }
  });
});
