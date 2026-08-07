interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  ariaLabel: string;
  /**
   * Refuses interaction as well as dimming it. Visual opacity alone still
   * leaves the control focusable and operable, which is worse than hiding it:
   * it reads as working and does nothing.
   */
  disabled?: boolean;
  title?: string;
}

/**
 * Apple-style sliding toggle in the liquid-glass language: a recessed track that
 * lights up signal-teal when on, with a raised glass knob.
 */
export default function Switch({
  checked,
  onChange,
  ariaLabel,
  disabled = false,
  title,
}: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      title={title}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-[26px] w-[46px] flex-shrink-0 items-center rounded-full border transition-colors duration-200 ${
        disabled ? "cursor-not-allowed opacity-40" : ""
      } ${
        checked
          ? "border-signal/40 bg-signal/70 shadow-[inset_0_1px_3px_rgb(0_0_0/0.3),0_0_12px_rgb(52_227_200/0.45)]"
          : "border-white/10 bg-white/[0.06] shadow-[inset_0_1px_3px_rgb(0_0_0/0.4)]"
      }`}
    >
      <span
        className={`inline-block h-[20px] w-[20px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.6)] transition-transform duration-200 ${
          checked ? "translate-x-[22px]" : "translate-x-[3px]"
        }`}
      />
    </button>
  );
}
