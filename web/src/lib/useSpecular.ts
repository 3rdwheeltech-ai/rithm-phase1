import { useCallback, useEffect, useRef } from "react";

/** Where the highlight sits when there is no pointer to track. */
const REST_X = "50%";
const REST_Y = "-10%";

/**
 * Track the pointer across a glass surface so its rim highlight moves with it.
 *
 * Real glass has a specular hotspot that shifts as you move relative to the
 * light. A static hairline is the tell that separates a CSS card from a
 * material, and this is the cheapest honest way to fix it: two custom
 * properties, written on an animation frame, read by the rim gradient in
 * `index.css`.
 *
 * Inert on touch — there is no pointer to follow, so the highlight stays at its
 * resting position rather than jumping to wherever the last tap landed.
 */
export function useSpecular<T extends HTMLElement>() {
  const nodeRef = useRef<T | null>(null);
  const frameRef = useRef<number | null>(null);
  const pendingRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const node = nodeRef.current;
    if (!node) return;

    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;

    function flush() {
      frameRef.current = null;
      const point = pendingRef.current;
      const el = nodeRef.current;
      if (!point || !el) return;
      el.style.setProperty("--sx", `${point.x.toFixed(1)}%`);
      el.style.setProperty("--sy", `${point.y.toFixed(1)}%`);
    }

    function onMove(event: PointerEvent) {
      const el = nodeRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      pendingRef.current = {
        x: ((event.clientX - rect.left) / rect.width) * 100,
        y: ((event.clientY - rect.top) / rect.height) * 100,
      };
      if (frameRef.current === null) frameRef.current = requestAnimationFrame(flush);
    }

    function onLeave() {
      const el = nodeRef.current;
      if (!el) return;
      pendingRef.current = null;
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      el.style.setProperty("--sx", REST_X);
      el.style.setProperty("--sy", REST_Y);
    }

    node.addEventListener("pointermove", onMove);
    node.addEventListener("pointerleave", onLeave);
    return () => {
      node.removeEventListener("pointermove", onMove);
      node.removeEventListener("pointerleave", onLeave);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, []);

  return useCallback((node: T | null) => {
    nodeRef.current = node;
  }, []);
}

/** Attach several refs to one element — e.g. a lens ref and a specular ref. */
export function mergeRefs<T>(...refs: Array<React.Ref<T> | undefined>) {
  return (node: T | null) => {
    for (const ref of refs) {
      if (typeof ref === "function") ref(node);
      else if (ref && typeof ref === "object") (ref as React.MutableRefObject<T | null>).current = node;
    }
  };
}
