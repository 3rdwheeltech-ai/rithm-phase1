import { useEffect, useRef, useState } from "react";
import { Sparkles, Lock, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useCreateUI } from "../../store/createUI";
import { useGenerate } from "../../hooks/useGenerate";
import { formatDuration } from "../../lib/track";
import JobProgress from "../JobProgress";
import ErrorToast from "../ErrorToast";
import Segmented from "./Segmented";
import TickSlider from "./TickSlider";
import Switch from "./Switch";
import Select, { type SelectOption } from "./Select";
import {
  BPM_MAX,
  BPM_MIN,
  GENRES,
  LENGTH_MAX_SECONDS,
  LENGTH_MIN_SECONDS,
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
 * Controls with no field on GenerateRequest are rendered DISABLED with a
 * reason, not removed. The API accepts exactly:
 *   prompt, genre, mood, bpm_min, bpm_max, instruments[<=10], vocal,
 *   length_seconds
 * Everything else here — lyrics, thinking, creativity, language, key, time
 * signature, seed, title — has no backend to carry it in Phase 1.
 */
const COMING_SOON = "Coming later — the API has no field for this yet";

const SUGGESTED_INSTRUMENTS = [
  "piano",
  "electric guitar",
  "synth pads",
  "strings",
  "drums",
  "bass",
  "saxophone",
  "vinyl crackle",
];

const LANGUAGES: SelectOption[] = [{ value: "en", label: "English" }];
const KEYS: SelectOption[] = [{ value: "auto", label: "Auto" }];

const SECTION_LABEL = "text-[11px] font-semibold uppercase tracking-[0.18em] text-brand-soft";
const FIELD_LABEL = "text-[12px] font-medium text-ink-muted";

export default function CreateForm() {
  const nav = useNavigate();
  const setPlayerHeight = useCreateUI((s) => s.setPlayerHeight);

  const [complexity, setComplexity] = useState<Complexity>("simple");
  const [lyricMode, setLyricMode] = useState<LyricMode>("vocal");
  const [prompt, setPrompt] = useState("");
  const [genre, setGenre] = useState<Genre | "">("");
  const [mood, setMood] = useState<Mood | "">("");
  const [instruments, setInstruments] = useState<string[]>([]);
  const [instrumentDraft, setInstrumentDraft] = useState("");
  const [lengthSeconds, setLengthSeconds] = useState(90);
  const [tempoAuto, setTempoAuto] = useState(true);
  const [bpmMin, setBpmMin] = useState(90);
  const [bpmMax, setBpmMax] = useState(130);
  const [dismissed, setDismissed] = useState(false);

  const advanced = complexity === "advanced";
  const cardRef = useRef<HTMLDivElement>(null);

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
            { value: "vocal", label: "Sung" },
            { value: "instrumental", label: "Instrumental" },
            { value: "write", label: "Write", disabled: true, title: COMING_SOON },
            { value: "describe", label: "Describe", disabled: true, title: COMING_SOON },
          ]}
        />
      </div>
      <p className="rounded-el border border-white/10 bg-white/[0.03] px-4 py-3 text-[12.5px] leading-relaxed text-ink-faint">
        {lyricMode === "instrumental"
          ? "Instrumental — no vocals. RITHM will compose music only."
          : "RITHM writes the words to match your description. Supplying your own lyrics is coming later."}
      </p>
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
        <p className="mt-1 text-right text-[11.5px] tabular-nums text-ink-faint">
          {prompt.length} / {PROMPT_MAX_LENGTH}
        </p>
      )}

      <div className="mt-4">
        <div className="flex items-center justify-between">
          <span className={FIELD_LABEL}>Instruments</span>
          <span className="text-[11.5px] tabular-nums text-ink-faint">
            {instruments.length} / {MAX_INSTRUMENTS}
          </span>
        </div>

        {instruments.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {instruments.map((instrument) => (
              <span
                key={instrument}
                className="inline-flex items-center gap-1.5 rounded-full border border-brand/25 bg-brand/15 px-3 py-1 text-[12.5px] font-medium text-ink"
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

        <div className="mt-3 flex flex-wrap gap-2">
          {SUGGESTED_INSTRUMENTS.filter((i) => !instruments.includes(i)).map((instrument) => (
            <button
              key={instrument}
              type="button"
              onClick={() => addInstrument(instrument)}
              disabled={instruments.length >= MAX_INSTRUMENTS}
              className="rounded-full border border-white/10 bg-white/[0.035] px-3 py-1.5 text-[12.5px] font-medium text-ink-muted transition-colors hover:border-white/15 hover:bg-white/[0.07] hover:text-ink disabled:opacity-30"
            >
              {instrument}
            </button>
          ))}
        </div>
      </div>
    </section>
  );

  return (
    <div ref={cardRef} className="glass-panel w-full p-6">
      <JobProgress stream={stream} />
      {!dismissed && <ErrorToast error={error} onDismiss={() => setDismissed(true)} />}

      <div className="mb-5 flex items-center justify-between">
        <h1 className="text-[20px] font-semibold tracking-[-0.02em] text-ink">Create</h1>
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
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-ink">Thinking</p>
                    <p className="mt-0.5 text-[12px] leading-snug text-ink-faint">{COMING_SOON}.</p>
                  </div>
                  <Switch
                    checked={false}
                    onChange={() => undefined}
                    ariaLabel="Thinking"
                    disabled
                    title={COMING_SOON}
                  />
                </div>

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

                <TickSlider
                  label="Creativity"
                  value={50}
                  onChange={() => undefined}
                  disabled
                  tooltip={COMING_SOON}
                />
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
                    className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
                      tempoAuto
                        ? "border-brand/30 bg-brand/15 text-ink"
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
                  <p className="mt-1.5 text-[12px] text-amber-300/90">
                    Minimum BPM must not exceed the maximum.
                  </p>
                )}
              </div>

              {/* Below here: no API field. Rendered so the shape of the product
                  is legible, disabled so nobody submits into a 422. */}
              <div>
                <span className={FIELD_LABEL}>Language</span>
                <div className="mt-1.5">
                  <Select
                    ariaLabel="Vocal language"
                    value="en"
                    onChange={() => undefined}
                    options={LANGUAGES}
                    disabled
                    title={COMING_SOON}
                  />
                </div>
              </div>

              <div>
                <span className={FIELD_LABEL}>Key</span>
                <div className="mt-1.5">
                  <Select
                    ariaLabel="Key and scale"
                    value="auto"
                    onChange={() => undefined}
                    options={KEYS}
                    disabled
                    title={COMING_SOON}
                  />
                </div>
              </div>

              <div>
                <span className={FIELD_LABEL}>Time signature</span>
                <div className="mt-1.5">
                  <Segmented<string>
                    ariaLabel="Time signature"
                    size="sm"
                    value="auto"
                    onChange={() => undefined}
                    options={[
                      { value: "auto", label: "Auto", disabled: true, title: COMING_SOON },
                      { value: "4", label: "4/4", disabled: true, title: COMING_SOON },
                      { value: "3", label: "3/4", disabled: true, title: COMING_SOON },
                    ]}
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <span className={FIELD_LABEL}>Seed</span>
                  <span className="flex items-center gap-1.5 text-[11px] text-ink-faint">
                    <Lock className="h-3 w-3" strokeWidth={2} />
                    Lock
                  </span>
                </div>
                <input
                  disabled
                  title={COMING_SOON}
                  aria-label="Seed"
                  placeholder="Minted server-side"
                  className="glass-input mt-1.5 tabular-nums disabled:opacity-40"
                />
              </div>

              <div>
                <span className={FIELD_LABEL}>Song title</span>
                <input
                  disabled
                  title={COMING_SOON}
                  aria-label="Song title"
                  placeholder="Named from your prompt"
                  className="glass-input mt-1.5 disabled:opacity-40"
                />
              </div>
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
        <div className={`w-full max-w-[340px] ${busy ? "" : "ai-frame-btn"}`}>
          <button
            type="button"
            onClick={onCreate}
            disabled={!canSubmit}
            className="glass-btn glass-btn-solid w-full rounded-el px-6 py-3 text-[14.5px] font-semibold disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
