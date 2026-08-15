import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { cn } from "../lib/cn";
import { useMe } from "../hooks/useMe";
import { decodeJwt } from "../lib/jwt";
import { DESKTOP_QUERY, useMediaQuery } from "../lib/useMediaQuery";
import { useAuth } from "../store/auth";
import { usePlayer } from "../store/player";
import Sidebar from "./Sidebar";
import TabBar from "./TabBar";
import Player from "./Player";
import GradualBlur from "./reactbits/GradualBlur";

// Only the desktop Home route shows the avatar, so its Lottie renderer (~400kB)
// is code-split out of the initial bundle and never loaded on a phone at all.
const AvatarPanel = lazy(() => import("./AvatarPanel"));

/**
 * App shell shared by every signed-in page.
 *
 * Two shells, one tree. At `lg` and above it is a three-column desktop studio —
 * sidebar rail, scrolling content, docked player. Below that the rail becomes a
 * bottom tab bar and the player becomes a mini bar above it.
 *
 * The switch is a className change, never a change of shape: `<Player>` holds the
 * only `<audio>` element in the app, and moving it in the tree would remount it
 * and cut playback mid-track. Its wrapper therefore keeps a fixed position among
 * its siblings at every breakpoint, and only its classes vary.
 *
 * The display name prefers the PROFILE over the id token. Settings writes
 * `profile.display_name`, and Phase 1 deliberately does not push that back to
 * the Cognito `name` attribute (it needs admin_update_user_attributes and a
 * grant the scoped dev IAM user does not hold, and the claim would only change
 * on the next token anyway) — so a token-first order would leave someone who
 * just renamed themselves staring at the old name until they re-login. The
 * claim stays as the fallback for rows created by shared/auth.py's lazy insert,
 * which never sees a name.
 */
export default function Layout({ children }: { children: ReactNode }) {
  const nav = useNavigate();
  const logout = useAuth((s) => s.logout);
  const idToken = useAuth((s) => s.idToken);
  const user = useAuth((s) => s.user);
  // No extra request: Layout renders inside RequireOnboarding, which has
  // already resolved this query.
  const { data: me } = useMe();
  const name =
    (me?.profile.display_name ?? "").trim() ||
    (decodeJwt(idToken)?.name ?? "").trim() ||
    null;

  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const hasTrack = usePlayer((s) => s.track !== null);

  // The right column varies by route: on Home it's a wide always-open stack
  // (avatar + player), on /create the player is pinned open, elsewhere it
  // collapses to its narrow rail. Below `lg` none of that applies.
  const path = useLocation().pathname;
  const variant = !isDesktop
    ? "mobile"
    : path === "/"
      ? "home"
      : path === "/create"
        ? "create"
        : "rail";

  function signOut() {
    logout();
    nav("/login", { replace: true });
  }

  // Room the mobile content must leave for the dock: tab bar, plus the mini
  // player when there is something loaded to play.
  //
  // Set on the ROOT element rather than inline on the shell below, because
  // <ErrorToast> portals to document.body to escape the backdrop-filter
  // containing blocks in the page cards — outside this subtree, an inline
  // custom property here would not reach it. Cleared on unmount so the auth
  // pages, which render no dock, fall back to the 20px default.
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--dock", hasTrack ? "142px" : "78px");
    return () => {
      root.style.removeProperty("--dock");
    };
  }, [hasTrack]);

  return (
    <div
      // No background of its own: <StudioField> paints the room, and anything
      // opaque here would cover it.
      className="relative min-h-dvh lg:h-dvh lg:overflow-hidden"
    >
      <Sidebar name={name} email={user?.email ?? null} onSignOut={signOut} />

      {/*
        One stable wrapper holds the single <Player> across every route and every
        breakpoint. On desktop Home it is a positioned column stacking the avatar
        above the player; on other desktop routes it collapses to
        `display: contents` and the player self-positions; on mobile it is the
        fixed mini bar sitting above the tab bar.
      */}
      <aside
        className={cn(
          variant === "mobile" &&
            "fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+72px)] z-30 px-3",
          variant === "home" &&
            "fixed right-3 top-3 bottom-3 z-20 flex w-[312px] flex-col gap-3 xl:w-[340px]",
          (variant === "create" || variant === "rail") && "contents",
        )}
      >
        {variant === "home" && (
          <Suspense fallback={<div className="lg-lens h-[400px] shrink-0" />}>
            <AvatarPanel className="shrink-0" />
          </Suspense>
        )}
        <Player
          variant={variant}
          className={variant === "home" ? "w-full min-h-0 flex-1" : ""}
        />
      </aside>

      <main
        className={cn(
          "flex flex-col px-4 sm:px-6",
          // Mobile: the page scrolls, and leaves room for the dock.
          "pb-[calc(var(--dock)+env(safe-area-inset-bottom))]",
          // Desktop: the shell is fixed and this column does the scrolling.
          "lg:h-full lg:overflow-y-auto lg:pb-0 lg:pl-0 lg:ml-[88px]",
          "transition-[margin] duration-300 ease-out",
          variant === "home"
            ? "lg:mr-[336px] xl:mr-[364px]"
            : variant === "create"
              ? "lg:mr-[332px]"
              : "lg:mr-[82px]",
        )}
      >
        {children}
      </main>

      {/*
        Content dissolving under the floating dock rather than sliding out from
        behind a hard edge. Mobile only — on desktop nothing overlaps the
        scrolling column, so there is nothing for it to sit under.
      */}
      <GradualBlur
        side="bottom"
        height="calc(var(--dock) + env(safe-area-inset-bottom))"
        className="fixed bottom-0 z-20 lg:hidden"
      />

      <TabBar name={name} email={user?.email ?? null} onSignOut={signOut} />
    </div>
  );
}
