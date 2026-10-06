/**
 * The census's reading of a group organiser's settlement (#3854): a settled
 * child's share and plan refund agree with its columns and its settlement, a
 * corrupted one disagrees, and the shapes the back-post has not reached yet
 * read as coverage or a named in-flight refund, never as an unexplained
 * disagreement. Rows are built from the real planners.
 */
import { describe, expect, it } from "vitest";

import { planConfirmationChargeLines } from "@/lib/booking-ledger-confirmation-posting";
import { groupChildHandBacksFromRows, planGroupChildLines } from "@/lib/booking-ledger-group-child-plan";
import { planGroupSettlementRefundLine, planGroupSettlementShareLines } from "@/lib/booking-ledger-group-settlement-posting";
import { planCancellationChargeLines } from "@/lib/booking-ledger-cancellation-posting";
import { refundKey } from "@/lib/booking-ledger-posting-keys";
import { isPaymentRecoveryOperationInFlight } from "@/lib/payment-recovery-constants";
import { buildOrganiserChildCancellationRefundKey } from "@/lib/payment-recovery-keys";
import { summarizeBookingLedgerCensus } from "@/lib/booking-ledger-projection-census-report";
import { evaluateBookingLedgerIdentities } from "@/lib/booking-ledger-projection-census";
import { plannedGroupChildLines } from "@/lib/booking-ledger-projection-census-group";
import type { BookingLedgerCensusRow, CensusLedgerLine } from "@/lib/booking-ledger-projection-census-row";
import { ledgerLineAmountCents, type BookingLedgerPosting } from "@/lib/booking-ledger-write";

const B = "child-1";
const PI = "pi-group";
const D1 = new Date("2027-09-01T00:00:00.000Z");
const D2 = new Date("2027-09-02T00:00:00.000Z");
const LATER = new Date("2027-08-01T00:00:00.000Z");
let seq = 0;

function toLines(postings: readonly BookingLedgerPosting[]): CensusLedgerLine[] {
  return postings.map((posting) => ({
    id: `line-${(seq += 1)}`,
    side: posting.side,
    kind: posting.kind,
    sign: posting.sign,
    quantity: posting.quantity,
    unitCents: posting.unitCents,
    amountCents: ledgerLineAmountCents(posting),
    bookingGuestId: posting.bookingGuestId ?? null,
    nightStart: posting.nightStart ?? null,
    nightEndExclusive: posting.nightEndExclusive ?? null,
    anchorKind: posting.anchorKind,
    anchorId: posting.anchorId,
    settlementMethod: posting.settlementMethod ?? null,
    reversesLineId: posting.reversesLineId ?? null,
    postingKey: posting.postingKey,
    postedAt: new Date(1_000 * seq),
  }));
}

/** The child's night rows: one guest, two nights at $22.50. */
const PRICING = {
  id: B,
  lodgeId: "l1",
  totalPriceCents: 4_500,
  promoAdjustmentCents: 0,
  guests: [
    {
      id: "g1",
      firstName: "Joiner",
      lastName: "One",
      ageTier: "ADULT" as const,
      rateMembershipTypeId: null,
      nights: [
        { stayDate: D1, priceCents: 2_250 },
        { stayDate: D2, priceCents: 2_250 },
      ],
    },
  ],
};

/** A $45 child its organiser settled, confirmed and its share posted by the settle's own planners. */
function settledChild(source: "STRIPE" | "INTERNET_BANKING"): { row: BookingLedgerCensusRow; settlement: { id: string; source: typeof source } } {
  const settlement = { id: "gs1", source };
  const charges = planConfirmationChargeLines(PRICING).postings;
  const share = planGroupSettlementShareLines({
    settlement: { ...settlement, amountCents: 4_500 },
    children: [{ bookingId: B, lodgeId: "l1", shareCents: 4_500 }],
  }).postings;
  return {
    settlement,
    row: {
      booking: { id: B, status: "PAID", deletedAt: null, organiserSettled: true, finalPriceCents: 4_500 },
      payment: {
        id: "pay-1",
        source,
        status: "SUCCEEDED",
        amountCents: 4_500,
        creditAppliedCents: 0,
        refundedAmountCents: 0,
        changeFeeCents: 0,
        additionalAmountCents: 0,
        additionalPaymentStatus: null,
        xeroInvoiceId: null,
        manuallyMarkedPaidAt: null,
      },
      transactions: [],
      refunds: [],
      credits: [],
      tasks: [],
      modifications: [],
      recoveryOperations: [],
      cancellation: null,
      groupSettlement: { id: "gs1", source, status: "SUCCEEDED", amountCents: 4_500, stripePaymentIntentId: source === "STRIPE" ? PI : null, refundPlan: null, refundRecoveryInFlight: false },
      groupChild: null,
      lines: toLines([...charges, ...share]),
    },
  };
}

/** The organiser cancel under a mirror plan: the refund beside the mirror, the stay reversed, the rest kept. */
function cancelledUnderPlan(source: "STRIPE" | "INTERNET_BANKING", options: { refundPosted: boolean }): BookingLedgerCensusRow {
  const { row, settlement } = settledChild(source);
  const refund = planGroupSettlementRefundLine({ settlement, bookingId: B, lodgeId: "l1", refundCents: 2_250 });
  const cancellation = planCancellationChargeLines({
    bookingId: B,
    lodgeId: "l1",
    keptCents: 2_250,
    chargeLines: row.lines
      .filter((line) => line.kind === "GUEST_NIGHT")
      .map((line) => ({ ...line, kind: "GUEST_NIGHT" as const, sign: line.sign === -1 ? -1 : 1, rateMembershipTypeId: null, ageTier: "ADULT", guestNames: ["Joiner One"], narration: "night" })),
    adjustmentLines: [],
  });
  if (cancellation.kind !== "lines") throw new Error("expected cancellation lines");
  return {
    ...row,
    booking: { ...row.booking, status: "CANCELLED" },
    payment: { ...row.payment!, status: "PARTIALLY_REFUNDED", refundedAmountCents: options.refundPosted ? 2_250 : 0 },
    groupSettlement: { ...row.groupSettlement!, refundPlan: { [B]: 2_250 }, refundRecoveryInFlight: !options.refundPosted },
    lines: [...row.lines, ...toLines([...(options.refundPosted && refund ? [refund] : []), ...cancellation.postings])],
  };
}

const statuses = (subject: BookingLedgerCensusRow) =>
  Object.fromEntries(evaluateBookingLedgerIdentities(subject).identities.map((result) => [result.identity, result.status]));
const integrity = (subject: BookingLedgerCensusRow) => evaluateBookingLedgerIdentities(subject).integrity.map((finding) => finding.kind);

describe("the census on a group-settled child (#3854)", () => {
  it.each(["STRIPE", "INTERNET_BANKING"] as const)("a %s settlement's child agrees on every identity, with no integrity finding", (source) => {
    const { row } = settledChild(source);
    expect(statuses(row)).toMatchObject({ PRICE: "AGREE", CAPTURED: "AGREE", REFUNDED: "AGREE", OWED: "AGREE" });
    expect(integrity(row)).toEqual([]);
    expect(evaluateBookingLedgerIdentities(row).bookingClass).toBeNull();
  });

  it("a share that no longer matches the child's payment, or under another settlement, is SOURCE_DRIFT", () => {
    const { row } = settledChild("STRIPE");
    expect(integrity({ ...row, payment: { ...row.payment!, amountCents: 4_400 } })).toContain("SOURCE_DRIFT");
    expect(integrity({ ...row, groupSettlement: { ...row.groupSettlement!, id: "gs-other" } })).toContain("SOURCE_DRIFT");
    expect(integrity({ ...row, groupSettlement: { ...row.groupSettlement!, status: "FAILED" } })).toContain("SOURCE_DRIFT");
  });

  it("an Internet Banking plan's BANK_REFUND counts on REFUNDED, and the cancelled child's owed(b) is zero", () => {
    const subject = cancelledUnderPlan("INTERNET_BANKING", { refundPosted: true });
    expect(statuses(subject)).toMatchObject({ PRICE: "AGREE", CAPTURED: "AGREE", REFUNDED: "AGREE" });
    expect(integrity(subject)).toEqual([]);
  });

  it("a plan refund line that disagrees with the frozen plan is SOURCE_DRIFT", () => {
    const subject = cancelledUnderPlan("INTERNET_BANKING", { refundPosted: true });
    expect(integrity({ ...subject, groupSettlement: { ...subject.groupSettlement!, refundPlan: { [B]: 2_000 } } })).toContain("SOURCE_DRIFT");
  });

  it("a pre-#3653 card plan whose one group retry is still in flight names the child's share of it IN_FLIGHT_REFUND", () => {
    const subject = cancelledUnderPlan("STRIPE", { refundPosted: false });
    const price = evaluateBookingLedgerIdentities(subject).identities.find((result) => result.identity === "PRICE")!;
    expect(price).toMatchObject({ status: "CLASSIFIED", deltaCents: 2_250, explainedBy: [{ name: "IN_FLIGHT_REFUND", cents: 2_250 }] });
    // Without the retry in flight, the same gap is a disagreement.
    expect(statuses({ ...subject, groupSettlement: { ...subject.groupSettlement!, refundRecoveryInFlight: false } }).PRICE).toBe("DISAGREE");
  });

  it("a child settled before #3854 that holds only a #3653 refund line is coverage, not a PRICE disagreement", () => {
    const { row } = settledChild("STRIPE");
    const refundLine = toLines([
      {
        bookingId: B,
        lodgeId: "l1",
        side: "SETTLEMENT",
        kind: "CARD_REFUND",
        sign: -1,
        quantity: 1,
        unitCents: 2_250,
        anchorKind: "PAYMENT_REFUND",
        anchorId: "re-1",
        settlementMethod: "CARD",
        narration: "Card refund",
        postingKey: refundKey("re-1"),
      },
    ]);
    const subject: BookingLedgerCensusRow = {
      ...row,
      booking: { ...row.booking, status: "CANCELLED" },
      payment: { ...row.payment!, refundedAmountCents: 2_250, status: "PARTIALLY_REFUNDED" },
      refunds: [{ id: "re-1", status: "succeeded", amountCents: 2_250, paymentTransactionId: null }],
      lines: refundLine,
    };
    const result = evaluateBookingLedgerIdentities(subject);
    expect(result.identities.find((identity) => identity.identity === "PRICE")).toMatchObject({ status: "COVERAGE" });
    expect(result.coverage).toContain("NOT_CONFIRMED_ON_LEDGER");
  });
});

// ---------------------------------------------------------------------------
// #3854's delta review: F1, K1, K2
// ---------------------------------------------------------------------------

type Op = BookingLedgerCensusRow["recoveryOperations"][number];

/** The #3653 debt the organiser cancel wrote for this child, in the state given. */
function childDebt(cents: number, state: Pick<Op, "status" | "attempts" | "nextRetryAt">): Op {
  return {
    type: "REFUND_BOOKING_MODIFICATION",
    ...state,
    amountCents: cents,
    idempotencyKey: buildOrganiserChildCancellationRefundKey("gs1", B),
    paymentId: "pay-1",
    paymentIntentId: PI,
  };
}

const PENDING = { status: "PENDING", attempts: 0, nextRetryAt: LATER } as const;
const RETRYING = { status: "FAILED", attempts: 2, nextRetryAt: LATER } as const;
const EXHAUSTED = { status: "FAILED", attempts: 5, nextRetryAt: null } as const;

/**
 * A child settled by card before #3854, holding no line, that its organiser
 * cancelled under #3653's per-child plan with `refundCents` owed back to it as a
 * debt (none made yet): the census plans its lines from the snapshot's evidence.
 */
function offLedgerCancelledChild(refundCents: number, debt: Pick<Op, "status" | "attempts" | "nextRetryAt"> | null): BookingLedgerCensusRow {
  const { row } = settledChild("STRIPE");
  return {
    ...row,
    booking: { ...row.booking, status: "CANCELLED" },
    groupSettlement: { ...row.groupSettlement!, refundPlan: { perChildRefunds: { [B]: refundCents } } },
    recoveryOperations: debt ? [childDebt(refundCents, debt)] : [],
    groupChild: {
      pricing: PRICING,
      siblings: [{ id: B, lodgeId: "l1", payment: { amountCents: 4_500, status: "SUCCEEDED", source: "STRIPE" } }],
      cancelledWithoutSnapshot: true,
      snapshotKept: null,
    },
    lines: [],
  };
}

const census = (rows: BookingLedgerCensusRow[]) => summarizeBookingLedgerCensus(rows.map(evaluateBookingLedgerIdentities), null, []);

describe("F1: GROUP_SETTLEMENT_OFF_LEDGER only where the back-post's planned lines would agree (#3854)", () => {
  it("a settled child whose planned confirmation and share agree is in the class, and the gate stays open", () => {
    const { row } = settledChild("STRIPE");
    const subject = { ...row, lines: [], groupChild: { pricing: PRICING, siblings: [{ id: B, lodgeId: "l1", payment: { amountCents: 4_500, status: "SUCCEEDED", source: "STRIPE" as const } }], cancelledWithoutSnapshot: false, snapshotKept: null } };
    expect(evaluateBookingLedgerIdentities(subject)).toMatchObject({ bookingClass: "GROUP_SETTLEMENT_OFF_LEDGER", coverage: [], info: { groupSettlementUnpostable: null } });
    expect(census([subject]).verdict).toBe("GATE_OPEN");
  });

  it("an organiser cancel that refunds the child nothing: kept is the whole share, the planned lines agree, still in the class", () => {
    const subject = offLedgerCancelledChild(0, null);
    expect(evaluateBookingLedgerIdentities(subject)).toMatchObject({ bookingClass: "GROUP_SETTLEMENT_OFF_LEDGER", coverage: [] });
  });

  it("the review's scenario: a 100% #3653 refund whose retry is exhausted, never paid, holds the gate (unsignable), live", () => {
    const subject = offLedgerCancelledChild(4_500, EXHAUSTED);
    const evaluation = evaluateBookingLedgerIdentities(subject);
    expect(evaluation).toMatchObject({ bookingClass: null, coverage: ["GROUP_SETTLEMENT_UNPOSTABLE"], info: { groupSettlementUnpostable: "POSTS_NOT_AGREEING" } });
    const report = census([subject]);
    expect(report.info.groupSettlementUnpostable).toEqual({ REFUSED: [], POSTS_WITH_CLASS: [], POSTS_NOT_AGREEING: [B] });
    expect(report.classes.GROUP_SETTLEMENT_OFF_LEDGER.bookings).toBe(0);
    expect(report.verdict).toBe("GATE_CLOSED");
    expect(report.gateClosedBecause).toEqual(["1 booking(s) with coverage gap GROUP_SETTLEMENT_UNPOSTABLE"]);
  });

  it("a refund still in flight is not waved through either: once posted it is a class the owner acknowledges, so until then it holds", () => {
    for (const state of [PENDING, RETRYING]) {
      const evaluation = evaluateBookingLedgerIdentities(offLedgerCancelledChild(4_500, state));
      expect(evaluation.coverage, state.status).toEqual(["GROUP_SETTLEMENT_UNPOSTABLE"]);
      // Not refused: the back-post posts it, then the owner acknowledges the class.
      expect(evaluation.info.groupSettlementUnpostable, state.status).toBe("POSTS_WITH_CLASS");
    }
    expect(census([offLedgerCancelledChild(4_500, PENDING)]).info.groupSettlementUnpostable).toEqual({ REFUSED: [], POSTS_WITH_CLASS: [B], POSTS_NOT_AGREEING: [] });
  });

  it("shares that do not add up to what the settlement collected hold the gate", () => {
    const { row } = settledChild("STRIPE");
    const subject = {
      ...row,
      lines: [],
      groupChild: {
        pricing: PRICING,
        siblings: [
          { id: B, lodgeId: "l1", payment: { amountCents: 4_500, status: "SUCCEEDED", source: "STRIPE" as const } },
          { id: "child-2", lodgeId: "l1", payment: { amountCents: 1, status: "SUCCEEDED", source: "STRIPE" as const } },
        ],
        cancelledWithoutSnapshot: false,
        snapshotKept: null,
      },
    };
    expect(evaluateBookingLedgerIdentities(subject)).toMatchObject({ bookingClass: null, coverage: ["GROUP_SETTLEMENT_UNPOSTABLE"], info: { groupSettlementUnpostable: "REFUSED" } });
  });

  it("night rows that do not make the price, or an unreadable snapshot on a cancelled child, hold the gate", () => {
    const { row } = settledChild("STRIPE");
    const evidence = { pricing: PRICING, siblings: [{ id: B, lodgeId: "l1", payment: { amountCents: 4_500, status: "SUCCEEDED", source: "STRIPE" as const } }], cancelledWithoutSnapshot: false, snapshotKept: null };
    const unpriced = { ...row, lines: [], groupChild: { ...evidence, pricing: { ...PRICING, guests: [{ ...PRICING.guests[0]!, nights: [{ stayDate: D1, priceCents: null }] }] } } };
    expect(evaluateBookingLedgerIdentities(unpriced)).toMatchObject({ coverage: ["GROUP_SETTLEMENT_UNPOSTABLE"], info: { groupSettlementUnpostable: "REFUSED" } });
    const unreadable = { ...offLedgerCancelledChild(0, null), groupChild: { ...evidence, cancelledWithoutSnapshot: false, snapshotKept: null } };
    expect(evaluateBookingLedgerIdentities(unreadable)).toMatchObject({ coverage: ["GROUP_SETTLEMENT_UNPOSTABLE"], info: { groupSettlementUnpostable: "REFUSED" } });
  });
});

/** The same child after the back-post: confirmation, share, and the cancellation keeping nothing. */
function backPostedCancelledChild(debt: Pick<Op, "status" | "attempts" | "nextRetryAt">): BookingLedgerCensusRow {
  const { row } = settledChild("STRIPE");
  const cancellation = planCancellationChargeLines({
    bookingId: B,
    lodgeId: "l1",
    keptCents: 0,
    chargeLines: row.lines
      .filter((line) => line.kind === "GUEST_NIGHT")
      .map((line) => ({ ...line, kind: "GUEST_NIGHT" as const, sign: line.sign === -1 ? -1 : 1, rateMembershipTypeId: null, ageTier: "ADULT", guestNames: ["Joiner One"], narration: "night" })),
    adjustmentLines: [],
  });
  if (cancellation.kind !== "lines") throw new Error("expected cancellation lines");
  return {
    ...offLedgerCancelledChild(4_500, debt),
    groupChild: null,
    lines: [...row.lines, ...toLines(cancellation.postings)],
  };
}

describe("K1: a FAILED refund the runner will retry is in flight; an exhausted one is not (#3854)", () => {
  it("the one predicate: PENDING, PROCESSING, and FAILED with a retry scheduled and attempts left", () => {
    expect(isPaymentRecoveryOperationInFlight({ status: "PENDING", attempts: 0, nextRetryAt: LATER })).toBe(true);
    expect(isPaymentRecoveryOperationInFlight({ status: "PROCESSING", attempts: 5, nextRetryAt: null })).toBe(true);
    expect(isPaymentRecoveryOperationInFlight({ status: "FAILED", attempts: 4, nextRetryAt: LATER })).toBe(true);
    expect(isPaymentRecoveryOperationInFlight({ status: "FAILED", attempts: 5, nextRetryAt: LATER })).toBe(false);
    expect(isPaymentRecoveryOperationInFlight({ status: "FAILED", attempts: 1, nextRetryAt: null })).toBe(false);
    expect(isPaymentRecoveryOperationInFlight({ status: "SUCCEEDED", attempts: 1, nextRetryAt: null })).toBe(false);
  });

  it("a back-posted child whose #3653 refund is pending or retrying names it IN_FLIGHT_REFUND; exhausted, it disagrees", () => {
    for (const state of [PENDING, RETRYING]) {
      const price = evaluateBookingLedgerIdentities(backPostedCancelledChild(state)).identities.find((result) => result.identity === "PRICE");
      expect(price, `${state.status}/${state.attempts}`).toMatchObject({ status: "CLASSIFIED", explainedBy: [{ name: "IN_FLIGHT_REFUND", cents: 4_500 }] });
    }
    const exhausted = evaluateBookingLedgerIdentities(backPostedCancelledChild(EXHAUSTED));
    expect(exhausted.identities.find((result) => result.identity === "PRICE")).toMatchObject({ status: "DISAGREE", deltaCents: 4_500 });
    expect(census([backPostedCancelledChild(EXHAUSTED)]).verdict).toBe("GATE_CLOSED");
  });
});

describe("K2: a share's evidence is that the settlement captured, a REFUNDED one included (#3854)", () => {
  it("a child of a settlement an organiser cancel refunded in full agrees, live and back-posted", () => {
    // Live (or back-posted, the same lines): the share and the plan's whole refund beside it, nothing kept.
    const { row, settlement } = settledChild("INTERNET_BANKING");
    const refund = planGroupSettlementRefundLine({ settlement, bookingId: B, lodgeId: "l1", refundCents: 4_500 })!;
    const cancellation = planCancellationChargeLines({
      bookingId: B,
      lodgeId: "l1",
      keptCents: 0,
      chargeLines: row.lines
        .filter((line) => line.kind === "GUEST_NIGHT")
        .map((line) => ({ ...line, kind: "GUEST_NIGHT" as const, sign: line.sign === -1 ? -1 : 1, rateMembershipTypeId: null, ageTier: "ADULT", guestNames: ["Joiner One"], narration: "night" })),
      adjustmentLines: [],
    });
    if (cancellation.kind !== "lines") throw new Error("expected cancellation lines");
    const subject: BookingLedgerCensusRow = {
      ...row,
      booking: { ...row.booking, status: "CANCELLED" },
      payment: { ...row.payment!, status: "REFUNDED", refundedAmountCents: 4_500 },
      groupSettlement: { ...row.groupSettlement!, status: "REFUNDED", refundPlan: { [B]: 4_500 } },
      lines: [...row.lines, ...toLines([refund, ...cancellation.postings])],
    };
    expect(statuses(subject)).toMatchObject({ PRICE: "AGREE", CAPTURED: "AGREE", REFUNDED: "AGREE" });
    expect(integrity(subject)).toEqual([]);
    // A settled, uncancelled child under a REFUNDED settlement: the share still stands.
    const settled = settledChild("STRIPE").row;
    expect(integrity({ ...settled, groupSettlement: { ...settled.groupSettlement!, status: "REFUNDED" } })).toEqual([]);
    // A settlement that never captured is still drift.
    for (const status of ["PENDING", "FAILED"] as const) {
      expect(integrity({ ...settled, groupSettlement: { ...settled.groupSettlement!, status } }), status).toContain("SOURCE_DRIFT");
    }
  });

  it("before the back-post, a child with no lines under a REFUNDED settlement is planned to agree, so it is in the class", () => {
    const { row } = settledChild("STRIPE");
    const subject = {
      ...row,
      lines: [],
      groupSettlement: { ...row.groupSettlement!, status: "REFUNDED" as const },
      groupChild: { pricing: PRICING, siblings: [{ id: B, lodgeId: "l1", payment: { amountCents: 4_500, status: "SUCCEEDED", source: "STRIPE" as const } }], cancelledWithoutSnapshot: false, snapshotKept: null },
    };
    expect(evaluateBookingLedgerIdentities(subject)).toMatchObject({ bookingClass: "GROUP_SETTLEMENT_OFF_LEDGER", coverage: [] });
  });
});

// ---------------------------------------------------------------------------
// #3854 sync lens F1: an appeal after the organiser cancel is not the cancel's
// ---------------------------------------------------------------------------

describe("sync lens F1: a refund appeal approved after the organiser cancel leaves the planned kept figure alone (#3854)", () => {
  // The lens's probe: a $45 Internet Banking child settled before #3854, its
  // organiser cancel's 50% plan mirrored ($22.50 back, $22.50 kept). The member
  // then appeals and the admin approves $10, which goes back by bank transfer.
  const settlement = { id: "gs1", source: "INTERNET_BANKING" as const, amountCents: 4_500, stripePaymentIntentId: null, refundPlan: { [B]: 2_250 } };
  const child = { id: B, lodgeId: "l1", status: "CANCELLED" as const, cancelledWithoutSnapshot: true };
  const siblings = [{ id: B, lodgeId: "l1", payment: { amountCents: 4_500, status: "PARTIALLY_REFUNDED", source: "INTERNET_BANKING" as const } }];
  const task = (status: "OPEN" | "COMPLETED" | "DISMISSED", occurrenceKey: string, amountCents: number) => ({
    kind: "CANCELLED_BOOKING_HAND_BACK" as const,
    status,
    occurrenceKey,
    paymentId: "pay-1",
    amountCents,
  });
  const kept = (refundedAmountCents: number, tasks: ReturnType<typeof task>[]) => {
    const plan = planGroupChildLines({
      child,
      settlement,
      siblings,
      perChildCommittedRefundCents: null,
      payment: { status: "PARTIALLY_REFUNDED", source: "INTERNET_BANKING", amountCents: 4_500, refundedAmountCents },
      handBacks: groupChildHandBacksFromRows("pay-1", tasks),
    });
    if (plan?.kind !== "plan") throw new Error("expected a plan");
    return plan.cancellationKeptCents;
  };
  const appeal = "refund-request-hand-back:rr1";

  it("kept stays the cancel's $22.50 with no appeal, the appeal open, the appeal paid, or the appeal dismissed", () => {
    expect(kept(2_250, [])).toBe(2_250);
    expect(kept(2_250, [task("OPEN", appeal, 1_000)])).toBe(2_250);
    // Paid: the completion moved `refundedAmountCents` by the $10; it posts its own refund.
    expect(kept(3_250, [task("COMPLETED", appeal, 1_000)])).toBe(2_250);
    expect(kept(2_250, [task("DISMISSED", appeal, 1_000)])).toBe(2_250);
  });

  it("#3827 unchanged: an edit refund hand-back open at the cancel is netted, open or paid since", () => {
    const edit = "edit-refund-hand-back:m1";
    expect(kept(2_250, [task("OPEN", edit, 1_000)])).toBe(1_250);
    expect(kept(3_250, [task("COMPLETED", edit, 1_000)])).toBe(1_250);
    // Both at once: the edit's is the cancel's, the appeal's is not.
    expect(kept(4_250, [task("COMPLETED", edit, 1_000), task("COMPLETED", appeal, 1_000)])).toBe(1_250);
  });

  it("a paid appeal never stands in for an unwritten mirror: the plan's share is still added", () => {
    // Defensive: refunds made since the cancel that are the appeal's say nothing about the mirror.
    expect(kept(1_000, [task("COMPLETED", appeal, 1_000)])).toBe(2_250);
  });

  it("the census plans the same, and once the back-post posts it the child agrees: no in-flight or dismissed hand-back to acknowledge", () => {
    const { row } = settledChild("INTERNET_BANKING");
    for (const status of ["OPEN", "DISMISSED"] as const) {
      // A pre-#3854 child with its mirror written holds no line (`NO_LINES`, which the back-post clears).
      const subject: BookingLedgerCensusRow = {
        ...row,
        booking: { ...row.booking, status: "CANCELLED" },
        payment: { ...row.payment!, status: "PARTIALLY_REFUNDED", refundedAmountCents: 2_250 },
        groupSettlement: { ...row.groupSettlement!, refundPlan: { [B]: 2_250 } },
        tasks: [{ id: "t1", ...task(status, appeal, 1_000), settlementDirection: null, lateCaptureApprovalIntentId: null }],
        groupChild: { pricing: PRICING, siblings, cancelledWithoutSnapshot: true, snapshotKept: null },
        lines: [],
      };
      const planned = plannedGroupChildLines(subject);
      expect(planned?.filter((line) => line.kind === "CANCELLATION_FEE").map((line) => line.amountCents), status).toEqual([2_250]);
      const posted = evaluateBookingLedgerIdentities({ ...subject, lines: planned! });
      expect(posted, status).toMatchObject({ coverage: [], integrity: [], bookingInstances: [] });
      expect(posted.identities.map((identity) => [identity.identity, identity.status]), status).toEqual(
        posted.identities.map((identity) => [identity.identity, identity.status === "NOT_APPLICABLE" ? "NOT_APPLICABLE" : "AGREE"]),
      );
    }
  });
});
