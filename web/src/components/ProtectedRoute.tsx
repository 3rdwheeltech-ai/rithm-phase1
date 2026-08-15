import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../store/auth";
import RouteSpinner from "./RouteSpinner";

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
    return <RouteSpinner label="Restoring your session…" />;
  }

  if (status === "anon") {
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }

  return <>{children}</>;
}
