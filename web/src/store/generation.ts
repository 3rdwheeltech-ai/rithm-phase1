import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { generate, type GenerateParams, type GeneratedTrack } from "../services/musicgen";

type GenStatus = "idle" | "generating" | "done" | "error";

const HISTORY_LIMIT = 50;

interface GenerationState {
  status: GenStatus;
  tracks: GeneratedTrack[];          // tracks from the most recent generation
  history: GeneratedTrack[];         // every track generated this session (newest first)
  current: GeneratedTrack | null;    // what the Player shows / plays
  error: string | null;
  start: (params: GenerateParams) => Promise<void>;
  setCurrent: (track: GeneratedTrack) => void;
  toggleLike: (id: string) => void;
  removeTrack: (id: string) => void;
  reset: () => void;
}

/**
 * Shared generation state: the Generate/Create buttons drive it, the Player and
 * Recents read it. Persisted to sessionStorage so a page refresh keeps the
 * session's generations (and the Player's current track); it clears when the
 * tab/browser closes. `status`/`error` are transient and not persisted.
 */
export const useGeneration = create<GenerationState>()(
  persist(
    (set) => ({
      status: "idle",
      tracks: [],
      history: [],
      current: null,
      error: null,
      start: async (params) => {
        set({ status: "generating", error: null });
        try {
          const tracks = await generate(params);
          set((s) => ({
            status: "done",
            tracks,
            current: tracks[0] ?? s.current,
            history: [...tracks, ...s.history].slice(0, HISTORY_LIMIT),
          }));
        } catch (e) {
          set({ status: "error", error: (e as Error).message });
        }
      },
      setCurrent: (track) => set({ current: track }),
      toggleLike: (id) =>
        set((s) => {
          const flip = (t: GeneratedTrack) => (t.id === id ? { ...t, liked: !t.liked } : t);
          return {
            history: s.history.map(flip),
            tracks: s.tracks.map(flip),
            current: s.current?.id === id ? { ...s.current, liked: !s.current.liked } : s.current,
          };
        }),
      removeTrack: (id) =>
        set((s) => ({
          history: s.history.filter((t) => t.id !== id),
          tracks: s.tracks.filter((t) => t.id !== id),
          current: s.current?.id === id ? null : s.current,
        })),
      reset: () => set({ status: "idle", tracks: [], current: null, error: null }),
    }),
    {
      name: "rithm-generation",
      storage: createJSONStorage(() => sessionStorage),
      // Only persist what we want to survive a refresh — not transient status/error.
      partialize: (s) => ({ history: s.history, current: s.current, tracks: s.tracks }),
    },
  ),
);
