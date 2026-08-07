import { useEffect, useRef, useState } from "react";
import { Info } from "lucide-react";
import { cn } from "../../lib/cn";

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

const MAX_BARS = 40;
const MIN_BARS = 14;
/** Below this, a bar plus its gap stops reading as a bar. */
const PX_PER_BAR = 9;

/**
 * EQ-style slider: a row of vertical bars that fill up to the value, with the
 * value bar glowing. A transparent native range input is overlaid for pointer
 * drag + keyboard accessibility.
 *
 * The bar count follows the available width. At 40 fixed bars a phone gives each
 * one about four pixels, which reads as noise rather than as a meter — so the
 * track thins out as it narrows, and stacks its label above the bars when even
 * that is not enough.
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
  const rowRef = useRef<HTMLDivElement>(null);
  const [bars, setBars] = useState(MAX_BARS);
  const [stacked, setStacked] = useState(false);

  useEffect(() => {
    const node = rowRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? 0;
      if (width === 0) return;
      setStacked(width < 300);
      // The bars get whatever is left after the label and the readout.
      const trackWidth = width < 300 ? width : width - 160;
      setBars(Math.max(MIN_BARS, Math.min(MAX_BARS, Math.floor(trackWidth / PX_PER_BAR))));
    });

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const ratio = max > min ? (value - min) / (max - min) : 0;
  const filled = Math.round(ratio * (bars - 1));

  const labelEl = (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1.5 text-sm font-medium text-ink-muted",
        !stacked && "w-[84px]",
      )}
    >
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
            className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-1.5 w-max max-w-[200px] -translate-x-1/2 rounded-control border border-white/10 bg-black/85 px-2.5 py-1.5 text-2xs font-normal leading-snug text-ink opacity-0 shadow-lg backdrop-blur-sm transition-opacity duration-150 group-focus-within/info:opacity-100 group-hover/info:opacity-100"
          >
            {tooltip}
          </span>
        </span>
      )}
    </span>
  );

  const readoutEl = (
    <span
      className={cn(
        "shrink-0 font-mono text-xs tabular-nums text-ink-faint",
        stacked ? "text-left" : "w-[64px] text-right",
      )}
    >
      {format(value)}
    </span>
  );

  return (
    <div
      ref={rowRef}
      className={cn(
        disabled && "pointer-events-none opacity-40",
        stacked ? "flex flex-col gap-1.5" : "flex items-center gap-3",
      )}
    >
      {stacked ? (
        <div className="flex items-center justify-between gap-3">
          {labelEl}
          {readoutEl}
        </div>
      ) : (
        labelEl
      )}

      <div className={cn("relative h-7", stacked ? "w-full" : "min-w-0 flex-1")}>
        {/* Visual bars */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-between gap-px">
          {Array.from({ length: bars }).map((_, i) => {
            const isThumb = i === filled;
            const isFilled = i <= filled;
            return (
              <span
                key={i}
                className={cn(
                  "w-full rounded-full transition-all duration-150",
                  isThumb
                    ? "h-7 bg-signal-bright shadow-[0_0_10px_rgb(52_227_200/0.8)]"
                    : isFilled
                      ? "h-5 border border-signal/70 bg-transparent"
                      : "h-3 bg-white/10",
                )}
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

      {!stacked && readoutEl}
    </div>
  );
}
