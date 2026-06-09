import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { apiFetch } from "../lib/api";
import { useAuth } from "../store/auth";
import { GoogleLogo, AppleLogo, MicrosoftLogo } from "../components/SocialLogos";

interface TokenResponse {
  id_token: string;
  refresh_token: string;
}

// Social providers are visual placeholders for a future release.
const SOCIAL = [
  { name: "Google", Logo: GoogleLogo },
  { name: "Apple", Logo: AppleLogo },
  { name: "Microsoft", Logo: MicrosoftLogo },
];

export default function Login() {
  const nav = useNavigate();
  const setAuth = useAuth((s) => s.setAuth);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const r = await apiFetch<TokenResponse>("/api/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      setAuth({ idToken: r.id_token, refreshToken: r.refresh_token, email });
      nav("/", { replace: true });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex w-full max-w-5xl flex-col items-center gap-14 px-2 md:flex-row md:items-stretch md:justify-between md:gap-12">
      {/* Left — brand hero, no glass. Stretches to the card's height so the
          wordmark sits on its top edge and the tagline on its bottom edge. */}
      <div className="flex animate-fade-in flex-col text-center md:flex-1 md:justify-between md:text-left">
        <h1 className="wordmark-hero">RITHM</h1>
        <p className="mt-4 text-[15px] font-medium tracking-wide text-ink-muted md:mt-0">
          Your AI music studio.
        </p>
      </div>

      {/* Right — sign-in glass card */}
      <div className="glass-card animate-rise px-10 pb-10 pt-11">
        <h2 className="mb-1.5 text-[23px] font-semibold leading-tight tracking-[-0.02em] text-ink">
          Welcome back
        </h2>
        <p className="mb-7 text-sm text-ink-muted">Sign in to your studio</p>

        <form onSubmit={onSubmit} className="flex flex-col gap-2.5">
          <input
            type="email"
            className="glass-input"
            placeholder="Email address"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />
          <input
            type="password"
            className="glass-input"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
          {err && (
            <div className="rounded-[9px] border border-red-400/20 bg-red-400/[0.07] px-3 py-2.5 text-[13px] leading-normal text-red-300">
              {err}
            </div>
          )}
          <button type="submit" className="btn-primary mt-1.5" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <div className="my-5 flex items-center gap-3 text-[12px] text-ink-faint">
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

        <p className="mt-6 text-center text-[13px] text-ink-faint">
          No account?{" "}
          <Link
            to="/signup"
            className="font-medium text-brand-soft transition-colors hover:text-white"
          >
            Create one
          </Link>
        </p>
      </div>
    </div>
  );
}
