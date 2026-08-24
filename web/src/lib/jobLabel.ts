import type { JobPhase } from "../hooks/useJobStream";

/**
 * How long "Generating lyrics…" holds before the label moves on.
 *
 * The API has no lyrics phase to read — it emits QUEUED → RUNNING →
 * COMPLETED/FAILED and nothing finer — so this is a client-side approximation
 * of the worker's LM planning step, not a report of it. Keep it modest: saying
 * "composing" while the model is still writing words is a much smaller lie than
 * saying "writing lyrics" over a finished set of them.
 */
export const LYRIC_PHASE_SECONDS = 15;

/** Cold start estimates below this are just queue latency, not a GPU boot. */
export const COLD_START_THRESHOLD_SECONDS = 30;

export type PillTone = "signal" | "amber" | "danger";

export interface JobLabelArgs {
  phase: JobPhase;
  /** `estimated_start_seconds` off the `queued` frame. Server-sent, never hardcoded. */
  estimatedStartSeconds?: number;
  writesLyrics: boolean;
  /** Seconds since the queued → running edge. 0 when not running. */
  runningSeconds: number;
}

export interface JobLabel {
  label: string;
  tone: PillTone;
  /** Terminal states stop the clock and the sweep, and offer a way out. */
  terminal: boolean;
}

/**
 * The single place the status pill's prose is decided — pure so the whole table
 * is testable without a DOM or a live stream.
 *
 * Returns null only for a job that does not exist. Note that `idle` is NOT the
 * same as "nothing happening": `useJobStream` sits at `idle` between accepting
 * a handle and the first frame landing, and a pill that blinked out in that gap
 * would look broken. Callers decide whether a job exists at all (the store's
 * `startedAt`); this only decides what to say about one.
 */
export function jobLabel({
  phase,
  estimatedStartSeconds,
  writesLyrics,
  runningSeconds,
}: JobLabelArgs): JobLabel | null {
  switch (phase) {
    case "lost":
      return { label: "We lost track of this one", tone: "amber", terminal: true };

    case "failed":
      return { label: "Generation failed", tone: "danger", terminal: true };

    case "completed":
      return { label: "Ready", tone: "signal", terminal: true };

    case "queued":
      return estimatedStartSeconds !== undefined &&
        estimatedStartSeconds > COLD_START_THRESHOLD_SECONDS
        ? { label: "Warming up…", tone: "amber", terminal: false }
        : { label: "Queued…", tone: "signal", terminal: false };

    case "running":
      return writesLyrics && runningSeconds < LYRIC_PHASE_SECONDS
        ? { label: "Generating lyrics…", tone: "signal", terminal: false }
        : { label: "Composing the song…", tone: "signal", terminal: false };

    // Submitted, but no frame has landed yet — either the POST is still in
    // flight or the stream is opening.
    case "idle":
      return { label: "Starting…", tone: "signal", terminal: false };

    default:
      return null;
  }
}

/** m:ss, for the pill's elapsed counter. */
export const fmtElapsed = (seconds: number): string =>
  `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, "0")}`;
