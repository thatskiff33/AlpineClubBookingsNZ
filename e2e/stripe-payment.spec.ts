import { expect, test } from "@playwright/test";
import { storageStatePath } from "./helpers/auth";
import { bookingCreateIsolation } from "./helpers/booking-create-client-ip";
import {
  bookSelfToReviewStep,
  confirmBookingToPaymentStep,
  fetchOccupiedBeds,
} from "./helpers/booking";
import { personas } from "./helpers/personas";
import { stayWindowForAttempt } from "./helpers/stay-dates";
import {
  payWithCard,
  STRIPE_SKIP_REASON,
  stripeTestModeConfigured,
  TEST_CARDS,
} from "./helpers/stripe";

// Critical row: Stripe test-mode payment success and failure through the
// booking wizard's in-wizard card step. Requires a genuine Stripe test-mode
// account — the specs skip loudly when only placeholder keys are configured
// and refuse to run at all against live keys (stripeTestModeConfigured throws).
const configured = stripeTestModeConfigured();

test.use({ storageState: storageStatePath(personas.booker.email) });

test.skip(!configured, STRIPE_SKIP_REASON);

// Retry these specs, overriding the suite's deterministic retries: 0. The app's
// payment handling is correct (verified end-to-end), but the US-geography CI
// runners intermittently trip Stripe's datacenter-IP defenses: an invisible
// hCaptcha / Radar challenge and the Link "universal-link-modal" occasionally
// intercept confirmPayment before the card is submitted, so no charge — and thus
// no success banner or decline copy — ever occurs within the wait (issue #1224,
// diagnosed from the CI network trace: Link modal + hcaptcha frames, no
// /confirm request, no card_declined). A fresh browser context per retry clears
// Stripe's Link cookies and usually recovers; the constant datacenter IP means
// Radar can still re-challenge, so retries reduce — not eliminate — the flake.
// (The "the e2e job is non-blocking by design" note that used to close this
// paragraph is stale: `Playwright E2E` has been a required check since #1315.)
//
// Those retries only help if they are IDEMPOTENT (#2302). Each test books the
// same persona, so an attempt that got as far as creating the booking leaves the
// persona holding its stay window; a retry on that same window then never gets
// past the review step (the member-night guard), which is how run 30586027310
// turned one Stripe challenge into three failures whose reported error was the
// collision rather than the challenge. `stayWindowForAttempt` gives every
// attempt its own window; attempt 0 is unchanged. The create itself also uses
// the shared booking-create census: a Stripe retry gets a new limiter bucket,
// so it cannot turn a later waitlist or whole-lodge setup into request 21.
test.describe.configure({ retries: 2 });

test("test-mode card payment succeeds and confirms the booking", async ({
  page,
}, testInfo) => {
  const window = stayWindowForAttempt(1, testInfo.retry);
  const occupiedBefore = await fetchOccupiedBeds(page, window.nights);
  await bookSelfToReviewStep(page, personas.booker, window);
  await confirmBookingToPaymentStep(
    page,
    bookingCreateIsolation("stripe-success", testInfo.retry),
  );

  await payWithCard(page, TEST_CARDS.success);

  // Stripe's confirmPayment (redirect: "if_required") resolves one of two ways,
  // both of which mean the charge succeeded and the booking is paid:
  //   • INLINE — the intent returns `succeeded` and PaymentForm shows the
  //     "Payment successful!" banner in place (the residential-IP path #1217 saw
  //     locally); or
  //   • REDIRECT — Stripe requires additional action (3D Secure / risk-based
  //     step-up, which its risk engine is markedly more likely to trigger for a
  //     CI runner's datacenter IP than for a residential one), so the page
  //     navigates to the return_url booking page, which shows "Payment received".
  // Assert the success OUTCOME rather than one specific confirmation path, so the
  // spec is robust to whichever path Stripe takes in a given environment (#1220).
  await expect(
    page
      .getByText("Payment successful!")
      .or(page.getByText("Payment received"))
      .first(),
  ).toBeVisible({ timeout: 45_000 });

  // Money is committed now, so the paid booking must hold its beds
  // (CAPACITY_HOLDING_BOOKING_STATUSES / issue #737). The server marks the
  // booking PAID and claims capacity in the success callback just after, so poll
  // instead of sampling instantly.
  for (const night of window.nights) {
    const before = occupiedBefore[night];
    if (before === undefined) {
      throw new Error(`no occupied-bed reading for ${night} before payment`);
    }
    await expect
      .poll(
        async () => (await fetchOccupiedBeds(page, window.nights))[night],
        {
          message: `occupied beds on ${night} after payment`,
          timeout: 20_000,
        },
      )
      .toBe(before + 1);
  }

  // The booking reaches a confirmed state for the member.
  await page.goto("/bookings");
  await expect(page.getByText(/confirmed|paid/i).first()).toBeVisible();
});

test("declined test-mode card leaves the booking payable", async ({
  page,
}, testInfo) => {
  const window = stayWindowForAttempt(2, testInfo.retry);
  await bookSelfToReviewStep(page, personas.booker, window);
  await confirmBookingToPaymentStep(
    page,
    bookingCreateIsolation("stripe-decline", testInfo.retry),
  );

  await payWithCard(page, TEST_CARDS.declined);

  // Stripe surfaces the decline inside the wizard; no success state appears
  // and the member can retry payment.
  await expect(
    page.getByText(/declined|unable to process|payment failed/i).first(),
  ).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText("Payment successful!")).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Pay Now" })).toBeVisible();
});
