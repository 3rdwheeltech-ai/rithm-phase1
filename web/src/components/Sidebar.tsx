import { Home, Plus, Library, Sparkles, Compass, LogOut, Settings } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { useHoverIntent } from "../lib/useHoverIntent";
import ModeToggle from "./ModeToggle";

interface NavItem {
  label: string;
  Icon: LucideIcon;
  to?: string;
}

// Home, Create and Library are live; AI Tools and Discover are visual
// placeholders (no routes yet).
const NAV: NavItem[] = [
  { label: "Home", Icon: Home, to: "/" },
  { label: "Create", Icon: Plus, to: "/create" },
  { label: "Library", Icon: Library, to: "/library" },
  { label: "AI Tools", Icon: Sparkles },
  { label: "Discover", Icon: Compass },
];

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
  const { hovered: expanded, onMouseEnter, onMouseLeave } = useHoverIntent();
  const nav = useNavigate();
  const { pathname } = useLocation();

  const reveal = expanded ? "opacity-100" : "opacity-0";

  return (
    <aside
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className={`glass-panel absolute bottom-3 left-3 top-3 z-20 flex flex-col overflow-hidden px-3 py-4 transition-[width] duration-300 ease-out ${
        expanded ? "w-[228px]" : "w-[64px]"
      }`}
    >
      {/* Brand mark — "R" collapsed, "RITHM" on hover */}
      <div className="mb-6 flex h-9 items-center px-2">
        <span className="whitespace-nowrap font-display text-[18px] tracking-[0.12em] text-white">
          R
          <span className={`transition-opacity duration-200 ${reveal}`}>ITHM</span>
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
            title={label}
            aria-label={label}
            aria-current={active ? "page" : undefined}
            onClick={to ? () => nav(to) : undefined}
            className={
              active
                ? "flex h-11 items-center gap-3.5 rounded-el border border-brand/25 bg-brand/15 px-2 text-ink transition-colors"
                : "flex h-11 items-center gap-3.5 rounded-el border border-transparent px-2 text-ink-muted transition-colors hover:bg-white/[0.06] hover:text-ink"
            }
          >
            <Icon className="h-5 w-5 flex-shrink-0" strokeWidth={1.75} />
            <span
              className={`whitespace-nowrap text-[14px] font-medium transition-opacity duration-200 ${reveal}`}
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
          title="Settings"
          aria-label="Settings"
          className="flex h-10 w-full items-center gap-3.5 rounded-el border border-transparent px-2 text-ink-faint transition-colors hover:bg-white/[0.06] hover:text-ink"
        >
          <Settings className="h-[18px] w-[18px] flex-shrink-0" strokeWidth={1.75} />
          <span
            className={`whitespace-nowrap text-[13.5px] font-medium transition-opacity duration-200 ${reveal}`}
          >
            Settings
          </span>
        </button>

        {/* Profile — name over email */}
        <div className="mt-2 border-t border-white/5 pt-3">
          <div className="flex items-center gap-3 px-1">
            <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border border-brand/60 bg-transparent text-[13px] font-semibold text-brand-soft">
              {initial}
            </span>
            <div
              className={`flex min-w-0 flex-1 items-center justify-between gap-2 transition-opacity duration-200 ${reveal}`}
            >
              <div className="min-w-0">
                <p className="truncate text-[12.5px] font-medium text-ink">{displayName}</p>
                <p className="truncate text-[11px] text-ink-faint">{email ?? "—"}</p>
              </div>
              <button
                type="button"
                onClick={onSignOut}
                title="Sign out"
                aria-label="Sign out"
                className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-white/[0.06] hover:text-ink"
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
