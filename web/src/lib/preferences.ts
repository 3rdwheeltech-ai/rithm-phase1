/**
 * The five preference questions, defined once.
 *
 * Onboarding asks them one per screen; Settings stacks them in a card. Both
 * render from this list, which is what guarantees that what someone picked at
 * registration is exactly what they see later — including the option order.
 */

import type { ChipOption } from "../components/ChipSelect";
import { GENRES, MOODS, type Genre, type Mood } from "../types/api";
import {
  EXPERIENCE_LEVELS,
  EXPERIENCE_LEVEL_LABELS,
  MAX_GENRES,
  MAX_MOODS,
  PRIMARY_INTENTS,
  PRIMARY_INTENT_LABELS,
  TYPICAL_LENGTHS,
  TYPICAL_LENGTH_LABELS,
  type ExperienceLevel,
  type Preferences,
  type PrimaryIntent,
  type TypicalLength,
} from "../types/profile";

/** Vocabulary tuple + label map -> chip options, in vocabulary order. */
function options<T extends string>(
  values: readonly T[],
  labels: Record<T, string>,
): ChipOption<T>[] {
  return values.map((value) => ({ value, label: labels[value] }));
}

/** Genres and moods label themselves — the wire value IS the display name. */
function selfLabelled<T extends string>(values: readonly T[]): ChipOption<T>[] {
  return values.map((value) => ({ value, label: value }));
}

export const EXPERIENCE_OPTIONS = options<ExperienceLevel>(
  EXPERIENCE_LEVELS,
  EXPERIENCE_LEVEL_LABELS,
);
export const INTENT_OPTIONS = options<PrimaryIntent>(PRIMARY_INTENTS, PRIMARY_INTENT_LABELS);
export const LENGTH_OPTIONS = options<TypicalLength>(TYPICAL_LENGTHS, TYPICAL_LENGTH_LABELS);
export const GENRE_OPTIONS = selfLabelled<Genre>(GENRES);
export const MOOD_OPTIONS = selfLabelled<Mood>(MOODS);

/**
 * A question, described in the terms both screens need.
 *
 * `key` doubles as the patch key, so a question cannot be wired to the wrong
 * field. Values are read and written as arrays regardless of `single` —
 * ChipSelect speaks arrays, and the two adapters below are the only place the
 * scalar/array conversion happens.
 */
export interface PreferenceQuestion {
  key: keyof Preferences;
  /** Onboarding's headline. */
  title: string;
  /** Onboarding's one-line why-we-ask. */
  subtitle: string;
  /** Settings' section label. */
  label: string;
  options: ChipOption<string>[];
  single: boolean;
  max?: number;
}

export const PREFERENCE_QUESTIONS: PreferenceQuestion[] = [
  {
    key: "experience_level",
    title: "Where are you at?",
    subtitle: "It sets how much of the studio we put in front of you.",
    label: "Experience",
    options: EXPERIENCE_OPTIONS,
    single: true,
  },
  {
    key: "genres",
    title: "What do you make?",
    subtitle: `Pick up to ${MAX_GENRES}. These seed the styles we suggest first.`,
    label: "Genres",
    options: GENRE_OPTIONS,
    single: false,
    max: MAX_GENRES,
  },
  {
    key: "moods",
    title: "And how should it feel?",
    subtitle: `Up to ${MAX_MOODS}. The mood is half of what the model listens to.`,
    label: "Moods",
    options: MOOD_OPTIONS,
    single: false,
    max: MAX_MOODS,
  },
  {
    key: "primary_intent",
    title: "What brings you here?",
    subtitle: "So the tools you need are the ones you find first.",
    label: "What you're here for",
    options: INTENT_OPTIONS,
    single: true,
  },
  {
    key: "typical_length",
    title: "How long, usually?",
    subtitle: "We'll start the length slider there. You can always move it.",
    label: "Typical length",
    options: LENGTH_OPTIONS,
    single: true,
  },
];

/** Read a preference as the array ChipSelect wants, scalar or list alike. */
export function questionValue(prefs: Preferences, key: keyof Preferences): string[] {
  const current = prefs[key];
  if (Array.isArray(current)) return current;
  return current === null ? [] : [current];
}

/**
 * Write ChipSelect's array back into the shape the wire expects.
 *
 * Cast at the boundary: the vocabularies came from `Preferences` in the first
 * place, so a value can only be a member of its own question's option list —
 * but ChipSelect is generic over plain strings and cannot prove that.
 */
export function questionPatch(
  key: keyof Preferences,
  next: string[],
): Partial<Preferences> {
  const isList = key === "genres" || key === "moods";
  return {
    [key]: isList ? next : (next[0] ?? null),
  } as Partial<Preferences>;
}
