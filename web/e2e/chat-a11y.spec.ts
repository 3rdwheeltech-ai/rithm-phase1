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
 * Run axe over the panel and return what it found.
 *
 * Scoped to the panel by its accessible name rather than run page-wide: the
 * shell around it (sidebar, player, studio field) is Day-4 work with its own
 * history, and a failure there would land on whoever next touches the chat.
 */
async function violations(page: import("@playwright/test").Page): Promise<AxeViolation[]> {
  await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async () => {
    const panel = document.querySelector('[aria-label="AI assistant chat"]');
    if (!panel) throw new Error("the chat panel is not on the page");
    const axe = (window as unknown as { axe: { run: (ctx: Element, opts: object) => Promise<{ violations: AxeViolation[] }> } }).axe;
    const result = await axe.run(panel, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
    });
    return result.violations;
  });
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

  // And back again, from inside the conversation — the thing chat had no
  // control for at all.
  await page.getByRole("tab", { name: "Talk" }).click();
  await expect(page.getByRole("button", { name: "Talk" })).toBeVisible();
});
