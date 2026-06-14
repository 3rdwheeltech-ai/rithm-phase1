import { Info } from "lucide-react";

interface TickSliderProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  /** Range + step. Defaults model the original 0–100 percent slider. */
  min?: number;
  max?: number;
  step?: number;
  /** Right-aligned readout. Defaults to `${value}%`. */
  format?: (value: number) => string;
  /** Dim + disable interaction (e.g. a control that needs Thinking ON). */
  disabled?: boolean;
  /** Optional hover/focus tooltip shown via an (i) icon next to the label. */
  tooltip?: string;
}

const BARS = 40;

/**
 * EQ-style slider matching the inspiration screenshot: a row of vertical bars
 * that fill up to the value, with the value bar glowing. A transparent native
 * range input is overlaid for pointer drag + keyboard accessibility.
 *
 * Label (with an optional info icon) and the value readout sit on the same axis
 * as the bars — name · bars · value — left to right.
 *
 * Range-agnostic: pass `min`/`max`/`step` + a `format` readout to drive seconds,
 * BPM, etc.; omit them for the original 0–100 percent behaviour.
 */
export default function TickSlider({
  label,
  value,
  onChange,
  min = 0,
  max = 100,
  step = 1,
  format = (v) => `${v}%`,
  disabled = false,
  tooltip,
}: TickSliderProps) {
  const ratio = max > min ? (value - min) / (max - min) : 0;
  const filled = Math.round(ratio * (BARS - 1));

  return (
    <div className={`flex items-center gap-3 ${disabled ? "pointer-events-none opacity-40" : ""}`}>
      {/* Label + optional info icon */}
      <span className="flex w-[84px] shrink-0 items-center gap-1.5 text-[13px] font-medium text-ink-muted">
        {label}
        {tooltip && (
          <span className="group/info relative inline-flex">
            <Info
              className="h-3.5 w-3.5 cursor-help text-ink-faint"
              strokeWidth={2}
              tabIndex={0}
              aria-label={tooltip}
            />
            <span
              role="tooltip"
              className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-1.5 w-max max-w-[200px] -translate-x-1/2 rounded-lg border border-white/10 bg-black/85 px-2.5 py-1.5 text-[11.5px] font-normal leading-snug text-ink opacity-0 shadow-lg backdrop-blur-sm transition-opacity duration-150 group-hover/info:opacity-100 group-focus-within/info:opacity-100"
            >
              {tooltip}
            </span>
          </span>
        )}
      </span>

      <div className="relative h-7 flex-1 min-w-0">
        {/* Visual bars */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-between gap-px">
          {Array.from({ length: BARS }).map((_, i) => {
            const isThumb = i === filled;
            const isFilled = i <= filled;
            return (
              <span
                key={i}
                className={`w-full rounded-full transition-all duration-150 ${
                  isThumb
                    ? "h-7 bg-brand-soft shadow-[0_0_10px_rgba(108,92,231,0.8)]"
                    : isFilled
                    ? "h-5 border border-brand/70 bg-transparent"
                    : "h-3 bg-white/10"
                }`}
              />
            );
          })}
        </div>

        {/* Transparent native input for drag + keyboard */}
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          aria-label={label}
          disabled={disabled}
          onChange={(e) => onChange(Number(e.target.value))}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
        />
      </div>

      <span className="w-[64px] shrink-0 text-right text-[12px] tabular-nums text-ink-faint">
        {format(value)}
      </span>
    </div>
  );
}
