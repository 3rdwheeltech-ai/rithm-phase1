import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api";

/**
 * `staleTime` is bounded above by the presign TTL, not chosen for feel.
 *
 * `mp3_url` and `wav_url` are S3 presigned GETs that expire in 15 minutes.
 * Cache a track list for longer than that and you are handing the user URLs you
 * already know are dead. Five minutes leaves a 3x margin, and
 * `refetchOnWindowFocus` covers the laptop-lid case.
 */
export const STALE_TIME_MS = 5 * 60_000;

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: STALE_TIME_MS,
        gcTime: 10 * 60_000,
        refetchOnWindowFocus: true,
        // Retrying a 4xx just repeats a request the server already refused —
        // and on a 429 it spends the user's remaining budget faster.
        retry: (count, error) =>
          !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
      },
      mutations: { retry: false },
    },
  });
}

/**
 * One key factory so invalidation is never guesswork. `qk.tracks` is the prefix
 * every list and detail key extends, which is what makes a single
 * `invalidateQueries({ queryKey: qk.tracks })` on job completion correct.
 */
export const qk = {
  /** The signed-in user + their profile document. One entry, no variants. */
  me: ["me"] as const,
  tracks: ["tracks"] as const,
  tracksList: () => ["tracks", "list"] as const,
  track: (id: string) => ["tracks", "detail", id] as const,
  prompts: (id: string) => ["tracks", "detail", id, "prompts"] as const,
  job: (id: string) => ["jobs", id] as const,
};
