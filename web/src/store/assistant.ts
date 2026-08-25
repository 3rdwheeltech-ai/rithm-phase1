import { create } from "zustand";

/**
 * Which door the AI Assistant panel is showing.
 *
 * "idle" is the avatar with its two buttons; "chat" replaces the whole panel
 * with the conversation.
 */
export type AssistantMode = "idle" | "chat";

interface AssistantState {
  mode: AssistantMode;
  openChat: () => void;
  closeChat: () => void;
}

/**
 * No `persist`, matching every other store here — and note the consequence:
 * this survives SPA navigation and NOT a reload.
 *
 * That is deliberate rather than an oversight. The conversation is the durable
 * thing and it lives on the server; the panel's open/closed state is not. A
 * refresh therefore drops the user back to the avatar while a live session
 * sits in the database — which `ChatPanel`'s mount resolves by opening into
 * chat when the server returns a non-empty transcript. Persisting this instead
 * would mean a stale flag deciding what the panel shows, which is the same
 * information in two places.
 */
export const useAssistant = create<AssistantState>((set) => ({
  mode: "idle",
  openChat: () => set({ mode: "chat" }),
  closeChat: () => set({ mode: "idle" }),
}));
