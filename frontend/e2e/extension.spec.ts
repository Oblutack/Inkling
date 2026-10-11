import AxeBuilder from "@axe-core/playwright";
import { chromium, expect, test, type APIRequestContext, type BrowserContext, type Page, request as playwrightRequest } from "@playwright/test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API, PASSWORD, uniqueEmail } from "./support/helpers";

// The browser extension, loaded into a real Chromium and driven through its popup and settings page, against the same
// stack as the other tests (the Go API, with a stub AI service). The extension is copied first with two additions that
// only the test needs: a fixed key (so its address is known) and permission for localhost (a person gives that when
// they save the settings; a test cannot click the browser's own permission prompt).

// What the extension's own pages (where some of these checks run) have: the part of the browser's extension API used here.
declare const chrome: { tabs: { query(filter: { url?: string }): Promise<{ id?: number; url?: string }[]> } };

const ORIGIN = "http://localhost:13000"; // the website, which is where a person makes the key
const ARTICLE_HOST = "http://localhost:9911";

const words = (text: string) => text.split(/\s+/).filter(Boolean);

function extensionCopy(): { dir: string; id: string } {
  const dir = mkdtempSync(join(tmpdir(), "inkling-extension-"));
  cpSync(join(__dirname, "..", "..", "extension"), dir, {
    recursive: true,
    filter: (source) => !/[\\/](test|node_modules)([\\/]|$)/.test(source) && !source.endsWith("package.json"),
  });
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const der = publicKey.export({ type: "spki", format: "der" });
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  manifest.key = der.toString("base64");
  manifest.host_permissions = ["http://localhost/*"];
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  // an extension's address: the first 128 bits of the key's hash, written with the letters a to p
  const id = [...createHash("sha256").update(der).digest().subarray(0, 16)]
    .map((byte) => String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 15)))
    .join("");
  return { dir, id };
}

// An account and a key for it, made the way a person does on the website.
async function newKey(api: APIRequestContext, options: { name: string; dailyLimit?: number }): Promise<string> {
  const headers = { Origin: ORIGIN };
  const email = uniqueEmail("ext");
  expect((await api.post("/signup", { data: { email, password: PASSWORD }, headers })).ok()).toBeTruthy();
  expect((await api.post("/login", { data: { email, password: PASSWORD }, headers })).ok()).toBeTruthy();
  const made = await api.post("/account/api-keys", { data: options, headers });
  expect(made.status()).toBe(201);
  return (await made.json()).key as string;
}

const ARTICLE = {
  title: "Heat pumps in cold climates",
  heading: "Heat pumps in cold climates",
  paragraphs: [
    "Heat pumps move heat from the outside air into a building instead of burning fuel to make it, which is why they use far less energy than a boiler.",
    "Modern models keep working well below freezing, and sales in the coldest parts of Europe have risen every year since 2019.",
    "The main cost is the installation, which can take a few days and may need new radiators, but running costs fall as soon as the work is done.",
    "Governments in many countries now pay part of the cost, so the price a household sees is often a third lower than the list price.",
  ],
};
const ARTICLE_HTML = `<!doctype html><html><head><title>${ARTICLE.title}</title></head><body>
  <nav>Home | News | Sport | Weather | Contact | Sign in</nav>
  <article><h1>${ARTICLE.heading}</h1>${ARTICLE.paragraphs.map((p) => `<p>${p}</p>`).join("")}</article>
  <aside style="display:none">Hidden advert text that must not be read</aside>
  <footer>Copyright and cookie notice and other footer words</footer></body></html>`;
const ARTICLE_WORDS = words(`${ARTICLE.title} ${ARTICLE.heading} ${ARTICLE.paragraphs.join(" ")}`).length;

test.describe.configure({ mode: "serial" });

test.describe("the browser extension", () => {
  let context: BrowserContext;
  let dir: string;
  let id: string;
  let api: APIRequestContext;
  let key: string;

  test.beforeAll(async () => {
    ({ dir, id } = extensionCopy());
    api = await playwrightRequest.newContext({ baseURL: API });
    key = await newKey(api, { name: "extension e2e" });
    context = await chromium.launchPersistentContext("", {
      channel: "chromium", // the bundled Chromium: a branded Chrome no longer loads extensions from the command line
      headless: true,
      args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`],
    });
    await context.route(`${ARTICLE_HOST}/**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/thin") return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Report</title><body>Tiny</body>" });
      return route.fulfill({ contentType: "text/html", body: ARTICLE_HTML });
    });
  });

  test.afterAll(async () => {
    await context?.close();
    await api?.dispose();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const extensionUrl = (file: string) => `chrome-extension://${id}/${file}`;

  async function openOptions(): Promise<Page> {
    const page = await context.newPage();
    await page.goto(extensionUrl("options.html"));
    return page;
  }

  // Saves the address and key in the settings page, the way a person would.
  async function configure(options: Page, apiKey: string, address = API) {
    await options.getByLabel("Inkling address").fill(address);
    await options.getByLabel("API key").fill(apiKey);
    await options.getByRole("button", { name: "Save", exact: true }).click();
    await expect(options.getByRole("status")).toHaveText("Settings saved.");
  }

  // The popup, aimed at a web page the way the toolbar button aims it at the page you are on.
  async function popupFor(path: string): Promise<{ popup: Page; article: Page }> {
    const article = await context.newPage();
    await article.goto(`${ARTICLE_HOST}${path}`);
    const options = await openOptions();
    const tabId = await options.evaluate(async (pattern) => {
      const tabs = await chrome.tabs.query({ url: pattern });
      return tabs[0].id;
    }, `${ARTICLE_HOST}/*`);
    await options.close();
    const popup = await context.newPage();
    await popup.goto(extensionUrl(`popup.html?tab=${tabId}`));
    return { popup, article };
  }

  test("before it is set up, the popup says what is needed and opens the settings", async () => {
    const popup = await context.newPage();
    await popup.goto(extensionUrl("popup.html"));
    await expect(popup.getByRole("heading", { name: "Connect Inkling" })).toBeVisible();
    await expect(popup.getByRole("button", { name: "Summarize this page" })).toBeHidden();
    const [settings] = await Promise.all([context.waitForEvent("page"), popup.getByRole("button", { name: "Open settings" }).click()]);
    await expect(settings.getByRole("heading", { name: "Inkling settings" })).toBeVisible();
    await settings.close();
    await popup.close();
  });

  test("the settings are checked before they are kept, and the connection can be tested", async () => {
    const options = await openOptions();
    await options.getByLabel("Inkling address").fill("http://example.com");
    await options.getByLabel("API key").fill("not a key");
    await options.getByRole("button", { name: "Save", exact: true }).click();
    await expect(options.getByText("Enter a valid address that starts with https://")).toBeVisible();
    await options.getByLabel("Inkling address").fill(API);
    await options.getByRole("button", { name: "Save", exact: true }).click();
    await expect(options.getByText("An Inkling API key starts with ink_.")).toBeVisible();
    await expect(options.getByRole("status")).toHaveText("");

    // the key is hidden as it is typed, and can be shown
    const field = options.getByLabel("API key");
    await expect(field).toHaveAttribute("type", "password");
    await options.getByRole("button", { name: "Show" }).click();
    await expect(field).toHaveAttribute("type", "text");
    await options.getByRole("button", { name: "Hide" }).click();

    await options.locator("#language").selectOption("German");
    await configure(options, key);
    await options.getByRole("button", { name: "Test the connection" }).click();
    await expect(options.getByRole("status")).toContainText("Connected. Key “extension e2e”: 0 requests used today.");

    // what was saved is there after a reload
    await options.reload();
    await expect(options.getByLabel("Inkling address")).toHaveValue(API);
    await expect(options.getByLabel("API key")).toHaveValue(key);
    await expect(options.locator("#language")).toHaveValue("German");
    await options.locator("#language").selectOption("English");
    await options.getByRole("button", { name: "Save", exact: true }).click();
    await options.close();
  });

  test("a page is read in the browser and summarized, and the result is shown as a list", async () => {
    const { popup, article } = await popupFor("/article");
    await expect(popup.getByText(ARTICLE.title, { exact: true })).toBeVisible();
    await expect(popup.getByText("localhost:9911")).toBeVisible();
    await expect(popup.getByRole("button", { name: "Summarize the selection" })).toBeHidden();

    await popup.getByRole("button", { name: "Summarize this page" }).click();
    const summary = popup.locator("#summary");
    await expect(summary.getByRole("heading", { name: "Stub summary" })).toBeVisible();
    await expect(summary.locator("li")).toHaveCount(4);
    // the title comes first, then the page
    await expect(summary).toContainText(`Opening words: ${words(`${ARTICLE.title} ${ARTICLE.heading}`).slice(0, 8).join(" ")}`);
    // the article's own words (not the menu, the footer or the hidden advert) were what was read
    await expect(summary).toContainText(`Words in source: ${ARTICLE_WORDS}`);
    await expect(summary).toContainText("Options: default, 150 words, English");
    await expect(popup.getByRole("status").filter({ hasText: "summaries left today" })).toBeVisible();
    await expect(summary).toBeFocused();
    await expect(popup.getByRole("heading", { name: "Summary", exact: true })).toBeVisible();
    await popup.close();
    await article.close();
  });

  test("a selection is summarized instead of the page", async () => {
    const { popup, article } = await popupFor("/article");
    // select the second paragraph the way a person does, then (as the toolbar button would) look at the page again
    await article.evaluate(() => {
      const paragraph = document.querySelectorAll("article p")[1];
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await popup.reload();
    const selected = ARTICLE.paragraphs[1];
    await expect(popup.getByText(`${words(selected).length} words selected`)).toBeVisible();
    await popup.getByRole("button", { name: "Summarize the selection" }).click();
    await expect(popup.locator("#summary")).toContainText(`Words in source: ${words(selected).length}`);
    await expect(popup.locator("#summary")).toContainText(`Opening words: ${words(selected).slice(0, 8).join(" ")}`);
    await popup.close();
    await article.close();
  });

  test("length, style and keeping the result are chosen in the popup, and remembered", async () => {
    const { popup, article } = await popupFor("/article");
    await popup.getByLabel("Length").selectOption({ label: "Long (about 300)" });
    await popup.getByLabel("Style").selectOption({ label: "Bullet points" });
    await popup.getByLabel("Keep it in my Inkling library").check();
    await popup.getByRole("button", { name: "Summarize this page" }).click();
    await expect(popup.locator("#summary")).toContainText("Options: bullets, 300 words, English");
    await expect(popup.getByRole("status").filter({ hasText: "Saved to your library." })).toBeVisible();

    // it is in the person's library on the website
    const documents = await (await api.get("/documents", { headers: { Origin: ORIGIN } })).json();
    const list: { Filename?: string }[] = Array.isArray(documents) ? documents : documents.documents;
    expect(list.map((d) => d.Filename)).toEqual([ARTICLE.title]); // named after the page

    // the choices are still there next time
    await popup.reload();
    await expect(popup.getByLabel("Length")).toHaveValue("300");
    await expect(popup.getByLabel("Style")).toHaveValue("bullets");
    await expect(popup.getByLabel("Keep it in my Inkling library")).toBeChecked();
    await popup.getByLabel("Keep it in my Inkling library").uncheck();
    await popup.getByLabel("Length").selectOption({ label: "Medium (about 150)" });
    await popup.getByLabel("Style").selectOption({ label: "Standard" });
    await popup.close();
    await article.close();
  });

  test("the summary can be copied, and another can be made", async () => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: `chrome-extension://${id}` }).catch(() => {});
    const { popup, article } = await popupFor("/article");
    await popup.getByRole("button", { name: "Summarize this page" }).click();
    await expect(popup.locator("#summary")).toContainText("Stub summary");
    await popup.getByRole("button", { name: "Copy", exact: true }).click();
    await expect(popup.getByRole("button", { name: "Copied" })).toBeVisible();
    await popup.getByRole("button", { name: "Summarize again" }).click();
    await expect(popup.getByRole("button", { name: "Summarize this page" })).toBeVisible();
    await expect(popup.locator("#summary")).toBeHidden();
    await popup.close();
    await article.close();
  });

  test("a page with no text of its own, such as a PDF in the browser's viewer, is handed to the server by its address", async () => {
    const { popup, article } = await popupFor("/thin");
    await popup.getByRole("button", { name: "Summarize this page" }).click();
    await expect(popup.locator("#summary")).toContainText("Subject: Page from localhost");
    await popup.close();
    await article.close();
  });

  test("a page the browser does not let extensions read is said so, plainly", async () => {
    const page = await context.newPage();
    await page.goto("chrome://version");
    const options = await openOptions();
    // the extension may not even see the address of such a page: the one tab whose address it cannot see is that one
    const tabId = await options.evaluate(async () => (await chrome.tabs.query({})).find((tab) => tab.url === undefined)?.id);
    expect(tabId).toBeGreaterThan(0);
    await options.close();
    const popup = await context.newPage();
    await popup.goto(extensionUrl(`popup.html?tab=${tabId}`));
    await expect(popup.getByRole("alert")).toContainText("Inkling cannot read this kind of page");
    await expect(popup.getByRole("button", { name: "Summarize this page" })).toBeDisabled();
    await popup.close();
    await page.close();
  });

  test("a wrong key, and a key at its own limit, are explained", async () => {
    const options = await openOptions();
    await configure(options, "ink_" + "x".repeat(40));
    const wrong = await popupFor("/article");
    await wrong.popup.getByRole("button", { name: "Summarize this page" }).click();
    await expect(wrong.popup.getByRole("alert")).toContainText("The API key was not accepted.");
    await expect(wrong.popup.getByRole("button", { name: "Summarize this page" })).toBeVisible(); // it can be tried again
    await wrong.popup.close();
    await wrong.article.close();

    await configure(options, await newKey(api, { name: "one only", dailyLimit: 1 }));
    const limited = await popupFor("/article");
    await limited.popup.getByRole("button", { name: "Summarize this page" }).click();
    await expect(limited.popup.locator("#summary")).toContainText("Stub summary");
    await limited.popup.getByRole("button", { name: "Summarize again" }).click();
    await limited.popup.getByRole("button", { name: "Summarize this page" }).click();
    await expect(limited.popup.getByRole("alert")).toContainText("This key has used its daily limit.");
    await limited.popup.close();
    await limited.article.close();

    await configure(options, key); // back to the good key
    await options.close();
  });

  test("a server that cannot be reached is named", async () => {
    const options = await openOptions();
    await configure(options, key, "http://localhost:1"); // nothing listens there
    const { popup, article } = await popupFor("/article");
    await popup.getByRole("button", { name: "Summarize this page" }).click();
    await expect(popup.getByRole("alert")).toContainText("Could not reach localhost:1.");
    await popup.close();
    await article.close();
    await configure(options, key);
    await options.close();
  });

  test("the popup and the settings page have no accessibility violations", async () => {
    const options = await openOptions();
    const optionsResults = await new AxeBuilder({ page: options }).analyze();
    expect(optionsResults.violations).toEqual([]);
    await options.close();

    const { popup, article } = await popupFor("/article");
    await expect(popup.getByRole("button", { name: "Summarize this page" })).toBeEnabled();
    expect((await new AxeBuilder({ page: popup }).analyze()).violations).toEqual([]);
    await popup.getByRole("button", { name: "Summarize this page" }).click();
    await expect(popup.locator("#summary")).toContainText("Stub summary");
    expect((await new AxeBuilder({ page: popup }).analyze()).violations).toEqual([]);
    await popup.close();
    await article.close();
  });
});
