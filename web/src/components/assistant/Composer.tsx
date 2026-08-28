import { useEffect, useRef, useState } from "react";
import { ArrowUp } from "lucide-react";
import { CHAT_MESSAGE_MAX_LENGTH } from "../../types/api";

/** Five rows of `text-sm` at `leading-relaxed`, in pixels. */
const MAX_HEIGHT_PX = 116;

/**
 * The message box.
 *
 * NOT a `SpecularButton` for the send control, deliberately: each instance of
 * that is a live WebGL context, and this one would sit inside a panel that is
 * already spending a `.lg-lens` filter pass per composite. A plain
 * `.ai-frame-btn` says the same thing for nothing.
 */
export default function Composer({
  onSend,
  busy,
  placeholder = "Tell me about the song…",
}: {
  onSend: (message: string) => void;
  busy: boolean;
  placeholder?: string;
}) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  // Auto-grow to the content, capped. Reset to `auto` first or the box only
  // ever ratchets upwards — scrollHeight is measured against the height it
  // already has.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [value]);

  // The box is the only thing to do in this panel, so it holds the caret: on
  // open, and again the moment a turn lands. `disabled={busy}` blurs it
  // mid-turn, and this runs after the commit that re-enables it — so the next
  // answer can be typed without first aiming at the box. `busy` is false at
  // mount, which is what covers opening the panel.
  useEffect(() => {
    if (!busy) ref.current?.focus();
  }, [busy]);

  const canSend = value.trim().length > 0 && !busy;

  function send() {
    if (!canSend) return;
    onSend(value.trim());
    setValue("");
  }

  return (
    <div className="mt-3 flex items-end gap-2">
      <textarea
        ref={ref}
        rows={1}
        value={value}
        disabled={busy}
        maxLength={CHAT_MESSAGE_MAX_LENGTH}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends; Shift+Enter is a newline. Never intercept a
          // composition keypress — an IME's Enter is confirming a candidate,
          // not submitting a message.
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
        aria-label="Message the assistant"
        placeholder={placeholder}
        className="glass-input min-h-[44px] flex-1 resize-none px-3 py-2.5 text-sm leading-relaxed disabled:opacity-50"
      />

      <div className="ai-frame-btn shrink-0">
        <button
          type="button"
          onClick={send}
          disabled={!canSend}
          title="Send"
          aria-label="Send"
          className="glass-btn glass-btn-solid h-11 w-11 rounded-el p-0"
        >
          <ArrowUp className="h-[18px] w-[18px]" strokeWidth={2.5} />
        </button>
      </div>
    </div>
  );
}
