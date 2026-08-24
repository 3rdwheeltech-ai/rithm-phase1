import { create } from "zustand";
import type { JobHandle, JobStreamState } from "../hooks/useJobStream";

const IDLE_STREAM: JobStreamState = { phase: "idle", jobId: null, connection: "closed" };

export interface GenerationState {
  /**
   * The live job. Set the moment a 202 comes back and read by `GenerationPill`,
   * which is the ONLY caller of `useJobStream` — the stream has to be owned by
   * something that outlives the form, or navigating away (including the app's
   * own jump to the finished track) tears the EventSource down mid-generation.
   */
  handle: JobHandle | null;
  /** Last state published by the pill, so the forms can read `busy` from here. */
  stream: JobStreamState;
  /** Mutation fired, 202 not back yet — there is no job to stream at all. */
  submitting: boolean;
  /**
   * True only when the model will write the words itself: vocals requested and
   * no user lyrics supplied. Decided at submit time by whichever surface
   * started the job, because only it knows the form state. See `jobLabel`.
   */
  writesLyrics: boolean;
  /** Wall clock of the submit, for the pill's elapsed counter. */
  startedAt: number | null;
  /**
   * Wall clock of the queued → running edge. Deliberately NOT `startedAt`: the
   * lyric window is measured from the moment the worker picks the job up, and a
   * 90s cold start would otherwise eat it before a single line is written.
   */
  runningSince: number | null;
  /** The user closed a terminal pill; don't bring it back for this job. */
  dismissed: boolean;

  begin: (writesLyrics: boolean) => void;
  accept: (handle: JobHandle) => void;
  publish: (stream: JobStreamState) => void;
  /** The mutation was rejected before a job existed — clear `busy`. */
  abandon: () => void;
  dismiss: () => void;
  reset: () => void;
}

const CLEARED = {
  handle: null,
  stream: IDLE_STREAM,
  submitting: false,
  writesLyrics: false,
  startedAt: null,
  runningSince: null,
  dismissed: false,
} as const;

/** One generation at a time, shared between the three forms and the shell. */
export const useGeneration = create<GenerationState>((set) => ({
  ...CLEARED,

  begin: (writesLyrics) =>
    set({ ...CLEARED, submitting: true, writesLyrics, startedAt: Date.now() }),

  accept: (handle) => set({ handle, submitting: false }),

  publish: (stream) =>
    set((prev) => ({
      stream,
      // Latch on the first `running` frame only. The stream can re-emit it on
      // every reconnect, and restarting the clock there would push the label
      // back to "Generating lyrics…" long after the words were written.
      runningSince:
        stream.phase === "running" && prev.runningSince === null
          ? Date.now()
          : prev.runningSince,
    })),

  abandon: () => set({ ...CLEARED }),

  dismiss: () => set({ dismissed: true }),

  reset: () => set({ ...CLEARED }),
}));

/**
 * True while anything is in flight. One generation at a time is a UX decision
 * AND what keeps the 20/day budget legible.
 */
export const selectBusy = (s: GenerationState) =>
  s.submitting || s.stream.phase === "queued" || s.stream.phase === "running";
