import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TrackCard from "./TrackCard";

const BASE = {
  title: "Midnight Bloom",
  subtitle: "lo-fi • 88 BPM",
  gradient: "from-teal-400/45 to-slate-900/65",
  duration: "1:30",
};

describe("TrackCard", () => {
  it("renders the title, subtitle and duration", () => {
    render(<TrackCard {...BASE} onPlay={() => undefined} />);

    expect(screen.getByText("Midnight Bloom")).toBeInTheDocument();
    expect(screen.getByText("lo-fi • 88 BPM")).toBeInTheDocument();
    expect(screen.getByText("1:30")).toBeInTheDocument();
  });

  it("names the play button after the track, and flips to Pause while playing", () => {
    const { rerender } = render(<TrackCard {...BASE} onPlay={() => undefined} />);
    expect(screen.getByRole("button", { name: "Play Midnight Bloom" })).toBeInTheDocument();

    rerender(<TrackCard {...BASE} playing onPlay={() => undefined} />);
    expect(screen.getByRole("button", { name: "Pause Midnight Bloom" })).toBeInTheDocument();
  });

  it("fires each handler from its own control", async () => {
    const onPlay = vi.fn();
    const onOpen = vi.fn();
    const onDelete = vi.fn();
    const user = userEvent.setup();

    render(<TrackCard {...BASE} onPlay={onPlay} onOpen={onOpen} onDelete={onDelete} />);

    await user.click(screen.getByRole("button", { name: "Play Midnight Bloom" }));
    await user.click(screen.getByRole("button", { name: "Open Midnight Bloom" }));
    await user.click(screen.getByRole("button", { name: "Delete Midnight Bloom" }));

    expect(onPlay).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("omits the open and delete controls when nothing handles them", () => {
    // Discover renders this card over sample data: there is no track to open
    // and nothing of the user's to delete, so neither button may exist.
    render(<TrackCard {...BASE} onPlay={() => undefined} />);

    expect(screen.queryByRole("button", { name: /^Open/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Delete/ })).not.toBeInTheDocument();
  });

  it("keeps the full prompt reachable as a tooltip once it leaves the card", () => {
    render(<TrackCard {...BASE} titleTooltip="dreamy lo-fi with warm piano" onPlay={() => undefined} />);

    expect(screen.getByText("Midnight Bloom")).toHaveAttribute(
      "title",
      "dreamy lo-fi with warm piano",
    );
  });
});
