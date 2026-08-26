import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ChatPanel from "./ChatPanel";
import { useAssistant } from "../../store/assistant";
import { useAuth } from "../../store/auth";
import { jsonResponse, renderWithProviders } from "../../test-utils";
import type { ChatSessionResponse, ChatTurnResponse, SongDraft } from "../../types/api";

/*
  lottie-web reaches for a real canvas at IMPORT time, and jsdom has none — the
  module throws before a single test collects. Mocked at the renderer rather
  than at AssistantAvatar so the header still renders the real component and
  its markup stays under test.
*/
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

const READY_DRAFT: SongDraft = {
  ...EMPTY,
  prompt: "a rainy late-night drive",
  title: "Neon Rooftop",
  genre: "Lo-Fi",
  mood: "Calm",
  instruments: ["piano", "rhodes", "drums"],
  lyrics_mode: "instrumental",
  voice: "auto",
};

function session(over: Partial<ChatSessionResponse> = {}): ChatSessionResponse {
  return { session_id: "s1", messages: [], draft: EMPTY, ready: false, ...over };
}

// Ids are uuid7 in production; a counter here keeps every turn distinct, which
// is what the transcript's React keys are built from.
let nextId = 2;

function turn(over: Partial<ChatTurnResponse> = {}): ChatTurnResponse {
  return {
    message: {
      id: `m${nextId++}`,
      role: "assistant",
      content: "What genre fits it best?",
      created_at: "2026-08-25T12:00:01Z",
    },
    draft: EMPTY,
    ready: false,
    suggestions: [],
    ...over,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  // useChatSession is gated on an authed session, exactly like useMe.
  useAuth.setState({ status: "authed" });
  useAssistant.setState({ mode: "chat" });
  nextId = 2;
});

afterEach(() => {
  vi.unstubAllGlobals();
  useAssistant.setState({ mode: "talk" });
});

/**
 * GET the session, then answer every POST with `next`.
 *
 * A FACTORY, not a value: a test that sends twice would otherwise get the same
 * message id back both times, and two transcript entries sharing a React key
 * is a bug in the fixture that looks like a bug in the panel.
 */
function serve(initial: ChatSessionResponse, next?: () => ChatTurnResponse | Response) {
  fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "GET") {
      return Promise.resolve(jsonResponse(200, initial));
    }
    const answer = next ? next() : turn();
    return Promise.resolve(answer instanceof Response ? answer : jsonResponse(200, answer));
  });
}

describe("ChatPanel", () => {
  it("renders the transcript the server resumed", async () => {
    serve(
      session({
        messages: [
          { id: "m0", role: "user", content: "a rainy drive", created_at: "2026-08-25T12:00:00Z" },
          { id: "m1", role: "assistant", content: "Lovely. What genre?", created_at: "2026-08-25T12:00:01Z" },
        ],
      }),
    );
    renderWithProviders(<ChatPanel />);

    expect(await screen.findByText("a rainy drive")).toBeInTheDocument();
    expect(await screen.findByText(/What genre/)).toBeInTheDocument();
  });

  it("sends on Enter and shows the reply", async () => {
    const user = userEvent.setup();
    serve(session(), () => turn({ message: { ...turn().message, content: "Nice one." } }));
    renderWithProviders(<ChatPanel />);

    const box = await screen.findByLabelText("Message the assistant");
    await user.type(box, "a rainy drive{Enter}");

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === "POST");
      expect(post).toBeDefined();
      expect(JSON.parse((post![1] as RequestInit).body as string)).toEqual({
        message: "a rainy drive",
      });
    });
    expect(await screen.findByText("Nice one.")).toBeInTheDocument();
  });

  it("does not send on Shift+Enter — that is a newline", async () => {
    const user = userEvent.setup();
    serve(session());
    renderWithProviders(<ChatPanel />);

    const box = await screen.findByLabelText("Message the assistant");
    await user.type(box, "line one{Shift>}{Enter}{/Shift}line two");

    expect(
      fetchMock.mock.calls.filter(([, init]) => (init as RequestInit)?.method === "POST"),
    ).toHaveLength(0);
    expect(box).toHaveValue("line one\nline two");
  });

  it("disables the composer mid-turn", async () => {
    const user = userEvent.setup();
    let release: (value: Response) => void = () => undefined;
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      (init?.method ?? "GET") === "GET"
        ? Promise.resolve(jsonResponse(200, session()))
        : new Promise<Response>((resolve) => {
            release = resolve;
          }),
    );
    renderWithProviders(<ChatPanel />);

    const box = await screen.findByLabelText("Message the assistant");
    await user.type(box, "a rainy drive{Enter}");

    // A second Enter mid-turn must not queue a second turn behind the first.
    await waitFor(() => expect(box).toBeDisabled());
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();

    release(jsonResponse(200, turn()));
    await waitFor(() => expect(box).toBeEnabled());
  });

  it("shows the failed turn inline, not as a page-wide error", async () => {
    const user = userEvent.setup();
    serve(
      session(),
      () =>
        jsonResponse(
          503,
        {
            type: "https://rithm.dev/errors/assistant-unavailable",
            title: "unavailable",
            status: 503,
            detail: "The assistant could not answer just now.",
          },
          { "Retry-After": "10" },
        ),
    );
    renderWithProviders(<ChatPanel />);

    await user.type(await screen.findByLabelText("Message the assistant"), "hello{Enter}");

    // The wording matters: the message IS saved server-side, and telling the
    // user to retype it would be a lie.
    expect(await screen.findByText(/Your message was saved/)).toBeInTheDocument();
    // The chat is still usable.
    expect(screen.getByLabelText("Message the assistant")).toBeEnabled();
  });

  it("offers Start over rather than a retry when the session is full", async () => {
    const user = userEvent.setup();
    serve(
      session({ messages: [{ id: "m0", role: "user", content: "hi", created_at: "2026-08-25T12:00:00Z" }] }),
      () =>
        jsonResponse(409, {
          type: "https://rithm.dev/errors/chat-session-full",
          title: "full",
          status: 409,
          detail: "This conversation has reached 60 messages.",
        }),
    );
    renderWithProviders(<ChatPanel />);

    await user.type(await screen.findByLabelText("Message the assistant"), "hello{Enter}");

    expect(await screen.findByText(/Start over to keep going/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start over" })).toBeEnabled();
  });

  it("shows the DraftCard only once the server says ready", async () => {
    const user = userEvent.setup();
    serve(session(), () => turn({ draft: READY_DRAFT, ready: true }));
    renderWithProviders(<ChatPanel />);

    expect(screen.queryByRole("button", { name: /Open in Create/ })).not.toBeInTheDocument();

    await user.type(await screen.findByLabelText("Message the assistant"), "instrumental{Enter}");

    expect(await screen.findByRole("button", { name: /Open in Create/ })).toBeInTheDocument();
    expect(screen.getByText("Neon Rooftop")).toBeInTheDocument();
    expect(screen.getByText(/Lo-Fi · Calm · instrumental/)).toBeInTheDocument();
    // 245px of column: two chips and a count, never a list of ten.
    expect(screen.getByText("+1 more")).toBeInTheDocument();
  });

  it("offers a way out before the server calls it ready", async () => {
    serve(
      session({
        messages: [{ id: "m0", role: "user", content: "hi", created_at: "2026-08-25T12:00:00Z" }],
      }),
    );
    renderWithProviders(<ChatPanel />);

    // Nobody is held hostage by the server's `ready` decision.
    expect(await screen.findByRole("button", { name: /Use what we have/ })).toBeInTheDocument();
  });

  it("renders the suggestions the turn came back with", async () => {
    const user = userEvent.setup();
    serve(session(), () => turn({ suggestions: ["Lo-Fi", "EDM", "Cinematic"] }));
    renderWithProviders(<ChatPanel />);

    await user.type(await screen.findByLabelText("Message the assistant"), "a drive{Enter}");

    expect(await screen.findByRole("button", { name: "Lo-Fi" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cinematic" })).toBeInTheDocument();
  });

  it("sends a suggestion as a message when tapped", async () => {
    const user = userEvent.setup();
    serve(session(), () => turn({ suggestions: ["Lo-Fi"] }));
    renderWithProviders(<ChatPanel />);

    await user.type(await screen.findByLabelText("Message the assistant"), "a drive{Enter}");
    await user.click(await screen.findByRole("button", { name: "Lo-Fi" }));

    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter(
        ([, init]) => (init as RequestInit)?.method === "POST",
      );
      const last = posts[posts.length - 1]!;
      expect(JSON.parse((last[1] as RequestInit).body as string)).toEqual({
        message: "Lo-Fi",
      });
    });
  });

  it("switches back to Talk without touching the conversation", async () => {
    const user = userEvent.setup();
    serve(session({ messages: [{ id: "m0", role: "user", content: "hi", created_at: "2026-08-25T12:00:00Z" }] }));
    renderWithProviders(<ChatPanel />);

    // The toggle is the way out. There is no separate close: an X would have
    // done exactly this while naming neither where it went nor what it left.
    await user.click(await screen.findByRole("tab", { name: "Talk" }));

    expect(useAssistant.getState().mode).toBe("talk");
    // Leaving is a UI state change, not a DELETE — the transcript is durable.
    expect(
      fetchMock.mock.calls.filter(([, init]) => (init as RequestInit)?.method === "DELETE"),
    ).toHaveLength(0);
  });

  it("starts over by deleting the session", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        return Promise.resolve(
          jsonResponse(200, session({ messages: [{ id: "m0", role: "user", content: "hi", created_at: "2026-08-25T12:00:00Z" }] })),
        );
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    renderWithProviders(<ChatPanel />);

    await user.click(await screen.findByRole("button", { name: "Start over" }));

    await waitFor(() => expect(screen.queryByText("hi")).not.toBeInTheDocument());
    const del = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === "DELETE");
    expect(del?.[0]).toBe("/api/v1/chat/session");
  });

  it("spends only one lens on the whole panel", async () => {
    serve(session({ draft: READY_DRAFT, ready: true }));
    const { container } = renderWithProviders(<ChatPanel />);

    // index.css names four `.lg-lens` on screen at once as the ceiling, and
    // Home already spends all four. This panel takes AvatarPanel's slot and
    // that is the entire allowance — no lens on the DraftCard, the composer or
    // a bubble.
    await screen.findByRole("button", { name: /Open in Create/ });
    expect(container.querySelectorAll(".lg-lens")).toHaveLength(1);
  });
});
