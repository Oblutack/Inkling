import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { newSignedInUser } from "./support/helpers";

// The reading list. (The AI service here is a stub: a page is titled "Page from <site>", and every summary starts with the
// heading "Stub summary" and a "Subject:" line.)

const tags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

function item(page: Page, title: string | RegExp) {
  return page.getByTestId("reading-item").filter({ has: page.getByRole("heading", { name: title }) });
}

async function saveFromTheBox(page: Page, content: string) {
  await page.goto("/dashboard");
  await page.locator("#main-textarea").fill(content);
  await page.getByRole("button", { name: "Save for later" }).click();
}

test.describe("the reading list", () => {
  test("a web address in the box is saved for later with a short summary", async ({ page }) => {
    await newSignedInUser(page);
    await saveFromTheBox(page, "https://blog.example/post");
    await expect(page).toHaveURL(/\/reading\?added=1/);
    await expect(page.getByTestId("reading-note")).toHaveText("Saved to your reading list.");

    const saved = item(page, "Page from blog.example");
    await expect(saved).toBeVisible();
    await expect(saved).toContainText("blog.example");
    await expect(saved).toContainText("Subject: Page from blog.example");
    await expect(saved.getByRole("link", { name: "Open the page" })).toHaveAttribute("href", "https://blog.example/post");
    await expect(page.getByRole("button", { name: "Unread (1)" })).toBeVisible();

    // it is in the library too, like any summary
    await page.goto("/dashboard");
    await expect(page.getByTestId("document-card").filter({ has: page.getByRole("heading", { name: "Page from blog.example" }) })).toHaveCount(1);
  });

  test("a text in the box is saved for later too, and there is nothing to save when the box is empty", async ({ page }) => {
    await newSignedInUser(page);
    await page.goto("/dashboard");
    await expect(page.getByRole("button", { name: "Save for later" })).toHaveCount(0);
    await page.locator("#main-textarea").fill("Heat pumps are efficient. Sales rose in 2024.");
    await expect(page.getByRole("button", { name: "Save for later" })).toBeVisible();
    await page.getByRole("button", { name: "Save for later" }).click();
    await expect(page).toHaveURL(/\/reading/);
    const saved = page.getByTestId("reading-item");
    await expect(saved).toHaveCount(1);
    await expect(saved).toContainText("Heat pumps are efficient");
    await expect(saved.getByRole("link", { name: "Open the page" })).toHaveCount(0); // a text has no page
  });

  test("something can be saved from the reading list page, and a page is not saved twice", async ({ page }) => {
    await newSignedInUser(page);
    await page.goto("/reading");
    await expect(page.getByTestId("reading-empty")).toContainText("Nothing waiting to be read");
    await expect(page.getByRole("button", { name: "Save for later" })).toBeDisabled();

    await page.getByLabel("Save something to read later").fill("news.example/story");
    await page.getByRole("button", { name: "Save for later" }).click();
    await expect(item(page, "Page from news.example")).toBeVisible();
    await expect(page.getByTestId("reading-note")).toHaveText("Saved to your reading list.");

    await page.getByLabel("Save something to read later").fill("https://news.example/story");
    await page.getByRole("button", { name: "Save for later" }).click();
    await expect(page.getByTestId("reading-note")).toHaveText("That page is already on your reading list.");
    await expect(page.getByTestId("reading-item")).toHaveCount(1);
  });

  test("an item is marked read and unread, archived and brought back, and taken off the list", async ({ page }) => {
    await newSignedInUser(page);
    await page.goto("/reading");
    for (const address of ["https://one.example/a", "https://two.example/b"]) {
      await page.getByLabel("Save something to read later").fill(address);
      await page.getByRole("button", { name: "Save for later" }).click();
    }
    await expect(page.getByTestId("reading-item")).toHaveCount(2);
    await expect(page.getByRole("button", { name: "Unread (2)" })).toBeVisible();

    await item(page, "Page from one.example").getByRole("button", { name: "Mark as read" }).click();
    await expect(page.getByTestId("reading-item")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Read (1)", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Read (1)", exact: true }).click();
    await expect(item(page, "Page from one.example")).toBeVisible();
    await item(page, "Page from one.example").getByRole("button", { name: "Mark as unread" }).click();
    await expect(page.getByTestId("reading-empty")).toBeVisible();

    await page.getByRole("button", { name: /^Unread/ }).click();
    await item(page, "Page from two.example").getByRole("button", { name: "Archive" }).click();
    await page.getByRole("button", { name: "Archived (1)" }).click();
    await item(page, "Page from two.example").getByRole("button", { name: "Bring back" }).click();
    await expect(page.getByTestId("reading-empty")).toContainText("Nothing archived");
    await page.getByRole("button", { name: /^Unread/ }).click();
    await expect(page.getByTestId("reading-item")).toHaveCount(2);

    page.once("dialog", (dialog) => dialog.accept());
    await item(page, "Page from two.example").getByRole("button", { name: "Remove" }).click();
    await expect(page.getByTestId("reading-item")).toHaveCount(1);
    // the library still has it
    await page.goto("/dashboard");
    await expect(page.getByTestId("document-card").filter({ has: page.getByRole("heading", { name: "Page from two.example" }) })).toHaveCount(1);
  });

  test("the account page offers the weekly digest, off until chosen, next to the alerts for watched pages", async ({ page }) => {
    await newSignedInUser(page);
    await page.goto("/account");
    const section = page.getByTestId("email-preferences");
    await expect(section.getByRole("checkbox", { name: "Alerts for pages you watch" })).toBeChecked();
    await expect(section.getByRole("checkbox", { name: "Study reminders" })).not.toBeChecked();
    const digest = section.getByRole("checkbox", { name: "Weekly reading digest" });
    await expect(digest).not.toBeChecked();
    await digest.check();
    await expect(section.getByText("Saved.")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("email-preferences").getByRole("checkbox", { name: "Weekly reading digest" })).toBeChecked();

    await page.goto("/reading");
    await page.getByRole("link", { name: "Switch it on in your account" }).click();
    await expect(page).toHaveURL(/\/account/);
  });

  test("a signed-out visitor is sent to log in", async ({ page }) => {
    await page.goto("/reading");
    await expect(page).toHaveURL(/\/login/);
  });

  test("the reading list has no accessibility violations", async ({ page }) => {
    await newSignedInUser(page);
    await saveFromTheBox(page, "https://blog.example/post");
    await expect(item(page, "Page from blog.example")).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(tags).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});
