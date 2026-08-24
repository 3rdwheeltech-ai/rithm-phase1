import type { QueryClient } from "@tanstack/react-query";
import { useAuth, type AuthState } from "../store/auth";
import { usePlayer } from "../store/player";
import { useGeneration } from "../store/generation";

/**
 * Who the cache belongs to. Null while anonymous or still bootstrapping.
 *
 * Falls back to `email` because a token whose `sub`/`email` claims fail to
 * decode leaves `user` null on an otherwise-authed session.
 */
function identity(s: AuthState): string | null {
  return s.status === "authed" ? (s.user?.sub ?? s.email) : null;
}

/**
 * Drop every trace of the previous account when the signed-in identity
 * changes. The QueryClient is a module-scope singleton and both usePlayer and
 * useGeneration are module-scope stores, so none of them is unmounted by
 * signing out — without this, the next user renders against the previous
 * user's cache until a reload. The generation store matters most: it holds a
 * live job handle whose SSE URL carries the OLD user's signed token, and the
 * status pill would keep streaming it.
 *
 * Stable across a token refresh (same `sub`) and across the anon→anon no-op
 * during bootstrap when there was never a session.
 *
 * Returns the unsubscribe, for tests.
 */
export function installSessionTeardown(queryClient: QueryClient): () => void {
  return useAuth.subscribe((state, previous) => {
    if (identity(state) === identity(previous)) return;
    queryClient.clear();
    usePlayer.getState().reset();
    useGeneration.getState().reset();
  });
}
