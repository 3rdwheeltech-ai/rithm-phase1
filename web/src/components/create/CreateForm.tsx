import { useEffect, useRef, useState } from "react";
import { Sparkles, Lock } from "lucide-react";
import { useCreateUI } from "../../store/createUI";
import { useGeneration } from "../../store/generation";
import type { GenerateParams } from "../../services/musicgen";
import Segmented from "./Segmented";
import TickSlider from "./TickSlider";
import Switch from "./Switch";
import Select, { type SelectOption } from "./Select";

type Complexity = "simple" | "advanced";
type LyricTab = "write" | "prompt" | "instrumental";
type VocalGender = "any" | "male" | "female";
type TimeSig = "auto" | "4" | "3" | "6";

// Genre chips — appended to the prompt text.
const GENRES = [
  "opera metal",
  "lo-fi",
  "synthwave",
  "flamenco",
  "tenor male vocals",
  "psychedelic pop",
  "guitarra eléctrica",
  "cinematic",
  "powerful male voice",
  "harmonies",
];

// vocal_language codes the model understands.
const LANGUAGES: SelectOption[] = [
  { value: "en", label: "English" },
  { value: "zh", label: "Mandarin" },
  { value: "ja", label: "Japanese" },
  { value: "ko", label: "Korean" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "it", label: "Italian" },
  { value: "pt", label: "Portuguese" },
  { value: "hi", label: "Hindi" },
];

// key_scale values ("auto" → omit, let the LM choose).
const KEYS: SelectOption[] = [
  { value: "auto", label: "Auto" },
  { value: "C Major", label: "C Major" },
  { value: "G Major", label: "G Major" },
  { value: "D Major", label: "D Major" },
  { value: "A Major", label: "A Major" },
  { value: "F Major", label: "F Major" },
  { value: "A Minor", label: "A Minor" },
  { value: "E Minor", label: "E Minor" },
  { value: "D Minor", label: "D Minor" },
  { value: "C Minor", label: "C Minor" },
];

const SECTION_LABEL = "text-[11px] font-semibold uppercase tracking-[0.18em] text-brand-soft";
const FIELD_LABEL = "text-[12px] font-medium text-ink-muted";

const fmtDuration = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;

export default function CreateForm() {
  const setPlayerHeight = useCreateUI((s) => s.setPlayerHeight);
  const { start, status, error, current } = useGeneration();
  const busy = status === "generating";

  const [complexity, setComplexity] = useState<Complexity>("simple");
  const [lyricTab, setLyricTab] = useState<LyricTab>("write");
  const [lyrics, setLyrics] = useState("");
  const [lyricPrompt, setLyricPrompt] = useState("");
  const [styles, setStyles] = useState("");
  const [genres, setGenres] = useState<string[]>([]);
  const [title, setTitle] = useState("");

  // Advanced controls (mapped 1:1 to ACE-Step fields; defaults omit the field).
  const [thinking, setThinking] = useState(true);
  const [duration, setDuration] = useState(90); // seconds
  const [creativity, setCreativity] = useState(50); // → lm_temperature
  const [language, setLanguage] = useState("en");
  const [vocalGender, setVocalGender] = useState<VocalGender>("any");
  const [tempoAuto, setTempoAuto] = useState(true);
  const [bpm, setBpm] = useState(120);
  const [timeSig, setTimeSig] = useState<TimeSig>("auto");
  const [keyScale, setKeyScale] = useState("auto");
  const [seedLock, setSeedLock] = useState(false);
  const [seedText, setSeedText] = useState("");

  const advanced = complexity === "advanced";
  const cardRef = useRef<HTMLDivElement>(null);

  // Publish the form's rendered height so the docked Player can grow with it.
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setPlayerHeight(entry.contentRect.height);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      setPlayerHeight(null);
    };
  }, [setPlayerHeight]);

  function toggleGenre(g: string) {
    setGenres((prev) => (prev.includes(g) ? prev.filter((x) => x !== g) : [...prev, g]));
  }

  // Locking the seed prefills the last generated seed so it's easy to reproduce.
  function toggleSeedLock(next: boolean) {
    setSeedLock(next);
    if (next && !seedText && current?.seed) setSeedText(current.seed.split(",")[0]!);
  }

  function onCreate() {
    const promptParts = [styles, ...genres];
    if (lyricTab === "prompt" && lyricPrompt.trim()) promptParts.push(lyricPrompt.trim());
    if (advanced && vocalGender !== "any") promptParts.push(`${vocalGender} vocals`);

    const lyricsValue =
      lyricTab === "write" ? lyrics
      : lyricTab === "instrumental" ? "[instrumental]"
      : ""; // "prompt" → LM drafts lyrics (needs thinking)

    const params: GenerateParams = {
      prompt: promptParts.filter(Boolean).join(", "),
      lyrics: lyricsValue,
      title: title || undefined,
    };

    if (advanced) {
      params.thinking = thinking;
      params.audioDuration = duration;
      params.vocalLanguage = language;
      if (thinking) params.lmTemperature = 0.5 + (creativity / 100) * 0.7;
      if (!tempoAuto) params.bpm = bpm;
      if (timeSig !== "auto") params.timeSignature = timeSig;
      if (keyScale !== "auto") params.keyScale = keyScale;
      const seedNum = Number(seedText);
      if (seedLock && Number.isFinite(seedNum) && seedText.trim() !== "") {
        params.useRandomSeed = false;
        params.seed = seedNum;
      }
    }

    void start(params);
  }

  // Primary inputs — shared by both layouts (left column when Advanced).
  const lyricsSection = (
    <section className="mb-5">
      <div className="mb-2.5 flex items-center justify-between">
        <span className={SECTION_LABEL}>Lyrics</span>
        <Segmented<LyricTab>
          ariaLabel="Lyric mode"
          size="sm"
          value={lyricTab}
          onChange={setLyricTab}
          options={[
            { value: "write", label: "Write" },
            { value: "prompt", label: "Prompt" },
            { value: "instrumental", label: "Instrumental" },
          ]}
        />
      </div>

      {lyricTab === "write" && (
        <textarea
          value={lyrics}
          onChange={(e) => setLyrics(e.target.value)}
          placeholder="Write your own lyrics, or use the tabs to let RITHM draft them…"
          className="glass-input min-h-[120px] resize-none leading-relaxed"
        />
      )}
      {lyricTab === "prompt" && (
        <>
          <textarea
            value={lyricPrompt}
            onChange={(e) => setLyricPrompt(e.target.value)}
            placeholder="Describe what the song is about and RITHM will write the lyrics…"
            className="glass-input min-h-[120px] resize-none leading-relaxed"
          />
          {advanced && !thinking && (
            <p className="mt-2 text-[12px] text-amber-300/80">
              Turn on Thinking for RITHM to draft lyrics from your description.
            </p>
          )}
        </>
      )}
      {lyricTab === "instrumental" && (
        <p className="rounded-el border border-white/10 bg-white/[0.03] px-4 py-6 text-center text-[13px] text-ink-faint">
          Instrumental — no lyrics. RITHM will compose music only.
        </p>
      )}
    </section>
  );

  const stylesSection = (
    <section className="mb-5">
      <span className={SECTION_LABEL}>Styles</span>
      <textarea
        value={styles}
        onChange={(e) => setStyles(e.target.value)}
        placeholder="e.g. opera metal, hard-hitting drums, powerful male voice, cinematic build…"
        className="glass-input mt-2.5 min-h-[72px] resize-none leading-relaxed"
      />
      <div className="mt-3 flex flex-wrap gap-2">
        {GENRES.map((g) => {
          const active = genres.includes(g);
          return (
            <button
              key={g}
              type="button"
              onClick={() => toggleGenre(g)}
              aria-pressed={active}
              className={`rounded-full border px-3 py-1.5 text-[12.5px] font-medium transition-colors ${
                active
                  ? "border-brand/25 bg-brand/15 text-ink"
                  : "border-white/10 bg-white/[0.035] text-ink-muted hover:border-white/15 hover:bg-white/[0.07] hover:text-ink"
              }`}
            >
              {g}
            </button>
          );
        })}
      </div>
    </section>
  );

  return (
    <div ref={cardRef} className="glass-panel w-full p-6">
      {/* Top bar: Simple / Advanced */}
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
        /* Advanced: inputs + sliders on the left, settings rail on the right.
           Becomes two columns once the box is wide enough (container query). */
        <div className="create-cq mb-6 animate-fade-in">
          <div className="create-cols">
            {/* LEFT — primary inputs + sliders */}
            <div className="min-w-0">
              {lyricsSection}
              {stylesSection}

              <span className={SECTION_LABEL}>More Options</span>
              <div className="mt-3 space-y-5 rounded-el border border-white/[0.07] bg-white/[0.02] p-4">
                {/* Thinking — headline switch */}
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-ink">Thinking</p>
                    <p className="mt-0.5 text-[12px] leading-snug text-ink-faint">
                      5Hz LM enhances quality, drafts lyrics in Prompt mode, and fills any blanks below.
                    </p>
                  </div>
                  <Switch checked={thinking} onChange={setThinking} ariaLabel="Thinking" />
                </div>

                <div className="h-px bg-white/[0.06]" />

                {/* Duration */}
                <TickSlider
                  label="Duration"
                  value={duration}
                  onChange={setDuration}
                  min={30}
                  max={240}
                  step={10}
                  format={fmtDuration}
                  tooltip="How long the generated track will be."
                />

                {/* Creativity → lm_temperature (only meaningful with Thinking) */}
                <TickSlider
                  label="Creativity"
                  value={creativity}
                  onChange={setCreativity}
                  disabled={!thinking}
                  tooltip="Higher values let the model take more risks."
                />
              </div>
            </div>

            {/* RIGHT — track settings rail */}
            <aside className="create-aside mt-5 space-y-4 rounded-el border border-white/[0.07] bg-white/[0.02] p-4">
              <span className={SECTION_LABEL}>Track Settings</span>

              {/* Language */}
              <div>
                <span className={FIELD_LABEL}>Language</span>
                <div className="mt-1.5">
                  <Select ariaLabel="Vocal language" value={language} onChange={setLanguage} options={LANGUAGES} />
                </div>
              </div>

              {/* Vocal gender */}
              <div>
                <span className={FIELD_LABEL}>Vocals</span>
                <div className="mt-1.5">
                  <Segmented<VocalGender>
                    ariaLabel="Vocal gender"
                    size="sm"
                    value={vocalGender}
                    onChange={setVocalGender}
                    options={[
                      { value: "any", label: "Any" },
                      { value: "male", label: "Male" },
                      { value: "female", label: "Female" },
                    ]}
                  />
                </div>
              </div>

              {/* Tempo */}
              <div>
                <div className="flex items-center justify-between">
                  <span className={FIELD_LABEL}>Tempo</span>
                  <button
                    type="button"
                    onClick={() => setTempoAuto((a) => !a)}
                    className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
                      tempoAuto
                        ? "border-brand/30 bg-brand/15 text-ink"
                        : "border-white/10 bg-white/[0.04] text-ink-muted hover:text-ink"
                    }`}
                  >
                    Auto
                  </button>
                </div>
                <div className="mt-1.5">
                  <TickSlider
                    label="BPM"
                    value={bpm}
                    onChange={setBpm}
                    min={60}
                    max={180}
                    step={1}
                    format={(v) => `${v} BPM`}
                    disabled={tempoAuto}
                    tooltip="Beats per minute — the track's tempo."
                  />
                </div>
              </div>

              {/* Time signature */}
              <div>
                <span className={FIELD_LABEL}>Time signature</span>
                <div className="mt-1.5">
                  <Segmented<TimeSig>
                    ariaLabel="Time signature"
                    size="sm"
                    value={timeSig}
                    onChange={setTimeSig}
                    options={[
                      { value: "auto", label: "Auto" },
                      { value: "4", label: "4/4" },
                      { value: "3", label: "3/4" },
                      { value: "6", label: "6/8" },
                    ]}
                  />
                </div>
              </div>

              {/* Key */}
              <div>
                <span className={FIELD_LABEL}>Key</span>
                <div className="mt-1.5">
                  <Select ariaLabel="Key & scale" value={keyScale} onChange={setKeyScale} options={KEYS} />
                </div>
              </div>

              {/* Seed */}
              <div>
                <div className="flex items-center justify-between">
                  <span className={FIELD_LABEL}>Seed</span>
                  <span className="flex items-center gap-1.5 text-[11px] text-ink-faint">
                    <Lock className="h-3 w-3" strokeWidth={2} />
                    Lock
                    <Switch checked={seedLock} onChange={toggleSeedLock} ariaLabel="Lock seed" />
                  </span>
                </div>
                <input
                  value={seedText}
                  onChange={(e) => setSeedText(e.target.value.replace(/[^0-9]/g, ""))}
                  disabled={!seedLock}
                  inputMode="numeric"
                  placeholder={seedLock ? "e.g. 4173934271" : "Random each run"}
                  className="glass-input mt-1.5 tabular-nums disabled:opacity-40"
                />
              </div>

              {/* Song title */}
              <div>
                <span className={FIELD_LABEL}>Song Title</span>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Optional — names the track in your Library"
                  className="glass-input mt-1.5"
                />
              </div>
            </aside>
          </div>
        </div>
      ) : (
        <>
          {lyricsSection}
          {stylesSection}
        </>
      )}

      {/* Create */}
      <div className="flex flex-col items-center gap-2">
        <div className="ai-frame-btn w-full max-w-[340px]">
          <button
            type="button"
            onClick={onCreate}
            disabled={busy}
            className="glass-btn glass-btn-solid w-full rounded-el px-6 py-3 text-[14.5px] font-semibold"
          >
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
        {error && <span className="text-[12.5px] text-red-300">{error}</span>}
      </div>
    </div>
  );
}
