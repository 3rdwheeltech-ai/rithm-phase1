export interface JwtClaims {
  name?: string;
  email?: string;
  [k: string]: unknown;
}

/**
 * Decode a JWT payload to read claims. No signature verification — this only
 * reads attributes (name/email) out of our own already-trusted session token,
 * so the sidebar can show the user's name without an extra API field.
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
