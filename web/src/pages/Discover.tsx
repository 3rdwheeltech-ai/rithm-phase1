import { useRef, useState, type ReactNode } from "react";
import { Compass, Play, ChevronLeft, ChevronRight, Globe, Info } from "lucide-react";
import { cn } from "../lib/cn";
import { useLens } from "../lib/useLens";
import { mergeRefs, useSpecular } from "../lib/useSpecular";
import { formatDuration } from "../lib/track";
import {
  DEMO_ARTISTS,
  DISCOVER_FILTERS,
  FEATURED,
  filterCatalogue,
  formatCount,
  type DiscoverFilter,
} from "../lib/discoverData";
import ComingSoonDialog from "../components/ComingSoonDialog";
import TrackCard from "../components/TrackCard";

/**
 * The community browse page — sample data, honestly labelled.
 *
 * Nothing here is wired to an API: there is no publish endpoint and no feed.
 * Rather than disable every control, which reads as broken rather than
 * forthcoming, every control works and opens <ComingSoonDialog>. The banner at
 * the top is the page's one piece of small print, and it stays above the fold.
 */

/** A titled horizontal rail with the carousel controls Home already uses. */
function Shelf({ title, children }: { title: string; children: ReactNode }) {
  const railRef = useRef<HTMLDivElement>(null);

  function scrollBy(dir: 1 | -1) {
    railRef.current?.scrollBy({ left: dir * 420, behavior: "smooth" });
  }

  return (
    <section className="mt-8">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-display text-lg font-semibold text-ink">{title}</h2>
        {/* Pointer-only: a touch device scrolls the rail directly, and these
            would just be two more things between a thumb and the content. */}
        <span className="hidden items-center gap-1 [@media(hover:hover)and(pointer:fine)]:flex">
          <button
            type="button"
            onClick={() => scrollBy(-1)}
            title="Scroll left"
            aria-label={`Scroll ${title} left`}
            className="glass-btn flex h-8 w-8 items-center justify-center rounded-full"
          >
            <ChevronLeft className="h-4 w-4" strokeWidth={2} />
          </button>
          <button
            type="button"
            onClick={() => scrollBy(1)}
            title="Scroll right"
            aria-label={`Scroll ${title} right`}
            className="glass-btn flex h-8 w-8 items-center justify-center rounded-full"
          >
            <ChevronRight className="h-4 w-4" strokeWidth={2} />
          </button>
        </span>
      </div>

      <div
        ref={railRef}
        className="scroll-plain flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2 sm:gap-4"
        style={{
          maskImage:
            "linear-gradient(to right, transparent 0, #000 12px, #000 calc(100% - 28px), transparent 100%)",
        }}
      >
        {children}
      </div>
    </section>
  );
}

export default function Discover() {
  const [filter, setFilter] = useState<DiscoverFilter>("For You");
  const [comingSoon, setComingSoon] = useState<string | null>(null);

  // The page's one lensed surface, and the one thing the route is about.
  const lensRef = useLens<HTMLDivElement>("md", 24);
  const specularRef = useSpecular<HTMLDivElement>();

  const catalogue = filterCatalogue(filter);
  const trending = catalogue.slice(0, 10);
  // A genre never has twenty tracks, so the second shelf simply does not
  // appear once the catalogue is narrowed — better than a rail of three.
  const fresh = catalogue.slice(10);

  return (
    <div className="flex flex-1 flex-col py-6 sm:py-8">
      <ComingSoonDialog feature={comingSoon} onClose={() => setComingSoon(null)} />

      <div className="mx-auto w-full max-w-[1100px] animate-fade-in">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-el border border-signal/25 bg-signal/15 text-signal-bright">
              <Compass className="h-5 w-5" strokeWidth={1.75} />
            </span>
            <div className="min-w-0">
              <h1 className="font-display text-xl font-semibold text-ink">Discover</h1>
              <p className="text-sm text-ink-muted">
                Hear what the RITHM community is publishing.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setComingSoon("Publishing")}
            // The label is the only thing below `sm`, where the word is hidden.
            aria-label="Publish"
            className="glass-btn flex min-h-[40px] flex-shrink-0 items-center gap-2 rounded-el px-4 text-sm font-medium"
          >
            <Globe className="h-4 w-4" strokeWidth={1.75} />
            <span className="hidden sm:inline">Publish</span>
          </button>
        </div>

        {/* The small print, above the fold, before anything invites a click. */}
        <div className="lg-thin mb-5 flex items-start gap-2.5 rounded-el px-3.5 py-2.5">
          <Info className="mt-px h-4 w-4 flex-shrink-0 text-signal-bright" strokeWidth={2} />
          <p className="text-xs leading-relaxed text-ink-muted">
            <span className="font-medium text-ink">Real features coming soon.</span> Every track
            and artist below is sample data — publishing, following and community playback are
            still being built.
          </p>
        </div>

        <div className="mb-6 flex flex-wrap gap-2">
          {DISCOVER_FILTERS.map((option) => {
            const active = option === filter;
            return (
              <button
                key={option}
                type="button"
                onClick={() => setFilter(option)}
                aria-pressed={active}
                className={cn(
                  "min-h-[36px] rounded-full border px-3.5 text-xs font-medium transition-all",
                  active
                    ? "pill-glow border-transparent text-ink"
                    : "border-white/10 bg-white/[0.035] text-ink-muted hover:border-white/15 hover:bg-white/[0.07] hover:text-ink",
                )}
              >
                {option}
              </button>
            );
          })}
        </div>

        {/* Featured — the page's one big box, so it gets the frame Home's
            generate box wears. Only one per route keeps it meaning something. */}
        <div className="ai-frame">
          <div
            ref={mergeRefs(lensRef, specularRef)}
            className="quick-surface flex items-center gap-4 p-4 sm:gap-6 sm:p-5"
          >
            <div
              className={`h-20 w-20 flex-shrink-0 rounded-el bg-gradient-to-br sm:h-[104px] sm:w-[104px] ${FEATURED.gradient}`}
            />
            <div className="min-w-0 flex-1">
              <span className="eyebrow">Featured</span>
              <h2 className="mt-1 truncate font-display text-lg font-semibold text-ink sm:text-2xl">
                {FEATURED.title}
              </h2>
              <p className="mt-0.5 truncate text-sm text-ink-muted">
                {[FEATURED.artist, FEATURED.genre, formatDuration(FEATURED.lengthSeconds)].join(
                  " • ",
                )}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setComingSoon("Community playback")}
              aria-label={`Play ${FEATURED.title}`}
              className="glass-btn glass-btn-ring flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full sm:h-14 sm:w-14"
            >
              <Play className="ml-0.5 h-5 w-5 sm:h-6 sm:w-6" strokeWidth={2} fill="currentColor" />
            </button>
          </div>
        </div>

        <Shelf title={filter === "For You" ? "Trending now" : filter}>
          {trending.map((track) => (
            <TrackCard
              key={track.id}
              className="w-[46vw] max-w-[180px] flex-shrink-0 snap-start"
              title={track.title}
              subtitle={`${track.artist} • ${formatCount(track.plays)} plays`}
              gradient={track.gradient}
              duration={formatDuration(track.lengthSeconds)}
              onPlay={() => setComingSoon("Community playback")}
            />
          ))}
        </Shelf>

        {fresh.length > 0 && (
          <Shelf title="New this week">
            {fresh.map((track) => (
              <TrackCard
                key={track.id}
                className="w-[46vw] max-w-[180px] flex-shrink-0 snap-start"
                title={track.title}
                subtitle={`${track.artist} • ${formatCount(track.plays)} plays`}
                gradient={track.gradient}
                duration={formatDuration(track.lengthSeconds)}
                onPlay={() => setComingSoon("Community playback")}
              />
            ))}
          </Shelf>
        )}

        <Shelf title="Popular artists">
          {DEMO_ARTISTS.map((artist) => (
            <div
              key={artist.id}
              className="w-[38vw] max-w-[150px] flex-shrink-0 snap-start text-center"
            >
              <div
                className={`mx-auto aspect-square w-full rounded-full bg-gradient-to-br ${artist.gradient}`}
              />
              <p className="mt-3 truncate text-sm font-medium text-ink">{artist.name}</p>
              <p className="mt-0.5 truncate text-xs text-ink-muted">
                {formatCount(artist.followers)} followers • {artist.genre}
              </p>
              <button
                type="button"
                onClick={() => setComingSoon("Following artists")}
                aria-label={`Follow ${artist.name}`}
                className="glass-btn mt-2.5 h-8 rounded-full px-4 text-xs font-medium"
              >
                Follow
              </button>
            </div>
          ))}
        </Shelf>
      </div>
    </div>
  );
}
