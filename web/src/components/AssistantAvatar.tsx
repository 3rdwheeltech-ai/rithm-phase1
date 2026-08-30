import { useEffect, useRef } from "react";
import Lottie, { type LottieRefCurrentProps } from "lottie-react";
import { cn } from "../lib/cn";
import { usePrefersReducedMotion } from "../lib/useReducedMotion";
import avatarAnimation from "../assets/avatar.lottie.json";
import riaPortrait from "../assets/ria-portrait.webp";

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
 * `src` DEFAULTS TO RIA — the same face the Anam avatar wears once Talk is
 * pressed. Before this, every surface showed the abstract Lottie until a voice
 * session connected, and the handoff read as the assistant being replaced by a
 * different character mid-interaction. The point of a persona is that it is
 * the same someone the whole way through, so the still portrait is the resting
 * state and the live avatar is that same face, animated.
 *
 * The image is BUNDLED, not hotlinked. The source is fetchable from Anam's lab
 * host, but an external image on the assistant's critical path is a vendor
 * dependency and a CSP surface for a 82 kB file we can simply ship.
 *
 * Pass `src={undefined}` explicitly to fall back to the Lottie.
 *
 * NOTE the Lottie renderer is still statically imported below and so still
 * costs its ~400 kB even though the portrait is now the default path. Making
 * it load only when actually used is a worthwhile follow-up, not part of this
 * change.
 */
export default function AssistantAvatar({
  variant = "stage",
  src = riaPortrait,
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
      // `object-top`, not the default centre. The source is 768x1152 and the
      // face sits in the upper half, so a centred square crop would cut the
      // top of her head off and fill the bottom third with hoodie.
      className="relative aspect-square w-full object-cover object-top"
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
