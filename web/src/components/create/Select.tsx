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
}

/**
 * Native `<select>` dressed in the recessed `glass-input` language, with a custom
 * chevron. Native keeps it accessible and keyboard-friendly; the appearance is
 * stripped so it reads as glass.
 */
export default function Select({ value, onChange, options, ariaLabel }: SelectProps) {
  return (
    <div className="relative">
      <select
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="glass-input cursor-pointer appearance-none pr-9 text-ink"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-[#0b0b12] text-ink">
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
