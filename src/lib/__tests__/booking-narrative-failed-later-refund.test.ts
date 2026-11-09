import { describe, expect, it } from "vitest";
import { BookingEventType } from "@prisma/client";

import { resolveBookingNarrative, type NarrativeBooking, type NarrativeEvent } from "@/lib/booking-narrative";
import type { CardRefundState, CardShortfallTaskStatuses } from "@/lib/manual-refund-task-settlement-rules";
import { CAPACITY_RACE_REFUND_EVENT_REASON } from "@/lib/booking-events";
import type { FailedLaterCardRefund, PaidAnotherWayClose } from "@/lib/booking-narrative-cancelled-post-payment";
import { cancelCardRefundEventReason, MADE_BEFORE_PAID_ANOTHER_WAY_SNAPSHOT } from "@/lib/cancel-card-refund-event-reason";
import { bindClubTime, requireClubTimeZone } from "@/lib/club-time";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

/**
 * #4166 (`INV-PAY-134`): a cancel's card refund that a close recorded - its
 * REFUNDED event - and Stripe then failed (#4104) is owed again on a row of its
 * own (`card_refund_failed_later_<refund>`). The page reads that row
 * (`readCancelledCardRefund`'s `cardRefundFailedLater`), and the narrative says
 * the failed amount by where the row stands - made again, on its way, stalled
 * or paid another way - never "refunded" on the event's date; what still stands
 * refunded keeps its date.
 *
 * MUTATION PROOF. Ignore `cardRefundFailedLater` and every case below says the
 * whole refund "was refunded on 5 May 2026"; take the failed part off nothing
 * and the refunded part is said twice; drop the cap and a failed part larger
 * than the refund is told past it; apply it to a credit and an account credit
 * is told as a card refund.
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
const CANCELLED = event(BookingEventType.CANCELLED, "2026-05-05T00:00:00.000Z", {
  amountCents: 12000,
  snapshot: {
    policySummary: "Cancelled 30 day(s) before check-in: 75% card refund under the policy in effect at the time.",
    refundMethod: "card",
    refundPercentage: 75,
    paidAmountCents: 12000,
    settledAmountCents: 9000,
    retainedAmountCents: 3000,
    changeFeeCents: 0,
  },
});

/** The cancel's card refund event as a close writes it; `made`, as a "Paid another way" close writes it. */
function cardRefunded(cents: number, made = false): NarrativeEvent {
  return event(BookingEventType.REFUNDED, "2026-05-05T00:00:00.000Z", {
    amountCents: cents,
    reason: cancelCardRefundEventReason({ cardRefundCents: cents, policy: { refundPercentage: 75, refundAmountCents: 9000 }, shortfall: made, format: CLUB_FORMAT_TEST }),
    snapshot: made ? { ...MADE_BEFORE_PAID_ANOTHER_WAY_SNAPSHOT } : null,
  });
}

const failedLater = (amountCents: number, state: CardRefundState, extra: Partial<FailedLaterCardRefund> = {}): FailedLaterCardRefund => ({ amountCents, state, ...extra });

function narrate(
  events: NarrativeEvent[],
  cardRefundFailedLater: FailedLaterCardRefund[] | undefined,
  more: { cardRefundState?: CardRefundState; cardRefundClose?: PaidAnotherWayClose; cardShortfallStatuses?: CardShortfallTaskStatuses } = {},
): string {
  return resolveBookingNarrative({ club: CLUB, booking: BOOKING, events, cardRefundState: "settled", cardRefundFailedLater, ...more }, CLUB_FORMAT_TEST).message;
}

const LEAD = "You cancelled this booking on 5 May 2026 after paying $120.00 on 2 May 2026. Under the cancellation policy in effect at the time, ";
const END = " No further payment is required.";
const MADE_AGAIN_AT = new Date("2026-05-12T00:00:00.000Z");

describe("#4166: a member cancel's card refund that failed after its REFUNDED event", () => {
  it("with none failed, reads as refunded on the event's date, as before", () => {
    expect(narrate([PAID, CANCELLED, cardRefunded(9000)], undefined)).toBe(`${LEAD}$90.00 was refunded on 5 May 2026 and $30.00 was retained.${END}`);
    expect(narrate([PAID, CANCELLED, cardRefunded(9000)], [])).toBe(`${LEAD}$90.00 was refunded on 5 May 2026 and $30.00 was retained.${END}`);
  });

  it.each([
    ["on its way", failedLater(9000, "on-its-way"), "$90.00 is on its way to your original payment method and $30.00 was retained."],
    ["stalled", failedLater(9000, "stalled"), "$90.00 is being refunded to you and $30.00 was retained; the club will be in touch about the card refund."],
    ["made again", failedLater(9000, "settled", { madeAt: MADE_AGAIN_AT }), "$90.00 was refunded to your card on 12 May 2026 and $30.00 was retained."],
    ["paid another way", failedLater(9000, "paid-another-way", { paidBackCents: 9000, unpaidCents: 0 }), "$90.00 could not go back to your card and was paid back to you another way and $30.00 was retained."],
    [
      "paid back in part another way",
      failedLater(9000, "paid-another-way", { paidBackCents: 5000, unpaidCents: 4000 }),
      "$50.00 could not go back to your card and was paid back to you another way, the club checked the remaining $40.00 and closed it and $30.00 was retained.",
    ],
    ["paid another way, read with no record figure", failedLater(9000, "paid-another-way"), "$90.00 could not go back to your card and was paid back to you another way and $30.00 was retained."],
  ] as const)("MUTATION: all of it failed, its row %s, says so - never refunded on the event's date", (_label, part, clause) => {
    const message = narrate([PAID, CANCELLED, cardRefunded(9000)], [part]);
    expect(message).toBe(`${LEAD}${clause}${END}`);
    expect(message).not.toContain("refunded on 5 May 2026");
  });

  it("MUTATION: part of it failed - the rest keeps the event's date, the failed part is told by its row", () => {
    expect(narrate([PAID, CANCELLED, cardRefunded(9000)], [failedLater(4000, "on-its-way")])).toBe(
      `${LEAD}$50.00 was refunded on 5 May 2026, $40.00 is on its way to your original payment method and $30.00 was retained.${END}`,
    );
  });

  it("two failed parts, each by its own row: made again, then stalled", () => {
    expect(narrate([PAID, CANCELLED, cardRefunded(9000)], [failedLater(3000, "stalled"), failedLater(6000, "settled", { madeAt: MADE_AGAIN_AT })])).toBe(
      `${LEAD}$60.00 was refunded to your card on 12 May 2026, $30.00 is being refunded to you and $30.00 was retained; the club will be in touch about the card refund.${END}`,
    );
  });

  it("MUTATION: a failed part is never told past the refund the event recorded", () => {
    expect(narrate([PAID, CANCELLED, cardRefunded(9000)], [failedLater(6000, "on-its-way"), failedLater(6000, "stalled")])).toBe(
      `${LEAD}$60.00 is on its way to your original payment method, $30.00 is being refunded to you and $30.00 was retained; the club will be in touch about the card refund.${END}`,
    );
  });

  it("MUTATION: a cancel settled as account credit is never told as a failed card refund", () => {
    const credited = event(BookingEventType.CREDITED, "2026-05-05T00:00:00.000Z", { amountCents: 9000 });
    const creditCancel = { ...CANCELLED, snapshot: { ...(CANCELLED.snapshot as object), refundMethod: "credit" } };
    expect(narrate([PAID, creditCancel, credited], [failedLater(9000, "on-its-way")], { cardRefundState: undefined })).toBe(
      `${LEAD}$90.00 was added to your account credit on 5 May 2026 and $30.00 was retained.${END}`,
    );
  });

  it("a row still being sent is said whole: nothing it made can have failed later", () => {
    expect(narrate([PAID, CANCELLED], [failedLater(4000, "stalled")], { cardRefundState: "on-its-way" })).toBe(
      `${LEAD}$90.00 is on its way to your original payment method and $30.00 was retained.${END}`,
    );
  });

  it("MUTATION: paid another way after part went to the card - that dated part, failed later, is told by its row and not twice", () => {
    // $60.00 reached the card before the rest was paid another way; the reader counts the failed $60.00 in `madeCents`.
    const close: PaidAnotherWayClose = { paidBackCents: 3000, unpaidCents: 0, madeCents: 6000 };
    expect(narrate([PAID, CANCELLED, cardRefunded(6000, true)], [failedLater(6000, "on-its-way")], { cardRefundState: "paid-another-way", cardRefundClose: close })).toBe(
      `${LEAD}$60.00 is on its way to your original payment method, $30.00 could not go back to your card and was paid back to you another way and $30.00 was retained.${END}`,
    );
    expect(narrate([PAID, CANCELLED, cardRefunded(6000, true)], [failedLater(2000, "stalled")], { cardRefundState: "paid-another-way", cardRefundClose: close })).toBe(
      `${LEAD}$40.00 was refunded to your card on 5 May 2026, $20.00 is being refunded to you, $30.00 could not go back to your card and was paid back to you another way and $30.00 was retained; the club will be in touch about the card refund.${END}`,
    );
  });

  it("MUTATION: a card refund shortfall's card part, failed later and stalled, is followed up", () => {
    const shortfall = {
      ...CANCELLED,
      snapshot: { ...(CANCELLED.snapshot as object), cardShortfall: { cardCents: 6000, bankCents: 3000, checkCents: 0 } },
    };
    expect(narrate([PAID, shortfall, cardRefunded(6000)], [failedLater(6000, "stalled")], { cardShortfallStatuses: { bank: "OPEN", card: "settled" } })).toBe(
      `${LEAD}$60.00 is being refunded to you, $30.00 is being refunded to you by bank transfer and $30.00 was retained; the club will be in touch about the card refund.${END}`,
    );
  });
});

describe("#4166: a capacity race's card refund that failed after its REFUNDED event", () => {
  const OPENING = "This booking was cancelled on 5 May 2026, after you paid $100.00 on 5 May 2026, because the dates filled up while your payment was going through.";
  function raceCancel(settledAmountCents: number) {
    return event(BookingEventType.CANCELLED, "2026-05-05T00:00:00.000Z", {
      amountCents: 10000,
      snapshot: { policySummary: "x", refundMethod: "card", cancelledBecause: "capacity_race", refundPercentage: 100, paidAmountCents: 10000, settledAmountCents, retainedAmountCents: 0 },
    });
  }
  const raceRefunded = (cents: number) => event(BookingEventType.REFUNDED, "2026-05-05T00:00:00.000Z", { amountCents: cents, reason: CAPACITY_RACE_REFUND_EVENT_REASON });

  it.each([
    ["on its way", failedLater(10000, "on-its-way"), "$100.00 is on its way to your original payment method."],
    ["made again", failedLater(10000, "settled", { madeAt: MADE_AGAIN_AT }), "$100.00 was refunded to your card on 12 May 2026."],
    ["stalled", failedLater(10000, "stalled"), "$100.00 is being refunded to you; the club will be in touch about the card refund."],
    ["paid another way", failedLater(10000, "paid-another-way", { paidBackCents: 10000, unpaidCents: 0 }), "$100.00 could not go back to your card and was paid back to you another way."],
  ] as const)("MUTATION: all of it failed, its row %s, says so", (_label, part, clause) => {
    expect(narrate([raceCancel(10000), raceRefunded(10000)], [part])).toBe(`${OPENING} ${clause.charAt(0).toUpperCase()}${clause.slice(1)}${END}`);
  });

  it("MUTATION: part failed, short of the charge - the rest keeps its date and the part no plan carried is still followed up", () => {
    expect(narrate([raceCancel(8000), raceRefunded(8000)], [failedLater(3000, "stalled")])).toBe(
      `${OPENING} $50.00 was refunded to your card on 5 May 2026 and $30.00 is being refunded to you; the club will be in touch about the card refund and the remaining $20.00.${END}`,
    );
  });
});

describe("#4166 round 2: paid-another-way parts, and the dated and undated parts", () => {
  /** $40.00 reached the card and was dated by the close's event, $20.00 more it counted undated, $30.00 was paid another way. */
  const close: PaidAnotherWayClose = { paidBackCents: 3000, unpaidCents: 0, madeCents: 6000 };
  const narratePaw = (parts: FailedLaterCardRefund[], record: PaidAnotherWayClose = close) =>
    narrate([PAID, CANCELLED, cardRefunded(4000, true)], parts, { cardRefundState: "paid-another-way", cardRefundClose: record });

  it("MUTATION: a failed refund the close dated comes off the dated part; one it counted undated, off the undated part", () => {
    expect(narratePaw([failedLater(2000, "on-its-way")])).toBe(
      `${LEAD}$20.00 was refunded to your card on 5 May 2026, $20.00 was refunded to your card, $20.00 is on its way to your original payment method, $30.00 could not go back to your card and was paid back to you another way and $30.00 was retained.${END}`,
    );
    expect(narratePaw([failedLater(2000, "on-its-way", { dated: false })])).toBe(
      `${LEAD}$40.00 was refunded to your card on 5 May 2026, $20.00 is on its way to your original payment method, $30.00 could not go back to your card and was paid back to you another way and $30.00 was retained.${END}`,
    );
  });

  it("MUTATION: the cancel's close and a failed-later row both paid another way are said as one total, once", () => {
    const message = narratePaw([failedLater(4000, "paid-another-way", { paidBackCents: 4000, unpaidCents: 0 })]);
    expect(message).toBe(
      `${LEAD}$20.00 was refunded to your card, $70.00 could not go back to your card and was paid back to you another way and $30.00 was retained.${END}`,
    );
    expect(message.match(/could not go back/g)).toHaveLength(1);
  });

  it("MUTATION: what both left unpaid is one total too, 'remaining' after the clauses before it", () => {
    const partClose: PaidAnotherWayClose = { paidBackCents: 2000, unpaidCents: 1000, madeCents: 6000 };
    expect(narratePaw([failedLater(4000, "paid-another-way", { paidBackCents: 3000, unpaidCents: 1000 })], partClose)).toBe(
      `${LEAD}$20.00 was refunded to your card, $50.00 could not go back to your card and was paid back to you another way, the club checked the remaining $20.00 and closed it and $30.00 was retained.${END}`,
    );
  });

  // #4516 (round-3 review 1): its row closed in part with the rest still owed - the reader splits the rest off as a
  // part of its own, where it stands - says both, and the club follows the rest up.
  it("MUTATION: a failed-later row paid back in part, the rest still owed, says both parts", () => {
    expect(narrate([PAID, CANCELLED, cardRefunded(9000)], [failedLater(4000, "paid-another-way", { paidBackCents: 4000, unpaidCents: 0 }), failedLater(5000, "stalled")])).toBe(
      `${LEAD}$50.00 is being refunded to you, $40.00 could not go back to your card and was paid back to you another way and $30.00 was retained; the club will be in touch about the card refund.${END}`,
    );
  });

  it("a failed-later row paid another way in part, alone, says 'remaining' after the clause before it", () => {
    expect(narrate([PAID, CANCELLED, cardRefunded(9000)], [failedLater(9000, "paid-another-way", { paidBackCents: 5000, unpaidCents: 4000 })])).toBe(
      `${LEAD}$50.00 could not go back to your card and was paid back to you another way, the club checked the remaining $40.00 and closed it and $30.00 was retained.${END}`,
    );
  });
});

describe("#4166 round 2: a capacity race the runner closed before #4125, with no event", () => {
  const OPENING = "This booking was cancelled on 5 May 2026, after you paid $100.00 on 5 May 2026, because the dates filled up while your payment was going through.";
  const raceCancel = event(BookingEventType.CANCELLED, "2026-05-05T00:00:00.000Z", {
    amountCents: 10000,
    snapshot: { policySummary: "x", refundMethod: "card", cancelledBecause: "capacity_race", refundPercentage: 100, paidAmountCents: 10000, settledAmountCents: 10000, retainedAmountCents: 0 },
  });

  it.each([
    ["none failed", undefined, "$100.00 was refunded to your card."],
    ["on its way", [failedLater(10000, "on-its-way")], "$100.00 is on its way to your original payment method."],
    ["stalled", [failedLater(10000, "stalled")], "$100.00 is being refunded to you; the club will be in touch about the card refund."],
  ] as const)("MUTATION: its refund, failed later and %s, is told by its row", (_label, parts, clause) => {
    expect(narrate([raceCancel], parts ? [...parts] : undefined)).toBe(`${OPENING} ${clause}${END}`);
  });
});
