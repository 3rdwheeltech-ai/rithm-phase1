import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { useVoiceTurn } from "./useVoiceTurn";
import ChatPanel from "../components/assistant/ChatPanel";
import { useAuth } from "../store/auth";
import { jsonResponse } from "../test-utils";
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

function turnResponse(content: string) {
  return {
    message: {
      id: "a1",
      role: "assistant" as const,
      content,
      created_at: "2026-08-25T12:00:00Z",
    },
    draft: EMPTY,
    ready: false,
    suggestions: ["Lo-Fi"],
  };
}

function problem(status: number, type: string) {
  return jsonResponse(status, { type, title: "no", status, detail: "no" });
}

let client: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  useAuth.setState({ status: "authed" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useVoiceTurn", () => {
  it("a voice turn lands in the same qk.chat entry ChatPanel renders", async () => {
    /*
      THE CENTRAL DESIGN DECISION OF THE FEATURE, ASSERTED.

      Anam is a face and a voice; the interview, the draft and the transcript
      never move. Talk and Chat are two doors on ONE conversation — which is
      what makes every fallback lossless, because everything ever said is
      already on the server before a single word is spoken aloud.
    */
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) =>
        Promise.resolve(
          init?.method === "POST"
            ? jsonResponse(200, turnResponse("Nice one — what mood?"))
            : jsonResponse(200, {
                session_id: null,
                messages: [],
                draft: EMPTY,
                ready: false,
                voice_available: true,
              } satisfies ChatSessionResponse),
        ),
      ),
    );

    const { result } = renderHook(() => useVoiceTurn(), { wrapper });
    const outcome = await result.current("a rainy drive");

    expect(outcome).toEqual({
      kind: "reply",
      text: "Nice one — what mood?",
      suggestions: ["Lo-Fi"],
    });

    // The SAME QueryClient. Nothing was passed between them but the cache.
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ChatPanel />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("a rainy drive")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText("Nice one — what mood?")).toBeInTheDocument(),
    );
  });

  it("marks the turn as coming through the voice door", async () => {
    // It writes `sessions.voice_enabled` and puts `voice=true` on the
    // `chat_turn` log line the rollout is read from.
    const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
      Promise.resolve(
        init?.method === "POST"
          ? jsonResponse(200, turnResponse("ok"))
          : jsonResponse(200, { session_id: null, messages: [], draft: EMPTY, ready: false }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useVoiceTurn(), { wrapper });
    await result.current("hello");

    const post = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST",
    );
    expect(JSON.parse((post![1] as RequestInit).body as string)).toEqual({
      message: "hello",
      source: "voice",
    });
  });

  it("maps assistant-unavailable to a spoken retry that keeps the session open", async () => {
    // The user's message is already committed server-side, so saying it again
    // genuinely works — and ending the call would cost them the slot too.
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) =>
        Promise.resolve(
          init?.method === "POST"
            ? problem(503, "https://rithm.dev/errors/assistant-unavailable")
            : jsonResponse(200, { session_id: null, messages: [], draft: EMPTY, ready: false }),
        ),
      ),
    );

    const { result } = renderHook(() => useVoiceTurn(), { wrapper });
    const outcome = await result.current("a rainy drive");

    expect(outcome).toEqual({
      kind: "spoken-error",
      text: "Sorry — I lost that one. Say it again?",
      end: null,
    });
  });

  it("maps chat-session-full to a spoken handoff that closes the session", async () => {
    // Holding the one global slot open for a server that will refuse the next
    // turn too is the failure this prevents.
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) =>
        Promise.resolve(
          init?.method === "POST"
            ? problem(409, "https://rithm.dev/errors/chat-session-full")
            : jsonResponse(200, { session_id: null, messages: [], draft: EMPTY, ready: false }),
        ),
      ),
    );

    const { result } = renderHook(() => useVoiceTurn(), { wrapper });
    const outcome = await result.current("a rainy drive");

    expect(outcome).toMatchObject({ kind: "spoken-error", end: "chat-full" });
  });

  it("maps the daily cap to a spoken ending that says nothing was lost", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) =>
        Promise.resolve(
          init?.method === "POST"
            ? problem(429, "https://rithm.dev/errors/429")
            : jsonResponse(200, { session_id: null, messages: [], draft: EMPTY, ready: false }),
        ),
      ),
    );

    const { result } = renderHook(() => useVoiceTurn(), { wrapper });
    const outcome = await result.current("a rainy drive");

    expect(outcome).toEqual({
      kind: "spoken-error",
      text: "That's all I can do for today. Everything we talked about is saved.",
      end: "chat-rate-limited",
    });
  });

  it("hands the loop a callback whose identity never changes", async () => {
    // `VoiceTurnLoop` registers it ONCE at session start. A callback that
    // changed per render would leave the loop holding a mutateAsync from three
    // turns ago.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, { session_id: null, messages: [], draft: EMPTY, ready: false }),
      ),
    );

    const { result, rerender } = renderHook(() => useVoiceTurn(), { wrapper });
    const first = result.current;
    rerender();
    rerender();

    expect(result.current).toBe(first);
  });
});
