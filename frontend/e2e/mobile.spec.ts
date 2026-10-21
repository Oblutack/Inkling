import { expect, test, type Locator, type Page } from "@playwright/test";
import { API, PASSWORD, realPdf, summarizeText, uniqueEmail } from "./support/helpers";

// The app on a phone. This file runs twice (see the "iphone" and "pixel" projects in playwright.config.ts): in WebKit, the
// engine of every iPhone browser, with an iPhone's screen, and in Chromium with an Android phone's. Each test walks through a
// part of the app and checks what a person on a phone would trip over, so a change that breaks the phone layout fails here.
//
//   - nothing makes the page scroll sideways, and nothing hangs off the right edge
//   - buttons, fields and links are big enough for a finger (an iPhone's guideline is 44 points, WCAG's minimum 24)
//   - a field's text is at least 16 px, or an iPhone zooms into the page when it is tapped
//   - text is not too small to read
//   - a pop-up (the PDF viewer) fits inside the screen, with its Close button on it

const origin = { Origin: "http://localhost:13000" };
const LEASE = [
  "## Lease terms.",
  "The lease ends on 28 February 2027.",
  "Rent is due on the first day of each month.",
  "The deposit sits in escrow and the lease renews automatically for another year.",
  "Escrow arrears and the lessor are described here. The tenant pays 950 euros rent per month.",
].join("\n");

interface Finding {
  where: string;
  problem: string;
}

// Looks at the page as it is now and lists what a phone would trip over. `scope` limits the look to one part of the page.
async function settle(page: Page) {
  // wait until nothing is moving: CSS animations done, and the page height the same for a few looks in a row
  // (the ones that follow the scroll position, and the ones that repeat for ever, do not finish)
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.timeline === document.timeline && a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
  let last = -1, same = 0;
  for (let i = 0; i < 16 && same < 4; i++) {
    const h = await page.evaluate(() => `${document.documentElement.scrollHeight}:${Math.round(document.body.getBoundingClientRect().height)}`);
    same = h === String(last) ? same + 1 : 0;
    last = h as unknown as number;
    await page.waitForTimeout(120);
  }
}

async function audit(page: Page, where: string, scope?: Locator): Promise<Finding[]> {
  await settle(page);
  const root = scope ? await scope.elementHandle() : null;
  const found = await page.evaluate((rootEl) => {
    const out: Array<[string, string]> = [];
    const base = (rootEl as Element | null) ?? document.body;
    const vw = document.documentElement.clientWidth;
    const label = (el: Element) => {
      const text = (el.getAttribute("aria-label") || el.textContent || el.getAttribute("placeholder") || el.getAttribute("title") || "").replace(/\s+/g, " ").trim();
      return `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""} "${text.slice(0, 32)}"`;
    };
    const visible = (el: Element) => {
      const b = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return b.width > 0 && b.height > 0 && st.visibility !== "hidden" && st.display !== "none" && !el.closest("[aria-hidden='true']") && !el.closest(".sr-only");
    };
    const inScroller = (el: Element) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const o = getComputedStyle(p).overflowX;
        if (o === "auto" || o === "scroll" || o === "hidden" || o === "clip") return true;
      }
      return false;
    };

    // 1. the page scrolls sideways, or something hangs off the right edge
    if (!rootEl && document.documentElement.scrollWidth > vw + 1) out.push(["sideways", `the page is ${document.documentElement.scrollWidth}px wide on a ${vw}px screen`]);
    let hanging = 0;
    for (const el of base.querySelectorAll("*")) {
      if (!visible(el) || getComputedStyle(el).position === "fixed" || el.closest("svg")) continue;
      const b = el.getBoundingClientRect();
      if (b.right > vw + 1 && !inScroller(el)) {
        if (hanging++ < 4) out.push(["off the edge", `${label(el)} reaches ${Math.round(b.right)}px on a ${vw}px screen`]);
      }
    }

    // 2. controls a finger can hit, and fields that make an iPhone zoom
    for (const el of base.querySelectorAll("a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=radio], [role=checkbox]")) {
      if (!visible(el) || el.closest("svg")) continue;
      if (el.matches("a.sr-only, a[href='#main']")) continue;
      let target: Element = el;
      if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
        const lab = el.closest("label") ?? (el.id ? document.querySelector(`label[for="${el.id}"]`) : null);
        if (lab && visible(lab)) target = lab;
      }
      // a link that is a piece of a sentence is as big as the sentence: only links on their own line are held to the size
      if (target instanceof HTMLAnchorElement) {
        const parent = target.parentElement;
        const around = parent ? (parent.textContent || "").replace(target.textContent || "", "").trim().length : 0;
        if (around > 12) continue;
      }
      const b = target.getBoundingClientRect();
      const h = Math.round(b.height), w = Math.round(b.width);
      if (h < 24 || w < 24) out.push(["too small to tap", `${label(el)} is ${w}x${h}px (24 is the least)`]);
      else if (h < 40 && !(target instanceof HTMLAnchorElement)) out.push(["small to tap", `${label(el)} is ${w}x${h}px (aim for 40 or more high)`]);
      if (el instanceof HTMLInputElement && !["checkbox", "radio", "range", "file", "button", "submit"].includes(el.type) || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
        const fs = parseFloat(getComputedStyle(el).fontSize);
        if (fs < 16) out.push(["zooms on tap", `${label(el)} has ${fs}px text, an iPhone zooms in below 16px`]);
      }
    }

    // 3. text that is too small to read
    let tiny = 0;
    const walker = document.createTreeWalker(base, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = (n.textContent || "").trim();
      const el = n.parentElement;
      if (!text || !el || !visible(el) || el.closest("svg, script, style, canvas, .textLayer, [data-testid='mind-map']")) continue;
      const fs = parseFloat(getComputedStyle(el).fontSize);
      if (fs < 12 && tiny++ < 3) out.push(["tiny text", `${label(el)} is ${fs}px`]);
    }
    return out;
  }, root);
  return found.map(([problem, detail]) => ({ where, problem: `${problem}: ${detail}` }));
}

// What gets reported: the problems that matter. "small to tap" (under 40 high but over 24) is a warning, so it is listed
// in the report but does not fail the test.
function hard(findings: Finding[]): string[] {
  return findings.filter((f) => !f.problem.startsWith("small to tap")).map((f) => `${f.where} | ${f.problem}`);
}
function soft(findings: Finding[]): string[] {
  return findings.filter((f) => f.problem.startsWith("small to tap")).map((f) => `${f.where} | ${f.problem}`);
}
const warnings: string[] = [];
function check(findings: Finding[]) {
  warnings.push(...soft(findings));
  return hard(findings);
}

test.afterEach(({}, info) => {
  if (warnings.length) {
    if (process.env.SHOW_SMALL) for (const w of new Set(warnings)) console.log(`SMALL ${info.project.name} :: ${w}`);
    info.annotations.push({ type: "small tap targets", description: [...new Set(warnings)].join("\n") });
    warnings.length = 0;
  }
});

// A new account, signed in. On a phone the page takes longer to come alive, and a field typed into before it has is cleared again,
// so each form is waited for first (the shared helper of the desktop tests does not need that).
async function newSignedInUser(page: Page) {
  const email = uniqueEmail("phone");
  for (const [path, button] of [["/signup", "Sign Up"], ["/login", "Sign In"]] as const) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await page.locator("#email").fill(email);
    await expect(page.locator("#email")).toHaveValue(email);
    await page.locator("#password").fill(PASSWORD);
    await page.getByRole("button", { name: button, exact: true }).click();
    if (path === "/signup") await expect(page.getByText("Check your email")).toBeVisible();
  }
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByRole("heading", { name: "Your Dashboard" })).toBeVisible();
}

const card = (page: Page, text: string | RegExp) => page.getByTestId("document-card").filter({ hasText: text }).first();

async function openPanel(saved: Locator, button: string, ready: Locator) {
  const more = saved.getByRole("button", { name: "More" });
  const target = saved.getByRole("button", { name: button, exact: true });
  if (!(await target.isVisible())) await more.click();
  await target.click();
  await expect(ready).toBeVisible();
}

test.describe("on a phone", () => {
  test("the pages before signing in fit the screen", async ({ page }) => {
    const problems: string[] = [];
    for (const path of ["/", "/login", "/signup", "/forgot-password"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      problems.push(...check(await audit(page, `page ${path}`)));
    }
    expect(problems).toEqual([]);
  });

  test("the dashboard, the menu and the other pages fit the screen", async ({ page }) => {
    await newSignedInUser(page);
    const problems: string[] = [];
    await page.waitForLoadState("networkidle");
    problems.push(...check(await audit(page, "dashboard (empty)")));

    // the menu opens, shows every page, and each entry is a finger-sized target
    const menu = page.getByRole("button", { name: /menu/i }).first();
    await menu.click();
    await expect(page.getByRole("link", { name: "Reading list" })).toBeVisible();
    problems.push(...check(await audit(page, "navigation menu open")));
    await page.keyboard.press("Escape");

    for (const path of ["/account", "/exam", "/reading", "/watches"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      problems.push(...check(await audit(page, `page ${path}`)));
    }
    expect(problems).toEqual([]);
  });

  test("a summary and every panel of its card fit the screen", async ({ page }) => {
    await newSignedInUser(page);
    await page.goto("/dashboard");
    await summarizeText(page, LEASE);
    const saved = card(page, "Lease terms");
    await expect(saved).toBeVisible();
    const problems: string[] = [];
    problems.push(...check(await audit(page, "a saved summary", saved)));

    const panels: Array<[string, string, string]> = [
      ["Chat With Document", "chat", "document-chat"],
      ["Mind map", "mind map", "mind-map"],
      ["Find the terms", "terms", "glossary-panel"],
      ["Also in another language", "translation", "bilingual-panel"],
      ["Check this contract", "contract checklist", "checklist-panel"],
      ["Find dates and deadlines", "dates", "dates-panel"],
      ["Highlights and notes", "highlights", "highlights-panel"],
    ];
    for (const [button, name, testId] of panels) {
      await openPanel(saved, button, saved.getByTestId(testId));
      problems.push(...check(await audit(page, `panel: ${name} (opened)`, saved)));
    }
    // the panels that show a result
    const generate: Array<[string, string, string]> = [
      ["glossary-panel", "Find the terms", "glossary-term"],
      ["bilingual-panel", "Show side by side", "bilingual-row"],
      ["checklist-panel", "Check the contract", "checklist-result"],
      ["dates-panel", "Find the dates", "date-item"],
    ];
    for (const [panelId, button, result] of generate) {
      const panel = saved.getByTestId(panelId);
      await panel.scrollIntoViewIfNeeded();
      const run = panel.getByRole("button", { name: button, exact: true });
      if (await run.count()) await run.first().click();
      await expect(saved.getByTestId(result).first()).toBeVisible();
      problems.push(...check(await audit(page, `panel result: ${panelId}`, saved)));
    }
    expect(problems).toEqual([]);
  });

  test("a PDF opens in a viewer that fits the screen, with highlighting offered", async ({ page }) => {
    await newSignedInUser(page);
    await page.goto("/dashboard");
    await page.locator("#pdf-upload").setInputFiles({
      name: "report.pdf",
      mimeType: "application/pdf",
      buffer: realPdf(["First page of the report.", "Stub passage that the answer cites. More text follows."]),
    });
    await page.getByRole("button", { name: "Summarize", exact: true }).click();
    const saved = card(page, "report.pdf");
    await expect(saved).toBeVisible();
    await saved.getByRole("button", { name: "More" }).click();
    await saved.getByRole("button", { name: "Highlights and notes" }).click();
    await saved.getByRole("button", { name: "Mark up the original" }).click();
    const viewer = page.getByTestId("pdf-viewer");
    await expect(viewer.getByTestId("pdf-text-layer")).toContainText("First page of the report.");

    const problems: string[] = [];
    problems.push(...check(await audit(page, "PDF viewer", viewer)));
    const box = await viewer.boundingBox();
    const view = page.viewportSize()!;
    if (!box || box.x < -1 || box.y < -1 || box.x + box.width > view.width + 1 || box.y + box.height > view.height + 1) {
      problems.push(`PDF viewer | does not fit the screen: ${JSON.stringify(box)} in ${view.width}x${view.height}`);
    }
    const close = await viewer.getByRole("button", { name: "Close", exact: true }).boundingBox();
    if (!close || close.y < 0 || close.y + close.height > view.height) problems.push("PDF viewer | the Close button is not on the screen");
    const page1 = await viewer.getByTestId("pdf-canvas").boundingBox();
    if (!page1 || page1.x + page1.width > view.width + 1) problems.push(`PDF viewer | the page is wider than the screen: ${page1?.width}px`);
    expect(problems).toEqual([]);
  });

  test("flashcards, the quiz, the exam and a comparison fit the screen", async ({ page }) => {
    await newSignedInUser(page);
    // a study set with a quiz, made the way the exam tests make one
    const made = await page.request.post(`${API}/study-sets/text`, { data: { text: "Cells\nquiz:Cells are what this set is about." }, headers: origin });
    expect(made.status()).toBe(201);
    const id = (await made.json()).id;
    expect((await page.request.post(`${API}/documents/${id}/study`, { data: { kind: "quiz" }, headers: origin })).status()).toBe(200);
    await page.request.put(`${API}/documents/${id}`, { data: { tags: ["biology"] }, headers: origin });

    const problems: string[] = [];
    await page.goto("/dashboard");
    const set = page.getByTestId("document-card").first();
    await expect(set).toBeVisible();
    await set.getByRole("button", { name: "Flashcards" }).click();
    await expect(set.getByTestId("flashcard")).toBeVisible();
    problems.push(...check(await audit(page, "flashcards", set)));
    await set.getByTestId("flashcard").click();
    await expect(set.getByTestId("rate-card")).toBeVisible();
    problems.push(...check(await audit(page, "flashcards (answer shown)", set)));

    await page.goto("/exam");
    await expect(page.getByTestId("exam-setup")).toBeVisible();
    problems.push(...check(await audit(page, "exam setup")));
    await page.getByTestId("exam-collection").selectOption({ value: "biology" });
    await page.getByRole("button", { name: "Start the exam" }).click();
    await expect(page.getByTestId("exam-run")).toBeVisible();
    problems.push(...check(await audit(page, "exam question")));
    await page.getByRole("radio").first().check();
    for (let i = 0; i < 3; i++) {
      const next = page.getByRole("button", { name: "Next", exact: true });
      if (await next.isEnabled()) await next.click();
      else break;
    }
    await page.getByRole("button", { name: "Finish the exam" }).click();
    // some questions were left unanswered: the exam asks first
    const anyway = page.getByRole("button", { name: "Finish anyway" });
    await expect(anyway).toBeVisible();
    problems.push(...check(await audit(page, "finish the exam: the question", page.getByRole("alertdialog"))));
    await anyway.click();
    await expect(page.getByTestId("exam-results")).toBeVisible();
    problems.push(...check(await audit(page, "exam results")));

    // comparing two versions
    await page.goto("/dashboard");
    await summarizeText(page, "## Agreement v1.\nThe rent is 900 euros per month. Notice is 30 days.");
    await summarizeText(page, "## Agreement v2.\nThe rent is 950 euros per month. Notice is 60 days.");
    const v2 = card(page, "Agreement v2");
    await expect(v2).toBeVisible();
    await openPanel(v2, "Compare with another document", v2.getByTestId("compare"));
    const panel = v2.getByTestId("compare");
    await panel.getByRole("searchbox", { name: "Find the other document" }).fill("Agreement v1");
    const select = panel.getByRole("combobox", { name: "Other document", exact: true });
    await expect(select.locator("option").filter({ hasText: "Agreement v1" })).not.toHaveCount(0);
    await select.selectOption({ index: 1 });
    await panel.getByRole("button", { name: "Compare", exact: true }).click();
    await expect(panel.getByTestId("comparison")).toBeVisible();
    problems.push(...check(await audit(page, "comparison", v2)));
    expect(problems).toEqual([]);
  });

  test("the podcast, the reading list and the library chat fit the screen", async ({ page }) => {
    await newSignedInUser(page);
    await page.goto("/dashboard");
    await summarizeText(page, LEASE);
    const saved = card(page, "Lease terms");
    await expect(saved).toBeVisible();
    const problems: string[] = [];
    await saved.getByRole("button", { name: "Listen as a podcast" }).click();
    await expect(saved.getByTestId("podcast")).toBeVisible();
    problems.push(...check(await audit(page, "podcast", saved)));
    problems.push(...check(await audit(page, "the library chat", page.getByTestId("library"))));
    expect(problems).toEqual([]);
  });

  test("on its side, the page still has room to work in", async ({ page }) => {
    await newSignedInUser(page);
    const view = page.viewportSize()!;
    await page.setViewportSize({ width: Math.max(view.width, view.height), height: Math.min(view.width, view.height) });
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");
    const problems = check(await audit(page, "dashboard, on its side"));
    // the header may take up to a quarter of a short screen, no more
    const header = await page.locator("header").first().boundingBox();
    if (header && header.height > page.viewportSize()!.height * 0.25) problems.push(`landscape | the header takes ${Math.round(header.height)}px of ${page.viewportSize()!.height}px`);
    expect(problems).toEqual([]);
  });

  test("a phone that asks for less motion gets cards that do not slide", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    // Every look at a card, one for each screen refresh from the very first, so a slide cannot be missed or caught half way by
    // looking at the wrong moment (on a slow machine the first look can be at the card's starting place, before it is shown).
    await page.addInitScript(() => {
      const seen = new Set<string>();
      (window as unknown as { __cardTransforms: Set<string> }).__cardTransforms = seen;
      const tick = () => {
        document.querySelectorAll('[data-testid="document-card"]').forEach((el) => seen.add(getComputedStyle(el).transform));
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await newSignedInUser(page);
    await page.goto("/dashboard");
    await summarizeText(page, LEASE);
    await expect(card(page, "Lease terms")).toBeVisible();
    await page.waitForTimeout(900); // longer than the card's entrance takes
    const { seen, last } = await page.evaluate(() => ({
      seen: [...(window as unknown as { __cardTransforms: Set<string> }).__cardTransforms],
      last: getComputedStyle(document.querySelector('[data-testid="document-card"]')!).transform,
    }));
    // It ends in place, and went from its starting place to there in one step: with the slide there would be many places between.
    expect(["none", "matrix(1, 0, 0, 1, 0, 0)"]).toContain(last);
    expect(seen.length, `the card was seen in ${seen.length} places: ${seen.join(" | ")}`).toBeLessThanOrEqual(2);
  });
});
