import { create } from "zustand";

export interface CreateUIState {
  /**
   * Rendered height (px) of the Create form, published by `CreateForm` and read
   * by the docked `Player` so it can grow/shrink with the form on `/create`.
   * Null on every other route (and once the form unmounts), which lets the
   * player fall back to its default height and collapsible behavior.
   */
  playerHeight: number | null;
  setPlayerHeight: (h: number | null) => void;
}

/** Transient UI bridge between the Create form and the global Player. */
export const useCreateUI = create<CreateUIState>((set) => ({
  playerHeight: null,
  setPlayerHeight: (h) => set({ playerHeight: h }),
}));
