import { cn } from "../../lib/cn";

/**
 * A progressive blur that ramps from clear to fully blurred across its height.
 *
 * Content sliding out of a scroll region should dissolve under the chrome rather
 * than being cut off at a hard line — it is one of the quieter things that makes
 * Apple's surfaces read as layers of glass instead of stacked rectangles.
 *
 * Adapted from React Bits' `GradualBlur` (MIT) — https://reactbits.dev — rebuilt
 * as stacked masked layers so it needs no maths dependency. Each layer blurs
 * harder than the last and is masked to its own band, which is what produces the
 * ramp; a single blurred element would give a uniform wash.
 *
 * Keep instances rare. Every layer is a separate `backdrop-filter` pass.
 */
export default function GradualBlur({
  height = 64,
  side = "top",
  className,
}: {
  /** Height of the ramp — a px number, or any CSS length. */
  height?: number | string;
  side?: "top" | "bottom";
  className?: string;
}) {
  const layers = [1, 2, 4, 8];

  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-x-0 z-10",
        side === "top" ? "top-0" : "bottom-0",
        className,
      )}
      style={{ height }}
    >
      {layers.map((blur, i) => {
        const from = (i / layers.length) * 100;
        const to = ((i + 1) / layers.length) * 100;
        // Each band is opaque over its own slice and transparent elsewhere, so
        // the layers tile the ramp instead of compounding across the whole box.
        const stops =
          side === "top"
            ? `rgba(0,0,0,1) ${100 - to}%, rgba(0,0,0,1) ${100 - from}%, rgba(0,0,0,0) ${100 - from}%`
            : `rgba(0,0,0,0) ${from}%, rgba(0,0,0,1) ${from}%, rgba(0,0,0,1) ${to}%`;
        const mask = `linear-gradient(to bottom, ${
          side === "top" ? `rgba(0,0,0,1) 0%, ${stops}` : `${stops}, rgba(0,0,0,1) 100%`
        })`;

        return (
          <div
            key={blur}
            className="absolute inset-0"
            style={{
              backdropFilter: `blur(${blur}px)`,
              WebkitBackdropFilter: `blur(${blur}px)`,
              maskImage: mask,
              WebkitMaskImage: mask,
            }}
          />
        );
      })}
    </div>
  );
}
