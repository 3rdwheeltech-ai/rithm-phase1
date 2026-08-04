import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider, type InfiniteData } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PAGE_SIZE, useTracks, type TracksPage } from "./useTracks";
import { qk } from "../lib/queryClient";
import type { TrackSummary } from "../types/api";

function track(id: string): TrackSummary {
  return {
    id,
    prompt: "warm lo-fi piano",
    genre: "Lo-Fi",
    mood: "Calm",
    bpm: 85,
    vocal: false,
    length_seconds: 30,
    mp3_url: `https://s3.example/${id}.mp3`,
    created_at: "2026-08-04T12:00:00Z",
  };
}

function page(ids: string[], headers: Record<string, string>) {
  return new Response(JSON.stringify(ids.map(track)), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  const view = renderHook(() => useTracks(), { wrapper });

  /**
   * Read pages from the cache rather than from `result.current`.
   *
   * The cache is where this hook's contract actually lives. `result.current`
   * additionally depends on React having re-rendered, and TanStack publishes
   * through its own batching notifier — asserting on that makes the test about
   * render scheduling instead of about pagination.
   */
  const pages = () =>
    queryClient.getQueryData<InfiniteData<TracksPage>>(qk.tracksList())?.pages ?? [];

  return { ...view, queryClient, pages };
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useTracks", () => {
  it("reads X-Next-Cursor and X-Total-Count off the response headers", async () => {
    fetchMock.mockResolvedValue(
      page(["t1", "t2"], { "x-next-cursor": "cursor-2", "x-total-count": "25" }),
    );

    const { result, pages } = setup();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(pages()[0]?.tracks).toHaveLength(2);
    expect(pages()[0]?.totalCount).toBe(25);
    expect(pages()[0]?.nextCursor).toBe("cursor-2");
    expect(result.current.hasNextPage).toBe(true);

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(`/api/v1/tracks?limit=${PAGE_SIZE}`);
  });

  it("passes the cursor on the next page and stops when the header is absent", async () => {
    fetchMock
      .mockResolvedValueOnce(page(["t1"], { "x-next-cursor": "cursor-2", "x-total-count": "2" }))
      // No X-Next-Cursor on the last page.
      .mockResolvedValueOnce(page(["t2"], { "x-total-count": "2" }));

    const { result, pages } = setup();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    await act(async () => {
      await result.current.fetchNextPage();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [secondUrl] = fetchMock.mock.calls[1] as [string];
    expect(secondUrl).toBe(`/api/v1/tracks?limit=${PAGE_SIZE}&cursor=cursor-2`);

    await waitFor(() => expect(pages()).toHaveLength(2));
    expect(pages()[1]?.tracks.map((t) => t.id)).toEqual(["t2"]);
    // An ABSENT header is how you know you are at the end — a short page is not
    // the signal, because a page can legitimately come back short.
    expect(pages()[1]?.nextCursor).toBeUndefined();
  });

  it("treats a full page with no cursor header as the end", async () => {
    const ids = Array.from({ length: PAGE_SIZE }, (_, i) => `t${i}`);
    fetchMock.mockResolvedValue(page(ids, { "x-total-count": String(PAGE_SIZE) }));

    const { result, pages } = setup();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(pages()[0]?.tracks).toHaveLength(PAGE_SIZE);
    expect(pages()[0]?.nextCursor).toBeUndefined();
    expect(result.current.hasNextPage).toBe(false);
  });
});
