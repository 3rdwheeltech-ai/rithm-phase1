import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AvatarPanel from "./AvatarPanel";
import { useAssistant } from "../store/assistant";
import { useAuth } from "../store/auth";
import { jsonResponse, renderWithProviders } from "../test-utils";
import type { ChatSessionResponse, SongDraft } from "../types/api";

/* lottie-web reaches for a real canvas at IMPORT time and jsdom has none. */
vi.mock("lottie-react", () => ({ default: () => null }));

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

function session(over: Partial<ChatSessionResponse> = {}): ChatSessionResponse {
  return { session_id: null, messages: [], draft: EMPTY, ready: false, ...over };
}

function serve(body: ChatSessionResponse) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, body)));
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
  useAssistant.setState({ mode: "talk" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  useAssistant.setState({ mode: "talk" });
});

describe("AvatarPanel", () => {
  it("makes Talk the panel's primary action, and says voice is not built yet", async () => {
    const user = userEvent.setup();
    serve(session());
    renderWithProviders(<AvatarPanel />);

    await user.click(screen.getByRole("button", { name: "Talk" }));

    expect(await screen.findByRole("dialog", { name: /Voice chat/ })).toBeInTheDocument();
    // Still on the Talk side: a Coming Soon is not a mode change.
    expect(useAssistant.getState().mode).toBe("talk");
  });

  it("switches to chat from the toggle", async () => {
    const user = userEvent.setup();
    serve(session());
    renderWithProviders(<AvatarPanel />);

    await user.click(screen.getByRole("tab", { name: "Chat" }));

    expect(useAssistant.getState().mode).toBe("chat");
  });

  it("resumes a live conversation after a reload", async () => {
    // `useAssistant` is not persisted, so a refresh lands here with a session
    // sitting on the server. The transcript is what decides, not a stored flag.
    serve(
      session({
        session_id: "s1",
        messages: [{ id: "m0", role: "user", content: "hi", created_at: "2026-08-25T12:00:00Z" }],
      }),
    );
    renderWithProviders(<AvatarPanel />);

    await waitFor(() => expect(useAssistant.getState().mode).toBe("chat"));
  });
});
