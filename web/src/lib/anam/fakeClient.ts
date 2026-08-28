import {
  ANAM_EVENT,
  type AnamClientLike,
  type AnamEventName,
  type TalkStreamLike,
} from "./types";

/**
 * An Anam client that needs no WebRTC, no microphone and no network.
 *
 * SHIPS IN `src/`, NOT IN A TEST FOLDER, on purpose: `VoiceTurnLoop` takes its
 * client as a constructor argument precisely so the loop's tests can run
 * against this with no `vi.mock` and no module interception — the code under
 * test stays on its real path, which is the API suite's idiom carried over.
 *
 * It also lets a test drive orderings a real SDK would never reproduce on
 * demand: an interruption arriving mid-chunk, a history event re-firing with
 * the same ids, a connection closing during a talk stream.
 *
 * It is ~90 lines of plain objects and is tree-shaken out of any build that
 * does not reference it.
 */

export class FakeTalkStream implements TalkStreamLike {
  readonly chunks: { text: string; endOfSpeech: boolean }[] = [];
  endCount = 0;
  /** Whether `endMessage` landed in the same task as the last chunk. */
  endedSynchronously = false;
  private lastChunkTick = -1;

  constructor(private readonly tick: () => number) {}

  streamMessageChunk(text: string, endOfSpeech: boolean): void {
    this.chunks.push({ text, endOfSpeech });
    this.lastChunkTick = this.tick();
  }

  endMessage(): void {
    this.endCount += 1;
    this.endedSynchronously = this.tick() === this.lastChunkTick;
  }
}

export class FakeAnamClient implements AnamClientLike {
  readonly streams: FakeTalkStream[] = [];
  readonly streamedTo: string[] = [];
  stopCount = 0;
  muted = false;
  muteCalls = 0;

  /**
   * A monotonically increasing "task" counter, bumped by `advanceTask()`.
   *
   * It is how a test asserts that every chunk AND the terminator landed in one
   * synchronous pass — the property that keeps the SDK's 15 s stream timeout
   * from ever starting to count.
   */
  private taskId = 0;

  private readonly handlers = new Map<AnamEventName, Set<(...a: never[]) => void>>();

  addListener(event: AnamEventName, callback: (...args: never[]) => void): void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(callback);
    this.handlers.set(event, set);
  }

  removeListener(event: AnamEventName, callback: (...args: never[]) => void): void {
    this.handlers.get(event)?.delete(callback);
  }

  async streamToVideoElement(videoElementId: string): Promise<void> {
    this.streamedTo.push(videoElementId);
  }

  createTalkMessageStream(): FakeTalkStream {
    const stream = new FakeTalkStream(() => this.taskId);
    this.streams.push(stream);
    return stream;
  }

  muteInputAudio(): unknown {
    this.muted = true;
    this.muteCalls += 1;
    return undefined;
  }

  unmuteInputAudio(): unknown {
    this.muted = false;
    return undefined;
  }

  async stopStreaming(): Promise<void> {
    this.stopCount += 1;
  }

  // ── Test hooks ───────────────────────────────────────────────────────────

  /** Fire an event at every registered handler, as the SDK would. */
  emit(event: AnamEventName, ...args: unknown[]): void {
    for (const handler of [...(this.handlers.get(event) ?? [])]) {
      (handler as (...a: unknown[]) => void)(...args);
    }
  }

  /** How many handlers are registered for an event. */
  listenerCount(event: AnamEventName): number {
    return this.handlers.get(event)?.size ?? 0;
  }

  /** Mark the boundary of a synchronous task, for `endedSynchronously`. */
  advanceTask(): void {
    this.taskId += 1;
  }

  /** The last stream opened, or null. */
  get lastStream(): FakeTalkStream | null {
    return this.streams[this.streams.length - 1] ?? null;
  }
}

/** A user utterance in the shape `MESSAGE_HISTORY_UPDATED` delivers it. */
export function userMessage(id: string, content: string) {
  return { id, content, role: "user" as const };
}

/** A persona row — what WE just spoke, echoed back. Must never be re-sent. */
export function personaMessage(id: string, content: string) {
  return { id, content, role: "persona" as const };
}

export { ANAM_EVENT };
