import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { JobStreamState } from "../hooks/useJobStream";

const fmtElapsed = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;

/**
 * The SSE-driven status surface.
 *
 * Every number here comes from the server. `estimated_start_seconds` in
 * particular is ESTIMATED_COLD_START_SECONDS from the task definition, and it
 * will change — it was sized against a worker image that no longer exists — so
 * render whatever arrives and never hardcode a figure.
 *
 * It renders through a PORTAL. `fixed inset-0` is only viewport-relative when
 * no ancestor establishes a containing block, and both mount points sit inside
 * one: CreateForm's card is `.lg-lens` (backdrop-filter) and QuickGenerate's is
 * `animate-rise` (a retained transform, fill-mode: both). Rendered in place,
 * this scrim covered the form it was mounted in instead of the viewport.
 */
export default function JobProgress({ stream }: { stream: JobStreamState }) {
  const [elapsed, setElapsed] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const active = stream.phase === "queued" || stream.phase === "running";
  // `lost` is TERMINAL — the stream gave up and nothing will move the phase on
  // again. Without a way out, this scrim sat over the whole app swallowing
  // every click until a reload, which reads exactly like "the buttons broke".
  const lost = stream.phase === "lost";

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(id);
  }, [active]);

  useEffect(() => {
    if (stream.phase === "idle") setElapsed(0);
  }, [stream.phase]);

  // A new job re-arms the scrim; otherwise a dismissal would stick forever.
  useEffect(() => {
    if (active) setDismissed(false);
  }, [active]);

  useEffect(() => {
    if (!lost) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDismissed(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lost]);

  if (!active && !lost) return null;
  if (lost && dismissed) return null;
  if (typeof document === "undefined") return null;

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

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={headline}
      className="fixed inset-0 z-[70] flex h-dvh items-center justify-center bg-black/55 px-5 backdrop-blur-md animate-fade-in"
    >
      {/* Click-away as a real button rather than a handler on the scrim: it
          gets keyboard and screen-reader behaviour for free. Only once the job
          is terminal — dismissing a running generation would hide a job the
          user has no other view of. */}
      {lost && (
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          onClick={() => setDismissed(true)}
          className="absolute inset-0 h-full w-full cursor-default"
        />
      )}
      <div className="ai-frame relative w-full max-w-[380px]">
        <div className="quick-surface relative px-6 py-8 text-center sm:px-7">
          {lost && (
            <button
              type="button"
              onClick={() => setDismissed(true)}
              aria-label="Dismiss"
              className="absolute right-3 top-3 rounded-full p-1.5 text-ink-faint transition-colors hover:bg-white/10 hover:text-ink"
            >
              <X className="h-4 w-4" strokeWidth={2} />
            </button>
          )}

          <div
            className={`mb-5 flex items-center justify-center gap-2 ${lost ? "hidden" : ""}`}
            aria-hidden="true"
          >
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="h-2.5 w-2.5 rounded-full bg-signal-bright motion-safe:animate-pulse"
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
            <p className="text-md font-semibold text-ink">{headline}</p>
            <p className="mt-1 text-sm text-ink-muted">{detail}</p>
          </div>

          {/* Nothing is still running once the stream is lost, so neither the
              sweep nor the elapsed clock should keep implying it is. */}
          {!lost && (
            <>
              <div className="relative mt-5 h-1 w-full overflow-hidden rounded-full bg-white/10">
                <div className="progress-sweep absolute inset-y-0 left-0 rounded-full" />
              </div>

              <div className="mt-3 flex items-center justify-center gap-2 font-mono text-2xs tabular-nums text-ink-faint">
                <span>{fmtElapsed(elapsed)} elapsed</span>
                {reconnecting && (
                  <span className="flex items-center gap-1 text-amber">
                    <span className="h-1.5 w-1.5 rounded-full bg-amber motion-safe:animate-pulse" />
                    reconnecting…
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
