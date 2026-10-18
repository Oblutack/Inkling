import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { newSignedInUser, summarizeText } from "./support/helpers";

// What a person can do with a saved summary beyond reading it.

async function saveDoc(page: Page, text: string, expectedCards: number) {
  await summarizeText(page, text);
  await expect(page.getByTestId("document-card")).toHaveCount(expectedCards);
}

// The card of a saved summary, found by its title.
function cardOf(page: Page, title: string) {
  return page.getByTestId("document-card").filter({ has: page.getByRole("heading", { name: title }) });
}

test.describe("renaming and tags", () => {
  test("a summary can be renamed, and the new title is kept", async ({ page }) => {
    await newSignedInUser(page);
    await saveDoc(page, "Alpha notes\nSome words about alpha.", 1);

    await page.getByRole("button", { name: "Rename Alpha notes" }).click();
    await page.getByLabel("Title").fill("Quarterly review");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Quarterly review" })).toBeVisible();

    await page.reload();
    await expect(page.getByRole("heading", { name: "Quarterly review" })).toBeVisible();
  });

  test("a blank title is refused and cancelling changes nothing", async ({ page }) => {
    await newSignedInUser(page);
    await saveDoc(page, "Alpha notes\nSome words about alpha.", 1);

    await page.getByRole("button", { name: "Rename Alpha notes" }).click();
    await page.getByLabel("Title").fill("   ");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("The title cannot be empty.")).toBeVisible();

    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("heading", { name: "Alpha notes" })).toBeVisible();
  });

  test("tags can be added, filtered by, and removed", async ({ page }) => {
    await newSignedInUser(page);
    await saveDoc(page, "Alpha notes\nSome words about alpha.", 1);
    await saveDoc(page, "Bravo plans\nSome words about bravo.", 2);

    const bravo = cardOf(page, "Bravo plans");
    await bravo.getByLabel("Add a tag").fill("Legal");
    await page.keyboard.press("Enter");
    await expect(bravo.getByTestId("tags")).toContainText("legal");

    const filter = page.getByRole("group", { name: "Filter by tag" });
    await expect(filter.getByRole("button", { name: "legal (1)" })).toBeVisible();
    await filter.getByRole("button", { name: "legal (1)" }).click();
    await expect(page.getByTestId("document-card")).toHaveCount(1);
    await expect(page.getByRole("heading", { name: "Bravo plans" })).toBeVisible();

    await filter.getByRole("button", { name: "All" }).click();
    await expect(page.getByTestId("document-card")).toHaveCount(2);

    await page.reload();
    await expect(cardOf(page, "Bravo plans").getByTestId("tags")).toContainText("legal");

    await cardOf(page, "Bravo plans").getByRole("button", { name: "Remove the tag legal" }).click();
    await expect(page.getByRole("group", { name: "Filter by tag" })).toHaveCount(0);
  });

  test("summaries are found by searching their title or text", async ({ page }) => {
    await newSignedInUser(page);
    await saveDoc(page, "Alpha notes\nSome words about alpha.", 1);
    await saveDoc(page, "Bravo plans\nSome words about bravo.", 2);

    const search = page.getByLabel("Search your summaries");
    await search.fill("bravo");
    await expect(page.getByTestId("document-card")).toHaveCount(1);
    await expect(page.getByRole("heading", { name: "Bravo plans" })).toBeVisible();

    await search.fill("zzzz");
    await expect(page.getByText("No summaries match your search.")).toBeVisible();

    await search.fill("");
    await expect(page.getByTestId("document-card")).toHaveCount(2);
  });

  test("a skeleton shows while the list loads", async ({ page }) => {
    await newSignedInUser(page);
    await saveDoc(page, "Alpha notes\nSome words about alpha.", 1);

    await page.route("**/documents?*", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.continue();
    });
    await page.reload();
    await expect(page.getByTestId("document-skeleton").first()).toBeVisible();
    await expect(page.getByText("You have no saved documents yet.")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Alpha notes" })).toBeVisible();
    await expect(page.getByTestId("document-skeleton")).toHaveCount(0);
  });
});

test.describe("questions, rewriting and study", () => {
  test("suggested questions are offered in the chat and can be asked with a click", async ({ page }) => {
    await newSignedInUser(page);
    await saveDoc(page, "Alpha notes\nSome words about alpha.", 1);

    await page.getByRole("button", { name: "Chat With Document" }).click();
    const suggestions = page.getByTestId("suggestions");
    await expect(suggestions.getByRole("button")).toHaveCount(4);
    await suggestions.getByRole("button", { name: "What is the main point?" }).click();
    await expect(page.getByText(/Stub answer to "What is the main point\?"/)).toBeVisible();
    await expect(page.getByTestId("suggestions")).toHaveCount(0);
  });

  test("selecting words in a summary offers to ask about them", async ({ page }) => {
    await newSignedInUser(page);
    await saveDoc(page, "Alpha notes\nSome words about alpha.", 1);

    await page.evaluate(() => {
      const item = [...document.querySelectorAll("[id^=doc-content-] li")].find((li) => li.textContent?.includes("Opening words"));
      const range = document.createRange();
      range.selectNodeContents(item!);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.locator("[id^=doc-content-]").first().dispatchEvent("mouseup");
    await page.getByRole("button", { name: "Ask about this" }).click();

    await expect(page.getByTestId("document-chat")).toBeVisible();
    await expect(page.getByTestId("document-chat").getByPlaceholder("Type a question")).toHaveValue(/What does this mean: "Opening words/);
    await expect(page.getByRole("button", { name: "Ask about this" })).toHaveCount(0);
  });

  test("a summary can be written again with another style and length", async ({ page }) => {
    await newSignedInUser(page);
    await saveDoc(page, "Alpha notes\nSome words about alpha.", 1);
    const card = page.getByTestId("document-card");

    await card.getByRole("button", { name: "More" }).click();
    await card.getByRole("button", { name: "Rewrite" }).click();
    await card.getByLabel("Length").selectOption({ label: "Detailed (500 words)" });
    await card.getByLabel("Style").selectOption({ label: "Bullet Points" });
    await card.getByRole("button", { name: "Write it again" }).click();

    await expect(card.getByText("Options: bullets, 500 words, English")).toBeVisible();
    await expect(page.getByTestId("rewrite")).toHaveCount(0);

    await page.reload();
    await expect(page.getByTestId("document-card").getByText("Options: bullets, 500 words, English")).toBeVisible();
  });

  test("flashcards can be flipped, moved through and shuffled", async ({ page }) => {
    await newSignedInUser(page);
    await saveDoc(page, "Alpha notes\nSome words about alpha.", 1);

    await page.getByTestId("document-card").getByRole("button", { name: "Study" }).click();
    await page.getByRole("button", { name: "Flashcards" }).click();
    const card = page.getByTestId("flashcard");
    await expect(card).toContainText("Front of card one");
    await card.click();
    await expect(card).toContainText("Back of card one");

    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(card).toContainText("Front of card two");
    await expect(page.getByTestId("flashcard-position")).toHaveText("2 / 3");

    await page.getByRole("button", { name: "Shuffle" }).click();
    await expect(page.getByTestId("flashcard-position")).toHaveText("1 / 3");
    await page.getByRole("button", { name: "Back", exact: true }).isDisabled();
  });

  test("a quiz is marked and scored", async ({ page }) => {
    await newSignedInUser(page);
    await saveDoc(page, "Alpha notes\nSome words about alpha.", 1);

    await page.getByTestId("document-card").getByRole("button", { name: "Study" }).click();
    await page.getByRole("button", { name: "Quiz" }).click();
    const quiz = page.getByTestId("quiz");

    await quiz.getByRole("button", { name: "Wrong A" }).click(); // wrong on purpose
    await expect(quiz.getByText("Not quite. The answer is: Right one")).toBeVisible();
    await expect(quiz.getByText("Because one.")).toBeVisible();
    await quiz.getByRole("button", { name: "Next question" }).click();

    await quiz.getByRole("button", { name: "Right two" }).click();
    await expect(quiz.getByText("Correct.")).toBeVisible();
    await quiz.getByRole("button", { name: "Next question" }).click();

    await quiz.getByRole("button", { name: "Right three" }).click();
    await quiz.getByRole("button", { name: "See your score" }).click();
    await expect(page.getByTestId("quiz-result")).toContainText("You got 2 of 3 right.");

    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByTestId("quiz")).toContainText("Question 1 of 3");
  });
});

test.describe("sharing, email and exports", () => {
  test("a summary can be shared by a link that works without an account and can be turned off", async ({ page, browser }) => {
    await newSignedInUser(page);
    await saveDoc(page, "Alpha notes\none two three four five six seven eight nine ZEBRAMARKER source text.", 1);

    await page.getByRole("button", { name: "More" }).click();
    await page.getByRole("button", { name: "Share a link" }).click();
    const link = await page.getByLabel("Public link").inputValue();
    expect(link).toMatch(/\/s\/[A-Za-z0-9_-]{43}$/);

    const stranger = await browser.newContext();
    const other = await stranger.newPage();
    await other.goto(link);
    await expect(other.getByTestId("shared-title")).toHaveText("Alpha notes");
    await expect(other.getByTestId("shared-summary")).toContainText("Stub summary");
    // The summary may echo the opening words; the rest of the source text must stay private.
    await expect(other.getByText("ZEBRAMARKER")).toHaveCount(0);

    await page.getByRole("button", { name: "Stop sharing" }).click();
    await expect(page.getByLabel("Public link")).toHaveCount(0);
    await other.reload();
    await expect(other.getByText("This link does not work")).toBeVisible();
    await stranger.close();
  });

  test("a link that never existed says so", async ({ page }) => {
    await page.goto("/s/" + "a".repeat(43));
    await expect(page.getByText("This link does not work")).toBeVisible();
    await page.goto("/s/not-a-token");
    await expect(page.getByText("This link does not work")).toBeVisible();
  });

  test("a summary can be emailed to its owner", async ({ page }) => {
    const email = await newSignedInUser(page);
    await saveDoc(page, "Alpha notes\nSome words about alpha.", 1);

    await page.getByRole("button", { name: "More" }).click();
    await page.getByRole("button", { name: "Email me this" }).click();
    await expect(page.getByText(`on its way to ${email}`)).toBeVisible();
  });

  test("a summary can be saved as a Markdown file and as a Word document", async ({ page }) => {
    await newSignedInUser(page);
    await saveDoc(page, "Alpha notes\nSome words about alpha.", 1);

    await page.getByRole("button", { name: "More" }).click();
    const markdown = page.waitForEvent("download");
    await page.getByRole("button", { name: "Save as Markdown" }).click();
    const md = await markdown;
    expect(md.suggestedFilename()).toBe("Alpha-notes.md");
    const text = await readFile((await md.path())!, "utf8");
    expect(text).toContain("# Alpha notes");
    expect(text).toContain("Stub summary");

    const word = page.waitForEvent("download");
    await page.getByRole("button", { name: "Save as Word" }).click();
    const docx = await word;
    expect(docx.suggestedFilename()).toBe("Alpha-notes.docx");
    const bytes = await readFile((await docx.path())!);
    expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");
  });

  test("a summary can be read aloud and stopped", async ({ page }) => {
    // The browser's own voices are not available in a test, so a stand-in records what would be spoken.
    await page.addInitScript(() => {
      const spoken: string[] = [];
      (window as unknown as { __spoken: string[] }).__spoken = spoken;
      class FakeUtterance {
        text: string;
        voice: unknown = null;
        onend: (() => void) | null = null;
        onerror: (() => void) | null = null;
        constructor(text: string) {
          this.text = text;
        }
      }
      (window as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance = FakeUtterance;
      Object.defineProperty(window, "speechSynthesis", {
        configurable: true,
        value: {
          getVoices: () => [],
          addEventListener() {},
          removeEventListener() {},
          speak: (u: { text: string }) => spoken.push(u.text),
          cancel() {},
        },
      });
    });
    await newSignedInUser(page);
    await saveDoc(page, "Alpha notes\nSome words about alpha.", 1);

    await page.getByRole("button", { name: "More" }).click();
    await page.getByRole("button", { name: "Read aloud" }).click();
    const reader = page.getByTestId("read-aloud");
    await expect(reader).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken.join(" "))).toContain("Stub summary");

    await reader.getByRole("button", { name: "Stop" }).click();
    await expect(reader.getByRole("button", { name: "Play", exact: true })).toBeVisible();

    // Closing the reader puts the button back.
    await page.getByRole("button", { name: "Close the reader" }).first().click();
    await expect(page.getByTestId("read-aloud")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Read aloud" })).toBeVisible();
  });
});

test.describe("themes and standing instructions", () => {
  test("the dark theme can be chosen and is remembered", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    await page.getByRole("button", { name: "Switch to the dark theme" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.getByRole("button", { name: "Switch to the light theme" })).toBeVisible();

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });

  test("the system's dark setting is followed until a choice is made", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });

  test("standing instructions are saved and reach every new summary", async ({ page }) => {
    await newSignedInUser(page);

    await page.getByRole("link", { name: "Account" }).click();
    await page.getByLabel("Instructions").fill("Focus on costs and deadlines.");
    await page.getByRole("button", { name: "Save instructions" }).click();
    await expect(page.getByText("Saved. New summaries will follow these.")).toBeVisible();

    await page.getByRole("link", { name: "Dashboard" }).click();
    await summarizeText(page, "Alpha notes\nSome words about alpha.");
    await expect(page.getByText("instructions: Focus on costs and deadlines.").first()).toBeVisible();

    await page.getByRole("link", { name: "Account" }).click();
    await expect(page.getByLabel("Instructions")).toHaveValue("Focus on costs and deadlines.");
    await page.getByLabel("Instructions").fill("");
    await page.getByRole("button", { name: "Save instructions" }).click();
    await expect(page.getByText("Cleared.")).toBeVisible();
  });
});

test.describe("installable app", () => {
  test("the manifest, its icons and the offline page are served", async ({ request }) => {
    const manifest = await request.get("/manifest.webmanifest");
    expect(manifest.ok()).toBe(true);
    const body = await manifest.json();
    expect(body).toMatchObject({ name: "Inkling", display: "standalone", start_url: "/" });
    expect(body.icons.map((i: { sizes: string }) => i.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    expect(body.icons.some((i: { purpose?: string }) => i.purpose === "maskable")).toBe(true);

    for (const icon of body.icons as { src: string }[]) {
      const response = await request.get(icon.src);
      expect(response.ok(), icon.src).toBe(true);
      expect(response.headers()["content-type"]).toContain("image/png");
    }
    const offline = await request.get("/offline.html");
    expect(offline.ok()).toBe(true);
    expect(await offline.text()).toContain("You are offline");
  });

  test("the service worker is served fresh and registers itself", async ({ page, request }) => {
    const worker = await request.get("/sw.js");
    expect(worker.ok()).toBe(true);
    expect(worker.headers()["content-type"]).toContain("javascript");
    expect(worker.headers()["cache-control"]).toContain("no-cache");

    await page.goto("/");
    const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
    expect(scope).toMatch(/\/$/);
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", /manifest\.webmanifest/);
  });

  test("a page that cannot be reached shows the offline page, and API calls are never answered by the worker", async ({ page, context }) => {
    await page.goto("/");
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    // Let the page be controlled by the worker (it claims clients when it activates).
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

    // The worker stores its offline page while it installs; going offline before that would prove nothing.
    await expect.poll(() => page.evaluate(async () => !!(await caches.match("/offline.html")))).toBe(true);

    await context.setOffline(true);
    await page.goto("/login").catch(() => undefined);
    await expect(page.getByRole("heading", { name: "You are offline" })).toBeVisible();
    await context.setOffline(false);
  });
});

test.describe("languages of the interface", () => {
  test.describe("a Spanish browser", () => {
    test.use({ locale: "es-ES" });

    test("starts in Spanish and says so in the page", async ({ page }) => {
      await page.goto("/");
      await expect(page.getByRole("button", { name: "Resumir", exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "Registrarse" })).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("lang", "es");
      await expect(page.locator("header").getByLabel("Idioma")).toHaveValue("es");
    });
  });

  test.describe("a Croatian browser", () => {
    test.use({ locale: "hr-HR" });

    test("gets the Bosnian interface", async ({ page }) => {
      await page.goto("/");
      await expect(page.getByRole("link", { name: "Registracija" })).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("lang", "bs");
    });
  });

  test("the language can be switched, and the choice is kept", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Summarize", exact: true })).toBeVisible();

    await page.locator("header").getByLabel("Language").selectOption("de");
    await expect(page.getByRole("button", { name: "Zusammenfassen", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Registrieren" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "de");

    await page.reload();
    await expect(page.getByRole("button", { name: "Zusammenfassen", exact: true })).toBeVisible();

    await page.locator("header").getByLabel("Sprache").selectOption("en");
    await expect(page.getByRole("button", { name: "Summarize", exact: true })).toBeVisible();
  });

  test("a signed-in dashboard is fully translated, and the summary language stays the person's choice", async ({ page }) => {
    await newSignedInUser(page);
    await summarizeText(page, "Alpha notes\nSome words about alpha.");
    await expect(page.getByTestId("document-card")).toHaveCount(1);

    await page.getByTestId("document-card").getByRole("button", { name: "More" }).click();
    await page.locator("header").getByLabel("Language").selectOption("es");
    await expect(page.getByRole("heading", { name: "Tu panel" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Resúmenes guardados" })).toBeVisible();
    const card = page.getByTestId("document-card");
    await expect(card.getByRole("button", { name: "Comprobar con el original" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Chatear con el documento" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Estudiar" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Guardar como Word" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Compartir un enlace" })).toBeVisible();
    await expect(page.getByLabel("Buscar en tus resúmenes")).toBeVisible();

    // The names of the summary languages are translated; their values (what the model is told) are not.
    const language = page.getByLabel("Idioma").last();
    await expect(language.locator("option", { hasText: "Inglés" })).toHaveAttribute("value", "English");

    await card.getByRole("button", { name: "Chatear con el documento" }).click();
    await expect(page.getByTestId("document-chat").getByPlaceholder("Escribe una pregunta")).toBeVisible();
    await expect(page.getByTestId("suggestions")).toBeVisible();
  });

  test("the account page and the shared page follow the language", async ({ page, browser }) => {
    await newSignedInUser(page);
    await page.locator("header").getByLabel("Language").selectOption("fr");
    await page.getByRole("link", { name: "Compte" }).click();
    await expect(page.getByRole("heading", { name: "Votre compte" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Utilisation du jour" })).toBeVisible();

    const stranger = await browser.newContext({ locale: "de-DE" });
    const other = await stranger.newPage();
    await other.goto("/s/" + "a".repeat(43));
    await expect(other.getByText("Dieser Link funktioniert nicht")).toBeVisible();
    await stranger.close();
  });
});
