import { create } from "zustand";
import type { TrackSummary } from "../types/api";

export interface PlayerState {
  /** The track the docked player is bound to, or null when nothing is loaded. */
  track: TrackSummary | null;
  isPlaying: boolean;
  /** Seconds into the track. Kept here so navigation does not reset the scrub. */
  position: number;

  play: (track: TrackSummary) => void;
  setTrack: (track: TrackSummary | null) => void;
  setPlaying: (isPlaying: boolean) => void;
  setPosition: (position: number) => void;
}

/**
 * Client-only playback state. TanStack Query owns the track DATA (including the
 * presigned URL, which expires); this store owns only which track is loaded and
 * where the playhead is, so the player survives navigation between History and
 * Track Detail without re-mounting its <audio> element.
 */
export const usePlayer = create<PlayerState>()((set) => ({
  track: null,
  isPlaying: false,
  position: 0,

  play: (track) =>
    set((s) =>
      s.track?.id === track.id
        ? { isPlaying: true }
        : { track, isPlaying: true, position: 0 },
    ),
  setTrack: (track) => set({ track, position: 0 }),
  setPlaying: (isPlaying) => set({ isPlaying }),
  setPosition: (position) => set({ position }),
}));
