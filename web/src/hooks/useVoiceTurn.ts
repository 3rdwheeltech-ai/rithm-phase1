import { useCallback, useRef } from "react";
import { ApiError } from "../lib/api";
import { useSendChatMessage } from "./useChat";
import type { VoiceTurnOutcome } from "../lib/anam/VoiceTurnLoop";
import {
  ASSISTANT_UNAVAILABLE_TYPE,
  CHAT_SESSION_FULL_TYPE,
} from "../types/api";

/**
 * One voice turn, through the SAME mutation the composer uses.
 *
 * THE CENTRAL DESIGN DECISION OF THE FEATURE, in one hook. The voice path
 * writes into the SAME `qk.chat` cache entry the text path does, so Talk and
 * Chat are two doors on one conversation: the same session row, the same
 * transcript, the same draft, the same `ready`. That is what makes every
 * fallback lossless — "the avatar broke" costs the user nothing but the
 * avatar, because everything ever said is already on the server.
 *
 * THREE THINGS THIS HAS TO GET RIGHT, and all three are about the call site
 * rather than about the request:
 *
 * 1. `mutateAsync`, not `mutate`. The loop must AWAIT the reply before it can
 *    speak it, and `send.data` / `send.isPending` read stale inside a handler
 *    registered at session start.
 *
 * 2. The returned callback is STABLE. `VoiceTurnLoop` registers it once, and a
 *    callback whose identity changed per render would leave the loop holding a
 *    `mutateAsync` from three turns ago. The ref indirection below is what
 *    buys that.
 *
 * 3. Error handling DIFFERS from chat. In the panel a 503 is a muted row the
 *    user can read; here there is nothing to read, so it must be SPOKEN — and
 *    a 409 or a 429 must END the session rather than hold the product's one
 *    global Anam slot open for a server that will refuse the next turn too.
 */

/** The 429 for the daily chat cap. Shared with the ErrorToast's generic path. */
const RATE_LIMITED_STATUS = 429;

export function useVoiceTurn(): (text: string) => Promise<VoiceTurnOutcome> {
  const send = useSendChatMessage();

  // `mutateAsync` is referentially stable in react-query v5, but relying on
  // that would make this hook's contract depend on someone else's changelog.
  // The ref costs three lines and makes "stable" a property of this file.
  const sendRef = useRef(send.mutateAsync);
  sendRef.current = send.mutateAsync;

  return useCallback(async (text: string): Promise<VoiceTurnOutcome> => {
    try {
      const turn = await sendRef.current({ message: text, source: "voice" });
      return { kind: "reply", text: turn.message.content, suggestions: turn.suggestions };
    } catch (error) {
      const type = error instanceof ApiError ? error.type : "";
      const status = error instanceof ApiError ? error.status : 0;

      if (type === ASSISTANT_UNAVAILABLE_TYPE) {
        // The session STAYS OPEN. The user's message is already committed
        // server-side, so saying it again genuinely works — and ending the call
        // over one refused turn would cost them the slot as well as the turn.
        return {
          kind: "spoken-error",
          text: "Sorry — I lost that one. Say it again?",
          end: null,
        };
      }

      if (type === CHAT_SESSION_FULL_TYPE) {
        return {
          kind: "spoken-error",
          text:
            "We've filled this conversation up. I'll take you to chat, " +
            "where you can start a fresh one.",
          end: "chat-full",
        };
      }

      // The daily cap, and anything else. Both end the call, and both say the
      // thing that actually matters: nothing was lost.
      return {
        kind: "spoken-error",
        text:
          status === RATE_LIMITED_STATUS
            ? "That's all I can do for today. Everything we talked about is saved."
            : "Something went wrong there. Everything we talked about is saved.",
        end: "chat-rate-limited",
      };
    }
  }, []);
}
