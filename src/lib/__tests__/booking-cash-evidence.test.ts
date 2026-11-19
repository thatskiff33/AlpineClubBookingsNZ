/**
 * #4069 (`INV-PAY-159`): the one cash-cover answer, branch by branch, over
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

type Row = CashEvidenceTransactionRow;
const captured = (amountCents: number, over: Partial<Row> = {}): Row => ({
  id: "tx-1",
  stripePaymentIntentId: null,
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
  supersededOwnership?: BookingCashSnapshot["supersededOwnership"];
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
    supersededOwnership: over.supersededOwnership ?? { owning: [], owedAgainByIntent: new Map() },
    group: over.group ?? null,
  };
}

// An operation's frozen plan names the capture each slice refunds (#1097).
const cardRefundOperation = (amountCents: number, status: string, type = "REFUND_BOOKING_MODIFICATION", paymentTransactionId = "tx-1") => ({
  id: `op-${type}-${status}`,
  type,
  status,
  idempotencyKey: `refund-${type}-${status}`,
  amountCents,
  allocationPlan: type === "REFUND_SUPERSEDED_PAYMENT" ? null : [{ paymentTransactionId, amountCents }],
  paymentTransactionId,
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

  it("takes off exactly what Net Collected's cash half takes off for the payment, in every state", () => {
    for (const row of [open, recorded, recordedOperationOpen]) {
      const s = snapshot({ booking: { status: "PAID" }, payment: row });
      const heldCents = getNetCollectedCashParts({ ...row, booking: s.booking }).heldCashCents;
      expect(deriveBookingCashCover(s)).toEqual({ kind: "owes", cents: s.booking.finalPriceCents - heldCents });
    }
  });
});

describe("deriveBookingCashCover: a superseded capture is never cover (blueprint section 2.7)", () => {
  // Worth 50,000. One ordinary 25,000 capture (tx-1) and a superseded intent
  // that captured 25,000 anyway (tx-2), which goes back to the member whole.
  const AFTER = new Date("2026-07-01T00:05:00.000Z");
  const ordinary = captured(25_000, { id: "tx-1", stripePaymentIntentId: "pi_ordinary" });
  const superseded = (over: Partial<Row> = {}) =>
    captured(25_000, { id: "tx-2", kind: "ADDITIONAL", stripePaymentIntentId: "pi_superseded", ...over });
  const cancelRow = { type: "CANCEL_PAYMENT_INTENT" as const, paymentId: "pay-1", paymentTransactionId: "tx-2", amountCents: 25_000, allocationPlan: null };
  const refundRow = (status: string) => cardRefundOperation(25_000, status, "REFUND_SUPERSEDED_PAYMENT", "tx-2");
  const owningRefundRow = { ...cancelRow, type: "REFUND_SUPERSEDED_PAYMENT" as const };
  const refundRecorded = { stripeRefundId: "re_superseded", paymentTransactionId: "tx-2", amountCents: 25_000, status: "succeeded", createdAt: AFTER };
  const refundedCapture = superseded({ status: "REFUNDED", refundedAmountCents: 25_000 });
  const noOwnership = { owning: [], owedAgainByIntent: new Map<string, number>() };
  const paid = (input: NonNullable<Parameters<typeof snapshot>[0]>) => deriveBookingCashCover(snapshot({ ...input, booking: { status: "PAID", ...input.booking } }));

  it("its cancel row still in flight, the refund row not yet written: owes 25,000", () => {
    // The hand-off's committed gap: the capture stands under the cancel row alone.
    expect(
      paid({ payment: payment({ transactions: [ordinary, superseded()] }), supersededOwnership: { owning: [cancelRow], owedAgainByIntent: new Map() } }),
    ).toEqual({ kind: "owes", cents: 25_000 });
  });

  it("the refund row written beside the cancel row: the same 25,000, once", () => {
    expect(
      paid({
        payment: payment({ transactions: [ordinary, superseded()], recoveryOperations: [refundRow("PENDING")] }),
        supersededOwnership: { owning: [cancelRow, owningRefundRow], owedAgainByIntent: new Map() },
      }),
    ).toEqual({ kind: "owes", cents: 25_000 });
  });

  it.each([
    ["recorded, its row not yet closed", "PROCESSING", { owning: [owningRefundRow], owedAgainByIntent: new Map<string, number>() }],
    ["recorded, its row closed", "SUCCEEDED", noOwnership],
  ])("the refund %s: the same 25,000, once", (_label, status, supersededOwnership) => {
    expect(
      paid({
        payment: payment({ status: "PARTIALLY_REFUNDED", transactions: [ordinary, refundedCapture], recoveryOperations: [refundRow(status)], refunds: [refundRecorded] }),
        supersededOwnership,
      }),
    ).toEqual({ kind: "owes", cents: 25_000 });
  });

  it("the refund failed later and is owed again by its own row: the same 25,000, once", () => {
    const owedAgain = { ...refundRow("PENDING"), id: "op-owed-again", idempotencyKey: "card_refund_failed_later_re_superseded", createdAt: AFTER };
    expect(
      paid({
        payment: payment({
          transactions: [ordinary, superseded()],
          recoveryOperations: [refundRow("SUCCEEDED"), owedAgain],
          refunds: [{ ...refundRecorded, status: "failed" }],
        }),
        supersededOwnership: { owning: [], owedAgainByIntent: new Map([["pi_superseded", 25_000]]) },
      }),
    ).toEqual({ kind: "owes", cents: 25_000 });
  });

  it("a separate 10,000 refund owed on the ordinary capture adds to it: owes 35,000", () => {
    expect(
      paid({
        payment: payment({ transactions: [ordinary, superseded()], recoveryOperations: [cardRefundOperation(10_000, "PENDING")] }),
        supersededOwnership: { owning: [cancelRow], owedAgainByIntent: new Map() },
      }),
    ).toEqual({ kind: "owes", cents: 35_000 });
  });

  it("owns only what the capture still holds: a part already refunded is not taken off twice", () => {
    const partRefunded = superseded({ status: "PARTIALLY_REFUNDED", refundedAmountCents: 10_000 });
    expect(
      paid({
        payment: payment({ status: "PARTIALLY_REFUNDED", transactions: [ordinary, partRefunded] }),
        supersededOwnership: { owning: [cancelRow], owedAgainByIntent: new Map() },
      }),
    ).toEqual({ kind: "owes", cents: 25_000 });
  });

  it("a cancel row in flight whose intent never captured owns nothing", () => {
    expect(
      paid({
        booking: { finalPriceCents: 25_000 },
        payment: payment({ transactions: [ordinary, superseded({ status: "PENDING" })] }),
        supersededOwnership: { owning: [cancelRow], owedAgainByIntent: new Map() },
      }),
    ).toEqual({ kind: "covered" });
  });

  it("never takes off more than the payment holds", () => {
    // A hand-back for all the ordinary capture and the cancel-owned capture: nothing is left, and nothing below nothing.
    const tasks = [{ status: "OPEN", kind: "CANCELLED_BOOKING_HAND_BACK", amountCents: 40_000, partPaymentReviewPaymentId: null, occurrenceKey: "edit-refund-hand-back:m-1", reason: "edit refund" }];
    expect(
      paid({
        booking: { manualRefundTasks: tasks },
        payment: payment({ transactions: [ordinary, superseded()] }),
        supersededOwnership: { owning: [cancelRow], owedAgainByIntent: new Map() },
      }),
    ).toEqual({ kind: "owes", cents: 50_000 });
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
    // A refunded status on a payment that is not a card's, with no captured row:
    // a credit note folded into a never-paid bank payment, or cash from before
    // the ledger. The records cannot say which, so it is never "owes the lot".
    ...(["PARTIALLY_REFUNDED", "REFUNDED"] as const).map((status): [string, BookingCashSnapshot, string] => [
      `a ${status} bank mirror no captured row backs`,
      snapshot({
        booking: { status: "CONFIRMED" },
        payment: payment({
          source: "INTERNET_BANKING",
          status,
          amountCents: 50_000,
          refundedAmountCents: status === "REFUNDED" ? 50_000 : 10_000,
          transactions: [captured(50_000, { source: "INTERNET_BANKING", status: "PENDING", reason: "internet_banking_switch_at_pay" })],
        }),
      }),
      "rows-disagree-with-payment",
    ]),
    ["rows that do not sum to the mirror",snapshot({ payment: payment({ transactions: [captured(40_000)], amountCents: 50_000 }) }), "rows-disagree-with-payment"],
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
    ["a dispute for less than the capture", snapshot({ payment: payment({ transactions: [captured(50_000)] }), disputedCaptureCents: 1 }), "disputed"],
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

  // History no current writer leaves; the reader must still refuse to call it
  // covered. A share that adds up proves the share, not the child's refunds.
  describe("a proved share with history it cannot carry (invalid-history inputs)", () => {
    it("is unknown when the child's refunds exceed its share, even at zero price", () => {
      const overRefunded = child({ booking: { finalPriceCents: 0 }, payment: childMirror({ refundedAmountCents: 6_000 }) });
      expect(deriveBookingCashCover(overRefunded)).toEqual({ kind: "unknown", reason: "refunds-unproven" });
    });

    it("is unknown when a REFUNDED mirror records less back than its share", () => {
      const refunded = child({ booking: { finalPriceCents: 0 }, payment: childMirror({ status: "REFUNDED", refundedAmountCents: 1_500 }) });
      expect(deriveBookingCashCover(refunded)).toEqual({ kind: "unknown", reason: "refunds-unproven" });
    });

    it.each([
      ["a legacy backfilled row", captured(4_500, { reason: "legacy_primary_backfill" }), "legacy-history"],
      [
        "a bank receipt holding its stored figure",
        captured(4_500, { source: "INTERNET_BANKING", reason: "internet_banking_switch_at_pay" }),
        "stored-figure-bank-receipt",
      ],
      ["a row refunded above its capture", captured(4_500, { refundedAmountCents: 6_000 }), "refunds-unproven"],
    ])("is unknown when the child carries %s", (_label, row, reason) => {
      const withRow = child({ payment: childMirror({ transactions: [row], _count: { transactions: 1 } }) });
      expect(deriveBookingCashCover(withRow)).toEqual({ kind: "unknown", reason });
    });

    it("still says the organiser pays while unpaid: who pays is proved by the group, not by rows", () => {
      const unpaid = child({
        booking: { status: "CONFIRMED" },
        payment: childMirror({ status: "PENDING", transactions: [captured(4_500, { reason: "legacy_primary_backfill" })] }),
        group: group({ settlement: settlement("PENDING") }),
      });
      expect(deriveBookingCashCover(unpaid)).toEqual({ kind: "organiser_pays" });
    });
  });

  it("stays covered when the whole share went back and the booking is worth nothing", () => {
    const refunded = childMirror({ status: "REFUNDED", refundedAmountCents: 4_500 });
    expect(deriveBookingCashCover(child({ booking: { finalPriceCents: 0 }, payment: refunded, group: group({ settlement: settlement("REFUNDED") }) }))).toEqual({ kind: "covered" });
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

  it("is unknown while the organiser's combined capture is disputed, whatever the share proves", () => {
    // The reader adds the settlement intent's dispute to the snapshot's figure: a child has no capture rows of its own.
    expect(deriveBookingCashCover({ ...child(), disputedCaptureCents: 9_000 })).toEqual({ kind: "unknown", reason: "disputed" });
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
