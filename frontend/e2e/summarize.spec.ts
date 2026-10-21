import { expect, test } from "@playwright/test";
import { alertOf, newSignedInUser, pdf, realPdf, summarizeText } from "./support/helpers";

const ARTICLE = "The council approved a new bike lane network funded by a regional grant. Work starts in March.";

test.describe("summarizing without an account", () => {
  test("pasted text streams into the output, then offers a PDF export", async ({ page }) => {
    await page.goto("/");
    await summarizeText(page, ARTICLE);

    await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
    await expect(page.getByText("Stub summary")).toBeVisible();
    await expect(page.getByText("Opening words: The council approved a new bike lane")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save as PDF" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel" })).toHaveCount(0);
  });

  test("a sample text can be loaded, summarized, and its length is shown", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "or try a sample text" }).click();
    await expect(page.locator("#main-textarea")).toHaveValue(/Harbourside Library/);
    // The attach button now sits under the text, and the sample link is gone.
    await expect(page.getByRole("button", { name: "or try a sample text" })).toHaveCount(0);

    await page.getByRole("button", { name: "Summarize", exact: true }).click();
    await expect(page.getByTestId("summary-length")).toContainText(/Summary: \d+ words? · \d+ min read/);
  });

  test("the last style, language and length are remembered on the next visit", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Style").selectOption({ label: "Bullet Points" });
    await page.locator("main").getByLabel("Language").selectOption({ label: "German" });
    await page.getByRole("slider").fill("300");
    await expect(page.getByText("300 Words")).toBeVisible();

    await page.reload();
    await expect(page.getByLabel("Style")).toHaveValue("bullets");
    await expect(page.locator("main").getByLabel("Language")).toHaveValue("German");
    await expect(page.getByText("300 Words")).toBeVisible();
  });

  test("unusable remembered settings fall back to the defaults", async ({ page }) => {
    await page.addInitScript(() =>
      localStorage.setItem("inkling.summaryPreferences", JSON.stringify({ wordCount: 5, style: "nope", language: "Klingon" }))
    );
    await page.goto("/");
    await expect(page.getByLabel("Style")).toHaveValue("default");
    await expect(page.locator("main").getByLabel("Language")).toHaveValue("English");
    await expect(page.getByText("150 Words")).toBeVisible();
  });

  test("Save as PDF downloads a real PDF of the summary", async ({ page }) => {
    await page.goto("/");
    await summarizeText(page, ARTICLE);
    await expect(page.getByRole("button", { name: "Save as PDF" })).toBeVisible();

    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Save as PDF" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/-summary\.pdf$/);

    const { readFile } = await import("node:fs/promises");
    const bytes = await readFile((await file.path())!);
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(bytes.length).toBeGreaterThan(1000);
  });

  test("an uploaded PDF is summarized, and the page limit appears", async ({ page }) => {
    await page.goto("/");
    await page.locator("#pdf-upload").setInputFiles(pdf("annual-report.pdf"));
    await expect(page.getByText("annual-report.pdf")).toBeVisible();
    await expect(page.getByRole("spinbutton", { name: "Page limit" })).toBeVisible();

    await page.getByRole("button", { name: "Summarize", exact: true }).click();
    await expect(page.getByText("Subject: annual-report.pdf")).toBeVisible();
  });

  test("several PDFs are combined into one summary", async ({ page }) => {
    await page.goto("/");
    await page.locator("#pdf-upload").setInputFiles([pdf("a.pdf"), pdf("b.pdf")]);
    await page.getByRole("button", { name: "Summarize", exact: true }).click();
    await expect(page.getByText("Subject: a.pdf, b.pdf")).toBeVisible();
  });

  test("a file removed from the list is not sent", async ({ page }) => {
    await page.goto("/");
    await page.locator("#pdf-upload").setInputFiles([pdf("keep.pdf"), pdf("drop.pdf")]);
    await page.getByRole("button", { name: "Remove drop.pdf" }).click();
    await page.getByRole("button", { name: "Summarize", exact: true }).click();
    await expect(page.getByText("Subject: keep.pdf")).toBeVisible();
    await expect(page.getByText(/drop\.pdf/)).toHaveCount(0);
  });

  test("a model failure is explained and the form stays usable", async ({ page }) => {
    await page.goto("/");
    await summarizeText(page, `${ARTICLE} FAIL_ME`);
    await expect(page.getByText(/language model is unavailable/i)).toBeVisible();
    await expect(page.getByRole("button", { name: "Summarize", exact: true })).toBeEnabled();

    // Editing the text and trying again works.
    await summarizeText(page, ARTICLE);
    await expect(page.getByText("Stub summary")).toBeVisible();
  });

  test("Cancel stops a running summary", async ({ page }) => {
    await page.goto("/");
    await summarizeText(page, `${ARTICLE} SLOW_ME`);
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("button", { name: "Summarize", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel" })).toHaveCount(0);
    // The user is told it was cancelled, rather than being left with an empty box.
    await expect(alertOf(page)).toHaveText("Summarization was cancelled.");
  });

  test("the word-count slider is replaced by a page limit once a PDF is attached", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#word-count")).toBeEnabled();
    await page.locator("#pdf-upload").setInputFiles(pdf("x.pdf"));
    await page.getByRole("button", { name: "Increase page limit" }).click();
    await expect(page.locator("#word-count")).toBeDisabled();
  });
});

test.describe("summarizing while signed in", () => {
  test("a summary is saved to the history, survives a reload, and can be deleted", async ({ page }) => {
    await newSignedInUser(page);
    await expect(page.getByText("You have no saved documents yet.")).toBeVisible();

    await page.locator("#pdf-upload").setInputFiles(pdf("quarterly.pdf"));
    await page.getByRole("button", { name: "Summarize", exact: true }).click();
    await expect(page.getByText("Subject: quarterly.pdf").first()).toBeVisible();

    const card = page.locator("h3", { hasText: "quarterly.pdf" });
    await expect(card).toBeVisible();

    await page.reload();
    await expect(page.locator("h3", { hasText: "quarterly.pdf" })).toBeVisible();

    // A saved summary can be exported too.
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Save quarterly.pdf as PDF" }).click();
    expect((await download).suggestedFilename()).toMatch(/\.pdf$/);

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Delete quarterly.pdf" }).click();
    await expect(page.locator("h3", { hasText: "quarterly.pdf" })).toHaveCount(0);
    await page.reload();
    await expect(page.getByText("You have no saved documents yet.")).toBeVisible();
  });

  test("chat answers questions about a saved document", async ({ page, context }) => {
    await newSignedInUser(page);
    await summarizeTextAndWaitForCard(page);

    await page.getByRole("button", { name: "Chat With Document" }).first().click();
    await page.getByTestId("document-chat").getByPlaceholder("Type a question").fill("When does work start?");
    await page.keyboard.press("Enter");

    await expect(page.getByText("When does work start?").first()).toBeVisible();
    await expect(page.getByText(/Stub answer to "When does work start\?"/)).toBeVisible();

    // An answer can be copied.
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.getByTestId("document-chat").getByRole("button", { name: "Copy" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('Stub answer to "When does work start?"');

    // A second question keeps the conversation going.
    await page.getByTestId("document-chat").getByPlaceholder("Type a question").fill("And who pays?");
    await page.keyboard.press("Enter");
    await expect(page.getByText(/Stub answer to "And who pays\?"/)).toBeVisible();
  });

  test("answers cite their sources: a chip opens the passage and its page", async ({ page }) => {
    await newSignedInUser(page);
    await summarizeTextAndWaitForCard(page);
    await page.getByRole("button", { name: "Chat With Document" }).first().click();
    await page.getByTestId("document-chat").getByPlaceholder("Type a question").fill("When does work start?");
    await page.keyboard.press("Enter");

    // The answer carries a clickable marker, and the source list starts collapsed.
    const chip = page.getByRole("button", { name: "Show source 1" });
    await expect(chip).toBeVisible();
    const sources = page.getByTestId("sources");
    await expect(sources).toContainText("Page 2");
    await expect(page.getByText("Stub passage that the answer cites.")).toBeHidden();

    await chip.click();
    await expect(page.getByText("Stub passage that the answer cites.")).toBeVisible();

    // It can be closed again from the list itself.
    await sources.getByText("Page 2").click();
    await expect(page.getByText("Stub passage that the answer cites.")).toBeHidden();
  });

  test("a cited page opens in the original PDF with the passage marked", async ({ page }) => {
    await newSignedInUser(page);
    await page.locator("#pdf-upload").setInputFiles({
      name: "manual.pdf",
      mimeType: "application/pdf",
      buffer: realPdf(["First page of the manual.", "Stub passage that the answer cites. More text follows."]),
    });
    await page.getByRole("button", { name: "Summarize", exact: true }).click();
    await expect(page.locator("h3", { hasText: "manual.pdf" })).toBeVisible();

    await page.getByRole("button", { name: "Chat With Document" }).first().click();
    await page.getByTestId("document-chat").getByPlaceholder("Type a question").fill("What does it say?");
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Show source 1" }).click();
    await page.getByRole("button", { name: "Open page 2 in the document" }).click();

    // The viewer opens on the cited page, drawn from the stored original, with the passage marked.
    const viewer = page.getByTestId("pdf-viewer");
    await expect(viewer).toBeVisible();
    await expect(viewer.getByTestId("pdf-page")).toHaveText("Page 2 of 2");
    await expect(page.getByTestId("pdf-highlight").first()).toBeVisible();
    const inked = await page.getByTestId("pdf-canvas").evaluate((canvas: HTMLCanvasElement) => {
      const { data } = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
      let dark = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i] < 128) dark++;
      return dark;
    });
    expect(inked, "the page was really drawn").toBeGreaterThan(200);

    // Other pages can be read, and carry no marking.
    await viewer.getByRole("button", { name: "Previous page" }).click();
    await expect(viewer.getByTestId("pdf-page")).toHaveText("Page 1 of 2");
    await expect(page.getByTestId("pdf-highlight")).toHaveCount(0);

    // Escape closes it, and focus goes back to where it was.
    await page.keyboard.press("Escape");
    await expect(viewer).toBeHidden();
  });

  test("the proof check marks each sentence and opens the evidence in the original", async ({ page }) => {
    await newSignedInUser(page);
    await page.locator("#pdf-upload").setInputFiles({
      name: "report.pdf",
      mimeType: "application/pdf",
      buffer: realPdf(["First page of the report.", "Stub passage that the answer cites. More text follows."]),
    });
    await page.getByRole("button", { name: "Summarize", exact: true }).click();
    await expect(page.locator("h3", { hasText: "report.pdf" })).toBeVisible();

    await page.getByRole("button", { name: "Check against the original" }).click();
    const proof = page.getByTestId("proof");
    await expect(page.getByTestId("proof-headline")).toHaveText(
      "1 of 3 statements found in the document · 1 partly found · 1 not found"
    );
    await expect(proof.getByRole("img", { name: "Found in the document" })).toHaveCount(1);
    await expect(proof.getByRole("img", { name: "Partly found" })).toHaveCount(1);
    await expect(proof.getByRole("img", { name: "Not found" })).toHaveCount(1);
    await expect(proof.getByText("Stub summary", { exact: true })).toBeVisible(); // headings are shown, not judged

    // An invented number is called out.
    await proof.getByText("The third claim says 99 things.").click();
    await expect(proof.getByText("Not in the document: 99")).toBeVisible();
    await expect(proof.getByText("No passage of the document matches this sentence.")).toBeVisible();

    // A backed sentence shows its evidence, and the evidence opens in the original at the right page.
    await proof.getByText("The first claim is backed word for word.").click();
    await expect(proof.getByText("Stub passage that the answer cites.").first()).toBeVisible();
    await proof.getByRole("button", { name: "Open page 2 in the document" }).first().click();
    const viewer = page.getByTestId("pdf-viewer");
    await expect(viewer.getByTestId("pdf-page")).toHaveText("Page 2 of 2");
    await expect(page.getByTestId("pdf-highlight").first()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(viewer).toBeHidden();

    // And back to the normal summary.
    await page.getByRole("button", { name: "Back to summary" }).click();
    await expect(page.getByTestId("proof")).toHaveCount(0);
    await expect(page.locator("[id^=doc-content-]").getByText("Stub summary").first()).toBeVisible();
  });

  test("a summary can be copied from the form and from its saved card", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await newSignedInUser(page);
    await summarizeText(page, ARTICLE);
    await expect(page.getByRole("button", { name: "Save as PDF" })).toBeVisible();

    await page.getByRole("button", { name: "Copy", exact: true }).click();
    await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "summary copied" })).toBeAttached();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("Stub summary");

    await page.evaluate(() => navigator.clipboard.writeText("something else"));
    await page.locator("h3").first().waitFor();
    await page.getByRole("button", { name: /^Copy .* summary$/ }).first().click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("Stub summary");
  });

  test("the proof check says so when the summary is in another language", async ({ page }) => {
    await newSignedInUser(page);
    await summarizeText(page, "LANGUAGE_MISMATCH a short document about nothing in particular.");
    await expect(page.locator("h3").first()).toBeVisible();
    await page.getByRole("button", { name: "Check against the original" }).click();
    await expect(page.getByRole("status").filter({ hasText: "different language" })).toBeVisible();
  });

  test("a failing proof check shows an error and can be retried", async ({ page }) => {
    await newSignedInUser(page);
    await summarizeText(page, "A short document that will be checked.");
    await expect(page.locator("h3").first()).toBeVisible();
    await page.route("**/documents/*/proof", (route) => route.fulfill({ status: 502, json: { error: "The AI service failed to produce a response." } }));
    await page.getByRole("button", { name: "Check against the original" }).click();
    await expect(alertOf(page)).toContainText("The AI service failed");
    await page.unroute("**/documents/*/proof");
    await page.getByRole("button", { name: "Check against the original" }).click();
    await expect(page.getByTestId("proof")).toBeVisible();
  });

  test("pasted text and documents without an original offer no way to open a page", async ({ page }) => {
    await newSignedInUser(page);
    await summarizeTextAndWaitForCard(page); // pasted text keeps no file
    await page.getByRole("button", { name: "Chat With Document" }).first().click();
    await page.getByTestId("document-chat").getByPlaceholder("Type a question").fill("When does work start?");
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Show source 1" }).click();
    await expect(page.getByText("Stub passage that the answer cites.")).toBeVisible();
    await expect(page.getByRole("button", { name: /Open page/ })).toHaveCount(0);
  });

  test("a citation marker that matches no source is never turned into a link", async ({ page }) => {
    await newSignedInUser(page);
    await summarizeTextAndWaitForCard(page);
    await page.getByRole("button", { name: "Chat With Document" }).first().click();
    await page.getByTestId("document-chat").getByPlaceholder("Type a question").fill("INVENTED reference please");
    await page.keyboard.press("Enter");

    await expect(page.getByRole("button", { name: "Show source 1" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Show source 9" })).toHaveCount(0);
    await expect(page.getByText("[9]")).toBeVisible();
  });

  test("an answer without citations shows no source list", async ({ page }) => {
    await newSignedInUser(page);
    await summarizeTextAndWaitForCard(page);
    await page.getByRole("button", { name: "Chat With Document" }).first().click();
    await page.getByTestId("document-chat").getByPlaceholder("Type a question").fill("NOCITE what is this?");
    await page.keyboard.press("Enter");

    await expect(page.getByText(/Stub answer to "NOCITE what is this\?"/)).toBeVisible();
    await expect(page.getByTestId("sources")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Show source/ })).toHaveCount(0);
  });

  test("history shows newest first", async ({ page }) => {
    await newSignedInUser(page);
    await page.locator("#pdf-upload").setInputFiles(pdf("first.pdf"));
    await page.getByRole("button", { name: "Summarize", exact: true }).click();
    await expect(page.locator("h3", { hasText: "first.pdf" })).toBeVisible();

    await page.getByRole("button", { name: "Remove first.pdf" }).click();
    await page.locator("#pdf-upload").setInputFiles(pdf("second.pdf"));
    await page.getByRole("button", { name: "Summarize", exact: true }).click();
    await expect(page.locator("h3", { hasText: "second.pdf" })).toBeVisible();

    const titles = await page.locator("h3").allTextContents();
    expect(titles.findIndex((t) => t.includes("second.pdf"))).toBeLessThan(
      titles.findIndex((t) => t.includes("first.pdf"))
    );
  });

  test("a summary goes on while the person looks at another page, and is shown when they come back", async ({ page }) => {
    await newSignedInUser(page);
    await page.goto("/dashboard");
    await summarizeText(page, `${ARTICLE} SLOW_ME`);
    await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();

    // Leaving the dashboard does not stop it, and the top bar says so.
    await page.getByRole("link", { name: "Reading list" }).click();
    await expect(page).toHaveURL(/\/reading/);
    const chip = page.getByTestId("summary-chip");
    await expect(chip).toContainText("Summarizing");

    // Back on the dashboard it is still being written (not lost), and then it is saved.
    await chip.click();
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
    await expect(page.getByTestId("document-card")).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByTestId("summary-chip")).toHaveCount(0);
  });

  test("a summary that finishes while the person is elsewhere is announced in the top bar", async ({ page }) => {
    await newSignedInUser(page);
    await page.goto("/dashboard");
    await summarizeText(page, `${ARTICLE} SLOW_ME`);
    await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
    await page.getByRole("link", { name: "Reading list" }).click();

    const chip = page.getByTestId("summary-chip");
    await expect(chip).toContainText("Summary ready", { timeout: 30_000 });
    await chip.click();
    // The saved summary is in the list; the form is empty, not showing the old one again.
    await expect(page.getByTestId("document-card")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Cancel" })).toHaveCount(0);
    await expect(page.getByTestId("summary-chip")).toHaveCount(0);
  });
});

async function summarizeTextAndWaitForCard(page: import("@playwright/test").Page) {
  await page.locator("#main-textarea").fill(ARTICLE);
  await page.getByRole("button", { name: "Summarize", exact: true }).click();
  await expect(page.locator("h3").first()).toBeVisible();
}
