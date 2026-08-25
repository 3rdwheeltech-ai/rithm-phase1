import { useEffect, useState } from "react";

/**
 * Whether the viewer has asked for reduced motion.
 *
 * The CSS side of this is handled by `@media (prefers-reduced-motion:
 * no-preference)` blocks in index.css — every keyframe animation is inside
 * one. This hook is for the cases CSS cannot reach: a Lottie that has to be
 * told to stop, and a progressive text reveal that has to render its whole
 * string at once rather than animate to it.
 *
 * Subscribes to changes rather than reading once. Someone toggling the OS
 * setting with the app open is rare, but a component that only ever read the
 * value at mount is also a component that reads `false` in any environment
 * whose matchMedia is a stub — and honouring the preference late is better
 * than never.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReduced(query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);

  return reduced;
}
