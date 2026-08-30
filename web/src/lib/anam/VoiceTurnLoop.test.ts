import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  VoiceTurnLoop,
  type RecordedTurn,
  type VoiceRecordOutcome,
} from "./VoiceTurnLoop";
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
 *
 * WHAT THESE TESTS ARE ABOUT NOW. The loop used to hear a person, ask RITHM's
 * interviewer and speak the answer. Anam's own model answers, so it hears a
 * person, hears the PERSONA, and records both. The single largest change is
 * that a persona row is no longer an echo to be dropped — it is the only copy
 * of Anam's reply that will ever exist, and losing it means Chat shows a
 * transcript with holes in it.
 */

const DEBOUNCE_MS = 300;

interface Harness {
  client: FakeAnamClient;
  loop: VoiceTurnLoop;
  /** One entry per POST, each the batch of turns it carried. */
  sent: RecordedTurn[][];
  phases: VoicePhase[];
  transcripts: string[];
  replies: string[];
  ends: string[];
  /** Every recorded turn, flattened to "role:content" for readable assertions. */
  lines: () => string[];
  /** Resolve the record currently held open. */
  release: (outcome?: VoiceRecordOutcome) => void;
}

function harness(options: { hold?: boolean } = {}): Harness {
  const client = new FakeAnamClient();
  const sent: RecordedTurn[][] = [];
  const phases: VoicePhase[] = [];
  const transcripts: string[] = [];
  const replies: string[] = [];
  const ends: string[] = [];

  let resolve: ((outcome: VoiceRecordOutcome) => void) | null = null;

  const loop = new VoiceTurnLoop({
    client,
    recordTurns: (turns) => {
      sent.push(turns);
      if (options.hold === true) {
        return new Promise<VoiceRecordOutcome>((r) => {
          resolve = r;
        });
      }
      return Promise.resolve<VoiceRecordOutcome>({ kind: "recorded" });
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
    lines: () => sent.flat().map((turn) => `${turn.role}:${turn.content}`),
    release: (outcome = { kind: "recorded" }) => resolve?.(outcome),
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
  it("records each turn once even though the event carries the whole history", async () => {
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

    // Without the `dispatched` guard, batch two resends turn one.
    expect(h.lines()).toEqual([
      "user:a rainy drive",
      "assistant:Nice one.",
      "user:lo-fi",
    ]);
  });

  it("records the persona's reply, because nothing else has a copy of it", async () => {
    /*
      THE INVERTED GUARD. This used to assert the opposite — persona rows were
      dropped because they were an echo of what we had just told Anam to say,
      and resending them was an infinite loop that billed every hop.

      That loop cannot exist now: this class produces no replies, so a persona
      row is Anam's model ANSWERING. Drop it and the reply exists nowhere —
      not in the transcript Chat reads, and not as the `asked` that tells the
      extractor which question the next answer belongs to.
    */
    const h = harness();

    h.client.emit(ANAM_EVENT.MESSAGE_HISTORY_UPDATED, [
      personaMessage("p1", "What genre are we going for?"),
    ]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    await settle();

    expect(h.lines()).toEqual(["assistant:What genre are we going for?"]);
    expect(h.replies).toEqual(["What genre are we going for?"]);
  });

  it("keeps a reply below the question it answered", async () => {
    // Order is the whole reason the buffer is a Map and not a pair of lists. A
    // scrambled batch writes an answer above its own question, and the
    // extractor reads a user turn as the answer to the line before it.
    const h = harness();

    h.client.emit(ANAM_EVENT.MESSAGE_HISTORY_UPDATED, [
      userMessage("m1", "hip-hop"),
      personaMessage("p1", "Hip-Hop it is. What mood?"),
      userMessage("m2", "dark"),
    ]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    await settle();

    expect(h.lines()).toEqual([
      "user:hip-hop",
      "assistant:Hip-Hop it is. What mood?",
      "user:dark",
    ]);
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

    expect(h.lines()).toEqual(["user:a rainy drive at night"]);
  });

  it("coalesces two utterances inside the debounce into a single turn", async () => {
    // Anam split one thought into two messages. The extractor should read them
    // as the one thought they were — "lo-fi" and "and quite slow" separately
    // would be two answers to the same question, one of them nonsense.
    const h = harness();

    h.client.emit(ANAM_EVENT.MESSAGE_HISTORY_UPDATED, [userMessage("m1", "lo-fi")]);
    vi.advanceTimersByTime(100);
    h.client.emit(ANAM_EVENT.MESSAGE_HISTORY_UPDATED, [
      userMessage("m1", "lo-fi"),
      userMessage("m2", "and quite slow"),
    ]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    await settle();

    expect(h.lines()).toEqual(["user:lo-fi and quite slow"]);
  });

  it("never merges across a change of speaker", async () => {
    // The safety rail on the merge above: only ADJACENT same-role runs join,
    // so a reply can never be absorbed into a question or vice versa.
    const h = harness();

    h.client.emit(ANAM_EVENT.MESSAGE_HISTORY_UPDATED, [
      userMessage("m1", "lo-fi"),
      personaMessage("p1", "Nice."),
      userMessage("m2", "and quite slow"),
    ]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    await settle();

    expect(h.lines()).toEqual([
      "user:lo-fi",
      "assistant:Nice.",
      "user:and quite slow",
    ]);
  });

  it("ignores an empty transcript", async () => {
    // STT emits these on a cough — and `RecordedTurn` has min_length=1 with
    // str_strip_whitespace=True, so an empty turn would be a 422.
    const h = harness();

    h.client.emit(ANAM_EVENT.MESSAGE_HISTORY_UPDATED, [userMessage("m1", "   ")]);
    vi.advanceTimersByTime(DEBOUNCE_MS * 4);
    await settle();

    expect(h.sent).toEqual([]);
    expect(h.client.streams).toEqual([]);
  });

  it("shows the user their own words immediately, before the reply exists", async () => {
    // Layer 1 of the cover for the gap, and the one doing the real work: it
    // answers the question the user actually has, "did it hear me right?"
    const h = harness({ hold: true });

    h.client.emit(ANAM_EVENT.USER_SPEECH_ENDED);
    h.client.emit(ANAM_EVENT.MESSAGE_HISTORY_UPDATED, [userMessage("m1", "a rainy drive")]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    await settle();

    expect(h.transcripts).toEqual(["a rainy drive"]);
    expect(h.replies).toEqual([]);
    expect(h.phases).toContain("thinking");
  });

  it("clears the thinking phase once Anam has answered", async () => {
    const h = harness();

    h.client.emit(ANAM_EVENT.USER_SPEECH_ENDED);
    h.client.emit(ANAM_EVENT.MESSAGE_HISTORY_UPDATED, [
      userMessage("m1", "hip-hop"),
      personaMessage("p1", "Good pick."),
    ]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    await settle();

    expect(h.phases[h.phases.length - 1]).toBe("speaking");
  });
});

describe("serialising", () => {
  it("never records two batches at once", async () => {
    /*
      Two concurrent POSTs would be actively harmful rather than wasteful: both
      append rows, both save_draft last-writer-wins, and they complete in an
      order that need not be send order — an out-of-order transcript the user
      can then read in Chat.
    */
    const h = harness({ hold: true });

    h.client.emit(ANAM_EVENT.MESSAGE_HISTORY_UPDATED, [userMessage("m1", "first")]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    await settle();
    expect(h.lines()).toEqual(["user:first"]);

    // A second utterance arrives mid-record — a correction, exactly when
    // people speak again.
    h.client.emit(ANAM_EVENT.MESSAGE_HISTORY_UPDATED, [
      userMessage("m1", "first"),
      userMessage("m2", "second"),
    ]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    await settle();

    // Buffered, not raced and not dropped.
    expect(h.lines()).toEqual(["user:first"]);

    h.release();
    await settle();
    await settle();

    expect(h.lines()).toEqual(["user:first", "user:second"]);
  });
});

describe("speaking", () => {
  /*
    `speak` is reached two ways now, and neither is a reply: the greeting, and
    an error that has to be said out loud because there is nothing to read.
    Anam speaks its own answers, so these drive `greet` — the one path that
    still puts our words in the avatar's mouth.
  */

  it("pushes every chunk in one pass so the fifteen-second stream timeout cannot fire", () => {
    const h = harness();

    // If `speak` awaited even ONCE between chunks, the stream would not have
    // ended synchronously — and that gap is exactly what starts the SDK's 15 s
    // idle clock counting.
    h.loop.greet("One. Two. Three.");

    const stream = h.client.lastStream!;
    expect(stream.chunks).toHaveLength(3);
    expect(stream.endedSynchronously).toBe(true);
  });

  it("marks the last chunk end-of-speech and ends the message exactly once", () => {
    const h = harness();

    h.loop.greet("Nice one. What mood?");

    const stream = h.client.lastStream!;
    expect(stream.chunks.map((c) => c.text)).toEqual(["Nice one.", "What mood?"]);
    expect(stream.chunks.map((c) => c.endOfSpeech)).toEqual([false, true]);
    expect(stream.endCount).toBe(1);
  });

  it("sanitises a line before it is spoken", () => {
    const h = harness();

    h.loop.greet("**Nice** — [Verse 1] what genre? 🎵");

    expect(h.client.lastStream!.chunks[0]!.text).toBe("Nice — what genre?");
  });

  it("opens no talk stream for a line that sanitises away to nothing", () => {
    const h = harness();

    h.loop.greet("🎵");

    expect(h.client.streams).toEqual([]);
    expect(h.phases[h.phases.length - 1]).toBe("listening");
  });
});

describe("barge-in", () => {
  it("ends the talk stream and returns to listening on TALK_STREAM_INTERRUPTED", () => {
    /*
      The microphone is NOT muted during a reply. Anam ships this event as a
      first-class path, and barge-in is what makes a wrong three-second answer
      survivable.
    */
    const h = harness();
    h.loop.greet("A long greeting nobody let it finish.");

    const streamsBefore = h.client.streams.length;
    h.client.emit(ANAM_EVENT.TALK_STREAM_INTERRUPTED, "corr-1");

    expect(h.phases[h.phases.length - 1]).toBe("listening");
    // NOT re-spoken: only the audio was cut, which is what interrupting asked
    // for.
    expect(h.client.streams.length).toBe(streamsBefore);
    expect(h.client.lastStream!.endCount).toBe(1);
    expect(h.client.muted).toBe(false);
  });

  it("keeps an interrupted reply in the transcript", async () => {
    const h = harness();

    h.client.emit(ANAM_EVENT.MESSAGE_HISTORY_UPDATED, [
      personaMessage("p1", "A long answer nobody let it finish."),
    ]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    await settle();

    h.client.emit(ANAM_EVENT.TALK_STREAM_INTERRUPTED, "corr-1");

    // Anam had already reported the line before the audio was cut, so it is
    // recorded and readable even though it was never heard in full.
    expect(h.replies).toEqual(["A long answer nobody let it finish."]);
    expect(h.lines()).toEqual(["assistant:A long answer nobody let it finish."]);
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

  it("disposes mid-speech without leaving a talk stream open", () => {
    const h = harness();
    h.loop.greet("A greeting cut short by the door closing.");

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

  it("records nothing while muted, which is what ending and a hidden tab do", async () => {
    const h = harness();
    h.loop.setMuted(true);

    h.client.emit(ANAM_EVENT.MESSAGE_HISTORY_UPDATED, [userMessage("m1", "stray")]);
    vi.advanceTimersByTime(DEBOUNCE_MS * 4);
    await settle();

    expect(h.sent).toEqual([]);
    expect(h.client.muted).toBe(true);
  });

  it("reports a drop that cut a reply short, so the user can read the rest", async () => {
    // Anam reports the line as it starts saying it, which puts the phase in
    // "speaking" — so a close arriving here is a connection that died on an
    // answer the user may only have half heard.
    const h = harness();

    h.client.emit(ANAM_EVENT.MESSAGE_HISTORY_UPDATED, [
      personaMessage("p1", "A long answer they only half heard."),
    ]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    await settle();

    h.client.emit(ANAM_EVENT.CONNECTION_CLOSED, "CONNECTION_CLOSED_CODE_WEBRTC_FAILURE");

    expect(h.ends).toEqual(["dropped"]);
    // It is already recorded, so the caller sends them to Chat to read it.
    expect(h.loop.hasUnspokenReply()).toBe(true);
  });

  it("does not claim a reply went unspoken when the user interrupted it", async () => {
    // Interrupting is the user CHOOSING to stop listening. The transcript is
    // already complete, and shoving them into Chat for it would punish the
    // feature's best affordance.
    const h = harness();

    h.client.emit(ANAM_EVENT.MESSAGE_HISTORY_UPDATED, [
      personaMessage("p1", "A long answer."),
    ]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
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
