import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CreateForm from "./CreateForm";
import { renderWithProviders, jsonResponse } from "../../test-utils";
import { MAX_INSTRUMENTS } from "../../types/api";
import { INSTRUMENT_SUGGESTIONS } from "../../lib/suggestions";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(
    jsonResponse(202, {
      job_id: "01J000000000000000000000J1",
      status: "QUEUED",
      sse_url: "/api/v1/jobs/01J000000000000000000000J1/events?token=tok",
      created_at: "2026-08-04T12:00:00Z",
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  // The form opens a stream on a 202; keep that inert here.
  vi.stubGlobal(
    "EventSource",
    class {
      close() {}
      addEventListener() {}
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function generateBody(): Record<string, unknown> {
  const call = fetchMock.mock.calls.find(([url]) => url === "/api/v1/tracks/generate");
  if (!call) throw new Error("no generate request was made");
  return JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>;
}

describe("CreateForm", () => {
  it("submits a payload matching GenerateRequest exactly", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CreateForm />);

    await user.type(screen.getByLabelText("Describe the track"), "warm lo-fi piano");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = generateBody();

    // Exactly the fields the API accepts — an unknown key is a 422.
    expect(Object.keys(body).sort()).toEqual(
      [
        "bpm_max",
        "bpm_min",
        "genre",
        "instruments",
        "length_seconds",
        "lyrics",
        "mood",
        "prompt",
        "vocal",
      ].sort(),
    );
    // Null, not "" — an empty string is a different instruction to the model.
    expect(body.lyrics).toBeNull();
    expect(body.prompt).toBe("warm lo-fi piano");
    expect(body.vocal).toBe(true);
    expect(body.length_seconds).toBe(90);
    // Auto tempo means BOTH bounds are null — never one alone.
    expect(body.bpm_min).toBeNull();
    expect(body.bpm_max).toBeNull();
  });

  it("sends vocal:false when Instrumental is chosen", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CreateForm />);

    await user.type(screen.getByLabelText("Describe the track"), "rain and piano");
    await user.click(screen.getByRole("tab", { name: "Instrumental" }));
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(generateBody().vocal).toBe(false);
  });

  it("blocks submit when bpm_min exceeds bpm_max", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CreateForm />);

    await user.type(screen.getByLabelText("Describe the track"), "fast track");
    await user.click(screen.getByRole("tab", { name: "Advanced" }));
    // Turn Auto off so the range is sent at all.
    await user.click(screen.getByRole("button", { name: "Auto" }));

    fireEvent.change(screen.getByLabelText("Min BPM"), { target: { value: "180" } });
    fireEvent.change(screen.getByLabelText("Max BPM"), { target: { value: "90" } });

    expect(screen.getByText("Minimum BPM must not exceed the maximum.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends both bpm bounds once Auto is off and the range is valid", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CreateForm />);

    await user.type(screen.getByLabelText("Describe the track"), "mid tempo");
    await user.click(screen.getByRole("tab", { name: "Advanced" }));
    await user.click(screen.getByRole("button", { name: "Auto" }));

    fireEvent.change(screen.getByLabelText("Min BPM"), { target: { value: "100" } });
    fireEvent.change(screen.getByLabelText("Max BPM"), { target: { value: "120" } });

    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const body = generateBody();
    expect(body.bpm_min).toBe(100);
    expect(body.bpm_max).toBe(120);
  });

  it("caps instruments at the API's limit", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CreateForm />);
    await user.click(screen.getByRole("tab", { name: "Advanced" }));

    const input = screen.getByLabelText("Add an instrument");
    for (let i = 0; i < MAX_INSTRUMENTS + 3; i += 1) {
      await user.type(input, `inst${i}{Enter}`);
    }

    expect(screen.getByText(`${MAX_INSTRUMENTS} / ${MAX_INSTRUMENTS}`)).toBeInTheDocument();
    expect(screen.getByLabelText("Add an instrument")).toBeDisabled();

    await user.type(screen.getByLabelText("Describe the track"), "layered");
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    expect((generateBody().instruments as string[]).length).toBe(MAX_INSTRUMENTS);
  });

  it("sends the lyrics the user wrote", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CreateForm />);

    await user.type(screen.getByLabelText("Describe the track"), "opera metal");
    await user.click(screen.getByRole("tab", { name: "Write" }));
    // `[[` is userEvent's escape for a literal `[` — it reads key descriptors
    // like `[Enter]` otherwise. The typed text is `[verse]\nneon rain`.
    await user.type(screen.getByLabelText("Your lyrics"), "[[verse]{enter}neon rain");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = generateBody();
    // Structure tags are ACE-Step's own — passed through, never rewritten.
    expect(body.lyrics).toBe("[verse]\nneon rain");
    expect(body.vocal).toBe(true);
  });

  it("opens in Write mode with the lyrics box ready and Create usable", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CreateForm />);

    // Write is the landing state, so the editor is there without a click.
    expect(screen.getByLabelText("Your lyrics")).toBeInTheDocument();

    // An empty box must NOT gate the primary button — that would greet every
    // visitor with a dead Create, which is the bug this page started with.
    await user.type(screen.getByLabelText("Describe the track"), "opera metal");
    expect(screen.getByRole("button", { name: "Create" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // Empty lyrics collapse to null: the model writes the words.
    const body = generateBody();
    expect(body.lyrics).toBeNull();
    expect(body.vocal).toBe(true);
  });

  it("does not send lyrics written before switching to Instrumental", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CreateForm />);

    await user.type(screen.getByLabelText("Describe the track"), "rain");
    await user.click(screen.getByRole("tab", { name: "Write" }));
    await user.type(screen.getByLabelText("Your lyrics"), "some words");
    await user.click(screen.getByRole("tab", { name: "Instrumental" }));
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // lyrics + vocal:false is a 422 at the API; the mode check is what stops
    // the pair ever being built.
    const body = generateBody();
    expect(body.vocal).toBe(false);
    expect(body.lyrics).toBeNull();
  });

  it("says so when a mode switch leaves written lyrics unused", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CreateForm />);

    await user.click(screen.getByRole("tab", { name: "Write" }));
    await user.type(screen.getByLabelText("Your lyrics"), "some words");

    // The textarea unmounts on the switch, so without a note the text is gone
    // from the screen AND from the request with nothing said about either.
    await user.click(screen.getByRole("tab", { name: "Generate" }));
    expect(screen.getByText(/lyrics are saved but will not be used/i)).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Write" }));
    expect(screen.queryByText(/will not be used/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Your lyrics")).toHaveValue("some words");
  });

  it("refills the instrument suggestions as they are used", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CreateForm />);
    await user.click(screen.getByRole("tab", { name: "Advanced" }));

    const row = () =>
      screen
        .getAllByRole("button")
        .map((b) => b.textContent?.trim() ?? "")
        .filter((text) => INSTRUMENT_SUGGESTIONS.includes(text));

    const before = row();
    expect(before).toHaveLength(8);

    const taken = before[2]!;
    await user.click(screen.getByRole("button", { name: taken }));

    const after = row();
    // The slot refills rather than leaving the row a chip short, and the taken
    // instrument does not come back as a suggestion.
    expect(after).toHaveLength(8);
    expect(after).not.toContain(taken);
    expect(new Set(after).size).toBe(8);
    // It moved to the chosen list instead.
    expect(screen.getByRole("button", { name: `Remove ${taken}` })).toBeInTheDocument();
  });

  it("renders the controls the API cannot carry, disabled and tagged", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CreateForm />);

    expect(screen.getByRole("tab", { name: "Describe" })).toBeDisabled();

    await user.click(screen.getByRole("tab", { name: "Advanced" }));
    expect(screen.getByRole("switch", { name: "Thinking" })).toBeDisabled();
    expect(screen.getByLabelText("Creativity")).toBeDisabled();
    expect(screen.getByLabelText("Vocal language")).toBeDisabled();
    expect(screen.getByLabelText("Key and scale")).toBeDisabled();
    expect(screen.getByLabelText("Seed")).toBeDisabled();
    expect(screen.getByLabelText("Song title")).toBeDisabled();

    // Every one carries a visible tag, so the state reads without hovering.
    expect(screen.getAllByText("Coming soon").length).toBeGreaterThanOrEqual(6);
  });

  it("explains each disabled control from an enabled wrapper", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CreateForm />);
    await user.click(screen.getByRole("tab", { name: "Advanced" }));

    // A disabled control eats its own pointer events, so a `title` on it never
    // fires. The explanation has to hang off an enabled ancestor — this is the
    // regression guard for that.
    const notes = screen.getAllByRole("note");
    expect(notes.length).toBeGreaterThanOrEqual(6);
    for (const note of notes) {
      expect(note).toHaveAttribute("aria-label", expect.stringContaining("Coming soon"));
      expect(note).not.toBeDisabled();
    }
  });
});
