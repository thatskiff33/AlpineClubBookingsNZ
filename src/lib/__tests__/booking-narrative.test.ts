import { describe, expect, it } from "vitest";
import { BookingEventType, BookingStatus } from "@prisma/client";
import {
  resolveBookingNarrative,
  type NarrativeBooking,
  type NarrativeEvent,
} from "@/lib/booking-narrative";
import { CAPACITY_RACE_REFUND_EVENT_REASON } from "@/lib/cancel-card-refund-event-reason";
import { DUPLICATE_CAPTURE_REFUND_EVENT_KIND } from "@/lib/duplicate-capture-refund-event";
import { editRefundHandBackCompletedSnapshot } from "@/lib/manual-refund-task-settlement-rules";
import { bindClubTime, requireClubTimeZone } from "@/lib/club-time";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

/**
 * The club's binding, supplied the way both real callers supply it (#3123). It
 * governs the real instants this resolver renders and nothing else: the stay
 * dates below are `@db.Date` lodge nights and take no zone.
 * `club-time-authority.test.ts` beside this file is where the two are pulled
 * apart under a club zone the environment does not hold.
 */
const CLUB = bindClubTime(requireClubTimeZone("Pacific/Auckland"), CLUB_FORMAT_TEST);

const CHECK_IN = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-03T00:00:00.000Z");

function booking(overrides: Partial<NarrativeBooking> = {}): NarrativeBooking {
  return {
    status: "PENDING",
    finalPriceCents: 12000,
    amountOwed: { owedCents: 12000, dueCents: 12000, appliedCreditCents: 0 },
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
    }, CLUB_FORMAT_TEST);

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
    }, CLUB_FORMAT_TEST);

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
    }, CLUB_FORMAT_TEST);

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
    }, CLUB_FORMAT_TEST);

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
    }, CLUB_FORMAT_TEST);

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
    }, CLUB_FORMAT_TEST);

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
    }, CLUB_FORMAT_TEST);

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
    }, CLUB_FORMAT_TEST);

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
    }, CLUB_FORMAT_TEST);

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
          // As the cancel's close writes it (`cancelCardRefundEventReason`, #4145).
          reason: "75% refunded to the original payment method.",
        }),
      ],
    }, CLUB_FORMAT_TEST);

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
    }, CLUB_FORMAT_TEST);

    expect(result.state).toBe("cancelled_post_payment");
    expect(result.message).toBe(
      "You cancelled this booking on 5 May 2026 after paying $120.00 on 2 May 2026. Under the cancellation policy in effect at the time, no refund was due and the full $120.00 was retained. No further payment is required."
    );
    // The duplicate-capture refund amount/date never leaks into the narrative.
    expect(result.message).not.toContain("$50.00");
    expect(result.message).not.toContain("3 May 2026");
    expect(result.message).not.toContain("was refunded");
  });

  it("EXCLUDES an edit refund sent back by hand from a later cancellation's settlement (#3827, INV-PAY-117)", () => {
    // An edit lowered the live booking by $30 and the treasurer sent that back
    // by bank transfer (a REFUNDED event marked as the edit task's completion);
    // the member later cancelled under a no-refund policy. The narrative must
    // describe the cancellation from its own snapshot, never the edit's refund.
    const result = resolveBookingNarrative({
      club: CLUB,
      booking: booking({ status: "CANCELLED" }),
      events: [
        event(BookingEventType.MEMBER_PAID, "2026-05-02T00:00:00.000Z", { amountCents: 12000 }),
        event(BookingEventType.REFUNDED, "2026-05-03T00:00:00.000Z", {
          amountCents: 3000,
          reason: "manual_refund_completed",
          snapshot: editRefundHandBackCompletedSnapshot("task-1"),
        }),
        event(BookingEventType.CANCELLED, "2026-05-05T00:00:00.000Z", {
          amountCents: 9000,
          snapshot: {
            policySummary: "Cancelled inside the no-refund window under the policy in effect at the time.",
            refundMethod: "card",
            refundPercentage: 0,
            paidAmountCents: 9000,
            settledAmountCents: 0,
            retainedAmountCents: 9000,
            changeFeeCents: 0,
          },
        }),
      ],
    }, CLUB_FORMAT_TEST);

    expect(result.state).toBe("cancelled_post_payment");
    expect(result.message).not.toContain("$30.00");
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
    }, CLUB_FORMAT_TEST);

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
    }, CLUB_FORMAT_TEST);

    expect(result.state).toBe("cancelled_post_payment");
    expect(result.message).toContain("no refund was due and the full $120.00 was retained");
  });

  // #4125: the capacity race's CANCELLED event is written before its card
  // refund is attempted; while no REFUNDED event follows (it threw, or Stripe
  // refused it, and the recovery row is retrying), the member is told it is on
  // its way - never "refunded", never "no refund was due".
  it("a card refund not yet made reads as on its way, not refunded and not 'no refund was due' (#4125)", () => {
    const cancelled = event(BookingEventType.CANCELLED, "2026-05-05T00:00:00.000Z", {
      amountCents: 12000,
      snapshot: {
        policySummary: "These dates were no longer available when payment completed, so the full amount is being refunded.",
        refundMethod: "card",
        cancelledBecause: "capacity_race",
        refundPercentage: 100,
        paidAmountCents: 12000,
        settledAmountCents: 12000,
        retainedAmountCents: 0,
      },
    });
    const paid = event(BookingEventType.MEMBER_PAID, "2026-05-02T00:00:00.000Z", { amountCents: 12000 });
    const pending = resolveBookingNarrative({ club: CLUB, booking: booking({ status: "CANCELLED" }), events: [paid, cancelled] }, CLUB_FORMAT_TEST);
    expect(pending.message).toContain("$120.00 is on its way to your original payment method.");
    // The system cancelled it, so the member is never told they did.
    expect(pending.message).toMatch(/^This booking was cancelled on 5 May 2026, after you paid \$120\.00 on 2 May 2026, because the dates filled up while your payment was going through\./);
    expect(pending.message).not.toContain("You cancelled");
    expect(pending.message).not.toContain("was refunded");
    expect(pending.message).not.toContain("no refund was due");

    const made = resolveBookingNarrative({
      club: CLUB,
      booking: booking({ status: "CANCELLED" }),
      events: [paid, cancelled, event(BookingEventType.REFUNDED, "2026-05-05T00:00:00.000Z", { amountCents: 12000 })],
    }, CLUB_FORMAT_TEST);
    expect(made.message).toContain("$120.00 was refunded on 5 May 2026");

    // No cancellation policy decided it: the whole charge goes back, so no policy is named.
    expect(pending.message).toBe(
      "This booking was cancelled on 5 May 2026, after you paid $120.00 on 2 May 2026, because the dates filled up while your payment was going through. $120.00 is on its way to your original payment method. No further payment is required.",
    );
    expect(made.message).toBe(
      "This booking was cancelled on 5 May 2026, after you paid $120.00 on 2 May 2026, because the dates filled up while your payment was going through. $120.00 was refunded on 5 May 2026. No further payment is required.",
    );
    expect(made.message).not.toContain("cancellation policy");
  });

  // #4125: the capacity race's settle cancels instead of recording MEMBER_PAID,
  // and its plan refunds what the payment ledger shows refundable - which can
  // be less than the charge. The paid fact comes from the CANCELLED snapshot,
  // and the part no refund covers is the club's to follow up.
  describe("a capacity-race cancel, as its settle writes it (#4125)", () => {
    function raceCancel(settledAmountCents: number) {
      return event(BookingEventType.CANCELLED, "2026-05-05T00:00:00.000Z", {
        amountCents: 10000,
        snapshot: { policySummary: "x", refundMethod: "card", cancelledBecause: "capacity_race", refundPercentage: 100, paidAmountCents: 10000, settledAmountCents, retainedAmountCents: 0 },
      });
    }
    const narrate = (events: NarrativeEvent[], cardRefundState?: "on-its-way" | "stalled") =>
      resolveBookingNarrative({ club: CLUB, booking: booking({ status: "CANCELLED" }), events, cardRefundState }, CLUB_FORMAT_TEST).message;
    const OPENING = "This booking was cancelled on 5 May 2026, after you paid $100.00 on 5 May 2026, because the dates filled up while your payment was going through.";

    it("with no MEMBER_PAID event, opens with the payment the snapshot froze - never 'no payment had been taken'", () => {
      expect(narrate([raceCancel(10000)])).toBe(`${OPENING} $100.00 is on its way to your original payment method. No further payment is required.`);
    });

    it.each([
      ["refunded", [raceCancel(8000), event(BookingEventType.REFUNDED, "2026-05-05T00:00:00.000Z", { amountCents: 8000 })], undefined, "$80.00 was refunded on 5 May 2026; the club will be in touch about the remaining $20.00."],
      ["on its way", [raceCancel(8000)], "on-its-way", "$80.00 is on its way to your original payment method; the club will be in touch about the remaining $20.00."],
      ["stalled", [raceCancel(8000)], "stalled", "$80.00 is being refunded to you; the club will be in touch about the card refund and the remaining $20.00."],
    ] as const)("MUTATION: a refund short of the charge, %s, names the rest", (_label, events, state, clause) => {
      expect(narrate([...events], state)).toBe(`${OPENING} ${clause} No further payment is required.`);
    });

    it("shares the card clause only for the automatic refund's own events (#4178)", () => {
      const cardRefund = event(BookingEventType.REFUNDED, "2026-05-05T00:00:00.000Z", {
        amountCents: 8000, reason: CAPACITY_RACE_REFUND_EVENT_REASON,
      });
      expect(narrate([raceCancel(8000), cardRefund])).toBe(
        `${OPENING} $80.00 was refunded to your card on 5 May 2026; the club will be in touch about the remaining $20.00. No further payment is required.`,
      );
      const bankRefund = event(BookingEventType.REFUNDED, "2026-05-20T00:00:00.000Z", {
        amountCents: 2000, reason: "Capacity-race shortfall paid by bank transfer.",
      });
      const mixed = narrate([raceCancel(8000), cardRefund, bankRefund]);
      expect(mixed).toBe(`${OPENING} $100.00 was refunded on 20 May 2026. No further payment is required.`);
      expect(mixed).not.toContain("to your card");
      const bankOnly = narrate([raceCancel(0), { ...bankRefund, amountCents: 10000 }]);
      expect(bankOnly).toBe(`${OPENING} $100.00 was refunded on 20 May 2026. No further payment is required.`);
      expect(bankOnly).not.toContain("to your card");
    });

    // An empty plan refunds nothing by card: never "no refund was due", only what the club follows up.
    it.each([
      ["on its way", "on-its-way"],
      ["stalled", "stalled"],
      ["unread", undefined],
    ] as const)("MUTATION: an empty plan (%s) says the club will be in touch about the whole charge", (_label, state) => {
      const message = narrate([raceCancel(0)], state);
      expect(message).toBe(`${OPENING} The club will be in touch about the $100.00. No further payment is required.`);
      expect(message).not.toContain("no refund was due");
    });

    // The club pays the rest later: every settlement event counts, so the follow-up line goes.
    it("MUTATION: a later refund covering the rest removes the follow-up line", () => {
      const events = [
        raceCancel(8000),
        event(BookingEventType.REFUNDED, "2026-05-05T00:00:00.000Z", { amountCents: 8000 }),
        event(BookingEventType.REFUNDED, "2026-05-20T00:00:00.000Z", { amountCents: 2000 }),
      ];
      expect(narrate(events)).toBe(`${OPENING} $100.00 was refunded on 20 May 2026. No further payment is required.`);
    });

    // #4154 (`INV-PAY-135`): the rest is a task to check (#4097's `check` part), read live.
    describe("its task to check (#4154)", () => {
      const withTask = (events: NarrativeEvent[], check: "OPEN" | "COMPLETED" | "DISMISSED", cardRefundState?: "on-its-way" | "stalled") =>
        resolveBookingNarrative({ club: CLUB, booking: booking({ status: "CANCELLED" }), events, cardRefundState, cardShortfallStatuses: { check } }, CLUB_FORMAT_TEST).message;
      const refunded = event(BookingEventType.REFUNDED, "2026-05-05T00:00:00.000Z", { amountCents: 8000 });

      it("still OPEN: the club will be in touch about the rest", () => {
        expect(withTask([raceCancel(8000), refunded], "OPEN")).toBe(`${OPENING} $80.00 was refunded on 5 May 2026; the club will be in touch about the remaining $20.00. No further payment is required.`);
      });

      it.each([
        ["after a refund made", [raceCancel(8000), refunded], undefined, "$80.00 was refunded on 5 May 2026 and the club checked the remaining $20.00 and closed it."],
        ["with the card refund stalled", [raceCancel(8000)], "stalled", "$80.00 is being refunded to you and the club checked the remaining $20.00 and closed it; the club will be in touch about the card refund."],
        ["after an empty plan", [raceCancel(0)], undefined, "The club checked the $100.00 and closed it."],
      ] as const)("MUTATION: dismissed %s, says the club checked it and closed it - never that it will be in touch", (_label, events, state, clause) => {
        const message = withTask([...events], "DISMISSED", state);
        expect(message).toBe(`${OPENING} ${clause} No further payment is required.`);
        expect(message).not.toContain("in touch about the remaining");
      });

      it("paid back: its REFUNDED event counts, so the whole charge reads refunded", () => {
        const paidBack = event(BookingEventType.REFUNDED, "2026-05-20T00:00:00.000Z", { amountCents: 2000, reason: "manual_refund_completed" });
        expect(withTask([raceCancel(8000), refunded, paidBack], "COMPLETED")).toBe(`${OPENING} $100.00 was refunded on 20 May 2026. No further payment is required.`);
      });
    });

    it("a refund recorded twice never reads as more than was paid", () => {
      const events = [
        raceCancel(10000),
        event(BookingEventType.REFUNDED, "2026-05-05T00:00:00.000Z", { amountCents: 10000 }),
        event(BookingEventType.REFUNDED, "2026-05-06T00:00:00.000Z", { amountCents: 10000 }),
      ];
      expect(narrate(events)).toBe(`${OPENING} $100.00 was refunded on 6 May 2026. No further payment is required.`);
    });
  });

  // #4125: a card cancel's refund with no REFUNDED event says where its
  // recovery row stands (`readCancelledCardRefundState`), with what was kept.
  describe("a card refund with no REFUNDED event, by its recovery row (#4125)", () => {
    function cardCancel(retainedAmountCents: number) {
      return [
        event(BookingEventType.MEMBER_PAID, "2026-05-02T00:00:00.000Z", { amountCents: 12000 }),
        event(BookingEventType.CANCELLED, "2026-05-05T00:00:00.000Z", {
          snapshot: {
            policySummary: "partial",
            refundMethod: "card",
            refundPercentage: 75,
            paidAmountCents: 12000,
            settledAmountCents: 12000 - retainedAmountCents,
            retainedAmountCents,
          },
        }),
      ];
    }
    const narrate = (retained: number, cardRefundState?: "on-its-way" | "stalled" | "settled" | "paid-another-way") =>
      resolveBookingNarrative({ club: CLUB, booking: booking({ status: "CANCELLED" }), events: cardCancel(retained), cardRefundState }, CLUB_FORMAT_TEST).message;

    it.each([
      ["on its way (no row read)", undefined, 0, "the time, $120.00 is on its way to your original payment method. No further"],
      ["on its way, with a part retained", "on-its-way", 3000, "the time, $90.00 is on its way to your original payment method and $30.00 was retained. No further"],
      ["stalled", "stalled", 0, "the time, $120.00 is being refunded to you; the club will be in touch about the card refund. No further"],
      ["stalled, with a part retained", "stalled", 3000, "the time, $90.00 is being refunded to you and $30.00 was retained; the club will be in touch about the card refund. No further"],
      ["made by the runner before it recorded", "settled", 3000, "the time, $90.00 was refunded to your card and $30.00 was retained. No further"],
      ["closed as paid another way", "paid-another-way", 0, "the time, $120.00 could not go back to your card and was paid back to you another way. No further"],
    ] as const)("%s", (_label, state, retained, expected) => {
      const message = narrate(retained, state);
      expect(message).toContain(expected);
      expect(message).not.toContain("no refund was due");
    });

    it("a stalled refund never says it is on its way", () => {
      expect(narrate(0, "stalled")).not.toContain("on its way");
    });

    // A joiner's booking the group organiser paid for by card is refunded to the
    // ORGANISER's card. Its settle writes MEMBER_PAID with no amount
    // (`group-settlement.ts`), so it never reaches the card branch: it is never
    // told the refund goes back to "your" payment method.
    it("never tells an organiser-paid joiner the refund goes to their own payment method", () => {
      const message = resolveBookingNarrative({
        club: CLUB,
        booking: booking({ status: "CANCELLED" }),
        events: [
          event(BookingEventType.MEMBER_PAID, "2026-05-02T00:00:00.000Z", { reason: "Settled by the group organiser as part of the combined group bill" }),
          cardCancel(0)[1]!,
        ],
        cardRefundState: "on-its-way",
      }, CLUB_FORMAT_TEST).message;
      expect(message).not.toContain("your original payment method");
      expect(message).not.toContain("your card");
    });
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
    }, CLUB_FORMAT_TEST);

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
    }, CLUB_FORMAT_TEST);

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
    }, CLUB_FORMAT_TEST);
    const adminView = resolveBookingNarrative({
      club: CLUB,
      booking: cancelledBooking,
      events,
    }, CLUB_FORMAT_TEST);

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
      const result = resolveBookingNarrative({ booking: b, events: [], club: CLUB }, CLUB_FORMAT_TEST);
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
      }, CLUB_FORMAT_TEST);
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
    const result = resolveBookingNarrative(REVIEW_ALONE, CLUB_FORMAT_TEST);

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
    const result = resolveBookingNarrative(REVIEW_ALONE, CLUB_FORMAT_TEST);

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
    const result = resolveBookingNarrative(REVIEW, CLUB_FORMAT_TEST);

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
    const result = resolveBookingNarrative(REVIEW, CLUB_FORMAT_TEST);

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
    }, CLUB_FORMAT_TEST);

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
    }, CLUB_FORMAT_TEST);

    expect(result.state).toBe("financial_review_pending");
    expect(result.message).toContain("we've received your payment of $120.00");
    expect(result.nextStep).not.toMatch(/nothing more to do/i);
  });

  it("CONTROL: the same PAID booking with no review keeps its own narrative whole", () => {
    const result = resolveBookingNarrative({
      ...REVIEW,
      financialReviewPending: false,
    }, CLUB_FORMAT_TEST);

    expect(result.state).toBe("paid");
    expect(result.message).toContain("we've received your payment of $120.00");
    expect(result.message).not.toMatch(/not part of that figure/i);
    expect(result.nextStep).toMatch(/nothing more to do/i);
    expect(result.nextStep).toContain("from your bookings page");
  });

  it("says nothing has moved, and never that settlement is complete", () => {
    const result = resolveBookingNarrative(REVIEW, CLUB_FORMAT_TEST);

    expect(result.message).toMatch(/nothing has been refunded or charged/i);
    expect(result.message).not.toMatch(/refunded to you|has been credited|processed/i);
  });

  it("uses no internal vocabulary and blames nobody", () => {
    // #3033 forbids corruption terminology and blaming the member. The evidence
    // vocabulary stays on the admin screen.
    const result = resolveBookingNarrative(REVIEW, CLUB_FORMAT_TEST);
    const copy = `${result.headline} ${result.message} ${result.nextStep}`;

    expect(copy).not.toMatch(
      /corrupt|mismatch|inconsistent|invalid|error|missing|your data|you did/i,
    );
    expect(copy).not.toMatch(/NO_STORED_NIGHT_PRICES|STORED_TOTAL_MISMATCH/);
  });

  it("does not collide with the admin approval queue's own state", () => {
    // `under_review` already means "an officer has not allowed this booking
    // yet", which is a different and more alarming claim than the true one.
    const result = resolveBookingNarrative(REVIEW, CLUB_FORMAT_TEST);
    const approval = resolveBookingNarrative({
      club: CLUB,
      booking: booking({ status: "AWAITING_REVIEW" }),
      events: [],
    }, CLUB_FORMAT_TEST);

    expect(approval.state).toBe("under_review");
    expect(result.state).not.toBe(approval.state);
  });

  it("outranks the paid narrative, whose next step is the false reassurance", () => {
    const paid = resolveBookingNarrative({ ...REVIEW, financialReviewPending: false }, CLUB_FORMAT_TEST);

    expect(paid.state).toBe("paid");
    expect(paid.nextStep).toMatch(/nothing more to do/i);
    expect(resolveBookingNarrative(REVIEW, CLUB_FORMAT_TEST).nextStep).not.toMatch(
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
    }, CLUB_FORMAT_TEST);

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
    }, CLUB_FORMAT_TEST);

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
      }, CLUB_FORMAT_TEST);

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
    }, CLUB_FORMAT_TEST);

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
    }, CLUB_FORMAT_TEST);

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
    }, CLUB_FORMAT_TEST);

    expect(result.state).toBe("paid");
  });
});

/*
  #3991: `ownerCreditHidden` — the viewer cannot see the booking owner's account
  credit (a linked guest on the booking page). The narrative then names no
  credit; the figures the viewer already sees (what was paid, what was retained)
  stay.
*/
describe("resolveBookingNarrative with the owner's credit hidden (#3991)", () => {
  const cancelledToCredit = (creditedCents: number) => [
    event(BookingEventType.MEMBER_PAID, "2026-05-02T00:00:00.000Z", { amountCents: 12000 }),
    event(BookingEventType.CANCELLED, "2026-05-05T00:00:00.000Z"),
    event(BookingEventType.CREDITED, "2026-05-06T00:00:00.000Z", { amountCents: creditedCents }),
  ];
  const resolve = (events: NarrativeEvent[], ownerCreditHidden?: boolean, b = booking({ status: "CANCELLED" })) =>
    resolveBookingNarrative({ club: CLUB, booking: b, events, ownerCreditHidden }, CLUB_FORMAT_TEST);

  it("CONTROL: a cancellation settled as credit names the credit to the owner", () => {
    const result = resolve(cancelledToCredit(9000));
    expect(result.message).toContain("$90.00 was added to your account credit on 6 May 2026 and $30.00 was retained");
  });

  it("drops the credit clause and keeps what was retained", () => {
    const result = resolve(cancelledToCredit(9000), true);
    expect(result.state).toBe("cancelled_post_payment");
    expect(result.message).not.toMatch(/credit/i);
    expect(result.message).not.toContain("$90.00");
    expect(result.message).toContain("after paying $120.00");
    expect(result.message).toContain("$30.00 was retained");
  });

  it("says nothing was retained when the whole payment went to credit", () => {
    const result = resolve(cancelledToCredit(12000), true);
    expect(result.message).not.toMatch(/credit/i);
    expect(result.message).toContain("nothing was retained");
  });

  it("leaves a card refund's wording alone", () => {
    const refunded = [
      event(BookingEventType.MEMBER_PAID, "2026-05-02T00:00:00.000Z", { amountCents: 12000 }),
      event(BookingEventType.CANCELLED, "2026-05-05T00:00:00.000Z"),
      event(BookingEventType.REFUNDED, "2026-05-06T00:00:00.000Z", { amountCents: 9000 }),
    ];
    expect(resolve(refunded, true).message).toBe(resolve(refunded).message);
  });

  it("says a credit-covered booking has nothing to pay without naming the credit", () => {
    const covered = booking({ status: "PENDING", amountOwed: { owedCents: -3000, dueCents: 0, appliedCreditCents: 15000 } });
    expect(resolve([], false, covered).message).toMatch(/credit/);
    const hidden = resolve([], true, covered);
    expect(hidden.state).toBe("nothing_to_pay");
    expect(hidden.message).not.toMatch(/credit/i);
  });
});
