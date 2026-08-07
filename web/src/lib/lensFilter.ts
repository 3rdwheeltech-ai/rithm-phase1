/**
 * Liquid Glass lensing.
 *
 * Apple's material does not just blur what is behind it — it *refracts* it,
 * bending the backdrop at the rim the way a real lens would. CSS has no
 * primitive for that, so we build an SVG displacement map sized to the element
 * and hand it to `backdrop-filter` as a filter reference.
 *
 * The map encodes displacement in colour channels: `feDisplacementMap` reads one
 * channel for the x offset and another for the y offset, treating mid-grey as
 * "no displacement". A dark rim therefore pulls the backdrop outward, and the
 * flat grey interior leaves it alone — which is exactly the profile of a lens.
 *
 * Technique adapted from React Bits' `GlassSurface` (MIT).
 * https://github.com/DavidHDev/react-bits
 */

export interface LensOptions {
  /** Corner radius in px. Should match the element's own radius. */
  radius: number;
  /**
   * Width of the refracting rim, as a fraction of the element's short edge.
   * Small controls need a proportionally wider rim than large panels or the
   * effect disappears.
   */
  edge: number;
  /**
   * Displacement strength. Negative values pull the backdrop inward, which is
   * the direction that reads as a convex lens.
   */
  strength: number;
  /** Softness of the rim ramp, in px. Higher is a rounder, gentler lens. */
  softness: number;
  /**
   * Extra displacement per channel, in px: red gets `strength`, green
   * `strength + spread`, blue `strength + 2 × spread`. That difference IS the
   * chromatic aberration, and it is the single easiest thing to overdo — past
   * about 6px the rim stops reading as glass and starts reading as a broken
   * video codec. Kept deliberately small.
   */
  spread: number;
  /**
   * Gaussian blur applied to the recombined result, in px. A fraction of a
   * pixel is enough to stop the three channels banding against each other at
   * the rim; a whole pixel throws away the refraction that produced them.
   */
  displace: number;
}

/** Tuned per size bucket — a 40px pill and a 900px sidebar need different rims. */
export const LENS_PRESETS = {
  sm: { edge: 0.42, strength: -92, softness: 5, spread: 2, displace: 0.4 },
  md: { edge: 0.14, strength: -140, softness: 9, spread: 3, displace: 0.5 },
  lg: { edge: 0.07, strength: -170, softness: 13, spread: 4, displace: 0.6 },
} as const satisfies Record<string, Omit<LensOptions, "radius">>;

export type LensPreset = keyof typeof LENS_PRESETS;

/**
 * Build the displacement map for an element of this size, as a data URI.
 *
 * Red varies across x and blue across y; the two are combined with a `difference`
 * blend so each keeps its own channel. The blurred interior rect floods the
 * middle with mid-grey so only the rim displaces.
 */
export function buildDisplacementMap(width: number, height: number, opts: LensOptions): string {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const inset = Math.min(w, h) * opts.edge * 0.5;
  const r = Math.min(opts.radius, Math.min(w, h) / 2);

  const svg = `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">\
<defs>\
<linearGradient id="x" x1="100%" y1="0%" x2="0%" y2="0%">\
<stop offset="0%" stop-color="#0000"/><stop offset="100%" stop-color="red"/>\
</linearGradient>\
<linearGradient id="y" x1="0%" y1="0%" x2="0%" y2="100%">\
<stop offset="0%" stop-color="#0000"/><stop offset="100%" stop-color="blue"/>\
</linearGradient>\
</defs>\
<rect width="${w}" height="${h}" fill="black"/>\
<rect width="${w}" height="${h}" rx="${r}" fill="url(#x)"/>\
<rect width="${w}" height="${h}" rx="${r}" fill="url(#y)" style="mix-blend-mode:difference"/>\
<rect x="${inset}" y="${inset}" width="${Math.max(0, w - inset * 2)}" height="${Math.max(
    0,
    h - inset * 2,
  )}" rx="${Math.max(0, r - inset)}" fill="hsl(0 0% 50% / 0.93)" style="filter:blur(${
    opts.softness
  }px)"/>\
</svg>`;

  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * Whether this browser can reference an SVG filter from `backdrop-filter`.
 *
 * Chromium can. Safari and Firefox parse `backdrop-filter` but drop the whole
 * declaration when it contains a `url()`, so the property test alone is not
 * enough — WebKit reports support and then renders nothing. Both are excluded by
 * engine before the property test runs.
 */
export function supportsBackdropLensing(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;

  const ua = navigator.userAgent;
  const isWebKit = /Safari/.test(ua) && !/Chrome|Chromium|Edg/.test(ua);
  const isFirefox = /Firefox/.test(ua);
  if (isWebKit || isFirefox) return false;

  const probe = document.createElement("div");
  probe.style.backdropFilter = "url(#lens-probe)";
  return probe.style.backdropFilter !== "";
}
