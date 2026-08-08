import { Play, Pause, ArrowUpRight, Trash2 } from "lucide-react";
import { cn } from "../lib/cn";

/**
 * The album card, used by Home's carousel, the Library grid and Discover.
 *
 * Opaque on purpose. `.surface`, never `.lg-*`: glass is chrome, and a scrolling
 * grid of thirty backdrop-filter layers is what makes a list feel cheap — the
 * rule the tier comment in index.css states and the one the Library grid exists
 * to respect.
 *
 * Sizing is the caller's. The carousel needs a fixed width and scroll snapping,
 * the Library grid needs the cell to decide; baking either in here would make
 * the component wrong somewhere.
 */
export default function TrackCard({
  title,
  subtitle,
  gradient,
  duration,
  onPlay,
  playing = false,
  onOpen,
  onDelete,
  titleTooltip,
  className,
}: {
  title: string;
  subtitle: string;
  /** Tailwind gradient stops, from `coverGradient` or `demoGradient`. */
  gradient: string;
  /** Pre-formatted — callers own the units. */
  duration: string;
  onPlay: () => void;
  playing?: boolean;
  /** Omit to hide the open-track arrow (Discover has nowhere to go). */
  onOpen?: () => void;
  /** Omit to hide the delete button (only Library owns its tracks). */
  onDelete?: () => void;
  titleTooltip?: string;
  className?: string;
}) {
  return (
    <div className={cn("group/card surface overflow-hidden p-2.5", className)}>
      <div className="relative aspect-square overflow-hidden rounded-control">
        <div className={`h-full w-full bg-gradient-to-br ${gradient}`} />

        <span className="absolute bottom-2 right-2 rounded-full bg-black/55 px-2 py-0.5 font-mono text-2xs font-medium tabular-nums text-ink backdrop-blur-sm">
          {duration}
        </span>

        {/* Both corner buttons sit ABOVE the play overlay in the stack, so a
            click near a corner does what the icon under the cursor says. */}
        {onDelete && (
          <button
            type="button"
            onClick={onDelete}
            title="Delete"
            aria-label={`Delete ${title}`}
            className="absolute left-1.5 top-1.5 z-10 flex h-7 w-7 items-center justify-center rounded-lg text-ink-faint transition-all hover:bg-danger/25 hover:text-danger focus-visible:opacity-100 lg:opacity-0 lg:group-hover/card:opacity-100"
          >
            <Trash2 className="h-4 w-4" strokeWidth={2} />
          </button>
        )}

        {onOpen && (
          <button
            type="button"
            onClick={onOpen}
            title="Open track"
            aria-label={`Open ${title}`}
            className="absolute right-1.5 top-1.5 z-10 flex h-7 w-7 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-black/40 hover:text-ink"
          >
            <ArrowUpRight className="h-4 w-4" strokeWidth={2} />
          </button>
        )}

        <button
          type="button"
          onClick={onPlay}
          aria-label={`${playing ? "Pause" : "Play"} ${title}`}
          className={cn(
            "absolute inset-0 flex items-center justify-center bg-black/20 transition-opacity focus-visible:opacity-100 group-hover/card:opacity-100",
            // What is playing stays visible without a pointer — on a phone
            // there is no hover to reveal it, and no other cue on the card.
            playing ? "opacity-100" : "opacity-0",
          )}
        >
          <span className="glass-btn glass-btn-ring flex h-11 w-11 items-center justify-center rounded-full">
            {playing ? (
              <Pause className="h-5 w-5" strokeWidth={2} fill="currentColor" />
            ) : (
              <Play className="ml-0.5 h-5 w-5" strokeWidth={2} fill="currentColor" />
            )}
          </span>
        </button>
      </div>

      <div className="px-0.5 pt-2.5">
        <p className="truncate text-sm font-medium text-ink" title={titleTooltip ?? title}>
          {title}
        </p>
        <p className="mt-0.5 truncate text-xs text-ink-muted">{subtitle}</p>
      </div>
    </div>
  );
}
