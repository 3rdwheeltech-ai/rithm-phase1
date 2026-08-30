import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { request } from "../lib/api";
import { qk } from "../lib/queryClient";
import { useAuth } from "../store/auth";
import type {
  ChatSessionResponse,
  ChatTurnResponse,
  SongDraft,
  VoiceTurnRecordResponse,
} from "../types/api";
import type { RecordedTurn } from "../lib/anam/VoiceTurnLoop";

/**
 * The chat session, and the one mutation that moves it.
 *
 * Four deliberate departures from the shared defaults in lib/queryClient.ts,
 * each for its own reason:
 *
 * 1. `retry: false` on the GET. The default retries a non-4xx twice, and a 503
 *    from this endpoint has already cost three upstream model attempts — so
 *    the default would turn one failed turn into NINE model calls before the
 *    inline error row ever appeared.
 *
 * 2. The in-flight turn is kept in the PANEL's local state, not written into
 *    this cache entry. `refetchOnWindowFocus` is on globally, and a focus
 *    refetch mid-turn would replace the transcript underneath the user as they
 *    read it.
 *
 * 3. `staleTime: Infinity`. Nothing here expires on a clock: the transcript
 *    changes only through `useSendChatMessage`, which writes the cache itself.
 *
 * 4. Unmounting on /create costs nothing and is not worked around. `gcTime` is
 *    ten minutes and the QueryClient lives above the router, so navigating away
 *    makes this query inactive rather than gone — coming back to `/` renders
 *    from cache instantly, which is what M6 checks.
 */
export function useChatSession() {
  const status = useAuth((s) => s.status);

  return useQuery({
    queryKey: qk.chat,
    queryFn: () => request<ChatSessionResponse>("/chat/session"),
    // Mirrors useMe: no token yet during bootstrap is a guaranteed 401.
    enabled: status === "authed",
    staleTime: Infinity,
    retry: false,
  });
}

/**
 * One turn's input.
 *
 * An object rather than a bare string, because a voice turn and a typed turn
 * are the same request with one field different — and the alternative, a
 * second mutation hook, is two things that must agree about how to fold a
 * response into the cache.
 */
export interface ChatTurnInput {
  message: string;
  source?: "chat" | "voice";
}

/**
 * Send one turn.
 *
 * The response IS the new state — it carries the assistant's message, the
 * merged draft and the readiness the server derived — so it is folded straight
 * into the cache with `setQueryData`. An `invalidateQueries` here would refetch
 * the whole transcript to learn what the response already said, and the panel
 * would render against the pre-refetch cache in the meantime.
 */
export function useSendChatMessage() {
  const queryClient = useQueryClient();

  return useMutation({
    /*
      `source` says which door this came through: "chat" from the composer,
      "voice" from the turn loop. It is defaulted on the server, so this is
      additive and an older API answers a body carrying it perfectly happily.

      NEVER ADD A RETRY TO THIS PATH. `/chat/messages` has no idempotency key,
      so a retried timeout that actually succeeded duplicates the transcript —
      and the QueryClient's `mutations: { retry: false }` is what stands
      between voice and exactly that.
    */
    mutationFn: ({ message, source = "chat" }: ChatTurnInput) =>
      request<ChatTurnResponse>("/chat/messages", {
        method: "POST",
        body: JSON.stringify({ message, source }),
      }),
    onSuccess: (turn, { message }) => {
      queryClient.setQueryData<ChatSessionResponse>(qk.chat, (previous) => {
        const base: ChatSessionResponse = previous ?? {
          session_id: null,
          messages: [],
          draft: turn.draft,
          ready: turn.ready,
        };
        return {
          ...base,
          // The user's turn is reconstructed rather than returned by the
          // server: the response carries the ASSISTANT's message, and asking
          // for both would double the payload to echo back what the client
          // just sent. The id is local and never read back.
          messages: [
            ...base.messages,
            {
              id: `local-${turn.message.id}`,
              role: "user" as const,
              content: message,
              created_at: turn.message.created_at,
            },
            turn.message,
          ],
          draft: turn.draft,
          ready: turn.ready,
        };
      });
    },
  });
}

/**
 * Record turns Anam's own model already spoke.
 *
 * THE SAME CACHE ENTRY `useSendChatMessage` WRITES, which is the property that
 * keeps Talk and Chat two doors on one conversation now that the two surfaces
 * no longer share a brain. The response carries the merged draft and the
 * readiness the server derived, so it folds straight in with `setQueryData` —
 * an `invalidateQueries` would refetch the whole transcript to learn what the
 * response already said.
 *
 * NEVER ADD A RETRY. `/chat/turns/record` has no idempotency key, so a retried
 * timeout that actually succeeded duplicates the transcript. The
 * QueryClient's `mutations: { retry: false }` is what stands between voice and
 * exactly that.
 */
export function useRecordVoiceTurns() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (turns: RecordedTurn[]) =>
      request<VoiceTurnRecordResponse>("/chat/turns/record", {
        method: "POST",
        body: JSON.stringify({ turns }),
      }),
    onSuccess: (recorded, turns) => {
      queryClient.setQueryData<ChatSessionResponse>(qk.chat, (previous) => {
        const base: ChatSessionResponse = previous ?? {
          session_id: null,
          messages: [],
          draft: recorded.draft,
          ready: recorded.ready,
        };
        return {
          ...base,
          // Reconstructed locally rather than returned. The server has no
          // reply to send back — it did not write one — so echoing the turns
          // we just posted would double the payload for nothing. These ids are
          // local and never read back.
          messages: [
            ...base.messages,
            ...turns.map((turn, index) => ({
              id: `local-voice-${Date.now()}-${index}`,
              role: turn.role,
              content: turn.content,
              created_at: new Date().toISOString(),
            })),
          ],
          draft: recorded.draft,
          ready: recorded.ready,
        };
      });
    },
  });
}

/** Start over. The server soft-deletes; this drops the transcript from view. */
export function useResetChat() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => request<void>("/chat/session", { method: "DELETE" }),
    onSuccess: () => {
      queryClient.setQueryData<ChatSessionResponse>(qk.chat, (previous) => ({
        session_id: null,
        messages: [],
        draft: EMPTY_DRAFT,
        ready: false,
        // Carried across the reset. "Start over" clears a CONVERSATION; it does
        // not change whether this deployment has an avatar, and dropping the
        // flag here would hide Talk until the next page load.
        voice_available: previous?.voice_available ?? false,
      }));
    },
  });
}

/**
 * What the server sends for a conversation that has not started. Declared here
 * so "no session" renders identically whether it came from a GET, a reset, or
 * a panel that has not loaded yet.
 */
export const EMPTY_DRAFT: SongDraft = {
  prompt: null,
  title: null,
  genre: null,
  mood: null,
  instruments: [],
  length_seconds: null,
  bpm_min: null,
  bpm_max: null,
  lyrics_mode: null,
  voice: null,
  lyrics: null,
  lyrics_prompt: null,
};
