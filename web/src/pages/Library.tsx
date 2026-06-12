import { Library as LibraryIcon, Play, Pause, Hash, Heart } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useGeneration } from "../store/generation";

const fmt = (seconds: number | null) => {
  if (!seconds || !Number.isFinite(seconds)) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
};

export default function Library() {
  const nav = useNavigate();
  const history = useGeneration((s) => s.history);
  const current = useGeneration((s) => s.current);
  const setCurrent = useGeneration((s) => s.setCurrent);

  return (
    <div className="flex flex-1 flex-col py-8">
      <div className="mx-auto w-full max-w-[860px] animate-fade-in">
          <div className="mb-6 flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-brand/25 bg-brand/15 text-brand-soft">
              <LibraryIcon className="h-5 w-5" strokeWidth={1.75} />
            </span>
            <div>
              <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-ink">Library</h1>
              <p className="text-[13px] text-ink-muted">
                {history.length > 0
                  ? `${history.length} track${history.length === 1 ? "" : "s"} this session`
                  : "Your generated tracks live here"}
              </p>
            </div>
          </div>

          {history.length === 0 ? (
            <div className="mt-10 flex flex-col items-center text-center">
              <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.03] text-ink-faint">
                <LibraryIcon className="h-7 w-7" strokeWidth={1.5} />
              </div>
              <p className="text-[15px] font-medium text-ink">No tracks yet</p>
              <p className="mt-1 max-w-[320px] text-[13px] text-ink-muted">
                Generate something and it'll show up here, ready to play.
              </p>
              <button
                type="button"
                onClick={() => nav("/create")}
                className="btn-primary mt-5 w-auto px-5"
              >
                Create a track
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {history.map((t) => {
                const active = current?.id === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setCurrent(t)}
                    title={`Play ${t.title}`}
                    className={`glass-panel group/card flex flex-col gap-3 p-4 text-left transition-all hover:-translate-y-0.5 ${
                      active ? "ring-1 ring-brand/50" : ""
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <span
                        className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full border transition-colors ${
                          active
                            ? "border-brand/50 bg-brand/25 text-ink"
                            : "border-white/10 bg-brand/15 text-brand-soft group-hover/card:bg-brand/25"
                        }`}
                      >
                        {active ? (
                          <Pause className="h-4 w-4" strokeWidth={2} fill="currentColor" />
                        ) : (
                          <Play className="ml-0.5 h-4 w-4" strokeWidth={2} fill="currentColor" />
                        )}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[14px] font-semibold text-ink">{t.title}</p>
                        <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-ink-faint">
                          {t.prompt || "—"}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center justify-between text-[11.5px] tabular-nums text-ink-faint">
                      <span className="flex items-center gap-1.5">
                        {fmt(t.durationSeconds)}
                        {t.liked && (
                          <Heart className="h-3 w-3 text-brand-soft" strokeWidth={2} fill="currentColor" />
                        )}
                      </span>
                      {t.seed && (
                        <span className="flex items-center gap-1">
                          <Hash className="h-3 w-3" strokeWidth={2} />
                          {t.seed.split(",")[0]}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
      </div>
    </div>
  );
}
