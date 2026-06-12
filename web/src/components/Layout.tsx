import { useEffect, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { apiFetch } from "../lib/api";
import { decodeJwt } from "../lib/token";
import { useAuth } from "../store/auth";
import Sidebar from "./Sidebar";
import Player from "./Player";
import GeneratingOverlay from "./GeneratingOverlay";

interface Me {
  user_id: string;
  email: string;
  is_admin: boolean;
}

/**
 * App shell shared by every signed-in page: glass sidebar, docked player, and a
 * scrollable main column. Fetches the current user once so the sidebar can show
 * the profile, and exposes sign-out.
 */
export default function Layout({ children }: { children: ReactNode }) {
  const nav = useNavigate();
  const clear = useAuth((s) => s.clear);
  const idToken = useAuth((s) => s.idToken);
  const name = (decodeJwt(idToken)?.name ?? "").trim() || null;

  // The player is pinned open (300px) on /create, so reserve room for it;
  // elsewhere it collapses to its rail and only needs the narrow margin.
  const onCreate = useLocation().pathname === "/create";

  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    // On a 401 apiFetch clears the session, which makes ProtectedRoute redirect.
    apiFetch<Me>("/api/v1/me")
      .then(setMe)
      .catch((e) => setErr((e as Error).message));
  }, []);

  function logout() {
    clear();
    nav("/login", { replace: true });
  }

  return (
    <div className="app-bg fixed inset-0">
      <Sidebar name={name} email={me?.email ?? null} onSignOut={logout} />
      <Player />
      <GeneratingOverlay />

      <main
        className={`ml-[88px] flex h-full flex-col overflow-y-auto px-6 transition-[margin] duration-300 ease-out ${
          onCreate ? "mr-[332px]" : "mr-[82px]"
        }`}
      >
        {err && (
          <div className="mx-auto mt-4 w-full max-w-[720px] rounded-[9px] border border-red-400/20 bg-red-400/[0.07] px-3 py-2.5 text-center text-[13px] text-red-300">
            {err}
          </div>
        )}
        {children}
      </main>
    </div>
  );
}
