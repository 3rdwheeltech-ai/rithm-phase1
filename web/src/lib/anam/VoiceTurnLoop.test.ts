import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceTurnLoop, type VoiceTurnOutcome } from "./VoiceTurnLoop";
import { ANAM_EVENT, FakeAnamClient, personaMessage, userMessage } from "./fakeClient";
import type { VoicePhase } from "../../store/assistant";

/**
 * The turn loop, against a hand-rolled fake — NO `vi.mock`, no WebRTC.
 *
 * `VoiceTurnLoop` takes its client as a constructor argument precisely so this
 * is possible: the code under test stays on its real path, which is the API
 * suite's idiom carried over. It also lets us drive orderings a real SDK would
 * never reproduce on demand — an interruption arriving mid-speech, a history
 * event re-firing with the same ids, a close during a talk stream.
 */

const DEBOUNCE_MS = 300;

interface Harness {
  client: FakeAnamClient;
  loop: VoiceTurnLoop;
  sent: string[];
  phases: VoicePhase[];
  transcripts: string[];
  replies: string[];
  ends: string[];
  /** Resolve the turn currently held open. */
  release: (outcome?: VoiceTurnOutcome) => void;
}

function reply(text: string, suggestions: string[] = []): VoiceTurnOutcome {
  return { kind: "reply", text, suggestions };
}

function harness(options: { hold?: boolean } = {}): Harness {
  const client = new FakeAnamClient();
  const sent: string[] = [];
  const phases: VoicePhase[] = [];
  const transcripts: string[] = [];
  const replies: string[] = [];
  const ends: string[] = [];

  let resolve: ((outcome: VoiceTurnOutcome) => void) | null = null;

  const loop = new VoiceTurnLoop({
    client,
    runTurn: (text) => {
      sent.push(text);
      if (options.hold === true) {
        return new Promise<VoiceTurnOutcome>((r) => {
          resolve = r;
        });
      }
      return Promise.resolve(reply(`Answer to ${text}`));
    },
    onPhase: (phase) => phases.push(phase),
    onUserTranscript: (text) => transcripts.push(text),
    onAssistantReply: (text) => replies.push(text),
    onVideoPlaying: () => undefined,
    onEnd: (reason) => ends.push(reason),
  });
  loop.attach();

  return {
    client,
    loop,
    sent,
    phases,
    transcripts,
    replies,
    ends,
    release: (outcome = reply("held")) => resolve?.(outcome),
  };
}

/** Let the microtask queue drain — awaited promises, not timers. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("hearing", () => {
  it("sends one turn per utterance even though the event carries the whole history", async () => {
    const h = harness();

    h.client.emit(ANAM_EVENT.MESSAGE_HISTORY_UPDATED, [userMessage("m1", "a rainy drive")]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    await settle();

    h.client.emit(ANAM_EVENT.MESSAGE_HISTORY_UPDATED, [
      userMessage("m1", "a rainy drive"),
      personaMessage("p1", "Nice one."),
      userMessage("m2", "lo-fi"),
    ]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    await settle();

    // Without the `dispatched` guard, turn two resends turn one.
    expect(h.sent).toEqual(["a rainy drive", "lo-fi"]);
  });

  it("does not send the persona's own reply back as a turn", async () => {
    // THIS IS THE INFINITE LOOP. Persona rows are what WE just spoke, echoed
    // back; sending them bills every hop and never terminates.
    const h = harness();

    h.client.emit(ANAM_EVENT.MESSAGE_HISTORY_UPDATED, [
      personaMessage("p1", "What genre are we going for?"),
    ]);
    vi.advanceTimersByTime(DEBOUNCE_MS * 4);
    await settle();

    expect(h.sent).toEqual([]);
  });

  it("treats a growing partial transcript as one turn, not two", async () => {
    // STT emits an interim, then a revised final, under the SAME message id.
    const h = harness();

    h.client.emit(ANAM_EVENT.MESSAGE_HISTORY_UPDATED, [userMessage("m1", "a rainy")]);
    vi.advanceTimersByTime(100);
    h.client.emit(ANAM_EVENT.MESSAGE_HISTORY_UPDATED, [
      userMessage("m1", "a rainy drive at night"),
    ]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    await settle();

    expect(h.sent).toEqual(["a rainy drive at night"]);
  });

  it("coalesces two utterances inside the debounce into a single turn", async () => {
    // Anam split one thought into two messages. The interviewer should read
    // them as the one thought they were.
    const h = harness();

    h.client.emit(ANAM_EVENT.MESSAGE_HISTORY_UPDATED, [userMessage("m1", "lo-fi")]);
    vi.advanceTimersByTime(100);
    h.client.emit(ANAM_EVENT.MESSAGE_HISTORY_UPDATED, [
      userMessage("m1", "lo-fi"),
      userMessage("m2", "and quite slow"),
    ]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    await settle();

    expect(h.sent).toEqual(["lo-fi and quite slow"]);
  });

  it("ignores an empty transcript", async () => {
    // STT emits these on a cough — and `ChatTurnRequest` has min_length=1 with
    // str_strip_whitespace=True, so an empty turn would be a 422.
    const h = harness();

    h.client.emit(ANAM_EVENT.MESSAGE_HISTORY_UPDATED, [userMessage("m1", "   ")]);
    vi.advanceTimersByTime(DEBOUNCE_MS * 4);
    await settle();

    expect(h.sent).toEqual([]);
    expect(h.client.streams).toEqual([]);
  });

  it("shows the user their own words immediately, before the reply exists", async () => {
    // Layer 1 of the ~3s cover, and the one doing the real work: it answers
    // the question the user actually has, which is "did it hear me right?"
    const h = harness({ hold: true });

    h.client.emit(ANAM_EVENT.MESSAGE_HISTORY_UPDATED, [userMessage("m1", "a rainy drive")]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    await settle();

    expect(h.transcripts).toEqual(["a rainy drive"]);
    expect(h.replies).toEqual([]);
    expect(h.phases).toContain("thinking");
  });
});

describe("serialising", () => {
  it("never runs two turns at once", async () => {
    /*
      Two concurrent POSTs would be actively harmful rather than wasteful: both
      append a user row, both run the Bedrock chain, both save_draft
      last-writer-wins, and the cache folds them in COMPLETION order — which
      need not be send order.
    */
    const h = harness({ hold: true });

    h.client.emit(ANAM_EVENT.MESSAGE_HISTORY_UPDATED, [userMessage("m1", "first")]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    await settle();
    expect(h.sent).toEqual(["first"]);

    // A second utterance arrives mid-turn — a correction, exactly when people
    // speak again.
    h.client.emit(ANAM_EVENT.MESSAGE_HISTORY_UPDATED, [
      userMessage("m1", "first"),
      userMessage("m2", "second"),
    ]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    await settle();

    // Buffered, not raced and not dropped.
    expect(h.sent).toEqual(["first"]);

    h.release(reply("ok"));
    await settle();
    await settle();

    expect(h.sent).toEqual(["first", "second"]);
  });
});

describe("speaking", () => {
  it("pushes every chunk in one pass so the fifteen-second stream timeout cannot fire", async () => {
    const h = harness({ hold: true });

    h.client.emit(ANAM_EVENT.MESSAGE_HISTORY_UPDATED, [userMessage("m1", "hi")]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    await settle();

    // The fake's "task" counter is bumped from a microtask queued immediately
    // before the reply lands. If `speak` awaited even ONCE between chunks,
    // this would run in the gap and the tick would no longer match — which is
    // exactly the gap that starts the SDK's 15s idle clock counting.
    queueMicrotask(() => h.client.advanceTask());
    h.release(reply("One. Two. Three."));
    await settle();
    await settle();

    const stream = h.client.lastStream!;
    expect(stream.chunks).toHaveLength(3);
    expect(stream.endedSynchronously).toBe(true);
  });

  it("marks the last chunk end-of-speech and ends the message exactly once", async () => {
    const h = harness({ hold: true });

    h.client.emit(ANAM_EVENT.MESSAGE_HISTORY_UPDATED, [userMessage("m1", "hi")]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    await settle();
    h.release(reply("Nice one. What mood?"));
    await settle();
    await settle();

    const stream = h.client.lastStream!;
    expect(stream.chunks.map((c) => c.text)).toEqual(["Nice one.", "What mood?"]);
    expect(stream.chunks.map((c) => c.endOfSpeech)).toEqual([false, true]);
    expect(stream.endCount).toBe(1);
  });

  it("sanitises the reply before it is spoken", async () => {
    const h = harness({ hold: true });

    h.client.emit(ANAM_EVENT.MESSAGE_HISTORY_UPDATED, [userMessage("m1", "hi")]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    await settle();
    h.release(reply("**Nice** — [Verse 1] what genre? 🎵"));
    await settle();
    await settle();

    // The dash becomes a comma: the TTS engine has no word for one.
    expect(h.client.lastStream!.chunks[0]!.text).toBe("Nice, what genre?");
  });

  it("opens no talk stream for a reply that sanitises away to nothing", async () => {
    const h = harness({ hold: true });

    h.client.emit(ANAM_EVENT.MESSAGE_HISTORY_UPDATED, [userMessage("m1", "hi")]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    await settle();
    h.release(reply("🎵"));
    await settle();
    await settle();

    expect(h.client.streams).toEqual([]);
    expect(h.phases[h.phases.length - 1]).toBe("listening");
  });
});

describe("barge-in", () => {
  it("ends the talk stream and returns to listening on TALK_STREAM_INTERRUPTED", async () => {
    /*
      The microphone is NOT muted during a reply. Anam ships this event as a
      first-class path, and barge-in is what makes a wrong three-second answer
      survivable.
    */
    const h = harness();

    h.client.emit(ANAM_EVENT.MESSAGE_HISTORY_UPDATED, [userMessage("m1", "hi")]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    await settle();

    const streamsBefore = h.client.streams.length;
    h.client.emit(ANAM_EVENT.TALK_STREAM_INTERRUPTED, "corr-1");

    expect(h.phases[h.phases.length - 1]).toBe("listening");
    // NOT re-spoken: the transcript is already complete, and only the audio
    // was cut — which is exactly what interrupting asked for.
    expect(h.client.streams.length).toBe(streamsBefore);
    expect(h.client.lastStream!.endCount).toBe(1);
    expect(h.client.muted).toBe(false);
  });

  it("keeps an interrupted reply in the transcript", async () => {
    const h = harness({ hold: true });

    h.client.emit(ANAM_EVENT.MESSAGE_HISTORY_UPDATED, [userMessage("m1", "hi")]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    await settle();
    h.release(reply("A long answer nobody let it finish."));
    await settle();
    await settle();

    h.client.emit(ANAM_EVENT.TALK_STREAM_INTERRUPTED, "corr-1");

    // The turn resolved into the caller's hands BEFORE speak was ever called.
    expect(h.replies).toEqual(["A long answer nobody let it finish."]);
  });
});

describe("ending", () => {
  it("ends the session rather than retrying when the turn is rate-limited", async () => {
    // Holding the one global slot open for a server that will refuse the next
    // turn too is the failure this prevents.
    const h = harness({ hold: true });

    h.client.emit(ANAM_EVENT.MESSAGE_HISTORY_UPDATED, [userMessage("m1", "hi")]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    await settle();
    h.release({ kind: "spoken-error", text: "That's all for today.", end: "chat-rate-limited" });
    await settle();
    await settle();

    expect(h.ends).toEqual(["chat-rate-limited"]);
    // It is still SPOKEN. In voice there is nothing to read.
    expect(h.client.lastStream!.chunks[0]!.text).toBe("That's all for today.");
  });

  it("keeps the session open when one turn was merely unavailable", async () => {
    // The message is already committed server-side, so saying it again works —
    // and ending the call over one refused turn costs the slot as well.
    const h = harness({ hold: true });

    h.client.emit(ANAM_EVENT.MESSAGE_HISTORY_UPDATED, [userMessage("m1", "hi")]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    await settle();
    h.release({ kind: "spoken-error", text: "Say it again?", end: null });
    await settle();
    await settle();

    expect(h.ends).toEqual([]);
  });

  it("disposes mid-speech without leaving a talk stream open", async () => {
    const h = harness();

    h.client.emit(ANAM_EVENT.MESSAGE_HISTORY_UPDATED, [userMessage("m1", "hi")]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    await settle();

    h.loop.dispose();

    expect(h.client.lastStream!.endCount).toBe(1);
    expect(h.client.listenerCount(ANAM_EVENT.MESSAGE_HISTORY_UPDATED)).toBe(0);
  });

  it("posts nothing after dispose, however late an event arrives", async () => {
    const h = harness();
    h.loop.dispose();

    h.client.emit(ANAM_EVENT.MESSAGE_HISTORY_UPDATED, [userMessage("m1", "too late")]);
    vi.advanceTimersByTime(DEBOUNCE_MS * 4);
    await settle();

    expect(h.sent).toEqual([]);
  });

  it("posts nothing while muted, which is what ending and a hidden tab do", async () => {
    const h = harness();
    h.loop.setMuted(true);

    h.client.emit(ANAM_EVENT.MESSAGE_HISTORY_UPDATED, [userMessage("m1", "stray")]);
    vi.advanceTimersByTime(DEBOUNCE_MS * 4);
    await settle();

    expect(h.sent).toEqual([]);
    expect(h.client.muted).toBe(true);
  });

  it("reports a drop that cut a reply short, so the user can read the rest", async () => {
    const h = harness({ hold: true });

    h.client.emit(ANAM_EVENT.MESSAGE_HISTORY_UPDATED, [userMessage("m1", "hi")]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    await settle();
    h.release(reply("A long answer they only half heard."));
    await settle();
    await settle();

    h.client.emit(ANAM_EVENT.CONNECTION_CLOSED, "CONNECTION_CLOSED_CODE_WEBRTC_FAILURE");

    expect(h.ends).toEqual(["dropped"]);
    // They already paid a Bedrock turn for this. The caller sends them to Chat.
    expect(h.loop.hasUnspokenReply()).toBe(true);
  });

  it("does not claim a reply went unspoken when the user interrupted it", async () => {
    // Interrupting is the user CHOOSING to stop listening. The transcript is
    // already complete, and shoving them into Chat for it would punish the
    // feature's best affordance.
    const h = harness({ hold: true });

    h.client.emit(ANAM_EVENT.MESSAGE_HISTORY_UPDATED, [userMessage("m1", "hi")]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    await settle();
    h.release(reply("A long answer."));
    await settle();
    await settle();

    h.client.emit(ANAM_EVENT.TALK_STREAM_INTERRUPTED, "corr-1");
    h.client.emit(ANAM_EVENT.CONNECTION_CLOSED, "CONNECTION_CLOSED_CODE_NORMAL");

    expect(h.loop.hasUnspokenReply()).toBe(false);
  });

  it("reports a drop while merely listening as nothing to read", async () => {
    const h = harness();

    h.client.emit(ANAM_EVENT.CONNECTION_CLOSED, "CONNECTION_CLOSED_CODE_WEBRTC_FAILURE");

    expect(h.ends).toEqual(["dropped"]);
    expect(h.loop.hasUnspokenReply()).toBe(false);
  });

  it("reports a denied microphone", async () => {
    const h = harness();
    h.client.emit(ANAM_EVENT.MIC_PERMISSION_DENIED, "NotAllowedError");
    expect(h.ends).toEqual(["mic-denied"]);
  });

  it("gives up on a microphone prompt nobody answered", () => {
    // A prompt the user walked away from holds the one global slot exactly as
    // firmly as a live call does.
    const h = harness();

    h.client.emit(ANAM_EVENT.MIC_PERMISSION_PENDING);
    vi.advanceTimersByTime(20_000);

    expect(h.ends).toEqual(["mic-timeout"]);
  });

  it("stops waiting once permission is granted", () => {
    const h = harness();

    h.client.emit(ANAM_EVENT.MIC_PERMISSION_PENDING);
    h.client.emit(ANAM_EVENT.MIC_PERMISSION_GRANTED);
    vi.advanceTimersByTime(60_000);

    expect(h.ends).toEqual([]);
  });

  it("does not fire the microphone timeout after dispose", () => {
    const h = harness();

    h.client.emit(ANAM_EVENT.MIC_PERMISSION_PENDING);
    h.loop.dispose();
    vi.advanceTimersByTime(60_000);

    expect(h.ends).toEqual([]);
  });
});

describe("the greeting", () => {
  it("speaks a line the loop did not produce, without posting it as a turn", () => {
    const h = harness();

    h.loop.greet("Tell me about the song you want.");

    expect(h.client.lastStream!.chunks[0]!.text).toBe("Tell me about the song you want.");
    expect(h.sent).toEqual([]);
  });
});
