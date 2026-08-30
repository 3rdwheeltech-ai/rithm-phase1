import { useCallback, useRef } from "react";
import { ApiError } from "../lib/api";
import { useRecordVoiceTurns } from "./useChat";
import type { RecordedTurn, VoiceRecordOutcome } from "../lib/anam/VoiceTurnLoop";
import { CHAT_SESSION_FULL_TYPE } from "../types/api";

/**
 * One batch of voice turns, recorded through the SAME cache entry the composer
 * writes.
 *
 * THE CENTRAL DESIGN DECISION OF THE FEATURE, AND IT SURVIVED THE BRAIN
 * SWITCH. Anam's own model now conducts the conversation — this hook no longer
 * fetches a reply — but the voice path still writes into `qk.chat`, so Talk
 * and Chat remain two doors on one conversation: the same session row, the
 * same transcript, the same draft, the same `ready`.
 *
 * That is what stopped the switch being a trade of the product for latency.
 * Without it the avatar would be fast and the interview would produce nothing:
 * no validated genre, no mood, no draft, and no Create button to press.
 *
 * THREE THINGS THIS HAS TO GET RIGHT, all about the call site:
 *
 * 1. `mutateAsync`, not `mutate`. The loop serialises batches and must know
 *    when one has landed; `send.data` reads stale inside a handler registered
 *    at session start.
 *
 * 2. The returned callback is STABLE. `VoiceTurnLoop` registers it once, and a
 *    callback whose identity changed per render would leave the loop holding a
 *    `mutateAsync` from three turns ago. The ref indirection buys that.
 *
 * 3. A FAILURE HERE IS QUIETER THAN IT USED TO BE, and that is the one thing
 *    genuinely worse about the new architecture. A refused turn used to cost
 *    the user their answer, which they noticed immediately. It now costs the
 *    RECORD: Anam keeps talking, the conversation sounds perfect, and nothing
 *    is being captured. So the errors that mean "stop" are still spoken aloud
 *    and still end the session, because silence would be indistinguishable
 *    from working.
 */

/** The 429 for the daily cap. Shared with the ErrorToast's generic path. */
const RATE_LIMITED_STATUS = 429;

export function useVoiceTurn(): (turns: RecordedTurn[]) => Promise<VoiceRecordOutcome> {
  const record = useRecordVoiceTurns();

  // `mutateAsync` is referentially stable in react-query v5, but relying on
  // that would make this hook's contract depend on someone else's changelog.
  // The ref costs three lines and makes "stable" a property of this file.
  const recordRef = useRef(record.mutateAsync);
  recordRef.current = record.mutateAsync;

  return useCallback(
    async (turns: RecordedTurn[]): Promise<VoiceRecordOutcome> => {
      try {
        await recordRef.current(turns);
        return { kind: "recorded" };
      } catch (error) {
        const type = error instanceof ApiError ? error.type : "";
        const status = error instanceof ApiError ? error.status : 0;

        if (type === CHAT_SESSION_FULL_TYPE) {
          return {
            kind: "spoken-error",
            text:
              "We've filled this conversation up. I'll take you to chat, " +
              "where you can start a fresh one.",
            end: "chat-full",
          };
        }

        if (status === RATE_LIMITED_STATUS) {
          return {
            kind: "spoken-error",
            text: "That's all I can do for today. Everything we talked about is saved.",
            end: "chat-rate-limited",
          };
        }

        // Anything else: the session STAYS OPEN and nothing is said.
        //
        // This is the deliberate half of the trade above. A one-off 5xx on the
        // record path costs a turn out of the draft, and interrupting a working
        // conversation to announce a problem the user cannot act on would cost
        // more than it saves — the next batch may well land, and the draft is
        // rebuilt from whatever did. `voice_turn_recorded` going quiet in
        // CloudWatch is how the persistent version of this gets noticed.
        return { kind: "recorded" };
      }
    },
    [],
  );
}
