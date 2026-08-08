import type { TrackSummary } from "../types/api";

const TITLE_MAX_LENGTH = 48;

/**
 * Filler that opens a prompt but never belongs in a name, stripped in order and
 * repeatedly — "create a song about rainy nights" peels down to "rainy nights".
 *
 * Deliberately conservative. Descriptive leading words are NOT stripped, because
 * they carry the whole meaning: "instrumental lo-fi beat" must not become
 * "lo-fi beat". That is why the generic nouns below only match when a connector
 * follows them ("song about …"), never on their own.
 */
const LEADING_NOISE: RegExp[] = [
  // No \b after this one: "e.g." ends in a period, and there is no word
  // boundary between "." and the following space, so \b would never match.
  /^(?:e\.?\s?g\.?|for example|please|can you|could you|i(?:'d| would) like|i want)[\s.,:;-]*/i,
  /^(?:make|create|generate|compose|write|produce|build|give)\s+(?:me\s+)?/i,
  /^(?:a|an|the)\b/i,
  /^(?:song|track|piece|tune|melody|music)\s+(?:about|for|that|which|with|in)\b/i,
];

/** Strip stacked filler prefixes, bounded so a pathological prompt cannot spin. */
function peel(text: string): string {
  let out = text;
  for (let pass = 0; pass < LEADING_NOISE.length * 2; pass += 1) {
    const before = out;
    for (const pattern of LEADING_NOISE) {
      out = out.replace(pattern, "").replace(/^[\s,:;–—-]+/, "");
    }
    if (out === before) break;
  }
  return out;
}

/** Trim to a word boundary rather than mid-word, and mark the cut. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  // Only honour the boundary if it is not so early that the label loses its
  // sense — a single very long word still gets a hard cut.
  const kept = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${kept.replace(/[\s,;:–—-]+$/, "")}…`;
}

/**
 * A display name for a track.
 *
 * The API has no `title` — `catalog.tracks` stores the prompt and nothing that
 * names the piece. Rather than invent a field the backend cannot round-trip,
 * derive a label from the prompt and keep the full text available as a tooltip.
 *
 * The derivation is the whole product here, so it is pinned by track.test.ts:
 * the first clause of a prompt is usually a good name, but only once the
 * instruction wrapper people type around it is taken off the front.
 */
export function trackTitle(track: Pick<TrackSummary, "prompt">): string {
  const prompt = track.prompt.replace(/\s+/g, " ").trim();
  if (!prompt) return "Untitled track";

  // Peel BEFORE splitting into clauses: "e.g." carries a period, so a clause
  // split on the raw prompt would slice the filler itself in half and title the
  // track "E". Peel again after, for filler exposed by the split ("…, a warm…").
  const firstClause = peel(prompt).split(/[,.—–\n]/)[0]?.trim() || prompt;
  let label = peel(firstClause);
  // Reverted if peeling ate everything — a prompt of pure filler still needs
  // a name, and its own words beat "Untitled track".
  if (!label.trim()) label = firstClause;

  label = clip(label.replace(/[\s,;:–—-]+$/, ""), TITLE_MAX_LENGTH);
  if (!label) return "Untitled track";

  // Only the first letter — anything more would flatten "lo-fi" and "EDM".
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * The one-line summary under a card title.
 *
 * Genre and BPM are both nullable, and a track with neither still needs a
 * second line — "Vocal"/"Instrumental" is the one fact every track has.
 */
export function trackSubtitle(
  track: Pick<TrackSummary, "genre" | "bpm" | "vocal">,
): string {
  const parts = [track.genre, track.bpm ? `${track.bpm} BPM` : null].filter(Boolean);
  return parts.length > 0 ? parts.join(" • ") : track.vocal ? "Vocal" : "Instrumental";
}

/** The comma-separated fragments of a prompt, as style chips. */
export function trackTags(track: Pick<TrackSummary, "prompt">, limit = 6): string[] {
  return track.prompt
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, limit);
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return "0:00";
  }
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}

/** "in 3 minutes", "in 2 hours" — for the 429 toast's retry_after_seconds. */
export function humaniseSeconds(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} seconds`;
  if (seconds < 3600) {
    const minutes = Math.round(seconds / 60);
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const hours = Math.round(seconds / 3600);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}
