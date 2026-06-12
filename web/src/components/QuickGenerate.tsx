import { useEffect, useRef, useState } from "react";
import { ChevronDown, Plus, Check, Music } from "lucide-react";
import { useGeneration } from "../store/generation";

interface SampleLyric {
  id: string;
  title: string;
  excerpt: string;
}

// Mock "previously used" lyrics — real history arrives with the Phase 2 backend.
const SAMPLE_LYRICS: SampleLyric[] = [
  { id: "midnight-drive", title: "Midnight Drive", excerpt: "City lights blur as we ride through the dark…" },
  { id: "neon-rain", title: "Neon Rain", excerpt: "Falling colours on the avenue tonight…" },
  { id: "golden-hour", title: "Golden Hour", excerpt: "Hold me close till the daylight fades…" },
];

// Example prompts shown as chips below the box (Stitch-style).
const SUGGESTIONS = [
  "Dreamy lo-fi with warm piano and soft rain",
  "Upbeat synthwave for a midnight drive",
  "Cinematic orchestral build with epic drums",
];

type Lyric =
  | { kind: "none" }
  | { kind: "preview"; id: string; title: string; excerpt: string }
  | { kind: "custom" };

export default function QuickGenerate() {
  const [prompt, setPrompt] = useState("");
  const [lyric, setLyric] = useState<Lyric>({ kind: "none" });
  const [customLyric, setCustomLyric] = useState("");
  const [open, setOpen] = useState(false);

  const { start, status, error } = useGeneration();
  const busy = status === "generating";

  const menuRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const lyricLabel =
    lyric.kind === "none" ? "Add lyric" : lyric.kind === "custom" ? "Custom lyric" : lyric.title;

  const canGenerate = prompt.trim().length > 0;

  function onGenerate() {
    if (busy) return;
    if (!canGenerate) {
      promptRef.current?.focus(); // nudge the user to describe a track first
      return;
    }
    const lyrics =
      lyric.kind === "custom" ? customLyric
      : lyric.kind === "preview" ? lyric.excerpt
      : "";
    void start({ prompt: prompt.trim(), lyrics });
  }

  return (
    <div className="animate-rise">
      <div className="ai-frame">
        <div className="quick-surface p-5">
          {/* Prompt */}
          <textarea
            ref={promptRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe the music you want to create… e.g. dreamy lo-fi with warm piano and soft rain"
            className="min-h-[92px] w-full resize-none bg-transparent text-[15px] leading-relaxed text-ink outline-none placeholder:text-ink-faint"
          />

          <div className="my-4 h-px bg-white/[0.07]" />

          {/* Lyric picker — full width */}
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-haspopup="listbox"
              aria-expanded={open}
              className="flex w-full items-center justify-between gap-2 rounded-el border border-white/10 bg-white/[0.04] px-4 py-2.5 text-[13.5px] font-medium text-ink-muted transition-colors hover:bg-white/[0.07] hover:text-ink"
            >
              <span className="flex items-center gap-2">
                {lyric.kind === "none" ? (
                  <Plus className="h-4 w-4" strokeWidth={1.75} />
                ) : (
                  <Check className="h-4 w-4 text-brand-soft" strokeWidth={2} />
                )}
                {lyricLabel}
              </span>
              <ChevronDown
                className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`}
                strokeWidth={1.75}
              />
            </button>

            {open && (
              <div className="quick-surface absolute bottom-full left-0 z-30 mb-2 w-full !rounded-el p-1.5">
                {SAMPLE_LYRICS.map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => {
                      setLyric({ kind: "preview", id: l.id, title: l.title, excerpt: l.excerpt });
                      setOpen(false);
                    }}
                    className="flex w-full flex-col gap-0.5 rounded-[9px] px-3 py-2 text-left transition-colors hover:bg-white/[0.06]"
                  >
                    <span className="text-[13.5px] font-medium text-ink">{l.title}</span>
                    <span className="truncate text-[12px] text-ink-faint">{l.excerpt}</span>
                  </button>
                ))}
                <div className="my-1 h-px bg-white/[0.07]" />
                <button
                  type="button"
                  onClick={() => {
                    setLyric({ kind: "custom" });
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-2 rounded-[9px] px-3 py-2 text-left text-[13.5px] font-medium text-brand-soft transition-colors hover:bg-white/[0.06]"
                >
                  <Plus className="h-4 w-4" strokeWidth={1.75} />
                  Add custom lyric
                </button>
              </div>
            )}

            {/* Selected preview excerpt */}
            {lyric.kind === "preview" && (
              <p className="mt-2.5 truncate text-[12.5px] text-ink-faint">“{lyric.excerpt}”</p>
            )}

            {/* Custom lyric paste box */}
            {lyric.kind === "custom" && (
              <textarea
                value={customLyric}
                onChange={(e) => setCustomLyric(e.target.value)}
                placeholder="Paste your lyrics…"
                className="glass-input mt-2.5 min-h-[110px] w-full resize-none leading-relaxed"
              />
            )}
          </div>

          {/* Generate — wide, centered */}
          <div className="mt-5 flex flex-col items-center gap-2">
            <div className={`w-full max-w-[340px] ${busy ? "" : "ai-frame-btn"}`}>
              <button
                type="button"
                disabled={busy}
                onClick={onGenerate}
                aria-disabled={!canGenerate}
                className="glass-btn glass-btn-solid w-full rounded-el px-6 py-3 text-[14.5px] font-semibold"
              >
                {busy ? "Generating…" : "Generate"}
              </button>
            </div>
            {error && <span className="text-[12.5px] text-red-300">{error}</span>}
          </div>
        </div>
      </div>

      {/* Prompt suggestions (Stitch-style) */}
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setPrompt(s)}
            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.035] py-1.5 pl-3 pr-3.5 text-[12.5px] text-ink-muted transition-colors hover:border-white/15 hover:bg-white/[0.07] hover:text-ink"
          >
            <Music className="h-3.5 w-3.5 flex-shrink-0 text-brand-soft" strokeWidth={1.75} />
            <span className="max-w-[230px] truncate">{s}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
