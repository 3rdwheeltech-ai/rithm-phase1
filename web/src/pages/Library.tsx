import { useState } from "react";
import { Library as LibraryIcon, Play, Pause, Trash2, Music } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useTracks } from "../hooks/useTracks";
import { useDeleteTrack } from "../hooks/useDeleteTrack";
import { usePlayer } from "../store/player";
import { formatDuration, trackTitle } from "../lib/track";
import ErrorToast from "../components/ErrorToast";
import CountUp from "../components/reactbits/CountUp";

export default function Library() {
  const nav = useNavigate();
  const { data, isLoading, hasNextPage, isFetchingNextPage, fetchNextPage } = useTracks();
  const deleteTrack = useDeleteTrack();
  const play = usePlayer((s) => s.play);
  const setPlaying = usePlayer((s) => s.setPlaying);
  const currentId = usePlayer((s) => s.track?.id ?? null);
  const isPlaying = usePlayer((s) => s.isPlaying);
  const [dismissed, setDismissed] = useState(false);

  const tracks = data?.pages.flatMap((page) => page.tracks) ?? [];
  // X-Total-Count is the server's number, and it is authoritative even while an
  // optimistic delete is in flight on this page.
  const total = data?.pages[0]?.totalCount;

  return (
    <div className="flex flex-1 flex-col py-6 sm:py-8">
      {!dismissed && (
        <ErrorToast error={deleteTrack.error} onDismiss={() => setDismissed(true)} />
      )}

      <div className="mx-auto w-full max-w-[860px] animate-fade-in">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-el border border-signal/25 bg-signal/15 text-signal-bright">
            <LibraryIcon className="h-5 w-5" strokeWidth={1.75} />
          </span>
          <div className="min-w-0">
            <h1 className="font-display text-xl font-semibold text-ink">Library</h1>
            <p className="text-sm text-ink-muted">
              {total === undefined ? (
                "Your generated tracks live here"
              ) : (
                <>
                  <CountUp to={total} className="font-mono tabular-nums" /> track
                  {total === 1 ? "" : "s"}
                </>
              )}
            </p>
          </div>
        </div>

        {isLoading ? (
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 sm:gap-3 lg:grid-cols-3">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="surface h-[112px] animate-pulse opacity-50" />
            ))}
          </div>
        ) : tracks.length === 0 ? (
          <div className="mt-10 flex flex-col items-center text-center">
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.03] text-ink-faint">
              <Music className="h-7 w-7" strokeWidth={1.5} />
            </div>
            <p className="text-md font-medium text-ink">No tracks yet</p>
            <p className="mt-1 max-w-[320px] text-sm text-ink-muted">
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
          <>
            <ul className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 sm:gap-3 lg:grid-cols-3">
              {tracks.map((track) => {
                const active = currentId === track.id;
                return (
                  <li
                    key={track.id}
                    // Opaque, not glass: thirty backdrop-filter layers in a
                    // scrolling grid is what makes a list feel cheap.
                    className="surface surface-hover group/card p-4"
                    style={{ "--r": "16px", "--pad": "16px" } as React.CSSProperties}
                  >
                    <div className="flex items-start gap-3">
                      <button
                        type="button"
                        // The whole loaded library becomes the queue, so next
                        // and previous walk it in the order shown here.
                        onClick={() =>
                          active && isPlaying ? setPlaying(false) : play(track, tracks)
                        }
                        aria-label={`${active && isPlaying ? "Pause" : "Play"} ${trackTitle(track)}`}
                        className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full border transition-colors ${
                          active
                            ? "border-signal/50 bg-signal/25 text-ink"
                            : "border-white/10 bg-signal/15 text-signal-bright group-hover/card:bg-signal/25"
                        }`}
                      >
                        {active && isPlaying ? (
                          <Pause className="h-4 w-4" strokeWidth={2} fill="currentColor" />
                        ) : (
                          <Play className="ml-0.5 h-4 w-4" strokeWidth={2} fill="currentColor" />
                        )}
                      </button>

                      <button
                        type="button"
                        onClick={() => nav(`/track/${track.id}`)}
                        className="min-w-0 flex-1 text-left"
                      >
                        <p className="truncate text-sm font-semibold text-ink">
                          {trackTitle(track)}
                        </p>
                        <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-ink-faint">
                          {track.prompt}
                        </p>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setDismissed(false);
                          deleteTrack.mutate(track.id);
                        }}
                        title="Delete"
                        aria-label={`Delete ${trackTitle(track)}`}
                        className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-control text-ink-faint transition-all hover:bg-danger/10 hover:text-danger focus-visible:opacity-100 lg:opacity-0 lg:group-hover/card:opacity-100"
                      >
                        <Trash2 className="h-4 w-4" strokeWidth={2} />
                      </button>
                    </div>

                    <div className="mt-3 flex items-center gap-2.5 font-mono text-2xs tabular-nums text-ink-faint">
                      <span>{formatDuration(track.length_seconds)}</span>
                      {track.genre && <span>{track.genre}</span>}
                      {track.bpm !== null && <span>{track.bpm} BPM</span>}
                    </div>
                  </li>
                );
              })}
            </ul>

            {hasNextPage && (
              <div className="mt-6 flex justify-center">
                <button
                  type="button"
                  onClick={() => void fetchNextPage()}
                  disabled={isFetchingNextPage}
                  className="glass-btn rounded-el px-5 py-2.5 text-sm font-medium disabled:opacity-50"
                >
                  {isFetchingNextPage ? "Loading…" : "Load more"}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
