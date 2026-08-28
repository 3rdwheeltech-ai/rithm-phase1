import { lazy, Suspense, useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "../../lib/cn";
import { useVoiceSession } from "../../hooks/useVoiceSession";
import { useAssistant } from "../../store/assistant";
import AssistantPoster from "../AssistantPoster";
import DoorToggle from "./DoorToggle";
import VoiceStage from "./VoiceStage";
import { voiceFailureCopy } from "./voiceCopy";

// The chat door, in its own chunk. Kept lazy HERE rather than imported
// directly because `ChatPanel` statically imports `AssistantAvatar`, which
// statically imports the ~400kB Lottie renderer — so a phone that only ever
// presses Talk still never downloads it, which is the whole reason
// `AssistantPoster` exists.
const ChatPanel = lazy(() => import("./ChatPanel"));

/**
 * The assistant's surface on a phone: a full-screen sheet.
 *
 * PORTALLED TO `document.body`, AND THAT IS NOT OPTIONAL. `.lg-lens` sets
 * `backdrop-filter`, which makes every panel on Home a containing block —
 * `ComingSoonDialog` documents exactly this trap. A sheet rendered inline is a
 * sheet trapped inside a card.
 *
 * ZERO `.lg-lens` INSIDE IT. `index.css` caps four on screen at once and Home
 * spends all four; covering them does not free them, because they are still in
 * the DOM and still compositing. `.surface` and `.ai-frame` instead, as
 * `DraftCard` does for the same reason.
 *
 * NOT INLINE-EXPANDABLE ON THE PAGE: a 375px-wide video is too small for a
 * face to do its job, and inside `<main>`'s scroll container the persona would
 * scroll off-screen mid-sentence.
 *
 * The motion is borrowed wholesale from the Player's sheet — scrim as a real
 * `<button>`, `translate-y-full` → `translate-y-0` over
 * `duration-[420ms] ease-sheet`, `rounded-t-sheet`, and the safe-area padding.
 * It is the pattern the app already teaches, and a second sheet that animates
 * differently reads as a different app.
 *
 * THE "START OVER" CONTROL IS DELIBERATELY ABSENT. `useResetChat`
 * soft-deletes server-side, and a live loop's next POST would then silently
 * create a NEW session — so the reset lives only in `ChatPanel`, where no call
 * can be running beside it.
 */
export default function VoiceSheet() {
  const open = useAssistant((s) => s.sheetOpen);
  const setSheetOpen = useAssistant((s) => s.setSheetOpen);
  const status = useAssistant((s) => s.voiceStatus);
  const failure = useAssistant((s) => s.voiceFailure);

  const mode = useAssistant((s) => s.mode);

  const voice = useVoiceSession();

  const onStage = status !== "idle" && status !== "unavailable";
  const failureLine = voiceFailureCopy(failure);

  /*
    Switching to Chat TEARS THE SESSION DOWN FIRST, and that is not tidiness.

    Unlike desktop — where the two panels are mutually exclusive by
    construction — this sheet can render both doors, so a live loop and
    `useResetChat`'s "Start over" could otherwise be on screen together. Reset
    soft-deletes server-side, after which the loop's next POST would silently
    open a NEW session and the transcript would fork.
  */
  const endVoice = voice.end;
  useEffect(() => {
    if (mode === "chat" && status !== "idle") endVoice();
  }, [mode, status, endVoice]);

  // Escape closes AND stops the session — the two are one action here, because
  // a sheet that closes over a live microphone is a sheet still holding the
  // product's one global slot.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      voice.end();
      setSheetOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, setSheetOpen, voice]);

  // Body scroll locked while open, restored on close. Read the previous value
  // rather than assuming "": another sheet may already have locked it.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (typeof document === "undefined") return null;

  function close(): void {
    voice.end();
    setSheetOpen(false);
  }

  return createPortal(
    <div
      className={cn(
        // Above TabBar's z-40 and GradualBlur's z-20, below
        // ComingSoonDialog's z-[70].
        "fixed inset-0 z-[60] transition-opacity duration-300 ease-sheet",
        open ? "opacity-100" : "pointer-events-none opacity-0",
      )}
    >
      {/* Click-away as a real button rather than a handler on the scrim: it
          gets keyboard and screen-reader behaviour for free. */}
      <button
        type="button"
        aria-label="Close assistant"
        tabIndex={open ? 0 : -1}
        onClick={close}
        className="absolute inset-0 h-full w-full cursor-default bg-black/60 backdrop-blur-md"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="AI assistant"
        className={cn(
          "surface absolute inset-x-0 bottom-0 top-8 flex flex-col overflow-y-auto rounded-t-sheet border-t border-white/10 px-5 pb-[calc(env(safe-area-inset-bottom)+24px)] pt-3",
          "transition-transform duration-[420ms] ease-sheet",
          open ? "translate-y-0" : "translate-y-full",
        )}
      >
        <div className="mx-auto mb-1 h-1 w-10 shrink-0 rounded-full bg-white/20" />
        <button
          type="button"
          onClick={close}
          aria-label="Close assistant"
          className="-ml-2 mb-2 flex h-10 w-10 shrink-0 items-center justify-center self-start rounded-full text-ink-muted transition-colors hover:bg-white/[0.06] hover:text-ink"
        >
          <X className="h-5 w-5" strokeWidth={2} />
        </button>

        {/* Same control, same place, as on desktop — see DoorToggle. */}
        <DoorToggle className="mb-3 flex shrink-0 justify-center" />

        {mode === "chat" ? (
          /*
            `chrome="plain"`: NO `.lg-lens` inside this sheet. index.css caps
            four on screen at once, Home spends all four, and covering them
            does not free them — they are still in the DOM and still
            compositing.
          */
          <Suspense fallback={<div className="surface min-h-0 flex-1 rounded-card" />}>
            <ChatPanel chrome="plain" className="min-h-0 flex-1" />
          </Suspense>
        ) : onStage ? (
          <VoiceStage
            ref={voice.videoRef}
            captions={voice.captions}
            pendingTranscript={voice.pendingTranscript}
            suggestions={voice.suggestions}
            onSuggestion={voice.answerSuggestion}
            onEnd={close}
            onGesture={voice.retryGesture}
            className="w-full"
          />
        ) : (
          <>
            {/* AssistantPoster, NOT AssistantAvatar. The latter statically
                imports the Lottie renderer, which would then ship to every
                phone — see the poster's own docstring. */}
            <AssistantPoster />

            {failureLine !== null && (
              <p
                role="status"
                className="mt-3 px-2 text-center text-2xs leading-snug text-amber"
              >
                {failureLine}
              </p>
            )}

            <button
              type="button"
              onClick={voice.start}
              disabled={!voice.canStart}
              className="mt-5 w-full rounded-control border border-signal/25 bg-signal/10 px-4 py-3 text-sm font-semibold text-ink transition-colors hover:bg-signal/15 disabled:opacity-40"
            >
              Talk
            </button>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
