import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { logIn, newSignedInUser, PASSWORD } from "./support/helpers";
import { totpCode } from "./support/totp";

// Two-step sign-in with an authenticator app: set up on the account page, asked for at sign-in, recovery codes, switched off.
// The test plays the app (support/totp.ts). A code is good once and only for a newer 30-second step than the last one used, so
// after setting up (which uses the current step's code) the next code that works is the one a step ahead, and only one more
// operation can use an app code in the same half minute: the tests are written around that, using recovery codes for the rest.

async function openAccount(page: Page) {
  await page.getByRole("link", { name: "Account" }).click();
  await expect(page.getByTestId("two-factor")).toBeVisible();
  return page.getByTestId("two-factor");
}

// Takes a signed-in account through setting up. Returns the secret and the recovery codes it was given.
async function switchOn(page: Page) {
  const section = await openAccount(page);
  await expect(section.getByRole("status")).toHaveText("Two-step sign-in is off.");
  await section.getByRole("button", { name: "Turn on", exact: true }).click();
  await section.getByLabel("Your password").fill(PASSWORD);
  await section.getByRole("button", { name: "Continue", exact: true }).click();

  await expect(section.getByTestId("two-factor-qr")).toBeVisible();
  const secret = (await section.getByTestId("two-factor-secret").innerText()).replace(/\s/g, "");
  expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  await section.getByLabel("Code from your app").fill(totpCode(secret));
  await section.getByRole("button", { name: "Confirm and turn on" }).click();

  const codes = section.getByTestId("recovery-codes");
  await expect(codes).toBeVisible();
  const recovery = await codes.getByTestId("recovery-code").allInnerTexts();
  expect(recovery).toHaveLength(10);
  for (const code of recovery) expect(code).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
  await section.getByRole("button", { name: "I have saved them" }).click();
  await expect(section.getByTestId("two-factor-on")).toContainText("Two-step sign-in is on.");
  await expect(section.getByTestId("recovery-left")).toHaveText("10 recovery codes left.");
  return { secret, recovery };
}

async function signOutAndStartSignIn(page: Page, email: string) {
  await page.getByRole("button", { name: "Logout" }).click();
  await logIn(page, email);
}

test.describe("two-step sign-in", () => {
  test("it is set up with a QR code and a code from the app, and then asked for at sign-in", async ({ page }) => {
    const email = await newSignedInUser(page);
    const { secret } = await switchOn(page);

    await signOutAndStartSignIn(page, email);
    // the password alone is not enough: the dashboard is not reached
    const step = page.getByTestId("second-step");
    await expect(step).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
    await step.getByLabel("6-digit code").fill("000000");
    await step.getByRole("button", { name: "Verify" }).click();
    await expect(step.getByRole("alert")).toHaveText(/That code was not accepted/);
    await expect(page).toHaveURL(/\/login/);

    await step.getByLabel("6-digit code").fill(totpCode(secret, 1).replace(/^(\d{3})(\d{3})$/, "$1 $2")); // typed with a space, as apps show it
    await step.getByRole("button", { name: "Verify" }).click();
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole("heading", { name: "Your Dashboard" })).toBeVisible();
  });

  test("a wrong code can be tried again, but not for ever", async ({ page }) => {
    const email = await newSignedInUser(page);
    await switchOn(page);
    await signOutAndStartSignIn(page, email);
    const step = page.getByTestId("second-step");
    for (let attempt = 1; attempt <= 5; attempt++) {
      await step.getByLabel("6-digit code").fill(`00000${attempt}`);
      await step.getByRole("button", { name: "Verify" }).click();
      await expect(step.getByRole("alert")).toHaveText(/That code was not accepted/);
    }
    // the sixth is refused whatever it is: the password has to be given again
    await step.getByLabel("6-digit code").fill("000006");
    await step.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByText(/took too long or was tried too often/)).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
    await expect(page.getByTestId("second-step")).toHaveCount(0);
  });

  test("a recovery code signs in once, and the count goes down", async ({ page }) => {
    const email = await newSignedInUser(page);
    const { recovery } = await switchOn(page);
    await signOutAndStartSignIn(page, email);

    const step = page.getByTestId("second-step");
    await step.getByRole("button", { name: "Use a recovery code instead" }).click();
    await step.getByLabel("Recovery code").fill(recovery[0].toUpperCase());
    await step.getByRole("button", { name: "Verify" }).click();
    await expect(page).toHaveURL(/\/dashboard/);

    const section = await openAccount(page);
    await expect(section.getByTestId("recovery-left")).toHaveText("9 recovery codes left.");

    // the same code is not good a second time
    await signOutAndStartSignIn(page, email);
    const again = page.getByTestId("second-step");
    await again.getByRole("button", { name: "Use a recovery code instead" }).click();
    await again.getByLabel("Recovery code").fill(recovery[0]);
    await again.getByRole("button", { name: "Verify" }).click();
    await expect(again.getByRole("alert")).toHaveText(/That code was not accepted/);
    await expect(page).toHaveURL(/\/login/);
    // the way back to the app's code, and back to the start
    await again.getByRole("button", { name: "Use the code from my app instead" }).click();
    await expect(again.getByLabel("6-digit code")).toBeVisible();
    await again.getByRole("button", { name: "Start again" }).click();
    await expect(page.getByLabel("Password")).toBeVisible();
  });

  test("it is switched off with the password and a code, and then the password is enough again", async ({ page }) => {
    const email = await newSignedInUser(page);
    const { secret } = await switchOn(page);
    const section = page.getByTestId("two-factor");

    await section.getByRole("button", { name: "Turn off" }).click();
    await section.getByLabel("Your password").fill("not-my-Password-1");
    await section.getByLabel("Code from your app").fill(totpCode(secret, 1));
    await section.getByRole("button", { name: "Turn off" }).last().click();
    await expect(section.getByRole("alert")).toHaveText(/Your password is incorrect/);

    await section.getByLabel("Your password").fill(PASSWORD);
    await section.getByRole("button", { name: "Turn off" }).last().click();
    await expect(section.getByRole("status").filter({ hasText: "Two-step sign-in is now off." })).toBeVisible();
    await expect(section.getByRole("status").filter({ hasText: "Two-step sign-in is off." })).toBeVisible();

    await signOutAndStartSignIn(page, email);
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test("it can be switched off with a recovery code when the phone is gone", async ({ page }) => {
    const email = await newSignedInUser(page);
    const { recovery } = await switchOn(page);
    const section = page.getByTestId("two-factor");
    await section.getByRole("button", { name: "Turn off" }).click();
    await section.getByLabel("Your password").fill(PASSWORD);
    await section.getByRole("button", { name: "Use a recovery code instead" }).click();
    await section.getByLabel("Recovery code (instead of an app code)").fill(recovery[3]);
    await section.getByRole("button", { name: "Turn off" }).last().click();
    await expect(section.getByRole("status").filter({ hasText: "Two-step sign-in is now off." })).toBeVisible();
    await signOutAndStartSignIn(page, email);
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test("new recovery codes end the old ones", async ({ page }) => {
    const email = await newSignedInUser(page);
    const { secret, recovery } = await switchOn(page);
    const section = page.getByTestId("two-factor");
    await section.getByRole("button", { name: "Make new recovery codes" }).click();
    await section.getByLabel("Your password").fill(PASSWORD);
    await section.getByLabel("Code from your app").fill(totpCode(secret, 1));
    await section.getByRole("button", { name: "Make new recovery codes" }).last().click();
    await expect(section.getByTestId("recovery-codes")).toBeVisible();
    const fresh = await section.getByTestId("recovery-codes").getByTestId("recovery-code").allInnerTexts();
    expect(fresh).toHaveLength(10);
    expect(fresh.filter((code) => recovery.includes(code))).toHaveLength(0);
    await section.getByRole("button", { name: "I have saved them" }).click();

    await signOutAndStartSignIn(page, email);
    const step = page.getByTestId("second-step");
    await step.getByRole("button", { name: "Use a recovery code instead" }).click();
    await step.getByLabel("Recovery code").fill(recovery[0]);
    await step.getByRole("button", { name: "Verify" }).click();
    await expect(step.getByRole("alert")).toHaveText(/That code was not accepted/); // an old one
    await step.getByLabel("Recovery code").fill(fresh[0]);
    await step.getByRole("button", { name: "Verify" }).click();
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test("the recovery codes can be downloaded as a file", async ({ page }) => {
    await newSignedInUser(page);
    const section = await openAccount(page);
    await section.getByRole("button", { name: "Turn on", exact: true }).click();
    await section.getByLabel("Your password").fill(PASSWORD);
    await section.getByRole("button", { name: "Continue", exact: true }).click();
    const secret = (await section.getByTestId("two-factor-secret").innerText()).replace(/\s/g, "");
    await section.getByLabel("Code from your app").fill(totpCode(secret));
    await section.getByRole("button", { name: "Confirm and turn on" }).click();
    const codes = await section.getByTestId("recovery-code").allInnerTexts();
    const [download] = await Promise.all([page.waitForEvent("download"), section.getByRole("button", { name: "Download" }).click()]);
    expect(download.suggestedFilename()).toBe("inkling-recovery-codes.txt");
    const { readFileSync } = await import("node:fs");
    const text = readFileSync(await download.path(), "utf8");
    for (const code of codes) expect(text).toContain(code);
    expect(text).toContain("works once");
  });

  test("a wrong code while setting up changes nothing", async ({ page }) => {
    await newSignedInUser(page);
    const section = await openAccount(page);
    await section.getByRole("button", { name: "Turn on", exact: true }).click();
    await section.getByLabel("Your password").fill(PASSWORD);
    await section.getByRole("button", { name: "Continue", exact: true }).click();
    await section.getByLabel("Code from your app").fill("000000");
    await section.getByRole("button", { name: "Confirm and turn on" }).click();
    await expect(section.getByRole("alert")).toHaveText(/That code was not accepted/);
    await expect(section.getByTestId("two-factor-qr")).toBeVisible(); // still there to try again
    await section.getByRole("button", { name: "Cancel" }).click();
    await expect(section.getByRole("status")).toHaveText("Two-step sign-in is off.");
  });

  test("the setup and the second step have no accessibility violations", async ({ page }) => {
    const email = await newSignedInUser(page);
    const section = await openAccount(page);
    await section.getByRole("button", { name: "Turn on", exact: true }).click();
    await section.getByLabel("Your password").fill(PASSWORD);
    await section.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(section.getByTestId("two-factor-qr")).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    const secret = (await section.getByTestId("two-factor-secret").innerText()).replace(/\s/g, "");
    await section.getByLabel("Code from your app").fill(totpCode(secret));
    await section.getByRole("button", { name: "Confirm and turn on" }).click();
    await expect(section.getByTestId("recovery-codes")).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await section.getByRole("button", { name: "I have saved them" }).click();

    await signOutAndStartSignIn(page, email);
    await expect(page.getByTestId("second-step")).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
});
