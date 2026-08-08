import { useState } from "react";
import { Home, Plus, Library, Sparkles, Compass, LogOut, Settings } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { cn } from "../lib/cn";
import { useHoverIntent } from "../lib/useHoverIntent";
import { useLens } from "../lib/useLens";
import { mergeRefs, useSpecular } from "../lib/useSpecular";
import ModeToggle from "./ModeToggle";

interface NavItem {
  label: string;
  Icon: LucideIcon;
  to?: string;
}

// All five are live. AI Tools and Discover are preview pages — the content is
// sample data and every control says so, which is the honest version of the
// dead nav rows they used to be. The `to`-less branch below stays for Settings.
const NAV: NavItem[] = [
  { label: "Home", Icon: Home, to: "/" },
  { label: "Create", Icon: Plus, to: "/create" },
  { label: "Library", Icon: Library, to: "/library" },
  { label: "AI Tools", Icon: Sparkles, to: "/tools" },
  { label: "Discover", Icon: Compass, to: "/discover" },
];

/**
 * The desktop rail. Below `lg` navigation is a bottom tab bar instead — a
 * 64px rail that only opens on hover is most of a phone's width and none of its
 * affordances.
 */
export default function Sidebar({
  name,
  email,
  onSignOut,
}: {
  name: string | null;
  email: string | null;
  onSignOut: () => void;
}) {
  const displayName = name || (email ? email.split("@")[0]! : "Account");
  const initial = displayName[0]!.toUpperCase();
  const { hovered, onMouseEnter, onMouseLeave } = useHoverIntent();
  // Keyboard users never fire hover, so tabbing into the rail opens it too.
  const [focusWithin, setFocusWithin] = useState(false);
  const expanded = hovered || focusWithin;
  const nav = useNavigate();
  const { pathname } = useLocation();

  const lensRef = useLens<HTMLElement>("md", 24);
  const specularRef = useSpecular<HTMLElement>();

  const reveal = expanded ? "opacity-100" : "opacity-0";

  return (
    <aside
      ref={mergeRefs(lensRef, specularRef)}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onFocusCapture={() => setFocusWithin(true)}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusWithin(false);
      }}
      className={cn(
        "lg-lens hidden overflow-hidden px-3 py-4 transition-[width] duration-300 ease-sheet",
        "lg:fixed lg:bottom-3 lg:left-3 lg:top-3 lg:z-20 lg:flex lg:flex-col",
        expanded ? "lg:w-[228px]" : "lg:w-[64px]",
      )}
      style={{ "--r": "24px", "--pad": "12px" } as React.CSSProperties}
    >
      {/* Brand mark — "R" collapsed, "RITHM" on hover */}
      <div className="mb-6 flex h-9 items-center px-2">
        <span className="whitespace-nowrap font-display text-lg font-bold tracking-[0.14em] text-ink">
          R
          <span className={cn("transition-opacity duration-200", reveal)}>ITHM</span>
        </span>
      </div>

      {/* Nav */}
      <nav className="flex flex-col gap-1">
        {NAV.map(({ label, Icon, to }) => {
          const active = to !== undefined && pathname === to;
          return (
            <button
              key={label}
              type="button"
              title={to ? label : `${label} — coming soon`}
              aria-label={to ? label : `${label} — coming soon`}
              aria-current={active ? "page" : undefined}
              disabled={!to}
              onClick={to ? () => nav(to) : undefined}
              className={cn(
                "r-inner flex h-11 items-center gap-3.5 border px-2 transition-colors",
                !to && "cursor-not-allowed border-transparent text-ink-faint opacity-40",
                to && active && "border-signal/25 bg-signal/15 text-ink",
                to &&
                  !active &&
                  "border-transparent text-ink-muted hover:bg-white/[0.06] hover:text-ink",
              )}
            >
              <Icon
                className={cn("h-5 w-5 flex-shrink-0", active && "text-signal-bright")}
                strokeWidth={1.75}
              />
              <span
                className={cn(
                  "whitespace-nowrap text-sm font-medium transition-opacity duration-200",
                  reveal,
                )}
              >
                {label}
              </span>
            </button>
          );
        })}
      </nav>

      {/* Footer: mode toggle + settings + profile */}
      <div className="mt-auto">
        {/* Basic/Pro mode — compact button collapsed, full pill on hover */}
        <div className="mb-2 px-1">
          <ModeToggle expanded={expanded} />
        </div>

        {/* Settings — subtle, sits just above the profile */}
        <button
          type="button"
          disabled
          title="Settings — coming soon"
          aria-label="Settings — coming soon"
          className="r-inner flex h-10 w-full cursor-not-allowed items-center gap-3.5 border border-transparent px-2 text-ink-faint opacity-40"
        >
          <Settings className="h-[18px] w-[18px] flex-shrink-0" strokeWidth={1.75} />
          <span
            className={cn(
              "whitespace-nowrap text-sm font-medium transition-opacity duration-200",
              reveal,
            )}
          >
            Settings
          </span>
        </button>

        {/* Profile — name over email */}
        <div className="mt-2 border-t border-white/5 pt-3">
          <div className="flex items-center gap-3 px-1">
            <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border border-signal/60 bg-transparent font-mono text-xs font-semibold text-signal-bright">
              {initial}
            </span>
            <div
              className={cn(
                "flex min-w-0 flex-1 items-center justify-between gap-2 transition-opacity duration-200",
                reveal,
              )}
            >
              <div className="min-w-0">
                <p className="truncate text-xs font-medium text-ink">{displayName}</p>
                <p className="truncate text-2xs text-ink-faint">{email ?? "—"}</p>
              </div>
              <button
                type="button"
                onClick={onSignOut}
                title="Sign out"
                aria-label="Sign out"
                className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-control text-ink-faint transition-colors hover:bg-white/[0.06] hover:text-ink"
              >
                <LogOut className="h-[17px] w-[17px]" strokeWidth={1.75} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
