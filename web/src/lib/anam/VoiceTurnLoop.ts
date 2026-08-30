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

/** One line of the conversation, as POST /chat/turns/record wants it. */
export interface RecordedTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * What recording a batch resolves to.
 *
 * A failed record is a `spoken-error` rather than a rejection for the reason
 * the old reply path had: in voice an error has to be SAID, because there is
 * nothing to read. `end` carries the reason rather than the caller sniffing
 * copy — a 409 or a 429 must close the session rather than hold the product's
 * one global slot open for a server that will refuse the next batch too.
 *
 * NOTE the failure is quieter than it used to be. Recording does not produce
 * the reply any more, so a refusal costs the DRAFT rather than the answer: the
 * user keeps talking to Anam and hears nothing wrong, while nothing is being
 * captured. That is why `voice_turn_recorded` is the line to alarm on.
 */
export type VoiceRecordOutcome =
  | { kind: "recorded" }
  | { kind: "spoken-error"; text: string; end: VoiceEndReason | null };

export interface VoiceTurnLoopOptions {
  client: AnamClientLike;
  /**
   * Records a batch of turns against `/chat/turns/record`. STABLE across
   * renders — the loop registers it once at session start, and a callback
   * whose identity changed per render would leave the loop holding a
   * `mutateAsync` from three turns ago.
   */
  recordTurns: (turns: RecordedTurn[]) => Promise<VoiceRecordOutcome>;
  onPhase: (phase: VoicePhase) => void;
  /** A user utterance, the moment STT finalises it. */
  onUserTranscript: (text: string) => void;
  /** A line the persona said, as Anam reports it. */
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
   * id → turn, waiting on the debounce.
   *
   * A Map keyed by message id, not an array, for two reasons: a growing
   * partial transcript REPLACES its earlier self rather than queueing as two
   * turns, and insertion order is preserved — which matters far more now that
   * both roles ride this buffer. A batch whose order was scrambled would write
   * an answer above the question it answered.
   */
  private buffer = new Map<string, RecordedTurn>();
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

  /**
   * BOTH ROLES ARE RECORDED NOW, and that is the change the brain switch made.
   *
   * The persona's rows used to be dropped as an echo of what we had just told
   * Anam to say — resending those was an infinite loop that billed every hop.
   * That loop cannot exist any more: this class no longer produces replies, so
   * a persona row is not an echo of ours, it is Anam's model ANSWERING, and it
   * is the only copy of that answer anywhere. Drop it and Chat shows a
   * transcript with holes in it.
   */
  private onHistory(messages: AnamMessage[]): void {
    if (this.disposed || this.muted) return;

    for (const message of messages) {
      // GUARD 1: the event carries the full history every time, and fires more
      // than once per utterance (an interim transcript, then a revised final).
      // Without this, turn six resends turns one to five.
      if (this.dispatched.has(message.id)) continue;
      // GUARD 2: STT emits empties on a cough, and `RecordedTurn` has
      // min_length=1 with str_strip_whitespace=True — an empty turn is a 422.
      const text = message.content.trim();
      if (text === "") continue;

      // Anam's own word for its side is "persona"; the API's is "assistant".
      // Translated here, at the vendor boundary, rather than anywhere further
      // in — `MessageRole` in the docs claims "assistant" and is wrong.
      const role = message.role === "user" ? "user" : "assistant";
      this.buffer.set(message.id, { role, content: text });

      if (role === "user") {
        this.options.onUserTranscript(text);
      } else {
        this.lastReplyText = text;
        this.options.onAssistantReply(text, []);
        /*
          "speaking", not "listening", and the difference is load-bearing.

          Anam adds a persona row when it has produced the line, i.e. as it
          starts saying it — so this is the truest moment we can observe. We
          never see it FINISH (no such event is in the SDK slice), so the phase
          stays here until the user speaks again and USER_SPEECH_ENDED moves it
          to "thinking".

          That imprecision costs nothing visually — `auraClass` only
          distinguishes "thinking" from everything else — and it is what keeps
          `hasUnspokenReply` meaningful now that we are not the ones talking:
          a drop in this phase means the connection died on a reply the user
          may only have half heard, which is why they get sent to Chat to read
          the rest of it.
        */
        this.setPhase("speaking");
      }
    }

    if (this.buffer.size === 0) return;
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.flush(), DEBOUNCE_MS);
  }

  private flush(): void {
    this.debounce = null;
    if (this.disposed || this.muted || this.buffer.size === 0) return;

    const batch = collapseRuns([...this.buffer.values()]);
    for (const id of this.buffer.keys()) this.dispatched.add(id);
    this.buffer.clear();
    if (batch.length === 0) return;

    // Serialised, not dropped, for the reason the reply path was: two
    // concurrent POSTs both append rows and both `save_draft` last-writer-wins,
    // and they complete in an order that need not be send order — an
    // out-of-order transcript the user can then read in Chat.
    this.inFlight = this.inFlight.then(() => this.record(batch));
  }

  private async record(batch: RecordedTurn[]): Promise<void> {
    if (this.disposed) return;
    let outcome: VoiceRecordOutcome;
    try {
      outcome = await this.options.recordTurns(batch);
    } catch {
      // `recordTurns` is expected to map every problem type to an outcome. A
      // throw reaching here is a bug in the caller, not a turn — and it must
      // not take the session down with it.
      return;
    }
    if (this.disposed || outcome.kind === "recorded") return;

    // Still SPOKEN. `createTalkMessageStream` works regardless of which brain
    // is answering, so the one thing we still say out loud is the thing the
    // user could not otherwise discover: that their conversation stopped being
    // recorded.
    this.speak(outcome.text);
    if (outcome.end !== null) this.options.onEnd(outcome.end);
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
      sentences.forEach((sentence, i) =>
        stream.streamMessageChunk(sentence, i === sentences.length - 1),
      );
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

/**
 * Merge consecutive same-role turns into one.
 *
 * Anam's STT can finalise one sentence as two messages 200 ms apart, and the
 * extractor reads a user turn as the answer to the question before it — so
 * "hip" and "hop" arriving separately would be two answers, one of them
 * nonsense. Joining only ADJACENT runs is what keeps this safe: a persona row
 * between two user rows ends the run, so a reply can never be absorbed into a
 * question or vice versa.
 */
function collapseRuns(turns: RecordedTurn[]): RecordedTurn[] {
  const out: RecordedTurn[] = [];
  for (const turn of turns) {
    const last = out[out.length - 1];
    if (last !== undefined && last.role === turn.role) {
      out[out.length - 1] = {
        role: last.role,
        content: `${last.content} ${turn.content}`.trim(),
      };
    } else {
      out.push({ ...turn });
    }
  }
  return out;
}
