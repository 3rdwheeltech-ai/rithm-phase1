# RITHM web

React 18 + Vite + Tailwind SPA. TanStack Query owns server state; Zustand owns
client-only state (auth session, player position, UI toggles).

## Running locally

```bash
npm install
npm run dev            # http://localhost:5173, proxies /api → http://localhost:8080
```

The API must be up. With the repo's compose stack:

```bash
docker compose up -d --wait     # postgres + localstack + api on :8080
```

To develop against deployed infrastructure instead of a local API:

```bash
VITE_DEV_API_TARGET=http://<ALB_DNS> npm run dev
```

## The API base is relative, always

`lib/api.ts` uses `API_BASE = "/api/v1"` and nothing else. In production
CloudFront serves this SPA at `/` and proxies `/api/*` to the ALB, so the SPA
and the API are same-origin; the Vite proxy above mirrors that shape in dev.

Two consequences worth knowing before you debug something:

- **Never bake an origin into the bundle.** A build that has to know its own URL
  cannot be promoted between environments.
- **There is no CORS in production.** The API's `CORS_ALLOWED_ORIGINS` exists
  only so `npm run dev` works. If you hit a CORS error, you have set an absolute
  API base somewhere — fix that, do not add a CORS entry.

## Scripts

| Command | What it gates |
|---|---|
| `npm run lint` | eslint incl. `jsx-a11y`, `--max-warnings 0` |
| `npm run typecheck` | `tsc --noEmit`, strict |
| `npm test` | vitest (jsdom) |
| `npm run build` | `tsc && vite build` — a type-clean app that does not build is not shippable |

`npm run test:e2e` (Playwright) and `npm run a11y` (pa11y-ci) are scripted but
not configured yet — deferred past launch.

## Sessions

The id token lives **in memory only**; it is the credential that spends GPU
budget, so an XSS payload cannot lift it out of `localStorage`. The refresh
token and the account email are persisted under `rithm-auth` so a reload keeps
you signed in — the email rides along because `POST /auth/refresh` needs it to
resolve the Cognito SECRET_HASH.

`bootstrapSession()` runs once at start-up and exchanges the refresh token; the
route guard renders a loading state until it settles, which is what makes a
deep link survive a hard refresh.
