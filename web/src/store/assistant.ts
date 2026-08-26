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
 */
export const useAssistant = create<AssistantState>((set) => ({
  mode: "talk",
  setMode: (mode) => set({ mode }),
}));
