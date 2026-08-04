export interface JwtClaims {
  sub?: string;
  name?: string;
  email?: string;
  /** Expiry, seconds since the epoch. */
  exp?: number;
  [k: string]: unknown;
}

/**
 * Decode a JWT payload to read claims. No signature verification — verification
 * is the API's job. The client only needs these to display the user and to know
 * when to stop trying, which is why there is no `GET /me` round trip for it.
 */
export function decodeJwt(token: string | null): JwtClaims | null {
  if (!token) return null;
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(
      atob(b64)
        .split("")
        .map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0"))
        .join(""),
    );
    return JSON.parse(json) as JwtClaims;
  } catch {
    return null;
  }
}
