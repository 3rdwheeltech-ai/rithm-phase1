import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useMe, useUpdateProfile } from "../hooks/useMe";
import { useLens } from "../lib/useLens";
import { mergeRefs, useSpecular } from "../lib/useSpecular";
import { cn } from "../lib/cn";
import {
  PREFERENCE_QUESTIONS,
  questionPatch,
  questionValue,
} from "../lib/preferences";
import ChipSelect from "../components/ChipSelect";
import ErrorToast from "../components/ErrorToast";
import RouteSpinner from "../components/RouteSpinner";
import type { Preferences } from "../types/profile";

const EMPTY: Preferences = {
  experience_level: null,
  genres: [],
  moods: [],
  primary_intent: null,
  typical_length: null,
};

/**
 * First-run preferences. Five questions, one per screen, all skippable.
 *
 * Renders on `auth-shell` rather than inside Layout — same frame as Login and
 * Signup. No rail, no player, no tab bar: this screen has one job, and the
 * chrome would only offer ways to leave it half-finished.
 *
 * One PATCH at the end, not one per step. A user who closes the tab midway is
 * asked again next login, which is better than persisting two of five answers
 * as though they were a considered choice.
 */
export default function Onboarding() {
  const nav = useNavigate();
  const { data, isPending, isError } = useMe();
  const update = useUpdateProfile();

  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Preferences>(EMPTY);
  const [dismissed, setDismissed] = useState(false);

  const lensRef = useLens<HTMLDivElement>("md", 24);
  const specularRef = useSpecular<HTMLDivElement>();

  if (isPending) return <RouteSpinner label="Loading your preferences…" />;

  // The mirror of RequireOnboarding's predicate. Covers a bookmark, the back
  // button, and anyone who re-types the URL after finishing. `isError` is
  // deliberately not a redirect: failing open here would bounce the user into
  // a shell that RequireOnboarding also fails open on, and they would never be
  // asked at all.
  if (!isError && data.profile.onboarding.completed_at !== null) {
    return <Navigate to="/" replace />;
  }

  const question = PREFERENCE_QUESTIONS[step]!;
  const total = PREFERENCE_QUESTIONS.length;
  const last = step === total - 1;

  function submit(action: "complete" | "skip") {
    update.mutate(
      { preferences: draft, onboarding_action: action },
      { onSuccess: () => nav("/", { replace: true }) },
    );
  }

  function choose(next: string[]) {
    setDraft((current) => ({ ...current, ...questionPatch(question.key, next) }));
    // Single-answer steps advance themselves — a tap is already an unambiguous
    // "this one", and making the user confirm it five times is five taps of
    // nothing. Multi-select can't: there is no way to know they are done.
    if (question.single) {
      window.setTimeout(() => setStep((s) => Math.min(s + 1, total - 1)), 180);
    }
  }

  return (
    <div className="auth-shell">
      {!dismissed && (
        <ErrorToast error={update.error} onDismiss={() => setDismissed(true)} />
      )}

      <div
        ref={mergeRefs(lensRef, specularRef)}
        className="lg-lens animate-rise w-full max-w-[480px] px-6 pb-8 pt-9 sm:px-10 sm:pb-10 sm:pt-11"
        style={{ "--r": "24px", "--pad": "16px" } as React.CSSProperties}
      >
        <div className="mb-7 flex items-baseline justify-between">
          <span className="wordmark">RITHM</span>
          <span className="eyebrow">
            {step + 1} of {total}
          </span>
        </div>

        {/* Progress — one segment per question, filled as they are passed. */}
        <div className="mb-8 flex gap-1.5" aria-hidden="true">
          {PREFERENCE_QUESTIONS.map((q, i) => (
            <span
              key={q.key}
              className={cn(
                "h-1 flex-1 rounded-full transition-colors duration-300",
                i <= step ? "bg-signal/60" : "bg-white/10",
              )}
            />
          ))}
        </div>

        {/* `key` replays the entrance animation as each question arrives. */}
        <div key={question.key} className="animate-fade-in">
          <h1 className="mb-1.5 text-xl font-semibold leading-tight text-ink">
            {question.title}
          </h1>
          <p className="mb-6 text-sm text-ink-muted">{question.subtitle}</p>

          <ChipSelect
            options={question.options}
            value={questionValue(draft, question.key)}
            onChange={choose}
            single={question.single}
            max={question.max}
            ariaLabel={question.label}
          />
        </div>

        <div className="mt-9 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => submit("skip")}
            disabled={update.isPending}
            className="text-sm font-medium text-ink-faint transition-colors hover:text-ink disabled:opacity-40"
          >
            Skip for now
          </button>

          <div className="flex items-center gap-2">
            {step > 0 && (
              <button
                type="button"
                onClick={() => setStep((s) => s - 1)}
                disabled={update.isPending}
                className="btn-secondary"
              >
                Back
              </button>
            )}
            <button
              type="button"
              onClick={() => (last ? submit("complete") : setStep((s) => s + 1))}
              disabled={update.isPending}
              // Never disabled on an unanswered question: every one of these is
              // optional, so a locked button would be a wall with no key.
              className="btn-primary w-auto px-6 py-2.5 text-sm"
            >
              {update.isPending ? "Saving…" : last ? "Finish" : "Continue"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
