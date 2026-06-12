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
