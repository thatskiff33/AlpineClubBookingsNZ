import { expect, test } from "./helpers/accessibility";
import { loginPersona } from "./helpers/auth";
import { completeMemberDetailsGateIfShown } from "./helpers/booking";
import { DEMO_PASSWORD, personas } from "./helpers/personas";

// #4917: once a shared address has spent its sign-in budget, sign-out still
// ends the session and the login form shows the network wait. The address is
// private to this spec, and a retry takes a fresh one because the counter
// survives in the database (flake invariant 1).
const booker = personas.booker;
// Bounds the budget-spending loop well above rateLimiters.login's 30.
const MAX_SPEND_POSTS = 60;

test("sign-out still works after the address sign-in budget is spent", async ({ page }, testInfo) => {
  const clientIp = `10.50.62.${17 + testInfo.retry}`;
  await loginPersona(page, booker.email, clientIp);
  await completeMemberDetailsGateIfShown(page);

  // Spend the budget with counted credential POSTs from the same address.
  let refused = false;
  for (let i = 0; i < MAX_SPEND_POSTS && !refused; i++) {
    const response = await page.request.post("/api/auth/callback/credentials", {
      headers: { "x-forwarded-for": clientIp },
      maxRedirects: 0,
    });
    refused = response.status() === 429;
    if (refused) {
      expect(new URL((await response.json()).url).searchParams.get("code")).toBe("ADDRESS_THROTTLED");
      expect(response.headers()["retry-after"]).toBeTruthy();
    }
  }
  expect(refused).toBe(true);

  await page.getByRole("button", { name: booker.firstName }).click();
  await page.getByRole("menuitem", { name: "Log out" }).click();
  await page.waitForURL(/\/login/);

  // The session really ended: a member page sends the visitor back to sign in.
  const session = await page.request.get("/api/auth/session", {
    headers: { "x-forwarded-for": clientIp },
  });
  expect(await session.json()).toBeNull();
  await page.goto("/dashboard");
  await page.waitForURL(/\/login/);

  // A password sign-in from the spent address shows the network wait.
  const emailField = page.locator("#email").first();
  await emailField.waitFor({ state: "visible" });
  await expect(async () => {
    await emailField.fill(booker.email);
    await page.locator("#password").first().fill(DEMO_PASSWORD);
    await expect(emailField).toHaveValue(booker.email);
  }).toPass({ timeout: 15_000 });
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(/too many sign-in attempts from this network/i)).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});
