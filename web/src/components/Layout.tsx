import { useEffect, useState, lazy, Suspense, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { apiFetch } from "../lib/api";
import { decodeJwt } from "../lib/token";
import { useAuth } from "../store/auth";
import Sidebar from "./Sidebar";
import Player from "./Player";
import GeneratingOverlay from "./GeneratingOverlay";

// Only the Home route shows the avatar, so its Lottie renderer (~400kB) is
// code-split out of the initial bundle and loaded on demand.
const AvatarPanel = lazy(() => import("./AvatarPanel"));

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

  // The right column varies by route: on Home it's a wide always-open stack
  // (avatar + player), on /create the player is pinned open (300px), and
  // elsewhere it collapses to its narrow rail. Reserve matching room for it.
  const path = useLocation().pathname;
  const variant = path === "/" ? "home" : path === "/create" ? "create" : "rail";

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

      {/*
        One stable wrapper holds the single <Player> across every route so its
        <audio> element is never remounted (which would interrupt playback). On
        Home the wrapper is a positioned column stacking the avatar above the
        player; on other routes it collapses to `display: contents` and the
        player self-positions exactly as before.
      */}
      <aside
        className={
          variant === "home"
            ? "absolute right-3 top-3 bottom-3 z-20 flex w-[312px] flex-col gap-3"
            : "contents"
        }
      >
        {variant === "home" && (
          <Suspense fallback={<div className="glass-panel h-[400px] shrink-0" />}>
            <AvatarPanel className="shrink-0" />
          </Suspense>
        )}
        <Player
          variant={variant}
          className={variant === "home" ? "w-full min-h-0 flex-1" : ""}
        />
      </aside>

      <GeneratingOverlay />

      <main
        className={`ml-[88px] flex h-full flex-col overflow-y-auto px-6 transition-[margin] duration-300 ease-out ${
          variant === "home" ? "mr-[336px]" : variant === "create" ? "mr-[332px]" : "mr-[82px]"
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
