import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Sidebar from "./Sidebar";
import { useChrome } from "../store/chrome";
import { renderWithProviders } from "../test-utils";

/**
 * The pin, and only the pin.
 *
 * `matchMedia` answers "no match" to everything in setupTests, which makes
 * `useHoverIntent` inert — it is fine-pointer gated. That is exactly the
 * condition these want: nothing but the pin can open the rail here, so a class
 * assertion cannot be an accident of a stray hover.
 */
function rail(container: HTMLElement): HTMLElement {
  const el = container.querySelector("aside");
  if (!el) throw new Error("the sidebar is not on the page");
  return el;
}

function render() {
  return renderWithProviders(
    <Sidebar name="Tri" email="tri@example.com" onSignOut={vi.fn()} />,
  );
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  useChrome.setState({ navPinned: false, playerPinned: false });
});

afterEach(() => {
  vi.unstubAllGlobals();
  useChrome.setState({ navPinned: false, playerPinned: false });
});

describe("Sidebar", () => {
  it("holds the rail open once pinned, with the pointer nowhere near it", async () => {
    const user = userEvent.setup();
    const { container } = render();

    expect(rail(container).className).toContain("lg:w-[64px]");

    await user.click(screen.getByRole("button", { name: "Pin menu" }));

    expect(useChrome.getState().navPinned).toBe(true);
    expect(rail(container).className).toContain("lg:w-[228px]");
  });

  it("is the rail's first tab stop, and reaching it opens the rail", async () => {
    const user = userEvent.setup();
    const { container } = render();

    await user.tab();

    // Faded but never skipped: it sits before the nav in the DOM, so taking it
    // out of the tab order would leave it reachable only by shift-tabbing back
    // out of Home. Landing on it sets `focusWithin`, which reveals it — it is
    // never focused and invisible at the same time.
    expect(screen.getByRole("button", { name: "Pin menu" })).toHaveFocus();
    expect(rail(container).className).toContain("lg:w-[228px]");
  });

  it("unpins from the same control, which names the state it will leave", async () => {
    const user = userEvent.setup();
    useChrome.setState({ navPinned: true });
    const { container } = render();

    const pin = screen.getByRole("button", { name: "Unpin menu" });
    expect(pin).toHaveAttribute("aria-pressed", "true");

    await user.click(pin);

    expect(useChrome.getState().navPinned).toBe(false);
    // Still open, because clicking focused it and `focusWithin` holds the rail
    // out — unpinning gives the rail back to hover, it does not slam it shut
    // under the pointer that just pressed the button.
    expect(rail(container).className).toContain("lg:w-[228px]");
    expect(screen.getByRole("button", { name: "Pin menu" })).toBeInTheDocument();

    await user.click(document.body);

    expect(rail(container).className).toContain("lg:w-[64px]");
  });

  it("takes no clicks while it is invisible on the 64px stub", () => {
    const { container } = render();

    // `opacity-0` rather than unmounted, matching every label here — which
    // leaves an invisible 28px target sitting over the wordmark unless the
    // pointer is turned off with it.
    const pin = screen.getByRole("button", { name: "Pin menu" });
    expect(pin.className).toContain("pointer-events-none");
    expect(pin.className).toContain("opacity-0");
    expect(rail(container).className).toContain("lg:w-[64px]");
  });
});
