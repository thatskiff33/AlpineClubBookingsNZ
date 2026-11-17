/**
 * #4069 (`INV-PAY-157`): the one cash-cover answer, branch by branch, over
 * snapshots shaped as the real writers leave them. The composed real-writer
 * cases are `booking-cash-evidence.realdb.test.ts`; the approval email's race
 * is `booking-exception-approved-interleaving.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";

// Pure: nothing here may reach the database.
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import {
  deriveBookingCashCover,
  type BookingCashSnapshot,
  type CashEvidencePayment,
  type CashEvidenceTransactionRow,
  type GroupChildCashEvidence,
} from "@/lib/booking-cash-evidence";
import { getNetCollectedCashParts } from "@/lib/payment-net-collected";

const T0 = new Date("2026-07-01T00:00:00.000Z");

type Row = CashEvidenceTransactionRow & { id?: string };
const captured = (amountCents: number, over: Partial<Row> = {}): Row => ({
  kind: "PRIMARY",
  source: "STRIPE",
  status: "SUCCEEDED",
  amountCents,
  refundedAmountCents: 0,
  reason: null,
  ...over,
});

function payment(over: Partial<CashEvidencePayment> = {}): CashEvidencePayment {
  const transactions = over.transactions ?? [];
  const capturedRows = transactions.filter((row) => ["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED"].includes(row.status));
  return {
    id: "pay-1",
    status: capturedRows.length > 0 ? "SUCCEEDED" : "PENDING",
    source: "STRIPE",
    amountCents: capturedRows.reduce((sum, row) => sum + row.amountCents, 0),
    refundedAmountCents: capturedRows.reduce((sum, row) => sum + row.refundedAmountCents, 0),
    changeFeeCents: null,
    _count: { transactions: capturedRows.length },
    recoveryOperations: [],
    refunds: [],
    transactions,
    ...over,
  };
}

function snapshot(over: {
  booking?: Partial<BookingCashSnapshot["booking"]>;
  payment?: CashEvidencePayment | null;
  appliedCreditCents?: number;
  disputedCaptureCents?: number;
  group?: GroupChildCashEvidence | null;
} = {}): BookingCashSnapshot {
  return {
    booking: {
      id: "bk-1",
      lodgeId: "lodge-1",
      status: "PAYMENT_PENDING",
      deletedAt: null,
      finalPriceCents: 50_000,
      organiserSettled: false,
      parentBookingId: null,
      manualRefundTasks: [],
      creditsFromCancellation: [],
      ...over.booking,
    },
    payment: over.payment === undefined ? null : over.payment,
    appliedCreditCents: over.appliedCreditCents ?? 0,
    disputedCaptureCents: over.disputedCaptureCents ?? 0,
    group: over.group ?? null,
  };
}

// An operation's frozen plan names the capture each slice refunds (#1097).
const cardRefundOperation = (amountCents: number, status: string, type = "REFUND_BOOKING_MODIFICATION") => ({
  id: `op-${type}-${status}`,
  type,
  status,
  idempotencyKey: `refund-${type}-${status}`,
  amountCents,
  allocationPlan: type === "REFUND_SUPERSEDED_PAYMENT" ? null : [{ paymentTransactionId: "tx-1", amountCents }],
  paymentTransactionId: "tx-1",
  createdAt: T0,
  succeededAt: status === "SUCCEEDED" ? T0 : null,
});

describe("deriveBookingCashCover: what the cash proves", () => {
  it("owes the whole worth when nothing was ever asked", () => {
    expect(deriveBookingCashCover(snapshot())).toEqual({ kind: "owes", cents: 50_000 });
  });

  it("never counts a pending bank transfer's face amount, whatever the status", () => {
    // The bed-holding switch: CONFIRMED, a PENDING bank payment at its face.
    const pendingBank = payment({
      source: "INTERNET_BANKING",
      status: "PENDING",
      amountCents: 50_000,
      transactions: [captured(50_000, { source: "INTERNET_BANKING", status: "PENDING", reason: "internet_banking_switch_at_pay" })],
    });
    expect(deriveBookingCashCover(snapshot({ booking: { status: "CONFIRMED" }, payment: pendingBank }))).toEqual({
      kind: "owes",
      cents: 50_000,
    });
  });

  it("is covered by a capture its row proves", () => {
    expect(
      deriveBookingCashCover(snapshot({ booking: { status: "PAID" }, payment: payment({ transactions: [captured(50_000)] }) })),
    ).toEqual({ kind: "covered" });
  });

  it("is covered when paid, reduced and partly refunded by card (PAID, PARTIALLY_REFUNDED)", () => {
    const reduced = payment({
      status: "PARTIALLY_REFUNDED",
      transactions: [captured(50_000, { status: "PARTIALLY_REFUNDED", refundedAmountCents: 25_000 })],
    });
    expect(deriveBookingCashCover(snapshot({ booking: { status: "PAID", finalPriceCents: 25_000 }, payment: reduced }))).toEqual({
      kind: "covered",
    });
  });

  it("is covered at zero price, with the $0 succeeded payment no row backs", () => {
    const zero = payment({ status: "SUCCEEDED", amountCents: 0, _count: { transactions: 0 } });
    expect(deriveBookingCashCover(snapshot({ booking: { status: "PAID", finalPriceCents: 0 }, payment: zero }))).toEqual({
      kind: "covered",
    });
  });

  it("is covered by applied credit alone", () => {
    expect(deriveBookingCashCover(snapshot({ appliedCreditCents: 50_000 }))).toEqual({ kind: "covered" });
    expect(deriveBookingCashCover(snapshot({ appliedCreditCents: 20_000 }))).toEqual({ kind: "owes", cents: 30_000 });
  });

  it("owes an unpaid addition on a paid primary, and a recorded change fee", () => {
    const withAddition = payment({
      transactions: [captured(50_000), captured(20_000, { kind: "ADDITIONAL", status: "PENDING" })],
      changeFeeCents: 1_500,
    });
    expect(
      deriveBookingCashCover(snapshot({ booking: { status: "PAID", finalPriceCents: 70_000 }, payment: withAddition })),
    ).toEqual({ kind: "owes", cents: 21_500 });
  });

  it("is covered exactly at worth, and owes the last cent below it", () => {
    const paid = payment({ transactions: [captured(49_999)] });
    expect(deriveBookingCashCover(snapshot({ payment: paid }))).toEqual({ kind: "owes", cents: 1 });
    expect(deriveBookingCashCover(snapshot({ payment: paid, appliedCreditCents: 1 }))).toEqual({ kind: "covered" });
  });

  it("never counts a refund Stripe has not paid, or failed, as cover", () => {
    // Paid 50,000; an edit lowered the price and started a 25,000 card refund;
    // a later edit raised it back. The refund is still owed, so 25,000 is due.
    for (const status of ["PENDING", "FAILED", "EXHAUSTED"]) {
      const paid = payment({ transactions: [captured(50_000)], recoveryOperations: [cardRefundOperation(25_000, status)] });
      expect(deriveBookingCashCover(snapshot({ booking: { status: "PAID" }, payment: paid }))).toEqual({
        kind: "owes",
        cents: 25_000,
      });
    }
  });

  it("never counts a superseded capture awaiting its refund as cover", () => {
    // The first intent captured anyway after a later ask replaced it; its own
    // refund row returns it whole, and the live ask is still unpaid.
    const superseded = payment({
      transactions: [captured(50_000, { id: "tx-1" }), captured(50_000, { id: "tx-2", status: "PENDING" })],
      recoveryOperations: [cardRefundOperation(50_000, "PENDING", "REFUND_SUPERSEDED_PAYMENT")],
    });
    expect(deriveBookingCashCover(snapshot({ payment: superseded }))).toEqual({ kind: "owes", cents: 50_000 });
  });

  it("never counts an open bank hand-back as cover", () => {
    const paid = payment({ source: "INTERNET_BANKING", transactions: [captured(50_000, { source: "INTERNET_BANKING", reason: "xero_invoice_paid_cash" })] });
    const tasks = [{ status: "OPEN", kind: "CANCELLED_BOOKING_HAND_BACK", amountCents: 25_000, partPaymentReviewPaymentId: null, occurrenceKey: "edit-refund-hand-back:m-1", reason: "edit refund" }];
    expect(deriveBookingCashCover(snapshot({ booking: { status: "PAID", manualRefundTasks: tasks }, payment: paid }))).toEqual({
      kind: "owes",
      cents: 25_000,
    });
  });
});

describe("deriveBookingCashCover: one refund comes off exactly once", () => {
  // A $250 refund on a $500 payment, for a booking still worth $500: open,
  // then paid. Either way the booking owes the $250 the club is handing back.
  const open = payment({ transactions: [captured(50_000)], recoveryOperations: [cardRefundOperation(25_000, "PROCESSING")] });
  const recorded = payment({
    status: "PARTIALLY_REFUNDED",
    transactions: [captured(50_000, { status: "PARTIALLY_REFUNDED", refundedAmountCents: 25_000 })],
    recoveryOperations: [cardRefundOperation(25_000, "SUCCEEDED")],
    refunds: [{ stripeRefundId: "re_1", paymentTransactionId: "tx-1", amountCents: 25_000, status: "succeeded", createdAt: T0 }],
  });
  const recordedOperationOpen = { ...recorded, recoveryOperations: [cardRefundOperation(25_000, "PROCESSING")] };

  it.each([
    ["open, nothing recorded", open],
    ["recorded, operation closed", recorded],
    ["recorded, operation not yet closed", recordedOperationOpen],
  ])("card refund %s", (_label, row) => {
    expect(deriveBookingCashCover(snapshot({ booking: { status: "PAID" }, payment: row }))).toEqual({ kind: "owes", cents: 25_000 });
  });

  it("a recorded refund Stripe refused stays owed", () => {
    const refused = {
      ...recordedOperationOpen,
      status: "SUCCEEDED" as const,
      transactions: [captured(50_000)],
      refundedAmountCents: 0,
      refunds: [{ stripeRefundId: "re_1", paymentTransactionId: "tx-1", amountCents: 25_000, status: "failed", createdAt: T0 }],
    };
    expect(deriveBookingCashCover(snapshot({ booking: { status: "PAID" }, payment: refused }))).toEqual({ kind: "owes", cents: 25_000 });
  });

  it("a bank hand-back, open then completed", () => {
    const task = (status: string) => ({ status, kind: "CANCELLED_BOOKING_HAND_BACK", amountCents: 25_000, partPaymentReviewPaymentId: null, occurrenceKey: "edit-refund-hand-back:m-1", reason: "edit refund" });
    const bank = (refundedAmountCents: number) =>
      payment({
        source: "INTERNET_BANKING",
        status: refundedAmountCents > 0 ? "PARTIALLY_REFUNDED" : "SUCCEEDED",
        transactions: [captured(50_000, { source: "INTERNET_BANKING", reason: "xero_invoice_paid_cash", refundedAmountCents, status: refundedAmountCents > 0 ? "PARTIALLY_REFUNDED" : "SUCCEEDED" })],
      });
    const openTask = snapshot({ booking: { status: "PAID", manualRefundTasks: [task("OPEN")] }, payment: bank(0) });
    const closedTask = snapshot({ booking: { status: "PAID", manualRefundTasks: [task("COMPLETED")] }, payment: bank(25_000) });
    expect(deriveBookingCashCover(openTask)).toEqual({ kind: "owes", cents: 25_000 });
    expect(deriveBookingCashCover(closedTask)).toEqual({ kind: "owes", cents: 25_000 });
  });

  it("holds the same cash as Net Collected's cash half for the payment (parity)", () => {
    for (const row of [open, recorded, recordedOperationOpen]) {
      const s = snapshot({ booking: { status: "PAID", finalPriceCents: 0 }, payment: row });
      expect(getNetCollectedCashParts({ ...row, booking: s.booking }).heldCashCents).toBe(25_000);
    }
  });
});

describe("deriveBookingCashCover: unknown, never a guess", () => {
  const cases: Array<[string, BookingCashSnapshot, string]> = [
    ["a cancelled booking", snapshot({ booking: { status: "CANCELLED" } }), "booking-not-live"],
    ["a deleted booking", snapshot({ booking: { deletedAt: T0 } }), "booking-not-live"],
    ["a legacy backfilled row", snapshot({ payment: payment({ transactions: [captured(50_000, { reason: "legacy_primary_backfill" })] }) }), "legacy-history"],
    [
      "a bank receipt holding its stored figure",
      snapshot({ payment: payment({ source: "INTERNET_BANKING", transactions: [captured(50_000, { source: "INTERNET_BANKING", reason: "internet_banking_switch_at_pay" })] }) }),
      "stored-figure-bank-receipt",
    ],
    ["a SUCCEEDED mirror with no rows", snapshot({ payment: payment({ status: "SUCCEEDED", amountCents: 50_000, _count: { transactions: 0 } }) }), "rows-disagree-with-payment"],
    ["rows that do not sum to the mirror", snapshot({ payment: payment({ transactions: [captured(40_000)], amountCents: 50_000 }) }), "rows-disagree-with-payment"],
    [
      "a refund written to the mirror alone",
      snapshot({ payment: payment({ status: "PARTIALLY_REFUNDED", transactions: [captured(50_000)], refundedAmountCents: 10_000 }) }),
      "rows-disagree-with-payment",
    ],
    ["a refund above its capture", snapshot({ payment: payment({ transactions: [captured(50_000, { refundedAmountCents: 60_000 })] }) }), "refunds-unproven"],
    [
      "a REFUNDED row recording no refund",
      snapshot({ payment: payment({ status: "REFUNDED", transactions: [captured(50_000, { status: "REFUNDED" })] }) }),
      "refunds-unproven",
    ],
    ["a disputed capture", snapshot({ payment: payment({ transactions: [captured(50_000)] }), disputedCaptureCents: 50_000 }), "disputed"],
  ];
  it.each(cases)("%s", (_label, input, reason) => {
    expect(deriveBookingCashCover(input)).toEqual({ kind: "unknown", reason });
  });
});

describe("deriveBookingCashCover: group children", () => {
  const settlement = (status: "PENDING" | "SUCCEEDED" | "REFUNDED", amountCents = 9_000) => ({
    id: "settle-1",
    source: "STRIPE" as const,
    amountCents,
    stripePaymentIntentId: "pi_group",
    refundPlan: null,
    refundPaidByBank: false,
    status,
  });
  const sibling = (id: string, amountCents: number, source: "STRIPE" | "INTERNET_BANKING" = "STRIPE") => ({
    id,
    lodgeId: "lodge-1",
    payment: { amountCents, status: "SUCCEEDED", source },
  });
  const group = (over: Partial<GroupChildCashEvidence> = {}): GroupChildCashEvidence => ({
    paymentMode: "ORGANISER_PAYS",
    settlement: settlement("SUCCEEDED"),
    siblings: [sibling("bk-1", 4_500), sibling("bk-2", 4_500)],
    handBacks: { openEditRefundHandBackCents: 0, completedRefundRequestHandBackCents: 0, completedOtherMirrorWritesCents: 0 },
    appealRefunds: { recordedCents: 0, committedCents: 0 },
    ...over,
  });
  // The settle writes the child's mirror with the settlement's source and no rows.
  const childMirror = (over: Partial<CashEvidencePayment> = {}) =>
    payment({ status: "SUCCEEDED", amountCents: 4_500, _count: { transactions: 0 }, ...over });
  const child = (over: Parameters<typeof snapshot>[0] = {}) =>
    snapshot({
      booking: { status: "PAID", finalPriceCents: 4_500, organiserSettled: true, parentBookingId: "bk-organiser", ...over.booking },
      payment: over.payment === undefined ? childMirror() : over.payment,
      group: over.group === undefined ? group() : over.group,
    });

  it("is covered by a share the frozen settlement proves", () => {
    expect(deriveBookingCashCover(child())).toEqual({ kind: "covered" });
  });

  it("stays covered after a reduction refunded to the organiser's card", () => {
    const refunded = childMirror({ status: "PARTIALLY_REFUNDED", refundedAmountCents: 1_500 });
    expect(deriveBookingCashCover(child({ booking: { finalPriceCents: 3_000 }, payment: refunded }))).toEqual({ kind: "covered" });
  });

  it("says the organiser pays while the organiser has not, never asking the member", () => {
    for (const status of ["PENDING", "REFUNDED"] as const) {
      const unpaid = child({ booking: { status: "CONFIRMED" }, payment: null, group: group({ settlement: settlement(status) }) });
      expect(deriveBookingCashCover(unpaid)).toEqual({ kind: "organiser_pays" });
    }
    expect(deriveBookingCashCover(child({ payment: null, group: group({ settlement: null }) }))).toEqual({ kind: "organiser_pays" });
  });

  it("is unknown when the shares do not add up to what the settlement collected", () => {
    expect(deriveBookingCashCover(child({ group: group({ siblings: [sibling("bk-1", 4_500)] }) }))).toEqual({
      kind: "unknown",
      reason: "organiser-share-unproven",
    });
  });

  it("is unknown with no group to prove the share from", () => {
    expect(deriveBookingCashCover(child({ group: null }))).toEqual({ kind: "unknown", reason: "organiser-share-unproven" });
  });

  it("leaves a rise after a bank-transfer settle to the organiser; a card child's rise is unproven", () => {
    const bankGroup = group({
      settlement: { ...settlement("SUCCEEDED"), source: "INTERNET_BANKING", stripePaymentIntentId: null },
      siblings: [sibling("bk-1", 4_500, "INTERNET_BANKING"), sibling("bk-2", 4_500, "INTERNET_BANKING")],
    });
    const bankChild = child({ booking: { finalPriceCents: 6_000 }, payment: childMirror({ source: "INTERNET_BANKING" }), group: bankGroup });
    expect(deriveBookingCashCover(bankChild)).toEqual({ kind: "organiser_pays" });
    expect(deriveBookingCashCover(child({ booking: { finalPriceCents: 6_000 } }))).toEqual({ kind: "unknown", reason: "organiser-share-unproven" });
  });

  it("treats a child switched to paying for itself as an ordinary booking", () => {
    const switched = child({ booking: { status: "PAYMENT_PENDING", organiserSettled: false }, payment: null, group: group({ settlement: settlement("PENDING") }) });
    expect(deriveBookingCashCover(switched)).toEqual({ kind: "owes", cents: 4_500 });
  });
});
