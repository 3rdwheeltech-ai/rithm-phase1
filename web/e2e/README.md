# `npm run test:e2e` — the signed-in accessibility gate

`.pa11yci` covers `/login` and `/signup`, and its own comment says why it stops
there: the signed-in routes need a real session, so covering them would mean
checking a credential into the repo or asserting against a login form that
never resolves. Everything behind the door — the studio shell, the create form,
the chat panel — has therefore never had a contrast check, and pa11y's stated
purpose is precisely the thing that regresses there: *"text over translucent
glass is exactly the thing that regresses silently when a tint gets nudged."*

This suite closes that gap without a credential.

## How it works

`signed-in.ts` seeds `localStorage` with exactly what `store/auth.ts` persists —
a refresh token and an email, never an id token — and intercepts every
`/api/v1/**` call. `bootstrapSession()` then takes its real path: it finds no
token, POSTs `/auth/refresh`, and gets back one the client can decode. Nothing
inside the app is stubbed out; only the network is.

Fixtures, not a running API, so this needs no database, no Cognito and no AWS.

## Running it

```bash
npm run test:e2e
```

The Playwright config builds the app and serves it with `vite preview`, the way
pa11y is run — the dev server's CSS pipeline is not the one that ships, and it
is the built stylesheet a contrast check has to measure.

**First run on a fresh Linux box needs the browser's system libraries:**

```bash
npx playwright install --with-deps chromium   # needs sudo for the apt step
```

Without them Chromium is present but cannot start, and every test fails with
`error while loading shared libraries: libnspr4.so`. That is a missing OS
package, not a failing assertion.

## Scope

axe runs over the chat panel only, scoped by its accessible name. The shell
around it is Day-4 work with its own history; a violation there would otherwise
land on whoever next touches this feature. Widen it deliberately, not by
accident.
