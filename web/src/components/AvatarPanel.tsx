import { useEffect, useRef, useState } from "react";
import Lottie, { type LottieRefCurrentProps } from "lottie-react";
import { useLens } from "../lib/useLens";
import { mergeRefs, useSpecular } from "../lib/useSpecular";
import avatarAnimation from "../assets/avatar.lottie.json";

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
 */
function StreamingPrompt({ enabled }: { enabled: boolean }) {
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
 * aura. The "Talk" button is visual only this phase; functionality lands once the
 * assistant is wired up.
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
  const lottieRef = useRef<LottieRefCurrentProps>(null);
  const [reduceMotion, setReduceMotion] = useState(false);

  // Matches the Player it stacks above, so the two read as one column of glass
  // rather than two different materials.
  const lensRef = useLens<HTMLElement>("md", 24);
  const specularRef = useSpecular<HTMLElement>();

  // Honour the user's reduced-motion preference — hold the Lottie on its first
  // frame instead of looping.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReduceMotion(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    if (reduceMotion) lottieRef.current?.stop();
  }, [reduceMotion]);

  return (
    <section
      ref={mergeRefs(lensRef, specularRef)}
      className={`lg-lens relative flex flex-col items-center overflow-hidden p-4 ${className}`}
      style={{ "--r": "24px", "--pad": "16px" } as React.CSSProperties}
    >
      <span className="mb-3 self-start eyebrow">
        AI Assistant
      </span>

      {/* Avatar stage — Lottie character lit by a breathing brand aura behind it */}
      <div className="relative w-full overflow-hidden rounded-card border border-white/10 bg-[radial-gradient(ellipse_at_50%_30%,rgb(var(--signal)/0.13),transparent_70%)]">
        {/* Aura glow behind the character */}
        <div className="avatar-aura pointer-events-none absolute inset-0 rounded-card" />

        {src ? (
          <img src={src} alt="AI assistant avatar" className="relative aspect-square w-full object-cover" />
        ) : (
          <Lottie
            lottieRef={lottieRef}
            animationData={avatarAnimation}
            loop
            autoplay={!reduceMotion}
            className="relative aspect-square w-full"
            rendererSettings={{ preserveAspectRatio: "xMidYMid meet" }}
          />
        )}
      </div>

      {/* Streaming assistant prompts, just below the avatar */}
      <StreamingPrompt enabled={!reduceMotion} />

      {/* Talk — breathing AI outline, matches the Generate button */}
      <div className="ai-frame-btn mt-4 w-full max-w-[200px]">
        <button
          type="button"
          className="glass-btn glass-btn-solid w-full rounded-el min-h-[44px] px-6 text-base font-semibold"
        >
          Talk
        </button>
      </div>
    </section>
  );
}
