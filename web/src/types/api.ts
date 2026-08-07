/**
 * Wire types for the RITHM API. Mirrors what Day 3 actually shipped.
 *
 * GENRES and MOODS are duplicated across the tree boundary — the other copy is
 * `api/app/modules/generation/schemas.py` (Genre / Mood StrEnums), which is in
 * turn pinned against `catalog/models.py` by
 * `test_genres_and_moods_match_the_catalog_vocabulary`. There is no cheap way
 * to share a vocabulary across Python and TypeScript in Phase 1 and a
 * `/vocabulary` endpoint is not worth a round trip, so `types/api.test.ts`
 * pins this copy to the literal launch-plan §A6 list instead. Three pinned
 * copies fail loudly; two unpinned copies drift silently.
 */

export const GENRES = [
  "Pop",
  "Hip-Hop",
  "EDM",
  "Lo-Fi",
  "Cinematic",
  "Rock",
  "Country",
  "R&B",
  "Ambient",
] as const;

export const MOODS = [
  "Happy",
  "Calm",
  "Energetic",
  "Dark",
  "Romantic",
  "Inspirational",
  "Dramatic",
] as const;

export type Genre = (typeof GENRES)[number];
export type Mood = (typeof MOODS)[number];

/** Server-side bounds, mirrored so the UI can never submit a 422. */
export const LENGTH_MIN_SECONDS = 10;
export const LENGTH_MAX_SECONDS = 180;
export const BPM_MIN = 20;
export const BPM_MAX = 300;
export const MAX_INSTRUMENTS = 10;
export const PROMPT_MAX_LENGTH = 2000;
export const LYRICS_MAX_LENGTH = 3000;
export const DELTA_COMMAND_MAX_LENGTH = 500;

export interface GenerateRequest {
  prompt: string;
  genre?: Genre | null;
  mood?: Mood | null;
  bpm_min?: number | null;
  bpm_max?: number | null;
  instruments: string[];
  vocal: boolean;
  length_seconds: number;
  /**
   * The user's own words, or null to let the model write them. Must be null
   * when `vocal` is false — the API returns a 422 for that pair, because
   * ACE-Step expresses "instrumental" through this same field.
   */
  lyrics?: string | null;
}

export type RefinementMode = "fresh" | "audio_reference";

export interface RefineRequest {
  delta_command: string;
  refinement_mode: RefinementMode;
}

export interface JobAccepted {
  job_id: string;
  status: "QUEUED";
  /** RELATIVE, and it already carries the SSE token. Use it verbatim. */
  sse_url: string;
  created_at: string;
}

export type JobStatusValue = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "DEAD_LETTERED";

export interface JobStatus {
  job_id: string;
  status: JobStatusValue;
  kind: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  track_id: string | null;
  /** Presigned, 15-minute TTL. Only present once the job is COMPLETED. */
  mp3_url: string | null;
}

export interface TrackSummary {
  id: string;
  prompt: string;
  genre: Genre | null;
  mood: Mood | null;
  bpm: number | null;
  vocal: boolean;
  length_seconds: number;
  /** Presigned, 15-MINUTE TTL. Do not sign, decorate or cache-bust it. */
  mp3_url: string;
  created_at: string;
}

export type PromptHistoryKind = "initial" | "refine_fresh" | "refine_audio" | "remix" | "variation";

export interface PromptHistoryEntry {
  id: string;
  prompt: string;
  delta_command: string | null;
  kind: PromptHistoryKind;
  created_at: string;
}

export interface TrackDetail extends TrackSummary {
  /** Presigned, 15-MINUTE TTL. */
  wav_url: string;
  waveform_hash: string;
  prompt_history: PromptHistoryEntry[];
}

// ── SSE frame payloads ─────────────────────────────────────────────────────

export interface QueuedEvent {
  job_id: string;
  queue_position?: number;
  estimated_start_seconds?: number;
}

export interface RunningEvent {
  job_id: string;
  started_at?: string;
  estimated_seconds_remaining?: number;
}

export interface CompletedEvent {
  job_id: string;
  /** Absent on the reconnect REPLAY frame — see useJobStream. */
  track_id?: string;
  mp3_url?: string;
}

export interface FailedEvent {
  job_id: string;
  error?: string;
}
