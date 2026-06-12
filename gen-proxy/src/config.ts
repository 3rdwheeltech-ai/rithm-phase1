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
