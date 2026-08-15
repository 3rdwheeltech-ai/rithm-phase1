import { describe, expect, it } from "vitest";
import {
  EXPERIENCE_LEVELS,
  EXPERIENCE_LEVEL_LABELS,
  PRIMARY_INTENTS,
  PRIMARY_INTENT_LABELS,
  TYPICAL_LENGTHS,
  TYPICAL_LENGTH_LABELS,
  withProfileDefaults,
} from "./profile";
import { PREFERENCE_QUESTIONS } from "../lib/preferences";

/**
 * The onboarding vocabularies are duplicated across the tree boundary — the
 * other copy is `api/app/modules/identity/models.py`, which is itself pinned by
 * `tests/test_identity_profile.py`. Pinning both to the same literal list means
 * a drift fails a test instead of producing a 422 in front of a user mid-signup.
 *
 * Genres and moods are deliberately NOT re-pinned here: the profile reuses the
 * tuples from `./api`, which `api.test.ts` already covers.
 */
describe("profile vocabulary", () => {
  it("EXPERIENCE_LEVELS matches the API copy exactly, in order", () => {
    expect([...EXPERIENCE_LEVELS]).toEqual(["beginner", "hobbyist", "pro", "artist"]);
  });

  it("PRIMARY_INTENTS matches the API copy exactly, in order", () => {
    expect([...PRIMARY_INTENTS]).toEqual([
      "content",
      "songwriting",
      "scoring",
      "client",
      "exploring",
    ]);
  });

  it("TYPICAL_LENGTHS matches the API copy exactly, in order", () => {
    expect([...TYPICAL_LENGTHS]).toEqual(["short", "standard", "long"]);
  });

  it("every vocabulary member has a label — an unlabelled chip renders blank", () => {
    for (const level of EXPERIENCE_LEVELS) expect(EXPERIENCE_LEVEL_LABELS[level]).toBeTruthy();
    for (const intent of PRIMARY_INTENTS) expect(PRIMARY_INTENT_LABELS[intent]).toBeTruthy();
    for (const length of TYPICAL_LENGTHS) expect(TYPICAL_LENGTH_LABELS[length]).toBeTruthy();
  });
});

describe("preference questions", () => {
  it("covers every preference key exactly once", () => {
    // A missed key is a preference the user can never set OR clear, and the
    // Settings diff would never notice it.
    expect(PREFERENCE_QUESTIONS.map((q) => q.key)).toEqual([
      "experience_level",
      "genres",
      "moods",
      "primary_intent",
      "typical_length",
    ]);
  });

  it("caps the multi-select questions and only those", () => {
    for (const question of PREFERENCE_QUESTIONS) {
      expect(question.max === undefined).toBe(question.single);
    }
  });
});

describe("withProfileDefaults", () => {
  it("survives an API response that predates the profile field", () => {
    // The deploy window: new bundle, old API. Must not throw, and must not
    // shove an existing user into onboarding.
    const profile = withProfileDefaults(undefined);

    expect(profile.preferences).toEqual({
      experience_level: null,
      genres: [],
      moods: [],
      primary_intent: null,
      typical_length: null,
    });
    expect(profile.onboarding.completed_at).not.toBeNull();
    expect(profile.display_name).toBe("");
  });

  it("leaves a complete document untouched", () => {
    const real = {
      version: 1,
      display_name: "Ada",
      onboarding: { completed_at: "2026-08-15T10:04:11Z", skipped: false },
      preferences: {
        experience_level: "pro" as const,
        genres: ["Lo-Fi" as const],
        moods: [],
        primary_intent: null,
        typical_length: null,
      },
    };
    expect(withProfileDefaults(real)).toEqual(real);
  });

  it("still routes a genuinely new user into onboarding", () => {
    const profile = withProfileDefaults({
      onboarding: { completed_at: null, skipped: false },
    });
    expect(profile.onboarding.completed_at).toBeNull();
  });
});
