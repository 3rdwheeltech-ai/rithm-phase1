import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, request, requestWithHeaders } from "./api";
import { useAuth } from "../store/auth";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A signed-in session whose id token is about to be rejected. */
function signIn() {
  useAuth.setState({
    idToken: "stale.id.token",
    refreshToken: "refresh-token",
    email: "user@example.com",
    user: { sub: "sub-1", email: "user@example.com" },
    status: "authed",
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  useAuth.setState({
    idToken: null,
    refreshToken: null,
    email: null,
    user: null,
    status: "anon",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ApiError", () => {
  it("carries status, detail and the numeric extras from a 429", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(429, {
        type: "https://rithm.dev/errors/429",
        title: "Rate limit exceeded",
        status: 429,
        detail: "Rate limit exceeded",
        request_id: "req-42",
        retry_after_seconds: 3600,
        used: 20,
        limit: 20,
      }),
    );

    const error = await request("/tracks/generate", { method: "POST", body: "{}" }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.status).toBe(429);
    expect(apiError.detail).toBe("Rate limit exceeded");
    expect(apiError.requestId).toBe("req-42");
    // Numbers, not prose — the toast reads these directly.
    expect(apiError.extras).toMatchObject({ retry_after_seconds: 3600, used: 20, limit: 20 });
    expect(apiError.message).toBe("Rate limit exceeded");
  });

  it("prefers detail over title, and falls back to HTTP <status>", async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { title: "", detail: "", status: 500 }));
    const error = (await request("/tracks").catch((e: unknown) => e)) as ApiError;
    expect(error.message).toBe("HTTP 500");
  });

  it("flattens a 422 validation array into one sentence", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(422, {
        title: "Validation Error",
        status: 422,
        detail: [{ msg: "bpm_min must be <= bpm_max" }, { msg: "prompt is required" }],
      }),
    );
    const error = (await request("/tracks/generate").catch((e: unknown) => e)) as ApiError;
    expect(error.message).toBe("bpm_min must be <= bpm_max. prompt is required");
  });

  it("does not throw a parse error on a non-JSON body", async () => {
    fetchMock.mockResolvedValue(
      new Response("<html><body>502 Bad Gateway</body></html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      }),
    );

    const error = (await request("/tracks").catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(502);
    expect(error.detail).toContain("502 Bad Gateway");
  });
});

describe("response handling", () => {
  it("does not call res.json() on a 204", async () => {
    const res = new Response(null, { status: 204 });
    const jsonSpy = vi.spyOn(res, "json");
    fetchMock.mockResolvedValue(res);

    await expect(request("/tracks/abc", { method: "DELETE" })).resolves.toBeUndefined();
    expect(jsonSpy).not.toHaveBeenCalled();
  });

  it("returns the headers so pagination can read X-Next-Cursor", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, [], { "x-next-cursor": "cursor-2", "x-total-count": "25" }),
    );

    const { headers } = await requestWithHeaders("/tracks");
    expect(headers.get("x-next-cursor")).toBe("cursor-2");
    expect(headers.get("x-total-count")).toBe("25");
  });

  it("sends the bearer token and resolves paths against the relative base", async () => {
    signIn();
    fetchMock.mockResolvedValue(jsonResponse(200, []));

    await request("/tracks");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/tracks");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer stale.id.token");
  });
});

describe("401 handling", () => {
  it("refreshes exactly once for N concurrent 401s, then replays each request", async () => {
    signIn();

    let refreshCalls = 0;
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/auth/refresh")) {
        refreshCalls += 1;
        return Promise.resolve(
          jsonResponse(200, {
            id_token: "fresh.id.token",
            refresh_token: null,
            expires_in: 3600,
            token_type: "Bearer",
          }),
        );
      }
      // Reject the stale token, accept the fresh one.
      return Promise.resolve(
        useAuth.getState().idToken === "fresh.id.token"
          ? jsonResponse(200, { ok: true })
          : jsonResponse(401, { title: "Unauthorized", status: 401 }),
      );
    });

    const results = await Promise.all([
      request("/tracks"),
      request("/tracks/a"),
      request("/tracks/b"),
      request("/jobs/j1"),
    ]);

    expect(refreshCalls).toBe(1);
    expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }, { ok: true }]);
    expect(useAuth.getState().idToken).toBe("fresh.id.token");
  });

  it("logs out and never loops when the refresh itself fails", async () => {
    signIn();

    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith("/auth/refresh")
          ? jsonResponse(401, { title: "Unknown user", status: 401 })
          : jsonResponse(401, { title: "Unauthorized", status: 401 }),
      ),
    );

    await expect(request("/tracks")).rejects.toBeInstanceOf(ApiError);
    expect(useAuth.getState().status).toBe("anon");
    expect(useAuth.getState().idToken).toBeNull();
    // One original + one refresh. No replay, no second refresh.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not attempt a refresh for an unauthenticated 401 (bad credentials)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { title: "Incorrect credentials", status: 401 }));

    await expect(request("/auth/login", { method: "POST", body: "{}" })).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
