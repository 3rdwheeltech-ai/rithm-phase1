import { usePlayer } from "../store/player";

/** What the room breathes at when a track carries no tempo of its own. */
const DEFAULT_BPM = 90;

/**
 * The chromatic field every glass surface refracts.
 *
 * Liquid Glass is a material defined by what shows through it, so in a music app
 * the honest thing to put back there is the music. While a track plays, the
 * field pulses at that track's tempo; paused, it goes still.
 *
 * The pulse costs no JavaScript per frame — the beat period is a CSS custom
 * property (`calc(60s / var(--bpm))`) and playback simply toggles
 * `animation-play-state`, so the compositor runs it and React never re-renders
 * for it. See `.studio-field` in index.css.
 */
export default function StudioField() {
  const bpm = usePlayer((s) => s.track?.bpm ?? null);
  const isPlaying = usePlayer((s) => s.isPlaying);

  return (
    <div
      className="studio-field"
      aria-hidden="true"
      style={
        {
          "--bpm": bpm && bpm > 0 ? bpm : DEFAULT_BPM,
          "--beat-state": isPlaying ? "running" : "paused",
        } as React.CSSProperties
      }
    />
  );
}
