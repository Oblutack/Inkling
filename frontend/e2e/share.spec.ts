import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { newSignedInUser } from "./support/helpers";

// Sharing to Inkling from another app. A phone's Share menu sends a POST to /share-target; the service worker keeps it and
// sends the browser on to /share. The tests send the same POST from the page itself, with the worker in charge.

// Makes the service worker the one in charge of the page (it is installed on the first visit and takes over on the next).
async function workerInCharge(page: Page) {
  await page.goto("/");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
}

async function share(page: Page, fields: Record<string, string>, files: { name: string; type: string; content: string }[] = []) {
  await page.evaluate(
    async ({ fields, files }) => {
      const form = new FormData();
      for (const [key, value] of Object.entries(fields)) form.append(key, value);
      for (const f of files) form.append("files", new File([f.content], f.name, { type: f.type }));
      await fetch("/share-target", { method: "POST", body: form, redirect: "manual" });
    },
    { fields, files }
  );
}

test.describe("sharing to Inkling", () => {
  test("the app says it can receive a share, and what kinds of files", async ({ request }) => {
    const manifest = await (await request.get("/manifest.webmanifest")).json();
    expect(manifest.share_target).toMatchObject({ action: "/share-target", method: "POST", enctype: "multipart/form-data" });
    expect(manifest.share_target.params).toMatchObject({ title: "title", text: "text", url: "url" });
    const accepted: string[] = manifest.share_target.params.files[0].accept;
    expect(manifest.share_target.params.files[0].name).toBe("files");
    for (const type of [".pdf", ".docx", ".pptx", "application/pdf", "audio/*", ".heic"]) expect(accepted).toContain(type);
  });

  test("a shared link arrives in the box, and can be summarized without an account", async ({ page }) => {
    await workerInCharge(page);
    await share(page, { title: "A page", text: "Great read https://news.example/post" });
    await page.goto("/share");

    await expect(page.getByTestId("share-item")).toBeVisible();
    await expect(page.locator("#main-textarea")).toHaveValue("https://news.example/post");
    await expect(page.getByTestId("link-detected")).toBeVisible();
    await page.getByRole("button", { name: "Summarize", exact: true }).click();
    await expect(page.getByText("Subject: Page from news.example")).toBeVisible();

    // Used: it is removed once the summary is done, and not offered again.
    await expect(page.getByTestId("summary-length")).toBeVisible();
    await expect.poll(() => page.evaluate(() => caches.has("inkling-share"))).toBe(false);
    await page.goto("/share");
    await expect(page.getByTestId("share-none")).toContainText("Nothing has been shared yet");
  });

  test("shared text arrives in the box, with its title", async ({ page }) => {
    await workerInCharge(page);
    await share(page, { title: "Cell notes", text: "Cells are the basic unit of life." });
    await page.goto("/share");
    await expect(page.locator("#main-textarea")).toHaveValue("Cell notes\n\nCells are the basic unit of life.");
  });

  test("a shared file is listed, and a newer share replaces an older one", async ({ page }) => {
    await workerInCharge(page);
    await share(page, { text: "First thing" });
    await share(page, {}, [{ name: "lecture.pdf", type: "application/pdf", content: "%PDF-1.4 lecture" }]);
    await page.goto("/share");
    await expect(page.getByText("lecture.pdf")).toBeVisible();
    await expect(page.getByTestId("share-item")).not.toContainText("First thing");
  });

  test("a signed-in person can make flashcards from what was shared", async ({ page }) => {
    await newSignedInUser(page);
    await workerInCharge(page);
    await share(page, { text: "Cell biology\nCells are the basic unit of life." });
    await page.goto("/share");
    await page.getByTestId("mode-switch").getByRole("button", { name: "Study" }).click();
    await page.getByRole("button", { name: "Make flashcards" }).click();
    await expect(page).toHaveURL(/\/dashboard/);
    const card = page.getByTestId("document-card").filter({ has: page.getByRole("heading", { name: "Cell biology" }) });
    await expect(card.getByTestId("flashcard")).toContainText("Front of card one");
  });

  test("with nothing shared the page says how to share, and a failed share says so", async ({ page }) => {
    await page.goto("/share");
    await expect(page.getByTestId("share-none")).toContainText("Nothing has been shared yet");
    await page.goto("/share?missing=1");
    await expect(page.getByRole("alert").filter({ hasText: "That share did not arrive" })).toBeVisible();
  });

  test("without the service worker the server sends the share to the page that explains", async ({ request }) => {
    const response = await request.post("/share-target", { multipart: { text: "hello" }, maxRedirects: 0 });
    expect(response.status()).toBe(303);
    expect(response.headers()["location"]).toMatch(/\/share\?missing=1$/);
  });

  test("the share page has no accessibility violations", async ({ page }) => {
    await workerInCharge(page);
    await share(page, { text: "Cell notes about cells and their parts." });
    await page.goto("/share");
    await expect(page.getByTestId("share-item")).toBeVisible();
    await expect(page.getByTestId("share-item")).toHaveCSS("opacity", "1");
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});
