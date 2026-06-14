import { useRef } from "react";
import { Play, MoreVertical, ChevronLeft, ChevronRight, ArrowUpRight } from "lucide-react";
import { useNavigate } from "react-router-dom";

interface SampleCreation {
  id: string;
  title: string;
  genre: string;
  bpm: number;
  duration: string; // pre-formatted "mm:ss" — sample data has no real audio
  gradient: string; // tailwind gradient classes for the asset-free album cover
  coverUrl?: string; // reserved: drop in a real album image later
}

// Curated demo "albums" — same mock-data pattern as QuickGenerate's SAMPLE_LYRICS.
// Real generated tracks have no cover/genre/BPM, so the carousel shows these until
// album art exists. Each gradient stands in for an album picture.
const SAMPLE_CREATIONS: SampleCreation[] = [
  { id: "neon-dreams", title: "Neon Dreams", genre: "Synthwave", bpm: 128, duration: "03:28", gradient: "from-indigo-500/50 via-fuchsia-500/40 to-cyan-400/30" },
  { id: "galactic-flow", title: "Galactic Flow", genre: "Ambient", bpm: 98, duration: "03:12", gradient: "from-sky-500/45 via-indigo-500/40 to-slate-900/60" },
  { id: "chase-the-light", title: "Chase The Light", genre: "Pop", bpm: 120, duration: "03:01", gradient: "from-amber-400/45 via-rose-500/40 to-violet-600/45" },
  { id: "midnight-echo", title: "Midnight Echo", genre: "Lo-Fi", bpm: 90, duration: "02:37", gradient: "from-violet-600/50 via-purple-700/40 to-indigo-900/60" },
  { id: "rage-inside", title: "Rage Inside", genre: "Hip Hop", bpm: 140, duration: "03:42", gradient: "from-red-500/50 via-rose-600/40 to-purple-900/55" },
  { id: "solar-tide", title: "Solar Tide", genre: "House", bpm: 124, duration: "03:55", gradient: "from-orange-400/45 via-pink-500/40 to-fuchsia-600/45" },
  { id: "glass-rivers", title: "Glass Rivers", genre: "Chillstep", bpm: 110, duration: "04:08", gradient: "from-teal-400/45 via-cyan-500/40 to-blue-700/50" },
];

export default function RecentCreations() {
  const nav = useNavigate();
  const trackRef = useRef<HTMLDivElement>(null);

  function scrollByCards(dir: 1 | -1) {
    trackRef.current?.scrollBy({ left: dir * 420, behavior: "smooth" });
  }

  return (
    <div className="mt-10">
      {/* Section header */}
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

      {/* Carousel */}
      <div
        ref={trackRef}
        className="flex snap-x snap-mandatory gap-4 overflow-x-auto pb-2 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {SAMPLE_CREATIONS.map((c) => (
          <div
            key={c.id}
            className="group/card glass-panel w-[180px] flex-shrink-0 snap-start overflow-hidden p-2.5"
          >
            {/* Album cover */}
            <div className="relative aspect-square overflow-hidden rounded-[10px]">
              {c.coverUrl ? (
                <img src={c.coverUrl} alt={c.title} className="h-full w-full object-cover" />
              ) : (
                <div className={`h-full w-full bg-gradient-to-br ${c.gradient}`} />
              )}

              {/* Duration badge */}
              <span className="absolute bottom-2 right-2 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-medium tabular-nums text-ink backdrop-blur-sm">
                {c.duration}
              </span>

              {/* Kebab */}
              <button
                type="button"
                title="More"
                aria-label="More options"
                className="absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-black/40 hover:text-ink"
              >
                <MoreVertical className="h-4 w-4" strokeWidth={2} />
              </button>

              {/* Play overlay on hover */}
              <div className="absolute inset-0 flex items-center justify-center bg-black/20 opacity-0 transition-opacity group-hover/card:opacity-100">
                <span className="glass-btn glass-btn-ring flex h-11 w-11 items-center justify-center rounded-full">
                  <Play className="ml-0.5 h-5 w-5" strokeWidth={2} fill="currentColor" />
                </span>
              </div>
            </div>

            {/* Meta */}
            <div className="px-0.5 pt-2.5">
              <p className="truncate text-[13.5px] font-medium text-ink">{c.title}</p>
              <p className="mt-0.5 truncate text-[12px] text-ink-muted">
                {c.genre} • {c.bpm} BPM
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
