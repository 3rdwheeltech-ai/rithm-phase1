import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

/**
 * jsdom ships no media-query engine, and the app reads one to decide between the
 * desktop shell and the mobile one. Report "no match" for everything: that is
 * the coarse-pointer, narrow-viewport answer, so components under test render
 * their mobile branch unless a test says otherwise.
 */
if (!window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

/**
 * jsdom implements no PointerEvent, so Testing Library falls back to a plain
 * Event and SILENTLY DROPS clientX/clientY — a drag test then reads NaN and
 * looks like a broken component rather than a missing API. MouseEvent already
 * carries the coordinate and button plumbing, so subclassing it is enough for
 * anything that scrubs, drags or captures a pointer.
 */
if (!("PointerEvent" in window)) {
  class PointerEventPolyfill extends MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;
    readonly isPrimary: boolean;

    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params);
      this.pointerId = params.pointerId ?? 0;
      this.pointerType = params.pointerType ?? "mouse";
      this.isPrimary = params.isPrimary ?? true;
    }
  }
  // `in` narrows window to never here — the DOM lib insists PointerEvent
  // always exists, which is exactly the assumption jsdom breaks.
  (globalThis as unknown as Record<string, unknown>).PointerEvent = PointerEventPolyfill;

  // Capture is a no-op without a real pointer, but it must not throw: the
  // scrub handler calls it on every pointerdown.
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.hasPointerCapture ??= () => false;
}

afterEach(() => {
  cleanup();
});
