import { useSyncExternalStore } from "react";

/**
 * Subscribe to a media query.
 *
 * `useSyncExternalStore` rather than `useState` + effect: the first render reads
 * the true value instead of flashing the wrong layout for a frame, which matters
 * here because the answer decides whether the app renders a sidebar or a tab bar.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    // No SSR in this app, but a sensible answer beats a crash if that changes.
    () => false,
  );
}

/** The breakpoint where the desktop shell takes over. Matches Tailwind's `lg`. */
export const DESKTOP_QUERY = "(min-width: 1024px)";

/** True where a real cursor exists — hover affordances are dead weight without one. */
export const FINE_POINTER_QUERY = "(hover: hover) and (pointer: fine)";
