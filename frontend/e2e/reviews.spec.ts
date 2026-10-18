import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { API, newSignedInUser } from "./support/helpers";

// Spaced repetition: rate flashcards, come back to the ones that are due, and the emails a person chose to receive.
// (The AI service here is a stub: a study set has the cards "Front of card one", "Front of card two" and "Front of card three".)

const tags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

// A study set, made through the API with the browser's own session, so the test starts from a page that has one.
async function makeStudySet(page: Page, title = "Cell biology notes") {
  const response = await page.request.post(`${API}/study-sets/text`, {
    data: { text: `${title}\nCells are the basic unit of life.` },
    headers: { Origin: "http://localhost:13000" },
  });
  expect(response.status()).toBe(201);
  await page.goto("/dashboard");
  const card = page.getByTestId("document-card").filter({ has: page.getByRole("heading", { name: title }) });
  await card.getByRole("button", { name: "Flashcards" }).click();
  await expect(card.getByTestId("flashcard")).toContainText("Front of card one");
  return card;
}

async function waitUntilSettled(page: Page, testId: string) {
  // A card fades in; scanned halfway, its text is a lighter mix of colours and fails the contrast rule on a slow machine.
  await expect(page.getByTestId(testId)).toHaveCSS("opacity", "1");
}

test.describe("rating flashcards", () => {
  test("a card is flipped, rated, and the next one is shown with what is known of it", async ({ page }) => {
    await newSignedInUser(page);
    const card = await makeStudySet(page);

    await expect(card.getByTestId("card-status")).toContainText("Not reviewed yet");
    await expect(card.getByTestId("rate-card")).toHaveCount(0); // the buttons come once the answer is shown
    await card.getByTestId("flashcard").click();
    await expect(card.getByTestId("rate-card")).toBeVisible();
    await card.getByRole("button", { name: "Missed it" }).click();

    // On to the next card; the missed one is due for review.
    await expect(card.getByTestId("flashcard")).toContainText("Front of card two");
    await expect(card.getByTestId("flashcard-position")).toHaveText("2 / 3");
    await card.getByRole("button", { name: "Back", exact: true }).click();
    await expect(card.getByTestId("card-status")).toContainText("Due for review");
    await expect(card.getByTestId("card-status")).toContainText("Due for review: 1");

    await card.getByRole("button", { name: "Next", exact: true }).click();
    await card.getByTestId("flashcard").click();
    await card.getByRole("button", { name: "Knew it" }).click();
    await card.getByRole("button", { name: "Back", exact: true }).click();
    await expect(card.getByTestId("card-status")).toContainText("Box 2 of 6, next review");

    // It is kept: after a reload the same status is shown.
    await page.reload();
    await card.getByRole("button", { name: "Flashcards" }).click();
    await expect(card.getByTestId("card-status")).toContainText("Due for review: 1");
  });

  test("the rating buttons have no accessibility violations", async ({ page }) => {
    await newSignedInUser(page);
    const card = await makeStudySet(page);
    await card.getByTestId("flashcard").click();
    await expect(card.getByTestId("rate-card")).toBeVisible();
    await waitUntilSettled(page, "document-card");
    const results = await new AxeBuilder({ page }).include('[data-testid="document-card"]').withTags(tags).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});

test.describe("the review", () => {
  test("nothing is due for a new account, and the page says how to start", async ({ page }) => {
    await newSignedInUser(page);
    await expect(page.getByTestId("review-chip")).toHaveCount(0);
    await page.goto("/review");
    await expect(page.getByTestId("review-empty")).toContainText("Nothing is due for review");
  });

  test("due cards are reviewed from the dashboard, a missed card comes round again, and the streak counts", async ({ page }) => {
    await newSignedInUser(page);
    const card = await makeStudySet(page);
    // Rate the first card as missed: it is due today.
    await card.getByTestId("flashcard").click();
    await card.getByRole("button", { name: "Missed it" }).click();

    await page.reload();
    const chip = page.getByTestId("review-chip");
    await expect(chip).toContainText("Flashcards to review today: 1");
    await expect(chip).toContainText("Days in a row: 1");
    await chip.getByRole("link", { name: "Review now" }).click();

    await expect(page).toHaveURL(/\/review/);
    await expect(page.getByTestId("review-progress")).toHaveText("0 of 1");
    await expect(page.getByTestId("review-session")).toContainText("From: Cell biology notes");
    const reviewCard = page.getByTestId("review-card");
    await expect(reviewCard).toContainText("Front of card one");
    await reviewCard.click();
    await expect(reviewCard).toContainText("Back of card one");

    // Missed again: it is not finished, and comes round again.
    await page.getByRole("button", { name: "Missed it" }).click();
    await expect(page.getByTestId("review-progress")).toHaveText("0 of 1");
    await expect(reviewCard).toContainText("Front of card one");
    await reviewCard.click();
    await page.getByRole("button", { name: "Knew it" }).click();

    const finished = page.getByTestId("review-finished");
    await expect(finished).toContainText("Done for now!");
    await expect(finished).toContainText("Knew it first time: 0. Needed another look: 1.");
    await expect(finished).toContainText("Days in a row: 1");
  });

  test("it can be done with the keyboard", async ({ page }) => {
    await newSignedInUser(page);
    const card = await makeStudySet(page);
    await card.getByTestId("flashcard").click();
    await card.getByRole("button", { name: "Missed it" }).click();
    await page.goto("/review");

    const reviewCard = page.getByTestId("review-card");
    await expect(reviewCard).toContainText("Front of card one");
    await page.locator("body").press("Space");
    await expect(reviewCard).toContainText("Back of card one");
    await page.locator("body").press("2");
    await expect(page.getByTestId("review-finished")).toContainText("Knew it first time: 1. Needed another look: 0.");
  });

  test("a card is not due again until its time has come", async ({ page }) => {
    await newSignedInUser(page);
    const card = await makeStudySet(page);
    await card.getByTestId("flashcard").click();
    await card.getByRole("button", { name: "Knew it" }).click(); // known: due in two days, not today
    await page.goto("/review");
    await expect(page.getByTestId("review-empty")).toBeVisible();
    await page.goto("/dashboard");
    await expect(page.getByTestId("review-chip")).toContainText("Days in a row: 1");
    await expect(page.getByTestId("review-chip")).toContainText("All caught up");
    await expect(page.getByRole("link", { name: "Review now" })).toHaveCount(0);
  });

  test("the review pages have no accessibility violations", async ({ page }) => {
    await newSignedInUser(page);
    const card = await makeStudySet(page);
    await card.getByTestId("flashcard").click();
    await card.getByRole("button", { name: "Missed it" }).click();
    await page.goto("/review");
    await expect(page.getByTestId("review-card")).toBeVisible();
    let results = await new AxeBuilder({ page }).withTags(tags).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

    await page.getByTestId("review-card").click();
    await page.getByRole("button", { name: "Knew it" }).click();
    await expect(page.getByTestId("review-finished")).toBeVisible();
    results = await new AxeBuilder({ page }).withTags(tags).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  test("a signed-out visitor is sent to log in", async ({ page }) => {
    await page.goto("/review");
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe("emails from Inkling", () => {
  test("study reminders can be switched on and off, and the choice is kept", async ({ page }) => {
    await newSignedInUser(page);
    await page.goto("/account");
    const section = page.getByTestId("email-preferences");
    const reminders = section.getByRole("checkbox", { name: "Study reminders" });
    await expect(reminders).not.toBeChecked(); // off until asked for
    await expect(section).toContainText("Your time zone:");

    await reminders.check();
    await expect(section.getByText("Saved.")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("email-preferences").getByRole("checkbox", { name: "Study reminders" })).toBeChecked();

    await page.getByTestId("email-preferences").getByRole("checkbox", { name: "Study reminders" }).uncheck();
    await page.reload();
    await expect(page.getByTestId("email-preferences").getByRole("checkbox", { name: "Study reminders" })).not.toBeChecked();
  });

  test("the account page section has no accessibility violations", async ({ page }) => {
    await newSignedInUser(page);
    await page.goto("/account");
    await expect(page.getByTestId("email-preferences").getByRole("checkbox")).toBeVisible();
    const results = await new AxeBuilder({ page }).include('[data-testid="email-preferences"]').withTags(tags).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  test("the unsubscribe link needs no login and sends its token and kind", async ({ page }) => {
    const sent: unknown[] = [];
    await page.route("**/email/unsubscribe", async (route) => {
      sent.push(route.request().postDataJSON());
      await route.fulfill({ json: { ok: true } });
    });
    await page.goto("/unsubscribe?token=a-long-token-from-an-email&kind=reminders");
    await expect(page.getByRole("status")).toContainText("You will not get these emails any more");
    expect(sent).toEqual([{ token: "a-long-token-from-an-email", kind: "reminders" }]);
    const results = await new AxeBuilder({ page }).withTags(tags).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  test("an unsubscribe link without a token says it did not work", async ({ page }) => {
    await page.goto("/unsubscribe");
    await expect(page.getByRole("alert").filter({ hasText: "That link did not work" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Email settings" })).toBeVisible();
  });
});
