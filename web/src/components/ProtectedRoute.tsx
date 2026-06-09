import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../store/auth";

/** Renders children only when a session exists; otherwise bounces to /login. */
export default function ProtectedRoute({ children }: { children: ReactNode }) {
  const idToken = useAuth((s) => s.idToken);
  if (!idToken) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}
