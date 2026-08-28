import { expect, test } from "@playwright/test";
import { AXE_PATH, EMPTY_DRAFT, signIn, type ChatFixture } from "./signed-in";

/**
 * The open chat panel, checked with axe.
 *
 * NOTHING ELSE IN CI SEES THIS FEATURE. `.pa11yci` lists only /login and
 * /signup — its own comment explains that the signed-in routes need a real
 * session — and vitest runs in jsdom, which has no layout and therefore no
 * computed colours to contrast. `text-2xs` chips and `text-sm` bubbles over
 * smoked glass in a 245px column are precisely the thing pa11y exists to catch
 * and cannot reach.
 */

const RESUMED: ChatFixture = {
  session_id: "01J000000000000000000000S1",
  messages: [
    {
      id: "m0",
      role: "user",
      content: "a rainy late-night drive",
      created_at: "2026-08-25T12:00:00Z",
    },
    {
      id: "m1",
      role: "assistant",
      content: "Lovely — neon on wet asphalt. What genre fits it best?",
      created_at: "2026-08-25T12:00:01Z",
    },
  ],
  draft: { ...EMPTY_DRAFT, prompt: "a rainy late-night drive" },
  ready: false,
};

const READY: ChatFixture = {
  ...RESUMED,
  draft: {
    ...EMPTY_DRAFT,
    prompt: "a rainy late-night drive",
    title: "Neon Rooftop",
    genre: "Lo-Fi",
    mood: "Calm",
    instruments: ["piano", "rhodes", "drums"],
    length_seconds: 120,
    lyrics_mode: "instrumental",
    voice: "auto",
  },
  ready: true,
};

interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  nodes: { target: string[] }[];
}

/**
 * Run axe over one assistant panel and return what it found.
 *
 * Scoped by accessible name rather than run page-wide: the shell around it
 * (sidebar, player, studio field) is Day-4 work with its own history, and a
 * failure there would land on whoever next touches the assistant.
 *
 * `label` selects the door. The Talk side is a panel in its own right — it has
 * a video, a live transcript and its own controls — so it needs checking
 * separately rather than being assumed to inherit the chat panel's result.
 */
async function violations(
  page: import("@playwright/test").Page,
  label = "AI assistant chat",
): Promise<AxeViolation[]> {
  await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async (name: string) => {
    const panel = document.querySelector(`[aria-label="${name}"]`);
    if (!panel) throw new Error(`the "${name}" panel is not on the page`);
    const axe = (window as unknown as { axe: { run: (ctx: Element, opts: object) => Promise<{ violations: AxeViolation[] }> } }).axe;
    const result = await axe.run(panel, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
    });
    return result.violations;
  }, label);
}

function describeFailures(found: AxeViolation[]): string {
  return found
    .map((v) => `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.map((n) => n.target.join(" ")).join("\n    ")}`)
    .join("\n");
}

test("the open chat panel has no WCAG 2 AA violations", async ({ page }) => {
  await signIn(page, RESUMED);
  await page.goto("/");

  // The panel opens itself when the server returns a live transcript — that is
  // the reload-resume path, and it is also the shortest route to a populated
  // panel here.
  await expect(page.getByRole("region", { name: "AI assistant chat" })).toBeVisible();
  await expect(page.getByText("a rainy late-night drive")).toBeVisible();

  const found = await violations(page);
  expect(found, describeFailures(found)).toEqual([]);
});

test("the panel with a DraftCard has no WCAG 2 AA violations", async ({ page }) => {
  await signIn(page, READY);
  await page.goto("/");

  // The `.ai-frame` card, the `.lg-thin` instrument chips and the "+1 more"
  // count — the smallest text in the feature, on the busiest background.
  await expect(page.getByRole("button", { name: /Open in Create/ })).toBeVisible();

  const found = await violations(page);
  expect(found, describeFailures(found)).toEqual([]);
});

test("the avatar's two doors are reachable and labelled", async ({ page }) => {
  // `voice_available` is absent, i.e. false — the not-configured state, and
  // the reason this assertion needs no rewriting for the voice feature.
  await signIn(page, { session_id: null, messages: [], draft: EMPTY_DRAFT, ready: false });
  await page.goto("/");

  // Talk is no longer a dead control: it is the panel's primary action, and it
  // opens the Coming Soon dialog every other unbuilt feature gets.
  await page.getByRole("button", { name: "Talk" }).click();
  await expect(page.getByRole("dialog", { name: /Voice chat/ })).toBeVisible();
  await page.getByRole("button", { name: "Got it" }).click();

  // The toggle is a tablist, so it never collides with the button above.
  await page.getByRole("tab", { name: "Chat" }).click();
  await expect(page.getByRole("region", { name: "AI assistant chat" })).toBeVisible();

  const found = await violations(page);
  expect(found, describeFailures(found)).toEqual([]);

  // TWO ways back, and they must both work. The header X is the small one,
  // beside the reset it is styled after — and it closes the panel without
  // touching the conversation behind it.
  await page.getByRole("button", { name: "Close chat" }).click();
  await expect(page.getByRole("button", { name: "Talk" })).toBeVisible();
  await page.getByRole("tab", { name: "Chat" }).click();
  await expect(page.getByRole("region", { name: "AI assistant chat" })).toBeVisible();

  // And the toggle, from inside the conversation — the thing chat had no
  // control for at all.
  await page.getByRole("tab", { name: "Talk" }).click();
  await expect(page.getByRole("button", { name: "Talk" })).toBeVisible();
});


test("the voice stage falls back accessibly when the service cannot be reached", async ({
  page,
}) => {
  /*
    Chromium has WebRTC but there is no Anam behind it, so this exercises the
    `connect-failed` path — which is the one real users hit on a bad network,
    and therefore the right surface to run axe over.

    What must survive it: the panel is still the panel, Talk is still a real
    control, and the way to Chat has not moved. The conversation itself is
    never at risk, because it lives on the server.
  */
  await signIn(page, {
    session_id: null,
    messages: [],
    draft: EMPTY_DRAFT,
    ready: false,
    voice_available: true,
  });
  await page.goto("/");

  await page.getByRole("button", { name: "Talk" }).click();

  // Named, not a shrug. "Something went wrong" is what makes a graceful
  // fallback feel like a fault.
  await expect(page.getByText(/Couldn't reach the voice service/)).toBeVisible();
  await expect(page.getByRole("tab", { name: "Chat" })).toBeVisible();

  const found = await violations(page, "AI assistant");
  expect(found, describeFailures(found)).toEqual([]);
});

test("the voice SDK is not downloaded until Talk is pressed", async ({ page }) => {
  /*
    THE BUNDLE SPLIT, PROVEN AT THE NETWORK RATHER THAN INFERRED.

    `@anam-ai/js-sdk` is ~117 kB and is imported dynamically from exactly one
    file. The unit test asserts the module factory is not invoked; only a real
    browser can show that the CHUNK IS NEVER FETCHED — which is the thing that
    actually costs a desktop Home load.

    Both halves matter. If the first assertion breaks, every visitor pays for a
    feature most will not use. If the second breaks, the dynamic import is
    dead code and Talk cannot work at all.
  */
  const fetched: string[] = [];
  page.on("request", (r) => fetched.push(r.url()));

  await signIn(page, {
    session_id: null,
    messages: [],
    draft: EMPTY_DRAFT,
    ready: false,
    voice_available: true,
  });
  // Registered after signIn's, so it wins: a mint that SUCCEEDS, which is what
  // takes the code past the mint and into the dynamic import.
  await page.route("**/api/v1/chat/voice/session", (route) =>
    route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        session_token: "e2e-token",
        expires_in_seconds: 180,
        lease_id: "00000000-0000-7000-8000-0000000000e2",
      }),
    }),
  );

  await page.goto("/");
  await expect(page.getByRole("button", { name: "Talk" })).toBeEnabled();
  expect(fetched.filter((u) => /\/assets\/anam-.*\.js$/.test(u))).toEqual([]);

  await page.getByRole("button", { name: "Talk" }).click();

  await expect
    .poll(() => fetched.filter((u) => /\/assets\/anam-.*\.js$/.test(u)).length)
    .toBe(1);
});
