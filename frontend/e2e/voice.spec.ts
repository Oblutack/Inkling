import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { installFakeSpeech, spoken } from "./support/speech";
import { newSignedInUser, summarizeText } from "./support/helpers";

// Talking to a document. (The browser here has a fake microphone, the AI service is a stub that always "hears" the words
// "What is the notice period?", and the speech engine is a stand-in that finishes each piece after a short delay.)

const tags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const QUESTION = "What is the notice period?";

async function openChat(page: Page) {
  await newSignedInUser(page);
  await page.goto("/dashboard");
  await summarizeText(page, "The notice period is sixty days. The deposit is returned within thirty days.");
  const card = page.getByTestId("document-card").first();
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Chat With Document" }).click();
  return page.getByTestId("document-chat");
}

test.describe("talking to a document", () => {
  test("a spoken question is written down, asked like a typed one, and answered with sources", async ({ page }) => {
    const chat = await openChat(page);
    await expect(chat.getByTestId("voice-button")).toBeVisible();

    await chat.getByTestId("voice-button").click();
    await expect(chat.getByTestId("voice-listening")).toBeVisible();
    const heard = page.waitForResponse((r) => r.url().endsWith("/voice/transcribe") && r.status() === 200);
    await chat.getByRole("button", { name: "Stop and ask" }).click();
    await heard;

    // what was heard is in the conversation as the question, and the answer follows with its source
    await expect(chat.getByText(QUESTION, { exact: true })).toBeVisible();
    await expect(chat.getByText(`Stub answer to "${QUESTION}"`)).toBeVisible();
    await expect(chat.getByTestId("voice-listening")).toHaveCount(0);
    await expect(chat.getByTestId("voice-button")).toBeEnabled();
  });

  test("listening can be cancelled, and nothing is asked", async ({ page }) => {
    const chat = await openChat(page);
    let sent = 0;
    await page.route("**/voice/transcribe", (route) => {
      sent += 1;
      return route.continue();
    });
    await chat.getByTestId("voice-button").click();
    await expect(chat.getByTestId("voice-listening")).toBeVisible();
    await chat.getByRole("button", { name: "Cancel" }).click();
    await expect(chat.getByTestId("voice-listening")).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(sent).toBe(0);
    await expect(chat.getByText(QUESTION)).toHaveCount(0);
  });

  test("the answer is read aloud without its citation numbers when that is switched on", async ({ page }) => {
    await installFakeSpeech(page, { voices: true, delay: 100 });
    const chat = await openChat(page);
    await chat.getByLabel("Read answers aloud").check();
    await chat.getByTestId("voice-button").click();
    await chat.getByRole("button", { name: "Stop and ask" }).click();
    await expect(chat.getByText(`Stub answer to "${QUESTION}"`)).toBeVisible();

    await expect.poll(async () => (await spoken(page)).length).toBe(1);
    const [line] = await spoken(page);
    expect(line.text).toContain(`Stub answer to "${QUESTION}"`);
    expect(line.text).not.toMatch(/\[\d+\]/);
  });

  test("a typed question is not read aloud unless asked for, and an answer is read when it is", async ({ page }) => {
    await installFakeSpeech(page, { voices: true, delay: 100 });
    const chat = await openChat(page);
    await chat.getByPlaceholder("Type a question").fill("Who pays?");
    await chat.getByRole("button", { name: "Ask", exact: true }).click();
    await expect(chat.getByText('Stub answer to "Who pays?"')).toBeVisible();
    expect((await spoken(page)).length).toBe(0);

    await chat.getByLabel("Read answers aloud").check();
    await chat.getByPlaceholder("Type a question").fill("Who else?");
    await chat.getByRole("button", { name: "Ask", exact: true }).click();
    await expect.poll(async () => (await spoken(page)).length).toBe(1);
  });

  test("hands-free listens, asks, reads the answer, and listens again until it is switched off", async ({ page }) => {
    await installFakeSpeech(page, { voices: true, delay: 300 });
    const chat = await openChat(page);
    await chat.getByLabel("Hands-free").check();
    await expect(chat.getByLabel("Read answers aloud")).toBeChecked(); // it reads the answers, so the voice can be waited for
    await expect(chat.getByTestId("voice-listening")).toBeVisible();

    await chat.getByRole("button", { name: "Stop and ask" }).click();
    await expect(chat.getByText(`Stub answer to "${QUESTION}"`)).toBeVisible();
    await expect.poll(async () => (await spoken(page)).length).toBe(1);
    // when the answer has been read, the next question is listened for
    await expect(chat.getByTestId("voice-listening")).toBeVisible({ timeout: 10_000 });

    await chat.getByLabel("Hands-free").uncheck();
    await expect(chat.getByTestId("voice-listening")).toHaveCount(0);
    await expect(chat.getByTestId("voice-button")).toBeVisible();
  });

  test("a question that could not be understood is explained and ends hands-free", async ({ page }) => {
    await installFakeSpeech(page, { voices: true, delay: 100 });
    const chat = await openChat(page);
    await page.route("**/voice/transcribe", (route) =>
      route.fulfill({
        status: 422,
        contentType: "application/json",
        body: JSON.stringify({ error: "No speech was found in that recording." }),
        // the answer comes from another address than the page, so it must say the page may read it
        headers: { "access-control-allow-origin": "http://localhost:13000", "access-control-allow-credentials": "true" },
      }),
    );
    await chat.getByLabel("Hands-free").check();
    await chat.getByRole("button", { name: "Stop and ask" }).click();
    await expect(chat.getByRole("alert")).toContainText("No speech was found");
    await expect(chat.getByLabel("Hands-free")).not.toBeChecked();
    await expect(chat.getByTestId("voice-listening")).toHaveCount(0);
  });

  test("the library chat can be spoken to as well", async ({ page }) => {
    await newSignedInUser(page);
    await page.goto("/dashboard");
    await summarizeText(page, "The notice period is sixty days.");
    await expect(page.getByTestId("document-card").first()).toBeVisible();
    await expect(page.getByTestId("voice-button").first()).toBeVisible();
  });

  test("the voice controls have no accessibility violations", async ({ page }) => {
    await installFakeSpeech(page, { voices: true, delay: 100 });
    const chat = await openChat(page);
    await expect(chat.getByTestId("voice-controls")).toBeVisible();
    let results = await new AxeBuilder({ page }).withTags(tags).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
    await chat.getByTestId("voice-button").click();
    await expect(chat.getByTestId("voice-listening")).toBeVisible();
    results = await new AxeBuilder({ page }).withTags(tags).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});
