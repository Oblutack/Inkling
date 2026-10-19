import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { newSignedInUser, summarizeText } from "./support/helpers";

// A summary in two languages. (The AI service here is a stub: each line of the summary comes back with "[Language] " in front;
// a line with SKIP is not translated, and a line with FIGURES comes back with its numbers changed. Every stub summary has the
// heading "Stub summary" and a line "Opening words: ..." with the first eight words of the text.)

const tags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

function card(page: Page, text: string): Locator {
  return page.getByTestId("document-card").filter({ hasText: text }).first();
}

async function openPanel(page: Page, text: string, match: string) {
  await page.goto("/dashboard");
  await summarizeText(page, text);
  const saved = card(page, match);
  await expect(saved).toBeVisible();
  await saved.getByRole("button", { name: "More" }).click();
  await saved.getByRole("button", { name: "Also in another language" }).click();
  return saved.getByTestId("bilingual-panel");
}

test.describe("two languages side by side", () => {
  test("the summary is shown line by line next to its translation, with the key words", async ({ page }) => {
    await newSignedInUser(page);
    const panel = await openPanel(page, "Rent notice deposit are explained in this short text.", "Rent notice deposit");
    await expect(panel.getByTestId("bilingual-result")).toHaveCount(0); // nothing is made until asked
    await panel.getByLabel("Second language").selectOption("German");
    await panel.getByRole("button", { name: "Show side by side" }).click();

    const rows = panel.getByTestId("bilingual-row");
    await expect(rows).toHaveCount(5);
    await expect(rows.first()).toContainText("Stub summary");
    await expect(rows.first()).toContainText("[German] Stub summary");
    await expect(rows.nth(2)).toContainText("Opening words: Rent notice deposit are explained in this short");
    await expect(rows.nth(2)).toContainText("[German] Opening words:");
    // a bullet keeps its form in both languages
    await expect(rows.nth(1).locator("p").first()).toHaveText(/^• /);
    await expect(rows.nth(1).locator("p").nth(1)).toContainText("• [German] Subject");
    await expect(panel.getByTestId("bilingual-vocabulary")).toContainText("Subject");
    await expect(panel.getByTestId("bilingual-vocabulary")).toContainText("[German] Subject");
    await expect(panel.getByTestId("bilingual-figures")).toHaveCount(0);
  });

  test("a line that was not translated says so, and a line whose figures changed is marked", async ({ page }) => {
    await newSignedInUser(page);
    const skipped = await openPanel(page, "SKIP these words are left untranslated here.", "SKIP these words");
    await skipped.getByRole("button", { name: "Show side by side" }).click();
    await expect(skipped.getByText("Not translated")).toHaveCount(1);

    const changed = await openPanel(page, "FIGURES 7 and 30 are written in this text.", "FIGURES 7 and 30");
    await changed.getByRole("button", { name: "Show side by side" }).click();
    const marked = changed.locator('[data-figures="changed"]');
    await expect(marked).toHaveCount(1);
    await expect(marked.getByTestId("bilingual-check")).toContainText("Check the figures in this line");
    await expect(changed.getByTestId("bilingual-figures")).toContainText("1 lines may have changed figures");
    await expect(marked).toContainText("[Spanish] Opening words: FIGURES 8 and 31");
  });

  test("a translation is shown again for free, another language is its own, and the old one goes with a new summary", async ({ page }) => {
    await newSignedInUser(page);
    const panel = await openPanel(page, "Lease terms are listed in this short text.", "Lease terms are");
    await panel.getByRole("button", { name: "Show side by side" }).click();
    await expect(panel.getByTestId("bilingual-row")).toHaveCount(5);
    await expect(panel.getByText(/^Made /)).toHaveCount(0);

    await page.reload();
    const saved = card(page, "Lease terms are");
    await saved.getByRole("button", { name: "More" }).click();
    await saved.getByRole("button", { name: "Also in another language" }).click();
    await saved.getByRole("button", { name: "Show side by side" }).click();
    await expect(saved.getByText(/^Made /)).toBeVisible();
    const usage = await (await page.request.get("http://localhost:18080/usage")).json();
    expect(usage.chats.used).toBe(1);

    await saved.getByLabel("Second language").selectOption("French");
    await expect(saved.getByTestId("bilingual-result")).toHaveCount(0);
    await saved.getByRole("button", { name: "Show side by side" }).click();
    await expect(saved.getByTestId("bilingual-row").first()).toContainText("[French]");
    await saved.getByRole("button", { name: "Translate again" }).click();
    await expect(saved.getByTestId("bilingual-row").first()).toContainText("[French]");
  });

  test("a failure is explained", async ({ page }) => {
    await newSignedInUser(page);
    const panel = await openPanel(page, "boom text that fails to translate here.", "boom text");
    await panel.getByRole("button", { name: "Show side by side" }).click();
    await expect(panel.getByRole("alert")).toBeVisible();
  });

  test("a study set, which has no summary, does not offer it", async ({ page }) => {
    await newSignedInUser(page);
    await page.goto("/dashboard");
    await page.getByRole("button", { name: "Study", exact: true }).click();
    await page.locator("#main-textarea").fill("Some words that are worth studying for the exam next week.");
    await page.getByRole("button", { name: /Make flashcards/ }).click();
    const set = page.getByTestId("document-card").first();
    await expect(set).toBeVisible();
    await set.getByRole("button", { name: "More" }).click();
    await expect(set.getByRole("button", { name: "Also in another language" })).toHaveCount(0);
  });

  test("the two languages have no accessibility violations", async ({ page }) => {
    await newSignedInUser(page);
    const panel = await openPanel(page, "FIGURES 7 and 30 are written in this text.", "FIGURES 7 and 30");
    await panel.getByRole("button", { name: "Show side by side" }).click();
    await expect(panel.getByTestId("bilingual-row").first()).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(tags).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});
