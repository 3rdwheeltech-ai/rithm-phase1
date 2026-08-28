import type { VoiceFailure } from "../../store/assistant";

/**
 * What the panel SAYS when voice does not happen, one line per reason.
 *
 * One table rather than a switch in each surface, because the desktop panel
 * and the mobile sheet must say the same thing about the same failure — and
 * because "something went wrong" is what makes a graceful fallback feel like a
 * fault. Every line names the cause and, where there is one, the way forward.
 *
 * `not-configured` is absent DELIBERATELY: voice was never here, so there is
 * nothing to explain. That case renders today's panel unchanged, with Talk
 * opening the Coming Soon dialog — see `AvatarPanel`.
 */
export const VOICE_FAILURE_COPY: Record<Exclude<VoiceFailure, "not-configured">, string> =
  {
    // The one that is ordinary rather than exceptional: on the free tier there
    // is one session for the whole product, so this is simply someone else.
    "at-capacity":
      "Someone else is talking to the assistant right now. Try again in a minute — or chat.",
    "quota-exceeded": "That's your voice time for today. Chat is still open.",

    "sdk-load-failed": "Couldn't load the voice assistant. Chat still works.",
    "no-webrtc": "This browser can't do voice. Chat still works.",
    offline: "You're offline. Voice needs a connection.",

    "mic-denied": "RITHM needs your microphone to talk. You can still chat.",
    "mic-timeout": "Never heard back about microphone permission.",

    "connect-failed": "Couldn't reach the voice service — your network may be blocking it.",
    "video-never-played": "The avatar wouldn't start playing here.",
    dropped: "The voice connection dropped. Everything you said is saved.",

    // Not a failure so much as an ending, and it says so.
    "time-limit": "That's all the time voice has for now — everything's saved.",
    "hidden-too-long": "Voice stopped while the tab was in the background.",

    "chat-unavailable": "The assistant couldn't answer that one.",
    "chat-full": "This conversation is full. Start a new one in chat.",
    "chat-rate-limited": "That's all for today. Everything we talked about is saved.",
  };

/** The line for a failure, or null where none should be shown. */
export function voiceFailureCopy(failure: VoiceFailure | null): string | null {
  if (failure === null || failure === "not-configured") return null;
  return VOICE_FAILURE_COPY[failure];
}
