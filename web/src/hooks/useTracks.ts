import { useInfiniteQuery } from "@tanstack/react-query";
import { requestWithHeaders } from "../lib/api";
import { qk } from "../lib/queryClient";
import type { TrackSummary } from "../types/api";

export const PAGE_SIZE = 20;

export interface TracksPage {
  tracks: TrackSummary[];
  nextCursor: string | undefined;
  totalCount: number | undefined;
}

export async function fetchTracksPage(cursor?: string): Promise<TracksPage> {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (cursor) params.set("cursor", cursor);

  const { data, headers } = await requestWithHeaders<TrackSummary[]>(`/tracks?${params}`);
  const total = headers.get("X-Total-Count");

  return {
    tracks: data ?? [],
    // The header is ABSENT when there is no next page. That absence is how you
    // know you are at the end — never infer it from a short page, because a
    // page can legitimately come back short.
    nextCursor: headers.get("X-Next-Cursor") ?? undefined,
    totalCount: total === null ? undefined : Number(total),
  };
}

/**
 * The user's tracks, newest first, keyset-paginated on X-Next-Cursor.
 *
 * `GET /tracks` answers with a BARE ARRAY and puts pagination in headers, which
 * is why this goes through requestWithHeaders rather than request.
 */
export function useTracks() {
  return useInfiniteQuery({
    queryKey: qk.tracksList(),
    queryFn: ({ pageParam }) => fetchTracksPage(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
}
