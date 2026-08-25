import { defineConfig, devices } from "@playwright/test";

/**
 * The accessibility gate for signed-in screens.
 *
 * `.pa11yci` covers /login and /signup and says why it stops there: the
 * signed-in routes need a real session, and covering them would mean either
 * checking a credential into the repo or asserting against a login form that
 * never resolves. That leaves the whole product behind the door untested for
 * contrast — and pa11y's own comment names exactly the thing that regresses:
 * "text over translucent glass is exactly the thing that regresses silently
 * when a tint gets nudged."
 *
 * This suite closes that gap WITHOUT a credential. Playwright can seed
 * localStorage and intercept every `/api/v1/**` call, so the app boots into a
 * fully rendered authed shell against fixtures, in a real browser, with real
 * CSS — which is what a contrast check needs and jsdom can never give.
 *
 * Runs against the production build, like pa11y does: the dev server serves
 * unminified CSS through a different pipeline, and it is the built stylesheet
 * that ships.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:4173",
    trace: "on-first-retry",
    // The desktop shell. AvatarPanel and ChatPanel have never rendered below
    // `lg`, so a default 1280x720 would test the mobile tab bar instead.
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run build && npx vite preview --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
