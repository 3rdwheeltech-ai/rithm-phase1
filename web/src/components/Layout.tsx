import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { cn } from "../lib/cn";
import { useMe } from "../hooks/useMe";
import { decodeJwt } from "../lib/jwt";
import { DESKTOP_QUERY, useMediaQuery } from "../lib/useMediaQuery";
import { useAssistant } from "../store/assistant";
import { useAuth } from "../store/auth";
import { useChrome } from "../store/chrome";
import { usePlayer } from "../store/player";
import Sidebar from "./Sidebar";
import TabBar from "./TabBar";
import Player from "./Player";
import GradualBlur from "./reactbits/GradualBlur";

// Only the desktop Home route shows the avatar, so its Lottie renderer (~400kB)
// is code-split out of the initial bundle and never loaded on a phone at all.
const AvatarPanel = lazy(() => import("./AvatarPanel"));
// Lazy for the SAME reason, and it is not optional: ChatPanel imports
// AssistantAvatar, which imports the Lottie renderer. A static import here
// would walk those 400kB straight back into the entry chunk and undo the split
// above.
const ChatPanel = lazy(() => import("./assistant/ChatPanel"));

/** Which shape the shell is in. Home and Create own the right column outright. */
export type ShellVariant = "home" | "create" | "rail" | "mobile";

/**
 * The gutters `<main>` leaves for the two rails.
 *
 * Lifted out of the JSX because it is now a function of three things rather
 * than one, and because it is the part of pinning that is easiest to get
 * subtly wrong — a unit test over a pure function beats rendering the whole
 * shell to read a class name off it.
 *
 * EVERY CLASS IS A WHOLE LITERAL. Tailwind's scanner reads source text, so a
 * built-up string like `lg:ml-[${n}px]` compiles to nothing at all.
 *
 * The numbers are all rail width + the 12px `left-3`/`right-3` gutter + 12px of
 * air: 64+24 = 88 collapsed and 228+24 = 252 pinned on the left, 58+24 = 82
 * collapsed on the right. The pinned rail reuses `create`'s 332 rather than
 * deriving its own — it is the same 300px component in the same place, and two
 * different margins for one box is how they drift apart.
 */
export function shellMargin(
  variant: ShellVariant,
  navPinned: boolean,
  playerPinned: boolean,
): string {
  const left = navPinned ? "lg:ml-[252px]" : "lg:ml-[88px]";
  const right =
    variant === "home"
      ? "lg:mr-[336px] xl:mr-[364px]"
      : variant === "create"
        ? "lg:mr-[332px]"
        : playerPinned
          ? "lg:mr-[332px]"
          : "lg:mr-[82px]";
  return `${left} ${right}`;
}

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
  const chatting = useAssistant((s) => s.mode === "chat");
  // Pinning a rail widens the gutter it sits in, so the page reflows around it
  // instead of being covered — see `shellMargin` and `store/chrome.ts`.
  const navPinned = useChrome((s) => s.navPinned);
  const playerPinned = useChrome((s) => s.playerPinned);

  // The right column varies by route: on Home it's a wide always-open stack
  // (avatar + player), on /create the player is pinned open, elsewhere it
  // collapses to its narrow rail. Below `lg` none of that applies.
  const path = useLocation().pathname;
  const variant: ShellVariant = !isDesktop
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
        {/*
          Two doors on the same slot. The rail's WIDTH never changes (§0.7) —
          only how the column divides between assistant and player. Note the
          two different Suspense fallbacks: a 400px skeleton is wrong for a
          panel that fills the column.

          NO width or height TRANSITION on this swap. `useLens` redraws its
          displacement map on ResizeObserver, so an animated box means
          buildDisplacementMap plus a full-panel SVG data-URI re-decode on
          every frame. Soften it with opacity or transform on an INNER wrapper
          if it ever needs softening.
        */}
        {variant === "home" &&
          (chatting ? (
            <Suspense fallback={<div className="lg-lens min-h-0 flex-1" />}>
              <ChatPanel className="min-h-0 flex-1" />
            </Suspense>
          ) : (
            <Suspense fallback={<div className="lg-lens h-[480px] shrink-0" />}>
              <AvatarPanel className="shrink-0" />
            </Suspense>
          ))}
        {/*
          <Player> keeps its exact position among its siblings at every
          breakpoint and in both of the states above — it holds the app's only
          <audio> element, and moving it in the tree remounts it and cuts
          playback mid-track. `compact` swaps its BODY, never its place.
        */}
        <Player
          variant={variant}
          compact={variant === "home" && chatting}
          className={
            variant === "home"
              ? chatting
                ? "w-full shrink-0"
                : "w-full min-h-0 flex-1"
              : ""
          }
        />
      </aside>

      <main
        className={cn(
          "flex flex-col px-4 sm:px-6",
          // Mobile: the page scrolls, and leaves room for the dock.
          "pb-[calc(var(--dock)+env(safe-area-inset-bottom))]",
          // Desktop: the shell is fixed and this column does the scrolling.
          "lg:h-full lg:overflow-y-auto lg:pb-0 lg:pl-0",
          // Matches the rails' own `transition-[width] duration-300`, so a pin
          // moves the gutter and the panel as one movement rather than two.
          "transition-[margin] duration-300 ease-out",
          shellMargin(variant, navPinned, playerPinned),
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
