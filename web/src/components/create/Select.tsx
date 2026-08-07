import { ChevronDown } from "lucide-react";

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  ariaLabel: string;
  /** Genuinely refuses interaction — not merely dimmed. */
  disabled?: boolean;
  title?: string;
}

/**
 * Native `<select>` dressed in the recessed `glass-input` language, with a custom
 * chevron. Native keeps it accessible and keyboard-friendly; the appearance is
 * stripped so it reads as glass.
 */
export default function Select({
  value,
  onChange,
  options,
  ariaLabel,
  disabled = false,
  title,
}: SelectProps) {
  return (
    <div className="relative">
      <select
        aria-label={ariaLabel}
        value={value}
        disabled={disabled}
        title={title}
        onChange={(e) => onChange(e.target.value)}
        className="glass-input cursor-pointer appearance-none pr-9 text-ink disabled:cursor-not-allowed disabled:opacity-40"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-room-raised text-ink">
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint"
        strokeWidth={1.75}
      />
    </div>
  );
}
