import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export const COMING_SOON = "Coming soon";
export const COMING_SOON_DETAIL = "Coming soon — the model has no field for this yet";

/**
 * Wraps a control that is deliberately inert and explains why on hover.
 *
 * The wrapper exists because a `title` attribute does NOT work here: a
 * `disabled` form control suppresses pointer events in every major browser, so
 * the native tooltip never fires and the control just looks broken. The
 * explanation has to come from an enabled ancestor, which is this.
 *
 * Nothing inside is focusable (that is the point), so the hover tooltip is
 * deliberately mouse-only and carries no information of its own — the visible
 * <ComingSoonTag> beside the label already states the status without any
 * interaction, and `role="note"` + `aria-label` carry it to assistive tech.
 */
export default function ComingSoon({
  children,
  className,
  label = COMING_SOON_DETAIL,
}: {
  children: ReactNode;
  className?: string;
  /** Overrides the explanation for controls that need a specific reason. */
  label?: string;
}) {
  return (
    <span
      className={cn("group/soon relative block", className)}
      role="note"
      aria-label={label}
    >
      {children}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute -top-1 left-1/2 z-30 w-max max-w-[220px] -translate-x-1/2 -translate-y-full rounded-control border border-white/10 bg-black/90 px-2.5 py-1.5 text-2xs font-medium leading-snug text-ink opacity-0 shadow-lg backdrop-blur-sm transition-opacity duration-150 group-hover/soon:opacity-100"
      >
        {label}
      </span>
    </span>
  );
}

/**
 * The inline "Coming soon" chip that sits next to a disabled control's label,
 * so the state is legible without hovering anything.
 */
export function ComingSoonTag({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "rounded-full border border-amber/25 bg-amber/10 px-1.5 py-0.5 text-2xs font-medium uppercase tracking-wide text-amber",
        className,
      )}
    >
      {COMING_SOON}
    </span>
  );
}
