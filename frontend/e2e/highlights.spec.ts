import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { API, newSignedInUser, realPdf } from "./support/helpers";

// Highlights and notes in the original PDF. (The PDF has two pages: "First page of the report." and "Stub passage that the answer
// cites. More text follows." The AI service is a stub.)

const tags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const origin = { Origin: "http://localhost:13000" };

async function uploadReport(page: Page): Promise<Locator> {
  await page.goto("/dashboard");
  await page.locator("#pdf-upload").setInputFiles({
    name: "report.pdf",
    mimeType: "application/pdf",
    buffer: realPdf(["First page of the report.", "Stub passage that the answer cites. More text follows."]),
  });
  await page.getByRole("button", { name: "Summarize", exact: true }).click();
  const card = page.getByTestId("document-card").first();
  await expect(card.getByRole("heading", { name: "report.pdf" })).toBeVisible();
  return card;
}

async function openViewer(page: Page, card: Locator) {
  await card.getByRole("button", { name: "More" }).click();
  await card.getByRole("button", { name: "Highlights and notes" }).click();
  await card.getByRole("button", { name: "Mark up the original" }).click();
  const viewer = page.getByTestId("pdf-viewer");
  await expect(viewer.getByTestId("pdf-page")).toHaveText("Page 1 of 2");
  await expect(viewer.getByTestId("pdf-text-layer")).toContainText("First page of the report.");
  return viewer;
}

// Selects the words of the first text run on the page that holds `words`, the way dragging over them would.
async function select(page: Page, words: string) {
  await page.evaluate((text) => {
    const layer = document.querySelector('[data-testid="pdf-text-layer"]')!;
    const span = [...layer.querySelectorAll("span")].find((s) => s.textContent?.includes(text))!;
    const range = document.createRange();
    range.selectNodeContents(span);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  }, words);
}

test.describe("highlights and notes in the original", () => {
  test("words are selected on the page, highlighted with a note, listed on the page and on the document", async ({ page }) => {
    await newSignedInUser(page);
    const card = await uploadReport(page);
    const viewer = await openViewer(page, card);

    await expect(viewer.getByTestId("pdf-mark-bar")).toContainText("Select words on the page");
    await select(page, "First page of the report.");
    await expect(viewer.getByTestId("pdf-selected")).toContainText("First page of the report.");
    await viewer.getByLabel("Note about the highlighted words").fill("check the figures here");
    await viewer.getByRole("button", { name: "Highlight", exact: true }).click();

    // it is marked on the page and listed under it, with its note
    await expect(viewer.getByTestId("pdf-mark").first()).toBeVisible();
    const item = viewer.getByTestId("page-highlight");
    await expect(item).toHaveCount(1);
    await expect(item).toContainText("First page of the report.");
    await expect(item).toContainText("check the figures here");
    await expect(viewer.getByTestId("pdf-selected")).toHaveCount(0); // the selection is used up

    // closing the viewer: the document lists it too
    await page.keyboard.press("Escape");
    const listed = card.getByTestId("highlight-item");
    await expect(listed).toHaveCount(1);
    await expect(listed).toContainText("page 1");
    await expect(listed).toContainText("check the figures here");
    await listed.getByRole("button", { name: "Open page 1" }).click();
    await expect(page.getByTestId("pdf-viewer").getByTestId("pdf-mark").first()).toBeVisible();
  });

  test("a note is edited and a highlight removed", async ({ page }) => {
    await newSignedInUser(page);
    const card = await uploadReport(page);
    const viewer = await openViewer(page, card);
    await select(page, "First page of the report.");
    await viewer.getByRole("button", { name: "Highlight", exact: true }).click();
    const item = viewer.getByTestId("page-highlight");
    await expect(item).toHaveCount(1);

    await item.getByRole("button", { name: "Add a note" }).click();
    await item.getByLabel("Note about the highlighted words").fill("revisit this");
    await item.getByRole("button", { name: "Save the note" }).click();
    await expect(item).toContainText("revisit this");
    await expect(item.getByRole("button", { name: "Edit the note" })).toBeVisible();

    page.once("dialog", (dialog) => dialog.accept());
    await item.getByRole("button", { name: "Remove the highlight" }).click();
    await expect(viewer.getByTestId("page-highlight")).toHaveCount(0);
    await expect(viewer.getByTestId("pdf-mark")).toHaveCount(0);
    const stored = await (await page.request.get(`${API}/documents/${(await (await page.request.get(`${API}/documents`)).json())[0].ID}/highlights`)).json();
    expect(stored.highlights).toHaveLength(0);
  });

  test("highlights are kept, belong to their own page, and come back after a reload", async ({ page }) => {
    await newSignedInUser(page);
    const card = await uploadReport(page);
    const viewer = await openViewer(page, card);
    await viewer.getByRole("button", { name: "Next page" }).click();
    await expect(viewer.getByTestId("pdf-page")).toHaveText("Page 2 of 2");
    await expect(viewer.getByTestId("pdf-text-layer")).toContainText("Stub passage that the answer cites");
    await select(page, "Stub passage that the answer cites");
    await viewer.getByLabel("Note about the highlighted words").fill("the key sentence");
    await viewer.getByRole("button", { name: "Highlight", exact: true }).click();
    await expect(viewer.getByTestId("page-highlight")).toHaveCount(1);
    await viewer.getByRole("button", { name: "Previous page" }).click();
    await expect(viewer.getByTestId("page-highlight")).toHaveCount(0); // it is on page 2

    await page.reload();
    const again = page.getByTestId("document-card").first();
    await again.getByRole("button", { name: "More" }).click();
    await again.getByRole("button", { name: "Highlights and notes" }).click();
    await expect(again.getByTestId("highlight-item")).toContainText("page 2");
    await expect(again.getByTestId("highlight-item")).toContainText("the key sentence");
  });

  test("the library search finds a document by a note written on it", async ({ page }) => {
    await newSignedInUser(page);
    const card = await uploadReport(page);
    const viewer = await openViewer(page, card);
    await select(page, "First page of the report.");
    await viewer.getByLabel("Note about the highlighted words").fill("zebra clause");
    await viewer.getByRole("button", { name: "Highlight", exact: true }).click();
    await expect(viewer.getByTestId("page-highlight")).toHaveCount(1);
    await page.keyboard.press("Escape");

    await page.getByRole("searchbox").or(page.getByPlaceholder(/search/i)).first().fill("zebra");
    await expect(page.getByTestId("document-card")).toHaveCount(1);
    await expect(page.getByTestId("document-card").first().getByRole("heading", { name: "report.pdf" })).toBeVisible();
  });

  test("a document with no stored original says so", async ({ page }) => {
    await newSignedInUser(page);
    await page.goto("/dashboard");
    await page.locator("#main-textarea").fill("Pasted words with no PDF behind them.");
    await page.getByRole("button", { name: "Summarize", exact: true }).click();
    const card = page.getByTestId("document-card").first();
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "More" }).click();
    await card.getByRole("button", { name: "Highlights and notes" }).click();
    await expect(card.getByTestId("highlights-panel")).toContainText("no stored original PDF");
    await expect(card.getByTestId("highlights-empty")).toBeVisible();
    // the API refuses a highlight that names a file the document does not have
    const docs = await (await page.request.get(`${API}/documents`)).json();
    const bad = await page.request.post(`${API}/documents/${docs[0].ID}/highlights`, { data: { page: 1, quote: "Pasted words", fileId: 999999 }, headers: origin });
    expect(bad.status()).toBe(400);
  });

  test("the viewer with its marks and the list have no accessibility violations", async ({ page }) => {
    await newSignedInUser(page);
    const card = await uploadReport(page);
    const viewer = await openViewer(page, card);
    await select(page, "First page of the report.");
    await viewer.getByLabel("Note about the highlighted words").fill("a note");
    await viewer.getByRole("button", { name: "Highlight", exact: true }).click();
    await expect(viewer.getByTestId("page-highlight")).toHaveCount(1);
    const results = await new AxeBuilder({ page }).withTags(tags).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});
