import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { API, newSignedInUser } from "./support/helpers";

// Exam mode. (The AI service here is a stub: every quiz has three questions, the right option of each starts with "Right",
// and a set whose text holds "quiz:name" gets questions of its own, so that two sets do not share them.)

const tags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const origin = { Origin: "http://localhost:13000" };

// A study set made through the API with the browser's own session; with a quiz when asked, and a tag when given.
async function makeSet(page: Page, name: string, options: { quiz?: boolean; tag?: string } = {}) {
  const made = await page.request.post(`${API}/study-sets/text`, { data: { text: `${name}\nquiz:${name} is what this set is about.` }, headers: origin });
  expect(made.status()).toBe(201);
  const id = (await made.json()).id as number;
  if (options.quiz) {
    const quiz = await page.request.post(`${API}/documents/${id}/study`, { data: { kind: "quiz" }, headers: origin });
    expect(quiz.status()).toBe(200);
  }
  if (options.tag) {
    const tagged = await page.request.put(`${API}/documents/${id}`, { data: { tags: [options.tag] }, headers: origin });
    expect(tagged.status()).toBe(200);
  }
  return id;
}

async function startCollection(page: Page, tag: string) {
  await page.goto("/exam");
  await expect(page.getByTestId("exam-setup")).toBeVisible();
  await page.getByTestId("exam-collection").selectOption({ value: tag });
  await page.getByRole("button", { name: "Start the exam" }).click();
  await expect(page.getByTestId("exam-run")).toBeVisible();
}

const next = (page: Page) => page.getByRole("button", { name: "Next", exact: true });

// Answers the question on the screen with a right option ("Right ...") or a wrong one.
async function answer(page: Page, right: boolean) {
  await page.getByRole("radio", { name: right ? /Right/ : /Wrong/ }).first().check();
}

test.describe("exam mode", () => {
  test("someone with no quizzes is told what to do first", async ({ page }) => {
    await newSignedInUser(page);
    await page.goto("/exam");
    await expect(page.getByTestId("exam-empty")).toContainText("no study sets with a quiz yet");
  });

  test("a signed-out visitor is sent to log in", async ({ page }) => {
    await page.goto("/exam");
    await expect(page).toHaveURL(/\/login/);
  });

  test("an exam on a collection is taken without feedback, marked at the end, and kept in the history", async ({ page }) => {
    await newSignedInUser(page);
    await makeSet(page, "alpha", { quiz: true, tag: "course" });
    await makeSet(page, "beta", { quiz: true, tag: "course" });
    await startCollection(page, "course");

    await expect(page.getByTestId("exam-position")).toHaveText("Question 1 of 6");
    await expect(page.getByTestId("exam-clock")).toContainText("Time:");
    // nothing says which answer is right while the exam is open
    await expect(page.getByText("Because one.")).toHaveCount(0);

    // four right, one wrong, one left blank
    for (let i = 0; i < 4; i++) {
      await answer(page, true);
      await next(page).click();
    }
    await answer(page, false);
    await next(page).click();
    await expect(page.getByTestId("exam-position")).toHaveText("Question 6 of 6");
    await page.getByRole("button", { name: "Finish the exam" }).click();
    await expect(page.getByTestId("exam-confirm")).toContainText("1 questions are not answered yet.");
    await page.getByRole("button", { name: "Keep going" }).click();
    await expect(page.getByTestId("exam-confirm")).toHaveCount(0);
    await page.getByRole("button", { name: "Finish the exam" }).click();
    await page.getByRole("button", { name: "Finish anyway" }).click();

    await expect(page.getByTestId("exam-score")).toHaveText("4 of 6 correct (67%)");
    await expect(page.getByTestId("exam-breakdown").getByRole("listitem")).toHaveCount(2);
    const missed = page.getByTestId("exam-missed-item");
    await expect(missed).toHaveCount(2);
    await expect(page.getByTestId("exam-missed")).toContainText("Not answered");
    await expect(page.getByTestId("exam-missed")).toContainText("Right answer:");
    await expect(page.getByTestId("exam-missed")).toContainText(/Because (one|two|three)\./);
    await expect(page.getByTestId("exam-history").getByRole("listitem")).toHaveCount(1);
    await expect(page.getByTestId("exam-history")).toContainText("4 of 6 (67%)");

    const kept = await (await page.request.get(`${API}/exams/results?tag=course`)).json();
    expect(kept.results).toHaveLength(1);
    expect(kept.results[0]).toMatchObject({ tag: "course", questions: 6, correct: 4 });
  });

  test("the missed questions can be practised, and a practice run is not kept", async ({ page }) => {
    await newSignedInUser(page);
    await makeSet(page, "alpha", { quiz: true, tag: "course" });
    await startCollection(page, "course");
    // three questions: miss them all by choosing wrong options
    for (let i = 0; i < 3; i++) {
      await answer(page, false);
      if (i < 2) await next(page).click();
    }
    await page.getByRole("button", { name: "Finish the exam" }).click();
    await expect(page.getByTestId("exam-score")).toHaveText("0 of 3 correct (0%)");
    await expect(page.getByTestId("exam-missed-item")).toHaveCount(3);

    await page.getByRole("button", { name: "Practise the missed ones" }).click();
    await expect(page.getByTestId("exam-position")).toHaveText("Question 1 of 3");
    await expect(page.getByTestId("exam-run")).toContainText("Practising the missed questions");
    for (let i = 0; i < 3; i++) {
      await answer(page, true);
      if (i < 2) await next(page).click();
    }
    await page.getByRole("button", { name: "Finish the exam" }).click();
    await expect(page.getByText("Practice result")).toBeVisible();
    await expect(page.getByTestId("exam-score")).toHaveText("3 of 3 correct (100%)");
    await expect(page.getByTestId("exam-allright")).toBeVisible();
    await expect(page.getByText("A practice run is not added to your history.")).toBeVisible();

    const kept = await (await page.request.get(`${API}/exams/results`)).json();
    expect(kept.results).toHaveLength(1); // only the first exam
  });

  test("answers can be chosen with the keys 1 to 4, and questions reached from the numbered buttons", async ({ page }) => {
    await newSignedInUser(page);
    await makeSet(page, "alpha", { quiz: true, tag: "course" });
    await startCollection(page, "course");
    await page.keyboard.press("3");
    await expect(page.getByRole("radio").nth(2)).toBeChecked();
    await page.keyboard.press("1");
    await expect(page.getByRole("radio").nth(0)).toBeChecked();

    await page.getByRole("button", { name: "Go to question 3" }).click();
    await expect(page.getByTestId("exam-position")).toHaveText("Question 3 of 3");
    await expect(page.getByRole("radio", { checked: true })).toHaveCount(0);
    await page.getByRole("button", { name: /Go to question 1 \(answered\)/ }).click();
    await expect(page.getByRole("radio").nth(0)).toBeChecked();
    await expect(page.getByRole("button", { name: "Previous" })).toBeDisabled();
  });

  test("sets without a quiz are offered one, and the exam starts once they have it", async ({ page }) => {
    await newSignedInUser(page);
    await makeSet(page, "alpha", { quiz: true });
    await makeSet(page, "gamma"); // flashcards only
    await page.goto("/exam");
    await page.getByLabel("Sets I pick").check();
    const sets = page.getByTestId("exam-sets");
    await expect(sets.getByRole("listitem")).toHaveCount(2);
    await expect(sets).toContainText("no quiz yet");
    await sets.getByLabel(/alpha/).check();
    await sets.getByLabel(/gamma/).check();
    await page.getByRole("button", { name: "Start the exam" }).click();

    const missing = page.getByTestId("exam-missing");
    await expect(missing).toContainText("1 of these sets have no quiz yet");
    await expect(missing).toContainText("gamma");
    await expect(missing).toContainText("uses 1 of your daily chat questions");
    await expect(page.getByTestId("exam-run")).toHaveCount(0);
    await page.getByRole("button", { name: "Make the missing quizzes" }).click();
    await expect(page.getByTestId("exam-missing")).toHaveCount(0);

    await page.getByRole("button", { name: "Start the exam" }).click();
    await expect(page.getByTestId("exam-position")).toHaveText("Question 1 of 6");
  });

  test("the exam can be started with the questions there are while a quiz is still missing", async ({ page }) => {
    await newSignedInUser(page);
    await makeSet(page, "alpha", { quiz: true });
    await makeSet(page, "gamma");
    await page.goto("/exam");
    await page.getByLabel("Sets I pick").check();
    await page.getByTestId("exam-sets").getByLabel(/alpha/).check();
    await page.getByTestId("exam-sets").getByLabel(/gamma/).check();
    await page.getByRole("button", { name: "Start the exam" }).click();
    await page.getByRole("button", { name: "Start with the 3 questions there are" }).click();
    await expect(page.getByTestId("exam-position")).toHaveText("Question 1 of 3");
  });

  test("a time limit marks the exam as it stands when the time is up", async ({ page }) => {
    await page.clock.install();
    await newSignedInUser(page);
    await makeSet(page, "alpha", { quiz: true, tag: "course" });
    await page.goto("/exam");
    await page.getByTestId("exam-collection").selectOption({ value: "course" });
    await page.getByLabel("Time limit (a minute a question)").check();
    await page.getByRole("button", { name: "Start the exam" }).click();
    await expect(page.getByTestId("exam-clock")).toContainText("Time left: 3:00");
    await answer(page, true);

    await page.clock.fastForward("03:05");
    await expect(page.getByTestId("exam-results")).toBeVisible();
    await expect(page.getByText("Time is up. Your exam was marked as it stood.")).toBeVisible();
    await expect(page.getByTestId("exam-score")).toHaveText("1 of 3 correct (33%)");
  });

  test("the setup, a question and the results have no accessibility violations", async ({ page }) => {
    await newSignedInUser(page);
    await makeSet(page, "alpha", { quiz: true, tag: "course" });
    await page.goto("/exam");
    await expect(page.getByTestId("exam-setup")).toBeVisible();
    expect((await new AxeBuilder({ page }).withTags(tags).analyze()).violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

    await page.getByRole("button", { name: "Start the exam" }).click();
    await expect(page.getByTestId("exam-run")).toBeVisible();
    await answer(page, false);
    expect((await new AxeBuilder({ page }).withTags(tags).analyze()).violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

    await page.getByRole("button", { name: "Finish the exam" }).click();
    await page.getByRole("button", { name: "Finish anyway" }).click();
    await expect(page.getByTestId("exam-results")).toBeVisible();
    await expect(page.getByTestId("exam-history")).toBeVisible();
    expect((await new AxeBuilder({ page }).withTags(tags).analyze()).violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  test("a past exam is listed, opened again with every question and answer, and its misses can be practised", async ({ page }) => {
    await newSignedInUser(page);
    await makeSet(page, "alpha", { quiz: true, tag: "course" });
    await startCollection(page, "course");
    // one right, one wrong, one left alone
    await answer(page, true);
    await next(page).click();
    await answer(page, false);
    await next(page).click();
    await page.getByRole("button", { name: "Finish the exam" }).click();
    await page.getByRole("button", { name: "Finish anyway" }).click();
    await expect(page.getByTestId("exam-score")).toHaveText("1 of 3 correct (33%)");

    // it is on the exam page afterwards, with the collection, the score and the time
    await page.goto("/exam");
    const past = page.getByTestId("exam-past");
    await expect(past.getByTestId("exam-past-item")).toHaveCount(1);
    await expect(past).toContainText("Collection “course”");
    await expect(past).toContainText("1 of 3 (33%)");
    expect((await new AxeBuilder({ page }).withTags(tags).analyze()).violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

    // opening it shows the result again, with the questions that were missed and what was chosen
    await past.getByRole("button", { name: /^Open the exam of/ }).click();
    await expect(page.getByRole("heading", { name: /^Your exam of/ })).toBeVisible();
    await expect(page.getByTestId("exam-score")).toHaveText("1 of 3 correct (33%)");
    await expect(page.getByTestId("exam-missed-item")).toHaveCount(2);
    await expect(page.getByTestId("exam-missed")).toContainText("Not answered");
    await expect(page.getByTestId("exam-missed")).toContainText("Right answer:");
    await expect(page.getByTestId("exam-history")).toHaveCount(0);
    expect((await new AxeBuilder({ page }).withTags(tags).analyze()).violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

    // and the misses can be practised from there; a practice run is not added to the list
    await page.getByRole("button", { name: "Practise the missed ones" }).click();
    await expect(page.getByTestId("exam-position")).toHaveText("Question 1 of 2");
    await answer(page, true);
    await next(page).click();
    await answer(page, true);
    await page.getByRole("button", { name: "Finish the exam" }).click();
    await expect(page.getByTestId("exam-score")).toHaveText("2 of 2 correct (100%)");
    await page.goto("/exam");
    await expect(page.getByTestId("exam-past").getByTestId("exam-past-item")).toHaveCount(1);
  });

  test("an exam kept before its questions were still opens, with the score and the questions that were missed", async ({ page }) => {
    await newSignedInUser(page);
    const id = await makeSet(page, "alpha", { quiz: true, tag: "course" });
    const kept = await page.request.post(`${API}/exams/results`, {
      data: {
        tag: "course",
        documentIds: [id],
        questions: 3,
        correct: 1,
        seconds: 75,
        breakdown: [{ documentId: id, title: "alpha", questions: 3, correct: 1 }],
        missed: [{ documentId: id, question: "An older question?" }],
      },
      headers: origin,
    });
    expect(kept.status()).toBe(201);

    await page.goto("/exam");
    await page.getByTestId("exam-past").getByRole("button", { name: /^Open the exam of/ }).click();
    await expect(page.getByTestId("exam-score")).toHaveText("1 of 3 correct (33%)");
    await expect(page.getByText("taken before the questions were kept")).toBeVisible();
    await expect(page.getByTestId("exam-missed")).toContainText("An older question?");
    // there is nothing to say about the answers, and nothing to practise on
    await expect(page.getByTestId("exam-missed")).not.toContainText("Right answer:");
    await expect(page.getByRole("button", { name: "Practise the missed ones" })).toHaveCount(0);
    await page.getByRole("button", { name: "Back to the exams" }).click();
    await expect(page.getByTestId("exam-past")).toBeVisible();
  });

  test("a past exam is deleted after a second look, and only that one", async ({ page }) => {
    await newSignedInUser(page);
    const id = await makeSet(page, "alpha", { quiz: true, tag: "course" });
    for (const correct of [1, 2]) {
      const kept = await page.request.post(`${API}/exams/results`, {
        data: {
          tag: "course",
          documentIds: [id],
          questions: 3,
          correct,
          seconds: 60,
          breakdown: [{ documentId: id, title: "alpha", questions: 3, correct }],
          missed: [],
        },
        headers: origin,
      });
      expect(kept.status()).toBe(201);
    }
    await page.goto("/exam");
    const items = page.getByTestId("exam-past").getByTestId("exam-past-item");
    await expect(items).toHaveCount(2);

    // newest first: the one with 2 right; asking to delete it only asks
    await items.first().getByRole("button", { name: /^Delete the exam of/ }).click();
    await expect(items).toHaveCount(2);
    await items.first().getByRole("button", { name: "Cancel" }).click();
    await expect(items).toHaveCount(2);
    await items.first().getByRole("button", { name: /^Delete the exam of/ }).click();
    await items.first().getByRole("button", { name: "Yes, delete" }).click();
    await expect(items).toHaveCount(1);
    await expect(items.first()).toContainText("1 of 3 (33%)");
    const left = await (await page.request.get(`${API}/exams/results`)).json();
    expect(left.results).toHaveLength(1);
  });
});
