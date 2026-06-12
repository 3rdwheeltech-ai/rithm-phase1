# ACE-Step API — Contract for RITHM

> **Purpose.** This is the API contract RITHM builds against. It tells `gen-proxy` how to call the
> ACE-Step server **correctly, with valid data**, and it maps every RITHM UI control (toggles like
> *thinking*, advanced settings like *BPM / inference steps / seed*) to the exact request field that
> drives it. Pair it with [`required-api-spec.md`](./required-api-spec.md) (how the server is
> launched) and [`platform-context.md`](./platform-context.md) (who calls whom). Defaults and field
> names here are taken from the live server schema (`GenerateMusicRequest`) and verified end-to-end
> on the demo box.

- **Base URL:** `http://<EC2_DNS>:8001`
- **Auth:** none (server launched with the key unset). Send **no** `Authorization` header, **no**
  `ai_token`.
- **Content-Type:** `application/json` for all calls below.
- **Async model:** submit → poll → download. Generation is **not** synchronous in one call.

---

## 1. The flow (3 calls + 2 probes)

```
POST /release_task     ──▶  { task_id }                 # submit, returns immediately
POST /query_result     ──▶  status 0→1 (poll every 2s)  # 0=running, 1=done, 2=failed
GET  /v1/audio?path=…  ──▶  audio bytes                 # download the file from the result

GET  /health      # liveness + which models are loaded
GET  /v1/models   # confirm the DiT model name
```

A track is ready when `query_result` returns `status: 1`; the audio URL is inside the parsed
`result`. On `status: 2` the `result`/error string is the failure reason to show the user.

---

## 2. `POST /release_task` — submit a generation

Returns a `task_id` immediately. Minimal valid body:

```json
{ "prompt": "dreamy lo-fi with warm piano, male vocals" }
```

Full body RITHM typically sends (every field optional except you want *some* prompt/lyrics/query):

```json
{
  "model": "acestep-v15-turbo",
  "prompt": "dreamy lo-fi with warm piano, male vocals",
  "lyrics": "",
  "thinking": true,
  "audio_format": "mp3",
  "audio_duration": 120,
  "batch_size": 1,
  "inference_steps": 8,
  "vocal_language": "en",
  "bpm": 90,
  "key_scale": "C Major",
  "time_signature": "4",
  "lm_temperature": 0.85
}
```

### Response

```json
{
  "data": { "task_id": "238e20df-…", "status": "queued", "queue_position": 1 },
  "code": 200, "error": null, "timestamp": 1781080963587, "extra": null
}
```

RITHM reads exactly one field: **`data.task_id`**. (`data.status` here is the human string
`"queued"` — do **not** confuse it with the integer status from `/query_result`.)

---

## 3. UI controls → request fields (the toggle map)

This is the table to build the RITHM form against. **Default** = server default if the field is
omitted. Omit a field to accept its default; send it to override.

### 3.1 Core inputs

| UI control | Field | Type | Default | Notes |
| --- | --- | --- | --- | --- |
| Prompt / description box | `prompt` | string | `""` | Free-text style/caption. Alias: `caption`. |
| Lyrics box | `lyrics` | string | `""` | See **lyric modes** below. |
| Output format | `audio_format` | string | `"mp3"` | `mp3`, `flac`, `wav`, `wav32`, `aac`. **Use `mp3` or `flac`** (see §7). |
| Language | `vocal_language` | string | `"en"` | `en`, `zh`, `ja`, … drives lyric pronunciation. |
| Number of variations | `batch_size` | int | `1`* | 1–4 on this box. Each adds time + VRAM; keep `1` for the demo. |
| Target model | `model` | string | server default | `"acestep-v15-turbo"`. Confirm via `/v1/models`. |

\* The schema default is `2`, but RITHM should send `batch_size: 1` for the one-click demo.

### 3.2 The **Thinking** toggle (the headline switch)

| UI toggle | Field | Default | Effect |
| --- | --- | --- | --- |
| **Thinking** ON | `thinking: true` | — | 5Hz LM generates audio codes (lm-dit) for higher quality, **and** drafts lyrics when the lyric box is empty, **and** fills any missing metadata (BPM/key/time-sig/duration). This is RITHM's default. |
| **Thinking** OFF | `thinking: false` | `false` | Pure `text2music`: DiT uses your caption/lyrics as-is, no LM. Faster, no LM VRAM. Use this if the LM isn't loaded. |

> The server schema default is `thinking:false`; **RITHM should send `thinking:true` explicitly**
> for the LM-enhanced experience. With `thinking:false`, leave lyrics empty only if you want an
> instrumental — the LM won't draft them.

### 3.3 Lyric modes (how the lyrics box behaves)

| Mode | What RITHM sends | Result |
| --- | --- | --- |
| **Write my own** | `lyrics: "<user text>"` | Sung verbatim. Use `[Verse]`, `[Chorus]`, `[Bridge]` section tags. |
| **Instrumental** | `lyrics: "[instrumental]"` | No vocals. |
| **Let AI write (Prompt mode)** | `lyrics: ""` + `thinking: true` | The 5Hz LM drafts lyrics from the prompt. The drafted lyrics come back in the result's `lyrics` field. |
| **Describe a song** | `sample_query: "a soft Bengali love song"` + `thinking: true` | LM auto-generates caption + lyrics + metadata from a one-line description. (`sample_mode` is implied; aliases for the query: `description`, `desc`.) |
| **Enhance my draft** | `prompt`/`lyrics` set + `use_format: true` + `thinking: true` | LM cleans up / formats your caption & lyrics before generating. |

### 3.4 Advanced — musical attributes (all optional; LM fills blanks when `thinking:true`)

| UI control | Field | Type | Default | Range / values |
| --- | --- | --- | --- | --- |
| BPM / tempo | `bpm` | int | `null` (LM/auto) | 30–300 |
| Key & scale | `key_scale` | string | `""` | e.g. `"C Major"`, `"Am"`, `"E minor"`. Aliases: `keyscale`, `keyScale`. |
| Time signature | `time_signature` | string | `""` | `"2"`, `"3"`, `"4"`, `"6"` (= 2/4, 3/4, 4/4, 6/8). Aliases: `timesignature`, `timeSignature`. |
| Duration (seconds) | `audio_duration` | float | `null` (LM/auto) | 10–600. Aliases: `duration`, `target_duration`. **Longer = slower** (see §6). |

User-provided values always win; the LM only fills fields you leave empty/null.

### 3.5 Advanced — diffusion / quality controls

| UI control | Field | Type | Default | Notes |
| --- | --- | --- | --- | --- |
| Inference steps | `inference_steps` | int | `8` | **Turbo: 1–20 (use 8).** More steps ≠ better on turbo; 8 is the sweet spot. (Base model: 32–64.) |
| Seed lock | `use_random_seed` | bool | `true` | `false` to reproduce a previous result. |
| Seed value | `seed` | int | `-1` | Used only when `use_random_seed:false`. The result echoes `seed_value`. |
| Guidance scale | `guidance_scale` | float | `7.0` | **Base model only** — ignored by turbo (turbo forces 1.0). Don't expose for the turbo demo. |
| Inference method | `infer_method` | string | `"ode"` | `"ode"` (faster) or `"sde"`. |
| Custom timesteps | `timesteps` | string | `null` | Comma-separated, e.g. `"0.97,0.76,…,0"`. Overrides `inference_steps`+`shift`. Power-user only. |

### 3.6 Advanced — 5Hz LM sampling (only relevant when `thinking:true`)

| UI control | Field | Type | Default | Notes |
| --- | --- | --- | --- | --- |
| LM creativity (temp) | `lm_temperature` | float | `0.85` | Higher = more varied/risky. |
| LM guidance | `lm_cfg_scale` | float | `2.5` | >1 enables CFG; how strongly the LM follows the prompt. |
| LM top-p | `lm_top_p` | float | `0.9` | Nucleus sampling. |
| LM top-k | `lm_top_k` | int | `null` | `null`/0 disables. |
| LM repetition penalty | `lm_repetition_penalty` | float | `1.0` | Raise to reduce repeated lines. |
| CoT: rewrite caption | `use_cot_caption` | bool | `true` | LM enhances the caption via reasoning. |
| CoT: detect language | `use_cot_language` | bool | `true` | LM auto-detects vocal language. |

> Server-launch-controlled (RITHM does **not** send these): `lm_model_path`, `lm_backend`. On the
> demo box these are fixed at launch (`acestep-5Hz-lm-1.7B`, `pt`). See `required-api-spec.md`.

### 3.7 Editing tasks (future RITHM features — not needed for one-click generate)

`task_type` (`text2music` default, plus `cover`, `repaint`, `lego`, `extract`, `complete`),
`reference_audio_path`, `src_audio_path`, `repainting_start/end`, `audio_cover_strength`. These
require an audio file already on the server (or multipart upload). Out of scope for Ckpt-1.

---

## 4. `POST /query_result` — poll for status & result

Request:

```json
{ "task_id_list": ["238e20df-…"] }
```

Response (running):

```json
{ "data": [ { "task_id": "238e20df-…", "status": 0, "result": null } ],
  "code": 200, "error": null, … }
```

Response (done — `result` is a **JSON string**, parse it):

```json
{ "data": [ {
    "task_id": "238e20df-…",
    "status": 1,
    "result": "[{\"file\": \"/v1/audio?path=…\", \"status\": 1, \"prompt\": \"…\", \"lyrics\": \"…\", \"metas\": {\"bpm\": 125, \"duration\": 120.0, \"keyscale\": \"F major\", \"timesignature\": \"4\"}, \"seed_value\": \"4173934271\", \"lm_model\": \"acestep-5Hz-lm-1.7B\", \"dit_model\": \"acestep-v15-turbo\"}]"
} ], "code": 200, "error": null, … }
```

**Contract RITHM relies on:**

| What | Where | Type | Rule |
| --- | --- | --- | --- |
| Job status | `data[0].status` | **int** | `0` running · `1` success · `2` failed. Compare `=== 1` / `=== 2`. |
| Result payload | `data[0].result` | **JSON string** | `JSON.parse` → **array** (one element per `batch_size`). |
| Audio URL | `result[i].file` | string | Pass the `path=` value to `/v1/audio`. |
| Final lyrics | `result[i].lyrics` | string | LM-drafted lyrics land here (Prompt mode). |
| Final caption | `result[i].prompt` | string | |
| Duration | `result[i].metas.duration` | number | Plus `bpm`, `keyscale`, `timesignature`, `genres`. |
| Seed | `result[i].seed_value` | string | Comma-separated if `batch_size>1`. Reuse to reproduce. |

**Polling:** every **2 s**, timeout **5 min** (both configurable on the RITHM side). On a long song
the first request also warms the models — raise the timeout if you allow long durations (see §6).

---

## 5. `GET /v1/audio?path=…` — download / stream

Take the `path=` value from `result[i].file` and request it here. Forward the browser's `Range`
header for seeking; the server returns:

- correct `Content-Type` (`audio/mpeg` for mp3, `audio/flac`, `audio/wav`),
- `Accept-Ranges: bytes`, and on a range request `206 Partial Content` + `Content-Range`.

Verified on this box for both mp3 and flac (full `200` and `206` range responses).

---

## 6. Timing & limits (measured on the demo box: Tesla T4, LM=1.7B `pt`, float32)

| Job | Approx. wall time |
| --- | --- |
| First request after boot | + model warmup (lazy load on first call) |
| 20 s song, `thinking:true` | ~30–40 s |
| 150 s song, `thinking:true` | ~120 s (LM ~100 s + DiT ~20 s) |

- LM time scales with **duration**; DiT time scales with duration × `inference_steps` × `batch_size`.
- Keep `batch_size: 1` and `inference_steps: 8` for snappy demos.
- If RITHM exposes long durations, raise `POLL_TIMEOUT_MS` accordingly.
- Check `GET /v1/stats` for `avg_job_seconds` and queue depth to tune timeouts/UX.

---

## 7. Audio format guidance

- **`mp3`** (default): small, universally playable in `<audio>`. Encoded at 128 kbps / 48 kHz on this
  box. ✅ Verified working.
- **`flac`**: lossless, ~10–20 MB, also `<audio>`-playable. ✅ Verified working.
- `wav`/`wav32`: large but supported. `opus`/`aac`: supported by the build but **not** verified on
  this box — prefer `mp3`/`flac` for the demo.

---

## 8. Errors

| HTTP | Meaning | RITHM handling |
| --- | --- | --- |
| `200` + `status:2` | Generation failed | Surface `result`/error text to the user; offer retry. |
| `400` | Bad JSON / invalid field | Fix the request body. |
| `401` | Auth on (shouldn't happen here) | Server misconfig — key must be unset, see `deployment-notes.md`. |
| `415` | Wrong Content-Type | Send `application/json`. |
| `429` | Queue full | Back off and retry; demo is one-at-a-time so this is unlikely. |
| `500` | Server error | Inspect server logs; retry. |

Error body shape: `{ "detail": "…message…" }`.

---

## 9. Recommended RITHM defaults (`gen-proxy/.env` or request builder)

```
DEFAULT_MODEL   = acestep-v15-turbo
THINKING        = true        # LM-enhanced; set false only if the LM isn't loaded server-side
AUDIO_FORMAT    = mp3         # or flac
INFERENCE_STEPS = 8           # turbo sweet spot
BATCH_SIZE      = 1
POLL_INTERVAL_MS= 2000
POLL_TIMEOUT_MS = 300000      # raise if long durations are allowed
```

Everything else (BPM, key, time-signature, duration, seed, LM temperature, …) is an **optional**
advanced toggle — omit to let the server/LM choose, send to override per the tables in §3.

---

## 10. Quick verification (copy-paste)

```bash
BASE=http://<EC2_DNS>:8001
curl -s $BASE/health
curl -s $BASE/v1/models

# submit
TID=$(curl -s -X POST $BASE/release_task -H 'Content-Type: application/json' \
  -d '{"prompt":"upbeat synthwave","thinking":true,"audio_format":"mp3","audio_duration":20,"batch_size":1}' \
  | python -c 'import sys,json;print(json.load(sys.stdin)["data"]["task_id"])')
echo "task=$TID"

# poll until status 1
curl -s -X POST $BASE/query_result -H 'Content-Type: application/json' \
  -d "{\"task_id_list\":[\"$TID\"]}"

# download (URL-encoded path from result[].file)
curl "$BASE/v1/audio?path=<encoded-path>" -o out.mp3
```

For the exhaustive parameter list (all aliases, editing tasks, multipart upload) see
[`../en/API.md`](../en/API.md). This document is the curated subset RITHM needs.
