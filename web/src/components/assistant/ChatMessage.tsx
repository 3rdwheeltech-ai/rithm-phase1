import { useEffect, useState } from "react";
import { cn } from "../../lib/cn";
import { usePrefersReducedMotion } from "../../lib/useReducedMotion";
import type { ChatMessage as ChatMessageData } from "../../types/api";

/**
 * BY WORD, not by character.
 *
 * `StreamingPrompt` reveals at 45ms/char, which is right for a five-word
 * teaser and wrong here: a 400-character reply would be ~400 setState calls
 * and nine seconds of them, inside a `backdrop-filter` panel that re-composites
 * on every one. Chunking to words cuts both by roughly six.
 */
const WORD_MS = 45;

/** Split into words WITH their trailing whitespace, so joining is lossless. */
function tokenise(text: string): string[] {
  return text.match(/\S+\s*/g) ?? [];
}

function useWordReveal(text: string, enabled: boolean): string {
  const [shown, setShown] = useState(enabled ? 0 : Number.MAX_SAFE_INTEGER);

  useEffect(() => {
    if (!enabled) {
      setShown(Number.MAX_SAFE_INTEGER);
      return;
    }
    const total = tokenise(text).length;
    setShown(0);
    const timer = setInterval(() => {
      setShown((n) => {
        if (n >= total) {
          clearInterval(timer);
          return n;
        }
        return n + 1;
      });
    }, WORD_MS);
    return () => clearInterval(timer);
  }, [text, enabled]);

  return tokenise(text).slice(0, shown).join("");
}

/**
 * One turn in the transcript.
 *
 * `.surface` for the assistant and a signal-tinted card for the user — both
 * OPAQUE planes, per index.css's doctrine: glass is chrome, and text sits on
 * something solid. The panel around them is the only lens here.
 */
export default function ChatMessage({
  message,
  reveal,
}: {
  message: ChatMessageData;
  /**
   * Reveal this one progressively. True for the newest assistant turn only —
   * re-animating the whole transcript on every render would be a light show,
   * and a message the user has already read must not move.
   */
  reveal: boolean;
}) {
  const reduceMotion = usePrefersReducedMotion();
  const animate = reveal && !reduceMotion;
  const revealed = useWordReveal(message.content, animate);
  const mine = message.role === "user";

  return (
    <div className={cn("flex", mine ? "justify-end" : "justify-start")}>
      <p
        className={cn(
          "max-w-[90%] whitespace-pre-wrap break-words rounded-card px-3 py-2.5 text-sm leading-relaxed",
          mine
            ? "ml-6 border border-signal/20 bg-signal/[0.10] text-ink"
            : "surface mr-6 text-ink",
        )}
      >
        {animate ? revealed : message.content}
        {animate && revealed.length < message.content.length && (
          <span className="caret-blink ml-0.5 inline-block w-px align-baseline text-signal-bright">
            |
          </span>
        )}
      </p>
    </div>
  );
}
