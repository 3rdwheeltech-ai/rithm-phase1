import { lazy, Suspense, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { decodeJwt } from "../lib/jwt";
import { useAuth } from "../store/auth";
import Sidebar from "./Sidebar";
import Player from "./Player";

// Only the Home route shows the avatar, so its Lottie renderer (~400kB) is
// code-split out of the initial bundle and loaded on demand.
const AvatarPanel = lazy(() => import("./AvatarPanel"));

/**
 * App shell shared by every signed-in page: glass sidebar, docked player, and a
 * scrollable main column.
 *
 * The user comes from the id token, not from a GET /me round trip — everything
 * the UI needs about them is already in the token the client is holding.
 */
export default function Layout({ children }: { children: ReactNode }) {
  const nav = useNavigate();
  const logout = useAuth((s) => s.logout);
  const idToken = useAuth((s) => s.idToken);
  const user = useAuth((s) => s.user);
  const name = (decodeJwt(idToken)?.name ?? "").trim() || null;

  // The right column varies by route: on Home it's a wide always-open stack
  // (avatar + player), on /create the player is pinned open, elsewhere it
  // collapses to its narrow rail. Reserve matching room for it.
  const path = useLocation().pathname;
  const variant = path === "/" ? "home" : path === "/create" ? "create" : "rail";

  function signOut() {
    logout();
    nav("/login", { replace: true });
  }

  return (
    <div className="app-bg fixed inset-0">
      <Sidebar name={name} email={user?.email ?? null} onSignOut={signOut} />

      {/*
        One stable wrapper holds the single <Player> across every route so its
        <audio> element is never remounted — which would interrupt playback on
        navigation. On Home the wrapper is a positioned column stacking the
        avatar above the player; elsewhere it collapses to `display: contents`
        and the player self-positions.
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
        <Player variant={variant} className={variant === "home" ? "w-full min-h-0 flex-1" : ""} />
      </aside>

      <main
        className={`ml-[88px] flex h-full flex-col overflow-y-auto px-6 transition-[margin] duration-300 ease-out ${
          variant === "home" ? "mr-[336px]" : variant === "create" ? "mr-[332px]" : "mr-[82px]"
        }`}
      >
        {children}
      </main>
    </div>
  );
}
