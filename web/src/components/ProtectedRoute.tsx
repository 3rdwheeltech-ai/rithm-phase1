import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../store/auth";

/**
 * Renders children only for an authenticated session.
 *
 * `status` matters as much as the token: the id token is memory-only, so
 * immediately after a reload there is no token *yet* while `bootstrapSession()`
 * exchanges the refresh token. Redirecting on a null token alone would bounce
 * every reload to /login and lose the deep link.
 */
export default function ProtectedRoute({ children }: { children: ReactNode }) {
  const status = useAuth((s) => s.status);
  const location = useLocation();

  if (status === "loading") {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center" aria-busy="true">
        <span className="sr-only">Restoring your session…</span>
        <span className="h-6 w-6 rounded-full border-2 border-white/15 border-t-brand-soft motion-safe:animate-spin" />
      </div>
    );
  }

  if (status === "anon") {
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }

  return <>{children}</>;
}
