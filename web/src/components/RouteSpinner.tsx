/**
 * The waiting state for a route guard.
 *
 * Extracted so ProtectedRoute and RequireOnboarding render IDENTICAL markup:
 * they run back to back on a cold load (restore the session, then fetch the
 * profile), and two spinners that differ by a pixel read as a flash rather than
 * one continuous wait.
 */
export default function RouteSpinner({ label }: { label: string }) {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center" aria-busy="true">
      <span className="sr-only">{label}</span>
      <span className="h-6 w-6 rounded-full border-2 border-white/15 border-t-signal-bright motion-safe:animate-spin" />
    </div>
  );
}
