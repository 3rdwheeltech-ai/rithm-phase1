# gen-proxy

Standalone Node/TS service that sits between the RITHM web app and the ACE-Step 1.5 model
API on EC2. The browser only ever calls `/gen/*` (same-origin via the vite dev proxy);
this service owns the EC2 DNS, does the async submit+poll **synchronously**, and streams
the audio bytes back so the EC2 stays fully behind the proxy (no browser CORS).

```
Browser → /gen/* (vite proxy) → gen-proxy :8090 → ACE-Step :8001 on EC2
```

## Run

```bash
cp .env.example .env   # set ACESTEP_API_BASE to the EC2 DNS
npm install
npm run dev            # listens on :8090

# smoke test:
curl localhost:8090/health
curl -X POST localhost:8090/generate -H 'Content-Type: application/json' -d '{"prompt":"upbeat lo-fi"}'
```

## Env

| Var | Default | Notes |
| --- | --- | --- |
| `ACESTEP_API_BASE` | `http://localhost:8001` | EC2 ACE-Step API base (the only place the DNS lives). |
| `PORT` | `8090` | Port this proxy listens on. |
| `AUDIO_FORMAT` | `mp3` | Flip to `flac` for lossless (~10–20 MB/file). |
| `DEFAULT_MODEL` | `acestep-v15-turbo` | DiT model sent to `release_task`. |
| `THINKING` | `true` | Set `false` if the EC2 has NO 5Hz LM loaded. |
| `INFERENCE_STEPS` | `8` | Turbo recommended. |
| `BATCH_SIZE` | `1` | Tracks per click. |
| `POLL_INTERVAL_MS` | `2000` | Poll cadence for `query_result`. |
| `POLL_TIMEOUT_MS` | `300000` | Give-up timeout (5 min). |

## Endpoints

- `GET /health` — `{ status, upstream, acestepApiBase }` (probes the EC2 too).
- `POST /generate` — blocks until the track is ready; returns `{ tracks: GeneratedTrack[] }`.
- `GET /audio?path=...` — streams audio bytes from the EC2, forwarding the `Range` header.
