# Ckpt-1 Demo Spec — RITHM repo (web + gen-proxy)

> **Branch:** `ckpt-1-sync-worker-demo`
> **Goal:** Make the **Generate** (Home / `QuickGenerate`) and **Create** (`/create` / `CreateForm`)
> buttons produce real music from the ACE-Step 1.5 model running on an EC2 box, play it in the
> existing `Player`, **synchronously** (submit → wait → play). Local-only demo.
>
> This document is self-contained: hand it to Claude with the EC2 DNS and you get a working copy.
> The companion doc `Model-api-mod.md` covers the model side (how to launch ACE-Step).

---

## 1. Decisions / constraints

- **Local only** (`npm run dev`); never deployed.
- **Login gate unchanged** — the existing Cognito login flow (`/api/*` → FastAPI on `:8080`) stays
  exactly as-is. Generation does **not** go through the FastAPI.
- **No ACE-Step API key** (`ACESTEP_API_KEY` empty on the model server).
- **No S3.** Audio is streamed back through our proxy.
- **All new logic lives in a standalone Node/TS service** `gen-proxy/` (sibling to `api/`, `web/`,
  `worker/`). The existing repo gets only **tiny** edits: one vite proxy entry + ~3 lines each in
  3 web components + 2 new small web files.
- **Audio format: MP3 by default**, FLAC available via a single env switch.
- **Zero model-side code changes** — the browser never talks to the EC2 directly (only `gen-proxy`
  does), so CORS is not required on the model server.

---

## 2. Architecture

```
Browser (http://localhost:5173)
  │
  ├── /api/*   → vite proxy → http://localhost:8080      (existing FastAPI — Cognito login, UNCHANGED)
  │
  └── /gen/*   → vite proxy → http://localhost:8090      (NEW Node/TS service: gen-proxy/)
                                  │
                                  └── http://<EC2_DNS>:8001   (ACE-Step model API)
                                       POST /release_task → poll POST /query_result → GET /v1/audio
```

- The web app only ever calls `/gen/*` (same-origin via the vite dev proxy → **no browser CORS**).
- `gen-proxy` owns the EC2 DNS, does the async submit+poll **synchronously**, and **streams the
  audio bytes back** so the EC2 stays fully behind the proxy.
- Generation flow is async on ACE-Step's side (`API.md`): `release_task` returns a `task_id`;
  `query_result` is polled until the item's top-level `status == 1` (done) or `2` (failed); each
  result's `file` is a `/v1/audio?path=...` URL. `gen-proxy` hides all of this.

---

## 3. `gen-proxy/` — standalone Node/TS service (NEW)

### 3.1 Layout
```
gen-proxy/
  package.json
  tsconfig.json
  .env.example
  README.md
  src/
    config.ts
    types.ts
    acestep.ts
    server.ts
```

### 3.2 `package.json`
```json
{
  "name": "gen-proxy",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "start": "tsx src/server.ts"
  },
  "dependencies": {
    "dotenv": "^16.4.5",
    "fastify": "^4.28.0"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "tsx": "^4.16.0",
    "typescript": "^5.5.0"
  }
}
```

### 3.3 `tsconfig.json`
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src"]
}
```

### 3.4 `.env.example`
```bash
# The ONLY place the EC2 DNS lives. Put the real value in gen-proxy/.env (gitignored).
ACESTEP_API_BASE=http://<EC2_PUBLIC_DNS>:8001

PORT=8090
AUDIO_FORMAT=mp3            # flip to "flac" for lossless (~10-20 MB/file)
DEFAULT_MODEL=acestep-v15-turbo
THINKING=true              # set false if the EC2 has NO 5Hz LM loaded
INFERENCE_STEPS=8
BATCH_SIZE=1
POLL_INTERVAL_MS=2000
POLL_TIMEOUT_MS=300000
```

### 3.5 `src/config.ts`
```ts
import "dotenv/config";

export const config = {
  acestepApiBase: (process.env.ACESTEP_API_BASE || "http://localhost:8001").replace(/\/$/, ""),
  port: Number(process.env.PORT || 8090),
  audioFormat: process.env.AUDIO_FORMAT || "mp3",
  defaultModel: process.env.DEFAULT_MODEL || "acestep-v15-turbo",
  thinking: (process.env.THINKING ?? "true").toLowerCase() === "true",
  inferenceSteps: Number(process.env.INFERENCE_STEPS || 8),
  batchSize: Number(process.env.BATCH_SIZE || 1),
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 2000),
  pollTimeoutMs: Number(process.env.POLL_TIMEOUT_MS || 300000),
};
```

### 3.6 `src/types.ts`
```ts
/** Normalized request the web app sends to gen-proxy /generate. */
export interface GenerateRequest {
  prompt?: string;
  lyrics?: string;
  vocalLanguage?: string;
  lmTemperature?: number;
  title?: string;           // client-side label only; not forwarded to ACE-Step
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
```

### 3.7 `src/acestep.ts`
```ts
import { config } from "./config.js";
import type {
  AceWrapper, AceResultItem, AceAudio, GenerateRequest, GeneratedTrack,
} from "./types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post<T>(path: string, body: unknown): Promise<AceWrapper<T>> {
  const res = await fetch(`${config.acestepApiBase}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ACE-Step ${path} failed (${res.status}): ${text}`);
  }
  return (await res.json()) as AceWrapper<T>;
}

/** Submit a generation task; returns the ACE-Step task_id. */
export async function releaseTask(req: GenerateRequest): Promise<string> {
  const { title, ...rest } = req; // title is client-only
  const body: Record<string, unknown> = {
    model: config.defaultModel,
    inference_steps: config.inferenceSteps,
    thinking: config.thinking,
    audio_format: config.audioFormat,
    batch_size: config.batchSize,
    prompt: "",
    lyrics: "",
    ...rest,
  };
  // map camelCase → ACE-Step names where needed
  if (req.vocalLanguage) body.vocal_language = req.vocalLanguage;
  if (typeof req.lmTemperature === "number") body.lm_temperature = req.lmTemperature;
  delete (body as any).vocalLanguage;
  delete (body as any).lmTemperature;

  const wrapper = await post<{ task_id: string }>("/release_task", body);
  if (!wrapper.data?.task_id) throw new Error("No task_id in release_task response");
  return wrapper.data.task_id;
}

/** Poll until the task succeeds (status 1) or fails (status 2) / times out. */
export async function pollUntilDone(taskId: string): Promise<AceAudio[]> {
  const deadline = Date.now() + config.pollTimeoutMs;
  while (Date.now() < deadline) {
    const wrapper = await post<AceResultItem[]>("/query_result", { task_id_list: [taskId] });
    const item = wrapper.data?.[0];
    if (item?.status === 1) return JSON.parse(item.result) as AceAudio[];
    if (item?.status === 2) throw new Error(`Generation failed: ${item.result || "unknown error"}`);
    await sleep(config.pollIntervalMs);
  }
  throw new Error(`Generation timed out after ${config.pollTimeoutMs}ms`);
}

/** Convert ACE-Step audios → browser-facing tracks (audio routed back through /gen/audio). */
export function toTracks(audios: AceAudio[]): GeneratedTrack[] {
  return audios.map((a, i) => ({
    id: `${Date.now()}-${i}`,
    title: a.prompt?.slice(0, 40) || `Track ${i + 1}`,
    lyrics: (a.lyrics || "").split("\n").map((l) => l.trim()).filter(Boolean),
    audioUrl: `/gen/audio?path=${encodeURIComponent(extractPath(a.file))}`,
    prompt: a.prompt || "",
    seed: a.seed_value ?? null,
    durationSeconds: a.metas?.duration ?? null,
  }));
}

/** The result `file` is "/v1/audio?path=<X>"; we only need <X> to re-issue via our /audio route. */
function extractPath(file: string): string {
  try {
    const u = new URL(file, config.acestepApiBase);
    return u.searchParams.get("path") || file;
  } catch {
    const m = file.match(/[?&]path=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : file;
  }
}

/** Fetch the audio bytes from the EC2 (forwarding Range for seeking). */
export async function fetchAudio(path: string, range?: string): Promise<Response> {
  const url = `${config.acestepApiBase}/v1/audio?path=${encodeURIComponent(path)}`;
  const headers: Record<string, string> = {};
  if (range) headers.Range = range;
  return fetch(url, { headers });
}
```

### 3.8 `src/server.ts`
```ts
import Fastify from "fastify";
import { config } from "./config.js";
import { releaseTask, pollUntilDone, toTracks, fetchAudio } from "./acestep.js";
import type { GenerateRequest } from "./types.js";

const app = Fastify({ logger: true, bodyLimit: 2 * 1024 * 1024 });

app.get("/health", async () => {
  let upstream = "unknown";
  try {
    const r = await fetch(`${config.acestepApiBase}/health`);
    upstream = r.ok ? "ok" : `error ${r.status}`;
  } catch {
    upstream = "unreachable";
  }
  return { status: "ok", upstream, acestepApiBase: config.acestepApiBase };
});

// Synchronous: blocks until the track is ready (or fails / times out).
app.post("/generate", async (req, reply) => {
  const body = (req.body || {}) as GenerateRequest;
  try {
    const taskId = await releaseTask(body);
    const audios = await pollUntilDone(taskId);
    return { tracks: toTracks(audios) };
  } catch (e) {
    req.log.error(e);
    reply.code(502);
    return { error: (e as Error).message };
  }
});

// Audio passthrough — what the browser <audio> element hits (via /gen/audio).
app.get("/audio", async (req, reply) => {
  const path = (req.query as { path?: string }).path;
  if (!path) { reply.code(400); return { error: "missing path" }; }

  const range = req.headers["range"] as string | undefined;
  const upstream = await fetchAudio(path, range);

  reply.code(upstream.status); // 200 or 206 for range
  for (const h of ["content-type", "content-length", "accept-ranges", "content-range"]) {
    const v = upstream.headers.get(h);
    if (v) reply.header(h, v);
  }
  const buf = Buffer.from(await upstream.arrayBuffer());
  return reply.send(buf);
});

app.listen({ port: config.port, host: "0.0.0.0" })
  .then(() => app.log.info(`gen-proxy on :${config.port} → ${config.acestepApiBase}`));
```

> Buffering the whole file (`arrayBuffer`) is fine for a demo (MP3 a few MB; FLAC ~10–20 MB). The
> forwarded `Range` header + passthrough of `content-range`/`accept-ranges` gives basic seeking.

### 3.9 `gen-proxy/README.md` (summary)
```
cp .env.example .env   # set ACESTEP_API_BASE to the EC2 DNS
npm install
npm run dev            # listens on :8090
# smoke test:
curl localhost:8090/health
curl -X POST localhost:8090/generate -H 'Content-Type: application/json' -d '{"prompt":"upbeat lo-fi"}'
```

---

## 4. `web/` — minimal edits

### 4.1 `web/vite.config.ts` — add the `/gen` proxy (long timeout for the blocking call)
```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8080",
      "/gen": {
        target: "http://localhost:8090",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/gen/, ""),
        timeout: 600000,
        proxyTimeout: 600000,
      },
    },
  },
});
```

### 4.2 `web/src/services/musicgen.ts` — NEW (thin client; NOT `apiFetch`)
> Deliberately separate from `lib/api.ts`: we must **not** attach the Cognito Bearer token to the
> proxy, and must **not** clear the session if the proxy returns a 502.
```ts
export interface GeneratedTrack {
  id: string;
  title: string;
  lyrics: string[];
  audioUrl: string;
  prompt: string;
  seed: string | null;
  durationSeconds: number | null;
}

export interface GenerateParams {
  prompt?: string;
  lyrics?: string;
  vocalLanguage?: string;
  lmTemperature?: number;
  title?: string;
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
```

### 4.3 `web/src/store/generation.ts` — NEW (shared Zustand store)
```ts
import { create } from "zustand";
import { generate, type GenerateParams, type GeneratedTrack } from "../services/musicgen";

type GenStatus = "idle" | "generating" | "done" | "error";

interface GenerationState {
  status: GenStatus;
  tracks: GeneratedTrack[];
  current: GeneratedTrack | null;
  error: string | null;
  start: (params: GenerateParams) => Promise<void>;
  reset: () => void;
}

export const useGeneration = create<GenerationState>((set) => ({
  status: "idle",
  tracks: [],
  current: null,
  error: null,
  start: async (params) => {
    set({ status: "generating", error: null });
    try {
      const tracks = await generate(params);
      set({ status: "done", tracks, current: tracks[0] ?? null });
    } catch (e) {
      set({ status: "error", error: (e as Error).message });
    }
  },
  reset: () => set({ status: "idle", tracks: [], current: null, error: null }),
}));
```

### 4.4 `web/src/components/QuickGenerate.tsx` — wire Generate (small edit)
- Import the store: `import { useGeneration } from "../store/generation";`
- Inside the component: `const { start, status, error } = useGeneration();`
- Build params and call `start` on click; replace the placeholder `setNote(true)`:
```tsx
const busy = status === "generating";

function onGenerate() {
  const lyrics =
    lyric.kind === "custom" ? customLyric
    : lyric.kind === "preview" ? lyric.excerpt
    : "";
  void start({ prompt: prompt.trim(), lyrics });
}
// ...
<button type="button" disabled={!canGenerate || busy} onClick={onGenerate} className="...">
  <Sparkles className="h-4 w-4" strokeWidth={2} />
  {busy ? "Generating…" : "Generate"}
</button>
{error && <span className="text-[12.5px] text-red-300">{error}</span>}
```
(Drop the old `note` placeholder text once wired.)

### 4.5 `web/src/components/create/CreateForm.tsx` — wire Create (small edit)
- Import + `const { start, status, error } = useGeneration();`
- Build the prompt/lyrics from the form per the mapping table, call `start` on the Create button.
  Leave the decorative Audio/Voice/Inspo/Save-to buttons as-is.
```tsx
const busy = status === "generating";

function onCreate() {
  const promptParts = [styles, ...genres];
  if (lyricTab === "prompt" && lyricPrompt.trim()) promptParts.push(lyricPrompt.trim());
  if (advanced) promptParts.push(`${vocalGender} vocals`);
  const lyrics =
    lyricTab === "write" ? lyrics
    : lyricTab === "instrumental" ? "[instrumental]"
    : ""; // "prompt" → let the LM draft lyrics (thinking=true)
  void start({
    prompt: promptParts.filter(Boolean).join(", "),
    lyrics,
    title: title || undefined,
    ...(advanced ? { lmTemperature: 0.5 + (weirdness / 100) * 0.7 } : {}),
  });
}
// ...
<button type="button" onClick={onCreate} disabled={busy} className="...">
  {busy ? "Creating…" : "Create"}
</button>
{error && <span className="text-[12.5px] text-red-300">{error}</span>}
```
> Note: the local `lyrics` state variable shadows the param key — rename the local computed value
> (e.g. `lyricsValue`) when applying, to avoid the name clash shown above.

### 4.6 `web/src/components/Player.tsx` — real playback (minimal)
- Read the current track: `const current = useGeneration((s) => s.current);`
- Add a hidden audio element and a ref:
```tsx
const audioRef = useRef<HTMLAudioElement>(null);
const [progress, setProgress] = useState(0);
const [dur, setDur] = useState(0);
const [cur, setCur] = useState(0);

const track = current ?? null; // when null, keep the existing static TRACK mock UI

useEffect(() => {
  const el = audioRef.current;
  if (!el) return;
  const onTime = () => { setCur(el.currentTime); setProgress(el.duration ? el.currentTime / el.duration : 0); };
  const onMeta = () => setDur(el.duration || 0);
  el.addEventListener("timeupdate", onTime);
  el.addEventListener("loadedmetadata", onMeta);
  return () => { el.removeEventListener("timeupdate", onTime); el.removeEventListener("loadedmetadata", onMeta); };
}, [track?.audioUrl]);

useEffect(() => {
  const el = audioRef.current;
  if (el) el.playbackRate = SPEEDS[speedIdx];
}, [speedIdx]);

function toggle() {
  const el = audioRef.current; if (!el) return;
  if (playing) el.pause(); else void el.play();
  setPlaying((p) => !p);
}
// render: <audio ref={audioRef} src={track?.audioUrl} preload="metadata" />
//   use track.title / track.lyrics / fmt(cur) / fmt(dur) / progress when track exists,
//   otherwise fall back to the existing TRACK.* mock values.
```
- Helper `fmt(seconds)` → `m:ss`. Wire the existing play/pause buttons to `toggle()` and the
  progress bar width to `progress`.

No changes to `api/`, `worker/`, the DB, or any infra.

---

## 5. Parameter mapping (UI → `/gen/generate` → `release_task`)

`gen-proxy` injects: `model`, `inference_steps`, `thinking`, `audio_format` (mp3), `batch_size`.

| UI field | ACE-Step param | Notes |
| --- | --- | --- |
| QuickGenerate `prompt` | `prompt` | music description |
| QuickGenerate custom/preview lyric | `lyrics` | empty when "none" |
| CreateForm `styles` + `genres[]` | `prompt` | `[styles, ...genres].join(", ")` |
| CreateForm `lyrics` (Write tab) | `lyrics` | |
| CreateForm `lyricPrompt` (Prompt tab) | appended to `prompt`; `lyrics` empty + `thinking:true` lets the LM draft lyrics | |
| CreateForm Instrumental tab | `lyrics: "[instrumental]"` | |
| CreateForm `vocalGender` | folded into `prompt` text ("male/female vocals") | no native field |
| CreateForm `weirdness` (0–100) | `lm_temperature` (≈0.5–1.2) | advanced only |
| CreateForm `styleInfluence` | (unused) | turbo ignores `guidance_scale` |
| CreateForm `title` | — (client-side label) | not forwarded |

`thinking:true` requires the 5Hz LM on the EC2. If absent, set `THINKING=false` in `gen-proxy/.env`.

---

## 6. Run order (local demo)

1. **EC2**: ACE-Step API up on `:8001` (see `Model-api-mod.md`).
2. **gen-proxy**: `cd gen-proxy && cp .env.example .env` → set `ACESTEP_API_BASE` → `npm i && npm run dev`.
3. **API stack** (for login only): `docker compose up` (Postgres + FastAPI on `:8080`), as today.
4. **web**: `cd web && npm run dev` → open `http://localhost:5173`, log in.
5. Home → enter prompt → **Generate**; or `/create` → fill form → **Create**. The `Player` plays it.

---

## 7. Verification

- `curl http://<EC2_DNS>:8001/health` → ok; `/v1/models` lists `acestep-v15-turbo`.
- `curl localhost:8090/health` → `{status:"ok", upstream:"ok"}`.
- `curl -X POST localhost:8090/generate -d '{"prompt":"upbeat lo-fi"}' -H 'Content-Type: application/json'`
  → `{ tracks:[{ audioUrl, ... }] }`; `curl "localhost:8090/audio?path=..." -o out.mp3` plays.
- In the browser, the Network tab shows only `/gen/generate` and `<audio src="/gen/audio?...">`
  (same-origin, 200/206). No request goes to the EC2 DNS from the browser.
- Failure path: stop the model → proxy returns 502 `{error}` → button shows a readable message.

---

## 8. Known limitations (acceptable for the demo)

- Works under the **vite dev proxy only** (not a deployed build).
- `/generate` is a **single blocking call** — no progress %; vite/proxy timeouts are raised to 10 min.
- **`batch_size=1`** by default (one track per click); raise `BATCH_SIZE` to return variations
  (the store already keeps `tracks[]`; the Player would need a small next/prev wiring to switch).
- Whole-file buffering in `/audio` (fine at demo sizes; FLAC ~10–20 MB).
- `thinking=true` depends on the EC2 having the 5Hz LM loaded.
