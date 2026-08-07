import type { LucideIcon } from "lucide-react";
import ComingSoon from "./ComingSoon";

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
  /**
   * Renders the segment but refuses selection. Used for controls the API has no
   * field for yet: showing them disabled is honest, hiding them means the same
   * question gets asked every week, enabling them means an error the user
   * cannot act on.
   */
  disabled?: boolean;
  /** Tooltip, and the accessible explanation for a disabled segment. */
  title?: string;
}

interface SegmentedProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: SegmentOption<T>[];
  /** Visual size — `sm` for inline tabs, `md` (default) for the page toggle. */
  size?: "sm" | "md";
  ariaLabel?: string;
}

/**
 * Generic segmented control sharing the glass-pill language of `ModeToggle`.
 * Reused for Simple/Advanced, the lyric tabs, and Vocal Gender.
 */
export default function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = "md",
  ariaLabel,
}: SegmentedProps<T>) {
  // Touch targets stay at 44px minimum however small the label gets.
  const pad = size === "sm" ? "min-h-[36px] px-3 text-xs" : "min-h-[40px] px-4 text-sm";

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="lg-regular inline-flex max-w-full flex-wrap items-center gap-1 rounded-full p-1"
      style={{ "--r": "999px" } as React.CSSProperties}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        const Icon = opt.icon;
        const button = (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={opt.disabled}
            title={opt.title}
            onClick={() => onChange(opt.value)}
            className={`flex items-center gap-1.5 rounded-full font-medium transition-all duration-200 ${pad} ${
              opt.disabled
                ? "cursor-not-allowed text-ink-faint opacity-40"
                : active
                  ? "pill-glow text-ink"
                  : "text-ink-muted hover:bg-white/[0.05] hover:text-ink"
            }`}
          >
            {Icon && <Icon className="h-3.5 w-3.5 text-signal-bright" strokeWidth={1.75} />}
            {opt.label}
          </button>
        );

        // A disabled <button> eats its own pointer events, so its `title` never
        // fires — the explanation has to come from an enabled wrapper. See
        // ComingSoon for the full reasoning.
        return opt.disabled && opt.title ? (
          <ComingSoon key={opt.value} className="inline-block" label={opt.title}>
            {button}
          </ComingSoon>
        ) : (
          button
        );
      })}
    </div>
  );
}
