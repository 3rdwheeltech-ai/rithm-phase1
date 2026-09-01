import type { CSSProperties, ReactNode } from "react";

/**
 * A soft, layered glow that hugs whatever it wraps.
 *
 * Ported from React Bits' `BorderGlow` (MIT).
 * https://github.com/DavidHDev/react-bits
 *
 * ADAPTED: upstream tracks the cursor and only lights the arc of the border
 * nearest it, then wraps `children` in its own background/border/flex-col
 * div. GenerationPill already owns its background, radius and clipping and
 * needs the ring lit on every side at once, not following a pointer — so
 * this fork drops the pointer tracking, the mesh-gradient border/fill
 * layers, and the wrapper's own chrome, keeping only the multi-layer
 * `boxShadow` glow itself, permanently at full opacity, on a bare wrapper
 * that renders `children` untouched. It also drops upstream's `inset`
 * shadow layers: those were meant to backlight an opaque card's interior,
 * but GenerationPill's glass background is translucent, so an inset glow
 * shows straight through as a wash across the pill instead of staying on
 * the border. Outward-only keeps the glow strictly outside the edge.
 */

interface BorderGlowProps {
  children: ReactNode;
  className?: string;
  /** "H S% L%", e.g. "40 45% 95%" for a warm off-white. */
  glowColor?: string;
  glowIntensity?: number;
  borderRadius?: number | string;
}

function parseHSL(hslStr: string): { h: number; s: number; l: number } {
  const match = hslStr.match(/([\d.]+)\s*([\d.]+)%?\s*([\d.]+)%?/);
  if (!match) return { h: 40, s: 80, l: 80 };
  return { h: parseFloat(match[1]), s: parseFloat(match[2]), l: parseFloat(match[3]) };
}

function buildBoxShadow(glowColor: string, intensity: number): string {
  const { h, s, l } = parseHSL(glowColor);
  const base = `${h}deg ${s}% ${l}%`;
  const layers: [number, number, number, number][] = [
    [0, 0, 0, 1], [0, 0, 1, 0], [0, 0, 3, 0], [0, 0, 6, 0],
    [0, 0, 15, 0], [0, 0, 25, 2], [0, 0, 50, 2],
  ];
  const alphas = [100, 60, 50, 40, 30, 20, 10];
  return layers
    .map(([x, y, blur, spread], i) => {
      const a = Math.min(alphas[i] * intensity, 100);
      return `${x}px ${y}px ${blur}px ${spread}px hsl(${base} / ${a}%)`;
    })
    .join(", ");
}

export default function BorderGlow({
  children,
  className = "",
  glowColor = "40 45% 95%",
  glowIntensity = 1,
  borderRadius = "9999px",
}: BorderGlowProps) {
  const radius = typeof borderRadius === "number" ? `${borderRadius}px` : borderRadius;
  return (
    <div className={`relative isolate ${className}`} style={{ borderRadius: radius }}>
      {/* The glow is its own layer, not a style on the wrapper — a
          `mix-blend-mode` on the wrapper itself would blend the pill's own
          content against the page, not just this ring. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-[inherit] mix-blend-plus-lighter"
        style={{ boxShadow: buildBoxShadow(glowColor, glowIntensity) } as CSSProperties}
      />
      {children}
    </div>
  );
}
