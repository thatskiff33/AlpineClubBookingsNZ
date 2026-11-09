import { beforeEach, describe, expect, it, vi } from "vitest";
import { BookingEventType } from "@prisma/client";

/**
 * #3991 (`INV-PAY-119`): the booking page's history narrative quotes what the
 * pay steps charge — the price plus a change fee recorded on the payment, less
 * the account credit applied to the booking — read from the one home,
 * `bookingAmountOwedCents`, with the credit from the ledger
 * (`deriveBookingAppliedCreditCents`), the same authority the card intent and
 * the payment-link page read. Before this the feed handed the narrative the
 * bare price, so a booking owing a fee or holding credit was quoted the wrong
 * figure.
 *
 * The REAL narrative resolver and the REAL credit derivation run here; only the
 * database and the timeline builder are stubbed. So a feed that drops the fee,
 * drops the credit, reads credit from anywhere but the ledger, or hands over
 * the bare price fails on the sentence the member reads.
 */

const mocks = vi.hoisted(() => ({
  memberCreditAggregate: vi.fn(),
  openFinancialReview: vi.fn(),
  bookingEvents: vi.fn(),
  recoveryRows: vi.fn(),
  recoveryRow: vi.fn(),
  closeRecord: vi.fn(),
  record: vi.fn(),
  payments: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: { findMany: vi.fn().mockResolvedValue([]) },
    bookingEvent: { findMany: mocks.bookingEvents },
    memberCredit: { aggregate: mocks.memberCreditAggregate },
    // #4097, #4125: a cancelled booking's shortfall tasks and card refund rows; #4145, #4516: a row's
    // "Paid another way" close record, a still-owed rest's record, and the payment's refunds.
    manualRefundTask: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0), findFirst: mocks.closeRecord, findUnique: mocks.record },
    paymentRecoveryOperation: { findUnique: mocks.recoveryRow, findMany: mocks.recoveryRows },
    payment: { findMany: mocks.payments },
  },
}));
vi.mock("@/lib/booking-history", () => ({
  buildBookingHistoryItems: vi.fn().mockReturnValue([]),
}));
vi.mock("@/lib/booking-financial-review-visibility", () => ({
  bookingHasOpenFinancialReview: mocks.openFinancialReview,
}));
vi.mock("@/lib/rate-membership-label", () => ({
  loadRateMembershipLabelResolver: vi.fn(),
}));

import { loadBookingDetailHistory } from "../_lib/booking-detail-history";
import { resolveBookingDetailPayment } from "../_lib/booking-detail-payment";
import { renderBookingDetailMessages } from "../_lib/booking-detail-messages";
import { bindClubFormat } from "@/lib/club-format-bound";
import {
  FINANCIAL_REVIEW_AMOUNT_PREDATES_THE_CHANGE,
  FINANCIAL_REVIEW_NOTHING_TO_PAY_PREDATES_THE_CHANGE,
} from "@/lib/booking-financial-review-copy";
import { bindClubTime, requireClubTimeZone } from "@/lib/club-time";
import { bookingAppliedCreditWhere } from "@/lib/member-credit-booking-rows";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { givenCardRefundPaidInPart } from "@/lib/__tests__/support/card-refund-paid-in-part";

const CLUB = bindClubTime(requireClubTimeZone("Pacific/Auckland"), CLUB_FORMAT_TEST);

function bookingWith(payment: { changeFeeCents: number | null; creditAppliedCents?: number } | null) {
  return {
    id: "booking-1",
    status: "PAYMENT_PENDING",
    finalPriceCents: 20000,
    checkIn: new Date("2026-08-01T00:00:00.000Z"),
    checkOut: new Date("2026-08-03T00:00:00.000Z"),
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    memberId: "member-1",
    member: { id: "member-1", firstName: "Ada", lastName: "Lovelace", email: "ada@x.org" },
    organisationId: null,
    organisation: null,
    adminReviewStatus: null,
    adminReviewNotes: null,
    adminReviewReason: null,
    payment: payment
      ? {
          status: "PENDING",
          amountCents: 0,
          refundedAmountCents: 0,
          additionalAmountCents: 0,
          additionalPaymentStatus: null,
          transactions: [],
          createdAt: new Date("2026-07-01T00:00:00.000Z"),
          updatedAt: new Date("2026-07-01T00:00:00.000Z"),
          creditAppliedCents: payment.creditAppliedCents ?? 0,
          changeFeeCents: payment.changeFeeCents,
          // #3924: what the Net Collected cash parts read on the pay projection.
          _count: { transactions: 0 },
          recoveryOperations: [],
          refunds: [],
        }
      : null,
    modifications: [],
    refundRequests: [],
    moneyReconciliation: null,
    guests: [],
    manualRefundTasks: [],
    creditsApplied: [],
    organiserSettled: false,
    creditsFromCancellation: [],
    parentBooking: null,
  } as never;
}

/** The ledger's `|Σ BOOKING_APPLIED|`, as the aggregate returns it (negative rows). */
function ledgerCredit(appliedCents: number) {
  mocks.memberCreditAggregate.mockResolvedValue({
    _sum: { amountCents: appliedCents === 0 ? null : -appliedCents },
  });
}

const OWNER = { canSeeAdminTools: false, canSeeOwnerCredit: true };
const LINKED_GUEST = { canSeeAdminTools: false, canSeeOwnerCredit: false };

async function historyFor(booking: never, viewer = OWNER) {
  return loadBookingDetailHistory({ booking, club: CLUB, viewer: viewer as never, format: CLUB_FORMAT_TEST });
}

async function narrativeFor(booking: never, viewer = OWNER) {
  return (await historyFor(booking, viewer)).bookingNarrative;
}

beforeEach(() => {
  vi.clearAllMocks();
  ledgerCredit(0);
  mocks.openFinancialReview.mockResolvedValue(false);
  mocks.bookingEvents.mockResolvedValue([]);
  mocks.recoveryRows.mockResolvedValue([]);
  mocks.recoveryRow.mockResolvedValue(null);
  mocks.closeRecord.mockResolvedValue(null);
  mocks.record.mockResolvedValue(null);
  mocks.payments.mockResolvedValue([]);
});

// #4125: the booking page reads a cancelled booking's card refund row, so a
// refund the retries gave up on says the club will be in touch, never "on its way".
describe("booking page history narrative reads a cancelled card refund's row (#4125)", () => {
  it("a dead capacity-race refund says the club will be in touch", async () => {
    mocks.bookingEvents.mockResolvedValue([
      { type: BookingEventType.MEMBER_PAID, occurredAt: new Date("2026-05-02T00:00:00.000Z"), actorMemberId: null, amountCents: 20000, reason: null, snapshot: null },
      {
        type: BookingEventType.CANCELLED,
        occurredAt: new Date("2026-05-05T00:00:00.000Z"),
        actorMemberId: null,
        amountCents: 20000,
        reason: null,
        snapshot: { refundMethod: "card", cancelledBecause: "capacity_race", refundPercentage: 100, paidAmountCents: 20000, settledAmountCents: 20000, retainedAmountCents: 0 },
      },
    ]);
    mocks.recoveryRows.mockResolvedValue([
      { id: "op-1", idempotencyKey: "capacity_claim_failed_refund_recovery_booking-1_pi_1", status: "FAILED", attempts: 5, nextRetryAt: null },
    ]);

    const narrative = await narrativeFor({ ...(bookingWith(null) as object), status: "CANCELLED" } as never);

    expect(narrative.message).toContain("$200.00 is being refunded to you; the club will be in touch about the card refund.");
    expect(narrative.message).not.toContain("on its way");
  });

  // #4516 (round-3 review 1): a dead card refund the treasurer paid back in part, the rest still owed - both parts,
  // never the whole as still owed; once a later close pays the rest, all that was paid back.
  it.each([
    ["while the rest is still owed", false, "$50.00 could not go back to your card and was paid back to you another way and $150.00 is being refunded to you; the club will be in touch about the card refund."],
    ["once a later close paid the rest", true, "$200.00 could not go back to your card and was paid back to you another way."],
  ] as const)("MUTATION: a card refund paid back in part says what was paid back %s", async (_when, restClosed, said) => {
    mocks.bookingEvents.mockResolvedValue([
      { type: BookingEventType.MEMBER_PAID, occurredAt: new Date("2026-05-02T00:00:00.000Z"), actorMemberId: null, amountCents: 20000, reason: null, snapshot: null },
      {
        type: BookingEventType.CANCELLED,
        occurredAt: new Date("2026-05-05T00:00:00.000Z"),
        actorMemberId: null,
        amountCents: 20000,
        reason: null,
        snapshot: { refundMethod: "card", refundPercentage: 100, paidAmountCents: 20000, settledAmountCents: 20000, retainedAmountCents: 0 },
      },
    ]);
    givenCardRefundPaidInPart(
      { rows: mocks.recoveryRows, row: mocks.recoveryRow, closeRecord: mocks.closeRecord, record: mocks.record, payments: mocks.payments },
      { bookingId: "booking-1", refundCents: 20000, paidBackCents: 5000, restClosed },
    );

    const narrative = await narrativeFor({ ...(bookingWith(null) as object), status: "CANCELLED" } as never);

    expect(narrative.message).toContain(`Under the cancellation policy in effect at the time, ${said}`);
  });
});

describe("booking page history narrative quotes the amount owed (#3991, INV-PAY-119)", () => {
  it("adds a change fee recorded on the payment to the price", async () => {
    const narrative = await narrativeFor(bookingWith({ changeFeeCents: 2500 }));
    expect(narrative.state).toBe("payable");
    // 200.00 + 25.00
    expect(narrative.message).toContain("$225.00 is due");
  });

  it("takes off the credit applied in the ledger, after adding the fee", async () => {
    ledgerCredit(5000);
    const narrative = await narrativeFor(bookingWith({ changeFeeCents: 2500 }));
    // 200.00 + 25.00 - 50.00
    expect(narrative.message).toContain("$175.00 is due");
    expect(mocks.memberCreditAggregate).toHaveBeenCalledWith(
      expect.objectContaining({ where: bookingAppliedCreditWhere("booking-1") }),
    );
  });

  it("reads credit from the ledger, the pay steps' authority, not the payment row's column", async () => {
    // The column says 90.00; the ledger, which the card intent charges against, says 50.00.
    ledgerCredit(5000);
    const narrative = await narrativeFor(bookingWith({ changeFeeCents: null, creditAppliedCents: 9000 }));
    expect(narrative.message).toContain("$150.00 is due");
  });

  it("says there is nothing to pay, naming the credit, when the credit covers price and fee", async () => {
    ledgerCredit(22500);
    const narrative = await narrativeFor(bookingWith({ changeFeeCents: 2500 }));
    expect(narrative.state).toBe("nothing_to_pay");
    expect(narrative.headline).toBe("Nothing to pay");
    expect(narrative.message).toContain("the account credit applied to it covers what it owes");
    expect(narrative.message).not.toMatch(/\$\d/);
  });

  it("still asks for the fee when credit covers only the price", async () => {
    ledgerCredit(20000);
    const narrative = await narrativeFor(bookingWith({ changeFeeCents: 2500 }));
    expect(narrative.state).toBe("payable");
    expect(narrative.message).toContain("$25.00 is due");
  });

  it("CONTROL: a plain booking with no payment row and no credit is quoted its price, as before", async () => {
    const narrative = await narrativeFor(bookingWith(null));
    expect(narrative.state).toBe("payable");
    expect(narrative.message).toContain("$200.00 is due");
  });

  it("CONTROL: a paid booking's narrative is untouched by what is owed", async () => {
    ledgerCredit(5000);
    const { prisma } = await import("@/lib/prisma");
    vi.mocked(prisma.bookingEvent.findMany).mockResolvedValueOnce([
      {
        id: "ev-paid",
        type: BookingEventType.MEMBER_PAID,
        occurredAt: new Date("2026-07-02T00:00:00.000Z"),
        amountCents: 22500,
        reason: null,
        snapshot: null,
      },
    ] as never);
    const narrative = await narrativeFor({ ...(bookingWith({ changeFeeCents: 2500 }) as object), status: "PAID" } as never);
    expect(narrative.state).toBe("paid");
    expect(narrative.message).toContain("$225.00");
  });
});

/*
  #3991 review: the one combination the booking page actually RENDERS with an
  amount. Its banner shows the narrative only for settled outcomes and an open
  financial review (`booking-status-banners.tsx`), so a payable booking's figure
  reaches the member there only beside a review.
*/
describe("booking page history narrative with an open financial review (#3991)", () => {
  beforeEach(() => mocks.openFinancialReview.mockResolvedValue(true));

  it("quotes the amount owed and says it predates the change", async () => {
    ledgerCredit(5000);
    const narrative = await narrativeFor(bookingWith({ changeFeeCents: 2500 }));
    expect(narrative.state).toBe("financial_review_pending");
    expect(narrative.message).toContain("$175.00 is due");
    expect(narrative.message).toContain(FINANCIAL_REVIEW_AMOUNT_PREDATES_THE_CHANGE);
  });

  it("at nothing owed, uses the sentence that needs no figure, and no bookings-page next step", async () => {
    ledgerCredit(22500);
    const narrative = await narrativeFor(bookingWith({ changeFeeCents: 2500 }));
    expect(narrative.state).toBe("financial_review_pending");
    expect(narrative.headline).toBe("Nothing to pay");
    expect(narrative.message).toContain("has nothing left to pay");
    expect(narrative.message).toContain(FINANCIAL_REVIEW_NOTHING_TO_PAY_PREDATES_THE_CHANGE);
    expect(narrative.message).not.toContain(FINANCIAL_REVIEW_AMOUNT_PREDATES_THE_CHANGE);
    expect(narrative.message).not.toMatch(/\$\d/);
    expect(narrative.nextStep).not.toMatch(/bookings page/i);
    expect(narrative.nextStep).toContain("There is nothing you need to do about that change.");
  });
});

/*
  #3991 review: a linked guest is not told about the owner's credit — the
  credit-election notice and every other money surface on the page withhold it
  from them. The amount they could already see stays.
*/
describe("booking page history narrative for a linked guest (#3991)", () => {
  it("says there is nothing to pay without naming the owner's credit", async () => {
    ledgerCredit(22500);
    const narrative = await narrativeFor(bookingWith({ changeFeeCents: 2500 }), LINKED_GUEST);
    expect(narrative.state).toBe("nothing_to_pay");
    expect(narrative.message).toMatch(/has nothing left to pay\.$/);
    expect(narrative.message).not.toMatch(/credit/i);
  });

  it("CONTROL: the owner, on the same booking, is told the credit covers it", async () => {
    ledgerCredit(22500);
    const narrative = await narrativeFor(bookingWith({ changeFeeCents: 2500 }));
    expect(narrative.message).toMatch(/credit/);
  });

  it("keeps the amount due, and the page's own figure keeps the real credit", async () => {
    ledgerCredit(5000);
    const history = await historyFor(bookingWith({ changeFeeCents: 2500 }), LINKED_GUEST);
    expect(history.bookingNarrative.message).toContain("$175.00 is due");
    expect(history.amountOwed).toEqual({ owedCents: 17500, dueCents: 17500, appliedCreditCents: 5000 });
  });
});

/*
  #3991 review: ONE credit source per page load. The pay card's total and the
  `{amountDue}` token used to come from the payment row's mirror column while the
  narrative read the ledger. Here the two disagree (column 90.00, ledger 50.00)
  and every figure the page shows must be the ledger's.
*/
describe("booking page data: the card, the {amountDue} token and the narrative agree (#3991)", () => {
  it("sizes all three from the ledger read the history loader returns", async () => {
    ledgerCredit(5000);
    mocks.openFinancialReview.mockResolvedValue(true);
    const booking = bookingWith({ changeFeeCents: 2500, creditAppliedCents: 9000 });
    const viewer = { ...OWNER, canManageBooking: true, isBookingOwner: true, nonOwnerAdminViewer: false };
    const history = await historyFor(booking, viewer);
    const payment = resolveBookingDetailPayment({
      booking,
      modules: {} as never,
      viewer: viewer as never,
      access: { isDeleted: false } as never,
      party: { hasProvisionalChildren: false, isProvisionalChild: false, isFlaggedProvisional: false } as never,
      amountOwed: history.amountOwed,
    });
    const messages = renderBookingDetailMessages({
      booking,
      club: CLUB,
      money: bindClubFormat(CLUB_FORMAT_TEST),
      modules: { xeroIntegration: false } as never,
      bookingMessages: new Proxy({}, { get: () => "{{amountDue}}" }) as never,
      bookingLodgeEmailSettings: { lodgeName: "", clubName: "", publicUrl: "", supportEmail: "" } as never,
      payment,
    });

    // 200.00 + 25.00 - 50.00 (ledger), never - 90.00 (column)
    expect(payment.creditAppliedCents).toBe(5000);
    expect(payment.cardAmountDueCents).toBe(17500);
    expect(messages.paymentRequiredDescription).toBe("$175.00");
    expect(history.bookingNarrative.message).toContain("$175.00 is due");
  });
});
