import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useMe } from "../hooks/useMe";
import RouteSpinner from "./RouteSpinner";

/**
 * Sends a user who has never finished onboarding to /onboarding, once.
 *
 * Wraps the authed SHELL only. `/onboarding` itself sits outside this guard —
 * that separation is the whole loop-proofing story. The two guards read the
 * same single `qk.me` cache entry and test opposite predicates, so within one
 * render pass exactly one of them can redirect:
 *
 *   here            completed_at === null  ->  /onboarding
 *   Onboarding.tsx  completed_at !== null  ->  /
 *
 * Because the gate keys off the stored document rather than a signup-time flag,
 * accounts created before this feature shipped (profile `{}`) are asked once
 * too, and a user who skips is never asked again.
 */
export default function RequireOnboarding({ children }: { children: ReactNode }) {
  const { data, isPending, isError } = useMe();

  // Mounted inside ProtectedRoute, so `status` is already "authed" and the
  // query is enabled — this is the profile fetch, not the session restore.
  if (isPending) return <RouteSpinner label="Loading your studio…" />;

  // Fail OPEN. A /me outage must not lock every signed-in user out of the app;
  // the worst case here is an onboarded user being asked again next load, which
  // is a far cheaper failure than a studio nobody can reach.
  if (isError) return <>{children}</>;

  if (data.profile.onboarding.completed_at === null) {
    return <Navigate to="/onboarding" replace />;
  }

  return <>{children}</>;
}
