import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import VoiceCard from "./VoiceCard";
import { useAssistant } from "../../store/assistant";
import { useAuth } from "../../store/auth";
import { jsonResponse, renderWithProviders } from "../../test-utils";
import type { ChatSessionResponse, SongDraft } from "../../types/api";

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
        ...over,
      }),
    ),
  );
}

beforeEach(() => {
  useAuth.setState({ status: "authed" });
  useAssistant.setState({ mode: "talk", sheetOpen: false });
});

afterEach(() => {
  vi.unstubAllGlobals();
  useAssistant.setState({ mode: "talk", sheetOpen: false });
});

describe("VoiceCard", () => {
  it("imports neither the Lottie renderer nor the SDK", async () => {
    /*
      THE ENTRY-CHUNK GUARD. This card renders on every mobile Home load, so
      anything it reaches for is paid for by every phone — which is exactly
      what `Layout`'s "never loaded on a phone at all" comment protects, and
      what `AssistantPoster` exists to keep true.

      Checked against the SOURCE rather than inferred, because the failure is
      silent: the app still works, the bundle is just 400kB heavier on the one
      device that can least afford it.

      Note also that this file carries NO `vi.mock("lottie-react")`, unlike
      every other test that touches the assistant. If a Lottie import ever
      creeps in, lottie-web reaches for a real canvas AT IMPORT TIME and this
      suite dies on the spot rather than passing quietly.
    */
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(process.cwd(), "src/components/assistant/VoiceCard.tsx"),
      "utf8",
    );

    expect(source).not.toContain("lottie");
    expect(source).not.toContain("@anam-ai");
    expect(source).not.toContain("AssistantAvatar");

    serve({ voice_available: true });
    renderWithProviders(<VoiceCard />);

    expect(await screen.findByRole("button", { name: "Talk" })).toBeInTheDocument();
  });

  it("opens the sheet on the voice door", async () => {
    const user = userEvent.setup();
    serve({ voice_available: true });
    renderWithProviders(<VoiceCard />);

    await user.click(await screen.findByRole("button", { name: "Talk" }));

    expect(useAssistant.getState().sheetOpen).toBe(true);
    expect(useAssistant.getState().mode).toBe("talk");
  });

  it("opens the sheet on the chat door", async () => {
    const user = userEvent.setup();
    serve({ voice_available: true });
    renderWithProviders(<VoiceCard />);

    await user.click(await screen.findByRole("button", { name: "Chat" }));

    expect(useAssistant.getState().sheetOpen).toBe(true);
    expect(useAssistant.getState().mode).toBe("chat");
  });

  it("keeps Chat working where voice was never configured", async () => {
    // Talk is DISABLED rather than hidden: a control that vanishes between
    // visits reads as a bug, and the pair is the point of the card.
    const user = userEvent.setup();
    serve({ voice_available: false });
    renderWithProviders(<VoiceCard />);

    const talk = await screen.findByRole("button", { name: "Talk" });
    expect(talk).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Chat" }));
    expect(useAssistant.getState().sheetOpen).toBe(true);
  });
});
