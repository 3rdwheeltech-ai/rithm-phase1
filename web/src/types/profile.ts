/**
 * Wire types for the user profile document (`identity.users.profile`).
 *
 * The other copy is `api/app/modules/identity/models.py`. Genres and moods are
 * NOT redeclared here — they come from `./api`, which already carries the
 * pinned copy of that vocabulary. The three onboarding-only vocabularies below
 * are pinned by `profile.test.ts`, the same way `api.test.ts` pins its own.
 *
 * Labels live here rather than in the pages because both Onboarding and
 * Settings render the same questions, and two copies of "Just starting out" is
 * exactly how the two screens drift apart.
 */

import type { Genre, Mood } from "./api";

export const PROFILE_VERSION = 1;
export const DISPLAY_NAME_MAX_LENGTH = 128;
export const MAX_GENRES = 5;
export const MAX_MOODS = 5;

export const EXPERIENCE_LEVELS = ["beginner", "hobbyist", "pro", "artist"] as const;
export const PRIMARY_INTENTS = [
  "content",
  "songwriting",
  "scoring",
  "client",
  "exploring",
] as const;
export const TYPICAL_LENGTHS = ["short", "standard", "long"] as const;

export type ExperienceLevel = (typeof EXPERIENCE_LEVELS)[number];
export type PrimaryIntent = (typeof PRIMARY_INTENTS)[number];
export type TypicalLength = (typeof TYPICAL_LENGTHS)[number];

export const EXPERIENCE_LEVEL_LABELS: Record<ExperienceLevel, string> = {
  beginner: "Just starting out",
  hobbyist: "Hobbyist",
  pro: "Producer",
  artist: "Recording artist",
};

export const PRIMARY_INTENT_LABELS: Record<PrimaryIntent, string> = {
  content: "Content & social",
  songwriting: "Songwriting & demos",
  scoring: "Film, games & scoring",
  client: "Client & commercial work",
  exploring: "Just exploring",
};

export const TYPICAL_LENGTH_LABELS: Record<TypicalLength, string> = {
  short: "Short — around 30s",
  standard: "Standard — around 90s",
  long: "Long — up to 3 min",
};

export interface OnboardingState {
  /** ISO-8601, stamped by the server. `null` means the flow has never run. */
  completed_at: string | null;
  skipped: boolean;
}

export interface Preferences {
  experience_level: ExperienceLevel | null;
  genres: Genre[];
  moods: Mood[];
  primary_intent: PrimaryIntent | null;
  typical_length: TypicalLength | null;
}

export interface Profile {
  version: number;
  display_name: string;
  onboarding: OnboardingState;
  preferences: Preferences;
}

export interface MeResponse {
  user_id: string;
  email: string;
  is_admin: boolean;
  profile: Profile;
}

/**
 * Every key optional. An ABSENT key leaves the stored value alone; an explicit
 * `null` clears it. Send only what changed — the server merges per key, which
 * is what stops two open tabs from clobbering each other's sections.
 */
export interface ProfilePatch {
  display_name?: string;
  preferences?: Partial<Preferences>;
  /** The server stamps `completed_at` itself; there is no way to supply one. */
  onboarding_action?: "complete" | "skip";
}

export const EMPTY_PREFERENCES: Preferences = {
  experience_level: null,
  genres: [],
  moods: [],
  primary_intent: null,
  typical_length: null,
};

/**
 * Fill in anything the server did not send.
 *
 * The API normalizes the document too, so in steady state this is a no-op. It
 * exists for the DEPLOY WINDOW: deploy-web (S3 sync + invalidate) finishes
 * minutes before deploy-api (image build, migration task, services-stable), so
 * there is a stretch where this bundle is talking to an API that predates
 * `profile` entirely. Without this, `data.profile.onboarding` throws in render
 * and every signed-in user gets a white screen until the API catches up.
 *
 * A MISSING `onboarding` object and an explicit `completed_at: null` mean
 * opposite things, so they must not collapse into each other:
 *
 *   onboarding absent  -> old API, we do not know  -> sentinel, do NOT redirect
 *   completed_at null  -> new API, never onboarded -> null, DO redirect
 *
 * Getting that backwards either white-screens the app or marches every existing
 * user back through onboarding, which is why `??` alone is not enough here.
 */
const ONBOARDING_UNKNOWN = "";

export function withProfileDefaults(raw: Partial<Profile> | undefined | null): Profile {
  const onboarding = raw?.onboarding;

  return {
    version: raw?.version ?? PROFILE_VERSION,
    display_name: raw?.display_name ?? "",
    onboarding: onboarding
      ? {
          completed_at: onboarding.completed_at ?? null,
          skipped: onboarding.skipped ?? false,
        }
      : { completed_at: ONBOARDING_UNKNOWN, skipped: false },
    preferences: { ...EMPTY_PREFERENCES, ...(raw?.preferences ?? {}) },
  };
}
