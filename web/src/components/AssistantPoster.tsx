import { cn } from "../lib/cn";

/**
 * The assistant's face for phones — a still, and NOT a downgrade.
 *
 * IT EXISTS FOR ONE REASON, AND IT IS NOT AESTHETIC. If `VoiceSheet` imported
 * `AssistantAvatar` for its fallback face, ~400 kB of Lottie renderer would
 * ship to phones — undoing Layout.tsx's "never loaded on a phone at all",
 * which is load-bearing rather than a nice-to-have. And the `src` prop on
 * `AssistantAvatar` does not save you: `import Lottie from "lottie-react"` is
 * static, so the module cost is paid whether or not the prop is set.
 *
 * The same frame, the same `.avatar-aura`, the same square box the Lottie and
 * the Anam video both occupy — so the three are interchangeable in a slot
 * without the geometry moving. Desktop keeps the Lottie it has today.
 *
 * It is not a compromise on mobile: the assistant has never rendered there at
 * all, so this is the FIRST face phones have had, not a lesser version of one.
 *
 * `src` takes a real portrait when there is one to take; until then the mark
 * below stands in, and swapping it is a one-line change with no other
 * consequence.
 */
export default function AssistantPoster({
  src,
  className = "",
}: {
  src?: string;
  className?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "relative w-full overflow-hidden rounded-card border border-white/10 bg-[radial-gradient(ellipse_at_50%_30%,rgb(var(--signal)/0.13),transparent_70%)]",
        className,
      )}
    >
      <div className="avatar-aura pointer-events-none absolute inset-0 rounded-card" />
      {src ? (
        <img
          src={src}
          alt=""
          className="relative aspect-square w-full object-cover"
        />
      ) : (
        <svg
          viewBox="0 0 100 100"
          className="relative aspect-square w-full text-signal"
          role="presentation"
        >
          <circle cx="50" cy="38" r="16" fill="currentColor" opacity="0.28" />
          <path
            d="M22 84c0-15.5 12.5-28 28-28s28 12.5 28 28"
            fill="currentColor"
            opacity="0.18"
          />
          <circle
            cx="50"
            cy="50"
            r="34"
            fill="none"
            stroke="currentColor"
            strokeOpacity="0.32"
            strokeWidth="1.5"
          />
        </svg>
      )}
    </div>
  );
}
