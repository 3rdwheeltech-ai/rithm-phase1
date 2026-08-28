import { create } from "zustand";

/**
 * Which door the AI Assistant panel is showing.
 *
 * "talk" is the avatar with its Talk button; "chat" replaces the whole panel
 * with the conversation. They are two modes of one assistant rather than a
 * panel and an overlay, which is why the segmented control that switches them
 * sits in the same place in both — see `assistant/DoorToggle.tsx`.
 */
export type AssistantMode = "talk" | "chat";

interface AssistantState {
  mode: AssistantMode;
  setMode: (mode: AssistantMode) => void;
  /** Whether this page load has already restored a live conversation. */
  resumed: boolean;
  markResumed: () => void;
}

/**
 * No `persist`, matching every other store here — and note the consequence:
 * this survives SPA navigation and NOT a reload.
 *
 * That is deliberate rather than an oversight. The conversation is the durable
 * thing and it lives on the server; the panel's open/closed state is not. A
 * refresh therefore drops the user back to the avatar while a live session
 * sits in the database — which `AvatarPanel`'s mount resolves by switching to
 * chat when the server returns a non-empty transcript. Persisting this instead
 * would mean a stale flag deciding what the panel shows, which is the same
 * information in two places.
 *
 * `resumed` is what makes that restore happen ONCE PER PAGE LOAD rather than
 * once per mount, and it is load-bearing rather than an optimisation. The two
 * panels swap places in Layout, so leaving chat REMOUNTS `AvatarPanel` — and
 * an ungated restore would read the same non-empty transcript and throw the
 * user straight back into the conversation they just closed. It shares `mode`'s
 * lifetime for the same reason `mode` has it: "has this page load restored
 * yet?" is a question a reload should be allowed to ask again.
 */
export const useAssistant = create<AssistantState>((set) => ({
  mode: "talk",
  setMode: (mode) => set({ mode }),
  resumed: false,
  markResumed: () => set({ resumed: true }),
}));
