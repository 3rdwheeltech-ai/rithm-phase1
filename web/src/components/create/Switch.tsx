interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  ariaLabel: string;
}

/**
 * Apple-style sliding toggle in the liquid-glass language: a recessed track that
 * lights up brand-purple when on, with a raised glass knob. Pairs with the
 * Thinking and Seed-lock controls.
 */
export default function Switch({ checked, onChange, ariaLabel }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-[26px] w-[46px] flex-shrink-0 items-center rounded-full border transition-colors duration-200 ${
        checked
          ? "border-brand/40 bg-brand/70 shadow-[inset_0_1px_3px_rgba(0,0,0,0.3),0_0_12px_rgba(108,92,231,0.45)]"
          : "border-white/10 bg-white/[0.06] shadow-[inset_0_1px_3px_rgba(0,0,0,0.4)]"
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
