import { request } from "../api";
import type { VoiceSessionResponse } from "../../types/api";
import { ANAM_VIDEO_ELEMENT_ID, type AnamClientLike } from "./types";

/**
 * Mint → connect → hand back a client, and tear the whole thing down again.
 *
 * THE ONLY IMPORT OF `@anam-ai/js-sdk` IN THIS TREE, and it is dynamic.
 *
 * A static import here — or anywhere reachable from `AvatarPanel` — pulls the
 * SDK into AvatarPanel's chunk, which mounts on EVERY desktop Home load. The
 * whole point is that someone who never presses Talk never downloads it. Vite
 * splits a dynamic import into its own chunk automatically, so no
 * `manualChunks` entry is needed; `.eslintrc.cjs` enforces the rule with
 * `no-restricted-imports` and an override for this one file, because the
 * comment above is not a guard.
 *
 * THE CLIENT IS A MODULE SINGLETON rather than a store slot. It is a
 * non-serialisable, side-effectful object; a store slot invites a component to
 * re-render on it and invites `getState().client` reaches from anywhere. The
 * precedent is `refreshInFlight` in `lib/api.ts`.
 */

let client: AnamClientLike | null = null;
let leaseId: string | null = null;

/** Whether a client is currently held. Read by the teardown paths. */
export function hasVoiceClient(): boolean {
  return client !== null;
}

/**
 * Can this browser do voice AT ALL?
 *
 * Checked BEFORE minting — never spend the product's one global session slot
 * to learn that this browser has no WebRTC.
 */
export function voiceSupported(): boolean {
  if (typeof window === "undefined") return false;
  return (
    "RTCPeerConnection" in window &&
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function"
  );
}

/**
 * A short-lived Anam credential, and the lease that goes with it.
 *
 * Fetched with a plain `request()` and NEVER put in a react-query cache: the
 * token is good for an hour and the session lasts three minutes, so a cache
 * entry would leave a live credential visible in devtools for ten minutes
 * after the call ended. The route answers `Cache-Control: no-store` to say the
 * same thing to every layer between here and it.
 */
export function mintVoiceSession(): Promise<VoiceSessionResponse> {
  return request<VoiceSessionResponse>("/chat/voice/session", { method: "POST" });
}

/**
 * Load the SDK, build a client, and start streaming into the one video element.
 *
 * `createClient(sessionToken)` takes NO persona config — verified against the
 * package's own `.d.ts`, where the public factory's signature is
 * `(sessionToken, options?)`. The persona rides on the token, which is exactly
 * why the server mints it with `personaConfig` rather than a `personaId`: the
 * brain setting is baked in before the browser is ever involved, and no value
 * a client could tamper with changes it.
 */
export async function loadAnamSdk(): Promise<
  (token: string) => AnamClientLike
> {
  // `AnamEvent` is an enum, i.e. a runtime value, so it could not be
  // `import type`d away even if we wanted it — which is the other half of why
  // `lib/anam/types.ts` re-declares the members this app uses as plain string
  // literals. Nothing above this line touches the package.
  const { createClient } = await import("@anam-ai/js-sdk");
  return (token) => createClient(token) as unknown as AnamClientLike;
}

/**
 * Build the client from a token.
 *
 * SEPARATE FROM THE IMPORT ABOVE, because the two fail for unrelated reasons
 * and the panel says different things about them. A rejected `import()` means
 * the chunk did not arrive — a bad deploy or a stale cache, and "couldn't load
 * the voice assistant" is the honest line. A throw from `createClient` means
 * the chunk is fine and the CREDENTIAL is not: the SDK decodes the session
 * token as a JWT and rejects anything malformed. Reporting that as a failed
 * download sends whoever debugs it to the bundler instead of the token route.
 */
export function buildVoiceClient(
  create: (token: string) => AnamClientLike,
  sessionToken: string,
): AnamClientLike {
  const created = create(sessionToken);
  client = created;
  return created;
}

/** Start the media flowing into the stage. Separate so handlers attach first. */
export async function streamToStage(): Promise<void> {
  await client?.streamToVideoElement(ANAM_VIDEO_ELEMENT_ID);
}

export function rememberLease(id: string): void {
  leaseId = id;
}

/**
 * Stop the stream and hand the slot back. Idempotent, and safe to call from a
 * path that has no client.
 *
 * `navigator.sendBeacon` CANNOT set an Authorization header, so the unload
 * release is `fetch(..., { keepalive: true })` — Safari 13+ and Chrome, but
 * not Firefox before 133. Which is fine, because the lease TTL on the server
 * is the real guarantee and this is an optimisation on top of it. Do not build
 * the recovery story on the unload path.
 */
export async function endVoiceSession(): Promise<void> {
  const held = client;
  const lease = leaseId;
  client = null;
  leaseId = null;

  if (held !== null) {
    // Never let a vendor teardown failure stop the lease from being released:
    // the slot is global, and holding it is worse than a leaked WebRTC object
    // the page is about to discard anyway.
    await held.stopStreaming().catch(() => undefined);
  }
  if (lease !== null) {
    await request<void>(`/chat/voice/session?lease_id=${lease}`, {
      method: "DELETE",
    }).catch(() => undefined);
  }
}

/** For tests, and for the `pagehide` path that must not await anything. */
export function forgetVoiceClient(): void {
  client = null;
  leaseId = null;
}

export { ANAM_VIDEO_ELEMENT_ID };
