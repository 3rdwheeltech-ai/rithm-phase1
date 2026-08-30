import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AvatarPanel from "./AvatarPanel";
import { useAssistant } from "../store/assistant";
import { useAuth } from "../store/auth";
import { usePlayer } from "../store/player";
import { jsonResponse, renderWithProviders } from "../test-utils";
import type { ChatSessionResponse, SongDraft, TrackSummary } from "../types/api";

/* lottie-web reaches for a real canvas at IMPORT time and jsdom has none. */
vi.mock("lottie-react", () => ({ default: () => null }));

/**
 * The SDK, faked at the module boundary — TIER 2 of the three test tiers.
 *
 * jsdom has no `RTCPeerConnection`, no `getUserMedia` and no media pipeline,
 * so the package cannot be exercised for real. `vi.mock` is reserved in this
 * repo for genuinely un-mockable modules (`lottie-react`, above, for the same
 * class of reason), and vitest intercepts DYNAMIC imports too — which is what
 * lets the "never loaded until Talk is pressed" assertion below work at all.
 *
 * The turn loop itself needs none of this: it takes its client as a
 * constructor argument and is tested against `FakeAnamClient` with no mocking
 * whatsoever. See `lib/anam/VoiceTurnLoop.test.ts`.
 */
const createClient = vi.fn(() => fakeAnamClient());
vi.mock("@anam-ai/js-sdk", () => ({
  createClient: (...args: unknown[]) => createClient(...(args as [])),
}));

function fakeAnamClient() {
  return {
    addListener: vi.fn(),
    removeListener: vi.fn(),
    streamToVideoElement: vi.fn().mockResolvedValue(undefined),
    createTalkMessageStream: vi.fn(() => ({
      streamMessageChunk: vi.fn(),
      endMessage: vi.fn(),
    })),
    muteInputAudio: vi.fn(),
    unmuteInputAudio: vi.fn(),
    stopStreaming: vi.fn().mockResolvedValue(undefined),
  };
}

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

/**
 * The chat GET answered from `body`, and the voice POST answered by `voice`.
 *
 * TIER 3: `vi.stubGlobal("fetch", …)`, exactly as the existing tests above do
 * for the session GET. Returns the mock so a test can count the POSTs — which
 * is how "does not retry a refused session" is asserted.
 */
function serveVoice(body: ChatSessionResponse, voice: () => Response) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) =>
    Promise.resolve(
      String(url).includes("/chat/voice/session") && init?.method === "POST"
        ? voice()
        : jsonResponse(200, body),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function problem(status: number, type: string, extra: Record<string, unknown> = {}) {
  return jsonResponse(status, { type, title: "no", status, detail: "no", ...extra });
}

const VOICE_ON = session({ voice_available: true });

/** jsdom has no WebRTC at all, so every "voice exists" test opts in. */
function withWebRTC() {
  vi.stubGlobal("RTCPeerConnection", class {});
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn() },
  });
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "HTMLMediaElement",
    globalThis.HTMLMediaElement ?? class {},
  );
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  createClient.mockClear();
  useAuth.setState({ status: "authed" });
  useAssistant.setState({ ...RESET_VOICE, mode: "talk", resumed: false });
  usePlayer.setState({ isPlaying: false, track: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useAssistant.setState({ ...RESET_VOICE, mode: "talk", resumed: false });
});

const RESET_VOICE = {
  voiceStatus: "idle",
  voiceFailure: null,
  voicePhase: "listening",
  voiceRemainingMs: 0,
  voiceCooldownUntil: 0,
  sheetOpen: false,
} as const;

describe("AvatarPanel", () => {
  it("says voice is not built yet when the server reports it is unavailable", async () => {
    // THE EXISTING TEST, RESCOPED RATHER THAN DELETED. With no Anam key the
    // panel must be bit-for-bit what shipped before voice existed — which is
    // the state every environment without a key is in, and the reason
    // `ComingSoonDialog` stays live code with a live test.
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

  it("does not drag the user back into a conversation they closed", async () => {
    // Leaving chat REMOUNTS this panel with the transcript still in the query
    // cache, so the resume above would fire a second time and undo the exit —
    // which made both ways out (the toggle and ChatPanel's X) dead controls.
    // `resumed` is what makes the restore once per page load.
    useAssistant.setState({ mode: "talk", resumed: true });
    serve(
      session({
        session_id: "s1",
        messages: [{ id: "m0", role: "user", content: "hi", created_at: "2026-08-25T12:00:00Z" }],
      }),
    );
    renderWithProviders(<AvatarPanel />);

    await screen.findByRole("button", { name: "Talk" });
    expect(useAssistant.getState().mode).toBe("talk");
  });

  it("stays on Talk when the first turn of THIS session lands", async () => {
    /*
      THE REGRESSION. Reported from a live call: the user pressed Talk, said
      "hip-hop", and was thrown into Chat one sentence in.

      The resume effect used to read `hasTranscript` as live state and bail
      with `if (!hasTranscript || resumed) return`. Starting from an empty
      transcript, that bail left `resumed` FALSE — the effect stayed armed for
      the whole session — and the first turn the user spoke flipped
      `hasTranscript` true and fired the restore mid-call.

      Writing into `qk.chat` is exactly what `useSendChatMessage` does on every
      voice turn, so this is the real sequence and not an approximation of it.
    */
    serve(session());
    const { queryClient } = renderWithProviders(<AvatarPanel />);

    // The EMPTY transcript has to land first — that is the state the bug
    // needed. Waiting on the Talk button is not enough: it renders while the
    // query is still pending, so the effect would not have run yet.
    await waitFor(() =>
      expect(queryClient.getQueryData<ChatSessionResponse>(["chat"])).toBeDefined(),
    );
    expect(useAssistant.getState().mode).toBe("talk");

    queryClient.setQueryData<ChatSessionResponse>(
      ["chat"],
      session({
        session_id: "s1",
        messages: [
          {
            id: "m0",
            role: "user",
            content: "hip-hop",
            created_at: "2026-08-30T12:00:00Z",
          },
        ],
      }),
    );

    // Never — the transcript growing is this page load's own doing.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Talk" })).toBeInTheDocument(),
    );
    expect(useAssistant.getState().mode).toBe("talk");
  });
});

describe("AvatarPanel · voice", () => {
  it("never loads the Anam SDK until Talk is pressed", async () => {
    // GUARDS THE BUNDLE SPLIT. A static import anywhere reachable from this
    // panel walks the SDK into AvatarPanel's chunk, which every desktop Home
    // load pays for — undoing the whole point, which is that someone who never
    // presses Talk never downloads it. `.eslintrc.cjs` enforces the import
    // rule; this asserts the behaviour it exists to protect.
    withWebRTC();
    serveVoice(VOICE_ON, () => jsonResponse(201, {}));
    renderWithProviders(<AvatarPanel />);

    await screen.findByRole("button", { name: "Talk" });
    expect(createClient).not.toHaveBeenCalled();
  });

  it("mints a session token from the API on Talk", async () => {
    const user = userEvent.setup();
    withWebRTC();
    const fetchMock = serveVoice(VOICE_ON, () =>
      jsonResponse(201, {
        session_token: "tok",
        expires_in_seconds: 180,
        lease_id: "lease-1",
      }),
    );
    renderWithProviders(<AvatarPanel />);

    await user.click(await screen.findByRole("button", { name: "Talk" }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url).includes("/chat/voice/session") &&
            (init as RequestInit | undefined)?.method === "POST",
        ),
      ).toBe(true);
    });
    // A Coming Soon dialog would mean the flag was never read.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("pauses the music player before opening the microphone", async () => {
    /*
      THE BUG NOBODY WOULD HAVE FOUND UNTIL DEMO DAY. Anam's STT transcribes
      the song's own lyrics as user speech, the loop POSTs them to
      /chat/messages, and the result is the daily cap burned, the draft
      corrupted with words nobody said, and a transcript full of sentences the
      user never uttered.
    */
    const user = userEvent.setup();
    withWebRTC();
    serveVoice(VOICE_ON, () =>
      jsonResponse(201, { session_token: "t", expires_in_seconds: 180, lease_id: "l" }),
    );
    usePlayer.setState({ isPlaying: true, track: { id: "t1" } as TrackSummary });
    renderWithProviders(<AvatarPanel />);

    await user.click(await screen.findByRole("button", { name: "Talk" }));

    await waitFor(() => expect(usePlayer.getState().isPlaying).toBe(false));
  });

  it("falls back to the Lottie avatar and names the reason when voice is at capacity", async () => {
    // The ORDINARY second-user path on the free tier, not an incident: there
    // is one session for the whole product.
    const user = userEvent.setup();
    withWebRTC();
    serveVoice(VOICE_ON, () =>
      problem(429, "https://rithm.dev/errors/voice-at-capacity", {
        retry_after_seconds: 42,
      }),
    );
    renderWithProviders(<AvatarPanel />);

    await user.click(await screen.findByRole("button", { name: "Talk" }));

    expect(await screen.findByText(/Someone else is talking/)).toBeInTheDocument();
    // The panel, the toggle and the conversation are all exactly where they were.
    expect(screen.getByRole("button", { name: "Talk" })).toBeInTheDocument();
    expect(useAssistant.getState().mode).toBe("talk");
  });

  it("does not retry a refused session", async () => {
    /*
      Against a one-concurrent-session plan an auto-retry is a lockout loop
      that also spends the monthly budget — the client competing with itself
      for the slot it just lost.
    */
    const user = userEvent.setup();
    withWebRTC();
    const fetchMock = serveVoice(VOICE_ON, () =>
      problem(429, "https://rithm.dev/errors/voice-at-capacity", {
        retry_after_seconds: 42,
      }),
    );
    renderWithProviders(<AvatarPanel />);

    const talk = await screen.findByRole("button", { name: "Talk" });
    await user.click(talk);
    await screen.findByText(/Someone else is talking/);

    await user.click(talk);
    await user.click(talk);

    const posts = fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).includes("/chat/voice/session") &&
        (init as RequestInit | undefined)?.method === "POST",
    );
    expect(posts).toHaveLength(1);
    // RE-QUERIED, not the node captured above: the failure re-renders the
    // panel and React replaces the button, so a held reference is detached.
    expect(screen.getByRole("button", { name: "Talk" })).toBeDisabled();
  });

  it("offers chat rather than a retry when the microphone is denied", async () => {
    const user = userEvent.setup();
    withWebRTC();
    serveVoice(VOICE_ON, () =>
      problem(503, "https://rithm.dev/errors/voice-unavailable"),
    );
    renderWithProviders(<AvatarPanel />);

    await user.click(await screen.findByRole("button", { name: "Talk" }));

    await screen.findByText(/Couldn't reach the voice service/);
    // The way to Chat never moved, which is the whole payoff of the fallback.
    expect(screen.getByRole("tab", { name: "Chat" })).toBeInTheDocument();
  });

  it("disables Talk where the browser has no WebRTC, and requests no token", async () => {
    /*
      DISABLED WITH A REASON, not a Coming Soon dialog. Voice genuinely exists
      in this deployment — it is this browser that cannot do it — and saying
      "still in the workshop" would be a lie about the product.

      And never spend the product's one global slot to learn something
      `window` already knows.
    */
    const user = userEvent.setup();
    const fetchMock = serveVoice(VOICE_ON, () => jsonResponse(201, {}));
    renderWithProviders(<AvatarPanel />);

    const talk = await screen.findByRole("button", { name: "Talk" });
    await waitFor(() => expect(talk).toBeDisabled());
    expect(talk).toHaveAttribute("title", "This browser can't do voice");
    await user.click(talk);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("/chat/voice/session")),
    ).toBe(false);
  });

  it("keeps the transcript untouched when a session is refused", async () => {
    // The conversation is on the SERVER. "The avatar broke" costs the user
    // nothing but the avatar.
    const user = userEvent.setup();
    withWebRTC();
    const withTranscript = session({
      voice_available: true,
      session_id: "s1",
      messages: [
        { id: "m0", role: "user", content: "a rainy drive", created_at: "2026-08-25T12:00:00Z" },
      ],
    });
    serveVoice(withTranscript, () =>
      problem(503, "https://rithm.dev/errors/voice-unavailable"),
    );
    useAssistant.setState({ resumed: true });
    const { queryClient } = renderWithProviders(<AvatarPanel />);

    await user.click(await screen.findByRole("button", { name: "Talk" }));
    await screen.findByText(/Couldn't reach the voice service/);

    const cached = queryClient.getQueryData<ChatSessionResponse>(["chat"]);
    expect(cached?.messages).toHaveLength(1);
  });

  it("still spends only one lens with the voice stage open", async () => {
    // index.css names four `.lg-lens` on screen at once as the ceiling, and
    // Home spends all four. The stage lives INSIDE AvatarPanel's.
    const user = userEvent.setup();
    withWebRTC();
    serveVoice(VOICE_ON, () =>
      jsonResponse(201, { session_token: "t", expires_in_seconds: 180, lease_id: "l" }),
    );
    const { container } = renderWithProviders(<AvatarPanel />);

    await user.click(await screen.findByRole("button", { name: "Talk" }));
    await screen.findByRole("log", { name: "Voice transcript" });

    expect(container.querySelectorAll(".lg-lens")).toHaveLength(1);
  });

  it("shows Tap to start when the browser refuses to autoplay the video", async () => {
    /*
      Layer 3 of three, and the only one that is guaranteed. iOS user
      activation is transient and is consumed by an await — and the token mint
      and the dynamic import are both awaits. Every production WebRTC app
      ships this; treating it as an edge case is how you ship a permanent
      spinner on iPhone.
    */
    const user = userEvent.setup();
    withWebRTC();
    vi.spyOn(HTMLMediaElement.prototype, "play").mockRejectedValue(
      new DOMException("", "NotAllowedError"),
    );
    serveVoice(VOICE_ON, () =>
      jsonResponse(201, { session_token: "t", expires_in_seconds: 180, lease_id: "l" }),
    );
    renderWithProviders(<AvatarPanel />);

    await user.click(await screen.findByRole("button", { name: "Talk" }));

    expect(await screen.findByRole("button", { name: "Tap to start" })).toBeInTheDocument();
  });

  it("gives the voice stage a captioned transcript and a real End button", async () => {
    // pa11y-ci and an axe pass are both in this repo, and a talking video with
    // no captions would be caught — and would deserve to be.
    const user = userEvent.setup();
    withWebRTC();
    serveVoice(VOICE_ON, () =>
      jsonResponse(201, { session_token: "t", expires_in_seconds: 180, lease_id: "l" }),
    );
    renderWithProviders(<AvatarPanel />);

    await user.click(await screen.findByRole("button", { name: "Talk" }));

    expect(await screen.findByRole("log", { name: "Voice transcript" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "End" })).toBeInTheDocument();
  });
});