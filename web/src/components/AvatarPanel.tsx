import { useEffect, useState } from "react";
import { useChatSession } from "../hooks/useChat";
import { useVoiceSession } from "../hooks/useVoiceSession";
import { useLens } from "../lib/useLens";
import { usePrefersReducedMotion } from "../lib/useReducedMotion";
import { mergeRefs, useSpecular } from "../lib/useSpecular";
import { useAssistant } from "../store/assistant";
import AssistantAvatar from "./AssistantAvatar";
import ComingSoonDialog from "./ComingSoonDialog";
import SpecularButton, { SPECULAR_BASE, SPECULAR_LINE } from "./SpecularButton";
import DoorToggle from "./assistant/DoorToggle";
import VoiceStage from "./assistant/VoiceStage";
import { voiceFailureCopy } from "./assistant/voiceCopy";

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
 * the eye. What it must not be is the quiet secondary button it was, sitting
 * next to a Chat that worked — that read as voice being the lesser half rather
 * than the unfinished one.
 *
 * TWO FAILURE FAMILIES, TREATED DIFFERENTLY ON PURPOSE:
 *
 * - Voice was never available here (`voice_available: false`, no WebRTC, no
 *   getUserMedia). The panel is BIT-FOR-BIT what shipped before voice existed:
 *   Lottie, `StreamingPrompt`, and Talk opening `ComingSoonDialog`. That is
 *   why `ComingSoonDialog` stays live code with a live test rather than being
 *   deleted, and it is the state every environment without an Anam key is in.
 * - Voice exists and this attempt failed. Lottie, one quiet line naming why,
 *   and Talk still a real control that retries once its cooldown passes.
 *
 * Neither touches the conversation, because the conversation is on the server.
 * The panel, the `DoorToggle` and the single `.lg-lens` never move: the voice
 * stage occupies the same box the avatar does.
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
  const voiceStatus = useAssistant((s) => s.voiceStatus);
  const voiceFailure = useAssistant((s) => s.voiceFailure);
  const [comingSoon, setComingSoon] = useState<string | null>(null);

  const voice = useVoiceSession();

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
   *
   * IT ARMS ON THE QUERY RESOLVING, NOT ON THE TRANSCRIPT BEING NON-EMPTY, and
   * that distinction is a bug fix rather than a style choice. The old condition
   * (`if (!hasTranscript || resumed) return`) left the effect ARMED through a
   * whole voice session whenever the transcript started empty: nothing had
   * resolved it, so `resumed` stayed false, and the first turn the user spoke
   * flipped `hasTranscript` true and fired the restore MID-CALL. Talk would
   * throw the user into Chat one sentence into their own conversation.
   *
   * Keying on `session` instead means the decision is made once, at the moment
   * the transcript first arrives, on the transcript AS IT WAS THEN — which is
   * the question this effect was always trying to ask. A transcript that grows
   * later is this page load's own doing and must never re-trigger it.
   */
  const { data: session } = useChatSession();
  useEffect(() => {
    if (session === undefined || resumed) return;
    markResumed();
    if (session.messages.length > 0) setMode("chat");
  }, [session, resumed, markResumed, setMode]);

  // Matches the Player it stacks above, so the two read as one column of glass
  // rather than two different materials.
  const lensRef = useLens<HTMLElement>("md", 24);
  const specularRef = useSpecular<HTMLElement>();

  /*
    THREE QUESTIONS, NOT ONE, because §4.1 answers them differently.

    `voiceConfigured` — does this deployment have an avatar at all? It rides on
    the session GET this panel has already fetched for the resume check above,
    so discovery costs no extra request and does not spend the product's one
    global Anam slot to answer a yes/no. False means voice was NEVER HERE, and
    the panel is bit-for-bit what shipped before it existed: Talk opens the
    Coming Soon dialog. `not-configured` is folded in as the backstop for the
    race where the server flag flips between the GET and the POST.

    `voice.supported` — can this browser do WebRTC and getUserMedia? Checked
    HERE rather than discovered by failing: never mint a token, and never take
    the global slot, to learn something `window` already knows. Voice exists,
    so Talk is a real control that is DISABLED and says why — not a Coming Soon
    dialog, which would be a lie about the product.

    `voice.canStart` — is a cooldown running? Same treatment: disabled, with a
    reason.
  */
  const voiceConfigured =
    (session?.voice_available ?? false) && voiceFailure !== "not-configured";

  // The stage replaces the avatar the moment anything is happening, so
  // "Connecting…" lands on the surface it is about rather than under it.
  const onStage =
    voiceConfigured && voiceStatus !== "idle" && voiceStatus !== "unavailable";

  const failureLine = voiceConfigured ? voiceFailureCopy(voiceFailure) : null;

  const talkTitle = !voiceConfigured
    ? undefined
    : !voice.supported
      ? "This browser can't do voice"
      : !voice.canStart
        ? "Give it a moment before trying again"
        : undefined;

  return (
    <section
      ref={mergeRefs(lensRef, specularRef)}
      // Named, like ChatPanel beside it. A `<section>` only becomes a landmark
      // once it has an accessible name, and the two doors should be the same
      // shape to assistive tech as they are to the eye.
      aria-label="AI assistant"
      className={`lg-lens relative flex flex-col items-center overflow-hidden p-4 ${className}`}
      style={{ "--r": "24px", "--pad": "16px" } as React.CSSProperties}
    >
      <span className="mb-3 self-start eyebrow">
        AI Assistant
      </span>

      {/* Same row of the panel as in ChatPanel — see DoorToggle. */}
      <DoorToggle className="mb-3 flex w-full shrink-0 justify-center" />

      {/*
        ONE OR THE OTHER, IN THE SAME BOX. `VoiceStage`'s video is the same
        `aspect-square w-full` the Lottie is, so this swap changes no geometry
        and `useLens`'s ResizeObserver never fires. `AssistantAvatar` itself is
        not modified by the voice work at all — the fallback is today's avatar,
        never a third thing and never an error screen.
      */}
      {onStage ? (
        <VoiceStage
          ref={voice.videoRef}
          captions={voice.captions}
          pendingTranscript={voice.pendingTranscript}
          suggestions={voice.suggestions}
          onSuggestion={voice.answerSuggestion}
          onEnd={voice.end}
          onGesture={voice.retryGesture}
          className="w-full"
        />
      ) : (
        <>
          <AssistantAvatar src={src} />

          {/* Streaming assistant prompts, just below the avatar */}
          <StreamingPrompt enabled={!reduceMotion} />

          {failureLine !== null && (
            <p
              role="status"
              className="mt-2 px-2 text-center text-2xs leading-snug text-amber"
            >
              {failureLine}
            </p>
          )}

          {/*
            The same control as Create's Create and Home's Generate, with the
            same props: this is the primary action of the panel it sits in, and
            three primary actions that look like three different things is how
            an app stops reading as one app.

            What it DOES depends on one server-supplied flag. With voice
            configured it starts a session; without it, it opens the same
            Coming Soon dialog it has always opened — which is what keeps this
            panel bit-for-bit unchanged in every environment without a key.
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
              disabled={voiceConfigured && !voice.canStart}
              title={talkTitle}
              onClick={() => {
                if (!voiceConfigured) {
                  setComingSoon("Voice chat");
                  return;
                }
                // Straight through, with NO await before it: the first two
                // statements inside `start` have to run while the browser
                // still considers this a user gesture.
                voice.start();
              }}
              className="w-full max-w-[240px]"
            >
              Talk
            </SpecularButton>
          </div>
        </>
      )}

      {/* Portalled, so the `backdrop-filter` on this panel cannot become its
          containing block and trap a `fixed` overlay inside the card. */}
      <ComingSoonDialog feature={comingSoon} onClose={() => setComingSoon(null)} />
    </section>
  );
}
