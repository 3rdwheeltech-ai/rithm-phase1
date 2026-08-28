import { create } from "zustand";

/**
 * Which door the AI Assistant panel is showing.
 *
 * "talk" is the avatar with its Talk button; "chat" replaces the whole panel
 * with the conversation. They are two modes of one assistant rather than a
 * panel and an overlay, which is why the segmented control that switches them
 * sits in the same place in both — see `assistant/DoorToggle.tsx`.
 */
export type AssistantMode = "talk" | "chat";

/**
 * Where the voice CONNECTION is. Not where the turn is — see `VoicePhase`.
 *
 * Two enums rather than one, deliberately. Crossing them gives a 21-member
 * state with about twelve unreachable members. `status` belongs to the
 * connection, `phase` belongs to the turn loop; they change on different
 * events and are read by different components.
 */
export type VoiceStatus =
  | "idle" // nothing started; Talk is the offer
  | "checking" // feature-detecting and minting
  | "connecting" // token in hand, stream starting
  | "needs-gesture" // connected, but the browser refused to play
  | "live"
  | "ending"
  | "unavailable"; // see voiceFailure for which kind

/** Only meaningful while `voiceStatus === "live"`. */
export type VoicePhase = "listening" | "thinking" | "speaking";

/**
 * Every way this can end, named — because the panel says something different
 * for each, and "something went wrong" is what makes a fallback feel like a
 * fault.
 *
 * `not-configured` is the one that is not a failure at all: voice was never
 * here, and the panel is bit-for-bit what ships today.
 */
export type VoiceFailure =
  // The server refused
  | "not-configured"
  | "at-capacity"
  | "quota-exceeded"
  // We cannot even try
  | "sdk-load-failed"
  | "no-webrtc"
  | "offline"
  // Permission
  | "mic-denied"
  | "mic-timeout"
  // Transport
  | "connect-failed"
  | "video-never-played"
  | "dropped"
  // We ended it
  | "time-limit"
  | "hidden-too-long"
  // The brain refused
  | "chat-unavailable"
  | "chat-full"
  | "chat-rate-limited";

interface AssistantState {
  mode: AssistantMode;
  setMode: (mode: AssistantMode) => void;
  /** Whether this page load has already restored a live conversation. */
  resumed: boolean;
  markResumed: () => void;

  // ── Voice ────────────────────────────────────────────────────────────────
  voiceStatus: VoiceStatus;
  voiceFailure: VoiceFailure | null;
  voicePhase: VoicePhase;
  /**
   * Wall-clock ms the session may still run — drives the countdown and the
   * sixty-seconds-left warning. Zero when nothing is live.
   */
  voiceRemainingMs: number;
  /**
   * Talk stays disabled until this passes. A refused session must NEVER
   * auto-retry: against a one-concurrent-session plan that is a lockout loop
   * which also spends the monthly budget — the client would be competing with
   * itself for the slot it just lost.
   */
  voiceCooldownUntil: number;
  /**
   * The mobile sheet. Unpersisted for the same reason `mode` is: a sheet that
   * reopens itself after a reload is a bug, not a feature.
   */
  sheetOpen: boolean;

  setVoiceStatus: (status: VoiceStatus) => void;
  setVoicePhase: (phase: VoicePhase) => void;
  setVoiceRemainingMs: (ms: number) => void;
  /** End a session with a reason, and cool Talk down for `cooldownMs`. */
  failVoice: (failure: VoiceFailure, cooldownMs?: number) => void;
  /** Back to the offer. Clears the failure line; does NOT clear the cooldown. */
  resetVoice: () => void;
  setSheetOpen: (open: boolean) => void;
}

/**
 * The default cooldown after a refusal, in ms.
 *
 * Long enough that a frustrated double-press is not a second mint, short
 * enough not to feel punitive. The at-capacity path overrides it with the
 * server's own `retry_after_seconds`, which is a real number computed from a
 * live lease rather than a guess.
 */
export const VOICE_COOLDOWN_MS = 30_000;

/**
 * No `persist`, matching every other store here — and note the consequence:
 * this survives SPA navigation and NOT a reload.
 *
 * That is deliberate rather than an oversight. The conversation is the durable
 * thing and it lives on the server; the panel's open/closed state is not. A
 * refresh therefore drops the user back to the avatar while a live session
 * sits in the database — which `AvatarPanel`'s mount resolves by switching to
 * chat when the server returns a non-empty transcript. Persisting this instead
 * would mean a stale flag deciding what the panel shows, which is the same
 * information in two places.
 *
 * VOICE LIVES HERE TOO, and not in a store of its own. `mode` and voice
 * status are one decision surface: Layout, the mobile card and the
 * route-change teardown all have to ask "is a call live?" before deciding
 * anything, and two stores that must agree is the same information in two
 * places — which is the argument this docstring already makes about `mode`.
 * Voice is a third state OF THE TALK DOOR, not a fourth door.
 *
 * It is not local component state either: the session must survive the avatar
 * ⇄ stage swap and, on mobile, live in a sheet portalled outside the panel
 * tree entirely.
 *
 * THE ANAM CLIENT INSTANCE IS NOT IN HERE. It is a non-serialisable,
 * side-effectful object; a store slot invites a component to re-render on it
 * and invites `getState().client` reaches from anywhere. It lives as a
 * module-level singleton in `lib/anam/session.ts` — the precedent is
 * `refreshInFlight` in `lib/api.ts`.
 *
 * `resumed` is what makes that restore happen ONCE PER PAGE LOAD rather than
 * once per mount, and it is load-bearing rather than an optimisation. The two
 * panels swap places in Layout, so leaving chat REMOUNTS `AvatarPanel` — and
 * an ungated restore would read the same non-empty transcript and throw the
 * user straight back into the conversation they just closed. It shares `mode`'s
 * lifetime for the same reason `mode` has it: "has this page load restored
 * yet?" is a question a reload should be allowed to ask again.
 */
export const useAssistant = create<AssistantState>((set) => ({
  mode: "talk",
  setMode: (mode) => set({ mode }),
  resumed: false,
  markResumed: () => set({ resumed: true }),

  voiceStatus: "idle",
  voiceFailure: null,
  voicePhase: "listening",
  voiceRemainingMs: 0,
  voiceCooldownUntil: 0,
  sheetOpen: false,

  setVoiceStatus: (voiceStatus) => set({ voiceStatus }),
  setVoicePhase: (voicePhase) => set({ voicePhase }),
  setVoiceRemainingMs: (voiceRemainingMs) => set({ voiceRemainingMs }),

  failVoice: (voiceFailure, cooldownMs = VOICE_COOLDOWN_MS) =>
    set({
      voiceStatus: "unavailable",
      voiceFailure,
      voicePhase: "listening",
      voiceRemainingMs: 0,
      voiceCooldownUntil: Date.now() + cooldownMs,
    }),

  resetVoice: () =>
    set({
      voiceStatus: "idle",
      voiceFailure: null,
      voicePhase: "listening",
      voiceRemainingMs: 0,
    }),

  setSheetOpen: (sheetOpen) => set({ sheetOpen }),
}));
