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

  // Map RITHM's camelCase fields → ACE-Step snake_case names, then strip the
  // camelCase keys so no unknown fields reach the model. `thinking`, `bpm`, `seed`
  // already match ACE-Step's names and pass through `...rest` (a client-sent
  // `thinking` intentionally overrides the env default).
  const camelToSnake: Record<string, string> = {
    vocalLanguage: "vocal_language",
    lmTemperature: "lm_temperature",
    audioDuration: "audio_duration",
    keyScale: "key_scale",
    timeSignature: "time_signature",
    useRandomSeed: "use_random_seed",
  };
  for (const [camel, snake] of Object.entries(camelToSnake)) {
    if (body[camel] !== undefined) body[snake] = body[camel];
    delete body[camel];
  }

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
