import { useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { ApiError } from "../lib/api";
import { humaniseSeconds } from "../lib/track";

function numeric(extras: Record<string, unknown>, key: string): number | null {
  const value = extras[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Turns an ApiError into the one sentence a user can act on.
 *
 * The 429 numbers come from the problem body's machine-readable extras, never
 * from parsing the prose — the prose is free to change, and a header cannot be
 * read cross-origin unless CORS exposes it.
 */
export function errorMessage(error: unknown): { message: string; requestId?: string } | null {
  if (!(error instanceof ApiError)) {
    if (error instanceof Error) return { message: error.message };
    return null;
  }

  switch (error.status) {
    case 401:
      // Silent: the client is already logging them out.
      return null;

    case 429: {
      const limit = numeric(error.extras, "limit");
      const retryAfter = numeric(error.extras, "retry_after_seconds");
      const allowance = limit === null ? "all your" : `all ${limit}`;
      const when = retryAfter === null ? "later" : `in ${humaniseSeconds(retryAfter)}`;
      return { message: `You've used ${allowance} generations for today. Try again ${when}.` };
    }

    case 503:
      // The job row is already FAILED, so retrying is both safe and correct.
      return { message: "We couldn't queue that one. Please try again." };

    case 404:
      return { message: "That track is no longer available." };

    case 400:
      // 400s are actionable by construction — show exactly what the API said.
      return { message: error.detail || error.title };

    case 422:
      return { message: error.message };

    default:
      if (error.status >= 500) {
        return { message: "Something went wrong on our side.", requestId: error.requestId };
      }
      return { message: error.message };
  }
}

export default function ErrorToast({
  error,
  onDismiss,
}: {
  error: unknown;
  onDismiss: () => void;
}) {
  const rendered = errorMessage(error);

  useEffect(() => {
    if (!rendered) return;
    const id = setTimeout(onDismiss, 8000);
    return () => clearTimeout(id);
  }, [rendered, onDismiss]);

  // A 404 should also drop the stale list, but that invalidation belongs to the
  // caller that knows which query produced it.
  if (!rendered) return null;
  if (typeof document === "undefined") return null;

  // Portalled for the same reason as <JobProgress>: every caller mounts this
  // inside a card with a backdrop-filter, which is a containing block for
  // `fixed`, so in place it anchored to the card instead of the viewport.
  return createPortal(
    <div
      role="alert"
      // `--dock` is the room the mobile tab bar and mini player occupy; the
      // toast has to clear them or it lands underneath. Unset off the app shell
      // (the auth pages), where the fallback applies.
      className="fixed bottom-[calc(env(safe-area-inset-bottom)+var(--dock,20px)+12px)] left-1/2 z-[60] w-[min(420px,calc(100vw-32px))] -translate-x-1/2 animate-rise lg:bottom-5"
    >
      <div className="lg-lens flex items-start gap-3 border border-danger/25 p-3.5">
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-snug text-ink">{rendered.message}</p>
          {rendered.requestId && (
            // What makes a support message answerable from CloudWatch.
            <p className="mt-1 font-mono text-2xs tabular-nums text-ink-faint">
              Reference: {rendered.requestId}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-white/[0.08] hover:text-ink"
        >
          <X className="h-4 w-4" strokeWidth={2} />
        </button>
      </div>
    </div>,
    document.body,
  );
}
