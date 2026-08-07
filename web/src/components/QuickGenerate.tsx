import { useRef, useState } from "react";
import { Music } from "lucide-react";
import { useNavigate } from "react-router-dom";
import Segmented from "./create/Segmented";
import TickSlider from "./create/TickSlider";
import JobProgress from "./JobProgress";
import ErrorToast from "./ErrorToast";
import { useGenerate } from "../hooks/useGenerate";
import { cn } from "../lib/cn";
import { useLens } from "../lib/useLens";
import { mergeRefs, useSpecular } from "../lib/useSpecular";
import { formatDuration } from "../lib/track";
import { PROMPT_SUGGESTIONS } from "../lib/suggestions";
import { useShuffledPicks } from "../lib/useShuffledPicks";
import {
  LENGTH_MAX_SECONDS,
  LENGTH_MIN_SECONDS,
  PROMPT_MAX_LENGTH,
  type GenerateRequest,
} from "../types/api";

/** Three at a time, drawn from the twenty in PROMPT_SUGGESTIONS. */
const VISIBLE_SUGGESTIONS = 3;

/** "write" is never held as state here — it routes to /create. See below. */
type LyricMode = "vocal" | "instrumental" | "write";

export default function QuickGenerate() {
  const nav = useNavigate();
  const [prompt, setPrompt] = useState("");
  const [lyricMode, setLyricMode] = useState<LyricMode>("vocal");
  const [lengthSeconds, setLengthSeconds] = useState(90);
  const [dismissed, setDismissed] = useState(false);

  const promptRef = useRef<HTMLTextAreaElement>(null);
  const suggestions = useShuffledPicks(PROMPT_SUGGESTIONS, VISIBLE_SUGGESTIONS);

  // The one surface on Home that sits directly over the field's bright pole, so
  // it is the one where refraction is actually visible. Radius matches `--r`.
  const lensRef = useLens<HTMLDivElement>("md", 24);
  const specularRef = useSpecular<HTMLDivElement>();

  const { generate, stream, busy, error } = useGenerate({
    onCompleted: (trackId) => {
      if (trackId) nav(`/track/${trackId}`);
    },
  });

  const canGenerate = prompt.trim().length > 0 && !busy;

  function onGenerate() {
    if (busy) return;
    if (prompt.trim().length === 0) {
      promptRef.current?.focus();
      return;
    }
    setDismissed(false);
    const body: GenerateRequest = {
      prompt: prompt.trim(),
      // The quick surface takes defaults for everything else; /create is where
      // genre, mood, BPM and instruments live.
      genre: null,
      mood: null,
      bpm_min: null,
      bpm_max: null,
      instruments: [],
      vocal: lyricMode !== "instrumental",
      length_seconds: lengthSeconds,
      lyrics: null,
    };
    generate.mutate(body);
  }

  return (
    <div className="animate-rise">
      <JobProgress stream={stream} />
      {!dismissed && <ErrorToast error={error} onDismiss={() => setDismissed(true)} />}

      <div className="ai-frame">
        <div ref={mergeRefs(lensRef, specularRef)} className="quick-surface p-4 sm:p-5">
          <textarea
            ref={promptRef}
            value={prompt}
            maxLength={PROMPT_MAX_LENGTH}
            onChange={(e) => setPrompt(e.target.value)}
            aria-label="Describe the music you want"
            placeholder="Describe the music you want to create… e.g. dreamy lo-fi with warm piano and soft rain"
            className="min-h-[92px] w-full resize-none bg-transparent text-md leading-relaxed text-ink outline-none placeholder:text-ink-faint"
          />
          {prompt.length > 1800 && (
            <p className="text-right font-mono text-2xs tabular-nums text-ink-faint">
              {prompt.length} / {PROMPT_MAX_LENGTH}
            </p>
          )}

          <div className="my-4 h-px bg-white/[0.07]" />

          <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="text-xs font-medium text-ink-muted">Vocals</span>
              <Segmented<LyricMode>
                ariaLabel="Vocals"
                size="sm"
                value={lyricMode}
                // "Write lyrics" is a door, not a mode: the quick surface has
                // no room for a lyrics editor, so it hands off to /create
                // rather than sitting there disabled.
                onChange={(v) => (v === "write" ? nav("/create") : setLyricMode(v))}
                options={[
                  { value: "vocal", label: "Sung" },
                  { value: "instrumental", label: "Instrumental" },
                  {
                    value: "write",
                    label: "Write lyrics",
                    title: "Write your own lyrics in the full Create page",
                  },
                ]}
              />
            </div>

            <div className="w-full sm:min-w-[240px] sm:flex-1">
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
          </div>

          <div className="mt-5 flex flex-col items-center gap-2">
            <div className={`w-full max-w-[340px] ${busy ? "" : "ai-frame-btn"}`}>
              <button
                type="button"
                disabled={!canGenerate}
                onClick={onGenerate}
                className="glass-btn glass-btn-solid min-h-[48px] w-full rounded-el px-6 text-base font-semibold disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? "Generating…" : "Generate"}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div
        // Reserves the row's height so the page does not jolt mid-rotation.
        className={cn(
          "mt-4 flex min-h-[36px] flex-wrap justify-center gap-2",
          suggestions.phase === "out" && "chips-out",
          suggestions.phase === "in" && "chips-in",
        )}
      >
        {suggestions.picks.map((suggestion) => (
          <button
            // Keyed by cycle too, so a rotation remounts the chip and a single
            // post-pick swap animates on its own without the row moving.
            key={`${suggestions.cycle}-${suggestion}`}
            type="button"
            onClick={() => {
              setPrompt(suggestion);
              suggestions.replace(suggestion);
              promptRef.current?.focus();
            }}
            className="chip-swap inline-flex min-h-[36px] items-center gap-2 rounded-full border border-white/10 bg-white/[0.035] pl-3 pr-3.5 text-xs text-ink-muted transition-colors hover:border-white/15 hover:bg-white/[0.07] hover:text-ink"
          >
            <Music className="h-3.5 w-3.5 flex-shrink-0 text-signal-bright" strokeWidth={1.75} />
            <span className="max-w-[200px] truncate sm:max-w-[230px]">{suggestion}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
