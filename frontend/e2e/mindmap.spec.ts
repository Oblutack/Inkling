import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { newSignedInUser, summarizeText } from "./support/helpers";

// The mind map of a summary. (The AI service here is a stub whose summary is always a heading "Stub summary" with four
// bullets, one of which repeats the first words of the text: that bullet is also the sentence the stub's proof check backs.)

const tags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const TEXT = "The first claim is backed word for word. More words follow in this little document.";

async function openMap(page: Page): Promise<Locator> {
  await page.goto("/dashboard");
  await summarizeText(page, TEXT);
  const saved = page.getByTestId("document-card").first();
  await expect(saved).toBeVisible();
  await saved.getByRole("button", { name: "Mind map" }).click();
  return saved.getByTestId("mind-map");
}

const node = (map: Locator, name: RegExp | string) => map.getByRole("button", { name });

test.describe("the mind map", () => {
  test("shows the title in the middle, the heading as a branch and the bullets as leaves", async ({ page }) => {
    await newSignedInUser(page);
    const map = await openMap(page);
    await expect(map.getByTestId("map-node")).toHaveCount(6);
    await expect(map.locator('[data-kind="root"]')).toHaveCount(1);
    await expect(map.locator('[data-kind="branch"]')).toHaveCount(1);
    await expect(map.locator('[data-kind="leaf"]')).toHaveCount(4);
    await expect(node(map, "Stub summary")).toBeVisible();
    await expect(node(map, /^Subject: pasted text/)).toBeVisible();
    // the same content is there to be read as a list
    await map.getByText("Show as an outline").click();
    await expect(map.getByTestId("map-outline")).toContainText("Stub summary");
    await expect(map.getByTestId("map-outline").getByRole("listitem")).toHaveCount(6);
  });

  test("a point is read in full, and the passage it came from is shown on request", async ({ page }) => {
    await newSignedInUser(page);
    const map = await openMap(page);
    await expect(map.getByTestId("map-detail")).toContainText("Select a point to read it in full");

    await node(map, /^Opening words: The first claim/).click();
    await expect(map.getByTestId("map-detail")).toContainText("Opening words: The first claim is backed word for word");
    await map.getByRole("button", { name: "Show where this comes from" }).click();
    const source = map.getByTestId("map-source");
    await expect(source).toContainText("Source in the document (page 2)");
    await expect(source).toContainText("Stub passage that the answer cites.");

    // a point with nothing in the document behind it says so (the check is already done: no second wait)
    await node(map, /^Subject: pasted text/).click();
    await expect(map.getByTestId("map-source-none")).toContainText("No passage of the document was matched");
    // and a heading has no passage of its own
    await node(map, "Stub summary").click();
    await expect(map.getByTestId("map-detail")).toContainText("Stub summary");
  });

  test("it can be zoomed and fitted, and a point is chosen with the keyboard", async ({ page }) => {
    await newSignedInUser(page);
    const map = await openMap(page);
    const picture = map.locator("svg").first();
    await expect(picture).toHaveAttribute("data-zoom", "1.00");
    await map.getByRole("button", { name: "Zoom in" }).click();
    await expect(picture).toHaveAttribute("data-zoom", "1.25");
    await map.getByRole("button", { name: "Zoom in" }).click();
    await expect(picture).toHaveAttribute("data-zoom", "1.56");
    await map.getByRole("button", { name: "Zoom out" }).click();
    await expect(picture).toHaveAttribute("data-zoom", "1.25");
    await map.getByRole("button", { name: "Fit all" }).click();
    await expect(picture).toHaveAttribute("data-zoom", "1.00");

    const leaf = node(map, /^Words in source/);
    await leaf.focus();
    await page.keyboard.press("Enter");
    await expect(leaf).toHaveAttribute("aria-pressed", "true");
    await expect(map.getByTestId("map-detail")).toContainText("Words in source");
  });

  test("the picture can be saved as SVG and as PNG", async ({ page }) => {
    await newSignedInUser(page);
    const map = await openMap(page);

    const [svgDownload] = await Promise.all([page.waitForEvent("download"), map.getByRole("button", { name: "Download SVG" }).click()]);
    expect(svgDownload.suggestedFilename()).toMatch(/-map\.svg$/);
    const chunks: Buffer[] = [];
    for await (const chunk of await svgDownload.createReadStream()) chunks.push(Buffer.from(chunk));
    const svg = Buffer.concat(chunks).toString("utf8");
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain("Stub summary");
    expect(svg).toContain("Subject: pasted text");
    expect(svg).not.toContain("var(--");

    const [pngDownload] = await Promise.all([page.waitForEvent("download"), map.getByRole("button", { name: "Download PNG" }).click()]);
    expect(pngDownload.suggestedFilename()).toMatch(/-map\.png$/);
    const png: Buffer[] = [];
    for await (const chunk of await pngDownload.createReadStream()) png.push(Buffer.from(chunk));
    const bytes = Buffer.concat(png);
    expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(bytes.length).toBeGreaterThan(2000);
  });

  test("a study set has no summary, so it has no map", async ({ page }) => {
    await newSignedInUser(page);
    await page.goto("/dashboard");
    await page.getByRole("button", { name: "Study", exact: true }).click();
    await page.locator("#main-textarea").fill("Some words that are worth studying for the exam next week.");
    await page.getByRole("button", { name: /Make flashcards/ }).click();
    await expect(page.getByTestId("document-card").first()).toBeVisible();
    await expect(page.getByTestId("document-card").first().getByRole("button", { name: "Mind map" })).toHaveCount(0);
  });

  test("the map has no accessibility violations", async ({ page }) => {
    await newSignedInUser(page);
    const map = await openMap(page);
    await node(map, /^Opening words: The first claim/).click();
    await map.getByRole("button", { name: "Show where this comes from" }).click();
    await expect(map.getByTestId("map-source")).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(tags).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});
