# Platform context for the ACE-Step EC2 box (read me first)

> **Audience:** a Claude agent (or engineer) working on the EC2 instance where **ACE-Step 1.5**
> runs. You can see the ACE-Step source here; you **cannot** see the RITHM application repo. This
> doc gives you the context of *what is calling your server and why*, so that if something breaks
> you can diagnose and fix it **without guessing** — and without breaking the contract the caller
> depends on.
>
> Companion docs (on the RITHM side, quoted where relevant below): `Ckpt1-Spec.md` (web + proxy),
> `Model-api-mod.md` (how to launch this server). This file is the bridge between them.

---

## 1. What RITHM is

RITHM is a web app for **AI music generation** (think: type a prompt or fill a small form, get a
song you can play in the browser). For this milestone ("Ckpt-1") it is a **local demo only** —
nothing is deployed. The only job of this checkpoint is:

> User clicks **Generate** (or **Create**) in the RITHM web UI → a real track comes back from
> *your* ACE-Step server → it plays in the in-app audio player. Synchronously: submit, wait, play.

That's it. No accounts beyond a login gate (which does **not** touch your server), no storage, no
S3, no streaming of partial progress. One click → one finished track → playback.

---

## 2. Who actually calls you (and who does not)

```
Browser (localhost:5173)
   │  the browser NEVER calls this EC2 directly
   ▼
RITHM "gen-proxy"  (Node/TS, localhost:8090, server-side)   ←── the ONLY thing that calls you
   │  POST /release_task → poll POST /query_result → GET /v1/audio
   ▼
ACE-Step API  (this EC2, :8001)
```

**Key consequence:** every request you receive comes from a single server-side Node process, not a
browser. Therefore:

- **CORS is irrelevant.** Do not add, debug, or worry about CORS middleware. There is no browser
  cross-origin request to this box. (If you ever see CORS suggested as a fix, it's a wrong turn.)
- **No auth.** The server is launched with an empty `ACESTEP_API_KEY`, so authentication is
  disabled. gen-proxy sends **no** `Authorization` header and **no** `ai_token`. If you re-enable
  auth, you will break the demo (gen-proxy has no key to send).
- Requests are plain `application/json`.

---

## 3. The contract gen-proxy depends on (DON'T break these)

gen-proxy uses the **stock** ACE-Step HTTP API (see `API.md`) — three endpoints plus health/models.
If you change any of the shapes below, generation breaks. If you *must* change one, see §6 for how
to signal it back to the RITHM side.

### 3.1 `POST /release_task` — submit
gen-proxy sends a body like:
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
- `prompt`/`lyrics` may be empty strings. `lyrics:"[instrumental]"` means "no vocals".
- When the user picks the "Prompt" lyric mode, gen-proxy sends `lyrics:""` and relies on
  `thinking:true` to have the **5Hz LM draft the lyrics**.
- gen-proxy reads exactly one field from the response: **`data.task_id`**. The expected wrapper is:
```json
{ "data": { "task_id": "…", "status": "queued" }, "code": 200, "error": null,
  "timestamp": 1700000000000, "extra": null }
```

### 3.2 `POST /query_result` — poll
```json
{ "task_id_list": ["<task_id>"] }
```
gen-proxy polls this **every 2 seconds**, up to a **5-minute** timeout, and reads:
- `data[0].status` — must be an **integer**: `0` = queued/running, `1` = success, `2` = failed.
  (Not a string. gen-proxy compares `=== 1` / `=== 2`.)
- `data[0].result` — on success, must be a **JSON string** that `JSON.parse`s to an **array** of
  audio objects. Each object must contain at least:
```json
{ "file": "/v1/audio?path=…", "lyrics": "…", "prompt": "…",
  "metas": { "duration": 30 }, "seed_value": "12345" }
```
  gen-proxy reads `file`, `lyrics`, `prompt`, `metas.duration`, `seed_value`. Extra fields are
  ignored and fine. On `status:2`, gen-proxy surfaces `result` to the user as the error text.

### 3.3 `GET /v1/audio?path=...` — download
gen-proxy extracts the `path` query value out of each result's `file` and re-requests it here,
**forwarding the browser's `Range` header**, then streams the bytes to the browser. For this to
play in an HTML `<audio>` element you must return:
- a correct **`Content-Type`** (e.g. `audio/mpeg` for mp3, `audio/flac`, `audio/wav`) — this is the
  single most common cause of "downloads but won't play"; a wrong/missing mime breaks the player;
- ideally **`Accept-Ranges: bytes`** and, for range requests, **`206`** + **`Content-Range`** so
  seeking works (the demo tolerates a plain `200` full-file response if ranges aren't supported).

### 3.4 `GET /health` and `GET /v1/models`
- `/health` — gen-proxy probes it for a liveness/`upstream:"ok"` readout. Keep it returning `200`.
- `/v1/models` — used to confirm `acestep-v15-turbo` is the loaded/available DiT model.

---

## 4. Guiding principle: prefer config over code

The RITHM side's stance is **"change nothing on the model unless you have to."** The server is a raw
package; the *intended* path to fix almost any issue is an **env var / launch flag / model choice**,
not a source edit. Before editing ACE-Step source, exhaust:

- env vars (see `API.md` §13 and `Model-api-mod.md` §2) — host/port, LM on/off, LM backend,
  offload-to-CPU, queue size, tmpdir;
- request params (gen-proxy can be told to send different values — see §6);
- model/format selection (`model`, `audio_format`).

If a **source change is genuinely required** (e.g. the package has a bug, or a default is wrong for
this GPU), that's acceptable for this dev box — but keep it **minimal and contract-preserving** (do
not change response shapes from §3), and **write down exactly what you changed and why** so it can
be reproduced and so the RITHM side knows. Communicate it back per §6.

---

## 5. Likely failure modes and how to resolve them gracefully

| Symptom | Likely cause | Graceful fix (try in this order) |
| --- | --- | --- |
| `release_task` errors / task fails immediately with `thinking:true` | 5Hz LM not loaded (no VRAM, or `ACESTEP_INIT_LLM` off) | **Tell the RITHM side to set `THINKING=false`** in `gen-proxy/.env` (one line) → runs pure `text2music`, no LM. Or fix the LM: `ACESTEP_INIT_LLM=true`, try `ACESTEP_LM_BACKEND=pt` if `vllm` won't load. |
| LM loads but is very slow / OOMs | `vllm` backend heavy, or batch/duration too high | Switch `ACESTEP_LM_BACKEND=pt`; enable `ACESTEP_OFFLOAD_TO_CPU=true` / `ACESTEP_LM_OFFLOAD_TO_CPU=true`; keep `batch_size=1` (RITHM's default). |
| Audio "downloads" but won't play in the browser | wrong/missing `Content-Type` on `/v1/audio` | Ensure the audio response sets the correct mime (`audio/mpeg`, `audio/flac`, `audio/wav`). This is the #1 playback bug. |
| `mp3` requests fail; other formats work | mp3 encoder/ffmpeg missing in this build | Install the encoder, **or** ask RITHM to set `AUDIO_FORMAT=wav`/`flac` in `gen-proxy/.env` (formats per `API.md` §4.2: `flac, mp3, opus, aac, wav, wav32`). |
| Generation never finishes (gen-proxy times out at 5 min) | job slow (cold model load, big duration), or stuck in queue | First request after boot is slowest (model warmup) — warm it once with a curl. Check `/v1/stats` for `avg_job_seconds`/queue. RITHM can raise `POLL_TIMEOUT_MS`. |
| `429` from `release_task` | queue full (`ACESTEP_QUEUE_MAXSIZE`) | Demo is `batch_size=1`, one click at a time — shouldn't hit this. If it does, raise the queue size env or wait. |
| gen-proxy `/health` shows `upstream:"unreachable"` | server not bound to `0.0.0.0`, or security group closed | Bind `ACESTEP_API_HOST=0.0.0.0` (not `127.0.0.1`); open inbound TCP `8001` to the caller's IP. |
| Empty/`null` `task_id`, or `result` not parseable | response wrapper shape changed | Restore the §3 shapes. If intentional, signal RITHM per §6. |

**Self-check before declaring success** — run the 4-step smoke test in `Model-api-mod.md` §6
(health → models → release_task → query_result → download). If all four pass, RITHM will work.

---

## 6. If you must change something the caller sees

gen-proxy is small and adjustable. If a fix on your end requires the caller to send different
**inputs** or expect a different **output**, the RITHM side can adapt — but they need to know. The
mappings live in `gen-proxy/src/acestep.ts`:

- **Outgoing request body** is built in `releaseTask()` — they can change param names/values
  (`model`, `inference_steps`, `thinking`, `audio_format`, `batch_size`, `lm_temperature`,
  `vocal_language`, etc.).
- **Polling/result parsing** is in `pollUntilDone()` (reads `data[0].status` int + `data[0].result`
  JSON string) and `toTracks()` (reads `file`, `lyrics`, `prompt`, `metas.duration`, `seed_value`).
- **Audio fetch** is in `fetchAudio()` (`GET /v1/audio?path=…`, forwards `Range`).
- **Defaults** come from `gen-proxy/.env` (`THINKING`, `AUDIO_FORMAT`, `DEFAULT_MODEL`,
  `INFERENCE_STEPS`, `BATCH_SIZE`, `POLL_INTERVAL_MS`, `POLL_TIMEOUT_MS`).

So when you report back, say it in those terms, e.g.:
- *"mp3 isn't available; set `AUDIO_FORMAT=flac`."*
- *"LM can't load; set `THINKING=false`."*
- *"`status` is now returned as a string `'success'` instead of int `1`"* (so they update the
  comparison) — **but prefer not to do this**; keeping the stock contract is the whole point.

A one-line note of **what you changed, why, and what RITHM must change (if anything)** is the
deliverable. Keep the stock API contract intact whenever possible.

---

## 7. TL;DR

- You serve **one** server-side caller (gen-proxy). No browser, no CORS, no auth, no S3.
- Keep the **stock** `/release_task` → `/query_result` → `/v1/audio` contract (§3) intact.
- Fix issues with **env/flags/params first**; source edits only as a minimal, documented last resort.
- The two most common real problems: **5Hz LM not loaded** (→ `THINKING=false`) and **wrong audio
  `Content-Type`** (→ fix the mime). Both are easy.
- Verify with the 4-step smoke test, then tell RITHM the one line of config to flip, if any.
