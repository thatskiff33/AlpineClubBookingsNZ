import { expect, test } from "@playwright/test";
import { storageStatePath } from "./helpers/auth";
import { bookingCreateIsolation } from "./helpers/booking-create-client-ip";
import {
  bookSelfToReviewStep,
  confirmBookingToPaymentStep,
  fetchOccupiedBeds,
  selectCalendarDay,
} from "./helpers/booking";
import { E2E_ADMIN } from "./helpers/fixtures";
import { personas } from "./helpers/personas";
import { cancelMemberBookingsOnDate } from "./helpers/reset";
import { lodgeNightLabel, stayWindow } from "./helpers/stay-dates";

// Critical row: member books a bed through /book with the capacity lock.
// The persona signed in by auth.setup.ts creates a real booking through the
// full wizard. Capacity semantics under test follow issue #737: a booking
// that still owes payment holds NO bed (only committed money reserves
// capacity — see CAPACITY_HOLDING_BOOKING_STATUSES), while the member-night
// lock still blocks the same member from booking the same lodge night twice.
// The paid-booking occupancy delta is asserted in stripe-payment.spec.ts,
// where a test-mode payment can actually commit the money.
test.use({ storageState: storageStatePath(personas.booker.email) });

test.describe.configure({ mode: "serial" });

// RETRY IDEMPOTENCY (#2302). This file is the sharpest case of the pollution
// class: it is serial end to end, test 1 CREATES a PAYMENT_PENDING booking on
// this window, and test 2 must re-book THE SAME window for the member-night lock
// to be the thing under test. A retry re-runs the whole group against the
// database the failed attempt left behind, so test 1 would meet its own leftover
// and fail at the review step with BOOKING_MEMBER_NIGHT_CONFLICT — the
// `waitlist.spec.ts:57` signature, reported on the test that is not broken.
//
// `stayWindowForAttempt` is structurally unusable here (twice over): this window
// is a module-scope const, which has no `testInfo` to read `retry` from, and
// test 2 must use the same window as test 1 rather than its own. So the reset is
// the tool — an idempotent group `beforeAll`, which re-runs on every attempt
// because a retry restarts the worker. A clean first attempt cancels nothing.
const window = stayWindow(0);

test.beforeAll(async ({ browser }) => {
  // A full-admin context purely for the reset: cancelling another member's
  // booking (and opting out of the cancellation email) is admin-only. Reuses the
  // session auth.setup.ts already saved rather than logging in again (#1779).
  const adminContext = await browser.newContext({
    storageState: storageStatePath(E2E_ADMIN.email),
  });
  try {
    await cancelMemberBookingsOnDate(adminContext.request, {
      memberName: `${personas.booker.firstName} ${personas.booker.lastName}`,
      checkIn: window.checkIn,
    });
  } finally {
    await adminContext.close();
  }
});

test("member books a bed through /book and the booking owes payment", async ({
  page,
}, testInfo) => {
  const occupiedBefore = await fetchOccupiedBeds(page, window.nights);

  await bookSelfToReviewStep(page, personas.booker, window);
  await confirmBookingToPaymentStep(
    page,
    bookingCreateIsolation("booking-payment-pending", testInfo.retry),
  );

  // Issue #737: no money committed yet, so the payment-pending booking must
  // not consume lodge capacity.
  const occupiedAfter = await fetchOccupiedBeds(page, window.nights);
  for (const night of window.nights) {
    expect(
      occupiedAfter[night],
      `occupied beds on ${night} while payment is owed`,
    ).toBe(occupiedBefore[night]);
  }

  // The booking is visible to the member with payment still owed.
  await page.goto("/bookings");
  const checkInDay = String(Number(window.checkIn.split("-")[2]));
  await expect(
    page.getByText(new RegExp(`\\b${checkInDay}[/ ]`)).first(),
  ).toBeVisible();
  await expect(page.getByText(/payment/i).first()).toBeVisible();
});

test("the same member cannot hold the same lodge night twice", async ({
  page,
}) => {
  await page.goto("/book");

  await expect(page.getByText("Select Your Dates")).toBeVisible();
  // Re-select the window already booked in the previous test.
  await selectCalendarDay(page, window.checkIn);
  await selectCalendarDay(page, window.checkOut);

  // #1680: the booker is pre-selected, so self is already in the party in its
  // added state (✓). Gate on that button (unambiguous vs. the "Add Guests"
  // breadcrumb/card title) then continue — the member-night lock must refuse a
  // second live booking on the same nights with a conflict message, not a quote.
  const addedSelf = page.getByRole("button", {
    name: `✓ ${personas.booker.firstName} ${personas.booker.lastName} (You)`,
  });
  await expect(addedSelf).toBeVisible();

  await page.getByRole("button", { name: "Continue", exact: true }).click();
  // #2250: the clash is deterministic — the booker against the booking they
  // made in the previous test, over both of that window's nights — so assert
  // the exact thing this rewrite added: the member addressed directly ("you",
  // not their name) and the real nights named. A looser alternation would still
  // pass if the night list fell back to "the nights you chose" or the
  // second-person address regressed.
  //
  // The nights come from `window`, never hardcoded: stayWindow() walks forward
  // from the RUN DATE, so a literal date is an assertion that passes only in
  // the week it was written.
  const [firstNight, secondNight] = window.nights.map(lodgeNightLabel);
  await expect(
    page
      .getByText(
        // Test helper: built from formatted dates, not user input; no ReDoS.
        new RegExp(
          `you are already on another booking for ${firstNight} and ${secondNight}`,
          "i",
        ),
      )
      .first(),
  ).toBeVisible();
  // The next step is stated too, and it is the wizard's date-picking variant.
  await expect(
    page.getByText(/choose different dates/i).first(),
  ).toBeVisible();
  await expect(page.getByText("Booking Summary")).not.toBeVisible();
});

test("the booker can remove themselves and continue with another guest", async ({
  page,
}) => {
  // #1680: self is pre-selected but opt-out. Removing the booker and booking on
  // behalf of a non-member guest must still reach a priced review, and the
  // seed-once guard must not re-add self after the explicit removal.
  await page.goto("/book");

  await expect(page.getByText("Select Your Dates")).toBeVisible();
  await selectCalendarDay(page, window.checkIn);
  await selectCalendarDay(page, window.checkOut);

  const addedSelf = page.getByRole("button", {
    name: `✓ ${personas.booker.firstName} ${personas.booker.lastName} (You)`,
  });
  await expect(addedSelf).toBeVisible();

  // X the booker out. The self quick-add returns to its un-added (+) state,
  // proving the seed-once guard did not re-add them.
  await page.getByRole("button", { name: "Remove" }).first().click();
  await expect(
    page.getByRole("button", {
      name: `+ ${personas.booker.firstName} ${personas.booker.lastName} (You)`,
    }),
  ).toBeVisible();

  // Add someone else (a non-member guest) and price the booking.
  await page.getByRole("button", { name: "+ Add Non-Member Guest" }).click();
  // #2264: the guest card is a named group and its fields are now
  // label-associated, so select by role within the card rather than by
  // placeholder. Scoping matters — the admin book page renders the
  // non-member CONTACT form with near-identical field names on the same page.
  const guestCard = page.getByRole("group", { name: "Guest 1" });
  await guestCard.getByRole("textbox", { name: "First Name" }).fill("Casey");
  await guestCard.getByRole("textbox", { name: "Last Name" }).fill("Visitor");

  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByText("Booking Summary")).toBeVisible();
});
