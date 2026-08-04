import { useMutation, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { request } from "../lib/api";
import { qk } from "../lib/queryClient";
import type { TracksPage } from "./useTracks";

/**
 * Soft delete, applied optimistically.
 *
 * The 204 has no body — nothing to parse. On error the previous pages are put
 * back, and the list is invalidated on settle either way so the server's
 * X-Total-Count is authoritative again.
 */
export function useDeleteTrack() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (trackId: string) => request(`/tracks/${trackId}`, { method: "DELETE" }),

    onMutate: async (trackId: string) => {
      await queryClient.cancelQueries({ queryKey: qk.tracksList() });
      const previous = queryClient.getQueryData<InfiniteData<TracksPage>>(qk.tracksList());

      queryClient.setQueryData<InfiniteData<TracksPage>>(qk.tracksList(), (old) =>
        old
          ? {
              ...old,
              pages: old.pages.map((page) => ({
                ...page,
                tracks: page.tracks.filter((track) => track.id !== trackId),
                totalCount:
                  page.totalCount === undefined ? undefined : Math.max(0, page.totalCount - 1),
              })),
            }
          : old,
      );

      return { previous };
    },

    onError: (_error, _trackId, context) => {
      if (context?.previous) {
        queryClient.setQueryData(qk.tracksList(), context.previous);
      }
    },

    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: qk.tracks });
    },
  });
}
