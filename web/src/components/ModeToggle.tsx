import { useState } from "react";
import { Sparkles } from "lucide-react";

type Mode = "basic" | "pro";

/**
 * Basic / Pro segmented toggle. Purely visual this phase — switching to Pro only
 * lights the pill with a subtler version of the quick-gen glow (.ai-frame-soft).
 */
export default function ModeToggle() {
  const [mode, setMode] = useState<Mode>("basic");

  return (
    <div className={mode === "pro" ? "ai-frame-soft" : undefined}>
      <div className="glass-panel flex items-center gap-1 !rounded-full p-1">
        <button
          type="button"
          onClick={() => setMode("basic")}
          aria-pressed={mode === "basic"}
          className={`rounded-full px-4 py-1.5 text-[13px] font-medium transition-colors ${
            mode === "basic" ? "bg-white/10 text-ink" : "text-ink-muted hover:text-ink"
          }`}
        >
          Basic
        </button>
        <button
          type="button"
          onClick={() => setMode("pro")}
          aria-pressed={mode === "pro"}
          className={`flex items-center gap-1.5 rounded-full px-4 py-1.5 text-[13px] font-medium transition-colors ${
            mode === "pro" ? "bg-white/10 text-ink" : "text-ink-muted hover:text-ink"
          }`}
        >
          <Sparkles className="h-3.5 w-3.5 text-brand-soft" strokeWidth={1.75} />
          Pro
        </button>
      </div>
    </div>
  );
}
