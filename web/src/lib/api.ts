import { decodeJwt } from "./jwt";
import { useAuth, type AuthUser } from "../store/auth";

/**
 * The API base is a RELATIVE path and nothing else.
 *
 * In production CloudFront serves the SPA at `/` and proxies `/api/*` to the
 * ALB, so the SPA and the API are same-origin; in dev the Vite proxy mirrors
 * exactly that shape. A build that has to know its own URL is a build you
 * cannot promote between environments — so never bake an origin in here.
 */
export const API_BASE = "/api/v1";

/**
 * How long the client assumes an SSE token is good for, deliberately BELOW the
 * server's SSE_TOKEN_TTL_SECONDS (1800). The client must not assume any
 * particular server TTL; this only decides when to treat its token as suspect.
 */
export const SSE_TOKEN_ASSUMED_TTL_SECONDS = 1500;

/** The one 401 that means "fall back to polling" rather than "log out". */
export const SSE_TOKEN_EXPIRED_TYPE = "https://rithm.dev/errors/sse-token-expired";

/** RFC 7807 members; anything else in the body is a machine-readable extra. */
const PROBLEM_MEMBERS = new Set(["type", "title", "status", "detail", "instance", "request_id"]);

interface ProblemBody {
  type?: string;
  title?: string;
  status?: number;
  detail?: unknown;
  instance?: string;
  request_id?: string;
  [k: string]: unknown;
}

/**
 * Every non-2xx response becomes one of these. `extras` is what keeps the rate
 * limiter's `retry_after_seconds` / `used` / `limit` available as numbers — the
 * error toast must never parse them back out of prose.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly type: string;
  readonly title: string;
  readonly detail: string;
  readonly requestId: string;
  readonly extras: Record<string, unknown>;

  constructor(init: {
    status: number;
    type?: string;
    title?: string;
    detail?: string;
    requestId?: string;
    extras?: Record<string, unknown>;
  }) {
    // Day 3 fixed a latent bug where `detail` was always null and the message
    // lived in `title`. Both are populated now; `detail` is the field to read.
    const message = init.detail || init.title || `HTTP ${init.status}`;
    super(message);
    this.name = "ApiError";
    this.status = init.status;
    this.type = init.type ?? "";
    this.title = init.title ?? "";
    this.detail = init.detail ?? "";
    this.requestId = init.requestId ?? "";
    this.extras = init.extras ?? {};
  }
}

/** Flatten a 422's Pydantic error array into one readable sentence. */
function detailToString(detail: unknown): string {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const messages = detail
      .map((d) => (d && typeof d === "object" ? (d as { msg?: unknown }).msg : undefined))
      .filter((m): m is string => typeof m === "string" && m.length > 0);
    return messages.join(". ");
  }
  return "";
}

async function toApiError(res: Response): Promise<ApiError> {
  const contentType = res.headers.get("content-type") ?? "";

  // A non-JSON body is what you get when something upstream returns an HTML
  // error page. Parsing it as JSON would throw and mask the real status.
  if (!contentType.includes("json")) {
    const text = await res.text().catch(() => "");
    return new ApiError({
      status: res.status,
      title: res.statusText || `HTTP ${res.status}`,
      detail: text.slice(0, 200),
    });
  }

  let body: ProblemBody;
  try {
    body = (await res.json()) as ProblemBody;
  } catch {
    return new ApiError({ status: res.status, title: res.statusText });
  }

  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!PROBLEM_MEMBERS.has(key)) extras[key] = value;
  }

  return new ApiError({
    status: res.status,
    type: body.type,
    title: body.title,
    detail: detailToString(body.detail),
    requestId: body.request_id,
    extras,
  });
}

/** 204 and empty bodies must never reach res.json(). */
async function parseBody<T>(res: Response): Promise<T> {
  if (res.status === 204 || res.headers.get("content-length") === "0") {
    return undefined as T;
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) return undefined as T;
  return (await res.json()) as T;
}

function userFromToken(idToken: string, fallbackEmail: string | null): AuthUser | null {
  const claims = decodeJwt(idToken);
  const sub = typeof claims?.sub === "string" ? claims.sub : null;
  const email = typeof claims?.email === "string" ? claims.email : fallbackEmail;
  return sub && email ? { sub, email } : null;
}

// ── Session ────────────────────────────────────────────────────────────────

interface TokenResponse {
  id_token: string;
  refresh_token: string | null;
  expires_in: number;
  token_type: string;
}

let refreshInFlight: Promise<boolean> | null = null;

/**
 * Exchange the stored refresh token for a fresh id token.
 *
 * Single-flight on purpose: ten concurrent requests that all 401 must produce
 * ONE refresh, not ten. Callers share the in-flight promise.
 */
export function refreshSession(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = doRefresh();
    void refreshInFlight.finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

async function doRefresh(): Promise<boolean> {
  const { refreshToken, email } = useAuth.getState();
  if (!refreshToken || !email) {
    useAuth.getState().logout();
    return false;
  }

  try {
    // A bare fetch, not `request` — routing this through the 401 handler would
    // recurse.
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // The API resolves the Cognito SECRET_HASH from the email, so this call
      // takes BOTH fields. It answers with refresh_token: null — Cognito does
      // not rotate it on REFRESH_TOKEN_AUTH.
      body: JSON.stringify({ email, refresh_token: refreshToken }),
    });
    if (!res.ok) {
      useAuth.getState().logout();
      return false;
    }
    const body = (await res.json()) as TokenResponse;
    useAuth.getState().setIdToken(body.id_token, userFromToken(body.id_token, email));
    return true;
  } catch {
    useAuth.getState().logout();
    return false;
  }
}

/**
 * Runs once at app start. The id token is memory-only, so after a reload the
 * only way back to an authenticated session is the persisted refresh token.
 */
export async function bootstrapSession(): Promise<void> {
  const auth = useAuth.getState();
  if (auth.idToken) {
    auth.setStatus("authed");
    return;
  }
  if (!auth.refreshToken || !auth.email) {
    auth.setStatus("anon");
    return;
  }
  const ok = await refreshSession();
  if (!ok) useAuth.getState().setStatus("anon");
}

export async function login(email: string, password: string): Promise<void> {
  const body = await request<TokenResponse>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  useAuth.getState().setSession({
    idToken: body.id_token,
    refreshToken: body.refresh_token,
    email,
    user: userFromToken(body.id_token, email),
  });
}

export async function signup(payload: {
  email: string;
  password: string;
  name: string;
  phone_number: string;
  consent_version: string;
}): Promise<void> {
  await request("/auth/signup", { method: "POST", body: JSON.stringify(payload) });
}

// ── Requests ───────────────────────────────────────────────────────────────

async function send(path: string, init: RequestInit): Promise<Response> {
  const { idToken } = useAuth.getState();

  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (idToken) headers.set("Authorization", `Bearer ${idToken}`);

  return fetch(`${API_BASE}${path}`, { ...init, headers });
}

/**
 * The one request path. Returns the headers alongside the body because
 * `GET /tracks` paginates on `X-Next-Cursor` — a client that throws its headers
 * away cannot paginate, and retro-fitting that means touching every call site.
 */
export async function requestWithHeaders<T>(
  path: string,
  init: RequestInit = {},
): Promise<{ data: T; headers: Headers }> {
  const hadToken = useAuth.getState().idToken !== null;
  let res = await send(path, init);

  // One shot, never a loop: refresh once, replay once, else the session is over
  // and the route guard takes it from here.
  if (res.status === 401 && hadToken) {
    const refreshed = await refreshSession();
    if (refreshed) {
      res = await send(path, init);
    } else {
      throw await toApiError(res);
    }
  }

  if (!res.ok) throw await toApiError(res);
  return { data: await parseBody<T>(res), headers: res.headers };
}

export async function request<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const { data } = await requestWithHeaders<T>(path, init);
  return data;
}
