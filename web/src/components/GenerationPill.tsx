import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import BorderGlow from "./BorderGlow";
import { useJobStream } from "../hooks/useJobStream";
import { fmtElapsed, jobLabel, type PillTone } from "../lib/jobLabel";
import { useGeneration } from "../store/generation";

/** Held for this long on `completed` before the pill retracts. */
const READY_LINGER_MS = 2_000;

const TONE_DOT: Record<PillTone, string> = {
  signal: "bg-amber",
  amber: "bg-amber",
  danger: "bg-danger",
};

/** The pill's permanent glow — off-white, on regardless of tone or phase. */
const PILL_GLOW_COLOR = "40 45% 95%";

/**
 * The generation status island.
 *
 * Mounted ONCE, from App.tsx, and it does four things:
 *
 *  1. owns the job stream. `useJobStream` opens an EventSource in an effect, so
 *     whoever calls it must outlive the job. The three forms do not: the moment
 *     one navigates — including this component's own jump to the finished
 *     track — its stream would be torn down. Hence the store, and hence this
 *     being the only caller.
 *  2. publishes stream state back into the store, which is where the forms read
 *     `busy` from.
 *  3. owns the navigate-on-completion the three forms used to duplicate.
 *  4. renders the pill.
 *
 * It replaces a full-screen `aria-modal` scrim, so the point of the whole thing
 * is what it ISN'T: no backdrop, `pointer-events-none` on the wrapper, and
 * `role="status"` rather than `role="dialog"`. The app stays usable for the
 * two-odd minutes a track takes.
 *
 * It portals for the same reason the old modal did: `fixed` is only
 * viewport-relative when no ancestor establishes a containing block, and the
 * app is full of `backdrop-filter` glass that does.
 */
export default function GenerationPill() {
  const nav = useNavigate();
  const handle = useGeneration((s) => s.handle);
  const publish = useGeneration((s) => s.publish);
  const reset = useGeneration((s) => s.reset);
  const dismiss = useGeneration((s) => s.dismiss);
  const dismissed = useGeneration((s) => s.dismissed);
  const writesLyrics = useGeneration((s) => s.writesLyrics);
  const startedAt = useGeneration((s) => s.startedAt);
  const runningSince = useGeneration((s) => s.runningSince);
  const submitting = useGeneration((s) => s.submitting);

  const stream = useJobStream(handle);

  // A ticking `now` is what drives both the elapsed clock and the lyrics →
  // composing handover, so one interval serves both.
  const [now, setNow] = useState(() => Date.now());
  const active = startedAt !== null;
  // Nothing is still running once the stream is terminal, so neither the clock
  // nor the re-render it forces should keep implying it is.
  const ticking =
    active && stream.phase !== "completed" && stream.phase !== "failed" && stream.phase !== "lost";

  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ticking]);

  useEffect(() => {
    publish(stream);
  }, [stream, publish]);

  // Completion navigates and then retracts. `navRef` keeps a re-render from
  // firing the same navigation twice.
  const navigatedFor = useRef<string | null>(null);
  useEffect(() => {
    if (stream.phase !== "completed") return;
    if (stream.trackId && navigatedFor.current !== stream.jobId) {
      navigatedFor.current = stream.jobId;
      nav(`/track/${stream.trackId}`);
    }
    const id = setTimeout(reset, READY_LINGER_MS);
    return () => clearTimeout(id);
  }, [stream.phase, stream.trackId, stream.jobId, nav, reset]);

  const rendered = jobLabel({
    phase: submitting ? "idle" : stream.phase,
    estimatedStartSeconds: stream.estimatedStartSeconds,
    writesLyrics,
    runningSeconds: runningSince === null ? 0 : Math.floor((now - runningSince) / 1000),
  });

  const show = active && !dismissed && rendered !== null;

  // Separate from `phase` on purpose: a reconnect is not a failing generation,
  // so it gets a quiet marker NEXT TO the status, never instead of it.
  const reconnecting = stream.connection === "retrying" || stream.connection === "polling";

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      // The wrapper must never eat a click: that is the entire difference
      // between this and the modal it replaced.
      className="pointer-events-none fixed inset-x-0 top-0 z-[60] flex justify-center px-4 pt-[calc(env(safe-area-inset-top)+10px)]"
    >
      <AnimatePresence>
        {show && rendered && (
          // BorderGlow sits OUTSIDE the pill's own `overflow-hidden`, on purpose:
          // that's what lets its ring bleed past the pill's rounded edge instead
          // of being clipped by it. It's always lit — not tied to `rendered.tone` —
          // so the pill reads as "on" through every phase, amber underneath it.
          <BorderGlow glowColor={PILL_GLOW_COLOR} className="pointer-events-auto">
            <motion.div
              layout
              initial={{ y: "-160%", opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: "-160%", opacity: 0 }}
              transition={{ type: "spring", stiffness: 380, damping: 32, mass: 0.7 }}
              role="status"
              aria-live="polite"
              className="relative isolate flex max-w-[min(92vw,380px)] items-center gap-3 overflow-hidden rounded-full py-3 pl-5 pr-4"
            >
              {/* Layer 1 — the glass background. `.lg-regular` is the house tier
                  for buttons, pills and popovers; only the radius is overridden,
                  the same way ModeToggle does it. */}
              <div className="lg-regular absolute inset-0 -z-10 !rounded-full" aria-hidden="true" />

              {/* Layer 2 — the status itself. */}
              <span
                aria-hidden="true"
                className={`h-2.5 w-2.5 flex-shrink-0 rounded-full ${TONE_DOT[rendered.tone]} ${
                  rendered.terminal ? "" : "motion-safe:animate-pulse"
                }`}
              />

              <span className="min-w-0 flex-1 truncate text-[15px] font-semibold leading-none text-ink">
                {rendered.label}
              </span>

              {!rendered.terminal && startedAt !== null && (
                <span className="flex flex-shrink-0 items-center gap-1.5 font-mono text-xs tabular-nums text-ink-faint">
                  {reconnecting && (
                    <span
                      aria-label="Reconnecting"
                      className="h-2 w-2 rounded-full bg-amber motion-safe:animate-pulse"
                    />
                  )}
                  {fmtElapsed(Math.max(0, Math.floor((now - startedAt) / 1000)))}
                </span>
              )}

              {rendered.terminal && rendered.tone !== "signal" && (
                <button
                  type="button"
                  onClick={dismiss}
                  aria-label="Dismiss"
                  className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-ink-faint transition-colors hover:bg-white/[0.08] hover:text-ink"
                >
                  <X className="h-4 w-4" strokeWidth={2} />
                </button>
              )}
            </motion.div>
          </BorderGlow>
        )}
      </AnimatePresence>
    </div>,
    document.body,
  );
}
