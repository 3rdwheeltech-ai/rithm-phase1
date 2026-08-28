/**
 * Local STRUCTURAL types for the slice of Anam's SDK this app uses.
 *
 * THIS IS WHY NOTHING ABOVE `session.ts` IMPORTS THE SDK. These are erased at
 * compile, so `VoiceTurnLoop`, `VoiceStage` and every test can be fully typed
 * against the client without a single byte of `@anam-ai/js-sdk` reaching
 * `AvatarPanel`'s chunk — which mounts on every desktop Home load.
 *
 * They also make the jsdom fake (`fakeClient.ts`) trivially type-safe: a fake
 * that satisfies `AnamClientLike` is one the loop cannot tell from the real
 * thing, which is what lets the loop's tests run with no `vi.mock` and no
 * WebRTC.
 *
 * Verified against `@anam-ai/js-sdk@4.26.0`'s own `.d.ts`, not against Anam's
 * documentation pages — the two disagree, and where they did the package won.
 * Two corrections worth recording:
 *
 * 1. `MessageRole` is `'user' | 'persona'`. The custom-LLM example in the docs
 *    shows `'assistant'`, and it is wrong. Sending the persona's rows back as
 *    user turns is an infinite loop that bills every hop, so this one matters.
 * 2. `ConnectionClosedCode` members are STRINGS, not numbers, and there is no
 *    "at capacity" member among them. Capacity is a mint-time 429, which the
 *    server has already turned into a typed problem before the SDK is loaded.
 */

/** `AnamEvent`'s members, as the string literals the enum actually carries. */
export const ANAM_EVENT = {
  MESSAGE_HISTORY_UPDATED: "MESSAGE_HISTORY_UPDATED",
  CONNECTION_CLOSED: "CONNECTION_CLOSED",
  VIDEO_PLAY_STARTED: "VIDEO_PLAY_STARTED",
  TALK_STREAM_INTERRUPTED: "TALK_STREAM_INTERRUPTED",
  SESSION_READY: "SESSION_READY",
  MIC_PERMISSION_PENDING: "MIC_PERMISSION_PENDING",
  MIC_PERMISSION_GRANTED: "MIC_PERMISSION_GRANTED",
  MIC_PERMISSION_DENIED: "MIC_PERMISSION_DENIED",
  USER_SPEECH_ENDED: "USER_SPEECH_ENDED",
} as const;

export type AnamEventName = (typeof ANAM_EVENT)[keyof typeof ANAM_EVENT];

/**
 * One row of Anam's own message history.
 *
 * `role: "persona"` rows are what WE just spoke, echoed back. The loop drops
 * them — see the guards in `VoiceTurnLoop`.
 */
export interface AnamMessage {
  id: string;
  content: string;
  role: "user" | "persona";
  interrupted?: boolean;
}

/**
 * A handle on one thing the persona is saying.
 *
 * `createTalkMessageStream()` rather than `talk()` because `talk()` gives you
 * NO handle: you cannot end it on an interruption, you cannot end it when the
 * three-minute cap lands mid-sentence, and you cannot end it on teardown.
 * Every one of those three is a certainty over a session, not an edge case.
 */
export interface TalkStreamLike {
  streamMessageChunk(text: string, endOfSpeech: boolean): void;
  endMessage(): void;
}

/** The slice of `AnamClient` this app touches. */
export interface AnamClientLike {
  addListener(event: AnamEventName, callback: (...args: never[]) => void): void;
  removeListener(event: AnamEventName, callback: (...args: never[]) => void): void;
  streamToVideoElement(videoElementId: string): Promise<void>;
  createTalkMessageStream(): TalkStreamLike;
  muteInputAudio(): unknown;
  unmuteInputAudio(): unknown;
  stopStreaming(): Promise<void>;
}

/**
 * The ONE video element id in the document, ever.
 *
 * `streamToVideoElement()` takes an element ID rather than a ref — confirmed
 * in the package's `.d.ts` — so two stages in the DOM means the SDK picks one
 * of them by document order and the other stays black. The case this actually
 * protects is a tablet at the `lg` boundary, where the mobile sheet and the
 * desktop panel could both be mounted.
 */
export const ANAM_VIDEO_ELEMENT_ID = "rithm-voice-stage";
