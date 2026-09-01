import { describe, expect, it } from "vitest";
import { BookingEventType, BookingStatus } from "@prisma/client";
import {
  resolveBookingNarrative,
  type NarrativeBooking,
  type NarrativeEvent,
} from "@/lib/booking-narrative";
import { DUPLICATE_CAPTURE_REFUND_EVENT_KIND } from "@/lib/duplicate-capture-refund-event";
import { bindClubTime, requireClubTimeZone } from "@/lib/club-time";

/**
 * The club's binding, supplied the way both real callers supply it (#3123). It
 * governs the real instants this resolver renders and nothing else: the stay
 * dates below are `@db.Date` lodge nights and take no zone.
 * `club-time-authority.test.ts` beside this file is where the two are pulled
 * apart under a club zone the environment does not hold.
 */
const CLUB = bindClubTime(requireClubTimeZone("Pacific/Auckland"));

const CHECK_IN = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-03T00:00:00.000Z");

function booking(overrides: Partial<NarrativeBooking> = {}): NarrativeBooking {
  return {
    status: "PENDING",
    finalPriceCents: 12000,
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    firstName: "Sam",
    adminReviewStatus: null,
    adminReviewNotes: null,
    adminReviewReason: null,
    ...overrides,
  };
}

function event(
  type: BookingEventType,
  occurredAt: string,
  extra: Partial<NarrativeEvent> = {}
): NarrativeEvent {
  return {
    type,
    occurredAt: new Date(occurredAt),
    amountCents: null,
    reason: null,
    snapshot: null,
    ...extra,
  };
}

describe("resolveBookingNarrative", () => {
  it("describes a payable booking with the amount and NZT dates", () => {
    const result = resolveBookingNarrative({
      club: CLUB,
      booking: booking({ status: "PENDING" }),
      events: [event(BookingEventType.CREATED, "2026-07-01T00:00:00.000Z")],
    });

    expect(result.state).toBe("payable");
    expect(result.message).toContain("$120.00");
    expect(result.message).toContain("1 Aug 2026 to 3 Aug 2026");
    expect(result.nextStep).not.toMatch(/booking officer/i);
  });

  it("offers a fresh link (not an error) when the link has expired but the booking is payable", () => {
    const result = resolveBookingNarrative({
      club: CLUB,
      booking: booking({ status: "PENDING" }),
      events: [],
      link: {
        expiresAt: new Date("2020-01-01T00:00:00.000Z"),
        usedAt: null,
        revokedAt: null,
      },
      now: new Date("2026-07-01T00:00:00.000Z"),
    });

    expect(result.state).toBe("expired_payable");
    expect(result.nextStep).toMatch(/fresh payment link/i);
  });

  it("treats a revoked link on a still-payable booking as expired-but-payable", () => {
    const result = resolveBookingNarrative({
      club: CLUB,
      booking: booking({ status: "PAYMENT_PENDING" }),
      events: [],
      link: {
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        usedAt: null,
        revokedAt: new Date("2026-07-01T00:00:00.000Z"),
      },
      now: new Date("2026-07-02T00:00:00.000Z"),
    });

    expect(result.state).toBe("expired_payable");
  });

  it("confirms a paid booking with the amount paid and the NZT date", () => {
    const result = resolveBookingNarrative({
      club: CLUB,
      booking: booking({ status: "PAID" }),
      events: [
        event(BookingEventType.CREATED, "2026-05-01T00:00:00.000Z"),
        event(BookingEventType.MEMBER_PAID, "2026-05-02T00:00:00.000Z", {
          amountCents: 12000,
        }),
      ],
    });

    expect(result.state).toBe("paid");
    expect(result.message).toContain("Thanks Sam");
    expect(result.message).toContain("$120.00");
    expect(result.message).toContain("2 May 2026");
  });

  it("treats COMPLETED like PAID", () => {
    const result = resolveBookingNarrative({
      club: CLUB,
      booking: booking({ status: "COMPLETED" }),
      events: [
        event(BookingEventType.MEMBER_PAID, "2026-05-02T00:00:00.000Z", {
          amountCents: 12000,
        }),
      ],
    });

    expect(result.state).toBe("paid");
  });

  it("confirms a $0 booking without claiming a payment was taken", () => {
    const result = resolveBookingNarrative({
      club: CLUB,
      booking: booking({ status: "PAID", finalPriceCents: 0 }),
      events: [
        event(BookingEventType.MEMBER_PAID, "2026-05-02T00:00:00.000Z", {
          amountCents: 0,
        }),
      ],
    });

    expect(result.state).toBe("paid");
    expect(result.message).toMatch(/no payment was required/i);
  });

  it("explains a bumped booking (released, no payment) with the release date", () => {
    const result = resolveBookingNarrative({
      club: CLUB,
      booking: booking({ status: "CANCELLED" }),
      events: [
        event(BookingEventType.CREATED, "2026-05-01T00:00:00.000Z"),
        event(BookingEventType.BUMPED, "2026-05-04T00:00:00.000Z", {
          snapshot: { flagged: false },
        }),
      ],
    });

    expect(result.state).toBe("bumped");
    expect(result.message).toContain("filled up");
    expect(result.message).toContain("released on 4 May 2026");
    expect(result.message).toMatch(/no payment was taken/i);
    expect(result.nextStep).toMatch(/book these dates again/i);
  });

  it("treats a BUMPED-status booking as bumped even without a bump event", () => {
    const result = resolveBookingNarrative({
      club: CLUB,
      booking: booking({ status: "BUMPED" }),
      events: [],
    });

    expect(result.state).toBe("bumped");
  });

  it("explains a pre-payment cancellation with nothing to refund", () => {
    const result = resolveBookingNarrative({
      club: CLUB,
      booking: booking({ status: "CANCELLED" }),
      events: [
        event(BookingEventType.CREATED, "2026-05-01T00:00:00.000Z"),
        event(BookingEventType.CANCELLED, "2026-05-05T00:00:00.000Z"),
      ],
    });

    expect(result.state).toBe("cancelled_pre_payment");
    expect(result.message).toContain("cancelled on 5 May 2026");
    expect(result.message).toMatch(/nothing to refund/i);
  });

  it("reproduces the cancelled-post-payment example exactly from stored facts", () => {
    const result = resolveBookingNarrative({
      club: CLUB,
      booking: booking({ status: "CANCELLED" }),
      events: [
        event(BookingEventType.MEMBER_PAID, "2026-05-02T00:00:00.000Z", {
          amountCents: 12000,
        }),
        event(BookingEventType.CANCELLED, "2026-05-05T00:00:00.000Z", {
          amountCents: 12000,
          snapshot: {
            policySummary:
              "Cancelled 3 day(s) before check-in: 75% card refund under the policy in effect at the time.",
            refundMethod: "card",
            refundPercentage: 75,
            paidAmountCents: 12000,
            settledAmountCents: 9000,
            retainedAmountCents: 3000,
            changeFeeCents: 0,
          },
        }),
        event(BookingEventType.REFUNDED, "2026-05-06T00:00:00.000Z", {
          amountCents: 9000,
        }),
      ],
    });

    expect(result.state).toBe("cancelled_post_payment");
    expect(result.message).toBe(
      "You cancelled this booking on 5 May 2026 after paying $120.00 on 2 May 2026. Under the cancellation policy in effect at the time, $90.00 was refunded on 6 May 2026 and $30.00 was retained. No further payment is required."
    );
  });

  it("EXCLUDES a #1992 duplicate-capture auto-refund from a later cancellation's settlement (#2008)", () => {
    // A duplicate card capture was auto-refunded (a REFUNDED event carrying the
    // duplicate_capture_refund discriminator), then the member later cancelled
    // under a no-refund policy. The cancellation narrative must describe the
    // no-refund cancellation from the CANCELLED snapshot and NEVER pick up the
    // duplicate-capture refund as this cancellation's settlement clause.
    const result = resolveBookingNarrative({
      club: CLUB,
      booking: booking({ status: "CANCELLED" }),
      events: [
        event(BookingEventType.MEMBER_PAID, "2026-05-02T00:00:00.000Z", {
          amountCents: 12000,
        }),
        // The #1992 duplicate-capture auto-refund of a second, distinct capture.
        event(BookingEventType.REFUNDED, "2026-05-03T00:00:00.000Z", {
          amountCents: 5000,
          snapshot: {
            kind: DUPLICATE_CAPTURE_REFUND_EVENT_KIND,
            duplicatePaymentIntentId: "pi_link_dup",
            settledPaymentIntentId: "pi_auto_charge",
            refundedAmountCents: 5000,
          },
        }),
        event(BookingEventType.CANCELLED, "2026-05-05T00:00:00.000Z", {
          amountCents: 12000,
          snapshot: {
            policySummary:
              "Cancelled inside the no-refund window under the policy in effect at the time.",
            refundMethod: "card",
            refundPercentage: 0,
            paidAmountCents: 12000,
            settledAmountCents: 0,
            retainedAmountCents: 12000,
            changeFeeCents: 0,
          },
        }),
      ],
    });

    expect(result.state).toBe("cancelled_post_payment");
    expect(result.message).toBe(
      "You cancelled this booking on 5 May 2026 after paying $120.00 on 2 May 2026. Under the cancellation policy in effect at the time, no refund was due and the full $120.00 was retained. No further payment is required."
    );
    // The duplicate-capture refund amount/date never leaks into the narrative.
    expect(result.message).not.toContain("$50.00");
    expect(result.message).not.toContain("3 May 2026");
    expect(result.message).not.toContain("was refunded");
  });

  it("describes a credit refund as account credit rather than a card refund", () => {
    const result = resolveBookingNarrative({
      club: CLUB,
      booking: booking({ status: "CANCELLED" }),
      events: [
        event(BookingEventType.MEMBER_PAID, "2026-05-02T00:00:00.000Z", {
          amountCents: 12000,
        }),
        event(BookingEventType.CANCELLED, "2026-05-05T00:00:00.000Z", {
          snapshot: {
            policySummary: "credit",
            refundMethod: "credit",
            refundPercentage: 75,
            paidAmountCents: 12000,
            settledAmountCents: 9000,
            retainedAmountCents: 3000,
            changeFeeCents: 0,
          },
        }),
        event(BookingEventType.CREDITED, "2026-05-05T00:00:00.000Z", {
          amountCents: 9000,
        }),
      ],
    });

    expect(result.state).toBe("cancelled_post_payment");
    expect(result.message).toContain("$90.00 was added to your account credit");
    expect(result.message).toContain("$30.00 was retained");
  });

  it("describes a no-refund cancellation as the full amount retained", () => {
    const result = resolveBookingNarrative({
      club: CLUB,
      booking: booking({ status: "CANCELLED" }),
      events: [
        event(BookingEventType.MEMBER_PAID, "2026-05-02T00:00:00.000Z", {
          amountCents: 12000,
        }),
        event(BookingEventType.CANCELLED, "2026-05-05T00:00:00.000Z", {
          snapshot: {
            policySummary: "no refund",
            refundMethod: "card",
            refundPercentage: 0,
            paidAmountCents: 12000,
            settledAmountCents: 0,
            retainedAmountCents: 12000,
            changeFeeCents: 0,
          },
        }),
      ],
    });

    expect(result.state).toBe("cancelled_post_payment");
    expect(result.message).toContain("no refund was due and the full $120.00 was retained");
  });

  it("surfaces an admin-declined review with the reason", () => {
    const result = resolveBookingNarrative({
      club: CLUB,
      booking: booking({
        status: "CANCELLED",
        adminReviewStatus: "REJECTED",
        adminReviewNotes: "Youth-only party needs an accompanying adult.",
      }),
      events: [event(BookingEventType.CANCELLED, "2026-05-05T00:00:00.000Z")],
    });

    expect(result.state).toBe("declined");
    expect(result.message).toContain(
      "Youth-only party needs an accompanying adult."
    );
    expect(result.nextStep).not.toMatch(/booking officer/i);
  });

  it("describes an awaiting-review booking", () => {
    const result = resolveBookingNarrative({
      club: CLUB,
      booking: booking({ status: "AWAITING_REVIEW", adminReviewStatus: "PENDING" }),
      events: [event(BookingEventType.CREATED, "2026-05-01T00:00:00.000Z")],
    });

    expect(result.state).toBe("under_review");
    expect(result.message).toMatch(/review/i);
  });

  it("produces identical wording for the public link view and the admin view", () => {
    const cancelledBooking = booking({ status: "CANCELLED" });
    const events = [
      event(BookingEventType.MEMBER_PAID, "2026-05-02T00:00:00.000Z", {
        amountCents: 12000,
      }),
      event(BookingEventType.CANCELLED, "2026-05-05T00:00:00.000Z", {
        snapshot: {
          policySummary: "card",
          refundMethod: "card",
          refundPercentage: 75,
          paidAmountCents: 12000,
          settledAmountCents: 9000,
          retainedAmountCents: 3000,
          changeFeeCents: 0,
        },
      }),
      event(BookingEventType.REFUNDED, "2026-05-06T00:00:00.000Z", {
        amountCents: 9000,
      }),
    ];

    // Public payment-link view (carries the link state) vs admin history view.
    const publicView = resolveBookingNarrative({
      club: CLUB,
      booking: cancelledBooking,
      events,
      link: {
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        usedAt: null,
        revokedAt: null,
      },
    });
    const adminView = resolveBookingNarrative({
      club: CLUB,
      booking: cancelledBooking,
      events,
    });

    expect(publicView).toEqual(adminView);
  });

  it("never falls back to a generic contact-the-officer message", () => {
    const states: NarrativeBooking[] = [
      booking({ status: "PENDING" }),
      booking({ status: "PAID" }),
      booking({ status: "CANCELLED" }),
      booking({ status: "BUMPED" }),
    ];
    for (const b of states) {
      const result = resolveBookingNarrative({ booking: b, events: [], club: CLUB });
      expect(result.message).not.toMatch(/contact the booking officer/i);
      expect(result.nextStep).not.toMatch(/contact the booking officer/i);
    }
  });

  // Issue #822 UX review: no booking state should leave a member without
  // page-level guidance. Every BookingStatus must yield a non-empty headline,
  // message, and a concrete next step (including DRAFT / WAITLISTED /
  // WAITLIST_OFFERED, which fall through to the specific fallback narrative).
  it("gives every BookingStatus a non-empty headline, message, and concrete next step", () => {
    const missingGuidance = Object.values(BookingStatus).filter((status) => {
      const result = resolveBookingNarrative({
        club: CLUB,
        booking: booking({ status }),
        events: [],
      });
      return (
        !result.headline.trim() ||
        !result.message.trim() ||
        !result.nextStep.trim()
      );
    });

    expect(missingGuidance).toEqual([]);
  });
});

/**
 * #3033 (epic #2797) — the member is told their change saved and the money is
 * with the club, without being told a number that does not exist.
 *
 * MUTATION PROOF. Print `finalPriceCents` (or any amount) in the standalone
 * message and "names no amount at all" fails. Name it `under_review` and "does
 * not collide with the admin approval queue" fails. Check the flag after the
 * PAID branch and "outranks the paid narrative" fails; check it before the
 * cancellation branch and "does not outrank a cancellation" fails. Default the
 * flag to true and "says nothing about review unless the caller says so" fails.
 * Put a cause, a diagnostic word or a member-blaming clause in the copy and
 * "uses no internal vocabulary and blames nobody" fails. Return the review
 * narrative outright for a payable booking — the original shape of this branch —
 * and "does not tell an unpaid booking there is nothing to do" fails on both the
 * amount due and the unscoped sentence.
 *
 * #3194 ADDED THE PAID COMPOSITION and its own proofs. Return the standalone
 * narrative for a PAID booking — the shape #3033 shipped — and "confirms the
 * payment it has received" fails on the headline and on every sentence about the
 * money that arrived. Append to the paid next step instead of replacing it and
 * the same test fails on "nothing more to do". Drop the bridging sentence and it
 * fails on "not part of that figure", which is the one clause that keeps the
 * figure on screen from reading as the amount under review. Invent an amount for
 * the change and "names ONLY the amount it has already received" fails on the
 * count.
 */
describe("a stay change that saved while its money is still being worked out (#3033)", () => {
  const REVIEW = {
    club: CLUB,
    booking: booking({ status: "PAID" }),
    events: [
      event(BookingEventType.MEMBER_PAID, "2026-07-02T00:00:00.000Z", {
        amountCents: 12000,
      }),
    ],
    financialReviewPending: true,
  };

  /*
    THE STANDALONE REVIEW NARRATIVE, on a booking that is neither payable nor
    paid.

    Since #3194 the payable and paid branches COMPOSE the review sentences onto
    their own, so the standalone wording - where D1's four rules are stated in
    full and where "no amount appears at all" is absolute - is what a DRAFT,
    WAITLISTED or WAITLIST_OFFERED booking reaches. This fixture keeps those
    rules pinned to the function they govern rather than to whichever status
    happened to reach it.
  */
  const REVIEW_ALONE = {
    club: CLUB,
    booking: booking({ status: "WAITLISTED" }),
    events: [],
    financialReviewPending: true,
  };

  it("confirms the saved change first, and says the club is working the amount out", () => {
    const result = resolveBookingNarrative(REVIEW_ALONE);

    expect(result.state).toBe("financial_review_pending");
    expect(result.headline).toBe("Your booking change is saved");
    expect(result.message).toContain("has been saved");
    expect(result.message).toContain("1 Aug 2026 to 3 Aug 2026");
    expect(result.message).toMatch(/working out what that change means/i);
    expect(result.nextStep).toMatch(/nothing you need to do about that change/i);
  });

  it("names no amount at all — not a zero, not an estimate, not the new total", () => {
    // The structural edit has already updated `finalPriceCents`, so printing it
    // would put an authoritative-looking figure beside a sentence saying the
    // figure is unknown. `$` is asserted absent rather than a specific number,
    // so any amount reaching this copy trips it.
    const result = resolveBookingNarrative(REVIEW_ALONE);

    expect(result.message).not.toContain("$");
    expect(result.nextStep).not.toContain("$");
    // And no bare number of any kind, which is what an estimate would look
    // like with its currency symbol dropped. The stay dates render as
    // "1 Aug 2026", so digits DO legitimately appear — the assertion is over
    // the sentence with its date range removed.
    expect(result.message.replace("1 Aug 2026 to 3 Aug 2026", "")).not.toMatch(
      /[0-9]/,
    );
  });

  /*
    #3194: THE PAID BOOKING KEEPS THE ANSWER TO "DID MY PAYMENT GO THROUGH?"

    #3033 returned the standalone narrative here, which removed "nothing more to
    do" and, with it, the only sentence in the product that tells a member their
    money arrived. On the public payment link that narrative IS the page, so a
    member who paid by internet banking and opened the link to check got no
    answer about the payment at all.
  */
  it("confirms the payment it has received, and discloses the review beside it", () => {
    const result = resolveBookingNarrative(REVIEW);

    expect(result.state).toBe("financial_review_pending");
    expect(result.headline).toBe("Payment received");
    expect(result.message).toContain("we've received your payment of $120.00");
    expect(result.message).toContain("2 Jul 2026");
    expect(result.message).toContain("1 Aug 2026 to 3 Aug 2026");
    // Both halves in one message: the payment is confirmed, and the change's
    // amount is said to sit outside it.
    expect(result.message).toMatch(/not part of that figure/i);
    expect(result.message).toMatch(/working out what that change means/i);
    expect(result.message).toMatch(/nothing has been refunded or charged/i);
    // The next step is replaced rather than appended, because the paid one opens
    // with the sentence this issue is named after.
    expect(result.nextStep).not.toMatch(/nothing more to do/i);
    expect(result.nextStep).toContain(
      "There is nothing you need to do about that change.",
    );
    expect(result.nextStep).toContain(
      "We'll be in touch once the amount is confirmed.",
    );
  });

  it("names ONLY the amount it has already received, never one for the change", () => {
    // The $120.00 that appears is money the club HAS, read off a durable payment
    // event - not the post-edit total the standalone narrative refuses, and not
    // a guess at the adjustment. Exactly one figure, so a second one appearing
    // trips this.
    const result = resolveBookingNarrative(REVIEW);

    expect(result.message.match(/\$/g)).toHaveLength(1);
    expect(result.message).not.toMatch(/\$0\.00/);
    expect(result.nextStep).not.toContain("$");
  });

  it("still confirms a stay that needed no payment, and still discloses the review", () => {
    // The other arm of the paid narrative: no payment event, so no figure. The
    // stay confirmation survives, and the review sentences are what warn the
    // member that an amount is nonetheless coming.
    const result = resolveBookingNarrative({
      club: CLUB,
      booking: booking({ status: "PAID" }),
      events: [],
      financialReviewPending: true,
    });

    expect(result.headline).toBe("Booking confirmed");
    expect(result.message).toContain("No payment was required.");
    expect(result.message).toMatch(/working out what that change means/i);
    expect(result.message).not.toContain("$");
    expect(result.nextStep).not.toMatch(/nothing more to do/i);
  });

  it("composes onto a COMPLETED booking too, not only a PAID one", () => {
    const result = resolveBookingNarrative({
      ...REVIEW,
      booking: booking({ status: "COMPLETED" }),
    });

    expect(result.state).toBe("financial_review_pending");
    expect(result.message).toContain("we've received your payment of $120.00");
    expect(result.nextStep).not.toMatch(/nothing more to do/i);
  });

  it("CONTROL: the same PAID booking with no review keeps its own narrative whole", () => {
    const result = resolveBookingNarrative({
      ...REVIEW,
      financialReviewPending: false,
    });

    expect(result.state).toBe("paid");
    expect(result.message).toContain("we've received your payment of $120.00");
    expect(result.message).not.toMatch(/not part of that figure/i);
    expect(result.nextStep).toMatch(/nothing more to do/i);
    expect(result.nextStep).toContain("from your bookings page");
  });

  it("says nothing has moved, and never that settlement is complete", () => {
    const result = resolveBookingNarrative(REVIEW);

    expect(result.message).toMatch(/nothing has been refunded or charged/i);
    expect(result.message).not.toMatch(/refunded to you|has been credited|processed/i);
  });

  it("uses no internal vocabulary and blames nobody", () => {
    // #3033 forbids corruption terminology and blaming the member. The evidence
    // vocabulary stays on the admin screen.
    const result = resolveBookingNarrative(REVIEW);
    const copy = `${result.headline} ${result.message} ${result.nextStep}`;

    expect(copy).not.toMatch(
      /corrupt|mismatch|inconsistent|invalid|error|missing|your data|you did/i,
    );
    expect(copy).not.toMatch(/NO_STORED_NIGHT_PRICES|STORED_TOTAL_MISMATCH/);
  });

  it("does not collide with the admin approval queue's own state", () => {
    // `under_review` already means "an officer has not allowed this booking
    // yet", which is a different and more alarming claim than the true one.
    const result = resolveBookingNarrative(REVIEW);
    const approval = resolveBookingNarrative({
      club: CLUB,
      booking: booking({ status: "AWAITING_REVIEW" }),
      events: [],
    });

    expect(approval.state).toBe("under_review");
    expect(result.state).not.toBe(approval.state);
  });

  it("outranks the paid narrative, whose next step is the false reassurance", () => {
    const paid = resolveBookingNarrative({ ...REVIEW, financialReviewPending: false });

    expect(paid.state).toBe("paid");
    expect(paid.nextStep).toMatch(/nothing more to do/i);
    expect(resolveBookingNarrative(REVIEW).nextStep).not.toMatch(
      /nothing more to do/i,
    );
  });

  it("does not outrank a cancellation, which is the more important truth", () => {
    // The review wording assumes a stay that is still going ahead. A cancelled
    // booking keeps its own narrative even while money is unresolved.
    const result = resolveBookingNarrative({
      club: CLUB,
      booking: booking({ status: "CANCELLED" }),
      events: [event(BookingEventType.CANCELLED, "2026-07-05T00:00:00.000Z")],
      financialReviewPending: true,
    });

    expect(result.state).toBe("cancelled_pre_payment");
  });

  it("does not tell an unpaid booking there is nothing to do (#3033 B2)", () => {
    /*
      THE CONTRADICTION THIS BRANCH USED TO PRODUCE. `PAYABLE_STATUSES` covers
      CONFIRMED, and a CONFIRMED-unpaid booking renders the member's Complete
      Payment card — so returning the review narrative outright put "there is
      nothing you need to do" directly beside a card asking for money. Both
      facts are true, so both are said.
    */
    const result = resolveBookingNarrative({
      club: CLUB,
      booking: booking({ status: "CONFIRMED" }),
      events: [],
      financialReviewPending: true,
    });

    expect(result.state).toBe("financial_review_pending");
    // The payment facts survive intact — the amount due and the instruction to
    // pay it, which is what the Complete Payment card beside this banner is for.
    expect(result.message).toContain("$120.00 is due");
    expect(result.nextStep).toMatch(/pay by card or internet banking/i);
    // And the review facts are added rather than substituted.
    expect(result.message).toMatch(/working out what that change means/i);
    /*
      #3194 fix round: the STALE-amount sentence, not "not part of that figure".
      The "$120.00 is due" above it is `booking.finalPriceCents`, which a parked
      edit writes back UNCHANGED while saving the new dates - so it is the price
      from before this member's change, and saying only that the change's amount
      sits outside it would leave them believing the rest of it is settled.
    */
    expect(result.message).toMatch(/does not yet reflect the change you made/i);
    expect(result.message).not.toMatch(/not part of that figure/i);
    // The narrowed sentence: scoped to the change, so it cannot cancel the
    // instruction to pay sitting in the same next step.
    expect(result.nextStep).toContain(
      "There is nothing you need to do about that change.",
    );
    expect(result.nextStep).not.toMatch(
      /there is nothing you need to do\.|there's nothing you need to do\./i,
    );
  });

  it("keeps the payable composition for every payable status", () => {
    // PENDING, PAYMENT_PENDING and CONFIRMED are all payable; the last two also
    // render the Complete Payment card. None may be told to do nothing.
    for (const status of ["PENDING", "PAYMENT_PENDING", "CONFIRMED"] as const) {
      const result = resolveBookingNarrative({
        club: CLUB,
        booking: booking({ status }),
        events: [],
        financialReviewPending: true,
      });

      expect(result.state).toBe("financial_review_pending");
      expect(result.message).toContain("$120.00 is due");
      expect(result.nextStep).toMatch(/pay by card or internet banking/i);
    }
  });

  it("keeps the expired-link wording when a payable booking has a review", () => {
    // The composition wraps whatever the payable builder produced, so a dead
    // link still offers a fresh one rather than being flattened to "pay below".
    const result = resolveBookingNarrative({
      club: CLUB,
      booking: booking({ status: "CONFIRMED" }),
      events: [],
      link: {
        revokedAt: null,
        usedAt: null,
        expiresAt: new Date("2026-06-01T00:00:00.000Z"),
      },
      financialReviewPending: true,
    });

    expect(result.headline).toBe("Payment link expired");
    expect(result.nextStep).toMatch(/request a fresh payment link/i);
    expect(result.message).toMatch(/working out what that change means/i);
  });

  it("still names no amount for the review half of a payable booking", () => {
    // The $120.00 that appears is the booking's OWN price, which is due and is
    // real. No second figure is invented for the adjustment.
    const result = resolveBookingNarrative({
      club: CLUB,
      booking: booking({ status: "CONFIRMED" }),
      events: [],
      financialReviewPending: true,
    });

    expect(result.message.match(/\$/g)).toHaveLength(1);
    expect(result.message).not.toMatch(/\$0\.00/);
  });

  it("says nothing about review unless the caller says so", () => {
    // Defaulted false: a caller that has not checked must not make a claim about
    // this member's money.
    const result = resolveBookingNarrative({
      club: CLUB,
      booking: booking({ status: "PAID" }),
      events: [
        event(BookingEventType.MEMBER_PAID, "2026-07-02T00:00:00.000Z", {
          amountCents: 12000,
        }),
      ],
    });

    expect(result.state).toBe("paid");
  });
});
