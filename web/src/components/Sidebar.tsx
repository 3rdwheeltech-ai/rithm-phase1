import { Home, Plus, Library, Sparkles, Compass, LogOut } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useHoverIntent } from "../lib/useHoverIntent";

interface NavItem {
  label: string;
  Icon: LucideIcon;
  active?: boolean;
}

// Only Home is live this phase; the rest are visual placeholders (no routes yet).
const NAV: NavItem[] = [
  { label: "Home", Icon: Home, active: true },
  { label: "Create", Icon: Plus },
  { label: "Library", Icon: Library },
  { label: "AI Tools", Icon: Sparkles },
  { label: "Discover", Icon: Compass },
];

export default function Sidebar({
  email,
  onSignOut,
}: {
  email: string | null;
  onSignOut: () => void;
}) {
  const initial = email ? email[0]!.toUpperCase() : "?";
  const { hovered: expanded, onMouseEnter, onMouseLeave } = useHoverIntent();

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
        {NAV.map(({ label, Icon, active }) => (
          <button
            key={label}
            type="button"
            title={label}
            aria-label={label}
            aria-current={active ? "page" : undefined}
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
        ))}
      </nav>

      {/* Profile */}
      <div className="mt-auto border-t border-white/5 pt-3">
        <div className="flex h-11 items-center gap-3 px-1">
          <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border border-white/10 bg-gradient-to-br from-brand to-brand-soft text-[13px] font-semibold text-white">
            {initial}
          </span>
          <div
            className={`flex min-w-0 flex-1 items-center justify-between gap-2 transition-opacity duration-200 ${reveal}`}
          >
            <span className="truncate text-[12.5px] text-ink-muted">{email ?? "—"}</span>
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
    </aside>
  );
}
