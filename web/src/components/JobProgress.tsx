import { useEffect, useState } from "react";
import type { JobStreamState } from "../hooks/useJobStream";

const fmtElapsed = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;

/**
 * The SSE-driven status surface.
 *
 * Every number here comes from the server. `estimated_start_seconds` in
 * particular is ESTIMATED_COLD_START_SECONDS from the task definition, and it
 * will change — it was sized against a worker image that no longer exists — so
 * render whatever arrives and never hardcode a figure.
 */
export default function JobProgress({ stream }: { stream: JobStreamState }) {
  const [elapsed, setElapsed] = useState(0);
  const active = stream.phase === "queued" || stream.phase === "running";

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(id);
  }, [active]);

  useEffect(() => {
    if (stream.phase === "idle") setElapsed(0);
  }, [stream.phase]);

  if (!active && stream.phase !== "lost") return null;

  const coldStart =
    stream.phase === "queued" &&
    stream.estimatedStartSeconds !== undefined &&
    stream.estimatedStartSeconds > 30;

  let headline: string;
  let detail: string;

  if (stream.phase === "lost") {
    headline = "We lost track of this one";
    detail = "Check your library — it may still have finished.";
  } else if (coldStart) {
    headline = "Warming up";
    detail = `The first track of a session takes about ${Math.round(
      stream.estimatedStartSeconds!,
    )}s while the GPU starts.`;
  } else if (stream.phase === "queued") {
    headline = "Queued";
    detail = "Waiting for a free worker…";
  } else {
    headline = "Composing your track";
    detail =
      stream.estimatedSecondsRemaining !== undefined
        ? `About ${Math.round(stream.estimatedSecondsRemaining)}s remaining.`
        : "Rendering audio…";
  }

  // Separate from `phase` on purpose: a reconnect is not a failing generation,
  // so it gets a quiet marker NEXT TO the status, never instead of it.
  const reconnecting = stream.connection === "retrying" || stream.connection === "polling";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-md animate-fade-in">
      <div className="ai-frame w-full max-w-[380px]">
        <div className="quick-surface px-7 py-8 text-center">
          <div className="mb-5 flex items-center justify-center gap-2" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="h-2.5 w-2.5 rounded-full bg-brand-soft motion-safe:animate-pulse"
                style={{ animationDelay: `${i * 200}ms` }}
              />
            ))}
          </div>

          {/*
            The whole interaction is a status change over time, which is exactly
            what aria-live is for — the one accessibility commitment on this
            screen that genuinely earns its keep.
          */}
          <div aria-live="polite">
            <p className="text-[16px] font-semibold tracking-[-0.01em] text-ink">{headline}</p>
            <p className="mt-1 text-[13px] text-ink-muted">{detail}</p>
          </div>

          <div className="relative mt-5 h-1 w-full overflow-hidden rounded-full bg-white/10">
            <div className="progress-sweep absolute inset-y-0 left-0 rounded-full" />
          </div>

          <div className="mt-3 flex items-center justify-center gap-2 text-[11.5px] tabular-nums text-ink-faint">
            <span>{fmtElapsed(elapsed)} elapsed</span>
            {reconnecting && (
              <span className="flex items-center gap-1 text-amber-300/80">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-300/80 motion-safe:animate-pulse" />
                reconnecting…
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
