import { useEffect, useRef } from "react";
import Lottie, { type LottieRefCurrentProps } from "lottie-react";
import { cn } from "../lib/cn";
import { usePrefersReducedMotion } from "../lib/useReducedMotion";
import avatarAnimation from "../assets/avatar.lottie.json";

/**
 * The assistant's face, at two sizes.
 *
 * Lifted out of `AvatarPanel` so `ChatPanel` can put the same character in its
 * header — the conversation is with someone, and a chat panel that opens
 * without the face the user just clicked reads as a different feature.
 *
 * IT PULLS IN ~400 kB OF LOTTIE RENDERER, which is why `AvatarPanel` is
 * `lazy()` in Layout.tsx: "never loaded on a phone at all" is the comment
 * there, and it is load-bearing. Anything importing this file must be lazy
 * too, or the renderer walks straight back into the entry chunk.
 *
 * `src` is reserved for swapping in a still portrait later; it takes
 * precedence over the Lottie when provided.
 */
export default function AssistantAvatar({
  variant = "stage",
  src,
  className = "",
}: {
  /**
   * "stage" — the framed, aura-lit square at the top of the assistant panel.
   * "chip" — a small round bust for a header row. No aura: at 32px the glow is
   * a smudge, and it would be sitting inside a `.lg-lens` that samples it.
   */
  variant?: "stage" | "chip";
  src?: string;
  className?: string;
}) {
  const lottieRef = useRef<LottieRefCurrentProps>(null);
  const reduceMotion = usePrefersReducedMotion();

  useEffect(() => {
    if (reduceMotion) lottieRef.current?.stop();
  }, [reduceMotion]);

  const stage = variant === "stage";
  const portrait = src ? (
    <img
      src={src}
      alt="AI assistant avatar"
      className="relative aspect-square w-full object-cover"
    />
  ) : (
    <Lottie
      lottieRef={lottieRef}
      animationData={avatarAnimation}
      loop
      autoplay={!reduceMotion}
      className="relative aspect-square w-full"
      rendererSettings={{ preserveAspectRatio: "xMidYMid meet" }}
    />
  );

  return (
    <div
      aria-hidden="true"
      className={cn(
        "relative overflow-hidden",
        stage
          ? "w-full rounded-card border border-white/10 bg-[radial-gradient(ellipse_at_50%_30%,rgb(var(--signal)/0.13),transparent_70%)]"
          : "shrink-0 rounded-full border border-signal/25 bg-signal/10",
        className,
      )}
    >
      {stage && (
        /* Aura glow behind the character. Stage only — see `variant` above. */
        <div className="avatar-aura pointer-events-none absolute inset-0 rounded-card" />
      )}
      {portrait}
    </div>
  );
}
