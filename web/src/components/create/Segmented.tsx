import type { LucideIcon } from "lucide-react";

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
  const pad = size === "sm" ? "px-3 py-1 text-[12px]" : "px-4 py-1.5 text-[13px]";

  return (
    <div role="tablist" aria-label={ariaLabel} className="glass-panel inline-flex items-center gap-1 !rounded-full p-1">
      {options.map((opt) => {
        const active = opt.value === value;
        const Icon = opt.icon;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={opt.disabled}
            title={opt.title}
            onClick={() => onChange(opt.value)}
            className={`flex items-center gap-1.5 rounded-full font-medium transition-colors ${pad} ${
              opt.disabled
                ? "cursor-not-allowed text-ink-faint opacity-40"
                : active
                  ? "bg-white/10 text-ink"
                  : "text-ink-muted hover:text-ink"
            }`}
          >
            {Icon && <Icon className="h-3.5 w-3.5 text-brand-soft" strokeWidth={1.75} />}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
