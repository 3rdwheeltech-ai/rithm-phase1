import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { request, SSE_TOKEN_EXPIRED_TYPE } from "../lib/api";
import { qk } from "../lib/queryClient";
import type {
  CompletedEvent,
  FailedEvent,
  JobStatus,
  QueuedEvent,
  RunningEvent,
  TrackDetail,
} from "../types/api";

/**
 * The job progress state machine.
 *
 * This hook is the difference between "it worked on my machine" and "it works
 * on a train". Two independent things can strand a client and neither is
 * exotic: a deploy (desiredCount=1 still briefly runs two API tasks, the SSE
 * hub is per-process, so the client can reconnect onto task B while the
 * completion is published on task A), and a stream token that outlives its own
 * job on a cold start. Both are invisible to a client that only listens.
 */
export type JobPhase = "idle" | "queued" | "running" | "completed" | "failed" | "lost";

/**
 * Deliberately separate from `phase`. The UI shows job progress from `phase`
 * and a small, quiet indicator from `connection`; conflating them makes a
 * reconnect look like a failed generation.
 */
export type ConnectionState = "connecting" | "open" | "retrying" | "polling" | "closed";

export interface JobStreamState {
  phase: JobPhase;
  jobId: string | null;
  connection: ConnectionState;
  trackId?: string;
  mp3Url?: string;
  error?: string;
  estimatedStartSeconds?: number;
  estimatedSecondsRemaining?: number;
}

export interface JobHandle {
  jobId: string;
  /** Use the server's `sse_url` verbatim — the token is in it. */
  sseUrl: string;
}

export interface JobStreamOptions {
  onCompleted?: (trackId: string | undefined) => void;
  onFailed?: (error: string) => void;
}

/** 1s, 2s, 4s, 8s, then 15s forever, each ±20% jitter. */
export const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;
export const MAX_CONSECUTIVE_FAILURES = 6;
/** Keepalives arrive every 15s, so 25s of silence is a real gap, not jitter. */
export const WATCHDOG_MS = 25_000;
export const POLL_INTERVAL_MS = 5_000;
export const POLL_CEILING_MS = 15 * 60_000;

const IDLE_STATE: JobStreamState = { phase: "idle", jobId: null, connection: "closed" };

function backoffDelay(failureCount: number): number {
  const base = BACKOFF_MS[Math.min(failureCount - 1, BACKOFF_MS.length - 1)] ?? 15_000;
  const jitter = base * 0.2 * (Math.random() * 2 - 1);
  return Math.max(250, Math.round(base + jitter));
}

function parse<T>(event: Event): T | null {
  const data = (event as MessageEvent<string>).data;
  if (typeof data !== "string" || data.length === 0) return null;
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

export function useJobStream(
  job: JobHandle | null,
  options: JobStreamOptions = {},
): JobStreamState {
  const queryClient = useQueryClient();
  const [state, setState] = useState<JobStreamState>(IDLE_STATE);

  // Kept in a ref so changing a callback never tears down a live stream.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const jobId = job?.jobId ?? null;
  const sseUrl = job?.sseUrl ?? null;

  useEffect(() => {
    if (!jobId || !sseUrl) {
      setState(IDLE_STATE);
      return;
    }

    let disposed = false;
    let source: EventSource | null = null;
    let failures = 0;
    let probed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let pollDeadline = 0;

    const patch = (next: Partial<JobStreamState>) => {
      if (disposed) return;
      setState((prev) => ({ ...prev, jobId, ...next }));
    };

    const clearWatchdog = () => {
      if (watchdogTimer !== null) clearTimeout(watchdogTimer);
      watchdogTimer = null;
    };

    const teardown = () => {
      source?.close();
      source = null;
      clearWatchdog();
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
      if (pollTimer !== null) clearInterval(pollTimer);
      pollTimer = null;
    };

    // ── terminal ───────────────────────────────────────────────────────────

    const finishCompleted = (trackId?: string, mp3Url?: string) => {
      if (disposed) return;
      teardown();
      patch({ phase: "completed", connection: "closed", trackId, mp3Url });

      void queryClient.invalidateQueries({ queryKey: qk.tracks });
      if (trackId) {
        void queryClient.prefetchQuery({
          queryKey: qk.track(trackId),
          queryFn: () => request<TrackDetail>(`/tracks/${trackId}`),
        });
      }
      optionsRef.current.onCompleted?.(trackId);
    };

    const finishFailed = (error: string) => {
      if (disposed) return;
      teardown();
      patch({ phase: "failed", connection: "closed", error });
      optionsRef.current.onFailed?.(error);
    };

    // ── the polling fallback ───────────────────────────────────────────────

    const fetchStatus = async (): Promise<JobStatus | null> => {
      try {
        return await request<JobStatus>(`/jobs/${jobId}`);
      } catch {
        return null;
      }
    };

    const applyStatus = (status: JobStatus) => {
      if (status.status === "COMPLETED") {
        finishCompleted(status.track_id ?? undefined, status.mp3_url ?? undefined);
        return;
      }
      if (status.status === "FAILED" || status.status === "DEAD_LETTERED") {
        finishFailed(status.error ?? "Generation failed.");
        return;
      }
      patch({ phase: status.status === "RUNNING" ? "running" : "queued" });
    };

    const pollOnce = async () => {
      if (disposed) return;
      if (Date.now() > pollDeadline) {
        teardown();
        patch({ phase: "lost", connection: "closed" });
        return;
      }
      const status = await fetchStatus();
      if (status && !disposed) applyStatus(status);
    };

    const startPolling = () => {
      if (disposed || pollTimer !== null) return;
      source?.close();
      source = null;
      clearWatchdog();
      patch({ connection: "polling" });
      pollDeadline = Date.now() + POLL_CEILING_MS;
      // Poll once immediately — don't wait 5s to find out the job finished
      // eleven minutes ago.
      void pollOnce();
      pollTimer = setInterval(() => void pollOnce(), POLL_INTERVAL_MS);
    };

    // ── connection management ──────────────────────────────────────────────

    /**
     * EventSource does not expose the response status on error, so the only way
     * to tell an expired token from a transient blip is to ask for the same URL
     * with a plain fetch and read the status off that. A small ugliness that
     * converts an unrecoverable hang into a working fallback.
     */
    const probeStreamStatus = async (): Promise<{ status: number; type: string } | null> => {
      const controller = new AbortController();
      try {
        const res = await fetch(sseUrl, {
          headers: { Accept: "text/event-stream" },
          signal: controller.signal,
        });
        if (res.status === 401) {
          let type = "";
          try {
            type = ((await res.json()) as { type?: string }).type ?? "";
          } catch {
            type = "";
          }
          return { status: 401, type };
        }
        // Never drain a live stream we only opened to read a status code.
        controller.abort();
        return { status: res.status, type: "" };
      } catch {
        return null;
      }
    };

    const scheduleRetry = () => {
      if (disposed) return;
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        startPolling();
        return;
      }
      patch({ connection: "retrying" });
      retryTimer = setTimeout(openStream, backoffDelay(failures));
    };

    const handleStreamError = () => {
      if (disposed || pollTimer !== null) return;
      // Native EventSource reconnects on its own with a schedule we cannot
      // control, and which is wrong for us — we must stop on terminal states
      // and on token expiry. So close it and drive reconnection ourselves.
      source?.close();
      source = null;
      clearWatchdog();
      failures += 1;

      if (failures === 2 && !probed) {
        probed = true;
        void probeStreamStatus().then((probe) => {
          if (disposed) return;
          if (probe?.status === 401 && probe.type === SSE_TOKEN_EXPIRED_TYPE) {
            // Retrying an expired token is a tight loop against a wall.
            startPolling();
            return;
          }
          scheduleRetry();
        });
        return;
      }
      scheduleRetry();
    };

    const armWatchdog = () => {
      clearWatchdog();
      watchdogTimer = setTimeout(() => {
        if (disposed || pollTimer !== null) return;
        // Open but silent past a heartbeat gap: the stream is stale — most
        // likely we are attached to an API task that will never publish this
        // job's completion. Reconnecting is always safe and is itself the
        // recovery, because the server replays current state on connect.
        source?.close();
        source = null;
        patch({ connection: "retrying" });
        openStream();
      }, WATCHDOG_MS);
    };

    const onActivity = () => {
      failures = 0;
      armWatchdog();
    };

    function openStream() {
      if (disposed) return;
      patch({ connection: "connecting" });

      const es = new EventSource(sseUrl!);
      source = es;

      es.onopen = () => {
        if (disposed) return;
        patch({ connection: "open" });
        onActivity();
      };
      es.onerror = handleStreamError;

      // A NAMED event, not the conventional `: keepalive` comment: comments
      // are invisible to EventSource, so without this the watchdog could not
      // tell a quiet queue from a dead stream.
      es.addEventListener("keepalive", onActivity);

      es.addEventListener("queued", (event) => {
        onActivity();
        const data = parse<QueuedEvent>(event);
        patch({
          phase: "queued",
          estimatedStartSeconds: data?.estimated_start_seconds,
        });
      });

      es.addEventListener("running", (event) => {
        onActivity();
        const data = parse<RunningEvent>(event);
        patch({
          phase: "running",
          estimatedSecondsRemaining: data?.estimated_seconds_remaining,
        });
      });

      es.addEventListener("completed", (event) => {
        onActivity();
        const data = parse<CompletedEvent>(event);
        if (data?.track_id) {
          finishCompleted(data.track_id, data.mp3_url);
          return;
        }
        // The RECONNECT REPLAY frame carries s3 keys but neither a track_id nor
        // a signed URL, so a client that reconnects after its job finished gets
        // a `completed` it cannot act on. One status read fills the gap.
        source?.close();
        source = null;
        clearWatchdog();
        void fetchStatus().then((status) => {
          if (disposed) return;
          finishCompleted(status?.track_id ?? undefined, status?.mp3_url ?? undefined);
        });
      });

      es.addEventListener("failed", (event) => {
        onActivity();
        const data = parse<FailedEvent>(event);
        finishFailed(data?.error ?? "Generation failed.");
      });

      armWatchdog();
    }

    setState({ phase: "idle", jobId, connection: "connecting" });
    openStream();

    return () => {
      disposed = true;
      teardown();
    };
  }, [jobId, sseUrl, queryClient]);

  return state;
}
