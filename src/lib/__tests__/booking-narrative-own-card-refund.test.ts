import { describe, expect, it } from "vitest";
import { BookingEventType } from "@prisma/client";

import { resolveBookingNarrative, type NarrativeBooking, type NarrativeEvent } from "@/lib/booking-narrative";
import type { CardRefundState, CardShortfallTaskStatuses } from "@/lib/manual-refund-task-settlement-rules";
import { CAPACITY_RACE_REFUND_EVENT_REASON } from "@/lib/booking-events";
import type { PaidAnotherWayClose } from "@/lib/booking-narrative-cancelled-post-payment";
import { cancelCardRefundEventReason, MADE_BEFORE_PAID_ANOTHER_WAY_SNAPSHOT } from "@/lib/cancel-card-refund-event-reason";
import { bindClubTime, requireClubTimeZone } from "@/lib/club-time";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

/**
 * #4145 (`INV-PAY-134`): the booking page's narrative for a member's card
 * cancel, whose REFUNDED event is written only by the close that made the
 * refund. The cancel's settlement is its OWN card refund event
 * (`isCancelCardRefundEvent`) - never another event that landed after the
 * cancel - and where none exists yet, or the row is still open or was paid
 * another way, the row says where the refund stands.
 *
 * MUTATION PROOF. Take the first settlement event again for a member's card
 * cancel and the edit-review cases read the review's credit or refund as the
 * cancellation's; drop the split and the paid-another-way part case says the
 * card took none of it; split on any card event, not only the one the close
 * marked, and an up-front event a cancel wrote before #4145 is read as the card
 * part; take the rest as paid back in full and a part payback reads as all of it;
 * say "closed" for anything but what the close's record left unpaid and a capped
 * close or the card's inline part is told as written off.
 */
const CLUB = bindClubTime(requireClubTimeZone("Pacific/Auckland"), CLUB_FORMAT_TEST);

const BOOKING: NarrativeBooking = {
  status: "CANCELLED",
  finalPriceCents: 12000,
  amountOwed: { owedCents: 0, dueCents: 0, appliedCreditCents: 0 },
  checkIn: new Date("2026-08-01T00:00:00.000Z"),
  checkOut: new Date("2026-08-03T00:00:00.000Z"),
  firstName: "Sam",
  adminReviewStatus: null,
  adminReviewNotes: null,
  adminReviewReason: null,
};

function event(type: BookingEventType, occurredAt: string, extra: Partial<NarrativeEvent> = {}): NarrativeEvent {
  return { type, occurredAt: new Date(occurredAt), amountCents: null, reason: null, snapshot: null, ...extra };
}

const PAID = event(BookingEventType.MEMBER_PAID, "2026-05-02T00:00:00.000Z", { amountCents: 12000 });

function cancelled(extra: Record<string, unknown> = {}): NarrativeEvent {
  return event(BookingEventType.CANCELLED, "2026-05-05T00:00:00.000Z", {
    amountCents: 12000,
    snapshot: {
      policySummary: "Cancelled 30 day(s) before check-in: 75% card refund under the policy in effect at the time.",
      refundMethod: "card",
      refundPercentage: 75,
      paidAmountCents: 12000,
      settledAmountCents: 9000,
      retainedAmountCents: 3000,
      changeFeeCents: 0,
      ...extra,
    },
  });
}

/**
 * The cancel's card refund event, as the close that made it writes it - or, `made`,
 * as a "Paid another way" close writes it for the slices Stripe had made first.
 */
function cardRefunded(occurredAt: string, cents: number, made = false): NarrativeEvent {
  return event(BookingEventType.REFUNDED, occurredAt, {
    amountCents: cents,
    reason: cancelCardRefundEventReason({ cardRefundCents: cents, policy: { refundPercentage: 75, refundAmountCents: 9000 }, shortfall: made, format: CLUB_FORMAT_TEST }),
    snapshot: made ? { ...MADE_BEFORE_PAID_ANOTHER_WAY_SNAPSHOT } : null,
  });
}

/** An edit financial review completed after the cancel, settling the edit's own money. */
const REVIEW_CREDITED = event(BookingEventType.CREDITED, "2026-05-07T00:00:00.000Z", { amountCents: 2500, reason: "edit_financial_review_credited" });
const REVIEW_REFUNDED = event(BookingEventType.REFUNDED, "2026-05-07T00:00:00.000Z", { amountCents: 2500, reason: "edit_financial_review_completed" });

function narrate(events: NarrativeEvent[], cardRefundState?: CardRefundState, cardShortfallStatuses: CardShortfallTaskStatuses = {}, cardRefundClose?: PaidAnotherWayClose): string {
  return resolveBookingNarrative({ club: CLUB, booking: BOOKING, events: [PAID, ...events], cardRefundState, cardShortfallStatuses, cardRefundClose }, CLUB_FORMAT_TEST).message;
}

/**
 * A "Paid another way" close as the page reads it: what the officer paid back,
 * what the close left unpaid, and what the row's slices took from its refunds.
 */
function closed(paidBackCents: number, { unpaid = 0, made = 0 }: { unpaid?: number; made?: number } = {}): PaidAnotherWayClose {
  return { paidBackCents, unpaidCents: unpaid, madeCents: made };
}

const LEAD = "You cancelled this booking on 5 May 2026 after paying $120.00 on 2 May 2026. Under the cancellation policy in effect at the time, ";
const END = ". No further payment is required.";

describe("#4145: a member's card cancel is settled by its own card refund event", () => {
  it.each([
    ["credited", REVIEW_CREDITED],
    ["refunded", REVIEW_REFUNDED],
  ] as const)("MUTATION: an edit review %s after the cancel is never the cancellation's settlement - on its way until the runner's refund", (_label, review) => {
    expect(narrate([cancelled(), review], "on-its-way")).toBe(
      `${LEAD}$90.00 is on its way to your original payment method and $30.00 was retained${END}`,
    );
    // The runner's refund lands after the review: the cancellation's date is its own.
    expect(narrate([cancelled(), review, cardRefunded("2026-05-09T00:00:00.000Z", 9000)], "settled")).toBe(
      `${LEAD}$90.00 was refunded on 9 May 2026 and $30.00 was retained${END}`,
    );
  });

  it("MUTATION: a row paid another way after part went to the card says the two parts apart", () => {
    expect(narrate([cancelled(), cardRefunded("2026-05-05T01:00:00.000Z", 6000, true)], "paid-another-way", {}, closed(3000, { made: 6000 }))).toBe(
      `${LEAD}$60.00 was refunded to your card on 5 May 2026, $30.00 could not go back to your card and was paid back to you another way and $30.00 was retained${END}`,
    );
    // Nothing made: the whole refund was paid another way.
    expect(narrate([cancelled()], "paid-another-way")).toBe(
      `${LEAD}$90.00 could not go back to your card and was paid back to you another way and $30.00 was retained${END}`,
    );
  });

  it("a shortfall's card part paid another way after part went to the card says the two parts apart too", () => {
    const shortfall = cancelled({ settledAmountCents: 10000, retainedAmountCents: 2000, cardShortfall: { cardCents: 6000, bankCents: 4000, checkCents: 0 } });
    expect(narrate([shortfall, cardRefunded("2026-05-05T01:00:00.000Z", 2500, true)], undefined, { bank: "OPEN", card: "paid-another-way" }, closed(3500, { made: 2500 }))).toContain(
      "$25.00 was refunded to your card on 5 May 2026, $35.00 could not go back to your card and was paid back to you another way, $40.00 is being refunded to you by bank transfer",
    );
    // Paid back in part: the rest of the card part is the club's closed remainder, never "paid back".
    expect(narrate([shortfall, cardRefunded("2026-05-05T01:00:00.000Z", 2500, true)], undefined, { bank: "OPEN", card: "paid-another-way" }, closed(2000, { unpaid: 1500, made: 2500 }))).toContain(
      "$25.00 was refunded to your card on 5 May 2026, $20.00 could not go back to your card and was paid back to you another way, the club checked the remaining $15.00 and closed it, $40.00 is being refunded to you by bank transfer",
    );
  });

  it("MUTATION: an up-front event a cancel wrote before #4145 is not proof of the card part - the close's record says what the card took", () => {
    // The old cancel wrote $90.00 up front; $60.00 went inline, the last $30.00 died and was closed for $30.00.
    const upFront = cardRefunded("2026-05-05T00:00:00.000Z", 9000);
    expect(narrate([cancelled(), upFront], "paid-another-way", {}, closed(3000, { made: 6000 }))).toBe(
      `${LEAD}$60.00 was refunded to your card, $30.00 could not go back to your card and was paid back to you another way and $30.00 was retained${END}`,
    );
    // Closed for $20.00 of that $30.00: only the $10.00 the close left unpaid is the club's closed remainder.
    expect(narrate([cancelled(), upFront], "paid-another-way", {}, closed(2000, { unpaid: 1000, made: 6000 }))).toBe(
      `${LEAD}$60.00 was refunded to your card, $20.00 could not go back to your card and was paid back to you another way, the club checked the remaining $10.00 and closed it and $30.00 was retained${END}`,
    );
  });

  it("MUTATION: a close capped below its slices claims nothing for the part its payment no longer held - never closed, never refunded", () => {
    // $90.00 due, $30.00 made, the payment held only $10.00 more and the officer closed it in full for that.
    expect(narrate([cancelled(), cardRefunded("2026-05-06T00:00:00.000Z", 3000, true)], "paid-another-way", {}, closed(1000, { made: 3000 }))).toBe(
      `${LEAD}$30.00 was refunded to your card on 6 May 2026, $10.00 could not go back to your card and was paid back to you another way and $30.00 was retained${END}`,
    );
  });

  it("MUTATION F1: a capped close with nothing made says no card part - the part the payment no longer held is none of its parts", () => {
    // $90.00 due, nothing reached the card, the payment held $60.00 and the officer paid that back.
    const message = narrate([cancelled()], "paid-another-way", {}, closed(6000));
    expect(message).toBe(`${LEAD}$60.00 could not go back to your card and was paid back to you another way and $30.00 was retained${END}`);
    expect(message).not.toContain("refunded to your card");
  });

  it("MUTATION F1: a shortfall whose open check part capped the card's close tells that $20.00 once - as the check part, never as a card refund", () => {
    const shortfall = cancelled({ settledAmountCents: 8000, retainedAmountCents: 4000, cardShortfall: { cardCents: 6000, bankCents: 0, checkCents: 2000 } });
    const message = narrate([shortfall], undefined, { check: "OPEN", card: "paid-another-way" }, closed(4000));
    expect(message).toContain(
      "$40.00 could not go back to your card and was paid back to you another way, the club will be in touch about the remaining $20.00 and $40.00 was retained",
    );
    expect(message).not.toContain("refunded to your card");
  });

  it("MUTATION: a record's paid-back figure comes before the undated card part - $60.00 to the card and $30.00 paid back, never $70.00 and $20.00", () => {
    // $90.00 due, no event dates the card part; the slices' refunds took $70.00 (a refund recorded after the close
    // among them) and the close paid back $30.00.
    expect(narrate([cancelled()], "paid-another-way", {}, closed(3000, { made: 7000 }))).toBe(
      `${LEAD}$60.00 was refunded to your card, $30.00 could not go back to your card and was paid back to you another way and $30.00 was retained${END}`,
    );
  });

  describe("MUTATION: a capacity race from before #4125, its snapshot the full $120.00 charge, its rows' plans $90.00 and no event", () => {
    const raced = event(BookingEventType.CANCELLED, "2026-05-05T00:00:00.000Z", {
      amountCents: 12000,
      snapshot: { cancelledBecause: "capacity_race", refundMethod: "card", paidAmountCents: 12000, settledAmountCents: 12000, retainedAmountCents: 0, changeFeeCents: 0 },
    });
    const told = (cardRefundState: CardRefundState) =>
      resolveBookingNarrative({ club: CLUB, booking: BOOKING, events: [raced], cardRefundState, cardRefundPlanCents: 9000 }, CLUB_FORMAT_TEST).message;

    it.each([
      ["settled by the old runner, which wrote no event", "settled", "$90.00 was refunded to your card; the club will be in touch about the remaining $30.00."],
      ["stalled", "stalled", "$90.00 is being refunded to you; the club will be in touch about the card refund and the remaining $30.00."],
      ["still being sent", "on-its-way", "$90.00 is on its way to your original payment method; the club will be in touch about the remaining $30.00."],
    ] as const)("%s: tells the plan's $90.00, never the charge's $120.00, and follows up the rest", (_label, state, expected) => {
      const message = told(state);
      expect(message).toContain(expected);
      expect(message).not.toContain("$120.00 was refunded");
      expect(message).not.toContain("$120.00 is");
    });
  });

  it("MUTATION F2: a capacity race's row the runner made beside one paid another way is told too, dated by its own event", () => {
    const raced = event(BookingEventType.CANCELLED, "2026-05-05T00:00:00.000Z", {
      amountCents: 12000,
      snapshot: { cancelledBecause: "capacity_race", refundMethod: "card", paidAmountCents: 12000, settledAmountCents: 8000, retainedAmountCents: 0, changeFeeCents: 0 },
    });
    // Row A: the runner made its $30.00 on 6 May. Row B: closed paid another way for $50.00, nothing made.
    const rowA = event(BookingEventType.REFUNDED, "2026-05-06T00:00:00.000Z", { amountCents: 3000, reason: CAPACITY_RACE_REFUND_EVENT_REASON });
    const message = resolveBookingNarrative(
      { club: CLUB, booking: BOOKING, events: [raced, rowA], cardRefundState: "paid-another-way", cardRefundClose: closed(5000) },
      CLUB_FORMAT_TEST,
    ).message;
    expect(message).toContain(
      "$30.00 was refunded to your card on 6 May 2026 and $50.00 could not go back to your card and was paid back to you another way; the club will be in touch about the remaining $40.00.",
    );
  });

  it("MUTATION F3: a capacity race from before #4125, whose snapshot holds the full charge, says what its close recorded and follows up the rest", () => {
    const raced = event(BookingEventType.CANCELLED, "2026-05-05T00:00:00.000Z", {
      amountCents: 12000,
      snapshot: { cancelledBecause: "capacity_race", refundMethod: "card", paidAmountCents: 12000, settledAmountCents: 12000, retainedAmountCents: 0, changeFeeCents: 0 },
    });
    const message = resolveBookingNarrative(
      { club: CLUB, booking: BOOKING, events: [raced], cardRefundState: "paid-another-way", cardRefundClose: closed(9000) },
      CLUB_FORMAT_TEST,
    ).message;
    expect(message).toContain("$90.00 could not go back to your card and was paid back to you another way; the club will be in touch about the remaining $30.00.");
    expect(message).not.toContain("closed it");
    expect(message).not.toContain("refunded to your card");
  });

  it("MUTATION: $100.00 due, $30.00 made by card and $50.00 paid back by bank transfer - the other $20.00 is said as closed, never as paid back", () => {
    const due = cancelled({ settledAmountCents: 10000, retainedAmountCents: 2000 });
    expect(narrate([due, cardRefunded("2026-05-06T00:00:00.000Z", 3000, true)], "paid-another-way", {}, closed(5000, { unpaid: 2000, made: 3000 }))).toBe(
      `${LEAD}$30.00 was refunded to your card on 6 May 2026, $50.00 could not go back to your card and was paid back to you another way, the club checked the remaining $20.00 and closed it and $20.00 was retained${END}`,
    );
    // Nothing made, paid back in part.
    expect(narrate([due], "paid-another-way", {}, closed(7000, { unpaid: 3000 }))).toBe(
      `${LEAD}$70.00 could not go back to your card and was paid back to you another way, the club checked the remaining $30.00 and closed it and $20.00 was retained${END}`,
    );
    // A caller that read no figure (an older page) says the rest was paid back, as before.
    expect(narrate([due, cardRefunded("2026-05-06T00:00:00.000Z", 3000, true)], "paid-another-way")).toContain(
      "$30.00 was refunded to your card on 6 May 2026, $70.00 could not go back to your card and was paid back to you another way and $20.00 was retained",
    );
  });

  // #4210 round 3 (UX 5, `INV-PAY-136`): a card refund that failed after the
  // close and was raised for the club to check is never said as closed.
  it("MUTATION (#4210): a check raised after a part close is said as the club being in touch, out of what the close left unpaid", () => {
    const due = cancelled({ settledAmountCents: 10000, retainedAmountCents: 2000 });
    // $100.00 owed, $60.00 paid back, $40.00 raised to check.
    expect(narrate([due], "paid-another-way", {}, { ...closed(6000, { unpaid: 4000 }), checkOpenCents: 4000 })).toBe(
      `${LEAD}$60.00 could not go back to your card and was paid back to you another way, the club will be in touch about the remaining $40.00 and $20.00 was retained${END}`,
    );
    // Part of it still to check: the rest stays closed.
    expect(narrate([due], "paid-another-way", {}, { ...closed(6000, { unpaid: 4000 }), checkOpenCents: 1500 })).toContain(
      "$60.00 could not go back to your card and was paid back to you another way, the club checked the remaining $25.00 and closed it, the club will be in touch about the remaining $15.00",
    );
    // The check paid back another way in its turn.
    expect(narrate([due], "paid-another-way", {}, { ...closed(6000, { unpaid: 4000 }), checkPaidBackCents: 4000 })).toBe(
      `${LEAD}$100.00 could not go back to your card and was paid back to you another way and $20.00 was retained${END}`,
    );
    // Checked - not owed: nothing more is said.
    expect(narrate([due], "paid-another-way", {}, closed(6000, { unpaid: 4000 }))).toContain("the club checked the remaining $40.00 and closed it");
  });

  it("MUTATION (#4210): a check beyond what the close left unpaid (a resolved paid-twice row) is said as part of the refund", () => {
    const due = cancelled({ settledAmountCents: 10000, retainedAmountCents: 2000 });
    expect(narrate([due], "paid-another-way", {}, { ...closed(10000), checkOpenCents: 10000 })).toBe(
      `${LEAD}$100.00 could not go back to your card and was paid back to you another way, the club will be in touch about $100.00 of the refund and $20.00 was retained${END}`,
    );
  });

  it("a settled card cancel quotes its own event's figure, not the CANCELLED snapshot's", () => {
    expect(narrate([cancelled(), cardRefunded("2026-05-08T00:00:00.000Z", 8500)], "settled")).toBe(
      `${LEAD}$85.00 was refunded on 8 May 2026 and $30.00 was retained${END}`,
    );
  });

  it("MUTATION: a capacity race's row paid another way after part went to the card says the parts apart, and follows up only what no plan carried", () => {
    const raced = event(BookingEventType.CANCELLED, "2026-05-05T00:00:00.000Z", {
      amountCents: 12000,
      snapshot: { cancelledBecause: "capacity_race", refundMethod: "card", paidAmountCents: 12000, settledAmountCents: 9000, retainedAmountCents: 0, changeFeeCents: 0 },
    });
    const made = event(BookingEventType.REFUNDED, "2026-05-05T01:00:00.000Z", {
      amountCents: 6000,
      reason: CAPACITY_RACE_REFUND_EVENT_REASON,
      snapshot: { ...MADE_BEFORE_PAID_ANOTHER_WAY_SNAPSHOT },
    });
    const message = resolveBookingNarrative(
      { club: CLUB, booking: BOOKING, events: [raced, made], cardRefundState: "paid-another-way", cardRefundClose: closed(3000, { made: 6000 }) },
      CLUB_FORMAT_TEST,
    ).message;
    expect(message).toContain(
      "$60.00 was refunded to your card on 5 May 2026 and $30.00 could not go back to your card and was paid back to you another way; the club will be in touch about the remaining $30.00.",
    );
  });

  it("an up-front event a cancel wrote before #4145 does not say refunded while the row is still open or dead", () => {
    const upFront = cardRefunded("2026-05-05T00:00:00.000Z", 9000);
    expect(narrate([cancelled(), upFront], "on-its-way")).toBe(`${LEAD}$90.00 is on its way to your original payment method and $30.00 was retained${END}`);
    expect(narrate([cancelled(), upFront], "stalled")).toContain("$90.00 is being refunded to you and $30.00 was retained; the club will be in touch about the card refund");
    // Made, or no row read at all (a cancel before #1349): the event says it.
    expect(narrate([cancelled(), upFront], "settled")).toBe(`${LEAD}$90.00 was refunded on 5 May 2026 and $30.00 was retained${END}`);
    expect(narrate([cancelled(), upFront])).toBe(`${LEAD}$90.00 was refunded on 5 May 2026 and $30.00 was retained${END}`);
  });

  it("a credit cancel still takes its CREDITED event, and a cancel with no snapshot its first settlement event", () => {
    const credit = cancelled({ refundMethod: "credit", policySummary: "credit" });
    const credited = event(BookingEventType.CREDITED, "2026-05-05T00:00:00.000Z", { amountCents: 9000 });
    expect(narrate([credit, credited])).toBe(`${LEAD}$90.00 was added to your account credit on 5 May 2026 and $30.00 was retained${END}`);
    const legacy = event(BookingEventType.CANCELLED, "2026-05-05T00:00:00.000Z", { amountCents: 12000 });
    expect(narrate([legacy, event(BookingEventType.REFUNDED, "2026-05-06T00:00:00.000Z", { amountCents: 9000 })])).toContain("$90.00 was refunded on 6 May 2026");
  });
});
