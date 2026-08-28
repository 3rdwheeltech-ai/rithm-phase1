import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Composer from "./Composer";

/**
 * The box holds the caret.
 *
 * This is the whole reason the component owns a focus effect at all: the panel
 * has exactly one thing to do in it, and answering a question should never
 * cost a click on the box you were already typing in.
 */
describe("Composer", () => {
  it("takes the caret as soon as the panel opens", () => {
    render(<Composer onSend={vi.fn()} busy={false} />);

    expect(screen.getByLabelText("Message the assistant")).toHaveFocus();
  });

  it("takes it back when the turn lands", async () => {
    // Mounted mid-turn, so the box starts disabled and unfocused — which is
    // where a real browser leaves it after `disabled` blurs it, and what the
    // user experiences as "I typed and nothing happened".
    const { rerender } = render(<Composer onSend={vi.fn()} busy={true} />);
    const box = screen.getByLabelText("Message the assistant");
    expect(box).not.toHaveFocus();

    rerender(<Composer onSend={vi.fn()} busy={false} />);

    await waitFor(() => expect(box).toHaveFocus());
  });

  it("still sends on Enter and clears the box", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<Composer onSend={onSend} busy={false} />);

    // No click first: the caret is already here, which is the point.
    await user.keyboard("a rainy drive{Enter}");

    expect(onSend).toHaveBeenCalledWith("a rainy drive");
    expect(screen.getByLabelText("Message the assistant")).toHaveValue("");
  });
});
