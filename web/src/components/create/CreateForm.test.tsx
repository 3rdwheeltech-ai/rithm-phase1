import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CreateForm from "./CreateForm";
import { renderWithProviders, jsonResponse } from "../../test-utils";
import { MAX_INSTRUMENTS } from "../../types/api";

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
        "mood",
        "prompt",
        "vocal",
      ].sort(),
    );
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

  it("renders the controls the API cannot carry, disabled rather than hidden", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CreateForm />);

    // Lyrics: there is no user-lyrics path in the worker.
    expect(screen.getByRole("tab", { name: "Write" })).toBeDisabled();
    expect(screen.getByRole("tab", { name: "Describe" })).toBeDisabled();

    await user.click(screen.getByRole("tab", { name: "Advanced" }));
    expect(screen.getByRole("switch", { name: "Thinking" })).toBeDisabled();
    expect(screen.getByLabelText("Creativity")).toBeDisabled();
    expect(screen.getByLabelText("Vocal language")).toBeDisabled();
    expect(screen.getByLabelText("Key and scale")).toBeDisabled();
  });
});
