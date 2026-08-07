import { useEffect, useRef, useState } from "react";
import { FINE_POINTER_QUERY, useMediaQuery } from "./useMediaQuery";

/**
 * Hover-with-intent: expands after a short delay on enter (avoids accidental
 * expansion when the cursor merely passes by), collapses immediately on leave.
 * Returns the state plus spreadable mouse handlers.
 *
 * Inert without a real cursor. On a touch screen `mouseenter` fires from a tap
 * and then never fires its matching leave, so a hover-expanding rail would latch
 * open and stay there — the affordance has to be a click instead.
 */
export function useHoverIntent(delay = 140) {
  const [hovered, setHovered] = useState(false);
  const timer = useRef<number>();
  const finePointer = useMediaQuery(FINE_POINTER_QUERY);

  function onMouseEnter() {
    if (!finePointer) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setHovered(true), delay);
  }

  function onMouseLeave() {
    window.clearTimeout(timer.current);
    setHovered(false);
  }

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return { hovered: finePointer && hovered, onMouseEnter, onMouseLeave };
}
