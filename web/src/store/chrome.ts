import { create } from "zustand";
import { persist } from "zustand/middleware";

interface ChromeState {
  /** The left menu bar stays expanded instead of closing when hover ends. */
  navPinned: boolean;
  /** The right player rail does, on the routes where it is a rail. */
  playerPinned: boolean;
  setNavPinned: (pinned: boolean) => void;
  setPlayerPinned: (pinned: boolean) => void;
}

/**
 * Which pieces of chrome the user has pinned open.
 *
 * THE ONLY PERSISTED STORE BESIDES AUTH, and the exception `assistant.ts`
 * argues for rather than a contradiction of it. That comment refuses to
 * persist panel state because the conversation is the durable thing and lives
 * on the server — a stored flag would be the same information in two places.
 * A pin is not that: nothing anywhere else knows it, nobody set it but the
 * user, and a preference that forgets itself on every reload is not one.
 *
 * Both default to `false`, so this changes nothing at all for anyone who never
 * presses a pin.
 *
 * Pinning does more than defeat the hover-close: `Layout`'s `shellMargin`
 * reads these too, so a pinned rail makes room in the page instead of floating
 * over it. That is the whole difference between a pin and the peek you already
 * get by hovering.
 */
export const useChrome = create<ChromeState>()(
  persist(
    (set) => ({
      navPinned: false,
      playerPinned: false,
      setNavPinned: (navPinned) => set({ navPinned }),
      setPlayerPinned: (playerPinned) => set({ playerPinned }),
    }),
    {
      name: "rithm-chrome",
      // The setters are rebuilt on every load; only the flags are state.
      partialize: (s) => ({ navPinned: s.navPinned, playerPinned: s.playerPinned }),
    },
  ),
);
