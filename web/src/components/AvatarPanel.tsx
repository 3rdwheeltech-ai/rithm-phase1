import { useEffect, useState } from "react";
import { useChatSession } from "../hooks/useChat";
import { useLens } from "../lib/useLens";
import { usePrefersReducedMotion } from "../lib/useReducedMotion";
import { mergeRefs, useSpecular } from "../lib/useSpecular";
import { useAssistant } from "../store/assistant";
import AssistantAvatar from "./AssistantAvatar";
import ComingSoonDialog from "./ComingSoonDialog";
import SpecularButton, { SPECULAR_BASE, SPECULAR_LINE } from "./SpecularButton";
import DoorToggle from "./assistant/DoorToggle";

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
 * TWO DOORS, and only one of them is built. `DoorToggle` chooses between them
 * and stays put across the swap; this is the Talk side of it.
 *
 * TALK IS THE PAGE'S PRIMARY ACTION HERE, so it gets the `SpecularButton` that
 * Create and Generate get — the same lit rim, the same size, the same weight in
 * the eye. Voice itself is cut (STT, TTS and an upload route are a feature of
 * their own), so pressing it opens a ComingSoonDialog: the treatment AiTools,
 * Discover and ModeToggle give every unbuilt feature. What it must not be is
 * the quiet secondary button it was, sitting next to a Chat that worked — that
 * read as voice being the lesser half rather than the unfinished one.
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
  const setMode = useAssistant((s) => s.setMode);
  const resumed = useAssistant((s) => s.resumed);
  const markResumed = useAssistant((s) => s.markResumed);
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
   *
   * ONCE PER PAGE LOAD, not once per mount — `resumed` is the whole reason
   * that flag exists. Leaving chat remounts this panel with the transcript
   * still sitting in the query cache, so an ungated restore would bounce the
   * user back into the conversation they had just closed, and both ways out
   * (the toggle and ChatPanel's X) would be dead controls.
   */
  const { data: session } = useChatSession();
  const hasTranscript = (session?.messages.length ?? 0) > 0;
  useEffect(() => {
    if (!hasTranscript || resumed) return;
    markResumed();
    setMode("chat");
  }, [hasTranscript, resumed, markResumed, setMode]);

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

      {/* Same row of the panel as in ChatPanel — see DoorToggle. */}
      <DoorToggle className="mb-3 flex w-full shrink-0 justify-center" />

      <AssistantAvatar src={src} />

      {/* Streaming assistant prompts, just below the avatar */}
      <StreamingPrompt enabled={!reduceMotion} />

      {/*
        The same control as Create's Create and Home's Generate, with the same
        props: this is the primary action of the panel it sits in, and three
        primary actions that look like three different things is how an app
        stops reading as one app.
      */}
      <div className="mt-4 flex w-full justify-center">
        <SpecularButton
          size="lg"
          radius={16}
          tint="#ffffff"
          tintOpacity={0}
          blur={5}
          textColor="#f5f5f5"
          lineColor={SPECULAR_LINE}
          baseColor={SPECULAR_BASE}
          intensity={2.5}
          shineSize={39}
          shineFade={32}
          thickness={2}
          speed={1.3}
          followMouse={false}
          proximity={140}
          autoAnimate={false}
          onClick={() => setComingSoon("Voice chat")}
          className="w-full max-w-[240px]"
        >
          Talk
        </SpecularButton>
      </div>

      {/* Portalled, so the `backdrop-filter` on this panel cannot become its
          containing block and trap a `fixed` overlay inside the card. */}
      <ComingSoonDialog feature={comingSoon} onClose={() => setComingSoon(null)} />
    </section>
  );
}
