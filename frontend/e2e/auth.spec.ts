import { expect, test } from "@playwright/test";
import { alertOf, emailedLink, logIn, newSignedInUser, PASSWORD, signUp, uniqueEmail } from "./support/helpers";

test.describe("authentication", () => {
  test("both the login and the sign-up page offer Google", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("button", { name: "Sign in with Google" })).toBeVisible();
    await page.goto("/signup");
    await expect(page.getByRole("button", { name: "Sign up with Google" })).toBeVisible();
  });

  test("protected pages send visitors to the login page", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
    await page.goto("/account");
    await expect(page).toHaveURL(/\/login/);
  });

  test("sign up, log in and log out", async ({ page }) => {
    const email = await newSignedInUser(page);
    await expect(page.getByRole("link", { name: "Account" })).toBeVisible();

    await page.getByRole("button", { name: "Logout" }).click();
    await expect(page.getByRole("link", { name: "Login" })).toBeVisible();

    // The session is really gone, not just hidden: protected pages bounce again.
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
    expect(email).toContain("@e2e.example");
  });

  test("a session survives a reload", async ({ page }) => {
    await newSignedInUser(page);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Your Dashboard" })).toBeVisible();
  });

  test("a wrong password shows an error and does not look like a session ending", async ({ page }) => {
    const email = uniqueEmail();
    await signUp(page, email);

    await logIn(page, email, "Wrong-Password-1");
    await expect(alertOf(page)).toContainText(/invalid|incorrect/i);
    await expect(page).toHaveURL(/\/login/);

    // The form still works afterwards (the regression was a wrong password acting like a logout).
    await logIn(page, email);
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test("weak sign-ups are rejected with a clear message", async ({ page }) => {
    await page.goto("/signup");
    await page.locator("#email").fill(uniqueEmail());
    await page.locator("#password").fill("password");
    await page.getByRole("button", { name: "Sign Up", exact: true }).click();
    await expect(alertOf(page)).toContainText(/too common|at least 8/i);

    // patterns a list of passwords cannot catch
    for (const password of ["87654321", "abababab", "Qwerty123"]) {
      await page.locator("#password").fill(password);
      await page.getByRole("button", { name: "Sign Up", exact: true }).click();
      await expect(alertOf(page)).toContainText(/too common/i);
    }
  });

  test("signing up with an address that already has an account looks the same as signing up", async ({ page }) => {
    // the page must not tell anyone which addresses are registered: the owner hears by email
    const email = uniqueEmail();
    await signUp(page, email);
    await page.goto("/signup");
    await page.locator("#email").fill(email);
    await page.locator("#password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign Up", exact: true }).click();
    await expect(page.getByText("Check your email")).toBeVisible();
    await expect(alertOf(page)).toHaveCount(0);
  });

  test("emails are matched case-insensitively", async ({ page }) => {
    const email = uniqueEmail();
    await signUp(page, email);
    await logIn(page, email.toUpperCase());
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test("confirming the email address removes the reminder banner", async ({ page }) => {
    const email = await newSignedInUser(page);
    await expect(page.getByRole("status").filter({ hasText: "confirm your email" })).toBeVisible();

    await page.goto(await emailedLink(email, "Confirm your email address"));
    await expect(page.getByText(/confirmed/i).first()).toBeVisible();

    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Your Dashboard" })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "confirm your email" })).toHaveCount(0);
  });

  test("a bad confirmation link says so", async ({ page }) => {
    await page.goto("/verify-email?token=not-a-real-token");
    await expect(alertOf(page)).toBeVisible();
  });

  test("forgotten password: request a link, choose a new password, old one stops working", async ({ page }) => {
    const email = uniqueEmail();
    await signUp(page, email);

    await page.goto("/forgot-password");
    await page.locator("#email").fill(email);
    await page.getByRole("button", { name: "Send link" }).click();
    await expect(page.getByRole("status")).toContainText(/if an account/i);

    const link = await emailedLink(email, "Reset your password");
    await page.goto(link);
    const newPassword = "Brand-New-Pass-7";
    await page.locator("#password").fill(newPassword);
    await page.locator("#confirm").fill(newPassword);
    await page.getByRole("button", { name: /reset|save|change|set/i }).click();
    await expect(page.getByRole("heading", { name: "Password changed" })).toBeVisible();

    await logIn(page, email, PASSWORD);
    await expect(alertOf(page)).toBeVisible();
    await logIn(page, email, newPassword);
    await expect(page).toHaveURL(/\/dashboard/);

    // The link is single use.
    await page.goto(link);
    await page.locator("#password").fill("Another-Pass-5xx");
    await page.locator("#confirm").fill("Another-Pass-5xx");
    await page.getByRole("button", { name: /reset|save|change|set/i }).click();
    await expect(alertOf(page)).toBeVisible();
  });

  test("asking for a reset never reveals whether an address has an account", async ({ page }) => {
    await page.goto("/forgot-password");
    await page.locator("#email").fill(uniqueEmail("nobody"));
    await page.getByRole("button", { name: "Send link" }).click();
    await expect(page.getByRole("status")).toContainText(/if an account/i);
  });
});
