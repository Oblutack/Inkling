import { expect, test, type Download, type Page } from "@playwright/test";
import { API, newSignedInUser, summarizeText } from "./support/helpers";

// Notes for other apps: one document as a Markdown note, and the whole library as a zip of notes. (The AI service is a stub:
// a study set has the cards "Front of card one/two/three" with the backs "Back of card one/two/three".)

const origin = { Origin: "http://localhost:13000" };

async function text(download: Download): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of await download.createReadStream()) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

// What a zip program reads from the end of the file: every file's name and text, with its check value verified.
function readZip(bytes: Buffer): Array<{ name: string; text: string }> {
  const end = bytes.length - 22;
  expect(bytes.readUInt32LE(end)).toBe(0x06054b50);
  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  const files: Array<{ name: string; text: string }> = [];
  for (let i = 0; i < count; i++) {
    const size = bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28);
    const local = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    files.push({ name, text: bytes.subarray(start, start + size).toString("utf8") });
    at += 46 + nameLength;
  }
  return files;
}

async function makeLibrary(page: Page) {
  const set = await page.request.post(`${API}/study-sets/text`, { data: { text: "Cell biology notes\nCells are the basic unit of life." }, headers: origin });
  expect(set.status()).toBe(201);
  await page.goto("/dashboard");
  await summarizeText(page, "Heat pumps are efficient. Sales rose in 2024.");
  await expect(page.getByTestId("document-card").filter({ hasText: "Heat pumps are efficient" })).toHaveCount(1);
  const docs = await (await page.request.get(`${API}/documents`)).json();
  const summary = docs.find((d: { Summary: string }) => d.Summary.trim() !== "");
  await page.request.put(`${API}/documents/${summary.ID}`, { data: { tags: ["energy", "home costs"] }, headers: origin });
  const saved = await page.request.post(`${API}/reading-list`, { data: { url: "https://blog.example/post" }, headers: origin });
  expect(saved.status()).toBe(201);
  return summary.ID as number;
}

test.describe("notes for Obsidian and Notion", () => {
  test("one document is downloaded as a note with front matter, its summary and tags", async ({ page }) => {
    await newSignedInUser(page);
    await makeLibrary(page);
    await page.goto("/dashboard");
    const card = page.getByTestId("document-card").filter({ hasText: "Heat pumps are efficient" }).first();
    await card.getByRole("button", { name: "More" }).click();
    const [download] = await Promise.all([page.waitForEvent("download"), card.getByRole("button", { name: "Obsidian note (.md)" }).click()]);
    expect(download.suggestedFilename()).toMatch(/^Heat pumps are efficient.*\.md$/);
    const note = (await text(download)).toString("utf8");
    expect(note.startsWith("---\ntitle: ")).toBe(true);
    expect(note).toMatch(/\ncreated: \d{4}-\d{2}-\d{2}T/);
    expect(note).toContain("tags:\n  - energy\n  - home-costs\n");
    expect(note).toContain("## Stub summary");
    expect(note).toContain("- Subject: pasted text");
  });

  test("a study set becomes a note with its flashcards in the plugin's form", async ({ page }) => {
    await newSignedInUser(page);
    await makeLibrary(page);
    await page.goto("/dashboard");
    // the flashcards of the set were made by the stub when the set was made
    const card = page.getByTestId("document-card").filter({ has: page.getByRole("heading", { name: "Cell biology notes" }) });
    await card.getByRole("button", { name: "More" }).click();
    const [download] = await Promise.all([page.waitForEvent("download"), card.getByRole("button", { name: "Obsidian note (.md)" }).click()]);
    const note = (await text(download)).toString("utf8");
    expect(note).toContain("## Flashcards");
    expect(note).toContain("Front of card one::Back of card one");
    expect(note).toContain("Front of card three::Back of card three");
    expect(note).toContain("  - flashcards");
  });

  test("the whole library is a zip with one note for each, from the account page", async ({ page }) => {
    await newSignedInUser(page);
    await makeLibrary(page);
    await page.goto("/account");
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download my notes (.zip)" }).click()]);
    expect(download.suggestedFilename()).toMatch(/^inkling-notes-\d{4}-\d{2}-\d{2}\.zip$/);
    const files = readZip(await text(download));
    expect(files).toHaveLength(3);
    expect(files.every((f) => f.name.startsWith("Inkling/") && f.name.endsWith(".md"))).toBe(true);
    const byTitle = (part: string) => files.find((f) => f.name.includes(part))!.text;
    expect(byTitle("Cell biology")).toContain("Front of card two::Back of card two");
    expect(byTitle("Page from blog.example")).toContain('source: "https://blog.example/post"');
    expect(byTitle("Heat pumps")).toContain("  - home-costs");
  });

  test("an empty library says so instead of making an empty zip", async ({ page }) => {
    await newSignedInUser(page);
    await page.goto("/account");
    await page.getByRole("button", { name: "Download my notes (.zip)" }).click();
    await expect(page.getByTestId("notes-message")).toHaveText("You have no saved summaries yet.");
  });
});
