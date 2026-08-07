import { useCallback, useEffect, useId, useRef } from "react";
import {
  buildDisplacementMap,
  LENS_PRESETS,
  supportsBackdropLensing,
  type LensPreset,
} from "./lensFilter";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Probed once per page load — the answer cannot change. */
let supported: boolean | null = null;
export function lensingSupported(): boolean {
  if (supported === null) supported = supportsBackdropLensing();
  return supported;
}

/** The single `<defs>` every lens filter lives in, owned by `<GlassFilters/>`. */
function defsNode(): SVGDefsElement | null {
  return document.querySelector<SVGDefsElement>("#lg-filter-defs defs");
}

function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

const CHANNEL_MATRIX = {
  R: "1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0",
  G: "0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0",
  B: "0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0",
} as const;

/**
 * Give an element a real refracting rim.
 *
 * Returns a ref to attach to the surface. The hook owns one `<filter>` inside
 * the app-wide `<GlassFilters/>` defs, keeps its displacement map sized to the
 * element, and points the element's `--lens` custom property at it.
 *
 * Does nothing where `backdrop-filter: url()` is unsupported (Safari, Firefox) —
 * the element keeps its blur-and-specular treatment and still looks finished.
 * Use it sparingly: this is chrome-only decoration and each instance costs a
 * full-buffer filter pass on every composite.
 *
 * Chromatic aberration is deliberate. The three channels are displaced at
 * slightly different strengths and recombined, which is what stops the rim
 * reading as a plain smear.
 */
export function useLens<T extends HTMLElement>(preset: LensPreset, radius: number) {
  const reactId = useId().replace(/:/g, "");
  const filterId = `lg-lens-${reactId}`;

  const nodeRef = useRef<T | null>(null);
  const feImageRef = useRef<SVGElement | null>(null);
  const filterRef = useRef<SVGElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const radiusRef = useRef(radius);
  radiusRef.current = radius;

  const redraw = useCallback(() => {
    const node = nodeRef.current;
    const feImage = feImageRef.current;
    if (!node || !feImage) return;

    const { width, height } = node.getBoundingClientRect();
    if (width < 1 || height < 1) return;

    const href = buildDisplacementMap(width, height, {
      radius: radiusRef.current,
      ...LENS_PRESETS[preset],
    });
    feImage.setAttribute("href", href);
  }, [preset]);

  const schedule = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      redraw();
    });
  }, [redraw]);

  useEffect(() => {
    const node = nodeRef.current;
    if (!node || !lensingSupported()) return;

    const defs = defsNode();
    if (!defs) return;

    const { strength, spread, displace } = LENS_PRESETS[preset];
    const filter = el("filter", {
      id: filterId,
      "color-interpolation-filters": "sRGB",
      x: "0%",
      y: "0%",
      width: "100%",
      height: "100%",
    });

    const feImage = el("feImage", {
      x: "0",
      y: "0",
      width: "100%",
      height: "100%",
      preserveAspectRatio: "none",
      result: "map",
    });
    filter.appendChild(feImage);

    // One displacement pass per channel, each a touch stronger than the last.
    (["R", "G", "B"] as const).forEach((channel, i) => {
      filter.appendChild(
        el("feDisplacementMap", {
          in: "SourceGraphic",
          in2: "map",
          scale: String(strength + i * spread),
          xChannelSelector: "R",
          yChannelSelector: "G",
          result: `disp${channel}`,
        }),
      );
      filter.appendChild(
        el("feColorMatrix", {
          in: `disp${channel}`,
          type: "matrix",
          values: CHANNEL_MATRIX[channel],
          result: channel,
        }),
      );
    });

    filter.appendChild(el("feBlend", { in: "R", in2: "G", mode: "screen", result: "rg" }));
    filter.appendChild(el("feBlend", { in: "rg", in2: "B", mode: "screen", result: "rgb" }));
    // Sub-pixel, and the last thing in the graph: it softens the seam where the
    // three channels land slightly apart without undoing the displacement.
    filter.appendChild(el("feGaussianBlur", { in: "rgb", stdDeviation: String(displace) }));

    defs.appendChild(filter);
    filterRef.current = filter;
    feImageRef.current = feImage;

    node.style.setProperty("--lens", `url(#${filterId})`);
    node.setAttribute("data-lens", "");
    redraw();

    const observer = new ResizeObserver(schedule);
    observer.observe(node);

    return () => {
      observer.disconnect();
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      filterRef.current?.remove();
      filterRef.current = null;
      feImageRef.current = null;
      node.removeAttribute("data-lens");
      node.style.removeProperty("--lens");
    };
  }, [filterId, preset, redraw, schedule]);

  return useCallback((node: T | null) => {
    nodeRef.current = node;
  }, []);
}
