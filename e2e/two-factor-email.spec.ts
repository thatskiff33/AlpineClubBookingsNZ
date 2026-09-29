import { expect, test } from "@playwright/test";
import { submitLoginForm } from "./helpers/auth";
import { clearMailbox, waitForTwoFactorCode } from "./helpers/mailpit";
import { personas } from "./helpers/personas";

// Critical row: global two-factor enforcement — the EMAIL-code method. The
// sibling spec (two-factor-login.spec.ts) covers the TOTP method; this one
// closes the email-code gap by capturing the emailed code from the staging
// mailpit SMTP capture container (docs/E2E_PLAYWRIGHT.md). Forced email
// enrollment on first login, then an email-code re-login that rejects a wrong
// code and accepts the real one.
//
// Runs serially: the re-login test depends on the enrollment done in the first.
test.describe.configure({ mode: "serial" });
// Each test performs a full login flow plus an email round-trip through mailpit;
// the 90s default is too tight on a loaded CI runner.
test.describe.configure({ timeout: 180_000 });

const enrollee = personas.emailEnrollee;

// A six-digit code that is guaranteed different from `code` (bumps the first
// digit), for the wrong-code rejection assertion.
function wrongSixDigitCode(code: string): string {
  return String((Number(code[0]) + 1) % 10) + code.slice(1);
}

test("first login forces enrollment and completes email-code enrollment", async ({
  page,
}) => {
  await submitLoginForm(page, enrollee.email);

  expect(
    page.url(),
    `${enrollee.email} should be un-enrolled on a fresh demo seed — ` +
      "run pnpm run test:e2e:prepare to reset the database",
  ).toContain("/login/enroll");

  await expect(
    page.getByRole("heading", { name: "Set up two-factor authentication" }),
  ).toBeVisible();

  // Switch from the default authenticator (TOTP) method to email codes.
  await page.getByRole("button", { name: "Email", exact: true }).click();

  await clearMailbox();
  await page.getByRole("button", { name: "Send email code" }).click();
  const code = await waitForTwoFactorCode(enrollee.email);

  await page.locator("#email-code").fill(code);
  await page.getByRole("button", { name: "Enroll", exact: true }).click();

  await expect(
    page.getByRole("heading", { name: "Save your recovery codes" }),
  ).toBeVisible();
  const recoveryCodes = (
    await page.locator("div.font-mono > div").allInnerTexts()
  ).map((value) => value.trim());
  expect(recoveryCodes.length).toBe(10);

  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
});

test("re-login rejects a wrong email code and accepts the emailed one", async ({
  page,
}) => {
  await submitLoginForm(page, enrollee.email);
  await expect(page).toHaveURL(/\/login\/verify/);
  await expect(page.getByText("Verify your sign-in")).toBeVisible();

  // The enrolled method is EMAIL, so the panel offers "Send email code" up front.
  await clearMailbox();
  await page.getByRole("button", { name: "Send email code" }).click();
  const code = await waitForTwoFactorCode(enrollee.email);

  // A wrong code is rejected and the gate holds (a bad attempt does not consume
  // the still-valid emailed code).
  await page.locator("#two-factor-code").fill(wrongSixDigitCode(code));
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByText(/invalid|incorrect|failed/i)).toBeVisible();
  await expect(page).toHaveURL(/\/login\/verify/);

  // The real emailed code completes the challenge.
  await page.locator("#two-factor-code").fill(code);
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
});
