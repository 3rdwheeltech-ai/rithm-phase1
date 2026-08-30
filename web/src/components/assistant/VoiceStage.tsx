import { forwardRef } from "react";
import { ArrowRight, RotateCcw } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { cn } from "../../lib/cn";
import { ANAM_VIDEO_ELEMENT_ID } from "../../lib/anam/types";
import { usePrefersReducedMotion } from "../../lib/useReducedMotion";
import { mergeRefs } from "../../lib/useSpecular";
import { useAssistant, type VoicePhase, type VoiceStatus } from "../../store/assistant";
import { EMPTY_DRAFT, useChatSession, useResetChat } from "../../hooks/useChat";

/**
 * The avatar, the captions and the clock — inside `AvatarPanel`'s EXISTING lens.
 *
 * NO `.lg-lens` OF ITS OWN. `index.css` names four refracting panels on screen
 * at once as the ceiling and Home spends all four (Sidebar, QuickGenerate,
 * AvatarPanel, Player). This renders inside one of them.
 *
 * THE BOX DOES NOT CHANGE SIZE. `useLens` rebuilds a displacement map on
 * `ResizeObserver`, so the `<video>` occupies the same `aspect-square w-full`
 * the Lottie occupies and swapping them changes no geometry. If the swap ever
 * needs softening, use opacity or transform on an inner wrapper.
 *
 * The transcript is not decoration. `pa11y-ci` and an axe pass are both in this
 * repo, and a talking video with no captions would be caught — and would
 * deserve to be. It is also the real cover for the ~3 s think, so one element
 * serves two purposes.
 */

export interface VoiceCaption {
  id: string;
  role: "user" | "assistant";
  text: string;
}

/** Seconds left at which the countdown becomes visible. */
const WARN_AT_MS = 60_000;

/**
 * Old WebKit reads the `webkit-playsinline` ATTRIBUTE, not the React property.
 *
 * Without it iOS takes the video full-screen the instant it plays — over the
 * sheet, over the captions, over everything — which reads as the app losing
 * control of the page rather than as a video playing.
 */
function setWebkitPlaysInline(node: HTMLVideoElement | null): void {
  node?.setAttribute("webkit-playsinline", "true");
}

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** What the aura should be doing, given where the turn is. */
function auraClass(phase: VoicePhase, status: VoiceStatus): string {
  if (status !== "live") return "avatar-aura";
  // One class, so the Anam video and the Lottie fallback speak the same "I'm
  // working" language — which matters because a user may see both in one
  // session.
  return phase === "thinking" ? "avatar-aura avatar-aura-thinking" : "avatar-aura";
}

const VoiceStage = forwardRef<
  HTMLVideoElement,
  {
    captions: VoiceCaption[];
    /** The utterance STT just finalised, shown before the reply exists. */
    pendingTranscript: string | null;
    onEnd: () => void;
    onGesture: () => void;
    className?: string;
  }
>(function VoiceStage(
  { captions, pendingTranscript, onEnd, onGesture, className },
  videoRef,
) {
  const reduceMotion = usePrefersReducedMotion();
  const nav = useNavigate();
  const reset = useResetChat();
  // The same cache entry ChatPanel reads, so neither door derives `ready` for
  // itself and the two can never disagree about when Create opens.
  const { data: session } = useChatSession();
  const draft = session?.draft ?? EMPTY_DRAFT;
  const ready = session?.ready ?? false;
  const status = useAssistant((s) => s.voiceStatus);
  const phase = useAssistant((s) => s.voicePhase);
  const remainingMs = useAssistant((s) => s.voiceRemainingMs);

  const connecting = status === "checking" || status === "connecting";
  const showCountdown = status === "live" && remainingMs > 0 && remainingMs <= WARN_AT_MS;

  return (
    <div className={cn("flex w-full flex-col", className)}>
      <div className="relative w-full overflow-hidden rounded-card border border-white/10 bg-[radial-gradient(ellipse_at_50%_30%,rgb(var(--signal)/0.13),transparent_70%)]">
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-0 z-10 rounded-card",
            auraClass(phase, status),
            // Reduced motion stills the aura, exactly as AssistantAvatar
            // already stops the Lottie. It does NOT hide Talk — see AvatarPanel.
            reduceMotion && "motion-safe:animate-none",
          )}
        />

        {/*
          The SAME `aspect-square w-full` box the Lottie occupies, so the swap
          changes no geometry and `useLens`'s ResizeObserver never fires.

          `aria-hidden` because it carries nothing the transcript below does not
          — a screen reader announcing "video" over a live caption log is noise.

          `muted` is NOT available to us: we need the audio, which is exactly
          why iOS will refuse to autoplay this and why "Tap to start" exists.
        */}
        {/*
          eslint-disable-next-line jsx-a11y/media-has-caption --
          A <track> element takes a WebVTT file, and this is a live WebRTC
          stream that has no file and no timed text to point one at. The
          captions this rule exists to demand are real and are right below:
          the `role="log"` transcript renders both sides of the conversation as
          it happens, which is why the element itself is `aria-hidden`.
        */}
        <video
          id={ANAM_VIDEO_ELEMENT_ID}
          ref={mergeRefs(videoRef, setWebkitPlaysInline)}
          playsInline
          autoPlay
          aria-hidden="true"
          className="aspect-square w-full object-cover"
        />

        {connecting && (
          <p className="absolute inset-0 z-20 flex items-center justify-center text-sm text-ink-muted">
            Connecting…
          </p>
        )}

        {/*
          Autoplay's guaranteed path. Every production WebRTC app ships this
          layer; treating it as an edge case is how you ship a permanent
          spinner on iPhone. The tap is a FRESH user gesture, which is the only
          thing that satisfies iOS once the original one has been consumed by
          an await.
        */}
        {status === "needs-gesture" && (
          <button
            type="button"
            onClick={onGesture}
            className="absolute inset-0 z-20 flex h-full w-full items-center justify-center bg-black/55 text-sm font-semibold text-ink backdrop-blur-sm"
          >
            Tap to start
          </button>
        )}

        {showCountdown && (
          <p className="absolute right-2 top-2 z-20 rounded-full bg-black/50 px-2 py-0.5 font-mono text-2xs tabular-nums text-ink-muted">
            {formatRemaining(remainingMs)}
          </p>
        )}
      </div>

      {/*
        `role="log"` carries an implicit `aria-live="polite"`, the same
        treatment ChatPanel gives its transcript — so each turn is announced
        without a live region of its own.
      */}
      <div
        role="log"
        aria-label="Voice transcript"
        className="scroll-plain mt-3 flex max-h-[132px] min-h-[44px] flex-col gap-1.5 overflow-y-auto pr-1"
      >
        {captions.map((caption) => (
          <p
            key={caption.id}
            className={cn(
              "text-2xs leading-snug",
              caption.role === "user" ? "text-ink-muted" : "text-ink",
            )}
          >
            {caption.text}
          </p>
        ))}

        {pendingTranscript !== null && (
          <p className="text-2xs leading-snug text-ink-muted">
            {pendingTranscript}
            {/*
              The exact treatment ChatPanel uses for thinking. The two doors
              must not blink differently — that is the kind of detail that reads
              as sloppiness without anyone being able to say why.
            */}
            <span aria-hidden="true" className="caret-blink ml-1 text-signal-bright">
              ▮
            </span>
          </p>
        )}
      </div>

      {/*
        NO CHIPS HERE ANY MORE, and their absence is deliberate rather than
        pending.

        They used to ride free on every turn response, generated server-side
        against the assistant's OWN reply — it chose the question, so chips for
        a different one would be worse than none. Anam's model writes the reply
        now, so there is nothing to generate them from short of a second model
        call, which would hand back exactly the latency that switch bought.

        Chat still has them: `/chat/messages` still answers with `suggestions`,
        and that path is untouched.
      */}

      {/*
        THE HANDOFF, on the Talk side at last.

        It only ever existed in Chat, so a user who described a song entirely by
        voice had no way out except switching doors to find the button. A pill
        rather than Chat's full `DraftCard`: that card is a tall block of text
        and this panel is already carrying a square video, a transcript and two
        controls. The card's job is to SUMMARISE what was captured, which the
        conversation just said out loud — so here the only part worth keeping is
        the door.

        `ready` is the same server-derived flag the DraftCard gates on, and it
        arrives through the same `qk.chat` entry, so the two doors agree about
        when the song is describable without either deriving it locally.

        AMBER, matching DraftCard's button, because it is the same action.
      */}
      {ready && (
        <button
          type="button"
          onClick={() => nav("/create", { state: { draft } })}
          className="glass-btn glass-btn-amber mt-3 min-h-[36px] w-full rounded-el px-3 text-2xs font-semibold"
        >
          Open in Create
          <ArrowRight className="ml-1.5 h-3.5 w-3.5" strokeWidth={2.5} />
        </button>
      )}

      {/*
        End, and Start over, as one row.

        A real <button> with a real label, replacing the Talk SpecularButton
        while live. Not only an a11y point: `Composer.tsx` records that each
        SpecularButton is a live WebGL context, and during a call StudioField's
        WebGL, the specular context, a `.lg-lens` filter pass and a 30 fps video
        decode are all compositing at once. One fewer context, and it is the
        correct control anyway.

        Start over ENDS THE SESSION FIRST. Clearing the transcript under a live
        avatar would leave Ria mid-sentence about a conversation that no longer
        exists — and it releases the product's one global Anam slot rather than
        holding it for a call whose whole subject was just deleted. Sized and
        styled off `ChatPanel`'s header pair so the two doors read the same.
      */}
      <div className="mt-3 flex w-full items-center gap-2">
        <button
          type="button"
          onClick={onEnd}
          className="flex-1 rounded-control border border-white/10 px-4 py-2 text-sm font-medium text-ink transition-colors hover:bg-white/[0.06]"
        >
          End
        </button>
        <button
          type="button"
          onClick={() => {
            onEnd();
            reset.mutate();
          }}
          disabled={reset.isPending || captions.length === 0}
          title="Start over"
          aria-label="Start over"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control border border-white/10 text-ink-faint transition-colors hover:bg-white/[0.06] hover:text-ink disabled:opacity-30"
        >
          <RotateCcw className="h-4 w-4" strokeWidth={2} />
        </button>
      </div>
    </div>
  );
});

export default VoiceStage;
