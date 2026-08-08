import { useState } from "react";
import { Sparkles, Info } from "lucide-react";
import { AI_TOOLS } from "../lib/aiTools";
import ComingSoonDialog from "../components/ComingSoonDialog";

/**
 * The tools grid.
 *
 * Twelve opaque cards, not glass: `.surface` is what the tier rule in index.css
 * asks for once a page holds a dozen of anything, and a grid of blurred panels
 * is a dozen filter passes per composite for no legibility gained.
 */
export default function AiTools() {
  const [comingSoon, setComingSoon] = useState<string | null>(null);

  return (
    <div className="flex flex-1 flex-col py-6 sm:py-8">
      <ComingSoonDialog feature={comingSoon} onClose={() => setComingSoon(null)} />

      <div className="mx-auto w-full max-w-[1100px] animate-fade-in">
        <div className="mb-5 flex items-center gap-3">
          <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-el border border-signal/25 bg-signal/15 text-signal-bright">
            <Sparkles className="h-5 w-5" strokeWidth={1.75} />
          </span>
          <div className="min-w-0">
            <h1 className="font-display text-xl font-semibold text-ink">AI Tools</h1>
            <p className="text-sm text-ink-muted">
              Everything RITHM will do with a track once it exists.
            </p>
          </div>
        </div>

        <div className="lg-thin mb-6 flex items-start gap-2.5 rounded-el px-3.5 py-2.5">
          <Info className="mt-px h-4 w-4 flex-shrink-0 text-signal-bright" strokeWidth={2} />
          <p className="text-xs leading-relaxed text-ink-muted">
            <span className="font-medium text-ink">Real features coming soon.</span> These are the
            tools on the roadmap — open one to see where it sits.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3 lg:grid-cols-4 xl:grid-cols-5">
          {AI_TOOLS.map(({ name, description, Icon }) => (
            <button
              key={name}
              type="button"
              onClick={() => setComingSoon(name)}
              className="surface surface-hover group/tool flex flex-col items-center px-3 py-5 text-center transition-all sm:px-4"
              style={{ "--r": "16px" } as React.CSSProperties}
            >
              {/*
                The warm tint sits on the icon rather than washing the card:
                twelve tinted panels would read as twelve buttons competing,
                and the icon is the only part that needs to carry the accent.
              */}
              <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-full border border-white/[0.07] bg-white/[0.03] text-ink-muted transition-colors group-hover/tool:border-signal/25 group-hover/tool:bg-signal/15 group-hover/tool:text-signal-bright">
                <Icon className="h-5 w-5" strokeWidth={1.5} />
              </span>
              <span className="text-sm font-semibold text-ink">{name}</span>
              <span className="mt-1 text-xs leading-snug text-ink-muted">{description}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
