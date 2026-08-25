import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import CreateForm from "./CreateForm";
import { renderWithProviders, jsonResponse } from "../../test-utils";
import { MAX_INSTRUMENTS, type SongDraft } from "../../types/api";
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
        "lyrics_mode",
        "lyrics_prompt",
        "mood",
        "prompt",
        "title",
        "vocal",
        "voice",
      ].sort(),
    );
    // Null, not "" — an empty string is a different instruction to the model.
    expect(body.lyrics).toBeNull();
    expect(body.lyrics_prompt).toBeNull();
    // Null means "name it for me"; "" would be a name the server has to honour.
    expect(body.title).toBeNull();
    expect(body.prompt).toBe("warm lo-fi piano");
    expect(body.vocal).toBe(true);
    // vocal and lyrics_mode are one fact stated twice; the API 422s a
    // disagreement, so they are never built independently.
    expect(body.lyrics_mode).toBe("write");
    expect(body.voice).toBe("auto");
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
    const body = generateBody();
    expect(body.vocal).toBe(false);
    expect(body.lyrics_mode).toBe("instrumental");
    // A gender for a track with no singer is meaningless — send "auto"
    // whatever the control was left on.
    expect(body.voice).toBe("auto");
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

  it("warns about unused lyrics under Instrumental, and only there", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CreateForm />);

    await user.click(screen.getByRole("tab", { name: "Write" }));
    await user.type(screen.getByLabelText("Your lyrics"), "some words");

    // The textarea unmounts on the switch, so without a note the text is gone
    // from the screen AND from the request with nothing said about either.
    await user.click(screen.getByRole("tab", { name: "Instrumental" }));
    expect(screen.getByText(/lyrics are saved but will not be used/i)).toBeInTheDocument();

    // Prompt mode does NOT discard them — the two boxes are separate strings —
    // so the warning there would be a lie.
    await user.click(screen.getByRole("tab", { name: "Prompt" }));
    expect(screen.queryByText(/will not be used/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Write" }));
    expect(screen.queryByText(/will not be used/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Your lyrics")).toHaveValue("some words");
  });

  it("offers the track title on both forms, enabled and optional", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CreateForm />);

    // Simple first — this is not an Advanced-only control. There is no rename
    // afterwards, so naming a track up front has to be reachable by default.
    expect(screen.getByLabelText("Track title")).toBeEnabled();

    await user.click(screen.getByRole("tab", { name: "Advanced" }));
    expect(screen.getByLabelText("Track title")).toBeEnabled();
  });

  it("sends a typed title and leaves an untouched box null", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CreateForm />);

    await user.type(screen.getByLabelText("Describe the track"), "opera metal");
    await user.type(screen.getByLabelText("Track title"), "  Midnight Ferry  ");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(generateBody().title).toBe("Midnight Ferry");
  });

  it("routes Prompt-mode typing into lyrics_prompt, never lyrics", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CreateForm />);

    await user.type(screen.getByLabelText("Describe the track"), "slow indie rock");
    await user.click(screen.getByRole("tab", { name: "Prompt" }));

    // The box stays ENABLED and empty is a legitimate submit — Prompt with no
    // brief means "write words to match the style alone".
    const brief = screen.getByLabelText("What the song is about");
    expect(brief).toBeEnabled();
    await user.type(brief, "a late drive home");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = generateBody();
    // Exactly one of the two is ever non-null; the API 422s any other pairing.
    expect(body.lyrics_mode).toBe("prompt");
    expect(body.lyrics_prompt).toBe("a late drive home");
    expect(body.lyrics).toBeNull();
  });

  it("keeps the lyric sheet and the brief in separate boxes", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CreateForm />);

    await user.click(screen.getByRole("tab", { name: "Write" }));
    await user.type(screen.getByLabelText("Your lyrics"), "[[verse]{enter}neon rain");

    await user.click(screen.getByRole("tab", { name: "Prompt" }));
    // A half-written verse must NOT arrive at the lyricist as if it were a
    // brief — that is the whole reason these are two strings and not one.
    expect(screen.getByLabelText("What the song is about")).toHaveValue("");
    await user.type(screen.getByLabelText("What the song is about"), "a brief");

    await user.click(screen.getByRole("tab", { name: "Write" }));
    // ...and it must not be lost on the way back, either.
    expect(screen.getByLabelText("Your lyrics")).toHaveValue("[verse]\nneon rain");
  });

  it("sends the chosen voice, and disables the control for an instrumental", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CreateForm />);

    await user.type(screen.getByLabelText("Describe the track"), "slow indie rock");
    await user.click(screen.getByRole("tab", { name: "Advanced" }));
    await user.click(screen.getByRole("tab", { name: "Female" }));
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(generateBody().voice).toBe("female");

    // Nothing to shape once there is no singer.
    await user.click(screen.getByRole("tab", { name: "Instrumental" }));
    expect(screen.getByRole("tab", { name: "Female" })).toBeDisabled();
    expect(screen.getByRole("tab", { name: "Male" })).toBeDisabled();
    expect(screen.getByText("No vocals to shape.")).toBeInTheDocument();
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

    // Describe is gone and Song title is built, so the Vocals row carries no
    // disabled tab at all any more.
    expect(screen.queryByRole("tab", { name: "Describe" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Advanced" }));
    expect(screen.getByRole("switch", { name: "Thinking" })).toBeDisabled();
    expect(screen.getByLabelText("Creativity")).toBeDisabled();
    expect(screen.getByLabelText("Vocal language")).toBeDisabled();
    expect(screen.getByLabelText("Key and scale")).toBeDisabled();
    expect(screen.getByLabelText("Seed")).toBeDisabled();

    // Six, not seven: the track title is built, so its ComingSoon is gone.
    // Pinned exactly — a count that only ever grows is not a regression guard.
    expect(screen.getAllByText("Coming soon")).toHaveLength(6);
  });

  it("explains each disabled control from an enabled wrapper", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CreateForm />);
    await user.click(screen.getByRole("tab", { name: "Advanced" }));

    // A disabled control eats its own pointer events, so a `title` on it never
    // fires. The explanation has to hang off an enabled ancestor — this is the
    // regression guard for that.
    const notes = screen.getAllByRole("note");
    expect(notes).toHaveLength(6);
    for (const note of notes) {
      expect(note).toHaveAttribute("aria-label", expect.stringContaining("Coming soon"));
      expect(note).not.toBeDisabled();
    }
  });
});

/**
 * The chat assistant's handoff.
 *
 * `lib/chat.ts` is the single place the wire invariants are honoured; these
 * are the statement that they arrive intact — and, at the end, that a handed
 * draft submits without a 422. A 422 here is what the user would read as "the
 * chatbot broke Create".
 */
function LocationProbe() {
  const { state } = useLocation();
  return <span data-testid="router-state">{state === null ? "cleared" : "present"}</span>;
}

function renderHandedOver(state: unknown) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[{ pathname: "/create", state }]}>
        <LocationProbe />
        <CreateForm />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const FULL_DRAFT: SongDraft = {
  prompt: "a rainy late-night drive",
  title: "Neon Rooftop",
  genre: "Lo-Fi",
  mood: "Calm",
  instruments: ["piano", "rhodes"],
  length_seconds: 120,
  bpm_min: 80,
  bpm_max: 100,
  lyrics_mode: "prompt",
  voice: "female",
  lyrics: null,
  lyrics_prompt: "a fight nobody won",
};

describe("CreateForm — the chat handoff", () => {
  it("fills every field and opens on Advanced", async () => {
    renderHandedOver({ draft: FULL_DRAFT });

    // Advanced, because the draft carries genre, mood, tempo and voice — none
    // of which Simple can show. Landing on Simple would look like the form had
    // ignored half the conversation.
    expect(screen.getByRole("tab", { name: "Advanced" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    expect(screen.getByLabelText("Describe the track")).toHaveValue("a rainy late-night drive");
    expect(screen.getByLabelText("Track title")).toHaveValue("Neon Rooftop");
    expect(screen.getByLabelText("Genre")).toHaveValue("Lo-Fi");
    expect(screen.getByLabelText("Mood")).toHaveValue("Calm");
    expect(screen.getByLabelText("What the song is about")).toHaveValue("a fight nobody won");
    expect(screen.getByText("piano")).toBeInTheDocument();
    expect(screen.getByText("rhodes")).toBeInTheDocument();
    // A bpm range means Auto is OFF — the pair is both-or-neither on the wire,
    // so its presence IS the tempo decision.
    expect(screen.getByLabelText("Min BPM")).toHaveValue("80");
    expect(screen.getByLabelText("Max BPM")).toHaveValue("100");
  });

  it("submits a handed draft without a 422", async () => {
    const user = userEvent.setup();
    renderHandedOver({ draft: FULL_DRAFT });

    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = generateBody();
    expect(body.prompt).toBe("a rainy late-night drive");
    expect(body.genre).toBe("Lo-Fi");
    expect(body.mood).toBe("Calm");
    expect(body.bpm_min).toBe(80);
    expect(body.bpm_max).toBe(100);
    expect(body.length_seconds).toBe(120);
    expect(body.lyrics_mode).toBe("prompt");
    expect(body.lyrics_prompt).toBe("a fight nobody won");
    // Exactly one of the two lyric fields is ever non-null, and lyrics_mode
    // says which. Every other pairing is a 422.
    expect(body.lyrics).toBeNull();
    expect(body.vocal).toBe(true);
    expect(body.voice).toBe("female");
  });

  it("keeps an instrumental draft's vocals off and its voice neutral", async () => {
    const user = userEvent.setup();
    renderHandedOver({
      draft: { ...FULL_DRAFT, lyrics_mode: "instrumental", lyrics_prompt: null, voice: "auto" },
    });

    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = generateBody();
    expect(body.vocal).toBe(false);
    expect(body.lyrics_mode).toBe("instrumental");
    expect(body.voice).toBe("auto");
    expect(body.lyrics).toBeNull();
    expect(body.lyrics_prompt).toBeNull();
  });

  it("clears the router state once it has been consumed", async () => {
    renderHandedOver({ draft: FULL_DRAFT });

    // history.state survives a reload. Without this, a refresh silently
    // re-seeds the form from a conversation the user has moved past — and
    // throws away whatever they changed in the meantime.
    await waitFor(() =>
      expect(screen.getByTestId("router-state")).toHaveTextContent("cleared"),
    );
    // …and the values it seeded are still there.
    expect(screen.getByLabelText("Describe the track")).toHaveValue("a rainy late-night drive");
  });

  it("still honours the prompt-only handoff from Home", () => {
    renderHandedOver({ prompt: "warm lo-fi piano" });

    expect(screen.getByLabelText("Describe the track")).toHaveValue("warm lo-fi piano");
    // Nothing Simple cannot show, so it opens where it always did.
    expect(screen.getByRole("tab", { name: "Simple" })).toHaveAttribute("aria-selected", "true");
  });

  it("opens on Simple for a draft that carries nothing Advanced-only", () => {
    renderHandedOver({
      draft: {
        ...FULL_DRAFT,
        genre: null,
        mood: null,
        bpm_min: null,
        bpm_max: null,
        voice: "auto",
      },
    });

    expect(screen.getByRole("tab", { name: "Simple" })).toHaveAttribute("aria-selected", "true");
  });
});
