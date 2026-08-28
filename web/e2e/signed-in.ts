import { createRequire } from "node:module";
import type { Page } from "@playwright/test";

const require = createRequire(import.meta.url);

/**
 * axe-core's browser bundle, injected into the page.
 *
 * The library itself, not `@axe-core/playwright`. axe-core is already in the
 * tree (pa11y-ci depends on it) and `axe.run()` is three lines to call, so the
 * wrapper would be a second dependency for an ergonomic improvement over code
 * that fits on a screen. It is listed in devDependencies so that stays true
 * whatever pa11y does next.
 */
export const AXE_PATH: string = require.resolve("axe-core/axe.min.js");

const EMAIL = "e2e@rithm.test";
const SUB = "00000000-0000-7000-8000-0000000000e1";

/** A JWT the CLIENT can decode. Nothing verifies it — the API is intercepted. */
function fakeIdToken(): string {
  const payload = {
    sub: SUB,
    email: EMAIL,
    name: "Ada Lovelace",
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  const b64 = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64(payload)}.signature`;
}

const PROFILE = {
  version: 1,
  display_name: "Ada Lovelace",
  onboarding: { completed_at: "2026-08-01T12:00:00Z", skipped: false },
  preferences: {},
};

function json(body: unknown, status = 200) {
  return {
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  };
}

export interface ChatFixture {
  session_id: string | null;
  messages: { id: string; role: "user" | "assistant"; content: string; created_at: string }[];
  draft: Record<string, unknown>;
  ready: boolean;
  /**
   * Whether this "deployment" has a voice avatar.
   *
   * Both branches are worth running, and the FALSE one is not a placeholder:
   * with voice unconfigured the panel must be bit-for-bit what shipped before
   * it existed — Lottie, streaming prompt, Talk opening the Coming Soon
   * dialog. That is what `chat-a11y.spec.ts`'s existing "two doors" assertion
   * checks, unchanged, and it is the state every environment without an Anam
   * key is in.
   */
  voice_available?: boolean;
}

/**
 * Boot the SPA as a signed-in user with every API call answered from fixtures.
 *
 * The seeded localStorage entry is exactly what `store/auth.ts` persists — a
 * refresh token and an email, never an id token — so `bootstrapSession()` takes
 * its real path: it finds no token, POSTs /auth/refresh, and the interception
 * below hands back one it can decode. Nothing about the auth flow is stubbed
 * out inside the app.
 */
export async function signIn(page: Page, chat: ChatFixture): Promise<void> {
  await page.addInitScript(
    ([email, storageKey]) => {
      window.localStorage.setItem(
        storageKey,
        JSON.stringify({
          state: { refreshToken: "e2e-refresh-token", email },
          version: 0,
        }),
      );
    },
    [EMAIL, "rithm-auth"] as const,
  );

  /*
    THE CATCH-ALL GOES FIRST, and that is not cosmetic.

    Playwright matches routes in REVERSE registration order — the most
    recently added handler wins. Registered last, as it was, this pattern
    swallowed every specific route below it: `/tracks` answered `{}` instead of
    `[]`, the shell died on `.map is not a function`, and the page rendered
    blank. Every spec in this suite then failed on a missing control rather
    than on anything it was testing.

    Registering it first makes it the FALLBACK it is written to be: an empty
    200 for anything unhandled, which beats a hung request leaving a spinner on
    screen for axe to measure.
  */
  await page.route("**/api/v1/**", (route) => route.fulfill(json({})));

  await page.route("**/api/v1/auth/refresh", (route) =>
    route.fulfill(json({ id_token: fakeIdToken(), refresh_token: null })),
  );
  await page.route("**/api/v1/me", (route) =>
    route.fulfill(json({ id: SUB, email: EMAIL, profile: PROFILE })),
  );
  await page.route("**/api/v1/chat/session", (route) =>
    route.request().method() === "DELETE"
      ? route.fulfill({ status: 204, body: "" })
      : route.fulfill(json({ voice_available: false, ...chat })),
  );
  /*
    The voice mint, refused.

    Chromium HAS WebRTC but there is no Anam to reach, so the useful thing to
    stub is a refusal — which exercises the fallback path real users hit on a
    bad network, and is the right a11y surface to run axe over. Declared BEFORE
    the catch-all below, which would otherwise answer it with an empty 200.
  */
  await page.route("**/api/v1/chat/voice/session", (route) =>
    route.request().method() === "POST"
      ? route.fulfill(
          json(
            {
              type: "https://rithm.dev/errors/voice-unavailable",
              title: "Voice could not start just now.",
              status: 503,
              detail: "Voice could not start just now. You can still chat.",
            },
            503,
          ),
        )
      : route.fulfill({ status: 204, body: "" }),
  );
  // The library list is a bare array with pagination in headers.
  await page.route("**/api/v1/tracks**", (route) => route.fulfill(json([])));
}

export const EMPTY_DRAFT: Record<string, unknown> = {
  prompt: null,
  title: null,
  genre: null,
  mood: null,
  instruments: [],
  length_seconds: null,
  bpm_min: null,
  bpm_max: null,
  lyrics_mode: null,
  voice: null,
  lyrics: null,
  lyrics_prompt: null,
};
