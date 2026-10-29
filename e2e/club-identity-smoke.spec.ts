import { expect, test, type Page } from "./helpers/accessibility";
import { storageStatePath } from "./helpers/auth";
import { E2E_ADMIN } from "./helpers/fixtures";

// E3 follow-up #1966 (PR #1957 / issue #1929): renaming the club in
// Admin > Appearance > Club Identity must reach the public site within the
// public-layout cache TTL (SHORT_CONFIG_TTL_SECONDS = 15s;
// src/lib/public-layout-config.ts). The admin PUT invalidates the identity tag
// and calls revalidatePath("/", "layout") + primeClubIdentitySync
// (src/app/api/admin/club-identity/route.ts), so a fresh public request after
// the PUT re-renders the header/footer/title from the new name.
//
// The name renders in three public places:
//   - the <title> (src/app/layout.tsx generateMetadata, uncached getClubIdentity),
//   - the header branding logo/link (src/components/website-header.tsx →
//     WebsiteLogo label, getCachedClubIdentity),
//   - the footer copyright line (src/components/website-footer.tsx,
//     getCachedClubIdentity).
//
// Cleanup: the club-identity form input holds the persisted OVERRIDE (empty =
// falling back to config/club.json). We capture that override up front and
// restore it in a finally block, so a failure mid-run never leaves the club
// renamed for later specs in the serial suite. We also capture the original
// public title + footer copyright and assert the public site returns to them.
//
// Auth: reuse the E2E full-admin storage state (saved once in auth.setup.ts;
// full admin has content:edit). No fresh login, so no login-rate-limit spend.

const NEW_NAME = "E2E Identity Smoke Club";

test.describe.configure({ mode: "serial" });
test.use({ storageState: storageStatePath(E2E_ADMIN.email) });

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Club identity follows the staged settings model (#3976): the fields are
// read-only until Edit, so each write opens the section first.
async function setClubNameOverride(page: Page, value: string): Promise<void> {
  const nameInput = page.locator("#club-identity-name");
  await expect(nameInput).toBeVisible();
  await page
    .getByRole("region", { name: "Club identity" })
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  await expect(nameInput).toBeEnabled();
  await nameInput.fill(value);
  await expect(nameInput).toHaveValue(value);
}

// Clicks Save and waits for the PUT itself (not the success message), so we
// know the server-side revalidation + sync-prime have completed before
// we probe the public site.
async function saveClubIdentity(page: Page): Promise<void> {
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().includes("/api/admin/club-identity") &&
        r.request().method() === "PUT",
    ),
    page.getByRole("button", { name: "Save club identity" }).click(),
  ]);
  expect(response.ok(), `club-identity PUT status ${response.status()}`).toBe(
    true,
  );
}

async function openIdentityPage(page: Page): Promise<void> {
  await page.goto("/admin/appearance/identity");
  await expect(
    page.getByRole("heading", { name: "Club Identity" }),
  ).toBeVisible();
}

// Reload the public home page (bounded retries, no fixed long sleep) until the
// title, header branding, and footer copyright all show `name`. `page.goto`
// forces a fresh server render each attempt. The timeout sits just past the
// 15s cache TTL so an invalidation miss still resolves via natural expiry.
async function expectPublicClubName(page: Page, name: string): Promise<void> {
  const namePattern = new RegExp(escapeRegExp(name));
  await expect(async () => {
    await page.goto("/");
    // Short inner timeouts (not the 15s global expect default) so a stale render
    // fails the iteration fast and re-goto()s promptly within the 20s ceiling.
    await expect(page).toHaveTitle(namePattern, { timeout: 2_000 });
    // Header branding: WebsiteLogo renders the name as text (no logo) or as an
    // <img> alt (logo present); either way it is the branding link's
    // accessible name (the first link inside the banner landmark).
    await expect(
      page.getByRole("banner").getByRole("link").first(),
    ).toHaveAccessibleName(namePattern, { timeout: 2_000 });
    // Footer legal row: "© <year> <name> Incorporated. All rights reserved."
    await expect(
      page.getByText(new RegExp(`${escapeRegExp(name)} Incorporated`)),
    ).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000, intervals: [500, 1_000, 2_000, 3_000, 5_000] });
}

async function expectPublicIdentityRestored(
  page: Page,
  originalTitle: string,
  originalFooter: string,
): Promise<void> {
  await expect(async () => {
    await page.goto("/");
    // Short inner timeouts so each miss re-goto()s promptly within the ceiling.
    await expect(page).toHaveTitle(originalTitle, { timeout: 2_000 });
    await expect(page.getByText(originalFooter)).toBeVisible({
      timeout: 2_000,
    });
  }).toPass({ timeout: 20_000, intervals: [500, 1_000, 2_000, 3_000, 5_000] });
}

test("club rename in admin propagates to the public header, footer, and title", async ({
  page,
}) => {
  // Capture the original public identity so we can prove it comes back.
  await page.goto("/");
  const originalTitle = await page.title();
  const footerCopyright = page.getByText(
    /Incorporated\. All rights reserved\./,
  );
  await expect(footerCopyright).toBeVisible();
  const originalFooter = (await footerCopyright.innerText()).trim();
  // Guard against a poisoned starting state (a previous aborted run).
  expect(originalTitle).not.toContain(NEW_NAME);
  expect(originalFooter).not.toContain(NEW_NAME);

  // Capture the current persisted override so cleanup restores it exactly
  // (empty string = "fall back to config/club.json").
  await openIdentityPage(page);
  const originalOverride = await page
    .locator("#club-identity-name")
    .inputValue();

  let restored = false;
  try {
    await setClubNameOverride(page, NEW_NAME);
    await saveClubIdentity(page);

    // The rename reaches all three public surfaces within the TTL.
    await expectPublicClubName(page, NEW_NAME);

    // Restore and confirm the public site returns to its original identity.
    await openIdentityPage(page);
    await setClubNameOverride(page, originalOverride);
    await saveClubIdentity(page);
    restored = true;
    await expectPublicIdentityRestored(page, originalTitle, originalFooter);
  } finally {
    // Safety net: if anything above threw before the restore PUT landed, force
    // the override back so the serial suite's later specs see the original
    // name. Skipped on the happy path (restore already persisted + verified).
    if (!restored) {
      await openIdentityPage(page).catch(() => {});
      await setClubNameOverride(page, originalOverride).catch(() => {});
      await saveClubIdentity(page).catch(() => {});
    }
  }
});
