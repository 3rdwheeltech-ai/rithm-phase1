import { useState } from "react";
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { useHoverIntent } from "../lib/useHoverIntent";

// Static placeholder track — real playback arrives with the Phase 2 backend.
const TRACK = {
  project: "Recents",
  title: "Midnight Drive",
  current: "1:14",
  total: "3:12",
  progress: 0.38,
  lyrics: [
    "City lights blur as we ride,",
    "neon rivers running wide.",
    "Hold the wheel, let go the time —",
    "midnight hums in four-four time.",
    "Engines breathe and streetlights glow,",
    "somewhere only we would go.",
  ],
};

const SPEEDS = [1, 1.25, 1.5, 2] as const;

export default function Player() {
  const [open, setOpen] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [speedIdx, setSpeedIdx] = useState(0);
  const { hovered, onMouseEnter, onMouseLeave } = useHoverIntent();

  const expanded = open || hovered;

  return (
    <aside
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className={`glass-panel absolute right-3 top-1/2 z-20 flex h-[460px] -translate-y-1/2 flex-col overflow-hidden transition-[width] duration-300 ease-out ${
        expanded ? "w-[300px]" : "w-[58px]"
      }`}
    >
      {expanded ? (
        <div className="flex h-full flex-col p-4">
          {/* Header: project label + collapse */}
          <div className="mb-3 flex items-center justify-between">
            <span className="truncate text-[11px] font-semibold uppercase tracking-[0.18em] text-brand-soft/70">
              {TRACK.project}
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              title="Collapse"
              aria-label="Collapse player"
              className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-white/[0.06] hover:text-ink"
            >
              <ChevronRight className="h-[18px] w-[18px]" strokeWidth={1.75} />
            </button>
          </div>

          {/* Lyrics */}
          <div className="-mr-1 flex-1 overflow-y-auto pr-1">
            {TRACK.lyrics.map((line, i) => (
              <p
                key={i}
                className={`text-[12.5px] leading-relaxed ${
                  i === 2 ? "text-ink" : "text-ink-faint"
                }`}
              >
                {line}
              </p>
            ))}
          </div>

          {/* Accent divider */}
          <div className="my-3 h-px w-full bg-gradient-to-r from-brand/5 via-brand/70 to-brand/5" />

          {/* Title */}
          <p className="truncate text-[15px] font-semibold text-ink">{TRACK.title}</p>

          {/* Progress */}
          <div className="mt-2.5">
            <div className="relative h-1 w-full rounded-full bg-white/10">
              <div
                className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-brand to-brand-soft"
                style={{ width: `${TRACK.progress * 100}%` }}
              />
              <div
                className="absolute top-1/2 h-2.5 w-2.5 -translate-y-1/2 -translate-x-1/2 rounded-full bg-white shadow-[0_0_8px_rgba(108,92,231,0.7)]"
                style={{ left: `${TRACK.progress * 100}%` }}
              />
            </div>
            <div className="mt-1.5 flex justify-between text-[11px] tabular-nums text-ink-faint">
              <span>{TRACK.current}</span>
              <span>{TRACK.total}</span>
            </div>
          </div>

          {/* Transport */}
          <div className="mt-3 flex items-center justify-center gap-5">
            <button
              type="button"
              title="Previous"
              aria-label="Previous"
              className="text-ink-muted transition-colors hover:text-ink"
            >
              <SkipBack className="h-5 w-5" strokeWidth={1.75} />
            </button>
            <button
              type="button"
              onClick={() => setPlaying((p) => !p)}
              title={playing ? "Pause" : "Play"}
              aria-label={playing ? "Pause" : "Play"}
              className="flex h-12 w-12 items-center justify-center rounded-full bg-[linear-gradient(135deg,#7a68fc_0%,#9d4edd_55%,#4cc9f0_140%)] text-white shadow-[0_4px_18px_rgba(108,92,231,0.5)] transition-transform hover:-translate-y-px"
            >
              {playing ? (
                <Pause className="h-5 w-5" strokeWidth={2} fill="currentColor" />
              ) : (
                <Play className="ml-0.5 h-5 w-5" strokeWidth={2} fill="currentColor" />
              )}
            </button>
            <button
              type="button"
              title="Next"
              aria-label="Next"
              className="text-ink-muted transition-colors hover:text-ink"
            >
              <SkipForward className="h-5 w-5" strokeWidth={1.75} />
            </button>
          </div>

          {/* Speed toggle (bottom-left) */}
          <div className="mt-3">
            <button
              type="button"
              onClick={() => setSpeedIdx((i) => (i + 1) % SPEEDS.length)}
              title="Playback speed"
              className="rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[12px] font-medium tabular-nums text-ink-muted transition-colors hover:bg-white/[0.08] hover:text-ink"
            >
              {SPEEDS[speedIdx]}×
            </button>
          </div>
        </div>
      ) : (
        /* Collapsed rail — expand arrow (top) + play (bottom) */
        <div className="flex h-full flex-col items-center justify-between py-4">
          <button
            type="button"
            onClick={() => setOpen(true)}
            title="Expand player"
            aria-label="Expand player"
            className="flex h-9 w-9 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-white/[0.06] hover:text-ink"
          >
            <ChevronLeft className="h-[18px] w-[18px]" strokeWidth={1.75} />
          </button>
          <button
            type="button"
            onClick={() => setPlaying((p) => !p)}
            title={playing ? "Pause" : "Play"}
            aria-label={playing ? "Pause" : "Play"}
            className="flex h-11 w-11 items-center justify-center rounded-full bg-[linear-gradient(135deg,#7a68fc_0%,#9d4edd_55%,#4cc9f0_140%)] text-white shadow-[0_4px_18px_rgba(108,92,231,0.5)] transition-transform hover:-translate-y-px"
          >
            {playing ? (
              <Pause className="h-[18px] w-[18px]" strokeWidth={2} fill="currentColor" />
            ) : (
              <Play className="ml-0.5 h-[18px] w-[18px]" strokeWidth={2} fill="currentColor" />
            )}
          </button>
        </div>
      )}
    </aside>
  );
}
