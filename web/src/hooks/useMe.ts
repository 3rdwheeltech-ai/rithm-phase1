import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getMe, patchProfile } from "../lib/api";
import { qk } from "../lib/queryClient";
import { useAuth } from "../store/auth";
import type { MeResponse, Profile, ProfilePatch } from "../types/profile";

/**
 * The signed-in user and their profile document.
 *
 * This is the one query the authed shell blocks on — RequireOnboarding reads
 * `profile.onboarding` out of it — so it is deliberately cheap and long-lived.
 */
export function useMe() {
  const status = useAuth((s) => s.status);

  return useQuery({
    queryKey: qk.me,
    queryFn: getMe,
    // The line that keeps this from firing before bootstrapSession() lands.
    // While `status` is "loading" there is no id token yet, and an anonymous
    // GET /me is a hard 401 that `requestWithHeaders` will not replay — it
    // only retries a request that HAD a token to begin with.
    enabled: status === "authed",
    // Unlike the track lists, nothing here expires on a clock: the document
    // changes only through useUpdateProfile, which writes the cache itself.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    gcTime: 30 * 60_000,
  });
}

/** PATCH the profile and fold the response back into the `me` cache entry. */
export function useUpdateProfile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (patch: ProfilePatch) => patchProfile(patch),
    onSuccess: (profile: Profile) => {
      // setQueryData, NEVER invalidateQueries. An invalidate triggers a
      // refetch, and RequireOnboarding re-renders against the pre-refetch cache
      // in the meantime — which sends the user who just pressed Finish straight
      // back to /onboarding for a frame. The PATCH response is already the
      // authoritative document; there is nothing to go and ask for.
      queryClient.setQueryData<MeResponse>(qk.me, (previous) =>
        previous ? { ...previous, profile } : previous,
      );
    },
  });
}
