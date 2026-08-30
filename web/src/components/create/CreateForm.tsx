import { useEffect, useRef, useState } from "react";
import { Sparkles, Lock, X } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { useCreateUI } from "../../store/createUI";
import { useGenerate } from "../../hooks/useGenerate";
import { useLens } from "../../lib/useLens";
import { mergeRefs, useSpecular } from "../../lib/useSpecular";
import { formatDuration } from "../../lib/track";
import { cn } from "../../lib/cn";
import { draftToCreateState } from "../../lib/chat";
import { INSTRUMENT_SUGGESTIONS } from "../../lib/suggestions";
import { useShuffledPicks } from "../../lib/useShuffledPicks";
import { usePrefersReducedMotion } from "../../lib/useReducedMotion";
import { useTypewriter } from "../../lib/useTypewriter";
import ErrorToast from "../ErrorToast";
import SpecularButton, { SPECULAR_BASE, SPECULAR_LINE } from "../SpecularButton";
import Segmented from "./Segmented";
import TickSlider from "./TickSlider";
import Switch from "./Switch";
import Select, { type SelectOption } from "./Select";
import ComingSoon, { ComingSoonTag } from "./ComingSoon";
import {
  BPM_MAX,
  BPM_MIN,
  GENRES,
  LENGTH_MAX_SECONDS,
  LENGTH_MIN_SECONDS,
  LYRICS_MAX_LENGTH,
  LYRICS_PROMPT_MAX_LENGTH,
  MAX_INSTRUMENTS,
  MOODS,
  PROMPT_MAX_LENGTH,
  TITLE_MAX_LENGTH,
  type GenerateRequest,
  type Genre,
  type LyricsMode,
  type Mood,
  type SongDraft,
  type Voice,
} from "../../types/api";

type Complexity = "simple" | "advanced";

/**
 * The API accepts exactly:
 *   prompt, title, genre, mood, bpm_min, bpm_max, instruments[<=10], vocal,
 *   voice, length_seconds, lyrics_mode, lyrics, lyrics_prompt
 *
 * Everything else here — thinking, creativity, language, key, time signature,
 * seed — is rendered DISABLED with a visible "Coming soon" tag and a hover
 * explanation, so the shape of the product stays legible without anyone
 * mistaking an unbuilt control for a broken one. The tag and the tooltip both
 * come from <ComingSoon>, which exists because a `title` on a disabled control
 * never fires.
 */

/** Eight at a time, drawn from the twenty in INSTRUMENT_SUGGESTIONS. */
const VISIBLE_INSTRUMENTS = 8;

const LANGUAGES: SelectOption[] = [{ value: "en", label: "English" }];
const KEYS: SelectOption[] = [{ value: "auto", label: "Auto" }];

const LYRICS_PLACEHOLDER = `[verse]
Neon on the wet street, engine running low
…

[chorus]
…`;

/**
 * The lyric brief's placeholder, typed out and cycled.
 *
 * A LIST RATHER THAN ONE LINE, because a single frozen example reads as the
 * format required rather than as an invitation. Watching it type — and reach
 * for four quite different songs — says the box takes a sentence in your own
 * words, which is the one thing people get wrong here: they paste lyrics into
 * it instead of describing them.
 *
 * All four are scenes, none is a lyric, and none of them rhymes. That is the
 * distinction the field is trying to teach.
 */
const LYRIC_BRIEF_PROMPTS = [
  "e.g. a late drive home after a fight nobody won",
  "e.g. the summer everything changed and nobody said so",
  "e.g. a letter to someone who moved away years ago",
  "e.g. the last night in a city you were done with",
];

/** Slower than the assistant panel's 45ms. A form is read, not watched. */
const BRIEF_TYPE_MS = 55;
const BRIEF_HOLD_MS = 3600;
const BRIEF_ERASE_MS = 18;

const SECTION_LABEL = "eyebrow";
const FIELD_LABEL = "text-xs font-medium text-ink-muted";

export default function CreateForm() {
  const setPlayerHeight = useCreateUI((s) => s.setPlayerHeight);
  const nav = useNavigate();
  const { pathname, state } = useLocation();
  /*
    Two doors hand work over in router state, and this reads both:

      { prompt }  Home's "Write lyrics" door, unchanged since Day 4.
      { draft }   the chat assistant's "Open in Create", thirteen fields at once.

    `draftToCreateState` is the single place the wire invariants are honoured
    for the second one — see lib/chat.ts for what those are and why.
  */
  const handed = state as { prompt?: string; draft?: SongDraft } | null;
  const seed = draftToCreateState(handed?.draft ?? null, handed?.prompt);

  // Opens on Advanced when the draft carries something Simple cannot show —
  // genre, mood, tempo or voice. Otherwise the user lands on a form that
  // appears to have ignored half the conversation.
  const [complexity, setComplexity] = useState<Complexity>(seed.complexity);
  // Write is the landing state: the lyrics editor is the reason most people
  // open this page, and an empty box still means "you write the words", so
  // defaulting here costs nothing for the users who never touch it.
  const [lyricMode, setLyricMode] = useState<LyricsMode>(seed.lyricMode);
  const [prompt, setPrompt] = useState(seed.prompt);
  const [title, setTitle] = useState(seed.title);
  const [voice, setVoice] = useState<Voice>(seed.voice);
  // TWO strings, not one shared box. Switching Write→Prompt→Write must not
  // hand a half-written verse to the lyricist as if it were a brief, and must
  // not lose it either.
  const [lyrics, setLyrics] = useState(seed.lyrics);
  const [lyricPrompt, setLyricPrompt] = useState(seed.lyricPrompt);

  /*
    The brief's placeholder types itself, cycling four examples.

    STOPPED THE MOMENT THERE IS A VALUE. A placeholder is invisible behind
    text, so animating one under a filled box is a timer nobody can see — and
    it would keep re-rendering this form on every keystroke of its own. Reduced
    motion holds the first example, which is exactly what shipped before.
  */
  const reduceMotion = usePrefersReducedMotion();
  const lyricBriefPlaceholder = useTypewriter(LYRIC_BRIEF_PROMPTS, {
    enabled: !reduceMotion && lyricPrompt === "",
    typeMs: BRIEF_TYPE_MS,
    slotMs: BRIEF_HOLD_MS,
    eraseMs: BRIEF_ERASE_MS,
  });
  const [genre, setGenre] = useState<Genre | "">(seed.genre);
  const [mood, setMood] = useState<Mood | "">(seed.mood);
  const [instruments, setInstruments] = useState<string[]>(seed.instruments);
  const [instrumentDraft, setInstrumentDraft] = useState("");
  const [lengthSeconds, setLengthSeconds] = useState(seed.lengthSeconds);
  const [tempoAuto, setTempoAuto] = useState(seed.tempoAuto);
  const [bpmMin, setBpmMin] = useState(seed.bpmMin);
  const [bpmMax, setBpmMax] = useState(seed.bpmMax);
  const [dismissed, setDismissed] = useState(false);

  /*
    CONSUME the handoff, then clear it.

    `history.state` survives a reload, so without this a refresh silently
    re-seeds the form from a conversation the user has since moved past —
    discarding whatever they changed in the meantime. That has been true of
    `prompt` since Day 4 and was survivable at one field; across thirteen it
    stops being invisible.

    The initialisers above have already run by the time this fires, so
    replacing the entry loses nothing.
  */
  useEffect(() => {
    if (handed) nav(pathname, { replace: true, state: null });
    // Once, on the entry that carried the handoff. `handed` is a fresh object
    // identity on every render, so it must NOT be a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // `exclude` keeps anything already on the track out of the suggestions,
  // however it got there — chip tap or typed by hand.
  const instrumentPicks = useShuffledPicks(INSTRUMENT_SUGGESTIONS, VISIBLE_INSTRUMENTS, {
    exclude: instruments,
  });

  const advanced = complexity === "advanced";
  // Shared with the lens and specular refs below — this node both publishes its
  // height to the docked Player and is the page's largest glass panel.
  const cardRef = useRef<HTMLDivElement>(null);
  const lensRef = useLens<HTMLDivElement>("md", 24);
  const specularRef = useSpecular<HTMLDivElement>();

  // Same rule the request body uses below: only Write mode with something in
  // the box counts as user lyrics; everything else leaves the words to the model.
  const { generate, busy, error } = useGenerate({
    writesLyrics: () =>
      lyricMode !== "instrumental" && !(lyricMode === "write" && lyrics.trim().length > 0),
  });

  const instrumental = lyricMode === "instrumental";

  // Publish the form's rendered height so the docked Player can grow with it.
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setPlayerHeight(entry.contentRect.height);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      setPlayerHeight(null);
    };
  }, [setPlayerHeight]);

  // Day 3's model validator on this is the exact path that used to 500 the API.
  // It returns a clean 422 now, but a disabled button says it better than a
  // Pydantic error array does.
  const bpmInvalid = !tempoAuto && bpmMin > bpmMax;
  // Write mode does NOT require lyrics. It is the default landing state, so
  // gating the primary button on an empty box would greet everyone with a
  // dead Create button — the exact complaint this page started with. An empty
  // box sends null, which is the model's own "write the words yourself".
  const canSubmit = prompt.trim().length > 0 && !bpmInvalid && !busy;

  function addInstrument(raw: string) {
    const value = raw.trim().toLowerCase();
    if (!value || instruments.length >= MAX_INSTRUMENTS || instruments.includes(value)) return;
    setInstruments((prev) => [...prev, value]);
    setInstrumentDraft("");
  }

  function onCreate() {
    if (!canSubmit) return;
    setDismissed(false);
    const body: GenerateRequest = {
      prompt: prompt.trim(),
      // Empty means "name it for me" — null, never "", because the server
      // treats a blank title as a name it has to honour.
      title: title.trim() || null,
      genre: genre === "" ? null : genre,
      mood: mood === "" ? null : mood,
      // Both or neither — the API validates the pair, so never send one alone.
      bpm_min: tempoAuto ? null : bpmMin,
      bpm_max: tempoAuto ? null : bpmMax,
      instruments,
      // One fact stated twice, and the API refuses to let the two disagree.
      vocal: !instrumental,
      lyrics_mode: lyricMode,
      // A gender for a track with no singer is meaningless; the API normalises
      // it anyway, but sending "auto" says what we mean.
      voice: instrumental ? "auto" : voice,
      length_seconds: lengthSeconds,
      // Exactly one of these two is ever non-null, and lyrics_mode says which.
      // The API 422s every other combination, so the mode check here is what
      // guarantees the client never sends one. "" and null both mean "you
      // write the words", and null is what the API wants.
      lyrics: lyricMode === "write" && lyrics.trim() ? lyrics.trim() : null,
      lyrics_prompt: lyricMode === "prompt" && lyricPrompt.trim() ? lyricPrompt.trim() : null,
    };
    generate.mutate(body);
  }

  /**
   * Optional, and first in both forms. "Leave empty and RITHM names it" is the
   * whole contract — the server writes one from the style brief and the
   * lyrics, and the box exists so anyone who already knows the name can say so
   * up front. There is no rename afterwards yet, which is exactly why this is
   * here rather than only in Advanced.
   */
  const titleSection = (
    <section className="mb-5">
      <div className="mb-2 flex items-center justify-between">
        <span className={SECTION_LABEL}>Track title</span>
        <span className="text-2xs text-ink-faint">Optional</span>
      </div>
      <input
        value={title}
        maxLength={TITLE_MAX_LENGTH}
        onChange={(e) => setTitle(e.target.value)}
        aria-label="Track title"
        placeholder="Leave empty and RITHM names it"
        className="glass-input"
      />
    </section>
  );

  const vocalsSection = (
    <section className="mb-5">
      <div className="mb-2.5 flex items-center justify-between">
        <span className={SECTION_LABEL}>Vocals</span>
        <Segmented<LyricsMode>
          ariaLabel="Vocal mode"
          size="sm"
          value={lyricMode}
          onChange={setLyricMode}
          options={[
            { value: "write", label: "Write" },
            { value: "prompt", label: "Prompt" },
            { value: "instrumental", label: "Instrumental" },
          ]}
        />
      </div>

      {lyricMode === "write" && (
        <>
          <textarea
            value={lyrics}
            maxLength={LYRICS_MAX_LENGTH}
            onChange={(e) => setLyrics(e.target.value)}
            aria-label="Your lyrics"
            placeholder={LYRICS_PLACEHOLDER}
            className="glass-input min-h-[160px] resize-y font-mono text-xs leading-relaxed"
          />
          <div className="mt-1 flex items-start justify-between gap-3">
            <p className="text-2xs leading-snug text-ink-faint">
              {/* ACE-Step parses these itself — we pass the text through
                  untouched, so the tags are the user's to use or ignore. */}
              {lyrics.trim() ? (
                <>
                  Use <code className="text-ink-muted">[verse]</code>,{" "}
                  <code className="text-ink-muted">[chorus]</code> and{" "}
                  <code className="text-ink-muted">[bridge]</code> to mark sections.
                </>
              ) : (
                // The empty state has to say what happens if they just hit
                // Create, because Write is where the page opens — and now
                // something actually keeps this promise.
                <>Leave this empty and RITHM will write the words for you.</>
              )}
            </p>
            {lyrics.length > LYRICS_MAX_LENGTH - 200 && (
              <span className="shrink-0 font-mono text-2xs tabular-nums text-ink-faint">
                {lyrics.length} / {LYRICS_MAX_LENGTH}
              </span>
            )}
          </div>
        </>
      )}

      {lyricMode === "prompt" && (
        <>
          {/* Prose treatment, NOT the lyric sheet's mono/tall box. It is a
              sentence, and looking like a lyric sheet is exactly what would
              make people paste lyrics into it. */}
          <textarea
            value={lyricPrompt}
            maxLength={LYRICS_PROMPT_MAX_LENGTH}
            onChange={(e) => setLyricPrompt(e.target.value)}
            aria-label="What the song is about"
            placeholder={lyricBriefPlaceholder}
            className="glass-input min-h-[72px] resize-none leading-relaxed"
          />
          <div className="mt-1 flex items-start justify-between gap-3">
            <p className="text-2xs leading-snug text-ink-faint">
              {lyricPrompt.trim()
                ? "RITHM writes the words from this."
                : "Leave this empty and RITHM will write words to match your style alone."}
            </p>
            {lyricPrompt.length > LYRICS_PROMPT_MAX_LENGTH - 100 && (
              <span className="shrink-0 font-mono text-2xs tabular-nums text-ink-faint">
                {lyricPrompt.length} / {LYRICS_PROMPT_MAX_LENGTH}
              </span>
            )}
          </div>
        </>
      )}

      {instrumental && (
        <div className="rounded-el border border-white/10 bg-white/[0.03] px-4 py-3">
          <p className="text-xs leading-relaxed text-ink-faint">
            Instrumental — no vocals. RITHM will compose music only.
          </p>
          {/* The textarea unmounts on a mode switch but the state survives, so
              without this the words the user typed vanish with no trace and are
              silently left out of the request. Say so instead. Write and Prompt
              no longer discard each other's content, so this fires ONLY here —
              anywhere else it would be a lie. */}
          {lyrics.trim() && (
            <p className="mt-2 text-2xs leading-snug text-ink-faint">
              Your {lyrics.trim().length} characters of lyrics are saved but will not be
              used — switch back to Write to sing them.
            </p>
          )}
        </div>
      )}
    </section>
  );

  const stylesSection = (
    <section className="mb-5">
      <span className={SECTION_LABEL}>Styles</span>
      <textarea
        value={prompt}
        maxLength={PROMPT_MAX_LENGTH}
        onChange={(e) => setPrompt(e.target.value)}
        aria-label="Describe the track"
        placeholder="e.g. opera metal, hard-hitting drums, powerful male voice, cinematic build…"
        className="glass-input mt-2.5 min-h-[72px] resize-none leading-relaxed"
      />
      {prompt.length > 1800 && (
        <p className="mt-1 text-right font-mono text-2xs tabular-nums text-ink-faint">
          {prompt.length} / {PROMPT_MAX_LENGTH}
        </p>
      )}

      <div className="mt-4">
        <div className="flex items-center justify-between">
          <span className={FIELD_LABEL}>Instruments</span>
          <span className="font-mono text-2xs tabular-nums text-ink-faint">
            {instruments.length} / {MAX_INSTRUMENTS}
          </span>
        </div>

        {instruments.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {instruments.map((instrument) => (
              <span
                key={instrument}
                className="inline-flex items-center gap-1.5 rounded-full border border-signal/25 bg-signal/15 px-3 py-1 text-xs font-medium text-ink"
              >
                {instrument}
                <button
                  type="button"
                  onClick={() => setInstruments((prev) => prev.filter((i) => i !== instrument))}
                  aria-label={`Remove ${instrument}`}
                  className="text-ink-faint transition-colors hover:text-ink"
                >
                  <X className="h-3 w-3" strokeWidth={2.5} />
                </button>
              </span>
            ))}
          </div>
        )}

        <input
          value={instrumentDraft}
          onChange={(e) => setInstrumentDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              addInstrument(instrumentDraft);
            }
          }}
          disabled={instruments.length >= MAX_INSTRUMENTS}
          aria-label="Add an instrument"
          placeholder={
            instruments.length >= MAX_INSTRUMENTS
              ? `Maximum ${MAX_INSTRUMENTS} instruments`
              : "Type an instrument and press Enter"
          }
          className="glass-input mt-2.5 disabled:opacity-40"
        />

        <div
          className={cn(
            "mt-3 flex min-h-[36px] flex-wrap gap-2",
            instrumentPicks.phase === "out" && "chips-out",
            instrumentPicks.phase === "in" && "chips-in",
          )}
        >
          {instrumentPicks.picks.map((instrument) => (
            <button
              key={`${instrumentPicks.cycle}-${instrument}`}
              type="button"
              onClick={() => {
                addInstrument(instrument);
                // `exclude` would drop it anyway, but replacing explicitly
                // refills the slot instead of leaving the row a chip short.
                instrumentPicks.replace(instrument);
              }}
              disabled={instruments.length >= MAX_INSTRUMENTS}
              className="chip-swap rounded-full border border-white/10 bg-white/[0.035] min-h-[36px] px-3 text-xs font-medium text-ink-muted transition-colors hover:border-white/15 hover:bg-white/[0.07] hover:text-ink disabled:opacity-30"
            >
              {instrument}
            </button>
          ))}
        </div>
      </div>
    </section>
  );

  return (
    <div
      ref={mergeRefs(cardRef, lensRef, specularRef)}
      className="lg-lens w-full p-4 sm:p-6"
      style={{ "--r": "24px", "--pad": "16px" } as React.CSSProperties}
    >
      {!dismissed && <ErrorToast error={error} onDismiss={() => setDismissed(true)} />}

      <div className="mb-5 flex items-center justify-between">
        <h1 className="font-display text-lg font-semibold text-ink sm:text-xl">Create</h1>
        <Segmented<Complexity>
          ariaLabel="Form complexity"
          value={complexity}
          onChange={setComplexity}
          options={[
            { value: "simple", label: "Simple" },
            { value: "advanced", label: "Advanced", icon: Sparkles },
          ]}
        />
      </div>

      {advanced ? (
        <div className="create-cq mb-6 animate-fade-in">
          <div className="create-cols">
            <div className="min-w-0">
              {titleSection}
              {vocalsSection}
              {stylesSection}

              <span className={SECTION_LABEL}>More Options</span>
              <div className="mt-3 space-y-5 rounded-el border border-white/[0.07] bg-white/[0.02] p-4">
                <ComingSoon>
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 text-sm font-medium text-ink opacity-40">
                        Thinking
                        <ComingSoonTag />
                      </p>
                      <p className="mt-0.5 text-xs leading-snug text-ink-faint">
                        Let the model plan the arrangement before it renders.
                      </p>
                    </div>
                    <Switch
                      checked={false}
                      onChange={() => undefined}
                      ariaLabel="Thinking"
                      disabled
                    />
                  </div>
                </ComingSoon>

                <div className="h-px bg-white/[0.06]" />

                <TickSlider
                  label="Length"
                  value={lengthSeconds}
                  onChange={setLengthSeconds}
                  min={LENGTH_MIN_SECONDS}
                  max={LENGTH_MAX_SECONDS}
                  step={5}
                  format={formatDuration}
                  tooltip="How long the generated track will be."
                />

                <ComingSoon>
                  <div className="mb-1 flex items-center gap-2">
                    <span className={`${FIELD_LABEL} opacity-40`}>Creativity</span>
                    <ComingSoonTag />
                  </div>
                  <TickSlider label="Creativity" value={50} onChange={() => undefined} disabled />
                </ComingSoon>
              </div>
            </div>

            <aside className="create-aside mt-5 space-y-4 rounded-el border border-white/[0.07] bg-white/[0.02] p-4">
              <span className={SECTION_LABEL}>Track Settings</span>

              <div>
                <span className={FIELD_LABEL}>Genre</span>
                <div className="mt-1.5">
                  <Select
                    ariaLabel="Genre"
                    value={genre}
                    onChange={(v) => setGenre(v as Genre | "")}
                    options={[
                      { value: "", label: "Any" },
                      ...GENRES.map((g) => ({ value: g, label: g })),
                    ]}
                  />
                </div>
              </div>

              <div>
                <span className={FIELD_LABEL}>Mood</span>
                <div className="mt-1.5">
                  <Select
                    ariaLabel="Mood"
                    value={mood}
                    onChange={(v) => setMood(v as Mood | "")}
                    options={[
                      { value: "", label: "Any" },
                      ...MOODS.map((m) => ({ value: m, label: m })),
                    ]}
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <span className={FIELD_LABEL}>Tempo</span>
                  <button
                    type="button"
                    onClick={() => setTempoAuto((a) => !a)}
                    aria-pressed={tempoAuto}
                    className={`rounded-full border px-2.5 py-0.5 text-2xs font-medium transition-colors ${
                      tempoAuto
                        ? "border-signal/30 bg-signal/15 text-ink"
                        : "border-white/10 bg-white/[0.04] text-ink-muted hover:text-ink"
                    }`}
                  >
                    Auto
                  </button>
                </div>
                {/* A range, not a single value: the API takes bpm_min/bpm_max
                    and resolves the midpoint itself. Both or neither. */}
                <div className="mt-1.5 space-y-2">
                  <TickSlider
                    label="Min BPM"
                    value={bpmMin}
                    onChange={setBpmMin}
                    min={BPM_MIN}
                    max={BPM_MAX}
                    step={1}
                    format={(v) => `${v}`}
                    disabled={tempoAuto}
                  />
                  <TickSlider
                    label="Max BPM"
                    value={bpmMax}
                    onChange={setBpmMax}
                    min={BPM_MIN}
                    max={BPM_MAX}
                    step={1}
                    format={(v) => `${v}`}
                    disabled={tempoAuto}
                  />
                </div>
                {bpmInvalid && (
                  <p className="mt-1.5 text-xs text-amber">
                    Minimum BPM must not exceed the maximum.
                  </p>
                )}
              </div>

              <div>
                <span className={FIELD_LABEL}>Voice</span>
                <div className="mt-1.5">
                  {/* Auto sits in the MIDDLE, not first: the control reads as a
                      slider between two poles with a neutral centre, which is
                      what it is. */}
                  <Segmented<Voice>
                    ariaLabel="Vocal gender"
                    size="sm"
                    value={voice}
                    onChange={setVoice}
                    options={[
                      { value: "male", label: "Male", disabled: instrumental },
                      { value: "auto", label: "Auto", disabled: instrumental },
                      { value: "female", label: "Female", disabled: instrumental },
                    ]}
                  />
                </div>
                <p className="mt-1 text-2xs text-ink-faint">
                  {/* Not filler. ACE-Step conditions on a caption token — there
                      is no gender parameter — and promising a guaranteed
                      gender is a support ticket. */}
                  {instrumental
                    ? "No vocals to shape."
                    : "A hint, not a guarantee — the model decides the timbre."}
                </p>
              </div>

              {/* Below here: no API field. Rendered so the shape of the
                  product is legible, disabled so nobody submits into a 422,
                  and tagged so nobody reports them as broken. */}
              <ComingSoon>
                <div className="mb-1.5 flex items-center gap-2">
                  <span className={`${FIELD_LABEL} opacity-40`}>Language</span>
                  <ComingSoonTag />
                </div>
                <Select
                  ariaLabel="Vocal language"
                  value="en"
                  onChange={() => undefined}
                  options={LANGUAGES}
                  disabled
                />
              </ComingSoon>

              <ComingSoon>
                <div className="mb-1.5 flex items-center gap-2">
                  <span className={`${FIELD_LABEL} opacity-40`}>Key</span>
                  <ComingSoonTag />
                </div>
                <Select
                  ariaLabel="Key and scale"
                  value="auto"
                  onChange={() => undefined}
                  options={KEYS}
                  disabled
                />
              </ComingSoon>

              <ComingSoon>
                <div className="mb-1.5 flex items-center gap-2">
                  <span className={`${FIELD_LABEL} opacity-40`}>Time signature</span>
                  <ComingSoonTag />
                </div>
                <Segmented<string>
                  ariaLabel="Time signature"
                  size="sm"
                  value="auto"
                  onChange={() => undefined}
                  options={[
                    { value: "auto", label: "Auto", disabled: true },
                    { value: "4", label: "4/4", disabled: true },
                    { value: "3", label: "3/4", disabled: true },
                  ]}
                />
              </ComingSoon>

              <ComingSoon label="Coming soon — seeds are minted server-side for now">
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2">
                    <span className={`${FIELD_LABEL} opacity-40`}>Seed</span>
                    <ComingSoonTag />
                  </span>
                  <span className="flex items-center gap-1.5 text-2xs text-ink-faint">
                    <Lock className="h-3 w-3" strokeWidth={2} />
                    Lock
                  </span>
                </div>
                <input
                  disabled
                  aria-label="Seed"
                  placeholder="Minted server-side"
                  className="glass-input tabular-nums disabled:opacity-40"
                />
              </ComingSoon>
            </aside>
          </div>
        </div>
      ) : (
        <>
          {titleSection}
          {vocalsSection}
          {stylesSection}
          <div className="mb-6">
            <TickSlider
              label="Length"
              value={lengthSeconds}
              onChange={setLengthSeconds}
              min={LENGTH_MIN_SECONDS}
              max={LENGTH_MAX_SECONDS}
              step={5}
              format={formatDuration}
              tooltip="How long the generated track will be."
            />
          </div>
        </>
      )}

      <div className="flex flex-col items-center gap-2">
        {/* Same treatment as Home's Generate — the two are the same action. */}
        <SpecularButton
          size="lg"
          radius={16}
          tint="#ffffff"
          tintOpacity={0}
          blur={5}
          textColor="#f5f5f5"
          lineColor={SPECULAR_LINE}
          baseColor={SPECULAR_BASE}
          intensity={2.5}
          shineSize={39}
          shineFade={32}
          thickness={2}
          speed={1.3}
          followMouse={false}
          proximity={140}
          autoAnimate={false}
          disabled={!canSubmit}
          onClick={onCreate}
          className="w-full max-w-[340px]"
        >
          {busy ? "Creating…" : "Create"}
        </SpecularButton>
      </div>
    </div>
  );
}
