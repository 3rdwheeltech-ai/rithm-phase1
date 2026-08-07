import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { login, signup } from "../lib/api";
import { useLens } from "../lib/useLens";
import { mergeRefs, useSpecular } from "../lib/useSpecular";

// Must match the API's CURRENT_CONSENT_VERSION (api/app/config.py).
const CONSENT_VERSION = "tos-2026-05";

export default function Signup() {
  const nav = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const lensRef = useLens<HTMLDivElement>("md", 24);
  const specularRef = useSpecular<HTMLDivElement>();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await signup({
        email,
        password,
        name,
        phone_number: phone,
        consent_version: CONSENT_VERSION,
      });
      // Auto-login straight into the studio after signup.
      await login(email, password);
      nav("/", { replace: true });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-shell">
      <div
        ref={mergeRefs(lensRef, specularRef)}
        className="glass-card animate-rise px-6 pb-8 pt-9 sm:px-10 sm:pb-10 sm:pt-11"
      >
      <span className="wordmark mb-9">RITHM</span>

      <h1 className="mb-1.5 text-xl font-semibold leading-tight text-ink">
        Create account
      </h1>
      <p className="mb-7 text-sm text-ink-muted">Your studio is one step away</p>

      <form onSubmit={onSubmit} className="flex flex-col gap-2.5">
        <input
          type="text"
          className="glass-input"
          placeholder="Full name"
          aria-label="Full name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="name"
          required
        />
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
          type="tel"
          className="glass-input"
          placeholder="Phone — e.g. +14155550123"
          aria-label="Phone number"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          autoComplete="tel"
          pattern="\+[1-9]\d{1,14}"
          required
        />
        <input
          type="password"
          className="glass-input"
          placeholder="Password — 8+ chars, 1 uppercase, 1 digit"
          aria-label="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          required
        />
        <label className="mt-0.5 flex cursor-pointer select-none items-center gap-2.5 text-sm text-ink-faint">
          <input
            type="checkbox"
            className="h-4 w-4 flex-shrink-0 cursor-pointer accent-signal"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
          />
          I agree to the Terms of Service
        </label>
        {err && (
          <div className="rounded-[9px] border border-danger/25 bg-danger/[0.08] px-3 py-2.5 text-sm leading-normal text-danger">
            {err}
          </div>
        )}
        <button type="submit" className="btn-primary mt-1.5" disabled={busy || !agreed}>
          {busy ? "Creating account…" : "Get started"}
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-ink-faint">
        Already have an account?{" "}
        <Link
          to="/login"
          className="font-medium text-signal-bright transition-colors hover:text-white"
        >
          Sign in
        </Link>
      </p>
      </div>
    </div>
  );
}
