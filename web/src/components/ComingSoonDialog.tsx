import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Sparkles, X } from "lucide-react";

/**
 * "That one isn't built yet."
 *
 * Discover and AI Tools render a product that mostly does not exist. Rather than
 * disable every control — which reads as broken, not as forthcoming — every
 * control works and lands here, naming the feature it would have run.
 *
 * NOT the same thing as `create/ComingSoon.tsx`, which is a hover tooltip
 * wrapping a genuinely disabled form control. This is a modal for a control that
 * responds. Keep them apart.
 *
 * Portalled for the same reason `<GenerationPill>` is: `fixed` is only
 * viewport-relative when no ancestor establishes a containing block, and these
 * pages are full of `backdrop-filter` and retained transforms.
 */
export default function ComingSoonDialog({
  feature,
  onClose,
}: {
  /** The feature's name, or null when nothing is open. */
  feature: string | null;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  // Whatever had focus when this opened, so it can be handed back on close.
  const returnRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (feature === null) return;

    returnRef.current = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      // Returning focus to the card that opened this is the difference between
      // a dialog and a flash of markup, for anyone not using a mouse.
      returnRef.current?.focus();
    };
  }, [feature, onClose]);

  if (feature === null) return null;
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${feature} — coming soon`}
      className="fixed inset-0 z-[70] flex h-dvh items-center justify-center bg-black/55 px-5 backdrop-blur-md animate-fade-in"
    >
      {/* Click-away as a real button rather than a handler on the scrim: it
          gets keyboard and screen-reader behaviour for free. */}
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default"
      />

      <div className="ai-frame relative w-full max-w-[380px]">
        <div className="quick-surface relative px-6 py-8 text-center sm:px-7">
          <button
            type="button"
            onClick={onClose}
            aria-label="Dismiss"
            className="absolute right-3 top-3 rounded-full p-1.5 text-ink-faint transition-colors hover:bg-white/10 hover:text-ink"
          >
            <X className="h-4 w-4" strokeWidth={2} />
          </button>

          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full border border-signal/25 bg-signal/15 text-signal-bright">
            <Sparkles className="h-5 w-5" strokeWidth={1.75} />
          </div>

          <p className="text-md font-semibold text-ink">{feature}</p>
          <p className="mx-auto mt-1.5 max-w-[280px] text-sm leading-relaxed text-ink-muted">
            This one is still in the workshop. Everything you see here is a
            preview of where RITHM is heading.
          </p>

          <button ref={closeRef} type="button" onClick={onClose} className="btn-primary mt-6">
            Got it
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
