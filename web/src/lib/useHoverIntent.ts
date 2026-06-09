import { useEffect, useRef, useState } from "react";

/**
 * Hover-with-intent: expands after a short delay on enter (avoids accidental
 * expansion when the cursor merely passes by), collapses immediately on leave.
 * Returns the state plus spreadable mouse handlers.
 */
export function useHoverIntent(delay = 140) {
  const [hovered, setHovered] = useState(false);
  const timer = useRef<number>();

  function onMouseEnter() {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setHovered(true), delay);
  }

  function onMouseLeave() {
    window.clearTimeout(timer.current);
    setHovered(false);
  }

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return { hovered, onMouseEnter, onMouseLeave };
}
