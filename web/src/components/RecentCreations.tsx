import { useRef } from "react";
import { Play, ChevronLeft, ChevronRight, ArrowUpRight, Sparkles } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useTracks } from "../hooks/useTracks";
import { usePlayer } from "../store/player";
import { formatDuration, trackTitle } from "../lib/track";
import type { TrackSummary } from "../types/api";

/**
 * Deterministic cover art from the track id.
 *
 * Generated tracks have no album image and nothing in the API produces one, so
 * the gradient stands in — derived from the id so a track keeps the same face
 * across sessions rather than shuffling on every render.
 */
const GRADIENTS = [
  "from-teal-400/45 via-cyan-600/35 to-slate-900/65",
  "from-amber-400/45 via-orange-600/35 to-rose-950/60",
  "from-emerald-400/40 via-teal-600/40 to-slate-900/70",
  "from-sky-400/40 via-teal-600/35 to-indigo-950/60",
  "from-amber-300/40 via-yellow-700/30 to-teal-950/70",
  "from-cyan-300/45 via-sky-700/35 to-slate-900/65",
  "from-orange-400/40 via-amber-700/35 to-slate-950/65",
];

export function coverGradient(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) % 997;
  return GRADIENTS[hash % GRADIENTS.length]!;
}

export default function RecentCreations() {
  const nav = useNavigate();
  const trackRef = useRef<HTMLDivElement>(null);
  const { data, isLoading } = useTracks();
  const play = usePlayer((s) => s.play);

  // The carousel shows the first page only; Library owns the full list.
  const tracks: TrackSummary[] = data?.pages[0]?.tracks ?? [];

  function scrollByCards(dir: 1 | -1) {
    trackRef.current?.scrollBy({ left: dir * 420, behavior: "smooth" });
  }

  return (
    <div className="mt-8 sm:mt-10">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-display text-lg font-semibold text-ink">Recent Creations</h2>
        <div className="flex items-center gap-1">
          <span className="hidden items-center gap-1 [@media(hover:hover)and(pointer:fine)]:flex">
          <button
            type="button"
            onClick={() => scrollByCards(-1)}
            title="Scroll left"
            aria-label="Scroll left"
            className="glass-btn flex h-8 w-8 items-center justify-center rounded-full"
          >
            <ChevronLeft className="h-4 w-4" strokeWidth={2} />
          </button>
          <button
            type="button"
            onClick={() => scrollByCards(1)}
            title="Scroll right"
            aria-label="Scroll right"
            className="glass-btn flex h-8 w-8 items-center justify-center rounded-full"
          >
            <ChevronRight className="h-4 w-4" strokeWidth={2} />
          </button>
          </span>
          <button
            type="button"
            onClick={() => nav("/library")}
            title="Open Library"
            className="ml-1 flex min-h-[40px] items-center gap-1 rounded-el px-2.5 text-sm font-medium text-ink-muted transition-colors hover:text-ink"
          >
            View All
            <ArrowUpRight className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex gap-4">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="surface h-[236px] w-[46vw] max-w-[180px] flex-shrink-0 animate-pulse opacity-50"
            />
          ))}
        </div>
      ) : tracks.length === 0 ? (
        // A first-run user sees this before anything else, so it is a call to
        // action rather than a shrug.
        <div className="surface flex flex-col items-center px-6 py-10 text-center">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full border border-signal/25 bg-signal/15 text-signal-bright">
            <Sparkles className="h-5 w-5" strokeWidth={1.75} />
          </div>
          <p className="text-md font-medium text-ink">Nothing here yet</p>
          <p className="mt-1 max-w-[340px] text-sm text-ink-muted">
            Describe a track above and hit Generate — your first one lands here in about a minute.
          </p>
        </div>
      ) : (
        <div
          ref={trackRef}
          className="scroll-plain flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2 sm:gap-4"
          style={{
            maskImage:
              "linear-gradient(to right, transparent 0, #000 12px, #000 calc(100% - 28px), transparent 100%)",
          }}
        >
          {tracks.map((track) => (
            <div
              key={track.id}
              className="group/card surface w-[46vw] max-w-[180px] flex-shrink-0 snap-start overflow-hidden p-2.5"
            >
              <div className="relative aspect-square overflow-hidden rounded-[10px]">
                <div className={`h-full w-full bg-gradient-to-br ${coverGradient(track.id)}`} />

                <span className="absolute bottom-2 right-2 rounded-full bg-black/55 px-2 py-0.5 font-mono text-2xs font-medium tabular-nums text-ink backdrop-blur-sm">
                  {formatDuration(track.length_seconds)}
                </span>

                <button
                  type="button"
                  onClick={() => nav(`/track/${track.id}`)}
                  title="Open track"
                  aria-label={`Open ${trackTitle(track)}`}
                  className="absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-black/40 hover:text-ink"
                >
                  <ArrowUpRight className="h-4 w-4" strokeWidth={2} />
                </button>

                <button
                  type="button"
                  onClick={() => play(track, tracks)}
                  aria-label={`Play ${trackTitle(track)}`}
                  className="absolute inset-0 flex items-center justify-center bg-black/20 opacity-0 transition-opacity group-hover/card:opacity-100 focus-visible:opacity-100"
                >
                  <span className="glass-btn glass-btn-ring flex h-11 w-11 items-center justify-center rounded-full">
                    <Play className="ml-0.5 h-5 w-5" strokeWidth={2} fill="currentColor" />
                  </span>
                </button>
              </div>

              <div className="px-0.5 pt-2.5">
                <p className="truncate text-sm font-medium text-ink" title={track.prompt}>
                  {trackTitle(track)}
                </p>
                <p className="mt-0.5 truncate text-xs text-ink-muted">
                  {[track.genre, track.bpm ? `${track.bpm} BPM` : null].filter(Boolean).join(" • ") ||
                    (track.vocal ? "Vocal" : "Instrumental")}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
