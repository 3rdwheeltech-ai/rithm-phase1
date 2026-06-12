import { useEffect, useState } from "react";
import { useGeneration } from "../store/generation";

const fmtElapsed = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;

/** Staged status copy keyed off elapsed time (the API gives no real progress %). */
function stage(elapsed: number): string {
  if (elapsed < 8) return "Drafting lyrics…";
  if (elapsed < 22) return "Composing the arrangement…";
  return "Rendering audio…";
}

/**
 * Full-screen "composing" state shown while a generation is in flight. A breathing
 * ai-frame glass card with staged copy + an elapsed timer and an indeterminate
 * sweep — honest about the synchronous wait without faking a percentage.
 */
export default function GeneratingOverlay() {
  const generating = useGeneration((s) => s.status === "generating");
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!generating) return;
    setElapsed(0);
    const id = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(id);
  }, [generating]);

  if (!generating) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-md animate-fade-in">
      <div className="ai-frame w-full max-w-[380px]">
        <div className="quick-surface px-7 py-8 text-center">
          {/* Pulsing dots */}
          <div className="mb-5 flex items-center justify-center gap-2" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="h-2.5 w-2.5 rounded-full bg-brand-soft motion-safe:animate-pulse"
                style={{ animationDelay: `${i * 200}ms` }}
              />
            ))}
          </div>

          <p className="text-[16px] font-semibold tracking-[-0.01em] text-ink">
            Composing your track
          </p>
          <p className="mt-1 text-[13px] text-ink-muted" aria-live="polite">
            {stage(elapsed)}
          </p>

          {/* Indeterminate sweep */}
          <div className="relative mt-5 h-1 w-full overflow-hidden rounded-full bg-white/10">
            <div className="progress-sweep absolute inset-y-0 left-0 rounded-full" />
          </div>

          <p className="mt-3 text-[11.5px] tabular-nums text-ink-faint">
            {fmtElapsed(elapsed)} elapsed · usually 30–120s
          </p>
        </div>
      </div>
    </div>
  );
}
