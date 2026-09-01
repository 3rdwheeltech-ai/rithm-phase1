import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ArrowUpRight, Sparkles } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useTracks } from "../hooks/useTracks";
import { usePlayer } from "../store/player";
import { coverGradient } from "../lib/covers";
import { formatDuration, trackSubtitle, trackTitle } from "../lib/track";
import TrackCard from "./TrackCard";
import type { TrackSummary } from "../types/api";

export default function RecentCreations() {
  const nav = useNavigate();
  const trackRef = useRef<HTMLDivElement>(null);
  const { data, isLoading } = useTracks();
  const play = usePlayer((s) => s.play);
  const setPlaying = usePlayer((s) => s.setPlaying);
  const currentId = usePlayer((s) => s.track?.id ?? null);
  const isPlaying = usePlayer((s) => s.isPlaying);

  // The carousel shows the first page only; Library owns the full list.
  const tracks: TrackSummary[] = data?.pages[0]?.tracks ?? [];

  // Arrows only make sense once there is somewhere to scroll to — hidden at
  // rest, and hidden again once the track in that direction runs out.
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(true);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;

    function update() {
      if (!el) return;
      setAtStart(el.scrollLeft <= 1);
      setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 1);
    }

    update();
    el.addEventListener("scroll", update, { passive: true });
    return () => el.removeEventListener("scroll", update);
  }, [tracks.length]);

  function scrollByCards(dir: 1 | -1) {
    trackRef.current?.scrollBy({ left: dir * 420, behavior: "smooth" });
  }

  return (
    <div className="mt-8 sm:mt-10">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-display text-lg font-semibold text-ink">Recent Creations</h2>
        <div className="flex items-center gap-1">
          {tracks.length > 0 && (
            <span className="flex items-center gap-1">
              {!atStart && (
                <button
                  type="button"
                  onClick={() => scrollByCards(-1)}
                  title="Scroll left"
                  aria-label="Scroll left"
                  className="glass-btn flex h-8 w-8 items-center justify-center rounded-full"
                >
                  <ChevronLeft className="h-4 w-4" strokeWidth={2} />
                </button>
              )}
              {!atEnd && (
                <button
                  type="button"
                  onClick={() => scrollByCards(1)}
                  title="Scroll right"
                  aria-label="Scroll right"
                  className="glass-btn flex h-8 w-8 items-center justify-center rounded-full"
                >
                  <ChevronRight className="h-4 w-4" strokeWidth={2} />
                </button>
              )}
            </span>
          )}
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
          {tracks.map((track) => {
            const active = currentId === track.id;
            return (
              <TrackCard
                key={track.id}
                className="w-[46vw] max-w-[180px] flex-shrink-0 snap-start"
                title={trackTitle(track)}
                titleTooltip={track.prompt}
                subtitle={trackSubtitle(track)}
                seed={track.id}
                gradient={coverGradient(track.id)}
                duration={formatDuration(track.length_seconds)}
                playing={active && isPlaying}
                onPlay={() => (active && isPlaying ? setPlaying(false) : play(track, tracks))}
                onOpen={() => nav(`/track/${track.id}`)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
