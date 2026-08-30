import { MessageSquare, Mic } from "lucide-react";
import { useChatSession } from "../../hooks/useChat";
import { useAssistant } from "../../store/assistant";

/**
 * The assistant's front door on a phone.
 *
 * NOT A NEW TAB. `TabBar` is explicit that four destinations plus Account is
 * the most the bar holds at 375px. And not the account sheet either: that is
 * established as the place for "somewhere you go on purpose", and the
 * assistant is not a destination — it is the app's OTHER INPUT METHOD. Burying
 * it there makes it undiscoverable.
 *
 * NOT A FAB, for a concrete reason rather than taste: `--dock` is already
 * 142px with a track loaded, and a FAB would want `position: fixed` inside a
 * page full of `backdrop-filter` — the containing-block trap this codebase has
 * already been bitten by twice (ErrorToast, GenerationPill).
 *
 * A card between QuickGenerate and RecentCreations instead. Home already
 * frames the decision — "Have something quick in mind?" — so "Or just tell me
 * about it" is the natural second door, with Talk and Chat side by side
 * exactly as `DoorToggle` pairs them on desktop.
 *
 * IT IMPORTS NO LOTTIE AND NO SDK. A lucide `Mic` and a `MessageSquare`, both
 * already in the entry chunk, and forty lines. That is the whole cost of
 * putting the assistant on phones for the first time.
 */
export default function VoiceCard({ className = "" }: { className?: string }) {
  const setSheetOpen = useAssistant((s) => s.setSheetOpen);
  const setMode = useAssistant((s) => s.setMode);
  const { data: session } = useChatSession();
  const voiceAvailable = session?.voice_available ?? false;

  function open(mode: "talk" | "chat"): void {
    setMode(mode);
    setSheetOpen(true);
  }

  return (
    <section
      aria-label="RIA - Your AI Assistant"
      className={`ai-frame mt-6 ${className}`}
    >
      <div className="quick-surface relative rounded-card px-4 py-5">
        <p className="text-center text-sm font-semibold text-ink">
          Or just tell me about it
        </p>
        <p className="mx-auto mt-1 max-w-[280px] text-center text-2xs leading-relaxed text-ink-muted">
          The assistant asks a few questions and fills in the Create form for you.
        </p>

        <div className="mt-4 flex gap-2">
          {/*
            Talk leads, and it is disabled rather than hidden where the
            deployment has no avatar: a control that vanishes between visits
            reads as a bug, and the pair is the point.
          */}
          <button
            type="button"
            onClick={() => open("talk")}
            disabled={!voiceAvailable}
            title={voiceAvailable ? undefined : "Voice isn't available yet"}
            className="flex flex-1 items-center justify-center gap-2 rounded-control border border-signal/25 bg-signal/10 px-4 py-2.5 text-sm font-medium text-ink transition-colors hover:bg-signal/15 disabled:opacity-40"
          >
            <Mic className="h-4 w-4" strokeWidth={2} />
            Talk
          </button>

          <button
            type="button"
            onClick={() => open("chat")}
            className="flex flex-1 items-center justify-center gap-2 rounded-control border border-white/10 px-4 py-2.5 text-sm font-medium text-ink-muted transition-colors hover:bg-white/[0.06] hover:text-ink"
          >
            <MessageSquare className="h-4 w-4" strokeWidth={2} />
            Chat
          </button>
        </div>
      </div>
    </section>
  );
}
