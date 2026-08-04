import { useRef, useState } from "react";
import { Music } from "lucide-react";
import { useNavigate } from "react-router-dom";
import Segmented from "./create/Segmented";
import TickSlider from "./create/TickSlider";
import JobProgress from "./JobProgress";
import ErrorToast from "./ErrorToast";
import { useGenerate } from "../hooks/useGenerate";
import { formatDuration } from "../lib/track";
import {
  LENGTH_MAX_SECONDS,
  LENGTH_MIN_SECONDS,
  PROMPT_MAX_LENGTH,
  type GenerateRequest,
} from "../types/api";

// Example prompts shown as chips below the box.
const SUGGESTIONS = [
  "Dreamy lo-fi with warm piano and soft rain",
  "Upbeat synthwave for a midnight drive",
  "Cinematic orchestral build with epic drums",
];

/** Write / Prompt have no API field — see the Vocals control below. */
type LyricMode = "vocal" | "instrumental" | "write";

export default function QuickGenerate() {
  const nav = useNavigate();
  const [prompt, setPrompt] = useState("");
  const [lyricMode, setLyricMode] = useState<LyricMode>("vocal");
  const [lengthSeconds, setLengthSeconds] = useState(90);
  const [dismissed, setDismissed] = useState(false);

  const promptRef = useRef<HTMLTextAreaElement>(null);
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
    };
    generate.mutate(body);
  }

  return (
    <div className="animate-rise">
      <JobProgress stream={stream} />
      {!dismissed && <ErrorToast error={error} onDismiss={() => setDismissed(true)} />}

      <div className="ai-frame">
        <div className="quick-surface p-5">
          <textarea
            ref={promptRef}
            value={prompt}
            maxLength={PROMPT_MAX_LENGTH}
            onChange={(e) => setPrompt(e.target.value)}
            aria-label="Describe the music you want"
            placeholder="Describe the music you want to create… e.g. dreamy lo-fi with warm piano and soft rain"
            className="min-h-[92px] w-full resize-none bg-transparent text-[15px] leading-relaxed text-ink outline-none placeholder:text-ink-faint"
          />
          {prompt.length > 1800 && (
            <p className="text-right text-[11.5px] tabular-nums text-ink-faint">
              {prompt.length} / {PROMPT_MAX_LENGTH}
            </p>
          )}

          <div className="my-4 h-px bg-white/[0.07]" />

          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="text-[12px] font-medium text-ink-muted">Vocals</span>
              <Segmented<LyricMode>
                ariaLabel="Vocals"
                size="sm"
                value={lyricMode}
                onChange={setLyricMode}
                options={[
                  { value: "vocal", label: "Sung" },
                  { value: "instrumental", label: "Instrumental" },
                  {
                    // There is no user-lyrics path: the worker sends
                    // "[Instrumental]" or lets the model write the words. Shown
                    // disabled rather than hidden.
                    value: "write",
                    label: "Write lyrics",
                    disabled: true,
                    title: "Writing your own lyrics is coming later",
                  },
                ]}
              />
            </div>

            <div className="min-w-[240px] flex-1">
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
                className="glass-btn glass-btn-solid w-full rounded-el px-6 py-3 text-[14.5px] font-semibold disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? "Generating…" : "Generate"}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap justify-center gap-2">
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => setPrompt(suggestion)}
            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.035] py-1.5 pl-3 pr-3.5 text-[12.5px] text-ink-muted transition-colors hover:border-white/15 hover:bg-white/[0.07] hover:text-ink"
          >
            <Music className="h-3.5 w-3.5 flex-shrink-0 text-brand-soft" strokeWidth={1.75} />
            <span className="max-w-[230px] truncate">{suggestion}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
