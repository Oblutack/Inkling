import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { newSignedInUser, pdf } from "./support/helpers";

// Studying without summarizing: the same box makes flashcards from pasted text, a web link or a file, and the document is
// saved with them, with no summary. (The AI service here is a stub: it answers with three flashcards or a three-question quiz.)

const NOTES = "Cell biology notes\nCells are the basic unit of life.";

function cardOf(page: Page, title: string) {
  return page.getByTestId("document-card").filter({ has: page.getByRole("heading", { name: title }) });
}

async function switchToStudy(page: Page) {
  await page.getByTestId("mode-switch").getByRole("button", { name: "Study" }).click();
}

// What an accessibility check found, one line each: the rule, the element and why. (A bare list of rule names does not
// say which element is at fault, which is what is needed to fix it.) On GitHub's runners the same lines are also written
// as an annotation, so they can be read without opening the log.
function violationsOf(results: Awaited<ReturnType<AxeBuilder["analyze"]>>): string[] {
  const found = results.violations.flatMap((v) =>
    v.nodes.map((n) => `${v.id}: ${v.help} -> ${n.target.join(" ")} (${(n.failureSummary ?? "").replace(/\s+/g, " ").trim()})`)
  );
  if (found.length > 0 && process.env.GITHUB_ACTIONS) console.log(`::error title=Accessibility check::${found.join(" ;; ").replace(/[\r\n%]/g, " ")}`);
  return found;
}

const makeCards = (page: Page) => page.getByRole("button", { name: "Make flashcards" }).click();

test.describe("study sets", () => {
  test("pasted text becomes flashcards, with no summary, and the options for a summary go away", async ({ page }) => {
    await newSignedInUser(page);
    await expect(page.getByText("Summary Word Count:")).toBeVisible();
    await switchToStudy(page);
    await expect(page.getByText("Summary Word Count:")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Summarize", exact: true })).toHaveCount(0);

    await page.locator("#main-textarea").fill(NOTES);
    await makeCards(page);

    // The new card opens on its flashcards at once, and says what it is.
    const card = cardOf(page, "Cell biology notes");
    await expect(card).toHaveCount(1);
    await expect(card.getByTestId("flashcard")).toContainText("Front of card one");
    await expect(card.getByTestId("study-set-note")).toContainText("Made for studying");
    // The box is emptied, so the same set is not made twice by a second click.
    await expect(page.locator("#main-textarea")).toHaveValue("");

    // What needs a summary is not offered; chat and study are.
    await expect(card.getByRole("button", { name: "Check against the original" })).toHaveCount(0);
    await expect(card.getByRole("button", { name: "Listen as a podcast" })).toHaveCount(0);
    await expect(card.getByRole("button", { name: "Chat With Document" })).toBeVisible();
    await card.getByRole("button", { name: "More" }).click();
    await expect(card.getByRole("button", { name: /Share/ })).toHaveCount(0);
    await expect(card.getByRole("button", { name: "Write a summary too" })).toBeVisible();

    // A quiz can be made from the same text.
    await card.getByRole("button", { name: "Quiz" }).click();
    await expect(card.getByTestId("quiz")).toContainText("Quiz question one?");
  });

  test("the cards can be downloaded as a file for a flashcard app", async ({ page }) => {
    await newSignedInUser(page);
    await switchToStudy(page);
    await page.locator("#main-textarea").fill(NOTES);
    await makeCards(page);
    const card = cardOf(page, "Cell biology notes");
    await expect(card.getByTestId("flashcard")).toBeVisible();

    const download = page.waitForEvent("download");
    await card.getByRole("button", { name: "Download the cards (CSV)" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe("Cell-biology-notes-flashcards.csv");
    const text = await readFile((await file.path())!, "utf8");
    expect(text).toBe("﻿Front of card one,Back of card one\r\nFront of card two,Back of card two\r\nFront of card three,Back of card three\r\n");
  });

  test("it is still there after a reload, and showing the cards again is free", async ({ page }) => {
    await newSignedInUser(page);
    await switchToStudy(page);
    await page.locator("#main-textarea").fill(NOTES);
    await makeCards(page);
    await expect(cardOf(page, "Cell biology notes").getByTestId("flashcard")).toBeVisible();

    await page.reload();
    const card = cardOf(page, "Cell biology notes");
    await expect(card.getByTestId("study-set-note")).toBeVisible();
    // The study tools are open but not loaded until asked for: a library full of study sets must not make a request each.
    await expect(card.getByTestId("flashcard")).toHaveCount(0);
    await card.getByRole("button", { name: "Flashcards" }).click();
    await expect(card.getByTestId("flashcard")).toContainText("Front of card one");
  });

  test("a web link and a file become study sets too", async ({ page }) => {
    await newSignedInUser(page);
    await switchToStudy(page);

    await page.locator("#main-textarea").fill("https://news.example/post");
    await expect(page.getByTestId("link-detected")).toContainText("Make flashcards");
    await makeCards(page);
    await expect(cardOf(page, "Page from news.example").getByTestId("flashcard")).toContainText("Front of card one");

    await page.locator("#pdf-upload").setInputFiles(pdf("lecture.pdf"));
    await makeCards(page);
    await expect(cardOf(page, "lecture.pdf").getByTestId("flashcard")).toContainText("Front of card one");
    await expect(page.getByTestId("document-card")).toHaveCount(2);
  });

  test("a summary can be written later, and the flashcards stay", async ({ page }) => {
    await newSignedInUser(page);
    await switchToStudy(page);
    await page.locator("#main-textarea").fill(NOTES);
    await makeCards(page);
    const card = cardOf(page, "Cell biology notes");
    await expect(card.getByTestId("flashcard")).toBeVisible();

    await card.getByRole("button", { name: "More" }).click();
    await card.getByRole("button", { name: "Write a summary too" }).click();
    await expect(card.getByTestId("rewrite")).toContainText("Your flashcards and quiz stay as they are.");
    await card.getByRole("button", { name: "Write the summary" }).click();

    // Now it is an ordinary summary card, with the tools that need one, and the cards are still there.
    await expect(card.getByTestId("study-set-note")).toHaveCount(0);
    await expect(card.getByText("Stub summary")).toBeVisible();
    await expect(card.getByRole("button", { name: "Check against the original" })).toBeVisible();
    await expect(card.getByTestId("flashcard")).toContainText("Front of card one");
  });

  test("a failure shows the reason and saves nothing", async ({ page }) => {
    await newSignedInUser(page);
    await switchToStudy(page);
    await page.locator("#main-textarea").fill("FAIL_ME notes about nothing");
    await makeCards(page);
    await expect(page.getByRole("alert").filter({ hasText: "The AI service failed to produce a response" })).toBeVisible();
    await expect(page.getByTestId("document-card")).toHaveCount(0);
    // The text is still there to try again.
    await expect(page.locator("#main-textarea")).toHaveValue("FAIL_ME notes about nothing");
  });

  test("the switch is only for signed-in people, on the dashboard", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("mode-switch")).toHaveCount(0);
    await newSignedInUser(page);
    await expect(page.getByTestId("mode-switch")).toBeVisible();
    // Back to summarizing: the options and the button come back.
    await switchToStudy(page);
    await page.getByTestId("mode-switch").getByRole("button", { name: "Summary" }).click();
    await expect(page.getByRole("button", { name: "Summarize", exact: true })).toBeVisible();
    await expect(page.getByText("Summary Word Count:")).toBeVisible();
  });

  test("the switch and a study set have no accessibility violations", async ({ page }) => {
    await newSignedInUser(page);
    await switchToStudy(page);
    const tags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
    let results = await new AxeBuilder({ page }).include('[data-testid="mode-switch"]').withTags(tags).analyze();
    expect(violationsOf(results)).toEqual([]);

    await page.locator("#main-textarea").fill(NOTES);
    await makeCards(page);
    const card = cardOf(page, "Cell biology notes");
    await expect(card.getByTestId("flashcard")).toBeVisible();
    // A new card fades in. Scanned halfway, its text is a lighter mix of colours and fails the contrast rule on a slow
    // machine (GitHub's), so wait until it is fully opaque.
    await expect(card).toHaveCSS("opacity", "1");
    results = await new AxeBuilder({ page }).include('[data-testid="document-card"]').withTags(tags).analyze();
    expect(violationsOf(results)).toEqual([]);
  });
});
