import { expect, test } from "./helpers/accessibility";
import { loginPersona, submitLoginForm } from "./helpers/auth";
import { completeMemberDetailsGateIfShown } from "./helpers/booking";
import { DEMO_PASSWORD, personas } from "./helpers/personas";

// #4617: enrol a passkey on the profile, sign out, sign in with the password
// and that passkey, then use the same passkey in the confirm dialog.
// The virtual authenticator is attached before registration. A private client
// IP keeps this journey out of Bob's shared login-rate bucket.
test.describe.configure({ timeout: 180_000 });

const enrollee = personas.enrollee;
const clientIp = "10.50.61.17";

test("password then passkey, then the confirm dialog", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __PW_CONFIRM__?: { open?: () => Promise<boolean> } }).__PW_CONFIRM__ =
      {};
  });

  const client = await page.context().newCDPSession(page);
  await client.send("WebAuthn.enable");
  await client.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  await loginPersona(page, enrollee.email, clientIp);
  await completeMemberDetailsGateIfShown(page);

  await page.goto("/profile");
  await page.getByRole("button", { name: "Add passkey" }).click();
  await expect(page.getByText("Passkey", { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: enrollee.firstName }).click();
  await page.getByRole("menuitem", { name: "Log out" }).click();
  await page.waitForURL(/\/login/);

  await submitLoginForm(page, enrollee.email, DEMO_PASSWORD, clientIp);
  await expect(page.getByText("Verify your sign-in")).toBeVisible();
  await page.getByRole("button", { name: "Use your passkey" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  await completeMemberDetailsGateIfShown(page);

  const proved = page.evaluate(async () => {
    const slot = (window as unknown as { __PW_CONFIRM__?: { open?: () => Promise<boolean> } })
      .__PW_CONFIRM__;
    if (!slot?.open) throw new Error("confirm dialog is not mounted");
    return slot.open();
  });
  const dialog = page.getByRole("dialog", { name: "Confirm it's you" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Use your passkey" }).click();
  await expect(proved).resolves.toBe(true);
});
