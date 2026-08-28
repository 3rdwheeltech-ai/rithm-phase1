import { describe, expect, it } from "vitest";
import { shellMargin } from "./Layout";

/**
 * The gutters, on their own.
 *
 * A pure function of three inputs is worth testing as one: rendering the whole
 * shell to read a class name off `<main>` needs a router, a query client, a
 * media stack and an `<audio>` element, and would still be checking this.
 */
describe("shellMargin", () => {
  it("widens the left gutter for a pinned menu, on every variant", () => {
    for (const variant of ["home", "create", "rail", "mobile"] as const) {
      expect(shellMargin(variant, false, false)).toContain("lg:ml-[88px]");
      expect(shellMargin(variant, true, false)).toContain("lg:ml-[252px]");
    }
  });

  it("reserves the player's full width on a rail route only when pinned", () => {
    expect(shellMargin("rail", false, false)).toContain("lg:mr-[82px]");
    expect(shellMargin("rail", false, true)).toContain("lg:mr-[332px]");
  });

  it("leaves Home and Create alone — they own the right column already", () => {
    // Home's is its own 312px stack, and Create's player is pinned open by the
    // route. Neither has anything for the player pin to decide.
    expect(shellMargin("home", false, true)).toContain("lg:mr-[336px]");
    expect(shellMargin("home", false, false)).toContain("lg:mr-[336px]");
    expect(shellMargin("create", false, true)).toContain("lg:mr-[332px]");
    expect(shellMargin("create", false, false)).toContain("lg:mr-[332px]");
  });

  it("writes whole class literals, never built-up strings", () => {
    // Tailwind's scanner reads source text: `lg:ml-[${n}px]` compiles to
    // nothing, and the failure is a margin that silently does not exist.
    const both = shellMargin("rail", true, true);
    expect(both.split(" ")).toEqual(["lg:ml-[252px]", "lg:mr-[332px]"]);
  });
});
