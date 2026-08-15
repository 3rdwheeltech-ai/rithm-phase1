import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ChipSelect from "./ChipSelect";

const OPTIONS = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Bravo" },
  { value: "c", label: "Charlie" },
];

describe("ChipSelect", () => {
  it("adds and removes values in multi mode", async () => {
    const onChange = vi.fn();
    render(
      <ChipSelect options={OPTIONS} value={["a"]} onChange={onChange} ariaLabel="Letters" />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Bravo" }));
    expect(onChange).toHaveBeenCalledWith(["a", "b"]);

    await userEvent.click(screen.getByRole("button", { name: "Alpha" }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("replaces rather than appends in single mode", async () => {
    const onChange = vi.fn();
    render(
      <ChipSelect
        options={OPTIONS}
        value={["a"]}
        onChange={onChange}
        single
        ariaLabel="Letters"
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Bravo" }));
    expect(onChange).toHaveBeenCalledWith(["b"]);
  });

  it("clears when the selected chip is tapped again — every question is optional", async () => {
    const onChange = vi.fn();
    render(
      <ChipSelect
        options={OPTIONS}
        value={["a"]}
        onChange={onChange}
        single
        ariaLabel="Letters"
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Alpha" }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("disables the unselected chips once max is reached, but not the selected ones", () => {
    render(
      <ChipSelect
        options={OPTIONS}
        value={["a", "b"]}
        onChange={vi.fn()}
        max={2}
        ariaLabel="Letters"
      />,
    );

    expect(screen.getByRole("button", { name: "Charlie" })).toBeDisabled();
    // Still removable — a cap must not trap the user at the cap.
    expect(screen.getByRole("button", { name: "Alpha" })).toBeEnabled();
  });

  it("reports selection through aria-pressed", () => {
    render(
      <ChipSelect options={OPTIONS} value={["b"]} onChange={vi.fn()} ariaLabel="Letters" />,
    );

    expect(screen.getByRole("button", { name: "Bravo" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Alpha" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
});
