import { StrictMode, createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_CONSECUTIVE_FAILURES,
  POLL_INTERVAL_MS,
  WATCHDOG_MS,
  useJobStream,
  type JobHandle,
} from "./useJobStream";

const JOB: JobHandle = {
  jobId: "01J000000000000000000000J1",
  sseUrl: "/api/v1/jobs/01J000000000000000000000J1/events?token=tok",
};
const TRACK_ID = "01J000000000000000000000T1";

/**
 * A controllable stand-in for the browser's EventSource. The real one
 * reconnects on a schedule we cannot observe or drive, which is exactly why
 * the hook closes it and manages reconnection itself — and why a fake is the
 * only way to pin that behaviour.
 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];

  url: string;
  closed = false;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private listeners = new Map<string, Set<(event: Event) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: (event: Event) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(handler);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, handler: (event: Event) => void): void {
    this.listeners.get(type)?.delete(handler);
  }

  close(): void {
    this.closed = true;
  }

  // ── test drivers ─────────────────────────────────────────────────────────

  open(): void {
    this.onopen?.(new Event("open"));
  }

  emit(type: string, data: unknown): void {
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }

  fail(): void {
    this.onerror?.(new Event("error"));
  }

  static get live(): FakeEventSource[] {
    return FakeEventSource.instances.filter((instance) => !instance.closed);
  }

  static get latest(): FakeEventSource {
    const last = FakeEventSource.instances[FakeEventSource.instances.length - 1];
    if (!last) throw new Error("no EventSource was constructed");
    return last;
  }
}

let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function setup(job: JobHandle | null = JOB) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();
  vi.spyOn(queryClient, "prefetchQuery").mockResolvedValue();

  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);

  const view = renderHook(() => useJobStream(job), { wrapper });
  return { ...view, queryClient, invalidate };
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function flush() {
  await advance(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.instances = [];
  fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", fetchMock);
  // Remove jitter so backoff timings are exact.
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── 1 ──────────────────────────────────────────────────────────────────────

describe("the happy path", () => {
  it("drives queued -> running -> completed and invalidates the list once", async () => {
    const { result, invalidate } = setup();

    act(() => FakeEventSource.latest.open());
    expect(result.current.connection).toBe("open");

    act(() =>
      FakeEventSource.latest.emit("queued", {
        job_id: JOB.jobId,
        estimated_start_seconds: 120,
      }),
    );
    expect(result.current.phase).toBe("queued");
    expect(result.current.estimatedStartSeconds).toBe(120);

    act(() =>
      FakeEventSource.latest.emit("running", {
        job_id: JOB.jobId,
        estimated_seconds_remaining: 45,
      }),
    );
    expect(result.current.phase).toBe("running");
    expect(result.current.estimatedSecondsRemaining).toBe(45);

    await act(async () => {
      FakeEventSource.latest.emit("completed", {
        job_id: JOB.jobId,
        track_id: TRACK_ID,
        mp3_url: "https://s3.example/audio.mp3",
      });
    });

    expect(result.current.phase).toBe("completed");
    expect(result.current.connection).toBe("closed");
    expect(result.current.trackId).toBe(TRACK_ID);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.live).toHaveLength(0);
  });
});

// ── 2 ──────────────────────────────────────────────────────────────────────

describe("terminal states are terminal", () => {
  it("failed sets the error, closes, and never reconnects", async () => {
    const { result } = setup();
    act(() => FakeEventSource.latest.open());

    act(() => FakeEventSource.latest.emit("failed", { job_id: JOB.jobId, error: "boom" }));

    expect(result.current.phase).toBe("failed");
    expect(result.current.error).toBe("boom");
    expect(FakeEventSource.live).toHaveLength(0);

    const constructed = FakeEventSource.instances.length;
    await advance(60_000);
    expect(FakeEventSource.instances).toHaveLength(constructed);
  });
});

// ── 3 ──────────────────────────────────────────────────────────────────────

describe("reconnection", () => {
  it("backs off after an error and resets the counter on the next event", async () => {
    const { result } = setup();

    act(() => FakeEventSource.latest.fail());
    expect(result.current.connection).toBe("retrying");
    expect(FakeEventSource.instances).toHaveLength(1);

    // 1s backoff, jitter neutralised.
    await advance(1_000);
    expect(FakeEventSource.instances).toHaveLength(2);

    // A received event resets the failure count, so the next error backs off
    // from 1s again rather than continuing the escalation.
    act(() => FakeEventSource.latest.emit("queued", { job_id: JOB.jobId }));
    act(() => FakeEventSource.latest.fail());
    await advance(1_000);
    expect(FakeEventSource.instances).toHaveLength(3);
  });
});

// ── 4 ──────────────────────────────────────────────────────────────────────

describe("giving up on the stream", () => {
  it("switches to polling after six consecutive failures and hits the endpoint", async () => {
    const { result } = setup();
    // The 2nd failure probes the URL to rule out an expired token; answer it
    // with something that is not a 401 so backoff simply continues.
    fetchMock.mockResolvedValue(jsonResponse(200, {}));

    const delays = [1_000, 2_000, 4_000, 8_000, 15_000];
    for (let failure = 0; failure < MAX_CONSECUTIVE_FAILURES; failure += 1) {
      act(() => FakeEventSource.latest.fail());
      await flush();
      if (failure < delays.length) await advance(delays[failure]!);
    }

    fetchMock.mockResolvedValue(
      jsonResponse(200, { job_id: JOB.jobId, status: "RUNNING", kind: "generate" }),
    );
    await flush();

    expect(result.current.connection).toBe("polling");
    expect(FakeEventSource.live).toHaveLength(0);
    expect(fetchMock.mock.calls.some(([url]) => url === `/api/v1/jobs/${JOB.jobId}`)).toBe(true);
  });

  it("stops retrying immediately on an expired stream token", async () => {
    const { result } = setup();

    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url === JOB.sseUrl
          ? jsonResponse(401, {
              type: "https://rithm.dev/errors/sse-token-expired",
              title: "Stream token expired.",
              status: 401,
            })
          : jsonResponse(200, { job_id: JOB.jobId, status: "RUNNING", kind: "generate" }),
      ),
    );

    act(() => FakeEventSource.latest.fail());
    await advance(1_000);
    act(() => FakeEventSource.latest.fail()); // second failure triggers the probe
    await flush();

    expect(result.current.connection).toBe("polling");
    // Two streams total: the original and the one backoff opened. No third.
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.live).toHaveLength(0);
  });
});

// ── 5 — the reason this hook exists ────────────────────────────────────────

describe("the deploy race", () => {
  it("a poll that returns COMPLETED finishes the job with no SSE event ever arriving", async () => {
    const { result, invalidate } = setup();

    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url === JOB.sseUrl
          ? jsonResponse(200, {})
          : jsonResponse(200, {
              job_id: JOB.jobId,
              status: "COMPLETED",
              kind: "generate",
              track_id: TRACK_ID,
              mp3_url: "https://s3.example/audio.mp3",
            }),
      ),
    );

    for (let failure = 0; failure < MAX_CONSECUTIVE_FAILURES; failure += 1) {
      act(() => FakeEventSource.latest.fail());
      await flush();
      await advance(15_000);
    }
    await flush();

    // The stream never delivered a single event. The poll did.
    expect(result.current.phase).toBe("completed");
    expect(result.current.trackId).toBe(TRACK_ID);
    expect(result.current.mp3Url).toBe("https://s3.example/audio.mp3");
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("keeps polling on a non-terminal status", async () => {
    const { result } = setup();
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url === JOB.sseUrl
          ? jsonResponse(200, {})
          : jsonResponse(200, { job_id: JOB.jobId, status: "RUNNING", kind: "generate" }),
      ),
    );

    for (let failure = 0; failure < MAX_CONSECUTIVE_FAILURES; failure += 1) {
      act(() => FakeEventSource.latest.fail());
      await flush();
      await advance(15_000);
    }
    await flush();
    expect(result.current.phase).toBe("running");

    const before = fetchMock.mock.calls.length;
    await advance(POLL_INTERVAL_MS);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
  });
});

// ── 6 ──────────────────────────────────────────────────────────────────────

describe("the staleness watchdog", () => {
  it("tears down and reconnects after 25s of total silence", async () => {
    setup();
    act(() => FakeEventSource.latest.open());
    expect(FakeEventSource.instances).toHaveLength(1);

    await advance(WATCHDOG_MS + 100);

    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
    expect(FakeEventSource.live).toHaveLength(1);
  });

  it("a keepalive resets it, so a quiet queue is not mistaken for a dead stream", async () => {
    setup();
    act(() => FakeEventSource.latest.open());

    await advance(WATCHDOG_MS - 5_000);
    act(() => FakeEventSource.latest.emit("keepalive", {}));
    await advance(WATCHDOG_MS - 5_000);

    // 40s elapsed, but never 25s without a keepalive.
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});

// ── 7 ──────────────────────────────────────────────────────────────────────

describe("lifecycle hygiene", () => {
  it("unmount closes the stream and clears every timer", async () => {
    const { unmount } = setup();
    act(() => FakeEventSource.latest.open());

    unmount();

    expect(FakeEventSource.live).toHaveLength(0);
    const constructed = FakeEventSource.instances.length;
    await advance(120_000);
    expect(FakeEventSource.instances).toHaveLength(constructed);
  });

  it("a StrictMode double mount leaves exactly one stream open", async () => {
    // React 18 StrictMode runs effect -> cleanup -> effect on mount. The
    // cleanup must close the first stream, or every job opens two and you
    // spend an afternoon chasing phantom duplicate events.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(
        StrictMode,
        null,
        createElement(QueryClientProvider, { client: queryClient }, children),
      );

    renderHook(() => useJobStream(JOB), { wrapper });
    await flush();

    expect(FakeEventSource.instances.length).toBeGreaterThan(1);
    expect(FakeEventSource.live).toHaveLength(1);
  });

  it("a null job stays idle and opens nothing", () => {
    const { result } = setup(null);
    expect(result.current.phase).toBe("idle");
    expect(FakeEventSource.instances).toHaveLength(0);
  });
});
