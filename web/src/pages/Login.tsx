import { useState } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { login } from "../lib/api";
import { useLens } from "../lib/useLens";
import { mergeRefs, useSpecular } from "../lib/useSpecular";
import { GoogleLogo, AppleLogo, MicrosoftLogo } from "../components/SocialLogos";

// Social providers are visual placeholders for a future release.
const SOCIAL = [
  { name: "Google", Logo: GoogleLogo },
  { name: "Apple", Logo: AppleLogo },
  { name: "Microsoft", Logo: MicrosoftLogo },
];

export default function Login() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  // Honour the deep link the route guard was protecting. Relative paths only —
  // an absolute `next` would make this an open redirect.
  const rawNext = params.get("next") ?? "/";
  const next = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The sign-in card is the first glass the user ever sees, and it sits over the
  // field's brightest corner — the one place the material has to sell itself.
  const lensRef = useLens<HTMLDivElement>("md", 24);
  const specularRef = useSpecular<HTMLDivElement>();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await login(email, password);
      nav(next, { replace: true });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-shell">
      <div className="flex w-full max-w-5xl flex-col items-center gap-10 sm:gap-14 md:flex-row md:items-stretch md:justify-between md:gap-12">
      {/* Left — brand hero, no glass. Stretches to the card's height so the
          wordmark sits on its top edge and the tagline on its bottom edge. */}
      <div className="flex animate-fade-in flex-col text-center md:flex-1 md:justify-between md:text-left">
        <h1 className="wordmark-hero">RITHM</h1>
        <p className="mt-4 text-md font-medium tracking-wide text-ink-muted md:mt-0">
          Your AI music studio.
        </p>
      </div>

      {/* Right — sign-in glass card */}
      <div
        ref={mergeRefs(lensRef, specularRef)}
        className="glass-card animate-rise px-10 pb-10 pt-11"
      >
        <h2 className="mb-1.5 text-xl font-semibold leading-tight tracking-[-0.02em] text-ink">
          Welcome back
        </h2>
        <p className="mb-7 text-sm text-ink-muted">Sign in to your studio</p>

        <form onSubmit={onSubmit} className="flex flex-col gap-2.5">
          <input
            type="email"
            className="glass-input"
            placeholder="Email address"
          aria-label="Email address"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />
          <input
            type="password"
            className="glass-input"
            placeholder="Password"
          aria-label="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
          {err && (
            <div className="rounded-[9px] border border-danger/25 bg-danger/[0.08] px-3 py-2.5 text-sm leading-normal text-danger">
              {err}
            </div>
          )}
          <button type="submit" className="btn-primary mt-1.5" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <div className="my-5 flex items-center gap-3 text-xs text-ink-faint">
          <span className="h-px flex-1 bg-white/10" />
          or continue with
          <span className="h-px flex-1 bg-white/10" />
        </div>

        <div className="flex gap-2.5">
          {SOCIAL.map(({ name, Logo }) => (
            <button
              key={name}
              type="button"
              className="btn-social"
              aria-label={`Sign in with ${name}`}
              title="Coming soon"
            >
              <Logo className="h-5 w-5" />
            </button>
          ))}
        </div>

        <p className="mt-6 text-center text-sm text-ink-faint">
          No account?{" "}
          <Link
            to="/signup"
            className="font-medium text-signal-bright transition-colors hover:text-white"
          >
            Create one
          </Link>
        </p>
        </div>
      </div>
    </div>
  );
}
