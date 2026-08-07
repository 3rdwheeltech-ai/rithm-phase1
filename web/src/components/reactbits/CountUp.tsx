import { useEffect, useRef, useState } from "react";

/**
 * Count a number up to its value on mount.
 *
 * Adapted from React Bits' `CountUp` (MIT) — https://reactbits.dev — rewritten
 * against `requestAnimationFrame` so it costs no animation dependency.
 *
 * Honours `prefers-reduced-motion` by rendering the final value immediately.
 */
export default function CountUp({
  to,
  duration = 900,
  className,
}: {
  to: number;
  duration?: number;
  className?: string;
}) {
  const [value, setValue] = useState(to);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setValue(to);
      return;
    }

    const start = performance.now();
    const from = 0;

    function tick(now: number) {
      const t = Math.min(1, (now - start) / duration);
      // Ease-out cubic: fast off the mark, settles gently on the number.
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(Math.round(from + (to - from) * eased));
      if (t < 1) frameRef.current = requestAnimationFrame(tick);
    }

    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [to, duration]);

  return <span className={className}>{value}</span>;
}
