import { useEffect, useRef, useState } from "react";
import { Home, Plus, Library, User, LogOut, Settings, Sparkles, Compass } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { cn } from "../lib/cn";
import { useLens } from "../lib/useLens";
import { mergeRefs, useSpecular } from "../lib/useSpecular";

interface Tab {
  label: string;
  Icon: LucideIcon;
  to: string;
}

// Four destinations plus Account is the most this bar holds at 375px. Discover
// earns a slot because browsing is a destination in every music app; AI Tools
// is a place you go on purpose, so it lives in the account sheet instead.
const TABS: Tab[] = [
  { label: "Home", Icon: Home, to: "/" },
  { label: "Create", Icon: Plus, to: "/create" },
  { label: "Library", Icon: Library, to: "/library" },
  { label: "Discover", Icon: Compass, to: "/discover" },
];

/**
 * Navigation below the desktop breakpoint.
 *
 * The sidebar it replaces expands on hover, which does not exist on a phone, and
 * eats 88px of a 375px screen even collapsed. A floating tab bar is the pattern
 * the platform already teaches, and it puts the three live destinations within
 * thumb reach.
 *
 * Everything the sidebar carried that is not a destination — the account, and the
 * placeholders for features this phase did not ship — moves into the account
 * sheet rather than being dropped.
 */
export default function TabBar({
  name,
  email,
  onSignOut,
}: {
  name: string | null;
  email: string | null;
  onSignOut: () => void;
}) {
  const nav = useNavigate();
  const { pathname } = useLocation();
  const [accountOpen, setAccountOpen] = useState(false);

  const lensRef = useLens<HTMLDivElement>("md", 999);
  const specularRef = useSpecular<HTMLDivElement>();

  const sheetLensRef = useLens<HTMLDivElement>("md", 24);
  const containerRef = useRef<HTMLElement>(null);

  const displayName = name || (email ? email.split("@")[0]! : "Account");

  // Route changes should not leave the sheet hanging open over the new page.
  useEffect(() => setAccountOpen(false), [pathname]);

  // Dismiss on an outside tap or Escape, the way a real popover behaves.
  useEffect(() => {
    if (!accountOpen) return;

    function onPointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setAccountOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setAccountOpen(false);
    }

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [accountOpen]);

  return (
    <nav
      ref={containerRef}
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-40 px-3 pb-[calc(env(safe-area-inset-bottom)+10px)] lg:hidden"
    >
      {accountOpen && (
        <div
          ref={sheetLensRef}
          className="lg-lens mx-auto mb-2 max-w-[420px] animate-rise p-2"
          style={{ "--r": "24px", "--pad": "8px" } as React.CSSProperties}
        >
          <div className="flex items-center gap-3 px-2 py-2.5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-signal/60 font-mono text-sm font-semibold text-signal-bright">
              {displayName[0]!.toUpperCase()}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-ink">{displayName}</p>
              <p className="truncate text-2xs text-ink-faint">{email ?? "—"}</p>
            </div>
          </div>

          <div className="my-1 h-px bg-white/[0.07]" />

          <button
            type="button"
            onClick={() => nav("/tools")}
            className="r-inner flex h-11 w-full items-center gap-3 px-2 text-sm font-medium text-ink-muted transition-colors hover:bg-white/[0.06] hover:text-ink"
          >
            <Sparkles className="h-[18px] w-[18px]" strokeWidth={1.75} />
            AI Tools
          </button>

          <button
            type="button"
            onClick={() => nav("/settings")}
            className="r-inner flex h-11 w-full items-center gap-3 px-2 text-sm font-medium text-ink-muted transition-colors hover:bg-white/[0.06] hover:text-ink"
          >
            <Settings className="h-[18px] w-[18px]" strokeWidth={1.75} />
            Settings
          </button>

          <div className="my-1 h-px bg-white/[0.07]" />

          <button
            type="button"
            onClick={onSignOut}
            className="r-inner flex h-11 w-full items-center gap-3 px-2 text-sm font-medium text-ink-muted transition-colors hover:bg-white/[0.06] hover:text-ink"
          >
            <LogOut className="h-[18px] w-[18px]" strokeWidth={1.75} />
            Sign out
          </button>
        </div>
      )}

      <div
        ref={mergeRefs(lensRef, specularRef)}
        className="lg-lens mx-auto flex max-w-[420px] items-center justify-around gap-1 p-1.5"
        style={{ "--r": "999px" } as React.CSSProperties}
      >
        {TABS.map(({ label, Icon, to }) => {
          const active = pathname === to || (to === "/library" && pathname.startsWith("/track/"));
          return (
            <button
              key={label}
              type="button"
              onClick={() => nav(to)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex min-h-[52px] flex-1 flex-col items-center justify-center gap-1 rounded-full px-2 py-1.5 transition-colors",
                active ? "bg-signal/15 text-ink" : "text-ink-muted",
              )}
            >
              <Icon
                className={cn("h-[22px] w-[22px]", active && "text-signal-bright")}
                strokeWidth={active ? 2 : 1.75}
              />
              <span className="text-[10.5px] font-medium leading-none">{label}</span>
            </button>
          );
        })}

        <button
          type="button"
          onClick={() => setAccountOpen((open) => !open)}
          aria-expanded={accountOpen}
          aria-label="Account"
          className={cn(
            "flex min-h-[52px] flex-1 flex-col items-center justify-center gap-1 rounded-full px-2 py-1.5 transition-colors",
            accountOpen ? "bg-signal/15 text-ink" : "text-ink-muted",
          )}
        >
          <User
            className={cn("h-[22px] w-[22px]", accountOpen && "text-signal-bright")}
            strokeWidth={accountOpen ? 2 : 1.75}
          />
          <span className="text-[10.5px] font-medium leading-none">Account</span>
        </button>
      </div>
    </nav>
  );
}
