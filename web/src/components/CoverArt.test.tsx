import { describe, expect, it } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import CoverArt from "./CoverArt";
import { coverGradient, coverImage } from "../lib/covers";

const SEED = "0192f0a1-7c3e-7b21-9d44-2f18ab5c0e31";

/** The photo is decorative, so it has no accessible role to query by. */
function img(container: HTMLElement) {
  return container.querySelector("img");
}

describe("CoverArt", () => {
  it("paints the gradient underneath, so there is never an empty square", () => {
    const { container } = render(<CoverArt seed={SEED} />);
    const root = container.firstElementChild!;

    for (const stop of coverGradient(SEED).split(" ")) {
      expect(root).toHaveClass(stop);
    }
  });

  it("hangs the seed's photo over it", () => {
    const { container } = render(<CoverArt seed={SEED} />);

    expect(img(container)).toHaveAttribute("src", coverImage(SEED));
    // Decorative: the title is adjacent text at every call site.
    expect(img(container)).toHaveAttribute("alt", "");
  });

  it("drops the photo when the url fails, leaving the gradient", () => {
    // The entire fallback story — a dead Unsplash url, a blocked CDN — must
    // degrade to what the app looked like before there were photographs, with
    // no broken-image icon left behind.
    const { container } = render(<CoverArt seed={SEED} />);

    fireEvent.error(img(container)!);

    expect(img(container)).toBeNull();
    expect(container.firstElementChild).toHaveClass("bg-gradient-to-br");
  });

  it("lets a caller override the gradient without touching the photo", () => {
    // Discover's sample catalogue keeps its own wider palette as its fallback.
    const { container } = render(<CoverArt seed={SEED} gradient="from-lime-300/40" />);

    expect(container.firstElementChild).toHaveClass("from-lime-300/40");
    expect(container.firstElementChild).not.toHaveClass(coverGradient(SEED).split(" ")[0]!);
    expect(img(container)).toHaveAttribute("src", coverImage(SEED));
  });
});
