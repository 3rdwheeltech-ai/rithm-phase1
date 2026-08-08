import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ComingSoonDialog from "./ComingSoonDialog";

describe("ComingSoonDialog", () => {
  it("renders nothing until a feature is named", () => {
    render(<ComingSoonDialog feature={null} onClose={() => undefined} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("names the feature it stands in for", () => {
    render(<ComingSoonDialog feature="Stem Splitter" onClose={() => undefined} />);

    expect(screen.getByRole("dialog", { name: "Stem Splitter — coming soon" })).toBeInTheDocument();
    expect(screen.getByText("Stem Splitter")).toBeInTheDocument();
  });

  it("closes on Escape, the dismiss button and the confirm button", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<ComingSoonDialog feature="Remix" onClose={onClose} />);

    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    await user.click(screen.getByRole("button", { name: "Got it" }));

    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("takes focus on open so a keyboard user is not left behind the scrim", () => {
    render(<ComingSoonDialog feature="Remix" onClose={() => undefined} />);
    expect(screen.getByRole("button", { name: "Got it" })).toHaveFocus();
  });
});
