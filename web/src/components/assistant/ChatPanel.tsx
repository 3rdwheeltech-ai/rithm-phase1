import { useEffect, useRef, useState } from "react";
import { RotateCcw, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { ApiError } from "../../lib/api";
import { cn } from "../../lib/cn";
import { useLens } from "../../lib/useLens";
import { mergeRefs, useSpecular } from "../../lib/useSpecular";
import { useAssistant } from "../../store/assistant";
import { EMPTY_DRAFT, useChatSession, useResetChat, useSendChatMessage } from "../../hooks/useChat";
import {
  ASSISTANT_UNAVAILABLE_TYPE,
  CHAT_SESSION_FULL_TYPE,
  type ChatMessage as ChatMessageData,
} from "../../types/api";
import AssistantAvatar from "../AssistantAvatar";
import ChatMessage from "./ChatMessage";
import Composer from "./Composer";
import DoorToggle from "./DoorToggle";
import DraftCard from "./DraftCard";

const OPENING_LINE =
  "Tell me about the song you want — a scene, a feeling, anything at all.";

/**
 * The conversational door onto Create.
 *
 * DESIGNED TO 245px, not 312. The rail is `w-[312px]`, minus `p-4` twice is
 * 280, minus bubble padding and the avatar gutter is about 245px of text —
 * roughly 30-35 characters a line at `text-sm`. `xl:w-[340px]` only arrives at
 * 1280px wide, so it is a bonus and never the design target.
 *
 * THE PANEL NEVER RESIZES. `.lg-lens` is `flex-1` inside a `fixed top-3
 * bottom-3` aside, so its box is viewport-stable and the `ResizeObserver` in
 * `useLens` never fires as messages arrive. If `min-h-0` is ever lost here, or
 * the panel becomes auto-height, the displacement map rebuilds on every
 * revealed word. That is the failure mode to watch for.
 *
 * NOTHING INSIDE MAY BE `position: fixed`. `.lg-lens` sets `backdrop-filter`,
 * which makes this element a containing block — the same trap Layout.tsx
 * documents for ErrorToast. ComingSoonDialog is safe because it portals.
 *
 * This is the ONLY new `.lg-lens` in the feature. index.css names four on
 * screen at once as the ceiling and Home already spends all four; this one
 * takes AvatarPanel's slot. No lens on the DraftCard, the Composer or a bubble.
 */
export default function ChatPanel({ className = "" }: { className?: string }) {
  const nav = useNavigate();
  const setMode = useAssistant((s) => s.setMode);

  const { data: session } = useChatSession();
  const send = useSendChatMessage();
  const reset = useResetChat();

  const scrollRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  // The in-flight turn lives HERE, not in the query cache:
  // `refetchOnWindowFocus` is on globally, and a focus refetch mid-turn would
  // otherwise replace the transcript underneath the user as they read it.
  const [pending, setPending] = useState<string | null>(null);
  // Set by any interaction with the panel — a reader who is ahead of the
  // reveal should not have to wait for it.
  const [skipReveal, setSkipReveal] = useState(false);

  const messages = session?.messages ?? [];
  const draft = session?.draft ?? EMPTY_DRAFT;
  const ready = session?.ready ?? false;
  const busy = send.isPending;

  const lensRef = useLens<HTMLElement>("md", 24);
  const specularRef = useSpecular<HTMLElement>();

  // Follow the conversation. `scrollTop` rather than scrollIntoView: the
  // latter walks up to the nearest scrollable ancestor and would move the
  // page's own column when the transcript is already at its end.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, pending, busy]);

  const lastAssistantId = [...messages].reverse().find((m) => m.role === "assistant")?.id;

  /*
    Any click or keypress inside the panel completes an in-progress reveal.

    Registered imperatively rather than as an `onClick` in the JSX, and that is
    not a lint dodge: jsx-a11y is right that a static element must not carry a
    click handler, and the fix it wants — a role and a tab stop — would put a
    fake control in the tab order for behaviour that is pure decoration over
    text already in the DOM. Nothing here is reachable only this way.

    Cleared when a NEW assistant message arrives rather than at send time, so
    it cannot race the composer's own Enter keydown: this effect runs on the
    id changing, which is strictly after the turn lands.
  */
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const skip = () => setSkipReveal(true);
    el.addEventListener("click", skip);
    el.addEventListener("keydown", skip);
    return () => {
      el.removeEventListener("click", skip);
      el.removeEventListener("keydown", skip);
    };
  }, []);

  useEffect(() => {
    setSkipReveal(false);
  }, [lastAssistantId]);

  function onSend(message: string) {
    setPending(message);
    send.mutate(message, { onSettled: () => setPending(null) });
  }

  const error = send.error;
  const problemType = error instanceof ApiError ? error.type : "";
  // These two are rendered as muted rows INSIDE the transcript rather than as
  // an ErrorToast over the page: the chat still works, and one failed turn is
  // not a reason to cover the thing the user is in the middle of.
  const unavailable = problemType === ASSISTANT_UNAVAILABLE_TYPE;
  const sessionFull = problemType === CHAT_SESSION_FULL_TYPE;

  // One-tap answers to whatever was just asked, derived server-side from the
  // draft. They live on the mutation's last result rather than in state:
  // react-query already holds it, and a second copy could disagree.
  const suggestions = busy ? [] : (send.data?.suggestions ?? []);

  return (
    <section
      ref={mergeRefs(lensRef, specularRef, panelRef)}
      aria-label="AI assistant chat"
      className={cn("lg-lens relative flex flex-col overflow-hidden p-4", className)}
      style={{ "--r": "24px", "--pad": "16px" } as React.CSSProperties}
    >
      <header className="mb-3 flex shrink-0 items-center gap-2">
        <AssistantAvatar variant="chip" className="h-8 w-8" />
        <span className="eyebrow flex-1 truncate">AI Assistant</span>

        <button
          type="button"
          onClick={() => reset.mutate()}
          disabled={reset.isPending || messages.length === 0}
          title="Start over"
          aria-label="Start over"
          className="flex h-7 w-7 items-center justify-center rounded-control text-ink-faint transition-colors hover:bg-white/[0.06] hover:text-ink disabled:opacity-30"
        >
          <RotateCcw className="h-4 w-4" strokeWidth={2} />
        </button>

        {/*
          Leaving is a UI state change and NOTHING else — no DELETE. The
          transcript is durable, lives on the server, and is exactly what the
          user expects to find when they come back.

          The same destination as the toggle below, deliberately: the toggle
          names where it goes and is the discoverable control, this is the
          two-pixel version for someone who already knows. Sized and styled off
          the reset button beside it so the header reads as one pair of quiet
          utilities rather than a control and a decision.
        */}
        <button
          type="button"
          onClick={() => setMode("talk")}
          title="Close chat"
          aria-label="Close chat"
          className="flex h-7 w-7 items-center justify-center rounded-control text-ink-faint transition-colors hover:bg-white/[0.06] hover:text-ink"
        >
          <X className="h-4 w-4" strokeWidth={2} />
        </button>
      </header>

      {/*
        The way out, and the way to voice, in one control. The X in the header
        goes to the same place; this one is here because it SAYS where that is
        and what is on the other side, which an X cannot. Same row of the panel
        as in AvatarPanel, so switching does not move it.
      */}
      <DoorToggle className="mb-3 flex shrink-0 justify-center" />

      {/*
        `role="log"` carries an implicit `aria-live="polite"`, which is what
        announces each new turn — so the thinking row below needs no live
        region of its own.
      */}
      <div
        ref={scrollRef}
        role="log"
        className="scroll-plain -mr-1 flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto pr-1"
      >
        {messages.length === 0 && !pending && (
          <p className="surface rounded-card px-3 py-2.5 text-sm leading-relaxed text-ink-muted mr-6">
            {OPENING_LINE}
          </p>
        )}

        {messages.map((message: ChatMessageData) => (
          <ChatMessage
            key={message.id}
            message={message}
            reveal={message.id === lastAssistantId && !skipReveal}
          />
        ))}

        {/* The optimistic user turn, shown the instant they press send. */}
        {pending !== null && (
          <div className="flex justify-end">
            <p className="ml-6 max-w-[90%] whitespace-pre-wrap break-words rounded-card border border-signal/20 bg-signal/[0.10] px-3 py-2.5 text-sm leading-relaxed text-ink opacity-60">
              {pending}
            </p>
          </div>
        )}

        {busy && (
          <p className="text-sm text-ink-faint">
            <span className="sr-only">The assistant is thinking</span>
            <span aria-hidden="true" className="caret-blink text-signal-bright">
              ▮
            </span>
          </p>
        )}

        {unavailable && (
          <p className="text-2xs leading-snug text-amber" role="alert">
            The assistant didn't answer that one. Your message was saved — send it
            again.
          </p>
        )}
        {sessionFull && (
          <p className="text-2xs leading-snug text-amber" role="alert">
            This conversation has gone as far as it can. Start over to keep going.
          </p>
        )}
        {error !== null && !unavailable && !sessionFull && (
          <p className="text-2xs leading-snug text-amber" role="alert">
            {error.message}
          </p>
        )}

        {ready && <DraftCard draft={draft} />}
      </div>

      {suggestions.length > 0 && (
        <div className="mt-2 flex shrink-0 flex-wrap gap-1.5">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => onSend(suggestion)}
              className="lg-thin rounded-full px-3 py-1 text-2xs font-medium text-ink-muted transition-colors hover:text-ink"
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}

      {(session?.messages.length ?? 0) > 0 && !ready && (
        // The SAME destination as the DraftCard's button, with the same draft —
        // so it says the same words. Always available, so nobody is held
        // hostage by the server's `ready` decision; quiet, because before the
        // core three are answered Create opens on a form with holes in it.
        // The two are rarely on screen together: `ready` is three answers away.
        <button
          type="button"
          onClick={() => nav("/create", { state: { draft } })}
          className="mt-2 shrink-0 self-end text-2xs text-ink-faint underline-offset-2 transition-colors hover:text-ink-muted hover:underline"
        >
          Continue in Create →
        </button>
      )}

      <Composer onSend={onSend} busy={busy} />
    </section>
  );
}
