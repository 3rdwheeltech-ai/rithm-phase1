import { create } from "zustand";
import type { TrackSummary } from "../types/api";

export interface PlayerState {
  /** The track the docked player is bound to, or null when nothing is loaded. */
  track: TrackSummary | null;
  /**
   * The list the current track was played FROM, in display order — what next
   * and previous walk. Playing from the library queues the library; playing a
   * single track queues just that one, so the transport is honestly disabled
   * rather than silently doing nothing.
   */
  queue: TrackSummary[];
  isPlaying: boolean;
  /** Seconds into the track. Kept here so navigation does not reset the scrub. */
  position: number;

  play: (track: TrackSummary, queue?: TrackSummary[]) => void;
  setTrack: (track: TrackSummary | null) => void;
  setPlaying: (isPlaying: boolean) => void;
  setPosition: (position: number) => void;
  /** Advance/retreat within the queue. No-ops at the ends — see hasNext. */
  next: () => void;
  previous: () => void;
  /**
   * Back to the empty state. Called on sign-out: the queue's `mp3_url`s are
   * presigned to the session that fetched them, so they must not survive into
   * the next one.
   */
  reset: () => void;
}

/** Index of the loaded track within its queue, or -1. */
function indexOf(state: PlayerState): number {
  if (!state.track) return -1;
  return state.queue.findIndex((t) => t.id === state.track!.id);
}

export function hasNext(state: PlayerState): boolean {
  const i = indexOf(state);
  return i >= 0 && i < state.queue.length - 1;
}

export function hasPrevious(state: PlayerState): boolean {
  return indexOf(state) > 0;
}

/**
 * Client-only playback state. TanStack Query owns the track DATA (including the
 * presigned URL, which expires); this store owns which track is loaded, where
 * the playhead is, and the queue it came from — so the player survives
 * navigation between History and Track Detail without re-mounting its <audio>.
 */
export const usePlayer = create<PlayerState>()((set) => ({
  track: null,
  queue: [],
  isPlaying: false,
  position: 0,

  play: (track, queue) =>
    set((s) => {
      // A queue is only replaced when the caller supplies one. Hitting play on
      // the already-loaded track from a different surface should not silently
      // strand the transport by shrinking its queue to one.
      const nextQueue = queue ?? (s.queue.some((t) => t.id === track.id) ? s.queue : [track]);
      return s.track?.id === track.id
        ? { isPlaying: true, queue: nextQueue }
        : { track, queue: nextQueue, isPlaying: true, position: 0 };
    }),

  setTrack: (track) =>
    set((s) => ({
      track,
      position: 0,
      queue: track && !s.queue.some((t) => t.id === track.id) ? [track] : s.queue,
    })),

  setPlaying: (isPlaying) => set({ isPlaying }),
  setPosition: (position) => set({ position }),

  next: () =>
    set((s) => {
      const i = indexOf(s);
      const upcoming = i >= 0 ? s.queue[i + 1] : undefined;
      // Keep isPlaying as-is: skipping while paused should stay paused.
      return upcoming ? { track: upcoming, position: 0 } : {};
    }),

  // Skipping BACKWARD past the first track is a no-op here. The "restart the
  // current track instead" convention lives in <Player>, which owns the audio
  // element and is the only thing that knows the real playhead.
  previous: () =>
    set((s) => {
      const i = indexOf(s);
      const earlier = i > 0 ? s.queue[i - 1] : undefined;
      return earlier ? { track: earlier, position: 0 } : {};
    }),

  reset: () => set({ track: null, queue: [], isPlaying: false, position: 0 }),
}));
