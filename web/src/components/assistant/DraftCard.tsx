import { ArrowRight } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { formatDuration, trackTitle } from "../../lib/track";
import type { SongDraft } from "../../types/api";

/** Two chips fit on a 245px line; the rest become a count. */
const VISIBLE_INSTRUMENTS = 2;

/**
 * What the conversation has built, and the door out of it.
 *
 * `.ai-frame` wrapping `.surface`, NOT another `.lg-lens`. The frame is a
 * box-shadow plus a masked conic border — no backdrop pass at all — so it
 * marks this as the AI-made thing without spending any of the four-lens
 * budget index.css sets, which `ChatPanel` has already taken the last of.
 *
 * It SUMMARISES rather than lists. The column is 245px of text, about 30-35
 * characters a line: a field-by-field readout would be a wall, and the Create
 * form is one click away and shows all of it properly.
 */
export default function DraftCard({ draft }: { draft: SongDraft }) {
  const nav = useNavigate();

  const facts = [
    draft.genre,
    draft.mood,
    draft.lyrics_mode === "instrumental" ? "instrumental" : null,
    draft.length_seconds !== null ? formatDuration(draft.length_seconds) : null,
    draft.bpm_min !== null && draft.bpm_max !== null
      ? `${draft.bpm_min}–${draft.bpm_max} BPM`
      : null,
  ].filter((fact): fact is string => fact !== null);

  const shown = draft.instruments.slice(0, VISIBLE_INSTRUMENTS);
  const extra = draft.instruments.length - shown.length;

  return (
    <div className="ai-frame mt-1">
      <div className="surface p-3">
        <p className="truncate text-sm font-semibold text-ink">
          {trackTitle({ prompt: draft.prompt ?? "", title: draft.title })}
        </p>

        {facts.length > 0 && (
          <p className="mt-1 text-2xs leading-snug text-ink-muted">{facts.join(" · ")}</p>
        )}

        {shown.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {shown.map((instrument) => (
              <span
                key={instrument}
                className="lg-thin max-w-full truncate rounded-full px-2.5 py-0.5 text-2xs font-medium text-ink-muted"
              >
                {instrument}
              </span>
            ))}
            {extra > 0 && (
              <span className="px-1 py-0.5 text-2xs text-ink-faint">+{extra} more</span>
            )}
          </div>
        )}

        {/*
          The handoff. It carries the DRAFT, not a generation — the chatbot
          fills the form and the user presses Create, which is the review step
          and the whole point.
        */}
        <button
          type="button"
          onClick={() => nav("/create", { state: { draft } })}
          className="glass-btn glass-btn-solid mt-3 min-h-[40px] w-full rounded-el px-3 text-sm font-semibold"
        >
          Open in Create
          <ArrowRight className="ml-1.5 h-4 w-4" strokeWidth={2.5} />
        </button>
      </div>
    </div>
  );
}
