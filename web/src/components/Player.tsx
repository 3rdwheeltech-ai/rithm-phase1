import { useCallback, useEffect, useRef, useState } from "react";
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Rewind,
  FastForward,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Music,
  Heart,
  Sparkles,
  Download,
  Trash2,
} from "lucide-react";
import { cn } from "../lib/cn";
import { useHoverIntent } from "../lib/useHoverIntent";
import { useLens } from "../lib/useLens";
import { mergeRefs, useSpecular } from "../lib/useSpecular";
import { formatDuration, trackTags, trackTitle } from "../lib/track";
import { useCreateUI } from "../store/createUI";
import { hasNext, hasPrevious, usePlayer } from "../store/player";
import { useDeleteTrack } from "../hooks/useDeleteTrack";
import { useTrack } from "../hooks/useTrack";
import CoverArt from "./CoverArt";

const SPEEDS = [1, 1.25, 1.5, 2] as const;
const SCRUB_STEP_SECONDS = 5;
/** Past this many seconds in, Previous restarts the track instead of skipping. */
const RESTART_THRESHOLD_SECONDS = 3;

type PlayerVariant = "home" | "create" | "rail" | "mobile";

/**
 * ProgressTrack and Transport are MODULE-LEVEL on purpose.
 *
 * Declared inside Player they were a new component *type* on every render, so
 * React unmounted and remounted them each time — and `timeupdate` fires several
 * times a second during playback. The controls were being destroyed and rebuilt
 * under the pointer, which is why nothing could be clicked or dragged while a
 * track was playing. Keep them out here.
 */

/** Scrubbable progress track plus its two timecodes. Click, drag or arrow. */
function ProgressTrack({
  big = false,
  progressPct,
  current,
  totalText,
  duration,
  onSeekRatio,
  onScrub,
}: {
  big?: boolean;
  progressPct: number;
  current: number;
  totalText: string;
  duration: number;
  onSeekRatio: (ratio: number) => void;
  onScrub: (deltaSeconds: number) => void;
}) {
  const railRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  const ratioFromEvent = useCallback((clientX: number) => {
    const rail = railRef.current;
    if (!rail) return 0;
    const rect = rail.getBoundingClientRect();
    return rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
  }, []);

  // Pointer capture is what makes the drag survive leaving the 8px-tall rail —
  // without it the browser stops delivering moves the moment the cursor slips
  // above or below, and the scrub dies halfway through.
  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (duration <= 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    onSeekRatio(ratioFromEvent(e.clientX));
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragging) return;
    onSeekRatio(ratioFromEvent(e.clientX));
  }

  function endDrag(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragging) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setDragging(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      onScrub(SCRUB_STEP_SECONDS);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      onScrub(-SCRUB_STEP_SECONDS);
    } else if (e.key === "Home") {
      e.preventDefault();
      onSeekRatio(0);
    } else if (e.key === "End") {
      e.preventDefault();
      onSeekRatio(1);
    }
  }

  return (
    <div>
      {/*
        A real slider, not a button: it reports its position to assistive tech
        and takes arrow keys, which a <button> never did.
      */}
      <div
        ref={railRef}
        role="slider"
        tabIndex={0}
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration) || 0}
        aria-valuenow={Math.round(current)}
        aria-valuetext={formatDuration(current)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
        className={cn(
          "relative w-full touch-none rounded-full outline-none focus-visible:ring-2 focus-visible:ring-signal/60",
          duration > 0 ? "cursor-pointer" : "cursor-default",
          big ? "h-2" : "h-1",
        )}
      >
        <span className="absolute inset-0 rounded-full bg-white/10" />
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-signal-dim to-signal"
          style={{ width: `${progressPct}%` }}
        />
        <span
          className={cn(
            "absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_0_8px_rgb(52_227_200/0.7)] transition-transform",
            dragging && "scale-125",
            big ? "h-3.5 w-3.5" : "h-2.5 w-2.5",
          )}
          style={{ left: `${progressPct}%` }}
        />
      </div>
      <div
        className={cn(
          "mt-1.5 flex justify-between font-mono tabular-nums text-ink-faint",
          big ? "text-xs" : "text-2xs",
        )}
      >
        <span>{formatDuration(current)}</span>
        <span>{totalText}</span>
      </div>
    </div>
  );
}

/** Previous · play/pause · next, with ±5s on the outer edges. */
function Transport({
  big = false,
  playing,
  hasTrack,
  canGoNext,
  canGoPrevious,
  onToggle,
  onNext,
  onPrevious,
  onScrub,
}: {
  big?: boolean;
  playing: boolean;
  hasTrack: boolean;
  canGoNext: boolean;
  canGoPrevious: boolean;
  onToggle: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onScrub: (deltaSeconds: number) => void;
}) {
  const icon = big ? "h-6 w-6" : "h-5 w-5";
  const ghost =
    "flex h-11 w-11 items-center justify-center rounded-full text-ink-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-30";

  return (
    <div className={cn("flex items-center justify-center", big ? "gap-5" : "gap-3")}>
      <button
        type="button"
        onClick={() => onScrub(-SCRUB_STEP_SECONDS)}
        disabled={!hasTrack}
        title="Back 5 seconds"
        aria-label="Back 5 seconds"
        className={cn(ghost, big ? "" : "hidden sm:flex")}
      >
        <Rewind className={icon} strokeWidth={1.75} />
      </button>
      <button
        type="button"
        onClick={onPrevious}
        disabled={!canGoPrevious}
        title="Previous track"
        aria-label="Previous track"
        className={ghost}
      >
        <SkipBack className={icon} strokeWidth={1.75} />
      </button>
      <button
        type="button"
        onClick={onToggle}
        disabled={!hasTrack}
        title={playing ? "Pause" : "Play"}
        aria-label={playing ? "Pause" : "Play"}
        className={cn(
          "glass-btn glass-btn-ring rounded-full disabled:opacity-40",
          big ? "h-16 w-16" : "h-12 w-12",
        )}
      >
        {playing ? (
          <Pause className={big ? "h-7 w-7" : "h-5 w-5"} strokeWidth={2} fill="currentColor" />
        ) : (
          <Play
            className={cn("ml-0.5", big ? "h-7 w-7" : "h-5 w-5")}
            strokeWidth={2}
            fill="currentColor"
          />
        )}
      </button>
      <button
        type="button"
        onClick={onNext}
        disabled={!canGoNext}
        title="Next track"
        aria-label="Next track"
        className={ghost}
      >
        <SkipForward className={icon} strokeWidth={1.75} />
      </button>
      <button
        type="button"
        onClick={() => onScrub(SCRUB_STEP_SECONDS)}
        disabled={!hasTrack}
        title="Forward 5 seconds"
        aria-label="Forward 5 seconds"
        className={cn(ghost, big ? "" : "hidden sm:flex")}
      >
        <FastForward className={icon} strokeWidth={1.75} />
      </button>
    </div>
  );
}

export default function Player({
  variant = "rail",
  compact = false,
  className = "",
}: {
  variant?: PlayerVariant;
  /**
   * Shrink to a one-line bar. Meaningful only with variant="home", where the
   * chat panel takes the rest of the column.
   *
   * It selects a BODY inside the existing desktop return — never an early
   * return of its own. The `if (onMobile)` branch below is the counter-example
   * and it carries a second <audio> element for exactly that reason; a third
   * one here would be a third place playback can be cut.
   */
  compact?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [speedIdx, setSpeedIdx] = useState(0);
  const { hovered, onMouseEnter, onMouseLeave } = useHoverIntent();
  const deleteTrack = useDeleteTrack();

  // home   → docked above the avatar, always expanded, parent-sized
  // create → pinned open, height synced to the form
  // rail   → collapsible hover rail on every other desktop route
  // mobile → mini bar above the tab bar, expanding to a full-screen sheet
  const onCreate = variant === "create";
  const onHome = variant === "home";
  const onMobile = variant === "mobile";
  const playerHeight = useCreateUI((s) => s.playerHeight);

  const track = usePlayer((s) => s.track);
  const playing = usePlayer((s) => s.isPlaying);
  const setPlaying = usePlayer((s) => s.setPlaying);
  const setTrack = usePlayer((s) => s.setTrack);
  const setPosition = usePlayer((s) => s.setPosition);
  const next = usePlayer((s) => s.next);
  const previous = usePlayer((s) => s.previous);
  const canGoNext = usePlayer(hasNext);
  const canGoPrevious = usePlayer(hasPrevious);

  const audioRef = useRef<HTMLAudioElement>(null);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [linkDead, setLinkDead] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const panelLensRef = useLens<HTMLElement>("md", 24);
  const panelSpecularRef = useSpecular<HTMLElement>();
  const miniLensRef = useLens<HTMLDivElement>("md", 999);

  // One retry per loaded track. An unbounded retry against a dead presign is a
  // request loop, and the URL is only going to be dead once per refresh.
  const retriedRef = useRef(false);
  const audioUrl = track?.mp3_url ?? null;
  const trackId = track?.id ?? null;
  // The store holds a TrackSummary, which carries no lyrics. This reads the
  // detail off the SAME query key the expiry-recovery path and useJobStream
  // already populate, so on the common paths it is a cache hit, not a request.
  const { data: detail, refetch: refetchDetail } = useTrack(trackId ?? undefined);
  const lyrics = detail?.id === trackId ? detail.lyrics : null;

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
    // refetch() on the panel's own query, NOT a second fetchQuery on the same
    // key. Two owners of one key means invalidate wakes both and the retry
    // budget this function exists to enforce is quietly spent twice.
    const { data: fresh } = await refetchDetail();
    if (fresh) {
      setTrack(fresh);
    } else {
      setLinkDead(true);
    }
  }, [refetchDetail, setTrack, trackId]);

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
    // Run the queue out rather than stopping dead on every track. `next()` is
    // a no-op at the end of the queue, so the guard is the same check the Next
    // button is disabled by.
    const onEnded = () => {
      if (hasNext(usePlayer.getState())) next();
      else setPlaying(false);
    };
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
  }, [audioUrl, recoverExpiredUrl, setPlaying, setPosition, next]);

  // A different track resets the transport and the one-retry budget.
  useEffect(() => {
    retriedRef.current = false;
    setLinkDead(false);
    setCurrent(0);
    setProgress(0);
    setDuration(0);
    if (trackId) setOpen(true);
  }, [trackId]);

  /**
   * Carry playback across a track change.
   *
   * Swapping `src` always pauses the element, so without this, Next loads the
   * following track and silently stops — which reads as a dead button. Bound to
   * `audioUrl` rather than `trackId` because the recovery refetch swaps the URL
   * on the same track and has to resume too.
   */
  useEffect(() => {
    const el = audioRef.current;
    if (!el || !audioUrl || !playing) return;
    void el.play().catch(() => setPlaying(false));
    // `playing` is deliberately NOT a dep: this fires on a URL change, and
    // including it would fight the pause branch of `toggle`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioUrl]);

  useEffect(() => {
    const el = audioRef.current;
    if (el) el.playbackRate = SPEEDS[speedIdx]!;
  }, [speedIdx]);

  // The sheet is a mobile affordance; widening past `lg` should not leave it
  // stranded over the desktop layout.
  useEffect(() => {
    if (!onMobile) setSheetOpen(false);
  }, [onMobile]);

  // A full-screen sheet over a scrolling page scrolls the page behind it.
  useEffect(() => {
    if (!sheetOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [sheetOpen]);

  useEffect(() => {
    if (!sheetOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setSheetOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [sheetOpen]);

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

  const scrub = useCallback((deltaSeconds: number) => {
    const el = audioRef.current;
    if (!el || !Number.isFinite(el.duration)) return;
    el.currentTime = Math.min(Math.max(0, el.currentTime + deltaSeconds), el.duration);
  }, []);

  /** Seek from a click or drag anywhere on a progress track. */
  const seekTo = useCallback(
    (ratio: number) => {
      const el = audioRef.current;
      if (!el || !Number.isFinite(el.duration)) return;
      const seconds = Math.min(Math.max(0, ratio), 1) * el.duration;
      el.currentTime = seconds;
      // Paused drags would otherwise show a stale thumb: `timeupdate` does fire
      // while paused, but not before the first play, so paint it ourselves.
      setCurrent(seconds);
      setProgress(el.duration ? seconds / el.duration : 0);
    },
    [],
  );

  /**
   * Previous restarts the current track unless we are near its start.
   *
   * That decision needs the live playhead, which only this component has — the
   * store's `position` lags by up to a `timeupdate` tick.
   */
  const onPrevious = useCallback(() => {
    const el = audioRef.current;
    if (el && el.currentTime > RESTART_THRESHOLD_SECONDS) {
      seekTo(0);
      return;
    }
    if (canGoPrevious) previous();
    else seekTo(0);
  }, [canGoPrevious, previous, seekTo]);

  const tags = track ? trackTags(track) : [];
  const progressPct = progress * 100;
  const totalText = formatDuration(duration || track?.length_seconds || 0);

  const expanded = onCreate || onHome || open || hovered;
  const heightStyle =
    onCreate && playerHeight
      ? { height: `clamp(460px, ${Math.round(playerHeight)}px, calc(100vh - 72px))` }
      : undefined;

  const speedButton = (
    <button
      type="button"
      onClick={() => setSpeedIdx((i) => (i + 1) % SPEEDS.length)}
      title="Playback speed"
      className="rounded-control border border-white/10 bg-white/[0.04] px-2.5 py-1 font-mono text-xs font-medium tabular-nums text-ink-muted transition-colors hover:bg-white/[0.08] hover:text-ink"
    >
      {SPEEDS[speedIdx]}×
    </button>
  );

  /*
    The mini bar's contents, shared by the mobile dock and by compact Home.
    Two consts rather than a nested component: a component declared in here is
    a new type on every render, and `timeupdate` fires several times a second
    during playback — which is what used to destroy and rebuild these controls
    under the user's pointer. See the note on ProgressTrack above.
  */
  const miniIdentity = track ? (
    <>
      <CoverArt seed={track.id} className="h-10 w-10 shrink-0 rounded-full" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-ink">
          {trackTitle(track)}
        </span>
        <span className="block truncate font-mono text-2xs tabular-nums text-ink-faint">
          {formatDuration(current)} / {totalText}
        </span>
      </span>
    </>
  ) : null;

  const miniPlayButton = (
    <button
      type="button"
      onClick={toggle}
      title={playing ? "Pause" : "Play"}
      aria-label={playing ? "Pause" : "Play"}
      className="glass-btn glass-btn-ring h-11 w-11 shrink-0 rounded-full"
    >
      {playing ? (
        <Pause className="h-[18px] w-[18px]" strokeWidth={2} fill="currentColor" />
      ) : (
        <Play className="ml-0.5 h-[18px] w-[18px]" strokeWidth={2} fill="currentColor" />
      )}
    </button>
  );

  const emptyState = (
    <div className="flex flex-1 flex-col items-center justify-center px-2 text-center">
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-ink-faint">
        <Music className="h-5 w-5" strokeWidth={1.75} />
      </div>
      <p className="text-sm font-medium text-ink-muted">Select a track to play</p>
      <p className="mt-1 text-xs text-ink-faint">Generate something to begin.</p>
    </div>
  );

  // ── Mobile ───────────────────────────────────────────────────────────────
  if (onMobile) {
    return (
      <aside role="region" aria-label="Track player" className={className}>
        {/* Generated music has no caption track. */}
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <audio
          ref={audioRef}
          src={audioUrl ?? undefined}
          preload="metadata"
          data-testid="player-audio"
        />

        {track && (
          <div
            ref={miniLensRef}
            className="lg-lens mx-auto flex max-w-[420px] items-center gap-3 p-2 pr-3"
            style={{ "--r": "999px" } as React.CSSProperties}
          >
            <button
              type="button"
              onClick={() => setSheetOpen(true)}
              aria-label={`Open player for ${trackTitle(track)}`}
              className="flex min-w-0 flex-1 items-center gap-3 text-left"
            >
              {miniIdentity}
            </button>

            {miniPlayButton}
          </div>
        )}

        {/* Full-screen sheet — the Apple Music morph, in CSS. */}
        {track && (
          <div
            className={cn(
              "fixed inset-0 z-50 transition-opacity duration-300 ease-sheet",
              sheetOpen ? "opacity-100" : "pointer-events-none opacity-0",
            )}
          >
            <button
              type="button"
              aria-label="Close player"
              tabIndex={sheetOpen ? 0 : -1}
              onClick={() => setSheetOpen(false)}
              className="absolute inset-0 h-full w-full cursor-default bg-black/60 backdrop-blur-md"
            />

            <div
              className={cn(
                "absolute inset-x-0 bottom-0 top-8 flex flex-col overflow-y-auto rounded-t-sheet border-t border-white/10 bg-room-raised/95 px-5 pb-[calc(env(safe-area-inset-bottom)+24px)] pt-3 backdrop-blur-2xl",
                "transition-transform duration-[420ms] ease-sheet",
                sheetOpen ? "translate-y-0" : "translate-y-full",
              )}
            >
              <div className="mx-auto mb-1 h-1 w-10 shrink-0 rounded-full bg-white/20" />
              <button
                type="button"
                onClick={() => setSheetOpen(false)}
                aria-label="Close player"
                className="-ml-2 mb-2 flex h-10 w-10 items-center justify-center self-start rounded-full text-ink-muted transition-colors hover:bg-white/[0.06] hover:text-ink"
              >
                <ChevronDown className="h-5 w-5" strokeWidth={2} />
              </button>

              <CoverArt
                seed={track.id}
                className="mx-auto aspect-square w-full max-w-[300px] shrink-0 rounded-card"
              />

              <h2 className="mt-6 text-lg font-semibold text-ink">{trackTitle(track)}</h2>
              <p className="mt-1 text-sm leading-relaxed text-ink-muted">{track.prompt}</p>

              <div className="mt-3 flex flex-wrap gap-1.5">
                {tags.map((tag) => (
                  <span
                    key={tag}
                    className="lg-thin max-w-full truncate rounded-full px-2.5 py-0.5 text-2xs font-medium text-ink-muted"
                  >
                    {tag}
                  </span>
                ))}
              </div>

              <div className="mt-6">
                <ProgressTrack
                  big
                  progressPct={progressPct}
                  current={current}
                  totalText={totalText}
                  duration={duration}
                  onSeekRatio={seekTo}
                  onScrub={scrub}
                />
              </div>

              <div className="mt-5">
                <Transport
                  big
                  playing={playing}
                  hasTrack={!!track}
                  canGoNext={canGoNext}
                  canGoPrevious={canGoPrevious}
                  onToggle={toggle}
                  onNext={next}
                  onPrevious={onPrevious}
                  onScrub={scrub}
                />
              </div>

              {linkDead && (
                <p className="mt-4 text-center text-xs text-amber" role="alert">
                  This link expired — refresh the page.
                </p>
              )}

              <div className="mt-6 flex items-center justify-between border-t border-white/[0.06] pt-4">
                {speedButton}
                <div className="flex items-center gap-1">
                  <a
                    href={`/track/${track.id}`}
                    title="Refine this track"
                    aria-label="Refine this track"
                    className="flex h-11 w-11 items-center justify-center rounded-control border border-signal/40 text-signal-bright transition-colors hover:bg-signal/10"
                  >
                    <Sparkles className="h-[18px] w-[18px]" strokeWidth={2} />
                  </a>
                  <a
                    href={track.mp3_url}
                    download
                    title="Download MP3"
                    aria-label="Download MP3"
                    className="flex h-11 w-11 items-center justify-center rounded-control text-ink-muted transition-colors hover:bg-white/[0.06] hover:text-ink"
                  >
                    <Download className="h-[18px] w-[18px]" strokeWidth={2} />
                  </a>
                  <button
                    type="button"
                    onClick={() => {
                      deleteTrack.mutate(track.id);
                      setTrack(null);
                      setSheetOpen(false);
                    }}
                    title="Delete"
                    aria-label="Delete"
                    className="flex h-11 w-11 items-center justify-center rounded-control text-ink-muted transition-colors hover:bg-danger/10 hover:text-danger"
                  >
                    <Trash2 className="h-[18px] w-[18px]" strokeWidth={2} />
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </aside>
    );
  }

  // ── Desktop ──────────────────────────────────────────────────────────────
  // Compact and EMPTY is `hidden`, never unmounted: unmounting takes the
  // <audio> with it and kills playback, and an empty `.lg-lens` still paints a
  // lit rim and two drop shadows for nothing.
  const compactHome = onHome && compact;
  const rootClass = onHome
    ? cn(
        "lg-lens flex flex-col overflow-hidden",
        compactHome && !track && "hidden",
        className,
      )
    : cn(
        "lg-lens fixed right-3 top-1/2 z-20 flex -translate-y-1/2 flex-col overflow-hidden transition-[width] duration-300 ease-sheet",
        !heightStyle && "h-[460px]",
        expanded ? "w-[300px]" : "w-[58px]",
      );

  return (
    <aside
      ref={mergeRefs(panelLensRef, panelSpecularRef)}
      role="region"
      aria-label="Track player"
      onMouseEnter={onCreate || onHome ? undefined : onMouseEnter}
      onMouseLeave={onCreate || onHome ? undefined : onMouseLeave}
      style={{ ...(onHome ? undefined : heightStyle), "--r": "24px" } as React.CSSProperties}
      className={rootClass}
    >
      {/* Generated music has no caption track. */}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio
        ref={audioRef}
        src={audioUrl ?? undefined}
        preload="metadata"
        data-testid="player-audio"
      />

      {/*
        `compact` is checked BEFORE `expanded` — `expanded` is
        `onCreate || onHome || open || hovered`, which is unconditionally true
        on Home, so an else-branch would never be reached. And no `key` on any
        of these: a key here remounts the subtree, <audio> included.

        `--r` stays 24px in compact rather than becoming a 999px pill. The
        aside's lens is useLens("md", 24) and the lens radius must match `--r`
        or the refracted rim drifts off the CSS corner — useLens reads its
        radius through a ref and redraws only on resize, so a radius that
        changes without a size change is a latent bug. A 24px bar under a 24px
        panel is the more coherent reading anyway.
      */}
      {compactHome ? (
        <div className="flex items-center gap-3 p-2 pr-3">
          <div className="flex min-w-0 flex-1 items-center gap-3">{miniIdentity}</div>
          {miniPlayButton}
        </div>
      ) : expanded ? (
        <div className="flex h-full flex-col p-4">
          {onCreate && track ? (
            <div className="mb-3 flex flex-wrap gap-1.5">
              {tags.map((tag) => (
                <span
                  key={tag}
                  className="lg-thin max-w-full truncate rounded-full px-2.5 py-0.5 text-2xs font-medium text-ink-muted"
                >
                  {tag}
                </span>
              ))}
            </div>
          ) : (
            <div className="mb-3 flex items-center justify-between">
              <span className="eyebrow truncate">{track ? "Now Playing" : "Player"}</span>
              {!onCreate && !onHome && (
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  title="Collapse"
                  aria-label="Collapse player"
                  className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-control text-ink-faint transition-colors hover:bg-white/[0.06] hover:text-ink"
                >
                  <ChevronRight className="h-[18px] w-[18px]" strokeWidth={1.75} />
                </button>
              )}
            </div>
          )}

          {track ? (
            <>
              {/* Lyrics when the user supplied them, the prompt otherwise. A
                  track whose words the model wrote has no lyrics stored, and
                  inventing words it does not have is worse than showing what
                  produced it. */}
              <div className="-mr-1 flex-1 overflow-y-auto pr-1">
                {lyrics ? (
                  <p className="whitespace-pre-wrap font-mono text-2xs leading-relaxed text-ink-muted">
                    {lyrics}
                  </p>
                ) : (
                  <p className="text-xs leading-relaxed text-ink-muted">{track.prompt}</p>
                )}
                <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-2xs text-ink-faint">
                  {track.genre && <span>{track.genre}</span>}
                  {track.mood && <span>{track.mood}</span>}
                  {track.bpm !== null && (
                    <span className="font-mono tabular-nums">{track.bpm} BPM</span>
                  )}
                  <span>{track.vocal ? "Vocal" : "Instrumental"}</span>
                </div>
              </div>

              <div className="my-3 h-px w-full bg-gradient-to-r from-signal/5 via-signal/70 to-signal/5" />

              <p className="truncate text-base font-semibold text-ink" title={track.prompt}>
                {trackTitle(track)}
              </p>

              <div className="mt-2.5">
                <ProgressTrack
                  progressPct={progressPct}
                  current={current}
                  totalText={totalText}
                  duration={duration}
                  onSeekRatio={seekTo}
                  onScrub={scrub}
                />
              </div>

              <div className="mt-3">
                <Transport
                  playing={playing}
                  hasTrack={!!track}
                  canGoNext={canGoNext}
                  canGoPrevious={canGoPrevious}
                  onToggle={toggle}
                  onNext={next}
                  onPrevious={onPrevious}
                  onScrub={scrub}
                />
              </div>

              {linkDead && (
                <p className="mt-3 text-center text-xs text-amber" role="alert">
                  This link expired — refresh the page.
                </p>
              )}

              <div className="mt-3">{speedButton}</div>

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
                      className="flex h-9 w-9 items-center justify-center rounded-control border border-transparent text-ink-faint opacity-40"
                    >
                      <Heart className="h-[18px] w-[18px]" strokeWidth={2} />
                    </button>

                    <a
                      href={`/track/${track.id}`}
                      title="Refine this track"
                      aria-label="Refine this track"
                      className="flex h-9 w-9 items-center justify-center rounded-control border border-signal/40 text-signal-bright transition-colors hover:bg-signal/10"
                    >
                      <Sparkles className="h-[18px] w-[18px]" strokeWidth={2} />
                    </a>

                    <a
                      href={track.mp3_url}
                      download
                      title="Download MP3"
                      aria-label="Download MP3"
                      className="flex h-9 w-9 items-center justify-center rounded-control border border-transparent text-ink-muted transition-colors hover:bg-white/[0.06] hover:text-ink"
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
                      className="flex h-9 w-9 items-center justify-center rounded-control border border-transparent text-ink-muted transition-colors hover:bg-danger/10 hover:text-danger"
                    >
                      <Trash2 className="h-[18px] w-[18px]" strokeWidth={2} />
                    </button>
                  </div>
                  {hint && <p className="mt-2 text-center text-2xs text-ink-faint">{hint}</p>}
                </div>
              )}
            </>
          ) : (
            emptyState
          )}
        </div>
      ) : (
        <div className="flex h-full flex-col items-center justify-between py-4">
          <button
            type="button"
            onClick={() => setOpen(true)}
            title="Expand player"
            aria-label="Expand player"
            className="flex h-9 w-9 items-center justify-center rounded-control text-ink-muted transition-colors hover:bg-white/[0.06] hover:text-ink"
          >
            <ChevronLeft className="h-[18px] w-[18px]" strokeWidth={1.75} />
          </button>
          <button
            type="button"
            onClick={toggle}
            disabled={!track}
            title={!track ? "No track loaded" : playing ? "Pause" : "Play"}
            aria-label={playing ? "Pause" : "Play"}
            className="glass-btn glass-btn-ring h-11 w-11 rounded-full"
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
