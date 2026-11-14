import { expect, test, type Page } from "./helpers/accessibility";
import { storageStatePath } from "./helpers/auth";
import { completeMemberDetailsGateIfShown, selectCalendarDay } from "./helpers/booking";
import { personas } from "./helpers/personas";
import { stayWindow } from "./helpers/stay-dates";

// #4950 — the /book wizard keeps the member's work in this tab across the
// profile detour the guests step offers ("then return here") and a refresh,
// and "Start again" throws it away.
//
// RETRY IDEMPOTENCY (#2302): nothing here writes to the database. The dates are
// only checked, never booked, and the kept work lives in the page's
// sessionStorage, which a retry's fresh browser context starts without. So one
// window serves every attempt. Window 16 is also member-guest-consent's decline
// window on its first retry; sharing it is safe because this spec books nothing,
// so it claims no capacity and leaves no member-night behind for that spec.
test.use({ storageState: storageStatePath(personas.booker.email) });

const stay = stayWindow(16);
const GUEST = { firstName: "Rewa", lastName: "Visitor" };
const KEPT_NOTICE = "We kept the booking you were working on in this tab.";

async function expectWorkRestored(page: Page): Promise<void> {
  await expect(page.getByText(KEPT_NOTICE)).toBeVisible();
  // Back on the guests step, with the member and the guest they typed.
  await expect(
    page.getByRole("button", {
      name: `✓ ${personas.booker.firstName} ${personas.booker.lastName} (You)`,
    }),
  ).toBeVisible();
  await expect(page.locator("#guest-1-first-name")).toHaveValue(GUEST.firstName);
  await expect(page.locator("#guest-1-last-name")).toHaveValue(GUEST.lastName);
}

test("the booking form keeps dates and guests across the profile detour and a refresh", async ({
  page,
}) => {
  await page.goto("/book");
  await completeMemberDetailsGateIfShown(page);
  await expect(page.getByText("Select Your Dates")).toBeVisible();
  await selectCalendarDay(page, stay.checkIn);
  await selectCalendarDay(page, stay.checkOut);

  await page.getByRole("button", { name: "+ Add Non-Member Guest" }).click();
  await page.locator("#guest-1-first-name").fill(GUEST.firstName);
  await page.locator("#guest-1-last-name").fill(GUEST.lastName);

  // The detour the guests step offers, followed exactly as a member would.
  await page.getByRole("link", { name: "Open Family Group in your profile" }).click();
  await expect(page).toHaveURL(/\/profile/);

  await page.goto("/book");
  await expectWorkRestored(page);

  await page.reload();
  await expectWorkRestored(page);

  await page.getByRole("button", { name: "Start again" }).click();
  await expect(page.getByText("Select Your Dates")).toBeVisible();
  await expect(page.getByText(KEPT_NOTICE)).not.toBeVisible();
  // Gone for good: a further refresh brings nothing back.
  await page.reload();
  await expect(page.getByText("Select Your Dates")).toBeVisible();
  await expect(page.getByText(KEPT_NOTICE)).not.toBeVisible();
});
