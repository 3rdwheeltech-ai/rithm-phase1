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

function recordResponse(draft: SongDraft = EMPTY, ready = false) {
  return { draft, ready };
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
  it("a recorded voice turn lands in the same qk.chat entry ChatPanel renders", async () => {
    /*
      THE CENTRAL DESIGN DECISION OF THE FEATURE, AND IT SURVIVED THE BRAIN
      SWITCH.

      Anam's own model writes the replies now, but the interview record, the
      draft and the transcript never moved. Talk and Chat remain two doors on
      ONE conversation — which is the property that stopped the switch being a
      trade of the whole product for latency, because everything said out loud
      is still on the server.
    */
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) =>
        Promise.resolve(
          init?.method === "POST"
            ? jsonResponse(200, recordResponse())
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
    const outcome = await result.current([
      { role: "user", content: "a rainy drive" },
      { role: "assistant", content: "Nice one — what mood?" },
    ]);

    expect(outcome).toEqual({ kind: "recorded" });

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

  it("posts both sides of the exchange, in order", async () => {
    // The persona's line is the only copy that exists — Anam wrote it and this
    // is the one path that persists it. Order matters because the extractor
    // reads a user turn as the answer to the line above it.
    const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
      Promise.resolve(
        init?.method === "POST"
          ? jsonResponse(200, recordResponse())
          : jsonResponse(200, { session_id: null, messages: [], draft: EMPTY, ready: false }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useVoiceTurn(), { wrapper });
    await result.current([
      { role: "user", content: "hip-hop" },
      { role: "assistant", content: "Hip-Hop it is." },
    ]);

    const post = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST",
    );
    expect(String(post![0])).toContain("/chat/turns/record");
    expect(JSON.parse((post![1] as RequestInit).body as string)).toEqual({
      turns: [
        { role: "user", content: "hip-hop" },
        { role: "assistant", content: "Hip-Hop it is." },
      ],
    });
  });

  it("says nothing and keeps going when one batch fails for an unknown reason", async () => {
    /*
      THE DELIBERATE HALF OF THE NEW TRADE.

      A refused turn used to cost the user their ANSWER, which they noticed at
      once. It now costs the RECORD: Anam keeps talking and the conversation
      sounds perfect. Interrupting a working call to announce a problem the
      user cannot act on would cost more than it saves — the next batch may
      land, and the draft rebuilds from whatever does. `voice_turn_recorded`
      going quiet in CloudWatch is how the persistent version gets noticed.
    */
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
    const outcome = await result.current([{ role: "user", content: "a rainy drive" }]);

    expect(outcome).toEqual({ kind: "recorded" });
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
    const outcome = await result.current([{ role: "user", content: "a rainy drive" }]);

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
    const outcome = await result.current([{ role: "user", content: "a rainy drive" }]);

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
