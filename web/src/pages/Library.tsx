import { useState } from "react";
import { Library as LibraryIcon, Music } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useTracks } from "../hooks/useTracks";
import { useDeleteTrack } from "../hooks/useDeleteTrack";
import { usePlayer } from "../store/player";
import { coverGradient } from "../lib/covers";
import { formatDuration, trackSubtitle, trackTitle } from "../lib/track";
import ErrorToast from "../components/ErrorToast";
import TrackCard from "../components/TrackCard";
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

      <div className="mx-auto w-full max-w-[1100px] animate-fade-in">
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
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3 lg:grid-cols-4 xl:grid-cols-5">
            {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
              // Proportional, not a fixed height: the card is a square cover
              // plus two lines, so it grows with the column.
              <div key={i} className="surface aspect-[3/4] animate-pulse opacity-50" />
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
            <ul className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3 lg:grid-cols-4 xl:grid-cols-5">
              {tracks.map((track) => {
                const active = currentId === track.id;
                return (
                  <li key={track.id}>
                    <TrackCard
                      title={trackTitle(track)}
                      // The prompt no longer has a line of its own under album
                      // art, so it keeps the tooltip it always had.
                      titleTooltip={track.prompt}
                      subtitle={trackSubtitle(track)}
                      gradient={coverGradient(track.id)}
                      duration={formatDuration(track.length_seconds)}
                      playing={active && isPlaying}
                      // The whole loaded library becomes the queue, so next and
                      // previous walk it in the order shown here.
                      onPlay={() =>
                        active && isPlaying ? setPlaying(false) : play(track, tracks)
                      }
                      onOpen={() => nav(`/track/${track.id}`)}
                      onDelete={() => {
                        setDismissed(false);
                        deleteTrack.mutate(track.id);
                      }}
                    />
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
