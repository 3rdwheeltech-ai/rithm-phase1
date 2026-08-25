import { useEffect, useState } from "react";
import { useChatSession } from "../hooks/useChat";
import { useLens } from "../lib/useLens";
import { usePrefersReducedMotion } from "../lib/useReducedMotion";
import { mergeRefs, useSpecular } from "../lib/useSpecular";
import { useAssistant } from "../store/assistant";
import AssistantAvatar from "./AssistantAvatar";
import ComingSoonDialog from "./ComingSoonDialog";

// Prompts the assistant "streams" letter-by-letter, cycling on a loop.
const PROMPTS = [
  "What shall I generate?",
  "How can I help?",
  "Describe a vibe…",
  "Need a fresh beat?",
  "Let's make something.",
];

const SLOT_MS = 3000; // each beat (cursor gap / phrase) lasts 3s
const TYPE_MS = 45; // per-character typing speed
const PHRASES_PER_CYCLE = 2; // phrases shown between cursor-only gaps

/**
 * Loops a fixed timeline: 3s of just the blinking cursor, then a couple of
 * phrases typed out LLM-style and held — each for 3s — then back to the cursor
 * gap, advancing through the phrase list. Falls back to a static phrase when
 * reduced motion is set.
 *
 * Exported because `ChatPanel` reuses the caret treatment for its "thinking"
 * row: the two are the same idea, and two blinking carets that blink
 * differently is the kind of detail that reads as sloppiness without anyone
 * being able to say why.
 */
export function StreamingPrompt({ enabled }: { enabled: boolean }) {
  const [text, setText] = useState("");

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      });
    const set = (v: string) => {
      if (!cancelled) setText(v);
    };

    async function run() {
      let phrase = 0;
      while (!cancelled) {
        // Cursor-only gap.
        set("");
        await wait(SLOT_MS);

        for (let k = 0; k < PHRASES_PER_CYCLE && !cancelled; k++) {
          const full = PROMPTS[phrase % PROMPTS.length]!;
          phrase++;
          // Type it out one character at a time…
          for (let i = 1; i <= full.length && !cancelled; i++) {
            set(full.slice(0, i));
            await wait(TYPE_MS);
          }
          // …then hold it for the remainder of the 3s slot.
          await wait(Math.max(0, SLOT_MS - full.length * TYPE_MS));
        }
      }
    }
    void run();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled]);

  if (!enabled) {
    return (
      <p className="mt-3 min-h-[2.5em] px-2 text-center text-sm leading-snug text-ink-muted">
        {PROMPTS[0]}
      </p>
    );
  }

  return (
    <p
      className="mt-3 min-h-[2.5em] px-2 text-center text-sm leading-snug text-ink-muted"
      aria-live="polite"
    >
      {text}
      <span className="caret-blink ml-0.5 inline-block w-px align-baseline text-signal-bright">|</span>
    </p>
  );
}

/**
 * The AI-assistant avatar atop the Home page's right column. The portrait is a
 * looping Lottie character framed in glass, lit from behind by a breathing brand
 * aura.
 *
 * TWO DOORS, and only one of them is built. "Chat" opens the conversational
 * panel and gets the breathing `.ai-frame-btn` outline, because the highlighted
 * door should be the one that works. "Talk" is voice, which is cut — it opens
 * a ComingSoonDialog, the same treatment AiTools, Discover and ModeToggle give
 * every unbuilt feature. It used to be a button that did nothing at all.
 *
 * `src` is reserved for swapping in a different portrait image later (it takes
 * precedence over the Lottie when provided).
 */
export default function AvatarPanel({
  src,
  className = "",
}: {
  src?: string;
  className?: string;
}) {
  const reduceMotion = usePrefersReducedMotion();
  const openChat = useAssistant((s) => s.openChat);
  const [comingSoon, setComingSoon] = useState<string | null>(null);

  /**
   * Resume a live conversation on a reload.
   *
   * `useAssistant` is not persisted, so `mode` survives SPA navigation and not
   * a refresh — which would otherwise drop the user back to this avatar while
   * their session sits on the server. The check belongs HERE rather than in
   * ChatPanel, which is only mounted once the decision has already been made,
   * and here rather than in Layout, which renders on every route and would
   * turn a Home-only feature into a request per page.
   *
   * ChatPanel reads the same cache entry, so opening costs no second request.
   */
  const { data: session } = useChatSession();
  const hasTranscript = (session?.messages.length ?? 0) > 0;
  useEffect(() => {
    if (hasTranscript) openChat();
  }, [hasTranscript, openChat]);

  // Matches the Player it stacks above, so the two read as one column of glass
  // rather than two different materials.
  const lensRef = useLens<HTMLElement>("md", 24);
  const specularRef = useSpecular<HTMLElement>();

  return (
    <section
      ref={mergeRefs(lensRef, specularRef)}
      className={`lg-lens relative flex flex-col items-center overflow-hidden p-4 ${className}`}
      style={{ "--r": "24px", "--pad": "16px" } as React.CSSProperties}
    >
      <span className="mb-3 self-start eyebrow">
        AI Assistant
      </span>

      <AssistantAvatar src={src} />

      {/* Streaming assistant prompts, just below the avatar */}
      <StreamingPrompt enabled={!reduceMotion} />

      <div className="mt-4 flex w-full max-w-[240px] gap-2">
        {/* Voice is cut: STT, TTS and an upload route are a feature of their
            own. Say so out loud rather than shipping a dead control. */}
        <button
          type="button"
          onClick={() => setComingSoon("Voice chat")}
          className="glass-btn min-h-[44px] flex-1 rounded-el px-4 text-base font-semibold"
        >
          Talk
        </button>

        {/* The rim marks the door that works. */}
        <div className="ai-frame-btn flex-1">
          <button
            type="button"
            onClick={openChat}
            className="glass-btn glass-btn-solid min-h-[44px] w-full rounded-el px-4 text-base font-semibold"
          >
            Chat
          </button>
        </div>
      </div>

      {/* Portalled, so the `backdrop-filter` on this panel cannot become its
          containing block and trap a `fixed` overlay inside the card. */}
      <ComingSoonDialog feature={comingSoon} onClose={() => setComingSoon(null)} />
    </section>
  );
}
