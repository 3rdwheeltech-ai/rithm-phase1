import { Play, ArrowUpRight } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useGeneration } from "../store/generation";

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
  const nav = useNavigate();
  const history = useGeneration((s) => s.history);
  const current = useGeneration((s) => s.current);
  const setCurrent = useGeneration((s) => s.setCurrent);

  const items = history.slice(0, 3);

  return (
    <div className="glass-panel mt-4 px-4 py-3.5">
      <div className="flex items-center gap-4">
        <span className="flex-shrink-0 text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-faint">
          Recents
        </span>

        {items.length > 0 ? (
          <div className="flex flex-1 gap-2.5">
            {items.map((t) => {
              const active = current?.id === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  title={`Play ${t.title}`}
                  onClick={() => setCurrent(t)}
                  className={`group/card flex min-w-0 flex-1 items-center gap-2.5 rounded-el border px-3 py-2 text-left transition-colors ${
                    active
                      ? "border-brand/30 bg-brand/15"
                      : "border-white/[0.07] bg-white/[0.03] hover:border-white/15 hover:bg-white/[0.07]"
                  }`}
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
              );
            })}
          </div>
        ) : (
          <p className="flex-1 text-[13px] text-ink-faint">
            Generate a track to get started — it'll show up here.
          </p>
        )}

        <button
          type="button"
          onClick={() => nav("/library")}
          title="Open Library"
          className="flex flex-shrink-0 items-center gap-1 rounded-el px-2.5 py-1.5 text-[13px] font-medium text-ink-muted transition-colors hover:text-ink"
        >
          Library
          <ArrowUpRight className="h-4 w-4" strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );
}
