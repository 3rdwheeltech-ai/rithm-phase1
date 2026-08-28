import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import VoiceSheet from "./VoiceSheet";
import { useAssistant } from "../../store/assistant";
import { useAuth } from "../../store/auth";
import { jsonResponse, renderWithProviders } from "../../test-utils";
import type { ChatSessionResponse, SongDraft } from "../../types/api";

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

function serve(over: Partial<ChatSessionResponse> = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      jsonResponse(200, {
        session_id: null,
        messages: [],
        draft: EMPTY,
        ready: false,
        voice_available: true,
        ...over,
      }),
    ),
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
  useAssistant.setState({
    mode: "talk",
    sheetOpen: true,
    voiceStatus: "idle",
    voiceFailure: null,
    voiceCooldownUntil: 0,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.style.overflow = "";
  useAssistant.setState({ mode: "talk", sheetOpen: false, voiceStatus: "idle" });
});

describe("VoiceSheet", () => {
  it("portals to document.body so no backdrop-filter ancestor can trap it", () => {
    /*
      NOT OPTIONAL. `.lg-lens` sets `backdrop-filter`, which makes every panel
      on Home a containing block — the trap `ComingSoonDialog` already
      documents. A sheet rendered inline is a sheet trapped inside a card.
    */
    serve();
    const { container } = renderWithProviders(<VoiceSheet />);

    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("adds no .lg-lens — Home already spends all four", () => {
    // index.css caps four refracting panels on screen at once, and covering
    // them does not free them: they are still in the DOM and still
    // compositing. `.surface` and `.ai-frame` instead, as DraftCard does.
    serve();
    renderWithProviders(<VoiceSheet />);

    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.querySelectorAll(".lg-lens")).toHaveLength(0);
  });

  it("locks body scroll while open and restores it on close", () => {
    document.body.style.overflow = "auto";
    serve();
    const { unmount } = renderWithProviders(<VoiceSheet />);

    expect(document.body.style.overflow).toBe("hidden");

    unmount();
    // Restored to what it WAS, not to "": another sheet may have locked it.
    expect(document.body.style.overflow).toBe("auto");
  });

  it("stops the session on Escape", async () => {
    // A sheet that closes over a live microphone is a sheet still holding the
    // product's one global slot.
    const user = userEvent.setup();
    serve();
    useAssistant.setState({ voiceStatus: "live" });
    renderWithProviders(<VoiceSheet />);

    await user.keyboard("{Escape}");

    await waitFor(() => expect(useAssistant.getState().sheetOpen).toBe(false));
    expect(useAssistant.getState().voiceStatus).not.toBe("live");
  });

  it("uses the poster, never the Lottie avatar", async () => {
    /*
      `AssistantAvatar` statically imports `lottie-react`, so its ~400kB
      renderer would ship to every phone that opens this sheet — undoing
      Layout's split. The `src` prop does not save you: the module cost is paid
      whether or not it is set.
    */
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(process.cwd(), "src/components/assistant/VoiceSheet.tsx"),
      "utf8",
    );

    expect(source).toContain("AssistantPoster");
    expect(source).not.toContain('from "../AssistantAvatar"');
  });

  it("carries both doors, so the card's Chat button has somewhere to land", async () => {
    serve();
    useAssistant.setState({ mode: "chat" });
    renderWithProviders(<VoiceSheet />);

    expect(
      await screen.findByRole("region", { name: "AI assistant chat" }),
    ).toBeInTheDocument();
    // Still no lens: ChatPanel renders `chrome="plain"` in here.
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.querySelectorAll(".lg-lens")).toHaveLength(0);
  });

  it("tears the session down before the chat door can render Start over", async () => {
    /*
      Unlike desktop, this sheet can render both doors. `useResetChat`
      soft-deletes server-side, after which a live loop's next POST would
      silently open a NEW session and fork the transcript.
    */
    serve();
    useAssistant.setState({ voiceStatus: "live", mode: "talk" });
    renderWithProviders(<VoiceSheet />);

    // The sheet subscribes to `mode`, so the store change is the re-render.
    useAssistant.setState({ mode: "chat" });

    await waitFor(() => expect(useAssistant.getState().voiceStatus).not.toBe("live"));
  });
});
