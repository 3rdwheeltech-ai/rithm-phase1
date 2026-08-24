import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useJobStream } from "../hooks/useJobStream";
import { fmtElapsed, jobLabel, type PillTone } from "../lib/jobLabel";
import { useGeneration } from "../store/generation";

// Static-imported, this would drag `ogl` into the entry chunk — GenerationPill
// is mounted from App.tsx, so it is in that chunk — undoing the deliberate
// lazy-load in SpecularButton. The aurora is decoration; it can arrive late.
const SoftAurora = lazy(() => import("./SoftAurora/SoftAurora"));

/** Held for this long on `completed` before the pill retracts. */
const READY_LINGER_MS = 2_000;

const TONE_DOT: Record<PillTone, string> = {
  signal: "bg-signal-bright",
  amber: "bg-amber",
  danger: "bg-danger",
};

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
          <motion.div
            layout
            initial={{ y: "-160%", opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: "-160%", opacity: 0 }}
            transition={{ type: "spring", stiffness: 380, damping: 32, mass: 0.7 }}
            role="status"
            aria-live="polite"
            className="pointer-events-auto relative isolate flex max-w-[min(92vw,360px)] items-center gap-2.5 overflow-hidden rounded-full py-2 pl-3.5 pr-3"
          >
            {/* Layer 1 — the aurora, clipped to the pill by `overflow-hidden`.
                Its props are FROZEN for the pill's lifetime: every one of them
                is in the component's effect deps, so changing one per phase
                would rebuild the WebGL context mid-generation. */}
            <div className="absolute inset-0 -z-10 opacity-60" aria-hidden="true">
              <Suspense fallback={null}>
                <SoftAurora
                  speed={0.9}
                  scale={1.1}
                  brightness={0.55}
                  color1="#7DF3E2"
                  color2="#34E3C8"
                  bandHeight={0.5}
                  bandSpread={1.2}
                  colorSpeed={0.6}
                  enableMouseInteraction={false}
                />
              </Suspense>
            </div>

            {/* Layer 2 — the glass over it. `.lg-regular` is the house tier for
                buttons, pills and popovers; only the radius is overridden, the
                same way ModeToggle does it. */}
            <div className="lg-regular absolute inset-0 -z-10 !rounded-full" aria-hidden="true" />

            {/* Layer 3 — the status itself. */}
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${TONE_DOT[rendered.tone]} ${
                rendered.terminal ? "" : "motion-safe:animate-pulse"
              }`}
            />

            <span className="min-w-0 flex-1 truncate text-sm font-medium leading-none text-ink">
              {rendered.label}
            </span>

            {!rendered.terminal && startedAt !== null && (
              <span className="flex flex-shrink-0 items-center gap-1.5 font-mono text-2xs tabular-nums text-ink-faint">
                {reconnecting && (
                  <span
                    aria-label="Reconnecting"
                    className="h-1.5 w-1.5 rounded-full bg-amber motion-safe:animate-pulse"
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
                className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-ink-faint transition-colors hover:bg-white/[0.08] hover:text-ink"
              >
                <X className="h-3.5 w-3.5" strokeWidth={2} />
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>,
    document.body,
  );
}
