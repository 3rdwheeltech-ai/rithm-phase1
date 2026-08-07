import { useState } from "react";
import { Sparkles } from "lucide-react";

type Mode = "basic" | "pro";

/**
 * Basic / Pro segmented toggle. Purely visual this phase — switching to Pro only
 * lights the control with a subtler version of the quick-gen glow (.ai-frame-soft).
 *
 * Lives in the sidebar footer, so it adapts to the rail's two states: the full
 * Basic/Pro pill when expanded, and a single compact mode button when collapsed.
 */
export default function ModeToggle({ expanded = true }: { expanded?: boolean }) {
  const [mode, setMode] = useState<Mode>("basic");

  // Collapsed rail — a single square button that flips the mode on click.
  if (!expanded) {
    return (
      <div className={mode === "pro" ? "ai-frame-soft !rounded-el" : undefined}>
        <button
          type="button"
          onClick={() => setMode((m) => (m === "basic" ? "pro" : "basic"))}
          title={mode === "pro" ? "Pro mode" : "Basic mode"}
          aria-label={`Mode: ${mode}. Toggle.`}
          className={`flex h-9 w-full items-center justify-center rounded-el border transition-colors ${
            mode === "pro"
              ? "border-transparent bg-white/10 text-signal-bright"
              : "border-white/10 text-ink-muted hover:bg-white/[0.06] hover:text-ink"
          }`}
        >
          <Sparkles className="h-[18px] w-[18px]" strokeWidth={1.75} />
        </button>
      </div>
    );
  }

  return (
    <div className={mode === "pro" ? "ai-frame-soft" : undefined}>
      <div className="glass-panel flex items-center gap-1 !rounded-full p-1">
        <button
          type="button"
          onClick={() => setMode("basic")}
          aria-pressed={mode === "basic"}
          className={`flex-1 rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
            mode === "basic" ? "bg-white/10 text-ink" : "text-ink-muted hover:text-ink"
          }`}
        >
          Basic
        </button>
        <button
          type="button"
          onClick={() => setMode("pro")}
          aria-pressed={mode === "pro"}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
            mode === "pro" ? "bg-white/10 text-ink" : "text-ink-muted hover:text-ink"
          }`}
        >
          <Sparkles className="h-3.5 w-3.5 text-signal-bright" strokeWidth={1.75} />
          Pro
        </button>
      </div>
    </div>
  );
}
