import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  ChevronLeft,
  ChevronRight,
  Music,
  Heart,
  Sparkles,
  Download,
  Trash2,
} from "lucide-react";
import { useHoverIntent } from "../lib/useHoverIntent";
import { request } from "../lib/api";
import { qk } from "../lib/queryClient";
import { formatDuration, trackTags, trackTitle } from "../lib/track";
import { useCreateUI } from "../store/createUI";
import { usePlayer } from "../store/player";
import { useDeleteTrack } from "../hooks/useDeleteTrack";
import type { TrackDetail } from "../types/api";

const SPEEDS = [1, 1.25, 1.5, 2] as const;
const SCRUB_STEP_SECONDS = 5;

type PlayerVariant = "home" | "create" | "rail";

export default function Player({
  variant = "rail",
  className = "",
}: {
  variant?: PlayerVariant;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [speedIdx, setSpeedIdx] = useState(0);
  const { hovered, onMouseEnter, onMouseLeave } = useHoverIntent();
  const queryClient = useQueryClient();
  const deleteTrack = useDeleteTrack();

  // home  → docked above the avatar, always expanded, parent-sized
  // create → pinned open, height synced to the form
  // rail   → collapsible hover rail on every other route
  const onCreate = variant === "create";
  const onHome = variant === "home";
  const playerHeight = useCreateUI((s) => s.playerHeight);

  const track = usePlayer((s) => s.track);
  const playing = usePlayer((s) => s.isPlaying);
  const setPlaying = usePlayer((s) => s.setPlaying);
  const setTrack = usePlayer((s) => s.setTrack);
  const setPosition = usePlayer((s) => s.setPosition);

  const audioRef = useRef<HTMLAudioElement>(null);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [linkDead, setLinkDead] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // One retry per loaded track. An unbounded retry against a dead presign is a
  // request loop, and the URL is only going to be dead once per refresh.
  const retriedRef = useRef(false);
  const audioUrl = track?.mp3_url ?? null;
  const trackId = track?.id ?? null;

  function flashHint(message: string) {
    setHint(message);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHint(null), 1800);
  }

  useEffect(() => () => {
    if (hintTimer.current) clearTimeout(hintTimer.current);
  }, []);

  /**
   * Presigned playback URLs expire in 15 minutes. On the <audio> error event,
   * refetch the track once and swap in the fresh URL; if that fails too, say so
   * rather than retrying into a wall.
   */
  const recoverExpiredUrl = useCallback(async () => {
    if (!trackId || retriedRef.current) {
      setLinkDead(true);
      return;
    }
    retriedRef.current = true;
    try {
      await queryClient.invalidateQueries({ queryKey: qk.track(trackId) });
      const fresh = await queryClient.fetchQuery({
        queryKey: qk.track(trackId),
        queryFn: () => request<TrackDetail>(`/tracks/${trackId}`),
      });
      setTrack(fresh);
    } catch {
      setLinkDead(true);
    }
  }, [queryClient, setTrack, trackId]);

  // Sync playback time/progress off the element.
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onTime = () => {
      setCurrent(el.currentTime);
      setPosition(el.currentTime);
      setProgress(el.duration ? el.currentTime / el.duration : 0);
    };
    const onMeta = () => setDuration(el.duration || 0);
    const onEnded = () => setPlaying(false);
    const onError = () => void recoverExpiredUrl();

    el.addEventListener("timeupdate", onTime);
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("ended", onEnded);
    el.addEventListener("error", onError);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("ended", onEnded);
      el.removeEventListener("error", onError);
    };
  }, [audioUrl, recoverExpiredUrl, setPlaying, setPosition]);

  // A different track resets the transport and the one-retry budget.
  useEffect(() => {
    retriedRef.current = false;
    setLinkDead(false);
    setCurrent(0);
    setProgress(0);
    setDuration(0);
    if (trackId) setOpen(true);
  }, [trackId]);

  useEffect(() => {
    const el = audioRef.current;
    if (el) el.playbackRate = SPEEDS[speedIdx]!;
  }, [speedIdx]);

  const toggle = useCallback(() => {
    const el = audioRef.current;
    if (!track || !el) return;
    if (playing) {
      el.pause();
      setPlaying(false);
    } else {
      void el.play().catch(() => setPlaying(false));
      setPlaying(true);
    }
  }, [playing, setPlaying, track]);

  function scrub(deltaSeconds: number) {
    const el = audioRef.current;
    if (!el || !Number.isFinite(el.duration)) return;
    el.currentTime = Math.min(Math.max(0, el.currentTime + deltaSeconds), el.duration);
  }

  /**
   * Keyboard control hangs off the play button rather than the <aside>.
   *
   * The aside is a `region` landmark; making a landmark focusable and
   * key-handling is what jsx-a11y rejects, and it is right to. Space and Enter
   * already activate a focused button natively, so this only adds scrubbing.
   */
  function onTransportKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      scrub(SCRUB_STEP_SECONDS);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      scrub(-SCRUB_STEP_SECONDS);
    }
  }

  const tags = track ? trackTags(track) : [];
  const progressPct = progress * 100;
  const totalText = formatDuration(duration || track?.length_seconds || 0);

  const expanded = onCreate || onHome || open || hovered;
  const heightStyle =
    onCreate && playerHeight
      ? { height: `clamp(460px, ${Math.round(playerHeight)}px, calc(100vh - 72px))` }
      : undefined;

  const rootClass = onHome
    ? `glass-panel flex flex-col overflow-hidden ${className}`
    : `glass-panel absolute right-3 top-1/2 z-20 flex -translate-y-1/2 flex-col overflow-hidden transition-[width] duration-300 ease-out ${
        heightStyle ? "" : "h-[460px]"
      } ${expanded ? "w-[300px]" : "w-[58px]"}`;

  return (
    <aside
      role="region"
      aria-label="Track player"
      onMouseEnter={onCreate || onHome ? undefined : onMouseEnter}
      onMouseLeave={onCreate || onHome ? undefined : onMouseLeave}
      style={onHome ? undefined : heightStyle}
      className={rootClass}
    >
      {/* Generated music has no caption track. */}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio ref={audioRef} src={audioUrl ?? undefined} preload="metadata" data-testid="player-audio" />

      {expanded ? (
        <div className="flex h-full flex-col p-4">
          {onCreate && track ? (
            <div className="mb-3 flex flex-wrap gap-1.5">
              {tags.map((tag) => (
                <span
                  key={tag}
                  className="max-w-full truncate rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-0.5 text-[11px] font-medium text-ink-muted"
                >
                  {tag}
                </span>
              ))}
            </div>
          ) : (
            <div className="mb-3 flex items-center justify-between">
              <span className="truncate text-[11px] font-semibold uppercase tracking-[0.18em] text-brand-soft/70">
                {track ? "Now Playing" : "Player"}
              </span>
              {!onCreate && !onHome && (
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  title="Collapse"
                  aria-label="Collapse player"
                  className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-white/[0.06] hover:text-ink"
                >
                  <ChevronRight className="h-[18px] w-[18px]" strokeWidth={1.75} />
                </button>
              )}
            </div>
          )}

          {track ? (
            <>
              {/* The API stores the prompt, not lyrics — show what produced the
                  track rather than inventing words it does not have. */}
              <div className="-mr-1 flex-1 overflow-y-auto pr-1">
                <p className="text-[12.5px] leading-relaxed text-ink-muted">{track.prompt}</p>
                <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-ink-faint">
                  {track.genre && <span>{track.genre}</span>}
                  {track.mood && <span>{track.mood}</span>}
                  {track.bpm !== null && <span className="tabular-nums">{track.bpm} BPM</span>}
                  <span>{track.vocal ? "Vocal" : "Instrumental"}</span>
                </div>
              </div>

              <div className="my-3 h-px w-full bg-gradient-to-r from-brand/5 via-brand/70 to-brand/5" />

              <p className="truncate text-[15px] font-semibold text-ink" title={track.prompt}>
                {trackTitle(track)}
              </p>

              <div className="mt-2.5">
                <div className="relative h-1 w-full rounded-full bg-white/10">
                  <div
                    className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-brand to-brand-soft"
                    style={{ width: `${progressPct}%` }}
                  />
                  <div
                    className="absolute top-1/2 h-2.5 w-2.5 -translate-y-1/2 -translate-x-1/2 rounded-full bg-white shadow-[0_0_8px_rgba(108,92,231,0.7)]"
                    style={{ left: `${progressPct}%` }}
                  />
                </div>
                <div className="mt-1.5 flex justify-between text-[11px] tabular-nums text-ink-faint">
                  <span>{formatDuration(current)}</span>
                  <span>{totalText}</span>
                </div>
              </div>

              <div className="mt-3 flex items-center justify-center gap-5">
                <button
                  type="button"
                  onClick={() => scrub(-SCRUB_STEP_SECONDS)}
                  title="Back 5 seconds"
                  aria-label="Back 5 seconds"
                  className="text-ink-muted transition-colors hover:text-ink"
                >
                  <SkipBack className="h-5 w-5" strokeWidth={1.75} />
                </button>
                <button
                  type="button"
                  onClick={toggle}
                  onKeyDown={onTransportKeyDown}
                  title={playing ? "Pause" : "Play"}
                  aria-label={playing ? "Pause" : "Play"}
                  className="glass-btn glass-btn-ring h-12 w-12 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60"
                >
                  {playing ? (
                    <Pause className="h-5 w-5" strokeWidth={2} fill="currentColor" />
                  ) : (
                    <Play className="ml-0.5 h-5 w-5" strokeWidth={2} fill="currentColor" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => scrub(SCRUB_STEP_SECONDS)}
                  title="Forward 5 seconds"
                  aria-label="Forward 5 seconds"
                  className="text-ink-muted transition-colors hover:text-ink"
                >
                  <SkipForward className="h-5 w-5" strokeWidth={1.75} />
                </button>
              </div>

              {linkDead && (
                <p className="mt-3 text-center text-[12px] text-amber-300/90" role="alert">
                  This link expired — refresh the page.
                </p>
              )}

              <div className="mt-3">
                <button
                  type="button"
                  onClick={() => setSpeedIdx((i) => (i + 1) % SPEEDS.length)}
                  title="Playback speed"
                  className="rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[12px] font-medium tabular-nums text-ink-muted transition-colors hover:bg-white/[0.08] hover:text-ink"
                >
                  {SPEEDS[speedIdx]}×
                </button>
              </div>

              {onCreate && (
                <div className="mt-4 border-t border-white/[0.06] pt-3">
                  <div className="flex items-center justify-around">
                    {/* Feedback (PE-06) is cut for launch — shown, disabled, and
                        labelled rather than hidden, so the question stops being
                        asked every week. */}
                    <button
                      type="button"
                      disabled
                      title="Favourites — coming soon"
                      aria-label="Favourites — coming soon"
                      className="flex h-9 w-9 items-center justify-center rounded-lg border border-transparent text-ink-faint opacity-40"
                    >
                      <Heart className="h-[18px] w-[18px]" strokeWidth={2} />
                    </button>

                    <a
                      href={`/track/${track.id}`}
                      title="Refine this track"
                      aria-label="Refine this track"
                      className="flex h-9 w-9 items-center justify-center rounded-lg border border-brand/40 text-brand-soft shadow-[0_0_10px_-2px_rgba(108,92,231,0.45)] transition-colors hover:bg-brand/10"
                    >
                      <Sparkles className="h-[18px] w-[18px]" strokeWidth={2} />
                    </a>

                    <a
                      href={track.mp3_url}
                      download
                      title="Download MP3"
                      aria-label="Download MP3"
                      className="flex h-9 w-9 items-center justify-center rounded-lg border border-transparent text-ink-muted transition-colors hover:bg-white/[0.06] hover:text-ink"
                    >
                      <Download className="h-[18px] w-[18px]" strokeWidth={2} />
                    </a>

                    <button
                      type="button"
                      onClick={() => {
                        deleteTrack.mutate(track.id);
                        setTrack(null);
                        flashHint("Deleted");
                      }}
                      title="Delete"
                      aria-label="Delete"
                      className="flex h-9 w-9 items-center justify-center rounded-lg border border-transparent text-ink-muted transition-colors hover:bg-red-500/10 hover:text-red-300"
                    >
                      <Trash2 className="h-[18px] w-[18px]" strokeWidth={2} />
                    </button>
                  </div>
                  {hint && <p className="mt-2 text-center text-[11.5px] text-ink-faint">{hint}</p>}
                </div>
              )}
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center px-2 text-center">
              <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-ink-faint">
                <Music className="h-5 w-5" strokeWidth={1.75} />
              </div>
              <p className="text-[13.5px] font-medium text-ink-muted">Select a track to play</p>
              <p className="mt-1 text-[12px] text-ink-faint">Generate something to begin.</p>
            </div>
          )}
        </div>
      ) : (
        <div className="flex h-full flex-col items-center justify-between py-4">
          <button
            type="button"
            onClick={() => setOpen(true)}
            title="Expand player"
            aria-label="Expand player"
            className="flex h-9 w-9 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-white/[0.06] hover:text-ink"
          >
            <ChevronLeft className="h-[18px] w-[18px]" strokeWidth={1.75} />
          </button>
          <button
            type="button"
            onClick={toggle}
            onKeyDown={onTransportKeyDown}
            disabled={!track}
            title={!track ? "No track loaded" : playing ? "Pause" : "Play"}
            aria-label={playing ? "Pause" : "Play"}
            className="glass-btn glass-btn-ring h-11 w-11 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60"
          >
            {playing ? (
              <Pause className="h-[18px] w-[18px]" strokeWidth={2} fill="currentColor" />
            ) : (
              <Play className="ml-0.5 h-[18px] w-[18px]" strokeWidth={2} fill="currentColor" />
            )}
          </button>
        </div>
      )}
    </aside>
  );
}
