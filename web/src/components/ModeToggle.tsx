import { useState } from "react";
import GradientText from "./GradientText/GradientText";
import ComingSoonDialog from "./ComingSoonDialog";

// Same sweep on both control states — teal into the amber "upgrade" accent
// and back, so the loop has no seam.
const UPGRADE_GRADIENT = ["#34E3C8", "#7DF3E2", "#FFB454", "#7DF3E2", "#34E3C8"];

/**
 * Basic / Pro control. Basic is the only mode that exists, permanently
 * selected — the Pro slot is a call to action, not a toggle, so it's pure
 * type (a small "Upgrade to" label giving way to a big bold "Pro" wordmark,
 * no icon standing in for a brand that doesn't have one yet) and opens the
 * same coming-soon card the rest of the app uses instead of pretending to
 * switch modes.
 *
 * Lives in the sidebar footer, so it adapts to the rail's two states: the full
 * Basic/Upgrade pill when expanded, and a single compact button when collapsed.
 */
export default function ModeToggle({ expanded = true }: { expanded?: boolean }) {
  const [showUpgrade, setShowUpgrade] = useState(false);

  // Collapsed rail — a single square button that opens the upgrade card.
  if (!expanded) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowUpgrade(true)}
          title="Upgrade to Pro"
          aria-label="Upgrade to Pro"
          className="flex h-9 w-full items-center justify-center rounded-el border border-white/10 transition-colors hover:bg-white/[0.06]"
        >
          <GradientText
            colors={UPGRADE_GRADIENT}
            animationSpeed={4}
            className="!m-0 !p-0 text-[13px] font-extrabold uppercase leading-none tracking-tight [backdrop-filter:none]"
          >
            Pro
          </GradientText>
        </button>
        <ComingSoonDialog feature={showUpgrade ? "Upgrade to Pro" : null} onClose={() => setShowUpgrade(false)} />
      </>
    );
  }

  return (
    <>
      <div className="glass-panel flex items-center gap-1 !rounded-full p-1">
        <div
          aria-pressed="true"
          className="pill-glow flex-shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium text-ink"
        >
          Basic
        </div>
        <button
          type="button"
          onClick={() => setShowUpgrade(true)}
          className="flex flex-1 items-baseline justify-center gap-1 rounded-full px-3 py-1.5 transition-colors hover:bg-white/[0.06]"
        >
          <span className="text-[10px] font-medium uppercase tracking-wide text-ink-faint">Upgrade to</span>
          <GradientText
            colors={UPGRADE_GRADIENT}
            animationSpeed={4}
            className="!m-0 !p-0 text-lg font-extrabold leading-none tracking-tight [backdrop-filter:none]"
          >
            Pro
          </GradientText>
        </button>
      </div>
      <ComingSoonDialog feature={showUpgrade ? "Upgrade to Pro" : null} onClose={() => setShowUpgrade(false)} />
    </>
  );
}
