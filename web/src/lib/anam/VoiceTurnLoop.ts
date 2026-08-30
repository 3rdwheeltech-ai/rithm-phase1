import {
  ANAM_EVENT,
  type AnamClientLike,
  type AnamEventName,
  type AnamMessage,
  type TalkStreamLike,
} from "./types";
import { sanitizeForSpeech, splitSentences } from "./speech";
import type { VoicePhase } from "../../store/assistant";

/**
 * The turn loop: hear a person, ask RITHM's interviewer, speak the answer.
 *
 * A PLAIN CLASS, NOT A HOOK, and that is not a style preference.
 *
 * Anam's handlers must be registered BEFORE `streamToVideoElement()` runs,
 * because startup events fire during it and a late listener misses what has
 * already fired. A handler registered once at session start and closing over
 * `useState` values therefore reads the INITIAL value for the rest of the
 * call — so every `phase` check inside a React-closured handler is a
 * stale-closure bug waiting to happen, and it appears three turns in rather
 * than at mount.
 *
 * Taking the client as a constructor argument also makes the whole loop
 * testable in jsdom against a hand-rolled fake, with no `vi.mock` and no
 * WebRTC — matching the API's "fakes patched into the module's own namespace,
 * so the code under test stays on its real path" idiom. React subscribes to a
 * status snapshot; it never drives the loop.
 */

/**
 * Under human turn-taking and two orders of magnitude under the ~3 s turn, so
 * it is effectively free. Its job: two utterances Anam split into two messages
 * arrive as ONE turn joined with a space, because the interviewer should read
 * them as one thought — which is what they were.
 */
const DEBOUNCE_MS = 300;

/**
 * How long to wait for an answer to the microphone prompt before giving up.
 *
 * A prompt the user walked away from is indistinguishable from one they never
 * saw, and either way the session is holding the product's one global slot
 * while nothing happens. Generous — it is a human deciding, not a machine
 * timing out — but finite.
 */
const MIC_PROMPT_TIMEOUT_MS = 20_000;

/** Why the loop wants the session over. Shaped to match `VoiceFailure`. */
export type VoiceEndReason =
  | "chat-full"
  | "chat-rate-limited"
  | "dropped"
  | "mic-denied"
  | "mic-timeout";

/**
 * What one turn resolves to, from the caller's side of `/chat/messages`.
 *
 * A failed turn is a `spoken-error` rather than a rejection, because in voice
 * an error has to be SAID — a muted inline row is the chat door's answer and
 * there is nothing to read here. `end` carries the reason rather than the
 * caller sniffing the copy: a 503 keeps the session open (the message is
 * already committed server-side, so "say it again" works), while a 409 or a
 * 429 must close it rather than hold the one global slot open for a server
 * that will refuse the next turn too.
 */
export type VoiceTurnOutcome =
  | { kind: "reply"; text: string; suggestions: string[] }
  | { kind: "spoken-error"; text: string; end: VoiceEndReason | null };

export interface VoiceTurnLoopOptions {
  client: AnamClientLike;
  /**
   * Runs one turn against `/chat/messages`. STABLE across renders — the loop
   * registers it once at session start, and a callback whose identity changed
   * per render would leave the loop holding a `mutateAsync` from three turns
   * ago.
   */
  runTurn: (text: string) => Promise<VoiceTurnOutcome>;
  onPhase: (phase: VoicePhase) => void;
  /** A user utterance, the moment STT finalises it — the ~3 s cover (layer 1). */
  onUserTranscript: (text: string) => void;
  /** The assistant's reply, once the server has it. */
  onAssistantReply: (text: string, suggestions: string[]) => void;
  /** The video actually started playing. The session clock starts HERE. */
  onVideoPlaying: () => void;
  /** The loop wants the session over. */
  onEnd: (reason: VoiceEndReason) => void;
}

export class VoiceTurnLoop {
  private readonly options: VoiceTurnLoopOptions;
  private readonly client: AnamClientLike;

  /**
   * User message ids already sent. `MESSAGE_HISTORY_UPDATED` carries the WHOLE
   * history and fires more than once per utterance (an interim transcript,
   * then a revised final), so without this, turn six resends turns one to five.
   */
  private readonly dispatched = new Set<string>();

  /**
   * id → latest text, waiting on the debounce.
   *
   * A Map keyed by message id, not an array: a growing partial transcript
   * REPLACES its earlier self rather than queueing as two turns.
   */
  private buffer = new Map<string, string>();
  private debounce: ReturnType<typeof setTimeout> | null = null;

  /**
   * Turns are SERIALISED, never dropped. Two concurrent POSTs to
   * `/chat/messages` would be actively harmful rather than merely wasteful:
   * both append a user row, both run the Bedrock chain (double spend, double
   * latency), both `save_draft` last-writer-wins, and `useSendChatMessage`
   * folds them into the cache in COMPLETION order, which need not be send
   * order — an out-of-order transcript the user can then read in Chat.
   */
  private inFlight: Promise<void> = Promise.resolve();

  private activeStream: TalkStreamLike | null = null;
  private disposed = false;
  /** Set while ending or hidden: a stray turn must not be posted. */
  private muted = false;
  /**
   * Where the turn is, mirrored here rather than read back out of React.
   *
   * The loop outlives the render that created it, so a `useState` value read
   * inside a handler registered at session start is the value it had at
   * session start. This field is the loop's own answer to "what is happening
   * right now", and `hasUnspokenReply` is the one question that depends on it.
   */
  private phase: VoicePhase = "listening";
  /** The last assistant message we RECEIVED. Read on a drop. */
  private lastReplyText: string | null = null;
  /** True when the connection died with a reply still coming out of the speaker. */
  private cutMidReply = false;

  private micTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly listeners: [AnamEventName, (...args: never[]) => void][] = [];

  constructor(options: VoiceTurnLoopOptions) {
    this.options = options;
    this.client = options.client;
  }

  /**
   * Register every handler. MUST be called before `streamToVideoElement()`:
   * startup events fire during that call and a late listener misses them.
   */
  attach(): void {
    this.on(ANAM_EVENT.MESSAGE_HISTORY_UPDATED, (messages: AnamMessage[]) =>
      this.onHistory(messages),
    );
    this.on(ANAM_EVENT.USER_SPEECH_ENDED, () => this.setPhase("thinking"));
    this.on(ANAM_EVENT.TALK_STREAM_INTERRUPTED, () => this.onTalkInterrupted());
    this.on(ANAM_EVENT.VIDEO_PLAY_STARTED, () => this.options.onVideoPlaying());
    this.on(ANAM_EVENT.MIC_PERMISSION_DENIED, () => {
      this.clearMicTimer();
      this.options.onEnd("mic-denied");
    });
    // "Still waiting for microphone permission…", then give up. A prompt
    // nobody answered holds the one global slot exactly as firmly as a live
    // call does.
    this.on(ANAM_EVENT.MIC_PERMISSION_PENDING, () => {
      this.clearMicTimer();
      this.micTimer = setTimeout(() => {
        this.micTimer = null;
        if (!this.disposed) this.options.onEnd("mic-timeout");
      }, MIC_PROMPT_TIMEOUT_MS);
    });
    this.on(ANAM_EVENT.MIC_PERMISSION_GRANTED, () => this.clearMicTimer());
    this.on(ANAM_EVENT.CONNECTION_CLOSED, () => {
      if (this.disposed || this.muted) return;
      // Read BEFORE anything resets it: this is the whole input to
      // `hasUnspokenReply`, and the caller asks straight after `onEnd`.
      this.cutMidReply = this.phase === "speaking";
      this.options.onEnd("dropped");
    });
  }

  /**
   * Speak a line the loop did not produce — the greeting, or the last thing the
   * assistant said before the user arrived from Chat.
   */
  greet(text: string): void {
    this.speak(text);
  }

  /**
   * Whether a reply was cut off in the middle of being said.
   *
   * The caller uses it on a drop to `setMode("chat")`, so the user can READ an
   * answer they already paid a Bedrock turn for rather than losing the half
   * they did not hear.
   *
   * DELIBERATELY NOT TRUE FOR A BARGE-IN. Interrupting is the user choosing to
   * stop listening; the transcript is already complete and shoving them into
   * Chat for it would punish the feature's best affordance. This is only for
   * the connection dying underneath a reply.
   */
  hasUnspokenReply(): boolean {
    return this.cutMidReply && this.lastReplyText !== null;
  }

  /** Stop posting turns. Used while ending, and while the tab is hidden. */
  setMuted(muted: boolean): void {
    this.muted = muted;
    // Muting the MICROPHONE is right for exactly these two cases and for
    // nothing else — never during a reply. See `onTalkInterrupted`.
    if (muted) this.client.muteInputAudio();
    else this.client.unmuteInputAudio();
  }

  /** Idempotent. Runs on unmount, door switch, route change, Escape and cap. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.debounce = null;
    this.clearMicTimer();
    this.buffer.clear();
    this.dispatched.clear();
    this.endActiveStream();
    for (const [event, handler] of this.listeners) {
      this.client.removeListener(event, handler);
    }
    this.listeners.length = 0;
  }

  // ── Hearing ──────────────────────────────────────────────────────────────

  private onHistory(messages: AnamMessage[]): void {
    if (this.disposed || this.muted) return;

    for (const message of messages) {
      // GUARD 1: the persona's rows are what WE just spoke, echoed back.
      // Sending those is an infinite loop that bills every hop.
      if (message.role !== "user") continue;
      // GUARD 2: the event carries the full history every time.
      if (this.dispatched.has(message.id)) continue;
      // GUARD 3: STT emits empties on a cough, and `ChatTurnRequest` has
      // min_length=1 with str_strip_whitespace=True — so an empty turn is a 422.
      const text = message.content.trim();
      if (text === "") continue;
      this.buffer.set(message.id, text);
    }

    if (this.buffer.size === 0) return;
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.flush(), DEBOUNCE_MS);
  }

  private flush(): void {
    this.debounce = null;
    if (this.disposed || this.muted || this.buffer.size === 0) return;

    const text = [...this.buffer.values()].join(" ").trim();
    for (const id of this.buffer.keys()) this.dispatched.add(id);
    this.buffer.clear();
    if (text === "") return;

    // Shown at 0 ms, and this is the real cover for the ~3 s think. It answers
    // the anxiety the user actually has during the gap, which is not "is it
    // fast?" but "did it hear me, and did it hear me right?"
    this.options.onUserTranscript(text);
    this.setPhase("thinking");

    // Serialised, not dropped. The 3 s gap is EXACTLY when people speak again —
    // a correction, a "sorry, I meant jazz" — and swallowing that is worse than
    // answering it a turn late.
    this.inFlight = this.inFlight.then(() => this.runTurn(text));
  }

  private async runTurn(text: string): Promise<void> {
    if (this.disposed) return;
    let outcome: VoiceTurnOutcome;
    try {
      outcome = await this.options.runTurn(text);
    } catch {
      // `runTurn` is expected to map every problem type to an outcome. A throw
      // that reaches here is a bug in the caller, not a turn — and it must not
      // take the session down with it.
      this.setPhase("listening");
      return;
    }
    if (this.disposed) return;

    if (outcome.kind === "spoken-error") {
      this.speak(outcome.text);
      // A 409 or a 429 ends the session; a 503 does not, because the user's
      // message is already committed and saying it again genuinely works.
      if (outcome.end !== null) this.options.onEnd(outcome.end);
      return;
    }

    this.lastReplyText = outcome.text;
    this.options.onAssistantReply(outcome.text, outcome.suggestions);
    this.speak(outcome.text);
  }

  // ── Speaking ─────────────────────────────────────────────────────────────

  private speak(reply: string): void {
    if (this.disposed) return;
    const sentences = splitSentences(sanitizeForSpeech(reply));
    if (sentences.length === 0) {
      this.setPhase("listening");
      return;
    }

    this.endActiveStream();
    const stream = this.client.createTalkMessageStream();
    this.activeStream = stream;
    this.setPhase("speaking");

    try {
      // ONE SYNCHRONOUS PASS. No await between chunks. The SDK times a talk
      // stream out after 15 s without a chunk, and pushing everything in the
      // same task means that clock never starts counting — which is what makes
      // `createTalkMessageStream` safe here despite holding the whole string.
      // Do NOT pace this for effect: pacing buys nothing we do not already
      // have, and introduces the one gap that can kill the stream.
      //
      // THE TRAILING SPACE IS LOAD-BEARING. Do not "tidy" it away.
      //
      // `streamMessageChunk` is a TOKEN-STREAM api: it exists to be fed an
      // LLM's output as it arrives, and an LLM's tokens carry their own leading
      // whitespace, so the SDK concatenates what it is given verbatim.
      // `splitSentences` splits ON the whitespace between sentences, which
      // means it consumes it — so without this, the engine received
      // "…about rainfall.You mentioned…" with no space after the full stop.
      //
      // A period between two word characters with no space is the shape of a
      // domain or a filename, and a TTS engine normalises that by SAYING the
      // period: "rainfall dot You". Every sentence boundary in every reply,
      // read out loud. It was reported twice before anyone found it here,
      // because it looks like a speech-engine problem and is entirely ours.
      sentences.forEach((sentence, i) => {
        const last = i === sentences.length - 1;
        stream.streamMessageChunk(last ? sentence : `${sentence} `, last);
      });
    } finally {
      // Ended HERE and nulled in the same breath, so `endMessage` is called
      // exactly once per utterance. An interruption arriving afterwards finds
      // no active stream and correctly does nothing to it — the audio is what
      // the engine cuts, and the text sequence was already terminated.
      stream.endMessage();
      this.activeStream = null;
    }
  }

  /**
   * Barge-in. The microphone is NOT muted during a reply, deliberately.
   *
   * Anam ships `TALK_STREAM_INTERRUPTED` as a first-class event, which means
   * interruption is a path they built rather than an accident — and barge-in
   * is the single most valuable affordance in a voice interface, because it is
   * what makes a wrong three-second answer survivable. Muting defeats it.
   *
   * The echo risk muting would have covered is real, and it is removed at the
   * source instead: starting a session pauses the music player.
   */
  private onTalkInterrupted(): void {
    this.endActiveStream();
    this.setPhase("listening");
    // DELIBERATELY NOT RE-SPOKEN. The assistant's turn was written into the
    // query cache BEFORE we started speaking it, so the transcript is already
    // complete — only the audio was cut, which is exactly what interrupting
    // asked for.
  }

  private endActiveStream(): void {
    if (this.activeStream === null) return;
    // End the orphaned stream so the SDK's 15 s idle timer cannot fire against
    // it after we have moved on.
    this.activeStream.endMessage();
    this.activeStream = null;
  }

  /**
   * Register one handler, and remember it so `dispose` can take it back off.
   *
   * The double assertion is the price of `AnamClientLike` describing the SDK
   * structurally rather than importing its `EventCallbacks` map — which is the
   * whole reason nothing above `session.ts` pulls the package in. The payload
   * types are pinned by the call sites in `attach()`, which is where a wrong
   * one would actually be caught.
   */
  private clearMicTimer(): void {
    if (this.micTimer === null) return;
    clearTimeout(this.micTimer);
    this.micTimer = null;
  }

  /** The one writer of `phase`, so the mirror and React cannot disagree. */
  private setPhase(phase: VoicePhase): void {
    this.phase = phase;
    this.options.onPhase(phase);
  }

  private on<T extends unknown[]>(
    event: AnamEventName,
    handler: (...args: T) => void,
  ): void {
    const erased = handler as unknown as (...args: never[]) => void;
    this.listeners.push([event, erased]);
    this.client.addListener(event, erased);
  }
}
