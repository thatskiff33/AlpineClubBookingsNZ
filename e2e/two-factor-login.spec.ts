import { expect, test } from "@playwright/test";
import {
  enrollTotp,
  readStoredTwoFactor,
  submitLoginForm,
  totpCode,
  wrongTotpCode,
} from "./helpers/auth";
import { personas } from "./helpers/personas";
import { must } from "../src/lib/indexed-access";

// Critical row: global two-factor enforcement — forced enrollment on first
// login, TOTP verification on later logins, wrong-code rejection, and
// protected-route gating for a session that has not passed the challenge.
// Runs serially: the later tests rely on the enrollment done in the first.
test.describe.configure({ mode: "serial" });
// Each test performs one or more full login flows (fresh enrollment, TOTP
// windows, recovery-code re-login); the 90s default is too tight on a loaded
// CI runner.
test.describe.configure({ timeout: 180_000 });

const enrollee = personas.enrollee;

test("first login forces two-factor enrollment and issues recovery codes", async ({
  page,
}) => {
  await submitLoginForm(page, enrollee.email);

  expect(
    page.url(),
    `${enrollee.email} should be un-enrolled on a fresh demo seed — ` +
      "run npm run test:e2e:prepare to reset the database",
  ).toContain("/login/enroll");

  const { recoveryCodes } = await enrollTotp(page, enrollee.email);
  expect(recoveryCodes.length).toBe(10);

  // Bob is seeded financeAccessLevel: "VIEWER" (prisma/demo-seed.ts), so his
  // admin matrix grants finance=view. Post-login now defaults an admin-access
  // member to their first accessible admin page (#2090 D-D3), which for a
  // finance-only member is /admin/payments — not /dashboard.
  await expect(page).toHaveURL(/\/admin\/payments/);
});

test("session that has not passed the challenge cannot reach protected pages", async ({
  page,
}) => {
  await submitLoginForm(page, enrollee.email);
  await expect(page).toHaveURL(/\/login\/verify/);

  // The password is accepted but the two-factor gate must still hold.
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login\/(verify|enroll)/);
});

test("re-login rejects a wrong code and accepts a valid TOTP code", async ({
  page,
}) => {
  const stored = readStoredTwoFactor(enrollee.email);
  expect(stored, "enrollment spec must have stored the TOTP secret").toBeTruthy();

  await submitLoginForm(page, enrollee.email);
  await expect(page).toHaveURL(/\/login\/verify/);
  await expect(page.getByText("Verify your sign-in")).toBeVisible();

  await page.locator("#two-factor-code").fill(wrongTotpCode(stored!.secret));
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByText(/invalid|incorrect|failed/i)).toBeVisible();
  await expect(page).toHaveURL(/\/login\/verify/);

  await page.locator("#two-factor-code").fill(totpCode(stored!.secret));
  await page.getByRole("button", { name: "Verify" }).click();
  // Bob (finance VIEWER) defaults to his first accessible admin page (#2090
  // D-D3): /admin/payments, re-resolved server-side at /login/verify.
  await expect(page).toHaveURL(/\/admin\/payments/);
});

test("recovery code completes the challenge and is single-use", async ({
  page,
}) => {
  const stored = readStoredTwoFactor(enrollee.email);
  if (!stored) throw new Error("enrollment spec must have stored recovery codes");
  const recoveryCode = must(
    stored.recoveryCodes[0],
    "enrollment spec must have stored at least one recovery code",
  );

  await submitLoginForm(page, enrollee.email);
  await expect(page).toHaveURL(/\/login\/verify/);

  await page.getByRole("button", { name: "Recovery" }).click();
  await page.locator("#two-factor-code").fill(recoveryCode);
  await page.getByRole("button", { name: "Verify" }).click();
  // Bob (finance VIEWER) defaults to his first accessible admin page (#2090
  // D-D3): /admin/payments, re-resolved server-side at /login/verify.
  await expect(page).toHaveURL(/\/admin\/payments/);

  // The same code must not work twice.
  const secondContext = await page.context().browser()!.newContext();
  const secondPage = await secondContext.newPage();
  await submitLoginForm(secondPage, enrollee.email);
  await expect(secondPage).toHaveURL(/\/login\/verify/);
  await secondPage.getByRole("button", { name: "Recovery" }).click();
  await secondPage.locator("#two-factor-code").fill(recoveryCode);
  await secondPage.getByRole("button", { name: "Verify" }).click();
  await expect(secondPage.getByText(/invalid|incorrect|failed/i)).toBeVisible();
  await secondContext.close();
});
