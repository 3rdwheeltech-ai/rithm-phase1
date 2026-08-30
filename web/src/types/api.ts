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
/** Bounded well under the VARCHAR(120) column, so a title never fails an INSERT. */
export const TITLE_MAX_LENGTH = 80;
/** A brief, not a draft. The draft is what `write` mode is for. */
export const LYRICS_PROMPT_MAX_LENGTH = 600;

/**
 * Where the words come from — and only that. It does not decide whether the
 * server asks a model: `vocal && lyrics === null` is what does, in both
 * "write" and "prompt". All this says is whether `lyrics_prompt` is honoured.
 *
 * Must AGREE with `vocal`: "instrumental" means vocal=false and nothing else
 * does. The API 422s every other pairing.
 */
export type LyricsMode = "write" | "prompt" | "instrumental";

/**
 * The requested lead vocal. A caption hint the worker folds into ACE-Step's
 * conditioning — there is no gender parameter, so it is never a guarantee.
 */
export type Voice = "auto" | "female" | "male";

export interface GenerateRequest {
  prompt: string;
  /** Null to let the server name it. Blank strings are normalised to null. */
  title?: string | null;
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
   *
   * Belongs to lyrics_mode "write". Sending it in "prompt" mode is a 422.
   */
  lyrics?: string | null;
  lyrics_mode: LyricsMode;
  /**
   * What the song should be ABOUT, in prose. Belongs to lyrics_mode "prompt";
   * sending it in "write" mode is a 422. Exactly one of this and `lyrics` is
   * ever non-null, and `lyrics_mode` says which.
   */
  lyrics_prompt?: string | null;
  voice: Voice;
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
  /**
   * The track's name. NULL on every track created before the column existed —
   * which is most of them — so `trackTitle()` keeps its prompt derivation as
   * the floor under this rather than as legacy.
   */
  title: string | null;
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
  /**
   * The words the track was generated FROM, not a transcript. Null for an
   * instrumental, and null for a vocal track whose lyrics the model wrote
   * itself. Detail-only — TrackSummary does not carry it.
   */
  lyrics: string | null;
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

// ── Chat assistant ─────────────────────────────────────────────────────────

/**
 * What the conversation has collected so far. Every field optional — the point
 * of the chat is that it fills in over several turns.
 *
 * Every bound on the server's copy (`api/app/modules/conversation/schemas.py`)
 * is the matching bound in `GenerateRequest`, and the server clamps on write.
 * That is what makes `draftToCreateState` a straight mapping rather than a
 * second round of validation: a draft that arrived here cannot 422 at
 * `POST /tracks/generate`, and a 422 after a handoff means those bounds have
 * drifted apart.
 */
export interface SongDraft {
  prompt: string | null;
  title: string | null;
  genre: Genre | null;
  mood: Mood | null;
  instruments: string[];
  length_seconds: number | null;
  bpm_min: number | null;
  bpm_max: number | null;
  lyrics_mode: LyricsMode | null;
  voice: Voice | null;
  lyrics: string | null;
  lyrics_prompt: string | null;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

export interface ChatTurnResponse {
  message: ChatMessage;
  draft: SongDraft;
  /** Derived server-side from the merged draft, never from a model's own flag. */
  ready: boolean;
  /** One-tap answers to whatever was just asked. Chips, not the whole menu. */
  suggestions: string[];
}

export interface ChatSessionResponse {
  /** Null when the user has never sent a message — a bare GET creates nothing. */
  session_id: string | null;
  messages: ChatMessage[];
  draft: SongDraft;
  ready: boolean;
  /**
   * Whether this deployment has a voice avatar at all.
   *
   * It rides on THIS response rather than being probed, because asking the
   * token route would mint a credential and claim the product's one global
   * Anam slot to answer a yes/no question. This query is already fetched on
   * Home mount with `staleTime: Infinity`, so discovery costs no request.
   *
   * Optional on the wire for the deploy window: an API that predates voice
   * omits it, and `false` is the correct reading of that.
   */
  voice_available?: boolean;
}

/** What one chat turn may carry. Mirrors CHAT_MESSAGE_MAX_LENGTH on the server. */
export const CHAT_MESSAGE_MAX_LENGTH = 1000;

/**
 * The two problem types the chat panel handles ITSELF, as muted inline rows,
 * rather than letting them surface as an ErrorToast over a chat that is
 * otherwise perfectly usable.
 *
 * 503: no model would answer this turn. The message is already persisted, so
 * the fix is a retry.
 * 409: this conversation is over its length cap. Nothing is rate-limited and
 * waiting will not help — the fix is "Start over", which is a different
 * control from a Retry-After the user cannot act on.
 */
export const ASSISTANT_UNAVAILABLE_TYPE = "https://rithm.dev/errors/assistant-unavailable";
export const CHAT_SESSION_FULL_TYPE = "https://rithm.dev/errors/chat-session-full";

/**
 * The four voice problem types, and they are four rather than one because the
 * panel says something different for each.
 *
 * 501 NOT-CONFIGURED is the one that matters most: it means voice was never
 * here, and the panel must be bit-for-bit what ships today — the Lottie, the
 * streaming prompt, and Talk opening the Coming Soon dialog. The other three
 * mean voice exists and this attempt failed, which names a reason and keeps
 * Talk a live control.
 *
 * 429 AT-CAPACITY is the ordinary second-user path on the free tier, not an
 * incident: someone else in the product is talking, and `retry_after_seconds`
 * on the body is a real number computed from a live lease.
 */
export const VOICE_NOT_CONFIGURED_TYPE = "https://rithm.dev/errors/voice-not-configured";
export const VOICE_AT_CAPACITY_TYPE = "https://rithm.dev/errors/voice-at-capacity";
export const VOICE_QUOTA_EXCEEDED_TYPE = "https://rithm.dev/errors/voice-quota-exceeded";
export const VOICE_UNAVAILABLE_TYPE = "https://rithm.dev/errors/voice-unavailable";

/** POST /chat/voice/session. Never cached, never logged — see the server's copy. */
export interface VoiceSessionResponse {
  session_token: string;
  /** The countdown runs off THIS, never off a hardcoded 180. */
  expires_in_seconds: number;
  /** Proves ownership of the slot on DELETE, so a stale tab cannot free it. */
  lease_id: string;
}
