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
  "from-indigo-500/50 via-fuchsia-500/40 to-cyan-400/30",
  "from-sky-500/45 via-indigo-500/40 to-slate-900/60",
  "from-amber-400/45 via-rose-500/40 to-violet-600/45",
  "from-violet-600/50 via-purple-700/40 to-indigo-900/60",
  "from-red-500/50 via-rose-600/40 to-purple-900/55",
  "from-orange-400/45 via-pink-500/40 to-fuchsia-600/45",
  "from-teal-400/45 via-cyan-500/40 to-blue-700/50",
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
    <div className="mt-10">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-[18px] font-semibold tracking-[-0.01em] text-ink">Recent Creations</h2>
        <div className="flex items-center gap-1">
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
          <button
            type="button"
            onClick={() => nav("/library")}
            title="Open Library"
            className="ml-1 flex items-center gap-1 rounded-el px-2.5 py-1.5 text-[13px] font-medium text-ink-muted transition-colors hover:text-ink"
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
              className="glass-panel h-[236px] w-[180px] flex-shrink-0 animate-pulse opacity-50"
            />
          ))}
        </div>
      ) : tracks.length === 0 ? (
        // A first-run user sees this before anything else, so it is a call to
        // action rather than a shrug.
        <div className="glass-panel flex flex-col items-center px-6 py-10 text-center">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full border border-brand/25 bg-brand/15 text-brand-soft">
            <Sparkles className="h-5 w-5" strokeWidth={1.75} />
          </div>
          <p className="text-[15px] font-medium text-ink">Nothing here yet</p>
          <p className="mt-1 max-w-[340px] text-[13px] text-ink-muted">
            Describe a track above and hit Generate — your first one lands here in about a minute.
          </p>
        </div>
      ) : (
        <div
          ref={trackRef}
          className="flex snap-x snap-mandatory gap-4 overflow-x-auto pb-2 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {tracks.map((track) => (
            <div
              key={track.id}
              className="group/card glass-panel w-[180px] flex-shrink-0 snap-start overflow-hidden p-2.5"
            >
              <div className="relative aspect-square overflow-hidden rounded-[10px]">
                <div className={`h-full w-full bg-gradient-to-br ${coverGradient(track.id)}`} />

                <span className="absolute bottom-2 right-2 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-medium tabular-nums text-ink backdrop-blur-sm">
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
                  onClick={() => play(track)}
                  aria-label={`Play ${trackTitle(track)}`}
                  className="absolute inset-0 flex items-center justify-center bg-black/20 opacity-0 transition-opacity group-hover/card:opacity-100 focus-visible:opacity-100"
                >
                  <span className="glass-btn glass-btn-ring flex h-11 w-11 items-center justify-center rounded-full">
                    <Play className="ml-0.5 h-5 w-5" strokeWidth={2} fill="currentColor" />
                  </span>
                </button>
              </div>

              <div className="px-0.5 pt-2.5">
                <p className="truncate text-[13.5px] font-medium text-ink" title={track.prompt}>
                  {trackTitle(track)}
                </p>
                <p className="mt-0.5 truncate text-[12px] text-ink-muted">
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
