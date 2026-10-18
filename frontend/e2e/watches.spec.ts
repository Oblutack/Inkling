import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { API, newSignedInUser } from "./support/helpers";

// Watching a page. (The AI service here is a stub: a page at "changing.example" is different every time it is read, with two
// sentences that change; any other page stays as it is; "robots.example" asks not to be watched, "unreadable.example" cannot
// be opened.)

// A page that changes, at an address of its own for each test (the stub counts the reads of each address, and the tests share it).
const changing = () => `https://changing.example/terms-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const tags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

async function watchFromDashboard(page: Page, address: string) {
  await page.goto("/dashboard");
  await page.locator("#main-textarea").fill(address);
  await page.getByRole("button", { name: "Watch this page" }).click();
}

function cardOf(page: Page, title: string) {
  return page.getByTestId("watch-card").filter({ has: page.getByRole("heading", { name: title }) });
}

test.describe("watching a page", () => {
  test("a web address in the box can be watched, a text cannot, and the page is listed with its limit", async ({ page }) => {
    await newSignedInUser(page);
    const CHANGING = changing();
    await page.goto("/dashboard");
    await page.locator("#main-textarea").fill("Some pasted words about something.");
    await expect(page.getByRole("button", { name: "Watch this page" })).toHaveCount(0);
    await page.locator("#main-textarea").fill(CHANGING);
    await expect(page.getByRole("button", { name: "Watch this page" })).toBeVisible();
    await page.getByRole("button", { name: "Watch this page" }).click();

    await expect(page).toHaveURL(/\/watches\?added=1/);
    await expect(page.getByTestId("watch-added")).toContainText("You will get an email when something important changes");
    const card = cardOf(page, "Page from changing.example");
    await expect(card).toBeVisible();
    await expect(card.getByRole("link", { name: CHANGING })).toBeVisible();
    await expect(card).toContainText("No changes yet");
    await expect(page.getByTestId("watch-limit")).toHaveText("Watching 1 of 10 pages.");
    // It is in the navigation too.
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Watched pages" }).click();
    await expect(page).toHaveURL(/\/watches$/);
  });

  test("checking a changed page writes the change up, and each change opens into a comparison", async ({ page }) => {
    await newSignedInUser(page);
    const CHANGING = changing();
    await watchFromDashboard(page, CHANGING);
    const card = cardOf(page, "Page from changing.example");
    await expect(card).toBeVisible();

    await card.getByRole("button", { name: "Check now" }).click();
    await expect(card.getByTestId("watch-result")).toHaveText("Found 2 changes.");
    await expect(card).toContainText("Stub bottom line (same language): 2 changes.");
    await expect(card.getByRole("button", { name: "Changes (1)" })).toBeVisible();

    await card.getByRole("button", { name: "Changes (1)" }).click();
    const change = card.getByTestId("watch-change");
    await expect(change).toHaveCount(1);
    await expect(change).toContainText("High importance");
    await change.getByRole("button", { name: "Show the changes" }).click();
    await expect(change).toContainText("Terms, version 2.");
    await expect(change).toContainText("Previous version");

    // Another check, another change, newest first.
    await card.getByRole("button", { name: "Check now" }).click();
    await expect(card.getByTestId("watch-result")).toHaveText("Found 2 changes.");
    await expect(card.getByTestId("watch-change")).toHaveCount(2);
  });

  test("a page that has not changed says so", async ({ page }) => {
    await newSignedInUser(page);
    await watchFromDashboard(page, "https://stable.example/page");
    const card = cardOf(page, "Page from stable.example");
    await card.getByRole("button", { name: "Check now" }).click();
    await expect(card.getByTestId("watch-result")).toHaveText("No changes.");
    await card.getByRole("button", { name: "Changes (0)" }).click();
    await expect(card.getByTestId("watch-history")).toContainText("Nothing has changed since you started watching.");
  });

  test("a watch can be paused and resumed, checked less often, and removed", async ({ page }) => {
    await newSignedInUser(page);
    await watchFromDashboard(page, "https://stable.example/page");
    const card = cardOf(page, "Page from stable.example");

    await card.getByRole("button", { name: "Pause" }).click();
    await expect(card.getByText("Paused", { exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "Check now" })).toHaveCount(0);
    await card.getByRole("button", { name: "Resume" }).click();
    await expect(card.getByRole("button", { name: "Check now" })).toBeVisible();

    await card.getByRole("combobox", { name: /How often to check/ }).selectOption({ label: "Every week" });
    await page.reload();
    await expect(cardOf(page, "Page from stable.example").getByRole("combobox", { name: /How often to check/ })).toHaveValue("168");

    page.once("dialog", (dialog) => dialog.accept());
    await cardOf(page, "Page from stable.example").getByRole("button", { name: "Remove" }).click();
    await expect(page.getByTestId("watch-empty")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("watch-empty")).toContainText("You are not watching any pages yet");
  });

  test("a page that cannot be watched is refused with the reason, and nothing is added", async ({ page }) => {
    await newSignedInUser(page);
    await watchFromDashboard(page, "https://robots.example/page");
    await expect(page.getByRole("alert").filter({ hasText: "asks not to be checked automatically" })).toBeVisible();
    await expect(page).toHaveURL(/\/dashboard/);

    await page.locator("#main-textarea").fill("https://unreadable.example/page");
    await page.getByRole("button", { name: "Watch this page" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "was not found" })).toBeVisible();
    await page.goto("/watches");
    await expect(page.getByTestId("watch-empty")).toBeVisible();
  });

  test("a link in an email opens the watch with its history showing", async ({ page }) => {
    await newSignedInUser(page);
    const CHANGING = changing();
    await watchFromDashboard(page, CHANGING);
    const card = cardOf(page, "Page from changing.example");
    await card.getByRole("button", { name: "Check now" }).click();
    await expect(card.getByTestId("watch-result")).toBeVisible();

    const list = await (await page.request.get(`${API}/watches`)).json();
    await page.goto(`/watches?open=${list.watches[0].id}`);
    await expect(cardOf(page, "Page from changing.example").getByTestId("watch-change")).toHaveCount(1);
  });

  test("the same page cannot be watched twice", async ({ page }) => {
    await newSignedInUser(page);
    await watchFromDashboard(page, "https://stable.example/page");
    await expect(page).toHaveURL(/\/watches/);
    await watchFromDashboard(page, "https://stable.example/page");
    await expect(page.getByRole("alert").filter({ hasText: "already watching" })).toBeVisible();
  });

  test("a signed-out visitor is sent to log in", async ({ page }) => {
    await page.goto("/watches");
    await expect(page).toHaveURL(/\/login/);
  });

  test("the watched pages and an open change have no accessibility violations", async ({ page }) => {
    await newSignedInUser(page);
    const CHANGING = changing();
    await watchFromDashboard(page, CHANGING);
    const card = cardOf(page, "Page from changing.example");
    await card.getByRole("button", { name: "Check now" }).click();
    await expect(card.getByTestId("watch-result")).toBeVisible();
    await card.getByRole("button", { name: "Changes (1)" }).click();
    await card.getByRole("button", { name: "Show the changes" }).click();
    await expect(card.getByTestId("watch-change")).toContainText("Terms, version 2.");
    const results = await new AxeBuilder({ page }).withTags(tags).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});
