import { useEffect, useRef, useState } from "react";
import { Sparkles, Lock, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useCreateUI } from "../../store/createUI";
import { useGenerate } from "../../hooks/useGenerate";
import { useLens } from "../../lib/useLens";
import { mergeRefs, useSpecular } from "../../lib/useSpecular";
import { formatDuration } from "../../lib/track";
import { cn } from "../../lib/cn";
import { INSTRUMENT_SUGGESTIONS } from "../../lib/suggestions";
import { useShuffledPicks } from "../../lib/useShuffledPicks";
import JobProgress from "../JobProgress";
import ErrorToast from "../ErrorToast";
import SpecularButton, { SPECULAR_BASE, SPECULAR_LINE } from "../SpecularButton";
import Segmented from "./Segmented";
import TickSlider from "./TickSlider";
import Switch from "./Switch";
import Select, { type SelectOption } from "./Select";
import ComingSoon, { COMING_SOON_DETAIL, ComingSoonTag } from "./ComingSoon";
import {
  BPM_MAX,
  BPM_MIN,
  GENRES,
  LENGTH_MAX_SECONDS,
  LENGTH_MIN_SECONDS,
  LYRICS_MAX_LENGTH,
  MAX_INSTRUMENTS,
  MOODS,
  PROMPT_MAX_LENGTH,
  type GenerateRequest,
  type Genre,
  type Mood,
} from "../../types/api";

type Complexity = "simple" | "advanced";
type LyricMode = "vocal" | "instrumental" | "write" | "describe";

/**
 * The API accepts exactly:
 *   prompt, genre, mood, bpm_min, bpm_max, instruments[<=10], vocal,
 *   length_seconds, lyrics
 *
 * Everything else here — describe, thinking, creativity, language, key, time
 * signature, seed, title — is rendered DISABLED with a visible "Coming soon"
 * tag and a hover explanation, so the shape of the product stays legible
 * without anyone mistaking an unbuilt control for a broken one. The tag and
 * the tooltip both come from <ComingSoon>, which exists because a `title` on a
 * disabled control never fires.
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

const SECTION_LABEL = "eyebrow";
const FIELD_LABEL = "text-xs font-medium text-ink-muted";

export default function CreateForm() {
  const nav = useNavigate();
  const setPlayerHeight = useCreateUI((s) => s.setPlayerHeight);

  const [complexity, setComplexity] = useState<Complexity>("simple");
  // Write is the landing state: the lyrics editor is the reason most people
  // open this page, and an empty box still means "you write the words", so
  // defaulting here costs nothing for the users who never touch it.
  const [lyricMode, setLyricMode] = useState<LyricMode>("write");
  const [prompt, setPrompt] = useState("");
  const [lyrics, setLyrics] = useState("");
  const [genre, setGenre] = useState<Genre | "">("");
  const [mood, setMood] = useState<Mood | "">("");
  const [instruments, setInstruments] = useState<string[]>([]);
  const [instrumentDraft, setInstrumentDraft] = useState("");
  const [lengthSeconds, setLengthSeconds] = useState(90);
  const [tempoAuto, setTempoAuto] = useState(true);
  const [bpmMin, setBpmMin] = useState(90);
  const [bpmMax, setBpmMax] = useState(130);
  const [dismissed, setDismissed] = useState(false);

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

  const { generate, stream, busy, error } = useGenerate({
    onCompleted: (trackId) => {
      if (trackId) nav(`/track/${trackId}`);
    },
  });

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
      genre: genre === "" ? null : genre,
      mood: mood === "" ? null : mood,
      // Both or neither — the API validates the pair, so never send one alone.
      bpm_min: tempoAuto ? null : bpmMin,
      bpm_max: tempoAuto ? null : bpmMax,
      instruments,
      vocal: lyricMode !== "instrumental",
      length_seconds: lengthSeconds,
      // Only in Write mode, and only if there is anything to send — "" and
      // null both mean "you write the words", and null is what the API wants.
      // Sent alongside vocal=false is a 422 by design; the mode check is what
      // guarantees the two can never disagree.
      lyrics: lyricMode === "write" && lyrics.trim() ? lyrics.trim() : null,
    };
    generate.mutate(body);
  }

  const vocalsSection = (
    <section className="mb-5">
      <div className="mb-2.5 flex items-center justify-between">
        <span className={SECTION_LABEL}>Vocals</span>
        <Segmented<LyricMode>
          ariaLabel="Vocal mode"
          size="sm"
          value={lyricMode}
          onChange={setLyricMode}
          options={[
            { value: "write", label: "Write" },
            { value: "vocal", label: "Sung" },
            { value: "instrumental", label: "Instrumental" },
            { value: "describe", label: "Describe", disabled: true, title: COMING_SOON_DETAIL },
          ]}
        />
      </div>

      {lyricMode === "write" ? (
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
                // Create, because Write is where the page opens.
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
      ) : (
        <p className="rounded-el border border-white/10 bg-white/[0.03] px-4 py-3 text-xs leading-relaxed text-ink-faint">
          {lyricMode === "instrumental"
            ? "Instrumental — no vocals. RITHM will compose music only."
            : "RITHM writes the words to match your description. Switch to Write to supply your own."}
        </p>
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
      <JobProgress stream={stream} />
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

              <ComingSoon>
                <div className="mb-1.5 flex items-center gap-2">
                  <span className={`${FIELD_LABEL} opacity-40`}>Song title</span>
                  <ComingSoonTag />
                </div>
                <input
                  disabled
                  aria-label="Song title"
                  placeholder="Named from your prompt"
                  className="glass-input disabled:opacity-40"
                />
              </ComingSoon>
            </aside>
          </div>
        </div>
      ) : (
        <>
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
