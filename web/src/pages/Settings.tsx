import { useEffect, useState } from "react";
import { Settings as SettingsIcon } from "lucide-react";
import { useMe, useUpdateProfile } from "../hooks/useMe";
import {
  PREFERENCE_QUESTIONS,
  questionPatch,
  questionValue,
} from "../lib/preferences";
import ChipSelect from "../components/ChipSelect";
import ErrorToast from "../components/ErrorToast";
import RouteSpinner from "../components/RouteSpinner";
import { DISPLAY_NAME_MAX_LENGTH, type Preferences, type Profile } from "../types/profile";
import type { ProfilePatch } from "../types/profile";

interface Draft {
  display_name: string;
  preferences: Preferences;
}

function toDraft(profile: Profile): Draft {
  return {
    display_name: profile.display_name,
    preferences: { ...profile.preferences },
  };
}

/** Order-insensitive for scalars, order-SENSITIVE for lists — the chip order is the user's. */
function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => item === b[i]);
  }
  return a === b;
}

/**
 * Build the patch from only what actually moved.
 *
 * Not just smaller: the server merges per key, so a diffed patch is what stops
 * two open tabs editing different sections from clobbering each other.
 */
function diff(draft: Draft, profile: Profile): ProfilePatch {
  const patch: ProfilePatch = {};

  if (draft.display_name !== profile.display_name) {
    patch.display_name = draft.display_name;
  }

  const changed: Partial<Preferences> = {};
  for (const question of PREFERENCE_QUESTIONS) {
    const key = question.key;
    if (!sameValue(draft.preferences[key], profile.preferences[key])) {
      Object.assign(changed, questionPatch(key, questionValue(draft.preferences, key)));
    }
  }
  if (Object.keys(changed).length > 0) patch.preferences = changed;

  return patch;
}

const SECTION_LABEL = "eyebrow";

export default function Settings() {
  const { data, isPending, isError, error } = useMe();
  const update = useUpdateProfile();

  const [draft, setDraft] = useState<Draft | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const profile = data?.profile ?? null;

  // Seed once the query lands, and re-seed whenever the server's document
  // changes underneath us — which includes our own successful save, so a
  // completed save is what clears the dirty state.
  useEffect(() => {
    if (profile) setDraft(toDraft(profile));
  }, [profile]);

  if (isPending) return <RouteSpinner label="Loading your settings…" />;
  if (isError) {
    return (
      <div className="flex flex-1 items-center justify-center py-6">
        <p className="text-sm text-ink-muted">
          {(error as Error).message || "Could not load your settings."}
        </p>
      </div>
    );
  }
  if (!draft) return <RouteSpinner label="Loading your settings…" />;

  const patch = diff(draft, data.profile);
  const dirty = Object.keys(patch).length > 0;

  function setPreference(key: keyof Preferences, next: string[]) {
    setDraft((current) =>
      current
        ? {
            ...current,
            preferences: { ...current.preferences, ...questionPatch(key, next) },
          }
        : current,
    );
  }

  return (
    <div className="flex flex-1 flex-col py-6 sm:py-8">
      {!dismissed && (
        <ErrorToast error={update.error} onDismiss={() => setDismissed(true)} />
      )}

      <div className="mx-auto w-full max-w-[720px] animate-fade-in">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-el border border-signal/25 bg-signal/15 text-signal-bright">
            <SettingsIcon className="h-5 w-5" strokeWidth={1.75} />
          </span>
          <div className="min-w-0">
            <h1 className="font-display text-xl font-semibold text-ink">Settings</h1>
            <p className="text-sm text-ink-muted">Your account and what you like to make</p>
          </div>
        </div>

        {/* ── Account ───────────────────────────────────────────────── */}
        {/* `surface` rather than a lensed tier: the rail is already this
            route's glass, and the tier budget is roughly four on screen. */}
        <section className="surface mb-4 rounded-card p-5">
          <span className={SECTION_LABEL}>Account</span>

          <div className="mt-4 flex flex-col gap-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-ink-muted">Display name</span>
              <input
                type="text"
                className="glass-input"
                value={draft.display_name}
                maxLength={DISPLAY_NAME_MAX_LENGTH}
                autoComplete="name"
                placeholder="What should we call you?"
                onChange={(e) =>
                  setDraft((current) =>
                    current ? { ...current, display_name: e.target.value } : current,
                  )
                }
              />
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-ink-muted">Email</span>
              <input
                type="email"
                className="glass-input cursor-not-allowed text-ink-faint"
                value={data.email}
                readOnly
                disabled
              />
              <span className="text-2xs text-ink-faint">
                Your email is your sign-in, so it is not editable here.
              </span>
            </label>
          </div>
        </section>

        {/* ── Preferences ───────────────────────────────────────────── */}
        <section className="surface rounded-card p-5">
          <span className={SECTION_LABEL}>Music preferences</span>
          <p className="mt-1.5 text-sm text-ink-muted">
            The same questions you saw when you signed up. Blank is fine.
          </p>

          <div className="mt-5 flex flex-col gap-6">
            {PREFERENCE_QUESTIONS.map((question) => (
              <div key={question.key}>
                <span className="mb-2.5 block text-xs font-medium text-ink-muted">
                  {question.label}
                </span>
                <ChipSelect
                  options={question.options}
                  value={questionValue(draft.preferences, question.key)}
                  onChange={(next) => setPreference(question.key, next)}
                  single={question.single}
                  max={question.max}
                  ariaLabel={question.label}
                />
              </div>
            ))}
          </div>
        </section>

        {/* ── Save bar ──────────────────────────────────────────────── */}
        {/* Sticky and only present when dirty: a Save button that is always
            there and usually disabled is furniture, not an affordance. */}
        {dirty && (
          <div className="sticky bottom-4 mt-4 animate-rise">
            <div className="surface flex items-center justify-between gap-3 rounded-card px-4 py-3">
              <span className="text-sm text-ink-muted">You have unsaved changes</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setDraft(toDraft(data.profile))}
                  disabled={update.isPending}
                  className="btn-secondary"
                >
                  Discard
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDismissed(false);
                    update.mutate(patch);
                  }}
                  disabled={update.isPending}
                  className="btn-primary w-auto px-6 py-2.5 text-sm"
                >
                  {update.isPending ? "Saving…" : "Save changes"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
