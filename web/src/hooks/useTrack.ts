import { useQuery } from "@tanstack/react-query";
import { request } from "../lib/api";
import { qk } from "../lib/queryClient";
import type { PromptHistoryEntry, TrackDetail } from "../types/api";

/** Detail already embeds prompt_history — see usePrompts for when it does not. */
export function useTrack(trackId: string | undefined) {
  return useQuery({
    queryKey: qk.track(trackId ?? ""),
    queryFn: () => request<TrackDetail>(`/tracks/${trackId}`),
    enabled: Boolean(trackId),
  });
}

/**
 * Only for refreshing the history independently of the detail — e.g. after a
 * refine lands on a track already on screen. The initial render reads
 * `prompt_history` off the detail and makes no second request.
 */
export function usePrompts(trackId: string | undefined, enabled = false) {
  return useQuery({
    queryKey: qk.prompts(trackId ?? ""),
    queryFn: () => request<PromptHistoryEntry[]>(`/tracks/${trackId}/prompts`),
    enabled: enabled && Boolean(trackId),
  });
}
