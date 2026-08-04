import type { TrackSummary } from "../types/api";

/**
 * A display name for a track.
 *
 * The API has no `title` — `catalog.tracks` stores the prompt and nothing that
 * names the piece. Rather than invent a field the backend cannot round-trip,
 * derive a label from the prompt and keep the full text available as a tooltip.
 */
export function trackTitle(track: Pick<TrackSummary, "prompt">): string {
  const prompt = track.prompt.trim();
  if (!prompt) return "Untitled track";
  const firstClause = prompt.split(/[,.—–\n]/)[0]?.trim() || prompt;
  const label = firstClause.length > 48 ? `${firstClause.slice(0, 45)}…` : firstClause;
  return label.charAt(0).toUpperCase() + label.slice(1);
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
