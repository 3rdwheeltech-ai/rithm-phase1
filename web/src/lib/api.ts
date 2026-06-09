import { useAuth } from "../store/auth";

/**
 * Thin fetch wrapper for the RITHM API.
 *
 * Paths are relative (e.g. "/api/v1/auth/login") and resolved through the Vite
 * dev proxy → http://localhost:8080. The current id_token is attached as a
 * Bearer header when present. Errors are surfaced as `Error(message)` parsed
 * from the API's RFC 7807 problem+json bodies (message lives in `title`; `detail`
 * is an array of field errors on 422 validation failures).
 */
export async function apiFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const { idToken } = useAuth.getState();

  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (idToken) {
    headers.set("Authorization", `Bearer ${idToken}`);
  }

  const res = await fetch(path, { ...init, headers });

  // An authenticated request rejected with 401 means the session is stale.
  if (res.status === 401 && idToken) {
    useAuth.getState().clear();
  }

  if (!res.ok) {
    throw new Error(await problemMessage(res));
  }

  if (res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}

/** Extract a human-readable message from an RFC 7807 problem+json response. */
async function problemMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as {
      title?: string;
      detail?: string | Array<{ msg?: string }>;
    };
    if (res.status === 422 && Array.isArray(body.detail)) {
      const msgs = body.detail.map((d) => d?.msg).filter(Boolean);
      if (msgs.length) return msgs.join(". ");
    }
    if (typeof body.title === "string" && body.title) return body.title;
    if (typeof body.detail === "string" && body.detail) return body.detail;
  } catch {
    // Response body was not JSON — fall through to the generic message.
  }
  return `Request failed (${res.status})`;
}
