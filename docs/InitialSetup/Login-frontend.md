# SPEC: Section D — Frontend (Apple Liquid Glass UI)
**Scope:** All `web/src` files for the login → signup → homepage flow.  
All auth logic is identical to Section D. Only the visual layer is new.

---

## Design intent

Dark void background (#06060e) with three large soft-blurred colour blobs underneath
(deep violet, electric indigo, warm purple) — these are the "liquid" the glass blurs.  
Cards use `backdrop-filter: blur + saturate` to refract those colours, a bright
specular line at the top rim, an internal gradient to simulate light depth, and
multi-layered shadows for float. Inputs are recessed (inset shadow). The primary
button has a brand-colour bloom. Typography is DM Sans (Google Fonts) — geometric,
clean, distinctly not Inter.

---

## Dependencies

```bash
cd web
npm install react-router-dom zustand
```

---

## Files that do NOT change from Section D

These are identical — copy them as-is:

- `web/src/store/auth.ts`
- `web/src/lib/api.ts`
- `web/src/components/ProtectedRoute.tsx`
- `web/src/App.tsx`

---

## `web/.env`

```bash
VITE_API_BASE=http://localhost:8000
```

---

## `web/src/index.css`

Replace the entire file:

```css
/* ── Google Fonts ───────────────────────────────────────────────────────── */
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500;9..40,600;9..40,700&display=swap');

/* ── Design tokens ──────────────────────────────────────────────────────── */
:root {
  --brand-rgb: 108, 92, 231;
  --brand: rgb(var(--brand-rgb));

  --bg: #06060e;
  --surface: rgba(255, 255, 255, 0.055);
  --border: rgba(255, 255, 255, 0.10);
  --border-focus: rgba(var(--brand-rgb), 0.52);

  --text:   #eaeaec;
  --text-2: rgba(234, 234, 236, 0.48);
  --text-3: rgba(234, 234, 236, 0.26);

  --r-card: 22px;
  --r-el:   12px;
}

/* ── Reset ──────────────────────────────────────────────────────────────── */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

/* ── Background ─────────────────────────────────────────────────────────── */
html { height: 100%; }

body {
  min-height: 100%;
  font-family: 'DM Sans', system-ui, -apple-system, sans-serif;
  background-color: var(--bg);
  color: var(--text);
  display: flex;
  align-items: center;
  justify-content: center;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  overflow-x: hidden;
}

/*
  Ambient colour field — three overlapping blobs that the glass card blurs
  and refracts. Positioning is deliberately asymmetric for organic depth.
*/
body::before {
  content: '';
  position: fixed;
  inset: 0;
  background:
    radial-gradient(ellipse 75% 65% at 15%  8%,  rgba(72,  52, 210, 0.38) 0%, transparent 60%),
    radial-gradient(ellipse 55% 70% at 82%  88%, rgba(28,  55, 215, 0.24) 0%, transparent 55%),
    radial-gradient(ellipse 50% 55% at 62%  28%, rgba(145, 48, 205, 0.20) 0%, transparent 52%);
  pointer-events: none;
  z-index: 0;
}

#root {
  position: relative;
  z-index: 1;
  width: 100%;
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px 20px;
}

/* ── Glass card ─────────────────────────────────────────────────────────── */
.card {
  position: relative;
  width: 100%;
  max-width: 400px;
  padding: 44px 40px 40px;
  overflow: hidden;

  /* Glass fill — dark tinted, not pure white */
  background: rgba(10, 10, 20, 0.42);
  backdrop-filter: blur(56px) saturate(190%) brightness(1.06);
  -webkit-backdrop-filter: blur(56px) saturate(190%) brightness(1.06);

  border-radius: var(--r-card);
  border: 1px solid var(--border);

  box-shadow:
    /* inner rim */
    inset 0  1px 0 rgba(255, 255, 255, 0.10),
    inset 0 -1px 0 rgba(0,   0,   0,   0.22),
    /* float depth */
    0   4px   6px rgba(0, 0, 0, 0.22),
    0  14px  32px rgba(0, 0, 0, 0.38),
    0  44px  88px rgba(0, 0, 0, 0.42),
    /* brand ambient bloom */
    0   0  130px rgba(var(--brand-rgb), 0.09);
}

/*
  Top-edge specular — the bright line where light hits the glass rim.
  Centred and fading at both ends, like visionOS / Liquid Glass.
*/
.card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 8%;
  right: 8%;
  height: 1px;
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgba(255, 255, 255, 0.20) 15%,
    rgba(255, 255, 255, 0.58) 36%,
    rgba(255, 255, 255, 0.70) 50%,
    rgba(255, 255, 255, 0.58) 64%,
    rgba(255, 255, 255, 0.20) 85%,
    transparent 100%
  );
  pointer-events: none;
}

/*
  Internal reflection gradient — glass is lighter near the top-left
  (simulated overhead light source) and subtly darker at the bottom.
*/
.card::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: linear-gradient(
    165deg,
    rgba(255, 255, 255, 0.045) 0%,
    transparent                45%,
    rgba(0,   0,   0,   0.06)  100%
  );
  pointer-events: none;
}

/* ── Brand wordmark ─────────────────────────────────────────────────────── */
.brand {
  display: block;
  font-size: 11.5px;
  font-weight: 700;
  letter-spacing: 0.28em;
  text-transform: uppercase;
  color: rgba(255, 255, 255, 0.88);
  margin-bottom: 36px;
}

/* ── Page heading ───────────────────────────────────────────────────────── */
.card h1 {
  font-size: 23px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--text);
  margin-bottom: 6px;
  line-height: 1.25;
}

.tagline {
  font-size: 14px;
  color: var(--text-2);
  margin-bottom: 30px;
  font-weight: 400;
  line-height: 1.5;
}

/* ── Form ───────────────────────────────────────────────────────────────── */
form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* ── Inputs ─────────────────────────────────────────────────────────────── */
input[type="email"],
input[type="password"],
input[type="text"] {
  width: 100%;
  padding: 12px 14px;
  font-size: 14.5px;
  font-weight: 400;
  font-family: inherit;
  color: var(--text);
  outline: none;

  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--border);
  border-radius: var(--r-el);

  /* Recessed look */
  box-shadow:
    inset 0 1px 4px rgba(0, 0, 0, 0.42),
    inset 0 0 0 1px rgba(0, 0, 0, 0.08);

  transition:
    border-color 0.18s ease,
    background   0.18s ease,
    box-shadow   0.18s ease;
}

input::placeholder { color: var(--text-3); }

input:focus {
  background: rgba(255, 255, 255, 0.065);
  border-color: var(--border-focus);
  box-shadow:
    inset 0 1px 4px rgba(0, 0, 0, 0.30),
    0 0 0 3.5px rgba(var(--brand-rgb), 0.15);
}

/* ── Primary button ─────────────────────────────────────────────────────── */
.btn-primary {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  padding: 12px 16px;
  margin-top: 6px;
  font-size: 14.5px;
  font-weight: 600;
  font-family: inherit;
  letter-spacing: 0.005em;
  cursor: pointer;

  color: rgba(255, 255, 255, 0.95);
  background: linear-gradient(
    158deg,
    rgba(122, 104, 252, 0.92) 0%,
    rgba(90,  66, 218, 0.96)  100%
  );
  border: 1px solid rgba(162, 150, 255, 0.24);
  border-radius: var(--r-el);

  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.15),
    0 4px 16px rgba(var(--brand-rgb), 0.42),
    0 1px  4px rgba(0, 0, 0, 0.30);

  transition:
    opacity   0.15s ease,
    transform 0.15s ease,
    box-shadow 0.15s ease;
}

.btn-primary:hover:not(:disabled) {
  opacity: 0.9;
  transform: translateY(-1px);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.18),
    0 6px 24px rgba(var(--brand-rgb), 0.52),
    0 2px  8px rgba(0, 0, 0, 0.30);
}

.btn-primary:active:not(:disabled) {
  transform: translateY(0.5px);
  opacity: 0.85;
}

.btn-primary:disabled {
  opacity: 0.28;
  cursor: not-allowed;
  transform: none;
}

/* ── Secondary button ───────────────────────────────────────────────────── */
.btn-secondary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 9px 22px;
  font-size: 13.5px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;

  color: var(--text-2);
  background: rgba(255, 255, 255, 0.055);
  border: 1px solid rgba(255, 255, 255, 0.09);
  border-radius: 10px;

  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.22);
  transition: background 0.15s, color 0.15s;
}

.btn-secondary:hover {
  background: rgba(255, 255, 255, 0.09);
  color: var(--text);
}

/* ── Consent row ────────────────────────────────────────────────────────── */
.consent {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  color: var(--text-3);
  cursor: pointer;
  user-select: none;
  margin-top: 2px;
}

.consent input[type="checkbox"] {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  accent-color: var(--brand);
  cursor: pointer;
}

/* ── Error state ────────────────────────────────────────────────────────── */
.err {
  font-size: 13px;
  color: rgba(255, 105, 105, 0.92);
  background: rgba(255, 80, 80, 0.07);
  border: 1px solid rgba(255, 80, 80, 0.16);
  border-radius: 9px;
  padding: 9px 13px;
  line-height: 1.5;
}

/* ── Footer nav row ─────────────────────────────────────────────────────── */
.foot {
  font-size: 13px;
  color: var(--text-3);
  text-align: center;
  margin-top: 22px;
}

a {
  color: rgba(162, 150, 255, 0.88);
  text-decoration: none;
  font-weight: 500;
  transition: color 0.15s;
}

a:hover { color: rgba(182, 172, 255, 1); }

/* ── Divider ────────────────────────────────────────────────────────────── */
.divider {
  height: 1px;
  background: rgba(255, 255, 255, 0.06);
  margin: 24px 0;
}

/* ── Home — top row ─────────────────────────────────────────────────────── */
.home-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 28px;
  gap: 12px;
}

/* User presence pill */
.user-pill {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 4px 12px 4px 8px;
  border-radius: 100px;
  background: rgba(var(--brand-rgb), 0.10);
  border: 1px solid rgba(var(--brand-rgb), 0.18);
  font-size: 11.5px;
  font-weight: 500;
  color: rgba(195, 185, 255, 0.82);
  max-width: 200px;
}

.pill-dot {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: rgba(var(--brand-rgb), 0.85);
  box-shadow: 0 0 8px rgba(var(--brand-rgb), 0.65);
}

.pill-email {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── Studio placeholder ─────────────────────────────────────────────────── */
.studio {
  min-height: 148px;
  border-radius: 15px;
  border: 1px dashed rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.018);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  margin-bottom: 28px;
  padding: 32px;
}

.studio-icon {
  color: rgba(255, 255, 255, 0.16);
}

.studio p {
  font-size: 13px;
  color: var(--text-3);
  text-align: center;
  line-height: 1.7;
}
```

---

## `web/src/main.tsx`

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

---

## `web/src/App.tsx`

```tsx
import { BrowserRouter, Routes, Route } from "react-router-dom";
import Login          from "./pages/Login";
import Signup         from "./pages/Signup";
import Home           from "./pages/Home";
import ProtectedRoute from "./components/ProtectedRoute";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login"  element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/"       element={<ProtectedRoute><Home /></ProtectedRoute>} />
      </Routes>
    </BrowserRouter>
  );
}
```

---

## `web/src/pages/Login.tsx`

```tsx
import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { apiFetch } from "../lib/api";
import { useAuth } from "../store/auth";

export default function Login() {
  const nav    = useNavigate();
  const setAuth = useAuth((s) => s.setAuth);

  const [email,    setEmail]    = useState("");
  const [password, setPassword] = useState("");
  const [err,      setErr]      = useState<string | null>(null);
  const [busy,     setBusy]     = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const r = await apiFetch<{ id_token: string; refresh_token: string }>(
        "/api/v1/auth/login",
        { method: "POST", body: JSON.stringify({ email, password }) },
      );
      setAuth({ idToken: r.id_token, refreshToken: r.refresh_token, email });
      nav("/", { replace: true });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <span className="brand">RITHM</span>

      <h1>Welcome back</h1>
      <p className="tagline">Sign in to your studio</p>

      <form onSubmit={onSubmit}>
        <input
          type="email" placeholder="Email address"
          value={email} onChange={(e) => setEmail(e.target.value)}
          autoComplete="email" required
        />
        <input
          type="password" placeholder="Password"
          value={password} onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password" required
        />
        {err && <div className="err">{err}</div>}
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>

      <p className="foot">
        No account?&nbsp;<Link to="/signup">Create one</Link>
      </p>
    </div>
  );
}
```

---

## `web/src/pages/Signup.tsx`

```tsx
import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { apiFetch } from "../lib/api";
import { useAuth } from "../store/auth";

const CONSENT_VERSION = "tos-2026-05"; // must match API CURRENT_CONSENT_VERSION

export default function Signup() {
  const nav    = useNavigate();
  const setAuth = useAuth((s) => s.setAuth);

  const [email,    setEmail]    = useState("");
  const [password, setPassword] = useState("");
  const [agreed,   setAgreed]   = useState(false);
  const [err,      setErr]      = useState<string | null>(null);
  const [busy,     setBusy]     = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await apiFetch("/api/v1/auth/signup", {
        method: "POST",
        body: JSON.stringify({ email, password, consent_version: CONSENT_VERSION }),
      });
      // Auto-login straight into the studio after signup
      const r = await apiFetch<{ id_token: string; refresh_token: string }>(
        "/api/v1/auth/login",
        { method: "POST", body: JSON.stringify({ email, password }) },
      );
      setAuth({ idToken: r.id_token, refreshToken: r.refresh_token, email });
      nav("/", { replace: true });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <span className="brand">RITHM</span>

      <h1>Create account</h1>
      <p className="tagline">Your studio is one step away</p>

      <form onSubmit={onSubmit}>
        <input
          type="email" placeholder="Email address"
          value={email} onChange={(e) => setEmail(e.target.value)}
          autoComplete="email" required
        />
        <input
          type="password" placeholder="Password — 8+ chars, 1 uppercase, 1 digit"
          value={password} onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password" required
        />
        <label className="consent">
          <input
            type="checkbox" checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
          />
          I agree to the Terms of Service
        </label>
        {err && <div className="err">{err}</div>}
        <button type="submit" className="btn-primary" disabled={busy || !agreed}>
          {busy ? "Creating account…" : "Get started"}
        </button>
      </form>

      <p className="foot">
        Already have an account?&nbsp;<Link to="/login">Sign in</Link>
      </p>
    </div>
  );
}
```

---

## `web/src/pages/Home.tsx`

```tsx
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiFetch } from "../lib/api";
import { useAuth } from "../store/auth";

/* Minimal equaliser icon — suggests audio/music without being heavy-handed */
function WaveIcon() {
  return (
    <svg
      className="studio-icon"
      width="32" height="22" viewBox="0 0 32 22"
      fill="none" xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect x="0"  y="7"  width="4" height="8"  rx="2" fill="currentColor" />
      <rect x="7"  y="3"  width="4" height="16" rx="2" fill="currentColor" />
      <rect x="14" y="0"  width="4" height="22" rx="2" fill="currentColor" />
      <rect x="21" y="3"  width="4" height="16" rx="2" fill="currentColor" />
      <rect x="28" y="7"  width="4" height="8"  rx="2" fill="currentColor" />
    </svg>
  );
}

export default function Home() {
  const nav   = useNavigate();
  const clear = useAuth((s) => s.clear);

  const [me,  setMe]  = useState<{ email: string; user_id: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ email: string; user_id: string }>("/api/v1/me")
      .then(setMe)
      .catch((e) => setErr((e as Error).message));
  }, []);

  function logout() {
    clear();
    nav("/login", { replace: true });
  }

  return (
    <div className="card">
      {/* Top row: wordmark + user identity */}
      <div className="home-top">
        <span className="brand" style={{ margin: 0 }}>RITHM</span>
        {me && (
          <div className="user-pill">
            <span className="pill-dot" />
            <span className="pill-email">{me.email}</span>
          </div>
        )}
      </div>

      {/* Studio placeholder — generation lands here in Phase 2 */}
      <div className="studio">
        <WaveIcon />
        <p>
          Your studio is ready.<br />
          Music generation arrives in the next phase.
        </p>
      </div>

      {err && <div className="err" style={{ marginBottom: 16 }}>{err}</div>}

      <button className="btn-secondary" onClick={logout}>
        Sign out
      </button>
    </div>
  );
}
```

---

## Run

```bash
cd web
npm run dev
# → http://localhost:5173
```

---

## Verify

Open `http://localhost:5173` in a browser. Work through this checklist visually:

```
□ Page background is near-black with visible violet/indigo colour blobs
□ Glass card floats centered — frosted/blurred, NOT opaque white or solid dark
□ Bright specular line visible at the very top edge of the card (glass rim highlight)
□ Card casts a soft multi-layered shadow — no harsh single drop shadow
□ "RITHM" wordmark in small uppercase wide-tracked lettering at card top
□ Input fields look recessed (darker interior) vs the card surface
□ Focused input shows a soft brand-purple ring (not just a coloured border)
□ Sign in button has a purple-toned glow beneath it
□ Button lifts slightly on hover (translateY -1px)
□ /signup → tick consent → "Get started" → auto-logs-in → home page
□ Home page shows RITHM wordmark + user-pill with email + studio placeholder + Sign out
□ Sign out → returns to /login
□ Direct access to / with no token → redirected to /login (protected route working)
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Card is a solid dark rectangle — no blur/glass | Browser doesn't support `backdrop-filter`, or body background is fully opaque | Ensure body has the gradient pseudo-element from index.css; confirm in DevTools that `backdrop-filter` is not crossed out |
| `backdrop-filter` crossed out in DevTools | Firefox without the flag, or an old Chromium | Enable `layout.css.backdrop-filter.enabled` in Firefox `about:config`, or upgrade browser |
| DM Sans not loading — falling back to system font | No internet access or Google Fonts blocked | Self-host DM Sans via `npm install @fontsource/dm-sans` and swap the `@import` for `@import '@fontsource/dm-sans'` |
| Specular top line not visible | Contrast too low on the user's display | Check `.card::before` is present in computed styles; increase the rgba white values slightly |
| Layout broken on mobile | Viewport padding insufficient | Confirm `padding: 32px 20px` on `#root` and `max-width: 400px` on `.card` |

---

## Implementation deviations (implemented 2026-06-08)

This section records where the shipped code differs from the spec above. (Per
project convention, frontend deviations live here, not in `specDeviations.md`.)

### 1. Tailwind instead of raw CSS

- **Spec**: `index.css` is a single hand-written raw-CSS file; pages use semantic
  class names (`.card`, `.brand`, `.tagline`, `.foot`, …).
- **Code**: The project is already a Vite + **Tailwind** scaffold, so the visual
  layer was rebuilt with Tailwind for long-term maintainability. `tailwind.config.ts`
  carries the design tokens (brand colour, `void` bg, `DM Sans`, radii, `rise`/`fade-in`
  keyframes). `index.css` keeps the `@tailwind` directives plus two custom layers:
  `@layer base` (body background + ambient blob field + `#root` centering) and
  `@layer components` (`.glass-card`, `.glass-input`, `.btn-primary`, `.btn-secondary`,
  `.wordmark` — the verbose backdrop-filter / multi-shadow / specular-rim effects that
  Tailwind expresses awkwardly). Pages compose these with utility classes. Visual intent
  (glass, specular rim, recessed inputs, brand bloom) is preserved 1:1.

### 2. Signup form collects `name` and `phone_number`

- **Spec**: `Signup.tsx` posts only `{ email, password, consent_version }`.
- **Code**: The real dev Cognito pool requires `name` and `phone_number` at signup
  (see `specDeviations.md` §11). The form therefore adds a **Full name** text field and
  a **Phone** `tel` field (E.164, `pattern="\+[1-9]\d{1,14}"`, placeholder `+14155550123`),
  and posts `{ email, password, name, phone_number, consent_version }`. `given_name` is
  set server-side; the form does not collect it.

### 3. No `web/.env` / `VITE_API_BASE` — Vite proxy + relative paths

- **Spec**: Create `web/.env` with `VITE_API_BASE=http://localhost:8000`; `apiFetch`
  presumably prefixes it.
- **Code**: `web/vite.config.ts` already proxies `/api → http://localhost:8080`, so
  `apiFetch` calls **relative** paths (`/api/v1/...`). No env var and no CORS handling
  are needed in dev. (Backend also serves on **:8080**, not :8000.)

### 4. Error parsing reads RFC 7807 `title` / `detail`

- **Spec**: `apiFetch` is "copied from Section D" (absent from the repo) and pages do
  `setErr((e as Error).message)`.
- **Code**: `lib/api.ts` was written from scratch. It throws `Error(message)` where the
  message is parsed from the API's RFC 7807 problem+json: `title` for most errors, and
  the joined `detail[].msg` array for `422` validation failures (see `specDeviations.md` §8).

### 5. Session persisted to localStorage; `/me` shape; auto-redirects

- `store/auth.ts` (written from scratch) uses zustand `persist` (localStorage key
  `rithm-auth`) so reloads keep the session. `apiFetch` clears the store on a `401` to a
  token-bearing request, which makes `ProtectedRoute` bounce to `/login`.
- `Home.tsx` reads `/api/v1/me → { user_id, email, is_admin }` (spec assumed
  `{ email, user_id }`).
- `App.tsx` adds a `GuestOnly` wrapper (signed-in users are redirected away from
  `/login` / `/signup`) and a catch-all `*` → `/`.

### 6. Added missing ESLint config

- The repo shipped no `.eslintrc*`, so `npm run lint` failed with "ESLint couldn't find a
  configuration file" (pre-existing scaffold gap). Added `web/.eslintrc.cjs` (ESLint 8
  eslintrc format) wiring the already-installed plugins: `@typescript-eslint`,
  `react-hooks`, `jsx-a11y`, extending each `recommended` set. `npm run lint` and
  `npm run typecheck` now both pass clean.

### 7. Login page — split layout + social sign-in placeholders

- **Spec**: Login is a single centered glass card with the small `RITHM` wordmark inside it.
- **Code** (per user request): Login is now a two-column split (stacks on mobile):
  - **Left** (no glass): a `RITHM` hero wordmark in **Audiowide** (Google Fonts; `font-display`
    token; `.wordmark-hero`, white→brand gradient, `clamp(48px,8vw,92px)`, `letter-spacing:0.1em`).
    The left column stretches to the card height (`md:items-stretch` + `md:justify-between`) so the
    wordmark sits on the card's top edge and the tagline "Your AI music studio." on its bottom edge.
  - **Right**: the glass card, pushed to the right edge, now headed `Welcome back` (the small
    in-card wordmark was removed since the hero replaces it).
  - Added three **dummy** social sign-in buttons (Google / Apple / Microsoft brand SVGs in
    `components/SocialLogos.tsx`, styled by `.btn-social`) under an "or continue with" divider.
    They are visual placeholders for a future release — `title="Coming soon"`, no handler.
- `Signup.tsx` and `Home.tsx` are unchanged (still centered cards using the small `.wordmark`).

### 8. Home rebuilt as the studio shell (Perplexity-style)

- **Spec**: Home is a centered glass card (wordmark + user pill + "studio placeholder" + Sign out).
- **Code** (per user request): Home is now a full-screen app shell (`fixed inset-0 .app-bg`):
  - **Sidebar** (`components/Sidebar.tsx`): a `.glass-panel` rail that is icon-only by default and
    **expands on hover** (overlays content, no reflow). Audiowide `RITHM` mark at top (`R` →
    `RITHM`), nav items Home (active) / Create / Library / AI Tools / Discover as **visual
    placeholders** (lucide icons, no routes yet), and a bottom profile (avatar + email + `Sign out`
    → existing `clear()` → `/login`). Email comes from the live `GET /api/v1/me`.
  - **Quick generation** (`components/QuickGenerate.tsx`): a near-opaque dark `.quick-surface`
    wrapped in `.ai-frame` — a multi-hue (violet/cyan/magenta) conic **edge** border that slowly
    rotates + breathes (`@property --ai-angle`, `ai-spin`/`ai-breathe`; reduced-motion safe) with a
    soft perimeter halo. The opaque inner keeps the interior reading as glass (only the outline
    glows, with a touch seeping behind the prompt). Contains a prompt textarea, a full-width
    "Add lyric" dropdown (mock history + "Add custom lyric" → reveals a paste textarea), and a wide,
    centered gradient **Generate** button. Below the box sit Stitch-style example-prompt chips that
    fill the prompt on click. No in-box title.
  - **Heading**: "Have something <span class=text-ai>quick</span> in mind?" — the word *quick* uses
    a living multi-hue gradient text fill (`.text-ai`, `ai-flow`).
  - **Background**: subtle dot matrix + soft brand vignette (`.app-bg`).
- **Phase-2 stubs**: there is no generation backend yet, so **Generate** is UI-only (shows
  "Generation arrives in the next phase.") and the lyric history is sample data. The non-Home nav
  items don't navigate. The only live call remains `GET /api/v1/me`.

### 9. Home — right player rail, Recents box, Basic/Pro toggle

Added from the user's sketch (`docs/FrontendReferences/Image 08-06-26 at 19.30.png`); all
front-end, no new APIs.
- **Right player rail** (`components/Player.tsx`): a persistent `.glass-panel` rail mirroring the
  sidebar (plain glass, **no glow**), `absolute right-3`, vertically centered. Starts **collapsed**
  (expand arrow top + play bottom); **hover (delayed) or the arrow expands**, the top-right button
  pins it collapsed. Expanded shows project label ("Recents") → mock lyrics → accent divider →
  title → progress bar + times → transport (back / play-pause / forward) → speed toggle (1×–2×).
  Static placeholder — play/pause + speed change local state only.
- **Recents box** (`components/Recents.tsx`): `.glass-panel` (no glow) below the quick-gen box,
  same width: "Recents" label (left), 3 mock track cards (waveform glyph → play on hover), and a
  "Library ↗" button (right) — placeholder (`title="Coming soon"`, no route).
- **Basic/Pro toggle** (`components/ModeToggle.tsx`): segmented pill at top-center; visual only.
  **Pro** wraps the pill in `.ai-frame-soft` — a subtler sibling of `.ai-frame` (thinner border,
  smaller/lower-opacity halo, slower spin).
- **Hover-intent** (`lib/useHoverIntent.ts`): expands after a short delay, collapses immediately;
  used by both the Player and the Sidebar (the latter moved from CSS `:hover` to JS-controlled
  width for the delay).
- Layout: `Home.tsx` `main` now reserves a right margin for the collapsed player; the rail overlays
  on expand (no reflow), like the sidebar.