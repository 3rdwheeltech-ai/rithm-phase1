import { useEffect } from "react";
import { lensingSupported } from "../lib/useLens";

/**
 * Host for every Liquid Glass lens filter on the page.
 *
 * `useLens` appends its `<filter>` into this one `<defs>` rather than each
 * surface rendering its own `<svg>`: filter definitions are global to the
 * document, so there is no reason to pay for a wrapper element per instance.
 *
 * Mount this once, high in the tree. It renders nothing visible.
 *
 * Also stamps `lens-ok` on `<html>` so the stylesheet can opt surfaces into the
 * refracting recipe only where the browser can actually run it.
 */
export default function GlassFilters() {
  useEffect(() => {
    if (lensingSupported()) document.documentElement.classList.add("lens-ok");
    return () => document.documentElement.classList.remove("lens-ok");
  }, []);

  return (
    <svg
      id="lg-filter-defs"
      aria-hidden="true"
      focusable="false"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: 0,
        height: 0,
        pointerEvents: "none",
        opacity: 0,
      }}
    >
      <defs />
    </svg>
  );
}
