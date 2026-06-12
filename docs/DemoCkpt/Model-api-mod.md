# Ckpt-1 Demo — Model side (ACE-Step 1.5 on EC2)

> Companion to `Ckpt1-Spec.md` (the RITHM repo side). This doc describes **everything the ACE-Step
> model server must do** for the RITHM demo to work.
>
> **TL;DR: No model code changes are required.** You only need to *launch* the existing ACE-Step
> API server with the right env vars and open one port. CORS is **not** needed because the browser
> never calls the model directly — only the RITHM `gen-proxy` Node service does (server-to-server).
>
> 👉 **Working on the EC2 box itself? Read [`platform-context.md`](./platform-context.md) first.** It
> explains the calling application, the exact contract `gen-proxy` depends on, the
> "config-over-code" fix philosophy, and a failure-mode → graceful-fix table. This file is the
> launch/contract reference; `platform-context.md` is the orientation + troubleshooting brief.

---

## 1. What the demo expects from this server

The RITHM `gen-proxy` service calls the **stock ACE-Step HTTP API** (`docs/.../API.md`) exactly as
documented — no new or modified endpoints:

| Endpoint | Method | Used for |
| --- | --- | --- |
| `/release_task` | POST | submit a generation task → `task_id` |
| `/query_result` | POST | poll task status until `status == 1` (done) / `2` (failed) |
| `/v1/audio?path=...` | GET | download/stream the generated audio file |
| `/health` | GET | liveness check |
| `/v1/models` | GET | confirm the loaded DiT model name |

All requests are plain JSON. **No API key** (auth disabled). Audio is served straight from the
server's temp dir via `/v1/audio` — **no S3, no external storage**.

---

## 2. Launch the API server

Run the stock server (no source edits). Example:

```bash
# Auth OFF (empty key), bind to all interfaces, turbo model, port 8001
export ACESTEP_API_HOST=0.0.0.0          # MUST be 0.0.0.0 (not 127.0.0.1) so the proxy can reach it
export ACESTEP_API_PORT=8001
export ACESTEP_API_KEY=                  # empty → authentication disabled
export ACESTEP_CONFIG_PATH=acestep-v15-turbo

# 5Hz LM: required only if RITHM sends thinking=true (the default).
# 'auto' decides based on GPU; force it on if you have the VRAM:
export ACESTEP_INIT_LLM=true
export ACESTEP_LM_MODEL_PATH=acestep-5Hz-lm-0.6B
export ACESTEP_LM_BACKEND=vllm

python -m acestep.api_server
```

### `thinking` requirement
RITHM sends `thinking=true` by default (LM enhances captions / fills metadata / drafts lyrics for
the "Prompt" lyric mode). This needs the **5Hz LM loaded** (`ACESTEP_INIT_LLM=true`).

- **If the box can't load the LM** (insufficient VRAM, etc.): that's fine — tell the RITHM side to
  set `THINKING=false` in `gen-proxy/.env`. Generation then runs in pure `text2music` mode using the
  caption/lyrics as-is. No model change either way.

### Model
Default DiT is `acestep-v15-turbo` (8 inference steps, fast — good for a demo). `gen-proxy` sends
`model: "acestep-v15-turbo"` explicitly; ensure it's the loaded/available model (check `/v1/models`).

---

## 3. Networking / EC2 security group

- Open **inbound TCP `8001`** to the demo machine's public IP (or `0.0.0.0/0` for an open demo box,
  per the user's setup). This is the only port the demo needs.
- **No S3, no other AWS services** are involved on the model side.
- The model server does **not** need to reach back to anything — it's purely request/response.

### CORS — not required
The browser talks only to RITHM's `gen-proxy` (`/gen/*` via the local vite proxy). `gen-proxy`
(Node, server-side) calls this API. Since there is no browser→model cross-origin request, **no CORS
middleware is needed on the model server.** (If you ever point a browser *directly* at `:8001`,
you'd then need CORS — but the demo does not.)

---

## 4. Request/response contract `gen-proxy` relies on

### 4.1 Submit — `POST /release_task`
`gen-proxy` sends a body like:
```json
{
  "model": "acestep-v15-turbo",
  "inference_steps": 8,
  "thinking": true,
  "audio_format": "mp3",
  "batch_size": 1,
  "prompt": "dreamy lo-fi with warm piano, male vocals",
  "lyrics": "",
  "lm_temperature": 0.85,
  "vocal_language": "en"
}
```
Expected response (`API.md` §4.3):
```json
{ "data": { "task_id": "…", "status": "queued" }, "code": 200, "error": null }
```
`gen-proxy` reads `data.task_id`.

### 4.2 Poll — `POST /query_result`
```json
{ "task_id_list": ["<task_id>"] }
```
Expected response (`API.md` §5.3): `data[0].status` is an **int** (`0` running, `1` success,
`2` failed), and `data[0].result` is a **JSON string** that parses to an array; each element has at
least:
```json
{ "file": "/v1/audio?path=…", "lyrics": "…", "prompt": "…",
  "metas": { "duration": 30 }, "seed_value": "12345" }
```
`gen-proxy` polls every 2 s until `status` is `1` or `2` (timeout 5 min, both configurable).

### 4.3 Audio — `GET /v1/audio?path=...`
`gen-proxy` takes the `path` value out of each result's `file` and re-requests it here, forwarding
the browser's `Range` header for seeking, then streams the bytes back to the browser. The server
should return the audio with a correct `Content-Type` (and ideally `Accept-Ranges`/`Content-Range`).

---

## 5. Audio format

RITHM requests `audio_format: "mp3"` by default (small, universally playable). It can switch to
`"flac"` (lossless, ~10–20 MB) by changing one env var on the RITHM side — no model change. Ensure
the requested formats are supported by the server build (they are, per `API.md` §4.2: `flac`, `mp3`,
`opus`, `aac`, `wav`, `wav32`).

---

## 6. Smoke test (run on / against the EC2)

```bash
# 1. Health + model
curl http://<EC2_DNS>:8001/health
curl http://<EC2_DNS>:8001/v1/models

# 2. Submit
curl -X POST http://<EC2_DNS>:8001/release_task \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"upbeat synthwave","thinking":true,"audio_format":"mp3","model":"acestep-v15-turbo"}'
# → note the task_id

# 3. Poll until status == 1
curl -X POST http://<EC2_DNS>:8001/query_result \
  -H 'Content-Type: application/json' \
  -d '{"task_id_list":["<task_id>"]}'
# → parse data[0].result (JSON string) → take file "/v1/audio?path=…"

# 4. Download
curl "http://<EC2_DNS>:8001/v1/audio?path=<URL-encoded-path>" -o out.mp3
```

If all four steps succeed, the RITHM demo will work once `ACESTEP_API_BASE` in `gen-proxy/.env`
points at `http://<EC2_DNS>:8001`.

---

## 7. Summary of model-side actions

- [ ] Launch `python -m acestep.api_server` with `ACESTEP_API_HOST=0.0.0.0`, `ACESTEP_API_PORT=8001`,
      `ACESTEP_API_KEY=` (empty), `ACESTEP_CONFIG_PATH=acestep-v15-turbo`.
- [ ] Load the 5Hz LM (`ACESTEP_INIT_LLM=true`) **or** tell RITHM to set `THINKING=false`.
- [ ] Open inbound TCP `8001` in the security group.
- [ ] Verify the 4-step smoke test above.
- [ ] **No source code changes. No CORS. No S3.**
