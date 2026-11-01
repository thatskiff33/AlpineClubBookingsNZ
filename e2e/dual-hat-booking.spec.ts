import { expect, test } from "./helpers/accessibility";
import { loginPersona, storageStatePath } from "./helpers/auth";
import {
  bookSelfToReviewStep,
  confirmBookingToPaymentStep,
  selectCalendarDay,
} from "./helpers/booking";
import {
  bookingCreateIsolation,
  withBookingCreateClientIp,
} from "./helpers/booking-create-client-ip";
import { DUAL_HAT_ADMIN, E2E_ADMIN, ROLE_PERSONAS } from "./helpers/fixtures";
import { personas } from "./helpers/personas";
import { stayWindowForAttempt } from "./helpers/stay-dates";

// Issue #1442: portal context determines booking intent.
// - A dual-hat admin (USER + ADMIN tokens: dana) books their own stay through
//   the member /book wizard under full member rules — no redirect, no admin
//   bypasses on their own booking.
// - An admin-only account (no USER token: the e2e admin) is still forced onto
//   /admin/book.
// - A Booking Officer (bookings:edit) can complete an on-behalf booking
//   through /admin/book — creation is aligned with the modification path
//   (#1313), where it previously died with a Full-Admin-only 403.
//
// Each test signs in fresh (loginPersona handles forced 2FA enrollment) and
// uses its own stayWindow index so member-nights never collide with the
// booking/stripe specs (indexes 0-2).

test.describe.configure({ mode: "serial" });

test("a dual-hat admin books their own stay through the member wizard", async ({
  page,
}, testInfo) => {
  await loginPersona(page, DUAL_HAT_ADMIN.email);
  // Retry-scoped window (#2302): this file is a serial group, so a failure in a
  // later test re-runs this one against the booking its own previous attempt
  // left behind. Attempt 0 is unchanged.
  const window = stayWindowForAttempt(3, testInfo.retry);

  // The old behavior replaced /book with /admin/book for every ADMIN-token
  // holder; dual-hat accounts must stay on the member wizard now.
  // bookSelfToReviewStep opens /book and drives dates → self-add → review,
  // which fails immediately if the redirect still fires.
  await bookSelfToReviewStep(page, DUAL_HAT_ADMIN, window);
  expect(page.url()).not.toContain("/admin/book");

  // Creating the booking proves the API accepts a dual-hat self-booking and
  // that it takes the normal member payment path (payment owed immediately),
  // not any admin on-behalf shortcut.
  await confirmBookingToPaymentStep(
    page,
    bookingCreateIsolation("dual-hat-member-create", testInfo.retry),
  );
});

// The admin-only account never exercises the login flow here — it only checks
// portal routing — so reuse the E2E admin session saved once in auth.setup.ts
// instead of a fresh per-spec login (#1779). The other two tests keep their own
// fresh logins: each drives a different persona on its own rate-limit bucket.
test.describe("admin-only routing", () => {
  test.use({ storageState: storageStatePath(E2E_ADMIN.email) });

  test("an admin-only account is still redirected to Book on Behalf", async ({
    page,
  }) => {
    await page.goto("/book");
    await expect(page).toHaveURL(/\/admin\/book/);
    await expect(
      page.getByRole("heading", { name: "Book on Behalf of Member" }),
    ).toBeVisible();
  });
});

test("a booking officer completes an on-behalf booking draft", async ({
  page,
}, testInfo) => {
  await loginPersona(page, ROLE_PERSONAS.ADMIN_BOOKINGS.email);
  const window = stayWindowForAttempt(4, testInfo.retry);

  await page.goto("/admin/book");
  await expect(
    page.getByRole("heading", { name: "Book on Behalf of Member" }),
  ).toBeVisible();

  // Pick the target member (alice) through the search picker.
  // #2264: the picker's visible label is now associated with its input, so
  // select by accessible name instead of by placeholder.
  await page
    .getByRole("textbox", { name: "Search for a member to book on behalf of" })
    .fill(personas.booker.firstName);
  await page
    .getByRole("button", {
      name: new RegExp(`${personas.booker.firstName} ${personas.booker.lastName}`),
    })
    .first()
    .click();

  await expect(page.getByText("Select Dates", { exact: true })).toBeVisible();
  await selectCalendarDay(page, window.checkIn);
  await selectCalendarDay(page, window.checkOut);

  // Quick-add the selected member themselves as the guest.
  await page
    .getByRole("button", {
      name: `+ ${personas.booker.firstName} ${personas.booker.lastName}`,
      exact: true,
    })
    .click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();

  // The quote priced the TARGET member (previously a non-Full-Admin caller
  // was silently priced as themselves and then 403'd on submit).
  await expect(page.getByText("3. Review & Confirm")).toBeVisible();

  await withBookingCreateClientIp(
    page,
    bookingCreateIsolation("dual-hat-officer-draft", testInfo.retry),
    {
      trigger: () => page.getByRole("button", { name: "Save as Draft" }).click(),
      // Creation succeeded: the officer lands on the new booking's detail page
      // (bookings:edit holders can view it per #1313). The destination has a
      // loading boundary, so the URL commits on the skeleton while the detail
      // RSC is still in flight — waiting on it alone would tear interception
      // down inside the very window this helper exists to hold open. The
      // server-rendered heading is the authoritative outcome.
      waitForOutcome: async () => {
        await expect(page).toHaveURL(/\/bookings\/[A-Za-z0-9-]+/);
        await expect(
          page.getByRole("heading", { name: "Booking Details" }),
        ).toBeVisible();
      },
    },
  );
});
