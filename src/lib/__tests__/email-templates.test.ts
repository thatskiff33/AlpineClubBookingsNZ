import { afterEach, describe, it, expect, vi } from "vitest";
import { passwordResetTemplate } from "@/lib/email-templates/account";
import {
  adminPendingDeadlineTemplate,
  adminSplitSettlementCancelledTemplate,
  adminSplitSettlementUnpaidTemplate,
} from "@/lib/email-templates/admin-booking";
import {
  adminDuplicateCaptureRefundTemplate,
  adminRefundRequestTemplate,
} from "@/lib/email-templates/admin-finance";
import {
  adminDailyDigestTemplate,
  adminIssueReportTemplate,
} from "@/lib/email-templates/admin-ops";
import {
  bookingBumpedTemplate,
  bookingCancelledTemplate,
  bookingConfirmedTemplate,
  bookingPendingTemplate,
  setupIntentFailedTemplate,
  splitGuestPortionCancelledTemplate,
} from "@/lib/email-templates/booking";
import {
  bookingPolicyExceptionRefusedTemplate,
} from "@/lib/email-templates/booking-exceptions";
import {
  preArrivalReminderTemplate,
} from "@/lib/email-templates/booking-reminders";
import {
  choreRosterTemplate,
  formatChoreRosterDate,
  hutLeaderAssignmentTemplate,
} from "@/lib/email-templates/chores";
import {
  waitlistOfferExpiredTemplate,
  waitlistOfferTemplate,
  waitlistPlaceRestoredTemplate,
} from "@/lib/email-templates/waitlist";
import { checkoutDayChoreNote } from "../email-message-notes";
import { getAppBaseUrl } from "../app-url";
/*
  THE EMAIL SURFACE'S OWN ACCESSOR, imported rather than reimplemented.

  These four cases used to build their expected string with `formatNZDateTime`
  from the retired `nzst-date` adapter, whose zone was `APP_TIME_ZONE` — the
  CONTAINER's `TZ`, unvalidated. Every one of the templates below renders through
  `emailClubDateTime`, whose zone is the club's PERSISTED `ClubTimeSettings.timeZone`
  with an environment SEED as the cold fallback, resolved through
  `resolveClubTimeZone` (INV-CONFIG-002; CT-5, #2869). Those two answers diverge on
  any deployment whose `TZ` names no place — `TZ=UTC` makes the seed resolver say
  `Pacific/Auckland` and the adapter say `UTC` — so the old oracle asserted the
  wrong authority and agreed only by accident of this machine's environment.

  Asserting through the accessor keeps exactly the relationship these cases always
  had (template and expectation calling the same helper) while moving both onto the
  authority the product uses. The SHAPE is pinned separately and byte-for-byte by
  `club-time/__tests__/house-shapes.test.ts`.
*/
import { emailClubDateTime } from "../email-templates-club-time";
import {
  AA_TEXT_CONTRAST_RATIO,
  DEFAULT_CLUB_THEME_VALUES,
  contrastRatio,
  deriveBrandShims,
} from "../club-theme-schema";
import { captureHostTimeZone } from "@/lib/__tests__/helpers/timezone";

describe("email-templates", () => {
  describe("adminDailyDigestTemplate", () => {
    it("uses dark text on light table headers", () => {
      const html = adminDailyDigestTemplate({
        newBookings: 1,
        paymentFailures: 0,
        capacityWarnings: 0,
        bookingsBumped: 0,
        pendingDeadlines: 0,
        xeroErrors: 0,
        totalAlerts: 1,
      });

      // The email palette is DERIVED from the substrate (#2187): the header fill
      // is the neutral-3 "mist" step and the ink is the "deep" seed. Pin the
      // header style to the COMPUTED shipping derivation, never a stale literal,
      // so it tracks the generator instead of a hand-copied hex.
      const { mist, deep, gold } = deriveBrandShims(DEFAULT_CLUB_THEME_VALUES);
      expect(html).toContain(`background-color: ${mist}; color: ${deep};`);
      // Never the accent (gold) as header ink — that was the low-contrast bug.
      expect(html).not.toContain(`background-color: ${mist}; color: ${gold};`);

      // Intent: dark ink on a light header clears WCAG AA for the header fill.
      const ratio = contrastRatio(deep, mist);
      expect(ratio).not.toBeNull();
      expect(ratio as number).toBeGreaterThanOrEqual(AA_TEXT_CONTRAST_RATIO);
    });
  });

  describe("adminDuplicateCaptureRefundTemplate (#1992 / #2007)", () => {
    const base = {
      memberName: "Alice Member",
      checkIn: new Date("2026-08-10"),
      checkOut: new Date("2026-08-12"),
      amountCents: 10000,
      paymentIntentId: "pi_link_intent",
      settledPaymentIntentId: "pi_auto_charge",
      operationReference: "duplicate_capture_booking-1_pi_link_intent",
      reviewUrl: "https://example.com/admin/payments",
    };

    it("success variant states the duplicate was refunded in full and needs no action", () => {
      const html = adminDuplicateCaptureRefundTemplate({
        ...base,
        refundFailed: false,
      });
      expect(html).toContain("Duplicate Card Capture Auto-Refunded");
      expect(html).toContain("automatically refunded in full");
      expect(html).toContain("no action is needed");
      // Booking/member/amount/intent context is carried.
      expect(html).toContain("Alice Member");
      expect(html).toContain("pi_link_intent");
      expect(html).toContain("pi_auto_charge");
      expect(html).toContain("duplicate_capture_booking-1_pi_link_intent");
      // Not the failed wording.
      expect(html).not.toContain("could not complete");
      expect(html).not.toContain("Retry Queued");
    });

    it("failed variant states the refund could not complete and a durable retry is queued, with the op reference and failure detail", () => {
      const html = adminDuplicateCaptureRefundTemplate({
        ...base,
        refundFailed: true,
        errorMessage: "Stripe is unavailable (503)",
      });
      expect(html).toContain("Retry Queued");
      expect(html).toContain("could not be automatically refunded");
      expect(html).toContain("watch the recovery queue");
      // Op reference and the inline failure detail are surfaced.
      expect(html).toContain("duplicate_capture_booking-1_pi_link_intent");
      expect(html).toContain("Stripe is unavailable (503)");
      // Not the success wording.
      expect(html).not.toContain("no action is needed");
    });

    it("falls back to 'another capture' when the settling intent id is unknown", () => {
      const html = adminDuplicateCaptureRefundTemplate({
        ...base,
        settledPaymentIntentId: null,
        refundFailed: false,
      });
      expect(html).toContain("another capture");
    });
  });

  describe("adminSplitSettlementUnpaidTemplate (#1993)", () => {
    const base = {
      memberName: "Jane Doe",
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      guestCount: 2,
      totalCents: 12000,
      holdUntil: new Date("2026-07-11T12:00:00.000Z"),
      reviewUrl: "https://example.com/admin/bookings",
      parentUnpaid: false,
    };

    it("recurring variant reports the hold extension and the capped repeating cadence", () => {
      const html = adminSplitSettlementUnpaidTemplate(base);
      expect(html).toContain("Hold extended to");
      // #1993 Part B / C3: the cadence is capped (1, 2, 3, then every 7th) and a
      // terminal cancellation ends the series — no more "repeats each run".
      expect(html).toContain("capped cadence");
      expect(html).toContain("first three hold extensions");
      expect(html).not.toContain("This alert repeats each time the hold is extended");
      expect(html).not.toContain("automatically cancelled");
    });

    it("recurring variant distinguishes parent-unpaid wording", () => {
      const settled = adminSplitSettlementUnpaidTemplate({
        ...base,
        parentUnpaid: false,
      });
      const parentUnpaid = adminSplitSettlementUnpaidTemplate({
        ...base,
        parentUnpaid: true,
      });
      expect(settled).toContain("internet banking");
      expect(parentUnpaid).toContain("has not been paid either");
    });
  });

  describe("adminSplitSettlementCancelledTemplate (#1993 Part A, C1)", () => {
    const base = {
      memberName: "Jane Doe",
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      guestCount: 2,
      totalCents: 12000,
      reviewUrl: "https://example.com/admin/bookings",
      parentUnpaid: false,
    };

    it("reports the auto-cancellation and drops any hold/repeat wording", () => {
      const html = adminSplitSettlementCancelledTemplate(base);
      expect(html).toContain("Auto-Cancelled");
      expect(html).toContain("automatically cancelled");
      // A terminal one-off notice: no "hold extended" row, no recurring cadence.
      expect(html).not.toContain("Hold extended to");
      expect(html).not.toContain("capped cadence");
      expect(html).toContain("one-off notice");
    });

    it("states the parent's actual state accurately (never a false 'also unpaid')", () => {
      const settled = adminSplitSettlementCancelledTemplate({
        ...base,
        parentUnpaid: false,
      });
      const parentUnpaid = adminSplitSettlementCancelledTemplate({
        ...base,
        parentUnpaid: true,
      });
      expect(settled).toContain("internet banking");
      expect(settled).toContain("settled and is unaffected");
      // For a not-settled parent the copy says "not settled (it may be unpaid or
      // already cancelled)" rather than asserting it is specifically unpaid.
      expect(parentUnpaid).toContain("not settled either");
      expect(parentUnpaid).toContain("already cancelled");
    });
  });

  describe("splitGuestPortionCancelledTemplate (#1993 Part A, C2)", () => {
    const base = {
      firstName: "Sam",
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      parentConfirmed: true,
    };

    it("reassures nothing was charged and only the guest portion was cancelled", () => {
      const html = splitGuestPortionCancelledTemplate(base);
      expect(html).toContain("Your Guests' Provisional Place Was Cancelled");
      expect(html).toContain("Nothing was ever charged");
      expect(html).toContain("your own booking is unaffected and remains confirmed");
    });

    it("does not promise 'remains confirmed' when the parent is not settled", () => {
      const html = splitGuestPortionCancelledTemplate({
        ...base,
        parentConfirmed: false,
      });
      expect(html).not.toContain("remains confirmed");
      expect(html).toContain("has not been changed by this cancellation");
    });

    it("shows the member's own booking reference when available", () => {
      const html = splitGuestPortionCancelledTemplate({
        ...base,
        parentBookingReference: "parent_abc",
      });
      expect(html).toContain("Your booking reference");
      expect(html).toContain("parent_abc");
    });
  });

  describe("passwordResetTemplate", () => {
    it("includes the reset URL", () => {
      const html = passwordResetTemplate("https://example.com/reset?token=abc");
      expect(html).toContain("https://example.com/reset?token=abc");
    });

    it("mentions expiry time", () => {
      const html = passwordResetTemplate("https://example.com/reset");
      expect(html).toContain("1 hour");
    });
  });

  describe("bookingConfirmedTemplate", () => {
    const checkIn = new Date("2026-07-15");
    const checkOut = new Date("2026-07-18");

    it("includes booking details", () => {
      const html = bookingConfirmedTemplate("Alice", checkIn, checkOut, 3, 45000);
      expect(html).toContain("Alice");
      expect(html).toContain("3");
      expect(html).toContain("$450.00");
    });

    it("shows confirmed status", () => {
      const html = bookingConfirmedTemplate("Test", checkIn, checkOut, 1, 10000);
      expect(html).toContain("Booking Confirmed");
    });

    it("includes view booking link", () => {
      const html = bookingConfirmedTemplate("Test", checkIn, checkOut, 1, 10000);
      expect(html).toContain("/bookings");
    });

    it("includes lodge directions and the configured door code", () => {
      const html = bookingConfirmedTemplate("Test", checkIn, checkOut, 1, 10000, {
        lodgeTravelNote: "Take the Bruce Road and carry chains.",
        doorCode: "A1234",
      });

      expect(html).toContain("How to get to the lodge");
      expect(html).toContain("Take the Bruce Road and carry chains.");
      expect(html).toContain("Door code");
      expect(html).toContain("A1234");
    });

    it("includes lodge directions without a door-code field when no code is set", () => {
      const html = bookingConfirmedTemplate("Test", checkIn, checkOut, 1, 10000, {
        lodgeTravelNote: "Take the Bruce Road and carry chains.",
        doorCode: null,
      });

      expect(html).toContain("How to get to the lodge");
      expect(html).toContain("Take the Bruce Road and carry chains.");
      expect(html).not.toContain("Door code");
    });

    it("explains the split provisional guest portion when this is a split parent (#1942)", () => {
      const holdUntil = new Date("2026-07-08T00:30:00Z");
      const html = bookingConfirmedTemplate("Test", checkIn, checkOut, 2, 10000, {
        provisionalGuests: { guestCount: 2, holdUntil },
      });

      expect(html).toContain("2 non-member guests");
      expect(html).toContain("held provisionally");
      expect(html).toContain("no bed is reserved for them yet");
      expect(html).toContain("covers only your member places");
      expect(html).toContain(emailClubDateTime(holdUntil));
    });

    it("uses singular wording for a single provisional guest (#1942)", () => {
      const holdUntil = new Date("2026-07-08T00:30:00Z");
      const html = bookingConfirmedTemplate("Test", checkIn, checkOut, 1, 10000, {
        provisionalGuests: { guestCount: 1, holdUntil },
      });

      expect(html).toContain("1 non-member guest is held provisionally");
    });

    it("omits the provisional section for an ordinary (non-split) confirmation (#1942)", () => {
      const html = bookingConfirmedTemplate("Test", checkIn, checkOut, 2, 10000);
      expect(html).not.toContain("held provisionally");
    });

    // #2263: the member whole-lodge approval confirms a booking on which NOTHING
    // has been paid (a PENDING Internet Banking receivable). Telling that member
    // "Total Paid" and "Payment has been processed successfully" is false, and
    // there is no PaymentLink on that path — so the reference is the only way
    // they can pay and it has to be in the message.
    it("states the amount OWING and the internet-banking reference for an unpaid confirmation", () => {
      const html = bookingConfirmedTemplate("Test", checkIn, checkOut, 6, 30000, {
        paymentDue: { reference: "TAC-ABC123", invoiceEmailed: true },
      });

      expect(html).toContain("Total Due");
      expect(html).not.toContain("Total Paid");
      expect(html).not.toContain("Payment has been processed successfully");
      expect(html).toContain("$300.00");
      expect(html).toContain("TAC-ABC123");
      expect(html).toContain("An invoice has been emailed to you separately.");
    });

    it("promises a club-sent invoice rather than an emailed one when none was raised", () => {
      const html = bookingConfirmedTemplate("Test", checkIn, checkOut, 6, 30000, {
        paymentDue: { reference: "TAC-ABC123", invoiceEmailed: false },
      });

      // With the Xero module off nothing raises an invoice, so claiming one has
      // been emailed is a promise the member cannot act on.
      expect(html).not.toContain("An invoice has been emailed");
      expect(html).toContain("The club will send you an invoice for it.");
      expect(html).toContain("TAC-ABC123");
    });

    it("keeps the paid confirmation exactly as it was when no payment is due", () => {
      const html = bookingConfirmedTemplate("Test", checkIn, checkOut, 2, 10000);
      expect(html).toContain("Total Paid");
      expect(html).toContain("Payment has been processed successfully.");
      expect(html).not.toContain("Total Due");
      expect(html).not.toContain("still owing");
    });
  });

  describe("bookingPendingTemplate", () => {
    const checkIn = new Date("2026-07-15");
    const checkOut = new Date("2026-07-18");
    const holdUntil = new Date("2026-07-08T00:30:00Z");

    it("includes pending explanation", () => {
      const html = bookingPendingTemplate("Alice", checkIn, checkOut, 3, holdUntil);
      expect(html).toContain("Booking Pending");
      expect(html).toContain("non-member");
    });

    it("mentions card won't be charged", () => {
      const html = bookingPendingTemplate("Test", checkIn, checkOut, 1, holdUntil);
      expect(html).toContain("only be charged when the booking is confirmed");
    });

    it("shows the exact hold deadline in the club's zone", () => {
      const html = bookingPendingTemplate("Test", checkIn, checkOut, 1, holdUntil);
      expect(html).toContain(emailClubDateTime(holdUntil));
    });

    it("does not include lodge directions or door codes", () => {
      const html = bookingPendingTemplate("Test", checkIn, checkOut, 1, holdUntil);
      expect(html).not.toContain("How to get to the lodge");
      expect(html).not.toContain("Door code");
      expect(html).not.toContain("A1234");
    });
  });

  describe("preArrivalReminderTemplate", () => {
    const checkIn = new Date("2026-07-15");
    const checkOut = new Date("2026-07-18");

    it("includes directions and current door code when set", () => {
      const html = preArrivalReminderTemplate({
        firstName: "Alice",
        checkIn,
        checkOut,
        guestCount: 2,
        expectedArrivalTime: "16:30",
        lodgeTravelNote: "Park below the lodge and walk up.",
        doorCode: "9876",
      });

      expect(html).toContain("Upcoming Lodge Stay");
      expect(html).toContain("Park below the lodge and walk up.");
      expect(html).toContain("Door code");
      expect(html).toContain("9876");
      expect(html).toContain("16:30");
    });

    it("renders the checkout-day chore sentence it is handed", () => {
      // #2621 (owner decision D-M5). The sentence is handed IN, composed by
      // `checkoutDayChoreNote` at the send site from the club's chores module
      // flag, so this HTML and the admin-editable body's {{checkoutChoreNote}}
      // cannot say different things.
      const html = preArrivalReminderTemplate({
        firstName: "Alice",
        checkIn,
        checkOut,
        guestCount: 2,
        lodgeTravelNote: "Park below the lodge and walk up.",
        doorCode: null,
        checkoutChoreNote: checkoutDayChoreNote(true),
      });

      expect(html).toContain("chore roster on the morning you check out");
      // The arrival information is unaffected — the field stays, as
      // display-only information (owner decision, 8 Aug).
      expect(
        preArrivalReminderTemplate({
          firstName: "Alice",
          checkIn,
          checkOut,
          guestCount: 2,
          expectedArrivalTime: "16:30",
          lodgeTravelNote: "Park below the lodge and walk up.",
          doorCode: null,
          checkoutChoreNote: checkoutDayChoreNote(true),
        })
      ).toContain("Expected arrival");
    });

    it("says nothing about chores for a club with no chore roster", () => {
      // The chores module DEFAULTS OFF, so this is the ordinary case, and an
      // unconditional sentence would tell those clubs' members to talk to a hut
      // leader about a roster that does not exist. Omitting the field reads the
      // same way as an explicit empty value — the fail-quiet direction for a
      // caller that has not been updated.
      for (const params of [{ checkoutChoreNote: checkoutDayChoreNote(false) }, {}]) {
        const html = preArrivalReminderTemplate({
          firstName: "Alice",
          checkIn,
          checkOut,
          guestCount: 2,
          lodgeTravelNote: "Park below the lodge and walk up.",
          doorCode: null,
          ...params,
        });

        expect(html).not.toMatch(/chore/i);
        expect(html).not.toMatch(/hut leader/i);
        // And no empty paragraph left where the sentence would have been.
        expect(html).not.toMatch(/<p[^>]*>\s*<\/p>/);
      }
    });

    it("omits the door-code field when no code is set", () => {
      const html = preArrivalReminderTemplate({
        firstName: "Alice",
        checkIn,
        checkOut,
        guestCount: 2,
        lodgeTravelNote: "Park below the lodge and walk up.",
        doorCode: null,
      });

      expect(html).toContain("Park below the lodge and walk up.");
      expect(html).not.toContain("Door code");
    });
  });

  describe("bookingBumpedTemplate", () => {
    const checkIn = new Date("2026-07-15");
    const checkOut = new Date("2026-07-18");

    it("includes bumped explanation", () => {
      const html = bookingBumpedTemplate("Alice", checkIn, checkOut, 2, true);
      expect(html).toContain("bumped");
      expect(html).toContain("member demand");
    });

    it("clarifies no charge", () => {
      const html = bookingBumpedTemplate("Test", checkIn, checkOut, 1, true);
      expect(html).toContain("not been charged");
    });

    it("includes rebook link", () => {
      const html = bookingBumpedTemplate("Test", checkIn, checkOut, 1, true);
      expect(html).toContain("/book");
    });

    // #2430: the same notice reaches a club member and a non-login
    // NON_MEMBER/SCHOOL contact (a converted public booking request). Only the
    // member can complete the login behind /book. The recipient argument is
    // REQUIRED — there is no default to fall back to, because `true` is the
    // leaky value (#2430 review) — so this pins the member wording directly.
    it("pins the member wording: Book Again, linked to the member booking flow", () => {
      const html = bookingBumpedTemplate("Test", checkIn, checkOut, 1, true);
      expect(html).toContain("Book Again");
      expect(html).toMatch(/href="[^"]*\/book"/);
      expect(html).not.toContain("Contact the Club");
    });

    it("sends a non-login recipient to the club contact page, not the members-only booking flow", () => {
      const html = bookingBumpedTemplate("Test", checkIn, checkOut, 1, false);
      expect(html).toContain("Contact the Club");
      expect(html).toContain("/contact");
      expect(html).not.toContain("Book Again");
      // No link anywhere in the message points at the member booking flow.
      expect(html).not.toMatch(/href="[^"]*\/book"/);
    });

    // #2430 review: a club's Contact page need not carry a contact form, so a
    // reader who cannot sign in would otherwise be left with no way to reply.
    it("names the club's support address for both recipient classes", () => {
      for (const canBook of [true, false]) {
        const html = bookingBumpedTemplate("Test", checkIn, checkOut, 1, canBook);
        expect(html).toContain("If you have any questions, contact the club at");
        expect(html).toContain("mailto:");
      }
    });
  });

  describe("bookingCancelledTemplate", () => {
    const checkIn = new Date("2026-07-15");
    const checkOut = new Date("2026-07-18");

    it("shows refund amount when applicable", () => {
      const html = bookingCancelledTemplate("Alice", checkIn, checkOut, 25000);
      expect(html).toContain("$250.00");
      expect(html).toContain("refund");
    });

    it("shows no refund message when zero", () => {
      const html = bookingCancelledTemplate("Alice", checkIn, checkOut, 0);
      expect(html).toContain("No refund was applicable");
    });

    it("surfaces restored applied credit subject to the cancellation policy (#1164)", () => {
      const html = bookingCancelledTemplate(
        "Alice",
        checkIn,
        checkOut,
        0,
        "card",
        1500
      );
      expect(html).toContain("$15.00");
      expect(html).toContain("previously applied account credit");
      expect(html).toContain("per the cancellation policy");
    });

    it("omits the restored-credit line when nothing was restored", () => {
      const html = bookingCancelledTemplate("Alice", checkIn, checkOut, 25000);
      expect(html).not.toContain("previously applied account credit");
    });
  });

  describe("choreRosterTemplate", () => {
    it("includes chore list", () => {
      const html = choreRosterTemplate("Bob", "2026-07-15", [
        { name: "Dishes", description: "Wash all dishes" },
        { name: "Sweep", description: null },
      ]);
      expect(html).toContain("Dishes");
      expect(html).toContain("Sweep");
      expect(html).toContain("Wash all dishes");
    });

    it("includes heater/fire safety reminder", () => {
      const html = choreRosterTemplate("Test", "2026-07-15", []);
      expect(html).toContain("heaters and fire");
    });

    it("keeps the deliberate long-weekday roster date (#2256)", () => {
      // De-duplicating this formatter with src/lib/email/chores.ts must not
      // change what the roster email says.
      expect(formatChoreRosterDate("2026-07-15")).toBe("Wednesday, 15 July 2026");
      expect(choreRosterTemplate("Bob", "2026-07-15", [])).toContain(
        "Wednesday, 15 July 2026",
      );
    });
  });

  describe("setupIntentFailedTemplate (#2256)", () => {
    const hostTimeZone = captureHostTimeZone();
    afterEach(() => {
      hostTimeZone.restore();
    });

    it("renders a @db.Date stay as that same NZ calendar day", () => {
      // Production shape: Booking.checkIn/checkOut are `@db.Date`, so Prisma
      // hands the template UTC-midnight Dates. The old
      // `toLocaleDateString("en-NZ")` had no timeZone, so it rendered these in
      // the sending process's own zone: correct on an NZ- or UTC-clocked
      // worker, but a day EARLY on anything west of UTC (a US-hosted worker
      // reads 2026-04-16T00:00Z as the evening of 15 April). The format was
      // wrong everywhere — "16/04/2026" rather than the house "16 Apr 2026".
      const html = setupIntentFailedTemplate({
        firstName: "Ada",
        checkIn: new Date("2026-04-16T00:00:00.000Z"),
        checkOut: new Date("2026-04-18T00:00:00.000Z"),
      });

      expect(html).toContain("16 Apr 2026 – 18 Apr 2026");
      expect(html).not.toContain("16/04/2026");

      // Same dates, worker in a zone behind UTC: the calendar day must not move.
      process.env.TZ = "America/New_York";
      expect(
        setupIntentFailedTemplate({
          firstName: "Ada",
          checkIn: new Date("2026-04-16T00:00:00.000Z"),
          checkOut: new Date("2026-04-18T00:00:00.000Z"),
        }),
      ).toContain("16 Apr 2026 – 18 Apr 2026");
    });

    it("REFUSES a stay carrying a time of day, rather than projecting it (#3113)", () => {
      // This case used to assert the opposite: it fed `checkIn`
      // 2026-04-15T23:30Z and expected "16 Apr 2026", because 23:30Z is already
      // 16 April in New Zealand. That pinned a PROJECTION of a value the
      // template documents as a stored calendar day, and it was green only
      // because New Zealand is east of Greenwich — the identical input renders
      // 15 April for a club in Denver or Honolulu.
      //
      // The fixture was also impossible. `Booking.checkIn`/`checkOut` are
      // `@db.Date`, PostgreSQL will not keep a time in a `date` column, and the
      // template's only production caller reads both straight off a `booking`
      // row (`stripe-webhook-service.ts` -> `handleSetupIntentFailed`). So the
      // old assertion described no reachable state while pinning the behaviour
      // this epic exists to remove.
      //
      // What replaces it is the same intent stated positively: a value carrying
      // a time of day is a REAL INSTANT that reached a calendar-day token, and
      // the guard says so loudly instead of mailing a plausible wrong day.
      expect(() =>
        setupIntentFailedTemplate({
          firstName: "Ada",
          checkIn: new Date("2026-04-15T23:30:00.000Z"),
          checkOut: new Date("2026-04-17T23:30:00.000Z"),
        }),
      ).toThrow(/takes a stored calendar day, not a moment/);
    });
  });

  describe("hutLeaderAssignmentTemplate", () => {
    const startDate = new Date("2026-07-15");
    const endDate = new Date("2026-07-18");

    it("includes the hut leader PIN and lodge link", () => {
      const html = hutLeaderAssignmentTemplate({
        firstName: "Alice",
        startDate,
        endDate,
        pin: "123456",
        assignmentId: "assign-abc123",
      });

      expect(html).toContain("123456");
      expect(html).toContain("/lodge");
    });

    it("includes assignment responsibilities", () => {
      const html = hutLeaderAssignmentTemplate({
        firstName: "Alice",
        startDate,
        endDate,
        pin: "123456",
        assignmentId: "assign-abc123",
      });

      expect(html).toContain("arrivals");
      expect(html).toContain("roster");
    });
  });

  describe("time-sensitive templates", () => {
    it("uses club date-time formatting for admin pending deadlines", () => {
      const deadline = new Date("2026-04-14T09:15:00Z");
      const html = adminPendingDeadlineTemplate([
        {
          memberName: "Jane Doe",
          checkIn: new Date("2026-04-15"),
          checkOut: new Date("2026-04-17"),
          guestCount: 3,
          deadline,
          hoursRemaining: 20,
        },
      ]);

      expect(html).toContain(emailClubDateTime(deadline));
    });

    it("uses club date-time formatting for waitlist offer expiry", () => {
      const expiresAt = new Date("2026-07-10T05:45:00Z");
      const html = waitlistOfferTemplate(
        "Jane",
        new Date("2026-07-01"),
        new Date("2026-07-03"),
        2,
        expiresAt,
        "booking123",
        10000
      );

      expect(html).toContain(emailClubDateTime(expiresAt));
    });
  });

  // #2649 — the stranded-confirm repair's member notice.
  //
  // The repair returns a booking to the waitlist after the member's FREE
  // waitlist confirmation was left in PAYMENT_PENDING by a failure in our own
  // code. Reusing `waitlist-offer-expired` for that told the member the one
  // thing that was demonstrably false — that their offer had expired — and
  // contradicted the #2648 message they had already been sent saying their
  // confirmation was stuck and not to retry. So this template is a true sibling
  // in shape and a deliberate opposite in wording, and both halves are pinned
  // here.
  describe("waitlistPlaceRestoredTemplate", () => {
    const render = () =>
      waitlistPlaceRestoredTemplate(
        "Mike",
        new Date("2026-07-01"),
        new Date("2026-07-03"),
        3,
      );

    it("states the restored place, the reassurance, and the same three rows as the expiry notice", () => {
      const html = render();

      expect(html).toContain("Your Waitlist Place Is Back");
      expect(html).toContain("Mike");

      // Same facts, same rows, same order as waitlistOfferExpiredTemplate — the
      // member still needs to know which nights and where they now sit.
      expect(html).toContain("Check-in");
      expect(html).toContain("Check-out");
      expect(html).toContain("New Position");
      expect(html).toContain("#3");

      // The reassurance is the entire reason this template exists: the club's
      // code failed, not the member, and their offer never ran out.
      expect(html).toContain("This was not something you did wrong");
      expect(html).toContain("your offer did not run out");
      expect(html).toContain("you confirmed in time");
      expect(html).toContain("our system could not complete it");

      // And the close tells them to do nothing, which is what #2648 already
      // asked of them — the two messages must not disagree.
      expect(html).toContain("You do not need to do anything");
      expect(html).toContain(
        "We will email you again as soon as a spot opens up for these nights",
      );

      // Same call to action as its sibling.
      expect(html).toContain("View Booking");
      expect(html).toContain("/bookings");
    });

    it("never says the offer expired, in any casing, anywhere in the message", () => {
      const html = render().toLowerCase();

      expect(html).not.toContain("has expired");
      expect(html).not.toContain("expired");
      // Nothing weaker either — no "expires", no "expiry".
      expect(html).not.toContain("expir");

      // The guard is only meaningful because the template it replaces DOES say
      // it; without this the assertions above could pass on an empty string.
      const expiryHtml = waitlistOfferExpiredTemplate(
        "Mike",
        new Date("2026-07-01"),
        new Date("2026-07-03"),
        3,
      ).toLowerCase();
      expect(expiryHtml).toContain("has expired");
    });
  });

  describe("support contact config", () => {
    it("renders the config-derived support email as a stable search key, and the removed SUPPORT_EMAIL env has no effect (#1986)", async () => {
      vi.resetModules();
      vi.stubEnv("EMAIL_FROM", "sender@example.com");
      // C7 #1986 removed the SUPPORT_EMAIL env override — email identity is now
      // DB-first / config-derived only. Setting the env var must NOT change what
      // the template bakes in (the config-derived search key that send-time
      // replacement later swaps for the live EmailMessageSetting.supportEmail).
      vi.stubEnv("SUPPORT_EMAIL", "help@example.com");

      const [{ accountDeletionApprovedTemplate }, { clubConfig }] =
        await Promise.all([
          import("@/lib/email-templates/account"),
          import("@/config/club"),
        ]);
      const html = accountDeletionApprovedTemplate("Alice");

      // The config-derived support address renders; the env value is ignored.
      expect(html).toContain(clubConfig.supportEmail);
      expect(html).not.toContain("help@example.com");

      vi.unstubAllEnvs();
    });
  });

  describe("issue report and refund free-text rendering", () => {
    it("preserves line breaks in issue report descriptions without trusting external URLs", () => {
      const html = adminIssueReportTemplate({
        memberName: "Casey Member",
        memberEmail: "casey@example.com",
        pageUrl: "https://evil.example/phish",
        pageTitle: "Broken page",
        description: "Line 1\n<script>alert(1)</script>\nLine 3",
        issueReportUrl: `${getAppBaseUrl()}/admin/issue-reports?report=issue-1`,
        hasScreenshot: true,
      });

      expect(html).toContain("white-space: pre-wrap");
      expect(html).toContain("Line 1\n&lt;script&gt;alert(1)&lt;/script&gt;\nLine 3");
      expect(html).not.toContain('href="https://evil.example/phish"');
      expect(html).toContain(`href="${getAppBaseUrl()}"`);
      expect(html).toContain("/admin/issue-reports?report=issue-1");
    });

    it("preserves line breaks in refund appeal reasons", () => {
      const html = adminRefundRequestTemplate({
        memberName: "Casey Member",
        bookingId: "booking-1",
        checkIn: new Date("2026-07-01"),
        checkOut: new Date("2026-07-03"),
        reason: "First line\nSecond line",
        requestedAmountCents: 2500,
        paidAmountCents: 5000,
        refundedAmountCents: 0,
      });

      expect(html).toContain("white-space: pre-wrap");
      expect(html).toContain("First line\nSecond line");
    });
  });
});

/**
 * #2562 review — the refusal notice.
 *
 * Before this, a refusal recorded a mandatory member-facing explanation and
 * delivered it nowhere. Three properties of the copy are load-bearing: the reason
 * actually appears, the message says nothing was booked or held, and it carries NO
 * `/bookings` CTA — the canonical authorized booking link is gated on
 * `ALWAYS_BOOKING_SCOPED_TEMPLATE_NAMES`, whose contract is that every sender hands
 * over a real booking id, and a refused NEW-booking request has none. A CTA added
 * here would be silently stripped on the change path and would make that set's own
 * statement false.
 */
describe("bookingPolicyExceptionRefusedTemplate", () => {
  function render(overrides: Record<string, unknown> = {}) {
    return bookingPolicyExceptionRefusedTemplate({
      firstName: "Ada",
      lodgeName: "Example Lodge",
      checkIn: new Date("2026-08-14T00:00:00.000Z"),
      checkOut: new Date("2026-08-15T00:00:00.000Z"),
      reasonLine:
        "Why the Booking Officer said no: that weekend is fully committed every year.",
      askDescription:
        "your request to be let past a booking rule for a new stay",
      ...overrides,
    } as Parameters<typeof bookingPolicyExceptionRefusedTemplate>[0]);
  }

  it("delivers the officer's explanation and says nothing was booked or held", () => {
    const html = render();
    expect(html).toContain("Your request was not approved");
    expect(html).toContain("fully committed every year");
    expect(html).toContain("Nothing was booked and nothing was changed");
    expect(html).toContain("gone back into the pool");
    // Where to look, since there is no button (see below).
    expect(html).toContain("My booking-rule requests");
  });

  it("carries no /bookings call to action on either flavour", () => {
    for (const askDescription of [
      "your request to be let past a booking rule for a new stay",
      "your request to be let past a booking rule for a change to your booking",
    ]) {
      const html = render({ askDescription });
      expect(html).not.toContain("/bookings");
      expect(html).not.toContain("View Booking");
    }
  });

  it("renders nothing in place of an absent reason rather than a dangling label", () => {
    const html = render({ reasonLine: "" });
    expect(html).not.toContain("Why the Booking Officer said no");
    expect(html).toContain("Your request was not approved");
  });
});
