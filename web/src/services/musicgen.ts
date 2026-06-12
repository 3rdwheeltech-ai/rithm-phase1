// Thin client for the gen-proxy music generation service (via the /gen vite proxy).
//
// Deliberately separate from lib/api.ts: we must NOT attach the Cognito Bearer token
// to the proxy, and must NOT clear the auth session if the proxy returns a 502.

export interface GeneratedTrack {
  id: string;
  title: string;
  lyrics: string[];
  audioUrl: string;
  prompt: string;
  seed: string | null;
  durationSeconds: number | null;
  liked?: boolean;
}

export interface GenerateParams {
  prompt?: string;
  lyrics?: string;
  vocalLanguage?: string;
  lmTemperature?: number;
  title?: string;
  // Advanced (Create) — all optional; omit to accept the server/LM default.
  thinking?: boolean;
  audioDuration?: number;   // seconds
  bpm?: number;
  keyScale?: string;
  timeSignature?: string;
  useRandomSeed?: boolean;
  seed?: number;
}

export async function generate(params: GenerateParams): Promise<GeneratedTrack[]> {
  const res = await fetch("/gen/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = (await res.json().catch(() => ({}))) as { tracks?: GeneratedTrack[]; error?: string };
  if (!res.ok) throw new Error(data.error || `Generation failed (${res.status})`);
  const tracks = data.tracks ?? [];
  if (params.title && tracks[0]) tracks[0].title = params.title; // client-side label override
  return tracks;
}
