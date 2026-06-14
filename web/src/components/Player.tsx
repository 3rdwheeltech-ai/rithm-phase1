import { useEffect, useRef, useState } from "react";
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
  FolderPlus,
  Trash2,
} from "lucide-react";
import { useHoverIntent } from "../lib/useHoverIntent";
import { useCreateUI } from "../store/createUI";
import { useGeneration } from "../store/generation";

const fmt = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
};

const SPEEDS = [1, 1.25, 1.5, 2] as const;

type PlayerVariant = "home" | "create" | "rail";

export default function Player({
  variant = "rail",
  className = "",
}: {
  variant?: PlayerVariant;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [speedIdx, setSpeedIdx] = useState(0);
  const { hovered, onMouseEnter, onMouseLeave } = useHoverIntent();

  // home  → docked above the avatar, always expanded, parent-sized
  // create → pinned open, height synced to the form
  // rail   → collapsible hover rail on every other route
  const onCreate = variant === "create";
  const onHome = variant === "home";
  const playerHeight = useCreateUI((s) => s.playerHeight);

  // Real generated track (null until the first Generate/Create completes).
  const current = useGeneration((s) => s.current);
  const toggleLike = useGeneration((s) => s.toggleLike);
  const removeTrack = useGeneration((s) => s.removeTrack);
  const track = current ?? null;
  const audioUrl = track?.audioUrl ?? null;

  // Transient "coming soon" hint for the placeholder actions.
  const [hint, setHint] = useState<string | null>(null);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function flashHint(msg: string) {
    setHint(msg);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHint(null), 1800);
  }

  const audioRef = useRef<HTMLAudioElement>(null);
  const [progress, setProgress] = useState(0);
  const [dur, setDur] = useState(0);
  const [cur, setCur] = useState(0);

  // Sync playback time/progress from the <audio> element.
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onTime = () => {
      setCur(el.currentTime);
      setProgress(el.duration ? el.currentTime / el.duration : 0);
    };
    const onMeta = () => setDur(el.duration || 0);
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("loadedmetadata", onMeta);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("loadedmetadata", onMeta);
    };
  }, [audioUrl]);

  // Reset transport when a new track loads, and reveal the player so a finished
  // track shows itself (on /create it's already pinned open).
  useEffect(() => {
    setPlaying(false);
    setCur(0);
    setProgress(0);
    setDur(0);
    if (audioUrl) setOpen(true);
  }, [audioUrl]);

  // Apply playback speed.
  useEffect(() => {
    const el = audioRef.current;
    if (el) el.playbackRate = SPEEDS[speedIdx];
  }, [speedIdx]);

  function toggle() {
    const el = audioRef.current;
    if (!track || !el) return; // nothing loaded yet
    if (playing) el.pause();
    else void el.play();
    setPlaying((p) => !p);
  }

  // Display values for the loaded track.
  const lyricLines = track && track.lyrics.length ? track.lyrics : ["Instrumental — no lyrics."];
  const progressPct = progress * 100;
  const curText = fmt(cur);
  const totalText = fmt(dur || track?.durationSeconds || 0);

  // First 5–6 style tags, derived from the prompt (no tags field on the track).
  const tags = track
    ? track.prompt.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 6)
    : [];

  // home/create are always open; create tracks the form's height. The rail stays
  // collapsible at its default height. On home the parent (Layout's right column)
  // owns positioning and size, so we drop the self-positioning classes there.
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
      onMouseEnter={onCreate || onHome ? undefined : onMouseEnter}
      onMouseLeave={onCreate || onHome ? undefined : onMouseLeave}
      style={onHome ? undefined : heightStyle}
      className={rootClass}
    >
      {/* Music playback element — captions are not applicable to generated songs. */}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio ref={audioRef} src={track?.audioUrl} preload="metadata" />
      {expanded ? (
        <div className="flex h-full flex-col p-4">
          {/* Header — on /create, the song's style tags sit at the top
              (a project-name label will live above these once projects exist). */}
          {onCreate && track ? (
            <div className="mb-3 flex flex-wrap gap-1.5">
              {tags.map((t, i) => (
                <span
                  key={i}
                  className="max-w-full truncate rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-0.5 text-[11px] font-medium text-ink-muted"
                >
                  {t}
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
              {/* Lyrics */}
              <div className="-mr-1 flex-1 overflow-y-auto pr-1">
                {lyricLines.map((line, i) => (
                  <p
                    key={i}
                    className={`text-[12.5px] leading-relaxed ${
                      i === 2 ? "text-ink" : "text-ink-faint"
                    }`}
                  >
                    {line}
                  </p>
                ))}
              </div>

              {/* Accent divider */}
              <div className="my-3 h-px w-full bg-gradient-to-r from-brand/5 via-brand/70 to-brand/5" />

              {/* Title */}
              <p className="truncate text-[15px] font-semibold text-ink">{track.title}</p>

              {/* Progress */}
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
                  <span>{curText}</span>
                  <span>{totalText}</span>
                </div>
              </div>

              {/* Transport */}
              <div className="mt-3 flex items-center justify-center gap-5">
                <button
                  type="button"
                  title="Previous"
                  aria-label="Previous"
                  className="text-ink-muted transition-colors hover:text-ink"
                >
                  <SkipBack className="h-5 w-5" strokeWidth={1.75} />
                </button>
                <button
                  type="button"
                  onClick={toggle}
                  title={playing ? "Pause" : "Play"}
                  aria-label={playing ? "Pause" : "Play"}
                  className="glass-btn glass-btn-ring h-12 w-12 rounded-full"
                >
                  {playing ? (
                    <Pause className="h-5 w-5" strokeWidth={2} fill="currentColor" />
                  ) : (
                    <Play className="ml-0.5 h-5 w-5" strokeWidth={2} fill="currentColor" />
                  )}
                </button>
                <button
                  type="button"
                  title="Next"
                  aria-label="Next"
                  className="text-ink-muted transition-colors hover:text-ink"
                >
                  <SkipForward className="h-5 w-5" strokeWidth={1.75} />
                </button>
              </div>

              {/* Speed toggle (bottom-left) */}
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

              {/* Action row (Create page only) */}
              {onCreate && (
                <div className="mt-4 border-t border-white/[0.06] pt-3">
                  <div className="flex items-center justify-around">
                    {/* Like — functional */}
                    <button
                      type="button"
                      onClick={() => toggleLike(track.id)}
                      title={track.liked ? "Unlike" : "Like"}
                      aria-label={track.liked ? "Unlike" : "Like"}
                      aria-pressed={!!track.liked}
                      className={`flex h-9 w-9 items-center justify-center rounded-lg border transition-colors ${
                        track.liked
                          ? "border-brand/40 bg-brand/15 text-brand-soft"
                          : "border-transparent text-ink-muted hover:bg-white/[0.06] hover:text-ink"
                      }`}
                    >
                      <Heart className="h-[18px] w-[18px]" strokeWidth={2} fill={track.liked ? "currentColor" : "none"} />
                    </button>

                    {/* Refine — placeholder with a subtle outline-only glow */}
                    <button
                      type="button"
                      onClick={() => flashHint("Refine — coming soon")}
                      title="Refine"
                      aria-label="Refine"
                      className="flex h-9 w-9 items-center justify-center rounded-lg border border-brand/40 text-brand-soft shadow-[0_0_10px_-2px_rgba(108,92,231,0.45)] transition-colors hover:bg-brand/10"
                    >
                      <Sparkles className="h-[18px] w-[18px]" strokeWidth={2} />
                    </button>

                    {/* Add to project — placeholder */}
                    <button
                      type="button"
                      onClick={() => flashHint("Projects — coming soon")}
                      title="Add to project"
                      aria-label="Add to project"
                      className="flex h-9 w-9 items-center justify-center rounded-lg border border-transparent text-ink-muted transition-colors hover:bg-white/[0.06] hover:text-ink"
                    >
                      <FolderPlus className="h-[18px] w-[18px]" strokeWidth={2} />
                    </button>

                    {/* Delete — functional */}
                    <button
                      type="button"
                      onClick={() => removeTrack(track.id)}
                      title="Delete"
                      aria-label="Delete"
                      className="flex h-9 w-9 items-center justify-center rounded-lg border border-transparent text-ink-muted transition-colors hover:bg-red-500/10 hover:text-red-300"
                    >
                      <Trash2 className="h-[18px] w-[18px]" strokeWidth={2} />
                    </button>
                  </div>
                  {hint && (
                    <p className="mt-2 text-center text-[11.5px] text-ink-faint">{hint}</p>
                  )}
                </div>
              )}
            </>
          ) : (
            /* Empty state — no track loaded yet */
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
        /* Collapsed rail — expand arrow (top) + play (bottom) */
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
