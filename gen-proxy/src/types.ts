/** Normalized request the web app sends to gen-proxy /generate. */
export interface GenerateRequest {
  prompt?: string;
  lyrics?: string;
  vocalLanguage?: string;
  lmTemperature?: number;
  title?: string;           // client-side label only; not forwarded to ACE-Step
  // Advanced (Create) — optional; mapped to ACE-Step snake_case in releaseTask().
  thinking?: boolean;
  audioDuration?: number;
  bpm?: number;
  keyScale?: string;
  timeSignature?: string;
  useRandomSeed?: boolean;
  seed?: number;
  [k: string]: unknown;     // allow extra passthrough fields
}

/** What gen-proxy returns to the web app. */
export interface GeneratedTrack {
  id: string;
  title: string;
  lyrics: string[];
  audioUrl: string;         // "/gen/audio?path=..." (browser-facing)
  prompt: string;
  seed: string | null;
  durationSeconds: number | null;
}

/** ACE-Step unified response wrapper (API.md §2). */
export interface AceWrapper<T> {
  data: T;
  code: number;
  error: string | null;
  timestamp: number;
  extra: unknown;
}

/** One item from /query_result data[] (API.md §5.3). */
export interface AceResultItem {
  task_id: string;
  status: number;           // 0 queued/running, 1 success, 2 failed
  result: string;           // JSON string -> AceAudio[]
}

/** One element of the parsed `result` array. */
export interface AceAudio {
  file: string;             // "/v1/audio?path=..."
  lyrics?: string;
  prompt?: string;
  metas?: { duration?: number; [k: string]: unknown };
  seed_value?: string;
  [k: string]: unknown;
}
