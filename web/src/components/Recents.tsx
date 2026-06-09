import { Play, ArrowUpRight } from "lucide-react";

interface Track {
  id: string;
  title: string;
}

// Mock recently-generated tracks — real history arrives with the Phase 2 backend.
const RECENTS: Track[] = [
  { id: "neon-rain", title: "Neon Rain" },
  { id: "golden-hour", title: "Golden Hour" },
  { id: "paper-planes", title: "Paper Planes" },
];

function WaveBars() {
  return (
    <svg width="16" height="12" viewBox="0 0 16 12" fill="none" aria-hidden="true">
      <rect x="0" y="4" width="2.4" height="4" rx="1.2" fill="currentColor" />
      <rect x="4" y="1" width="2.4" height="10" rx="1.2" fill="currentColor" />
      <rect x="8" y="3" width="2.4" height="6" rx="1.2" fill="currentColor" />
      <rect x="12" y="2" width="2.4" height="8" rx="1.2" fill="currentColor" />
    </svg>
  );
}

export default function Recents() {
  return (
    <div className="glass-panel mt-4 px-4 py-3.5">
      <div className="flex items-center gap-4">
        <span className="flex-shrink-0 text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-faint">
          Recents
        </span>

        <div className="flex flex-1 gap-2.5">
          {RECENTS.map((t) => (
            <button
              key={t.id}
              type="button"
              title={t.title}
              className="group/card flex min-w-0 flex-1 items-center gap-2.5 rounded-el border border-white/[0.07] bg-white/[0.03] px-3 py-2 text-left transition-colors hover:border-white/15 hover:bg-white/[0.07]"
            >
              <span className="relative flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-brand/15 text-brand-soft">
                <span className="transition-opacity group-hover/card:opacity-0">
                  <WaveBars />
                </span>
                <Play
                  className="absolute h-4 w-4 opacity-0 transition-opacity group-hover/card:opacity-100"
                  strokeWidth={2}
                  fill="currentColor"
                />
              </span>
              <span className="truncate text-[13px] font-medium text-ink">{t.title}</span>
            </button>
          ))}
        </div>

        <button
          type="button"
          title="Coming soon"
          className="flex flex-shrink-0 items-center gap-1 rounded-el px-2.5 py-1.5 text-[13px] font-medium text-ink-muted transition-colors hover:text-ink"
        >
          Library
          <ArrowUpRight className="h-4 w-4" strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );
}
