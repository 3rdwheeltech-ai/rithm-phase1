import { cn } from "../lib/cn";

export interface ChipOption<T extends string> {
  value: T;
  label: string;
}

interface ChipSelectProps<T extends string> {
  options: readonly ChipOption<T>[];
  value: readonly T[];
  onChange: (next: T[]) => void;
  /**
   * One answer instead of many. Picking replaces rather than appends, and
   * picking the selected chip again clears it — the questions this drives are
   * all skippable, so there has to be a way back to "no answer".
   */
  single?: boolean;
  /** Multi-select cap. Unselected chips disable once it is reached. */
  max?: number;
  ariaLabel: string;
  className?: string;
}

/**
 * A group of toggle chips, in the language CreateForm already speaks.
 *
 * Lives at components/ root rather than components/create/: that folder is
 * route-scoped (Segmented, Select, TickSlider belong to the Create form), and
 * this control's consumers are Onboarding and Settings.
 *
 * `role="group"` of `aria-pressed` buttons, not a listbox — a listbox owes full
 * arrow-key roving-tabindex semantics, and a row of independently tabbable
 * toggles is both simpler and what these screens actually behave like.
 */
export default function ChipSelect<T extends string>({
  options,
  value,
  onChange,
  single = false,
  max,
  ariaLabel,
  className,
}: ChipSelectProps<T>) {
  const atCap = max !== undefined && value.length >= max;

  function toggle(option: T) {
    if (value.includes(option)) {
      onChange(single ? [] : value.filter((v) => v !== option));
      return;
    }
    if (single) {
      onChange([option]);
      return;
    }
    if (atCap) return;
    onChange([...value, option]);
  }

  return (
    <div role="group" aria-label={ariaLabel} className={cn("flex flex-wrap gap-2", className)}>
      {options.map((option) => {
        const selected = value.includes(option.value);
        // Capped chips are disabled rather than hidden: a row that reflows as
        // you pick loses the position you were reading.
        const locked = !selected && atCap;

        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            disabled={locked}
            onClick={() => toggle(option.value)}
            className={cn(
              "min-h-[36px] rounded-full border px-3 text-xs font-medium transition-colors",
              selected
                ? "border-signal/25 bg-signal/15 text-ink"
                : "border-white/10 bg-white/[0.035] text-ink-muted hover:border-white/15 hover:bg-white/[0.07] hover:text-ink",
              locked && "cursor-not-allowed opacity-30 hover:border-white/10 hover:bg-white/[0.035]",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
