/**
 * The booking-ledger projection census (#3583, `INV-MONEY-037`): the six
 * identities of design §6 and the live owed(b) identity, each proved three
 * ways — a booking whose lines the REAL planners wrote agrees; a one-cent
 * mutation either way of a line, and of a column, is a disagreement naming
 * the booking, both figures and the delta; and every named class's fixture
 * lands in its class, while the same fixture a cent either way, or with one
 * piece of its evidence removed, is a generic disagreement. Then coverage,
 * integrity, paging, acknowledgements and the verdict.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { planCancellationChargeLines } from "@/lib/booking-ledger-cancellation-posting";
import { planConfirmationChargeLines } from "@/lib/booking-ledger-confirmation-posting";
import { planCreditLines, planHandBackLine } from "@/lib/booking-ledger-credit-posting";
import { planAgreedAdjustmentLine, planModificationChargeLines } from "@/lib/booking-ledger-modification-posting";
import { agreedGiveBackKey } from "@/lib/booking-ledger-posting-keys";
import { evaluateBookingLedgerIdentities, postConfirmationEditsWithoutLines, type BookingLedgerIdentity } from "@/lib/booking-ledger-projection-census";
import {
  BOOKING_LEDGER_ACKNOWLEDGEMENT_FILE,
  draftBookingLedgerAcknowledgements,
  summarizeBookingLedgerCensus,
} from "@/lib/booking-ledger-projection-census-report";
import { evaluateBookingLedgerPages } from "@/lib/booking-ledger-projection-census-store";
import { BOOKING_LEDGER_CENSUS_GATE_POLICY } from "@/lib/booking-ledger-projection-census-classes";
import type { BookingLedgerCensusRow, CensusLedgerLine } from "@/lib/booking-ledger-projection-census-row";
import { planSettlementLines, type PostedSettlementLine } from "@/lib/booking-ledger-settlement-posting";
import { buildBookingLedgerRows, type BookingLedgerPosting } from "@/lib/booking-ledger-write";
import type { ModificationPricingSide } from "@/lib/booking-modification-lines";
import type { ReversibleChargeLine } from "@/lib/booking-ledger-charge-line";
import { cancellationCreditDescription } from "@/lib/cancellation-settled-money";
import { editReviewHandBackLinesWhere, isEditReviewHandBackLine } from "@/lib/edit-financial-review-charge-shape";
import { buildBookingCancellationRefundIdempotencyKey, buildEditFinancialReviewRefundRecoveryIdempotencyKey } from "@/lib/payment-recovery-keys";
import { realElapsedMs } from "@/lib/__tests__/helpers/clock";

const B = "bk-3583";
const LODGE = "lodge-3583";
const D1 = new Date("2026-08-01T00:00:00.000Z");
const D2 = new Date("2026-08-02T00:00:00.000Z");
const CONFIRMED_AT = new Date("2026-06-01T00:00:00.000Z");
const LATER = new Date("2026-06-10T00:00:00.000Z");
const EARLIER = new Date("2026-05-20T00:00:00.000Z");

type Line = CensusLedgerLine & Omit<ReversibleChargeLine, "kind" | "sign"> & { narration: string };

/** The ledger table in memory: each planner's postings, validated by the real door, given ids. */
class Ledger {
  lines: Line[] = [];
  post(postings: readonly BookingLedgerPosting[], postedAt = CONFIRMED_AT): this {
    for (const row of buildBookingLedgerRows(postings)) {
      this.lines.push({
        id: `line-${this.lines.length + 1}`,
        side: row.side,
        kind: row.kind,
        sign: row.sign,
        quantity: row.quantity,
        unitCents: row.unitCents,
        amountCents: row.amountCents,
        bookingGuestId: row.bookingGuestId ?? null,
        nightStart: (row.nightStart as Date | null) ?? null,
        nightEndExclusive: (row.nightEndExclusive as Date | null) ?? null,
        rateMembershipTypeId: row.rateMembershipTypeId ?? null,
        ageTier: row.ageTier ?? null,
        guestNames: [...((row.guestNames as string[] | undefined) ?? [])],
        anchorKind: row.anchorKind,
        anchorId: row.anchorId,
        settlementMethod: row.settlementMethod ?? null,
        reversesLineId: row.reversesLineId ?? null,
        postingKey: row.postingKey ?? null,
        narration: row.narration,
        postedAt,
      });
    }
    return this;
  }
  reversible(): ReversibleChargeLine[] {
    return this.lines
      .filter((line) => line.kind === "GUEST_NIGHT" || line.kind === "PROMOTION" || line.kind === "CHANGE_FEE")
      .map((line) => ({ ...line, kind: line.kind as ReversibleChargeLine["kind"], sign: line.sign === -1 ? -1 : 1 }));
  }
  settlementPosted(): PostedSettlementLine[] {
    return this.lines
      .filter((line) => line.anchorKind === "PAYMENT_TRANSACTION" || line.anchorKind === "PAYMENT_REFUND")
      .map((line) => ({ ...line, sign: line.sign === -1 ? -1 : 1 }));
  }
  adjustments() {
    return this.lines
      .filter((line) => line.kind === "AGREED_ADJUSTMENT")
      .map((line) => ({ ...line, sign: line.sign === -1 ? (-1 as const) : (1 as const) }));
  }
}

const GUESTS = ["g1", "g2"].map((id) => ({
  id,
  firstName: "Census",
  lastName: id,
  ageTier: "ADULT" as const,
  rateMembershipTypeId: null,
  nights: [
    { stayDate: D1, priceCents: 5_000 },
    { stayDate: D2, priceCents: 5_000 },
  ],
}));

/** Two guests, two nights at $50, a $10 promotion: a $190 booking, confirmed by the settle's planner. */
function confirmedLedger(promoAdjustmentCents = -1_000): Ledger {
  const plan = planConfirmationChargeLines({ id: B, lodgeId: LODGE, totalPriceCents: 20_000, promoAdjustmentCents, guests: GUESTS });
  return new Ledger().post(plan.postings);
}

type Txn = BookingLedgerCensusRow["transactions"][number];
function txn(id: string, amountCents: number, overrides: Partial<Txn> = {}): Txn {
  return { id, kind: "PRIMARY", status: "SUCCEEDED", source: "STRIPE", xeroInvoiceId: null, amountCents, refundedAmountCents: 0, reason: null, withdrawnAt: null, createdAt: CONFIRMED_AT, ...overrides };
}

/** Post what the settlement sync would, from these rows, onto the ledger. */
function settle(ledger: Ledger, row: Pick<BookingLedgerCensusRow, "transactions" | "refunds" | "payment">, manuallySettled = false, at = CONFIRMED_AT): void {
  const plan = planSettlementLines({
    bookingId: B,
    lodgeId: LODGE,
    manuallySettled,
    manualActorMemberId: manuallySettled ? "officer" : null,
    transactions: row.transactions.map((t) => ({ id: t.id, source: row.payment?.source ?? "STRIPE", status: t.status, amountCents: t.amountCents })),
    refunds: row.refunds,
    postedLines: ledger.settlementPosted(),
  });
  ledger.post(plan.postings, at);
}

function credits(ledger: Ledger, rows: BookingLedgerCensusRow["credits"]): void {
  const plan = planCreditLines({
    bookingId: B,
    lodgeId: LODGE,
    credits: rows,
    postedLines: ledger.lines.map((line) => ({ postingKey: line.postingKey, amountCents: line.amountCents })),
  });
  ledger.post(plan.postings);
}

function credit(id: string, type: BookingLedgerCensusRow["credits"][number]["type"], amountCents: number, extra: Partial<BookingLedgerCensusRow["credits"][number]> = {}) {
  return {
    id,
    type,
    amountCents,
    sourceBookingId: type === "BOOKING_APPLIED" ? null : B,
    appliedToBookingId: type === "BOOKING_APPLIED" ? B : null,
    restoredFromBookingId: null,
    description: "credit",
    xeroCreditNoteId: null,
    ...extra,
  };
}

function payment(overrides: Partial<NonNullable<BookingLedgerCensusRow["payment"]>> = {}): NonNullable<BookingLedgerCensusRow["payment"]> {
  return {
    id: "pay-3583",
    source: "STRIPE",
    status: "SUCCEEDED",
    amountCents: 19_000,
    creditAppliedCents: 0,
    refundedAmountCents: 0,
    changeFeeCents: 0,
    additionalAmountCents: 0,
    additionalPaymentStatus: null,
    xeroInvoiceId: null,
    manuallyMarkedPaidAt: null,
    ...overrides,
  };
}

function row(overrides: Partial<BookingLedgerCensusRow> & { lines: CensusLedgerLine[] }): BookingLedgerCensusRow {
  return {
    booking: { id: B, status: "PAID", deletedAt: null, organiserSettled: false, finalPriceCents: 19_000 },
    payment: payment(),
    transactions: [],
    refunds: [],
    credits: [],
    tasks: [],
    modifications: [],
    recoveryOperations: [],
    cancellation: null,
    ...overrides,
  };
}

function identity(subject: BookingLedgerCensusRow, name: BookingLedgerIdentity) {
  return evaluateBookingLedgerIdentities(subject).identities.find((result) => result.identity === name)!;
}

function guestSide(id: string, nights: Array<[Date, number]>): ModificationPricingSide["guests"][number] {
  return { guestKey: id, ageTier: "ADULT", isMember: true, rateMembershipTypeId: null, name: `Census ${id}`, nights: nights.map(([stayDate, priceCents]) => ({ stayDate, priceCents, priceSource: "SOLD" as const })) };
}

// ---------------------------------------------------------------------------
// Real-planner fixtures, one per identity's interesting case
// ---------------------------------------------------------------------------

/** A $190 booking paid in full by card. */
function cardPaid(): BookingLedgerCensusRow {
  const ledger = confirmedLedger();
  const subject = row({ lines: ledger.lines, transactions: [txn("t1", 19_000)] });
  settle(ledger, subject);
  return { ...subject, lines: ledger.lines };
}

/** $40 of account credit and $150 by card. */
function creditAndCard(): BookingLedgerCensusRow {
  const ledger = confirmedLedger();
  const rows = [credit("c1", "BOOKING_APPLIED", -4_000)];
  const subject = row({ lines: [], transactions: [txn("t1", 15_000)], credits: rows, payment: payment({ amountCents: 15_000, creditAppliedCents: 4_000 }) });
  credits(ledger, rows);
  settle(ledger, subject);
  return { ...subject, lines: ledger.lines };
}

/** An edit removes one guest-night ($50) with a $5 change fee; $45 goes back on the card. */
function reducedAndRefunded(): BookingLedgerCensusRow {
  const ledger = confirmedLedger();
  const base = row({ lines: [], transactions: [txn("t1", 19_000)] });
  settle(ledger, base);
  const plan = planModificationChargeLines({
    bookingId: B,
    lodgeId: LODGE,
    bookingModificationId: "m1",
    before: { guests: [guestSide("g1", [[D1, 5_000], [D2, 5_000]]), guestSide("g2", [[D1, 5_000], [D2, 5_000]])], promoAdjustmentCents: -1_000 },
    after: { guests: [guestSide("g1", [[D1, 5_000], [D2, 5_000]]), guestSide("g2", [[D1, 5_000]])], promoAdjustmentCents: -1_000 },
    changeFeeCents: 500,
    expectedCents: -4_500,
    postedLines: ledger.reversible().filter((line) => line.kind !== "CHANGE_FEE") as never,
  });
  if (plan.kind !== "lines") throw new Error(`edit plan refused: ${plan.reason}`);
  ledger.post(plan.postings, LATER);
  const subject = row({
    lines: [],
    booking: { id: B, status: "PAID", deletedAt: null, organiserSettled: false, finalPriceCents: 14_000 },
    transactions: [txn("t1", 19_000, { status: "PARTIALLY_REFUNDED", refundedAmountCents: 4_500 })],
    refunds: [{ id: "r1", status: "succeeded", amountCents: 4_500, paymentTransactionId: "t1" }],
    modifications: [{ id: "m1", modificationType: "BATCH_MODIFY", priceDiffCents: -5_000, changeFeeCents: 500, createdAt: LATER, reviewRebase: null }],
    payment: payment({ refundedAmountCents: 4_500, changeFeeCents: 500, status: "PARTIALLY_REFUNDED" }),
  });
  settle(ledger, subject, false, LATER);
  return { ...subject, lines: ledger.lines };
}

/** An edit raises one night by $25 and the payment carries the ask for it. */
function raisedWithAsk(): BookingLedgerCensusRow {
  const ledger = confirmedLedger();
  settle(ledger, row({ lines: [], transactions: [txn("t1", 19_000)] }));
  const plan = planModificationChargeLines({
    bookingId: B,
    lodgeId: LODGE,
    bookingModificationId: "m2",
    before: { guests: [guestSide("g1", [[D1, 5_000], [D2, 5_000]]), guestSide("g2", [[D1, 5_000], [D2, 5_000]])], promoAdjustmentCents: -1_000 },
    after: { guests: [guestSide("g1", [[D1, 5_000], [D2, 7_500]]), guestSide("g2", [[D1, 5_000], [D2, 5_000]])], promoAdjustmentCents: -1_000 },
    changeFeeCents: 0,
    expectedCents: 2_500,
    postedLines: ledger.reversible() as never,
  });
  if (plan.kind !== "lines") throw new Error(`edit plan refused: ${plan.reason}`);
  ledger.post(plan.postings, LATER);
  return row({
    lines: ledger.lines,
    booking: { id: B, status: "PAID", deletedAt: null, organiserSettled: false, finalPriceCents: 21_500 },
    transactions: [txn("t1", 19_000), txn("a1", 2_500, { kind: "ADDITIONAL", status: "PENDING", createdAt: LATER })],
    modifications: [{ id: "m2", modificationType: "BATCH_MODIFY", priceDiffCents: 2_500, changeFeeCents: 0, createdAt: LATER, reviewRebase: null }],
    payment: payment({ additionalAmountCents: 2_500, additionalPaymentStatus: "PENDING" }),
  });
}

/** Cash marked paid by an officer, cancelled at 50%: the club keeps $95 and hands $95 back by hand. */
function cashCancelled(task: "OPEN" | "COMPLETED" | "DISMISSED"): BookingLedgerCensusRow {
  const ledger = confirmedLedger();
  const base = row({ lines: [], transactions: [txn("t1", 19_000)], payment: payment({ source: "INTERNET_BANKING" }) });
  settle(ledger, base, true);
  const cancel = planCancellationChargeLines({ bookingId: B, lodgeId: LODGE, keptCents: 9_500, chargeLines: ledger.reversible(), adjustmentLines: ledger.adjustments() });
  if (cancel.kind !== "lines") throw new Error("cancel plan refused");
  ledger.post(cancel.postings, LATER);
  if (task === "COMPLETED") {
    ledger.post([planHandBackLine({ bookingId: B, lodgeId: LODGE, manualRefundTaskId: "task-hb", amountCents: 9_500, settlementMethod: "INTERNET_BANKING", officerMemberId: "officer" })], LATER);
  }
  return {
    ...base,
    lines: ledger.lines,
    booking: { ...base.booking, status: "CANCELLED" },
    payment: payment({ source: "INTERNET_BANKING", refundedAmountCents: task === "COMPLETED" ? 9_500 : 0 }),
    tasks: [{ id: "task-hb", kind: "CANCELLED_BOOKING_HAND_BACK", status: task, amountCents: 9_500, settlementDirection: null, paymentId: "pay-3583", lateCaptureApprovalIntentId: null }],
    cancellation: { refundMethod: "manual", settledAmountCents: 9_500, keptCents: 9_500 },
  };
}

/** Card paid, cancelled at 50%: the refund plan of `plannedCents` is enqueued and, if done, made. */
function cardCancelled(plannedCents: number, refunded: boolean): BookingLedgerCensusRow {
  const ledger = confirmedLedger();
  const base = row({ lines: [], transactions: [txn("t1", 19_000)] });
  settle(ledger, base);
  const cancel = planCancellationChargeLines({ bookingId: B, lodgeId: LODGE, keptCents: 9_500, chargeLines: ledger.reversible(), adjustmentLines: ledger.adjustments() });
  if (cancel.kind !== "lines") throw new Error("cancel plan refused");
  ledger.post(cancel.postings, LATER);
  const refunds = refunded ? [{ id: "r-cancel", status: "succeeded", amountCents: plannedCents, paymentTransactionId: "t1" }] : [];
  const subject: BookingLedgerCensusRow = {
    ...base,
    booking: { ...base.booking, status: "CANCELLED" },
    refunds,
    transactions: [txn("t1", 19_000, { refundedAmountCents: refunded ? plannedCents : 0 })],
    payment: payment({ refundedAmountCents: refunded ? plannedCents : 0 }),
    recoveryOperations: [
      { type: "REFUND_BOOKING_MODIFICATION", status: refunded ? "SUCCEEDED" : "PENDING", amountCents: plannedCents, idempotencyKey: buildBookingCancellationRefundIdempotencyKey(B) },
    ],
    cancellation: { refundMethod: "card", settledAmountCents: 9_500, keptCents: 9_500 },
    lines: [],
  };
  settle(ledger, subject, false, LATER);
  return { ...subject, lines: ledger.lines };
}

/** Plus one cent on the first line of one kind (its unit and amount together, as a line would carry them). */
function bumpLine(subject: BookingLedgerCensusRow, kind: CensusLedgerLine["kind"], by: 1 | -1 = 1): BookingLedgerCensusRow {
  let done = false;
  return {
    ...subject,
    lines: subject.lines.map((line) => {
      if (done || line.kind !== kind || line.reversesLineId !== null) return line;
      done = true;
      return { ...line, unitCents: line.unitCents + by, amountCents: line.amountCents + by * line.sign };
    }),
  };
}

function bumpPayment(subject: BookingLedgerCensusRow, key: "amountCents" | "creditAppliedCents" | "refundedAmountCents" | "changeFeeCents" | "additionalAmountCents", by: 1 | -1 = 1): BookingLedgerCensusRow {
  return { ...subject, payment: { ...subject.payment!, [key]: subject.payment![key] + by } };
}

// ---------------------------------------------------------------------------


/** The review's probe S1: an edit's $50 reduction credited to account, the CREDIT_ISSUED line missing or present. */
function reductionCredited(withLine: boolean): BookingLedgerCensusRow {
  const ledger = confirmedLedger(0);
  settle(ledger, row({ lines: [], transactions: [txn("t1", 20_000)] }));
  const plan = planModificationChargeLines({
    bookingId: B,
    lodgeId: LODGE,
    bookingModificationId: "m1",
    before: { guests: [guestSide("g1", [[D1, 5_000], [D2, 5_000]]), guestSide("g2", [[D1, 5_000], [D2, 5_000]])], promoAdjustmentCents: 0 },
    after: { guests: [guestSide("g1", [[D1, 5_000], [D2, 5_000]]), guestSide("g2", [[D1, 5_000]])], promoAdjustmentCents: 0 },
    changeFeeCents: 0,
    expectedCents: -5_000,
    postedLines: ledger.reversible() as never,
  });
  if (plan.kind !== "lines") throw new Error(`edit plan refused: ${plan.reason}`);
  ledger.post(plan.postings, LATER);
  const rows = [credit("c-reduction", "BOOKING_MODIFICATION_REFUND", 5_000)];
  if (withLine) credits(ledger, rows);
  return row({
    lines: ledger.lines,
    booking: { id: B, status: "PAID", deletedAt: null, organiserSettled: false, finalPriceCents: 15_000 },
    transactions: [txn("t1", 20_000, { refundedAmountCents: 5_000 })],
    credits: rows,
    modifications: [{ id: "m1", modificationType: "BATCH_MODIFY", priceDiffCents: -5_000, changeFeeCents: 0, createdAt: LATER, reviewRebase: null }],
    payment: payment({ amountCents: 20_000, refundedAmountCents: 5_000 }),
  });
}

/** The review's probe S2: $200 captured in full by card beside $40 of applied credit (#1641). */
function probeDoublePay(): BookingLedgerCensusRow {
  const ledger = confirmedLedger(0);
  const rows = [credit("c1", "BOOKING_APPLIED", -4_000)];
  credits(ledger, rows);
  const subject = row({
    lines: [],
    booking: { id: B, status: "PAID", deletedAt: null, organiserSettled: false, finalPriceCents: 20_000 },
    transactions: [txn("t1", 20_000)],
    credits: rows,
    payment: payment({ amountCents: 20_000 }),
  });
  settle(ledger, subject);
  return { ...subject, lines: ledger.lines };
}

const report = (rows: BookingLedgerCensusRow[], acknowledgements: Parameters<typeof summarizeBookingLedgerCensus>[2] = []) =>
  summarizeBookingLedgerCensus(rows.map(evaluateBookingLedgerIdentities), null, acknowledgements);

// ---------------------------------------------------------------------------

describe("the identities agree on lines the real planners wrote (#3583)", () => {
  it.each([
    ["a card-paid booking", cardPaid],
    ["credit plus card", creditAndCard],
    ["an edit with a change fee, refunded to the card", reducedAndRefunded],
    ["an edit raising the price, the ask outstanding", raisedWithAsk],
  ])("%s: every applicable identity AGREES — not classified, not coverage", (_label, build) => {
    const evaluation = evaluateBookingLedgerIdentities(build());
    expect(evaluation.identities.filter((result) => result.status !== "AGREE" && result.status !== "NOT_APPLICABLE")).toEqual([]);
    expect(evaluation.identities.find((result) => result.identity === "OWED")?.status).toBe("AGREE");
    expect(evaluation.integrity).toEqual([]);
    expect(evaluation.coverage).toEqual([]);
  });

  it("each identity is applicable on the fixture that exercises it, and agrees", () => {
    expect(identity(cardPaid(), "PRICE")).toMatchObject({ status: "AGREE", columnCents: 19_000, ledgerCents: 19_000 });
    expect(identity(cardPaid(), "CAPTURED")).toMatchObject({ status: "AGREE", columnCents: 19_000 });
    expect(identity(creditAndCard(), "CREDIT_APPLIED")).toMatchObject({ status: "AGREE", columnCents: 4_000 });
    expect(identity(reducedAndRefunded(), "REFUNDED")).toMatchObject({ status: "AGREE", columnCents: 4_500 });
    expect(identity(reducedAndRefunded(), "CHANGE_FEE")).toMatchObject({ status: "AGREE", columnCents: 500 });
    expect(identity(raisedWithAsk(), "ADDITIONAL")).toMatchObject({ status: "AGREE", columnCents: 2_500, ledgerCents: 2_500 });
    expect(identity(raisedWithAsk(), "OWED")).toMatchObject({ status: "AGREE", columnCents: 2_500, ledgerCents: 2_500 });
    expect(identity(cashCancelled("COMPLETED"), "PRICE")).toMatchObject({ status: "AGREE", columnCents: 0, ledgerCents: 0 });
  });
});

describe("the parts of an identity a plain booking does not exercise", () => {
  it("PRICE counts a live review-share stand-in: finalPriceCents == charges + adjusted(b) (design §5.3)", () => {
    const ledger = new Ledger();
    ledger.lines = [...(cardPaid().lines as Line[])];
    ledger.post([planAgreedAdjustmentLine({ bookingId: B, lodgeId: LODGE, manualRefundTaskId: "task-standin", direction: "REFUND_TO_MEMBER", amountCents: 3_000, note: "share", officerMemberId: "officer" })], LATER);
    const subject = row({
      lines: ledger.lines,
      booking: { id: B, status: "PAID", deletedAt: null, organiserSettled: false, finalPriceCents: 16_000 },
      transactions: [txn("t1", 19_000)],
      tasks: [{ id: "task-standin", kind: "EDIT_FINANCIAL_REVIEW", status: "COMPLETED", amountCents: 3_000, settlementDirection: "REFUND_TO_MEMBER", paymentId: "pay-3583", lateCaptureApprovalIntentId: null }],
    });
    expect(identity(subject, "PRICE")).toMatchObject({ status: "AGREE", columnCents: 16_000, ledgerCents: 16_000 });
    expect(evaluateBookingLedgerIdentities(subject).integrity).toEqual([]);
  });

  it("ADDITIONAL is zero == zero once the ask is withdrawn, though owed(b) still holds the debt (INV-ADDPAY-040)", () => {
    const raised = raisedWithAsk();
    const withdrawn = {
      ...raised,
      transactions: [txn("t1", 19_000), txn("a1", 2_500, { kind: "ADDITIONAL", status: "FAILED", withdrawnAt: LATER, createdAt: LATER })],
      payment: payment({ additionalAmountCents: 0, additionalPaymentStatus: null }),
    };
    expect(identity(withdrawn, "ADDITIONAL")).toMatchObject({ status: "AGREE", columnCents: 0, ledgerCents: 0 });
    expect(identity(withdrawn, "OWED")).toMatchObject({ status: "AGREE", columnCents: 2_500, ledgerCents: 2_500 });
  });
});

describe("the OWED identity's column side, and the evidence a mirror class needs", () => {
  it("counts issued credit the refunded column never counted (a Xero inbound mint), with its line", () => {
    const subject = cardPaid();
    const ledger = new Ledger();
    ledger.lines = [...(subject.lines as Line[])];
    const rows = [credit("c-xero", "CANCELLATION_REFUND", 1_000, { description: `Internet Banking payment credit for booking ${B}` })];
    credits(ledger, rows);
    const minted = { ...subject, lines: ledger.lines, credits: rows };
    expect(identity(minted, "OWED")).toMatchObject({ status: "AGREE", columnCents: 1_000, ledgerCents: 1_000 });
  });

  it("CREDIT_MIRROR_XERO_CAP needs the money to add up: the same capped column on a price the ledger does not cover is a disagreement", () => {
    const capped = xeroCappedCredit();
    const short = { ...capped, booking: { ...capped.booking, finalPriceCents: 19_001 } };
    expect(identity(short, "CREDIT_APPLIED").deltaCents).toBe(identity(capped, "CREDIT_APPLIED").deltaCents);
    expect(identity(short, "CREDIT_APPLIED").status).toBe("DISAGREE");
  });
});

describe("a legacy-backfilled payment's credit allocation is counted once (#3583, the back-post lane's double count)", () => {
  /**
   * The payment's transaction came from the legacy backfill, and a credit
   * allocation since raised its refunded total. The allocation's own row and
   * line explain those cents; only what no row explains is the legacy seed.
   */
  const onLegacy = (seededCents = 0) => {
    const subject = reductionCredited(true);
    return {
      ...subject,
      transactions: [txn("t1", 20_000, { refundedAmountCents: 5_000 + seededCents, reason: "legacy_primary_backfill" })],
      payment: payment({ amountCents: 20_000, refundedAmountCents: 5_000 + seededCents }),
    };
  };
  const refunded = (subject: BookingLedgerCensusRow) => identity(subject, "REFUNDED");

  it("the allocation alone explains the refunded column; nothing is left for the legacy seed", () => {
    expect(refunded(onLegacy())).toMatchObject({ status: "CLASSIFIED", deltaCents: 5_000, explainedBy: [{ name: "REFUND_MIRROR_CREDIT_ALLOCATION", cents: 5_000 }] });
    expect(identity(onLegacy(), "OWED").status).toBe("AGREE");
    expect(evaluateBookingLedgerIdentities(onLegacy()).coverage).toEqual([]);
  });

  it("a seed beside the allocation is the legacy class for exactly what no row explains", () => {
    expect(refunded(onLegacy(2_000))).toMatchObject({
      status: "CLASSIFIED",
      deltaCents: 7_000,
      explainedBy: [
        { name: "REFUND_MIRROR_CREDIT_ALLOCATION", cents: 5_000 },
        { name: "REFUND_MIRROR_LEGACY_SEED", cents: 2_000 },
      ],
    });
  });

  it("a cent either way on the column is still a disagreement", () => {
    for (const by of [1, -1] as const) expect(refunded(bumpPayment(onLegacy(), "refundedAmountCents", by)).status).toBe("DISAGREE");
  });

  it("the seed is never more than the legacy transactions hold: another transaction's unexplained refund is a disagreement", () => {
    const seeded = legacySeed();
    const drifted = {
      ...seeded,
      transactions: [...seeded.transactions, txn("t9", 3_000, { refundedAmountCents: 3_000 })],
      payment: payment({ refundedAmountCents: 5_000 }),
    };
    expect(refunded(drifted)).toMatchObject({ status: "DISAGREE", deltaCents: 5_000 });
  });
});

describe("the review's two gate escapes are closed (fix round of #3583)", () => {
  it("S1: a missing CREDIT_ISSUED line is coverage, holding the gate — and with the line every identity agrees", () => {
    const missing = evaluateBookingLedgerIdentities(reductionCredited(false));
    expect(missing.coverage).toContain("UNPOSTED_CREDIT");
    expect(missing.identities.find((result) => result.identity === "OWED")).toMatchObject({ status: "COVERAGE", deltaCents: 5_000 });
    expect(missing.identities.find((result) => result.identity === "REFUNDED")).toMatchObject({ status: "COVERAGE", deltaCents: 5_000 });
    expect(report([reductionCredited(false)]).verdict).toBe("GATE_CLOSED");
    const posted = evaluateBookingLedgerIdentities(reductionCredited(true));
    expect(posted.identities.find((result) => result.identity === "OWED")?.status).toBe("AGREE");
    expect(posted.identities.find((result) => result.identity === "REFUNDED")?.explainedBy).toEqual([{ name: "REFUND_MIRROR_CREDIT_ALLOCATION", cents: 5_000 }]);
    // The class instance is the owner's to acknowledge (design §6); once it is, nothing holds the gate.
    expect(report([reductionCredited(true)], [{ bookingId: B, class: "REFUND_MIRROR_CREDIT_ALLOCATION", cents: 5_000, reference: "x" }]).verdict).toBe("GATE_OPEN");
  });

  it("S2: #1641's double-pay shape is KNOWN_DEFECT_HISTORY and holds the gate, on CREDIT_APPLIED and on OWED", () => {
    const evaluation = evaluateBookingLedgerIdentities(probeDoublePay());
    const detail = expect.stringContaining("#1641 shape");
    expect(evaluation.identities.find((result) => result.identity === "CREDIT_APPLIED")?.explainedBy).toEqual([{ name: "KNOWN_DEFECT_HISTORY", cents: -4_000, detail }]);
    expect(evaluation.identities.find((result) => result.identity === "OWED")).toMatchObject({ status: "CLASSIFIED", columnCents: 0, ledgerCents: -4_000, explainedBy: [{ name: "KNOWN_DEFECT_HISTORY", cents: 4_000, detail }] });
    const summary = report([probeDoublePay()]);
    expect(summary.verdict).toBe("GATE_CLOSED");
    expect(summary.gateClosedBecause).toEqual(["1 booking(s) in KNOWN_DEFECT_HISTORY, which holds the gate"]);
  });

  it("a BANK_REFUND line the refunded column never counted disagrees on OWED, though every column identity agrees", () => {
    const subject = cardPaid();
    const ledger = new Ledger();
    ledger.lines = [...(subject.lines as Line[])];
    ledger.post([planHandBackLine({ bookingId: B, lodgeId: LODGE, manualRefundTaskId: "task-x", amountCents: 1_000, settlementMethod: "INTERNET_BANKING", officerMemberId: "officer" })]);
    const rogue = { ...subject, lines: ledger.lines, tasks: [{ id: "task-x", kind: "CANCELLED_BOOKING_HAND_BACK" as const, status: "COMPLETED" as const, amountCents: 1_000, settlementDirection: null, paymentId: "pay-3583", lateCaptureApprovalIntentId: null }] };
    expect(identity(rogue, "REFUNDED").status).toBe("AGREE");
    expect(identity(rogue, "OWED")).toMatchObject({ status: "DISAGREE", deltaCents: -1_000 });
  });
});

/** The second review's H1 probe: $190 by card; refund r1 $45 FAILED, its retry r2 $45 SUCCEEDED, r2's CARD_REFUND line missing. */
function retriedRefundUnposted(): BookingLedgerCensusRow {
  const subject = cardPaid();
  return {
    ...subject,
    transactions: [txn("t1", 19_000, { status: "PARTIALLY_REFUNDED", refundedAmountCents: 4_500 })],
    refunds: [
      { id: "r1", status: "failed", amountCents: 4_500, paymentTransactionId: "t1" },
      { id: "r2", status: "succeeded", amountCents: 4_500, paymentTransactionId: "t1" },
    ],
    payment: payment({ status: "PARTIALLY_REFUNDED", refundedAmountCents: 4_500 }),
  };
}

const groupChild = (overrides: Partial<Omit<BookingLedgerCensusRow, "lines">>) =>
  row({ lines: [], booking: { id: B, status: "PAID", deletedAt: null, organiserSettled: true, finalPriceCents: 19_000 }, ...overrides });

describe("the second review's gate escapes are closed (fix round 2 of #3583)", () => {
  it("H1: a failed refund with no line of its own explains nothing, and the retry's missing line is UNPOSTED_SETTLEMENT", () => {
    const evaluation = evaluateBookingLedgerIdentities(retriedRefundUnposted());
    expect(evaluation.coverage).toContain("UNPOSTED_SETTLEMENT");
    expect(evaluation.identities.find((result) => result.identity === "REFUNDED")).toMatchObject({
      status: "COVERAGE",
      deltaCents: 4_500,
      explainedBy: [{ name: "UNPOSTED_SETTLEMENT", cents: 4_500 }],
    });
    expect(evaluation.identities.find((result) => result.identity === "OWED")).toMatchObject({
      status: "COVERAGE",
      deltaCents: 4_500,
      explainedBy: [{ name: "UNPOSTED_SETTLEMENT", cents: 4_500 }],
    });
    const summary = report([retriedRefundUnposted()]);
    expect(summary.classes.REFUND_MIRROR_FAILED_REFUND.instances).toEqual([]);
    expect(summary.verdict).toBe("GATE_CLOSED");
    expect(summary.gateClosedBecause).toContain("1 booking(s) with coverage gap UNPOSTED_SETTLEMENT");
    // Without the retry's row the column's $45 is unexplained: the failed refund alone is a disagreement, not a class.
    const alone = { ...retriedRefundUnposted(), refunds: [{ id: "r1", status: "failed", amountCents: 4_500, paymentTransactionId: "t1" }] };
    expect(identity(alone, "REFUNDED")).toMatchObject({ status: "DISAGREE", deltaCents: 4_500 });
    // With r2's line posted by the real planner, every identity agrees.
    const ledger = new Ledger();
    ledger.lines = [...(retriedRefundUnposted().lines as Line[])];
    settle(ledger, retriedRefundUnposted(), false, LATER);
    const posted = evaluateBookingLedgerIdentities({ ...retriedRefundUnposted(), lines: ledger.lines });
    expect(posted.identities.filter((result) => result.status !== "AGREE" && result.status !== "NOT_APPLICABLE")).toEqual([]);
    expect(posted.coverage).toEqual([]);
  });

  it("H1: a captured transaction with no capture line is UNPOSTED_SETTLEMENT on CAPTURED and OWED", () => {
    const subject = cardPaid();
    const uncaptured = { ...subject, lines: subject.lines.filter((line) => line.kind !== "CARD_CAPTURE") };
    const evaluation = evaluateBookingLedgerIdentities(uncaptured);
    expect(evaluation.coverage).toEqual(["UNPOSTED_SETTLEMENT"]);
    expect(evaluation.identities.find((result) => result.identity === "CAPTURED")).toMatchObject({ status: "COVERAGE", explainedBy: [{ name: "UNPOSTED_SETTLEMENT", cents: 19_000 }] });
    expect(evaluation.identities.find((result) => result.identity === "OWED")).toMatchObject({ status: "COVERAGE", explainedBy: [{ name: "UNPOSTED_SETTLEMENT", cents: -19_000 }] });
    expect(report([uncaptured]).verdict).toBe("GATE_CLOSED");
  });

  it("M2: a group child with a credit row of its own is not GROUP_SETTLEMENT_OFF_LEDGER — it is NO_LINES and UNPOSTED_CREDIT", () => {
    const cancelled = groupChild({
      booking: { id: B, status: "CANCELLED", deletedAt: null, organiserSettled: true, finalPriceCents: 19_000 },
      payment: null,
      credits: [credit("c-cancel", "CANCELLATION_REFUND", 5_000, { description: cancellationCreditDescription(B) })],
    });
    const applied = groupChild({ payment: payment({ creditAppliedCents: 4_000 }), credits: [credit("c-applied", "BOOKING_APPLIED", -4_000)] });
    for (const child of [cancelled, applied]) {
      const evaluation = evaluateBookingLedgerIdentities(child);
      expect(evaluation.bookingClass).toBeNull();
      expect(evaluation.coverage.sort()).toEqual(["NO_LINES", "UNPOSTED_CREDIT"]);
      const summary = report([child]);
      expect(summary.classes.GROUP_SETTLEMENT_OFF_LEDGER.bookings).toBe(0);
      expect(summary.verdict).toBe("GATE_CLOSED");
    }
  });

  it("M2: a group child whose payment carries a credit, refund or change-fee figure of its own is not off-ledger either", () => {
    for (const column of ["creditAppliedCents", "refundedAmountCents", "changeFeeCents"] as const) {
      const evaluation = evaluateBookingLedgerIdentities(groupChild({ payment: payment({ [column]: 1_000 }) }));
      expect(evaluation, column).toMatchObject({ bookingClass: null, coverage: ["NO_LINES"] });
    }
  });

  it("M3: a PAID booking whose payment SUCCEEDED beside a still-pending primary is a disagreement, not NOTHING_CAPTURED", () => {
    const subject = row({ lines: confirmedLedger().lines, transactions: [txn("t1", 19_000, { status: "PENDING" })] });
    const evaluation = evaluateBookingLedgerIdentities(subject);
    expect(evaluation.identities.find((result) => result.identity === "CAPTURED")).toMatchObject({ status: "DISAGREE", deltaCents: 19_000, explainedBy: [] });
    expect(evaluation.identities.find((result) => result.identity === "OWED")).toMatchObject({ status: "DISAGREE", deltaCents: -19_000, explainedBy: [] });
    const summary = report([subject]);
    expect(summary.classes.NOTHING_CAPTURED.instances).toEqual([]);
    expect(summary.verdict).toBe("GATE_CLOSED");
    // Not paid, the payment not captured either: the same rows are NOTHING_CAPTURED.
    const unpaid = { ...subject, booking: { ...subject.booking, status: "PAYMENT_PENDING" as const }, payment: payment({ status: "PENDING" }) };
    expect(identity(unpaid, "CAPTURED")).toMatchObject({ status: "CLASSIFIED", explainedBy: [{ name: "NOTHING_CAPTURED", cents: 19_000 }] });
    // Paid-like, or the payment's own status captured, and it is not.
    expect(identity({ ...unpaid, payment: payment({ status: "SUCCEEDED" }) }, "CAPTURED").status).toBe("DISAGREE");
    expect(identity({ ...unpaid, booking: { ...unpaid.booking, status: "PAID" as const } }, "CAPTURED").status).toBe("DISAGREE");
  });

  it("M4: on OWED a legacy refund no line records is coverage (UNPOSTED_LEGACY_REFUND), not a class; on REFUNDED it stays the mirror class", () => {
    const evaluation = evaluateBookingLedgerIdentities(legacySeed());
    expect(evaluation.identities.find((result) => result.identity === "OWED")).toMatchObject({
      status: "COVERAGE",
      deltaCents: 2_000,
      explainedBy: [{ name: "UNPOSTED_LEGACY_REFUND", cents: 2_000 }],
    });
    expect(evaluation.identities.find((result) => result.identity === "REFUNDED")).toMatchObject({ status: "CLASSIFIED", explainedBy: [{ name: "REFUND_MIRROR_LEGACY_SEED", cents: 2_000 }] });
    expect(evaluation.coverage).toEqual(["UNPOSTED_LEGACY_REFUND"]);
    const summary = report([legacySeed()], [{ bookingId: B, class: "REFUND_MIRROR_LEGACY_SEED", cents: 2_000, reference: "x" }]);
    expect(summary.verdict).toBe("GATE_CLOSED");
    expect(summary.gateClosedBecause).toEqual(["1 booking(s) with coverage gap UNPOSTED_LEGACY_REFUND"]);
    // A cent either way, or the legacy evidence removed, and OWED disagrees.
    for (const by of [1, -1] as const) expect(identity(bumpPayment(legacySeed(), "refundedAmountCents", by), "OWED").status).toBe("DISAGREE");
    expect(identity({ ...legacySeed(), transactions: legacySeed().transactions.map((t) => ({ ...t, reason: null })) }, "OWED").status).toBe("DISAGREE");
  });

  it("L5: an instance of a class the owner has not decided holds the gate until acknowledged to the cent, and the count prints beside the verdict", () => {
    const open = report([cashCancelled("OPEN")]);
    expect(open.verdict).toBe("GATE_CLOSED");
    expect(open.unacknowledgedClassInstances).toBe(1);
    expect(open.classes.IN_FLIGHT_HAND_BACK).toMatchObject({ gateRule: "ACKNOWLEDGE", holdsGate: true, unacknowledged: 1 });
    expect(open.gateClosedBecause).toEqual(["1 unacknowledged instance(s) of IN_FLIGHT_HAND_BACK on 1 booking(s): the owner acknowledges each on #3583"]);
    const signed = report([cashCancelled("OPEN")], [{ bookingId: B, class: "IN_FLIGHT_HAND_BACK", cents: 9_500, reference: "hand-back in progress" }]);
    expect(signed).toMatchObject({ verdict: "GATE_OPEN", unacknowledgedClassInstances: 0 });
    // An in-flight figure that moves after sign-off is stale and holds again: it cannot sit in flight forever unseen.
    const moved = report([cashCancelled("OPEN")], [{ bookingId: B, class: "IN_FLIGHT_HAND_BACK", cents: 9_000, reference: "hand-back in progress" }]);
    expect(moved.verdict).toBe("GATE_CLOSED");
    expect(moved.acknowledged.stale).toHaveLength(1);
  });
});

describe("#3791's review closures: a line is judged by what the member was credited (#3583)", () => {
  const TASK = "task-3791";
  const task = { id: TASK, kind: "EDIT_FINANCIAL_REVIEW" as const, status: "COMPLETED" as const, amountCents: 5_000, settlementDirection: "REFUND_TO_MEMBER" as const, paymentId: null, lateCaptureApprovalIntentId: null };
  const giveBack = (cents: number, id = "c-give") => credit(id, "BOOKING_APPLIED", cents, { sourceBookingId: B });
  const share = (cents: number, key?: string) => ({
    ...planAgreedAdjustmentLine({ bookingId: B, lodgeId: LODGE, manualRefundTaskId: TASK, direction: "REFUND_TO_MEMBER", amountCents: cents, note: "agreed", officerMemberId: "officer" }),
    ...(key ? { postingKey: key } : {}),
  });
  const rebase = (movementCents: number) => ({ id: "m-rebase", modificationType: "PRICE_REBASE", priceDiffCents: 0, changeFeeCents: 0, createdAt: LATER, reviewRebase: { taskId: TASK, movementCents } });
  const findings = (subject: BookingLedgerCensusRow) => evaluateBookingLedgerIdentities(subject).integrity.map((finding) => `${finding.kind}:${finding.lineId}`);

  /** A $190 booking its credit covered; a $50 share given back, posted as the agreed give-back. */
  function covered(giveBackLineCents: number | null = 5_000, rows = [giveBack(5_000)]): BookingLedgerCensusRow {
    const ledger = confirmedLedger();
    const creditRows = [credit("c-applied", "BOOKING_APPLIED", -19_000), ...rows];
    credits(ledger, creditRows);
    if (giveBackLineCents !== null) ledger.post([share(giveBackLineCents, agreedGiveBackKey(TASK))], LATER);
    return row({ lines: ledger.lines, credits: creditRows, tasks: [task], payment: payment({ amountCents: 0, creditAppliedCents: 14_000 }) });
  }
  const unsettled = (subject: BookingLedgerCensusRow) =>
    evaluateBookingLedgerIdentities(subject).identities.filter((result) => result.status !== "AGREE" && result.status !== "NOT_APPLICABLE");

  it("a covered booking's agreed give-back agrees: the price column never carries it, and owed(b) is what the columns say less it", () => {
    expect(unsettled(covered())).toEqual([]);
    expect(findings(covered())).toEqual([]);
  });

  it("a give-back line a cent either way, or with no give-back row behind it, is source drift and an owed(b) disagreement", () => {
    for (const cents of [4_999, 5_001]) {
      const subject = covered(cents);
      expect(findings(subject)).toHaveLength(1);
      expect(unsettled(subject).map((result) => [result.identity, result.deltaCents])).toEqual([["OWED", cents - 5_000]]);
    }
    expect(findings(covered(5_000, []))).toHaveLength(1);
  });

  it("a missing give-back line is an owed(b) disagreement by the give-back no line records", () => {
    expect(unsettled(covered(null)).map((result) => [result.identity, result.deltaCents])).toEqual([["OWED", -5_000]]);
    expect(findings(covered(null))).toEqual([]);
  });

  it("the give-back the line records is net of the closure's own re-price, read from its PRICE_REBASE row", () => {
    const subject = covered(3_000);
    expect(findings(subject)).toHaveLength(1);
    expect(findings({ ...subject, modifications: [rebase(-2_000)] })).toEqual([]);
    expect(findings({ ...subject, modifications: [rebase(-1_000)] })).toHaveLength(1);
  });

  it("after a cancellation a netted stand-in must be made of the give-back and share credit; the typed share still stands", () => {
    const cancelled = (lineCents: number, rows: BookingLedgerCensusRow["credits"]) =>
      row({ lines: new Ledger().post([share(lineCents)], LATER).lines, credits: rows, tasks: [task], booking: { id: B, status: "CANCELLED", deletedAt: null, organiserSettled: false, finalPriceCents: 19_000 } });
    expect(findings(cancelled(2_500, [giveBack(2_500)]))).toEqual([]);
    expect(findings(cancelled(3_000, [giveBack(2_500), credit("c-mint", "BOOKING_MODIFICATION_REFUND", 500)]))).toEqual([]);
    expect(findings(cancelled(5_000, []))).toEqual([]);
    for (const [cents, rows] of [[2_500, []], [2_400, [giveBack(2_500)]], [2_600, [giveBack(2_500)]], [5_100, []]] as const) {
      expect(findings(cancelled(cents, [...rows])), `${cents}`).toEqual([`SOURCE_DRIFT:line-1`]);
    }
  });

  it("#3835 (#3907): on a captured payment the task's own refund - its card debt or its hand-back - makes the stand-in with any give-back, and only that bears out a smaller hand-back", () => {
    const debt = (cents: number, taskId = TASK) => ({ type: "REFUND_BOOKING_MODIFICATION" as const, status: "PENDING" as const, amountCents: cents, idempotencyKey: buildEditFinancialReviewRefundRecoveryIdempotencyKey(taskId) });
    const handBack = (cents: number, taskId = TASK) =>
      planHandBackLine({ bookingId: B, lodgeId: LODGE, manualRefundTaskId: taskId, amountCents: cents, settlementMethod: "INTERNET_BANKING", officerMemberId: "officer" });
    const captured = (lineCents: number, { debts = [] as ReturnType<typeof debt>[], handBacks = [] as number[], rows = [] as BookingLedgerCensusRow["credits"] }) =>
      row({
        lines: new Ledger().post([share(lineCents), ...handBacks.map((cents) => handBack(cents))], LATER).lines,
        credits: rows,
        tasks: [task],
        recoveryOperations: debts,
        booking: { id: B, status: "CANCELLED", deletedAt: null, organiserSettled: false, finalPriceCents: 19_000 },
      });
    // Borne out: the card's part, the bank's part, each with or without a credit part.
    expect(findings(captured(2_500, { debts: [debt(2_500)] }))).toEqual([]);
    expect(findings(captured(2_500, { debts: [debt(1_500)], rows: [giveBack(1_000)] }))).toEqual([]);
    expect(findings(captured(5_000, { debts: [debt(2_500)], rows: [giveBack(2_500)] }))).toEqual([]);
    expect(findings(captured(2_500, { handBacks: [2_500] }))).toEqual([]);
    expect(findings(captured(5_000, { handBacks: [2_500], rows: [giveBack(2_500)] }))).toEqual([]);
    // A line a cent off its refund, a refund a cent short, larger than the line, or another task's: drift.
    expect(findings(captured(2_501, { debts: [debt(2_500)] }))).toEqual(["SOURCE_DRIFT:line-1"]);
    expect(findings(captured(2_500, { debts: [debt(2_499)] }))).toEqual(["SOURCE_DRIFT:line-1"]);
    expect(findings(captured(2_500, { debts: [debt(3_000)] }))).toEqual(["SOURCE_DRIFT:line-1"]);
    expect(findings(captured(2_500, { debts: [debt(2_500, "task-other")] }))).toEqual(["SOURCE_DRIFT:line-1"]);
    // A hand-back a cent off, or its credit part missing: neither it nor the stand-in is borne out.
    expect(findings(captured(2_500, { handBacks: [2_501] }))).toEqual(["SOURCE_DRIFT:line-1", "SOURCE_DRIFT:line-2"]);
    expect(findings(captured(5_000, { handBacks: [2_500] }))).toEqual(["SOURCE_DRIFT:line-1", "SOURCE_DRIFT:line-2"]);
    // One task's refund makes one line: a sibling with none of its own is not made by it.
    const sibling = { ...task, id: "task-sibling", amountCents: 2_000 };
    const siblingLine = { ...planAgreedAdjustmentLine({ bookingId: B, lodgeId: LODGE, manualRefundTaskId: sibling.id, direction: "REFUND_TO_MEMBER", amountCents: 1_000, note: "agreed", officerMemberId: "officer" }) };
    const both = row({
      lines: new Ledger().post([share(2_500), siblingLine], LATER).lines,
      tasks: [task, sibling],
      recoveryOperations: [debt(2_500)],
      booking: { id: B, status: "CANCELLED", deletedAt: null, organiserSettled: false, finalPriceCents: 19_000 },
    });
    expect(findings(both)).toEqual(["SOURCE_DRIFT:line-2"]);
    expect(findings({ ...both, recoveryOperations: [debt(2_500), debt(1_000, sibling.id)] })).toEqual([]);
    // Nor is a second live stand-in of the same task made by the refund the first used.
    expect(findings(row({ ...both, lines: new Ledger().post([share(2_500), { ...share(2_500), postingKey: `${share(2_500).postingKey}-again` }], LATER).lines, tasks: [task] }))).toEqual(["SOURCE_DRIFT:line-2"]);
  });

  /**
   * #3913 F1/F3: an internet-banking booking cancelled at 50% (its own hand-back
   * of $95 made), then a review handed back by bank transfer: its stand-in and
   * hand-back posted, and the refunded column raised by the hand-back.
   */
  function bankReviewed(shareCents: number, lineCents: number, handBackCents: number): BookingLedgerCensusRow {
    const base = cashCancelled("COMPLETED");
    const ledger = new Ledger();
    ledger.lines = base.lines.map((line) => ({ rateMembershipTypeId: null, ageTier: null, guestNames: [], narration: "", ...line }));
    ledger.post([share(lineCents), planHandBackLine({ bookingId: B, lodgeId: LODGE, manualRefundTaskId: TASK, amountCents: handBackCents, settlementMethod: "INTERNET_BANKING", officerMemberId: "officer" })], LATER);
    return {
      ...base,
      lines: ledger.lines,
      tasks: [...base.tasks, { ...task, amountCents: shareCents }],
      payment: { ...base.payment!, refundedAmountCents: base.payment!.refundedAmountCents + handBackCents },
    };
  }
  const reviewLines = (subject: BookingLedgerCensusRow) => ({
    standIn: subject.lines.find((line) => line.kind === "AGREED_ADJUSTMENT")!.id,
    handBack: subject.lines.find((line) => line.kind === "BANK_REFUND" && line.anchorId === TASK)!.id,
  });

  it("#3913 F3: a netted hand-back its stand-in bears out explains the refunded column as REFUND_MIRROR_HAND_BACK", () => {
    const netted = bankReviewed(5_000, 2_500, 2_500);
    expect(findings(netted)).toEqual([]);
    const refunded = identity(netted, "REFUNDED");
    expect(refunded.status).toBe("CLASSIFIED");
    // The cancellation's $95 hand-back and the review's $25, the share it is smaller than notwithstanding.
    expect(refunded.explainedBy).toEqual([{ name: "REFUND_MIRROR_HAND_BACK", cents: 12_000 }]);
  });

  it("#3913 F4: a task's hand-back is #3835's own query, read on the live lines - a reversed one bears nothing out, another task's or kind's is not it", () => {
    const where = editReviewHandBackLinesWhere([TASK]);
    const handBack = bankReviewed(5_000, 2_500, 2_500).lines.find((line) => line.kind === "BANK_REFUND" && line.anchorId === TASK)!;
    expect(isEditReviewHandBackLine(handBack, TASK)).toBe(true);
    for (const [key, value] of [["kind", "CARD_REFUND"], ["anchorKind", "CANCELLATION"], ["anchorId", "task-other"], ["reversesLineId", "line-1"]] as const) {
      expect(isEditReviewHandBackLine({ ...handBack, [key]: value }, TASK), key).toBe(false);
    }
    // The query #3835 runs is exactly those four predicates and no other, so
    // the census's reading of a line and #3835's of a row cannot part.
    expect(where).toEqual({ kind: "BANK_REFUND", anchorKind: "REVIEW_TASK", anchorId: { in: [TASK] }, reversesLineId: null });
    // #3835 counts a hand-back a later reversal undid (`reversesLineId: null` keeps the original);
    // the census does not, so such a stand-in is drift - the stricter reading, never an excuse.
    const netted = bankReviewed(5_000, 2_500, 2_500);
    const original = netted.lines.find((line) => line.id === handBack.id)!;
    const reversed = { ...netted, lines: [...netted.lines, { ...original, id: "line-reversal", sign: -original.sign, amountCents: -original.amountCents, reversesLineId: original.id, postingKey: `${original.postingKey}:reversal` }] };
    expect(findings(reversed)).toContain(`SOURCE_DRIFT:${reviewLines(netted).standIn}`);
  });

  it("#3913 F1: a hand-back above the share, with the stand-in it makes, is drift - neither is netted, and the refunded column is not classified", () => {
    const over = bankReviewed(2_500, 3_000, 3_000);
    const { standIn, handBack } = reviewLines(over);
    expect(findings(over).sort()).toEqual([`SOURCE_DRIFT:${handBack}`, `SOURCE_DRIFT:${standIn}`].sort());
    const refunded = identity(over, "REFUNDED");
    // The cancellation's $95 hand-back explains its part; the review's $30 nothing does.
    expect(refunded).toMatchObject({ status: "DISAGREE", deltaCents: 12_500, explainedBy: [] });
  });

  it("#3913 G1: a task that refunded the capture never mints, so an edit's unrelated share credit does not stand in for its missing give-back", () => {
    const debt = (cents: number) => ({ type: "REFUND_BOOKING_MODIFICATION" as const, status: "PENDING" as const, amountCents: cents, idempotencyKey: buildEditFinancialReviewRefundRecoveryIdempotencyKey(TASK) });
    const editCredit = (cents: number) => credit("c-edit", "BOOKING_MODIFICATION_REFUND", cents);
    const cancelledBooking = { id: B, status: "CANCELLED" as const, deletedAt: null, organiserSettled: false, finalPriceCents: 19_000 };
    // Card: a $25 stand-in, $15 to the card, the $10 give-back missing, a $10 edit credit beside it.
    const card = (rows: BookingLedgerCensusRow["credits"]) =>
      row({ lines: new Ledger().post([share(2_500)], LATER).lines, credits: rows, tasks: [task], recoveryOperations: [debt(1_500)], booking: cancelledBooking });
    expect(findings(card([giveBack(1_000)]))).toEqual([]);
    expect(findings(card([editCredit(1_000)]))).toEqual(["SOURCE_DRIFT:line-1"]);
    // Bank transfer: the $50 share whole, $25 handed back, the give-back missing, a $25 edit credit beside it.
    const bank = (rows: BookingLedgerCensusRow["credits"]) =>
      row({
        lines: new Ledger().post([share(5_000), planHandBackLine({ bookingId: B, lodgeId: LODGE, manualRefundTaskId: TASK, amountCents: 2_500, settlementMethod: "INTERNET_BANKING", officerMemberId: "officer" })], LATER).lines,
        credits: rows,
        tasks: [task],
        booking: cancelledBooking,
      });
    expect(findings(bank([giveBack(2_500)]))).toEqual([]);
    expect(findings(bank([editCredit(2_500)]))).toEqual(["SOURCE_DRIFT:line-1", "SOURCE_DRIFT:line-2"]);
    // #3913 lens 3: a hand-back a later reversal undid still means the task
    // refunded the capture, so it still never mints - the edit's $25 credit
    // does not make the $25 stand-in its reversed hand-back no longer does.
    const netted = bankReviewed(5_000, 2_500, 2_500);
    const original = netted.lines.find((line) => line.kind === "BANK_REFUND" && line.anchorId === TASK)!;
    const reversal = { ...original, id: "line-reversal", sign: -original.sign, amountCents: -original.amountCents, reversesLineId: original.id, postingKey: `${original.postingKey}:reversal` };
    const reversed = (rows: BookingLedgerCensusRow["credits"]) => ({ ...netted, lines: [...netted.lines, reversal], credits: rows });
    expect(findings(reversed([editCredit(2_500)]))).toContain(`SOURCE_DRIFT:${reviewLines(netted).standIn}`);
    // Its give-back row still makes it: only the share credit is refused.
    expect(findings(reversed([giveBack(2_500)]))).not.toContain(`SOURCE_DRIFT:${reviewLines(netted).standIn}`);
  });

  it("#3913 G2: where siblings are each made alone but not together, the one line without which the rest are made is named alone; where more could be wrong, every line drawing on a row is", () => {
    const standIn = (taskId: string, cents: number) =>
      planAgreedAdjustmentLine({ bookingId: B, lodgeId: LODGE, manualRefundTaskId: taskId, direction: "REFUND_TO_MEMBER", amountCents: cents, note: "agreed", officerMemberId: "officer" });
    const debt = (cents: number, taskId: string) => ({ type: "REFUND_BOOKING_MODIFICATION" as const, status: "PENDING" as const, amountCents: cents, idempotencyKey: buildEditFinancialReviewRefundRecoveryIdempotencyKey(taskId) });
    const cancelledBooking = { id: B, status: "CANCELLED" as const, deletedAt: null, organiserSettled: false, finalPriceCents: 19_000 };
    // A: $50, $20 handed back and $30 given back. B and C: $10 each, and only
    // one $10 give-back left for them. Removing B or C makes the rest, so more
    // than one line could be the wrong one: every line drawing on a row is
    // named - A's stand-in and so its hand-back too. Over-naming fails closed.
    const contested = row({
      lines: new Ledger().post([
        standIn("task-a", 5_000),
        planHandBackLine({ bookingId: B, lodgeId: LODGE, manualRefundTaskId: "task-a", amountCents: 2_000, settlementMethod: "INTERNET_BANKING", officerMemberId: "officer" }),
        standIn("task-b", 1_000),
        standIn("task-c", 1_000),
      ], LATER).lines,
      credits: [giveBack(3_000, "c-a"), giveBack(1_000, "c-bc")],
      tasks: [{ ...task, id: "task-a", amountCents: 5_000 }, { ...task, id: "task-b", amountCents: 2_000 }, { ...task, id: "task-c", amountCents: 2_000 }],
      booking: cancelledBooking,
    });
    expect(findings(contested)).toEqual(["SOURCE_DRIFT:line-1", "SOURCE_DRIFT:line-2", "SOURCE_DRIFT:line-3", "SOURCE_DRIFT:line-4"]);
    // The lens-3 probe: three $100 siblings, nothing refunded, give-backs of
    // $10, $20 and $30, posted $20, $30 and $30. Removing B or C makes the
    // rest, yet A and B could be the two wrong ones ($10 and $20): all three
    // are named. W, $7 its own card refund made alone, takes no row and is not.
    const probe = row({
      lines: new Ledger().post([standIn("task-a", 2_000), standIn("task-b", 3_000), standIn("task-c", 3_000), standIn("task-w", 700)], LATER).lines,
      credits: [giveBack(1_000, "c-10"), giveBack(2_000, "c-20"), giveBack(3_000, "c-30")],
      tasks: ["task-a", "task-b", "task-c", "task-w"].map((id) => ({ ...task, id, amountCents: 10_000 })),
      recoveryOperations: [debt(700, "task-w")],
      booking: cancelledBooking,
    });
    expect(findings(probe)).toEqual(["SOURCE_DRIFT:line-1", "SOURCE_DRIFT:line-2", "SOURCE_DRIFT:line-3"]);
    // A line nothing makes, even alone, is named - and does not hide the contest the rest still hold.
    const unmade = row({ ...probe, lines: new Ledger().post([standIn("task-a", 2_000), standIn("task-b", 3_000), standIn("task-c", 3_000), standIn("task-w", 700), standIn("task-v", 4_444)], LATER).lines, tasks: [...probe.tasks, { ...task, id: "task-v", amountCents: 10_000 }] });
    expect(findings(unmade)).toEqual(["SOURCE_DRIFT:line-1", "SOURCE_DRIFT:line-2", "SOURCE_DRIFT:line-3", "SOURCE_DRIFT:line-5"]);
    // One wrong line: X, $15, takes the $10 give-back and the $5 share credit
    // both; Y ($2 to its card, so never minting) needs that give-back and Z
    // that credit. Only without X are the rest made, so X alone is named.
    const single = row({
      lines: new Ledger().post([standIn("task-x", 1_500), standIn("task-y", 1_200), standIn("task-z", 500)], LATER).lines,
      credits: [giveBack(1_000), credit("c-mint", "BOOKING_MODIFICATION_REFUND", 500)],
      tasks: ["task-x", "task-y", "task-z"].map((id) => ({ ...task, id, amountCents: 5_000 })),
      recoveryOperations: [debt(200, "task-y")],
      booking: cancelledBooking,
    });
    expect(findings(single)).toEqual(["SOURCE_DRIFT:line-1"]);
  });

  it("#3913 F2: stand-ins the rows could make another way at the same total fail closed as AMBIGUOUS_REVIEW_GIVE_BACK, swapped or not; one task's, or one way's, stays exact", () => {
    const debt = (cents: number, taskId: string) => ({ type: "REFUND_BOOKING_MODIFICATION" as const, status: "PENDING" as const, amountCents: cents, idempotencyKey: buildEditFinancialReviewRefundRecoveryIdempotencyKey(taskId) });
    const sibling = { ...task, id: "task-sibling", amountCents: 2_500 };
    const siblingLine = (cents: number) =>
      planAgreedAdjustmentLine({ bookingId: B, lodgeId: LODGE, manualRefundTaskId: sibling.id, direction: "REFUND_TO_MEMBER", amountCents: cents, note: "agreed", officerMemberId: "officer" });
    // Two $25 shares, each a $10 card debt under its own key; give-backs of $5 and $10.
    const siblings = (taskLineCents: number, siblingLineCents: number, rows = [giveBack(500, "c-give-a"), giveBack(1_000, "c-give-b")]) =>
      row({
        lines: new Ledger().post([share(taskLineCents), siblingLine(siblingLineCents)], LATER).lines,
        credits: rows,
        tasks: [{ ...task, amountCents: 2_500 }, sibling],
        recoveryOperations: [debt(1_000, TASK), debt(1_000, sibling.id)],
        booking: { id: B, status: "CANCELLED", deletedAt: null, organiserSettled: false, finalPriceCents: 19_000 },
      });
    const figures = (subject: BookingLedgerCensusRow) =>
      evaluateBookingLedgerIdentities(subject).bookingInstances.map((instance) => [instance.name, instance.detail, instance.cents]);
    const ambiguous = [
      ["AMBIGUOUS_REVIEW_GIVE_BACK", "review stand-ins after the cancellation", 3_500],
      ["AMBIGUOUS_REVIEW_GIVE_BACK", "their own refunds to the capture", 2_000],
      ["AMBIGUOUS_REVIEW_GIVE_BACK", "review give-back and share credit rows beside them", 1_500],
    ];
    const correct = siblings(1_500, 2_000);
    const swapped = siblings(2_000, 1_500);
    for (const subject of [correct, swapped]) {
      // The rows make either assignment, so neither is drift - and neither is agreement.
      expect(findings(subject)).toEqual([]);
      expect(figures(subject)).toEqual(ambiguous);
      expect(report([subject]).verdict).toBe("GATE_CLOSED");
    }
    // Acknowledged to the cent, as #3583 treats a live booking; a moved figure is stale.
    const acknowledge = (subject: BookingLedgerCensusRow) =>
      evaluateBookingLedgerIdentities(subject).bookingInstances.map((instance) => ({ bookingId: B, class: "AMBIGUOUS_REVIEW_GIVE_BACK" as const, cents: instance.cents, reference: "owner, #3913" }));
    // This bare row holds the gate for other reasons too, so the class's own reason is read.
    const classReason = "3 unacknowledged instance(s) of AMBIGUOUS_REVIEW_GIVE_BACK on 1 booking(s): the owner acknowledges each on #3583";
    expect(report([correct]).gateClosedBecause).toContain(classReason);
    const signed = report([correct], acknowledge(correct));
    expect(signed.classes.AMBIGUOUS_REVIEW_GIVE_BACK.unacknowledged).toBe(0);
    expect(signed.acknowledged.matched).toHaveLength(3);
    expect(signed.gateClosedBecause.filter((reason) => reason.includes("AMBIGUOUS_REVIEW_GIVE_BACK"))).toEqual([]);
    expect(signed.acknowledged.stale).toEqual([]);
    // Still ambiguous, one figure moved: a $7 give-back row no line draws on
    // joins the rows. The stand-ins and refunds still match; the rows' figure
    // is stale, and holds the gate.
    const grown = siblings(1_500, 2_000, [giveBack(500, "c-give-a"), giveBack(1_000, "c-give-b"), giveBack(700, "c-give-c")]);
    expect(findings(grown)).toEqual([]);
    expect(figures(grown).map(([, , cents]) => cents)).toEqual([3_500, 2_000, 2_200]);
    const regrown = report([grown], acknowledge(correct));
    expect(regrown.acknowledged.matched).toHaveLength(2);
    expect(regrown.acknowledged.stale.map((entry) => [entry.cents, entry.foundCents])).toEqual([[1_500, [2_200]]]);
    expect(regrown.verdict).toBe("GATE_CLOSED");
    expect(regrown.gateClosedBecause).toContain("1 stale acknowledgement(s): the figure moved since it was signed off");
    // A give-back a dollar larger: the lines are no longer made, and the sign-off matches nothing.
    const moved = siblings(1_500, 2_000, [giveBack(500, "c-give-a"), giveBack(1_100, "c-give-b")]);
    expect(findings(moved)).not.toEqual([]);
    expect(report([moved], acknowledge(correct)).acknowledged.matched).toEqual([]);
    // No pooled row, each line its own refund alone: exact, not ambiguous.
    const ownOnly = { ...siblings(1_000, 1_000, []) };
    expect(findings(ownOnly)).toEqual([]);
    expect(figures(ownOnly)).toEqual([]);
    // A full share and a netted one swap too: $20 typed and posted whole, $20 typed and $10 given back.
    const pair = row({
      lines: new Ledger().post([share(2_000), siblingLine(1_000)], LATER).lines,
      credits: [giveBack(1_000)],
      tasks: [{ ...task, amountCents: 2_000 }, { ...sibling, amountCents: 2_000 }],
      booking: { id: B, status: "CANCELLED", deletedAt: null, organiserSettled: false, finalPriceCents: 19_000 },
    });
    expect(findings(pair)).toEqual([]);
    expect(figures(pair).map(([name]) => name)).toEqual(Array(3).fill("AMBIGUOUS_REVIEW_GIVE_BACK"));
    // A give-back and an account-credit share's minted credit swap the same way: $10 and $5 or $5 and $10.
    const withMint = row({
      lines: new Ledger().post([share(1_000), siblingLine(500)], LATER).lines,
      credits: [giveBack(1_000), credit("c-mint", "BOOKING_MODIFICATION_REFUND", 500)],
      tasks: [{ ...task, amountCents: 2_000 }, { ...sibling, amountCents: 2_000 }],
      booking: { id: B, status: "CANCELLED", deletedAt: null, organiserSettled: false, finalPriceCents: 19_000 },
    });
    expect(findings(withMint)).toEqual([]);
    expect(figures(withMint).map(([, , cents]) => cents)).toEqual([1_500, 0, 1_500]);
    // Two siblings the rows make only one way - $10 each from two $10 give-backs - are exact.
    const once = row({
      lines: new Ledger().post([share(1_000), siblingLine(1_000)], LATER).lines,
      credits: [giveBack(1_000, "c-1"), giveBack(1_000, "c-2")],
      tasks: [{ ...task, amountCents: 2_000 }, { ...sibling, amountCents: 2_000 }],
      booking: { id: B, status: "CANCELLED", deletedAt: null, organiserSettled: false, finalPriceCents: 19_000 },
    });
    expect(findings(once)).toEqual([]);
    expect(figures(once)).toEqual([]);
    // One task drawing on the rows: exact, as before.
    const single = row({ lines: new Ledger().post([share(2_500)], LATER).lines, credits: [giveBack(1_000)], tasks: [task], recoveryOperations: [debt(1_500, TASK)], booking: { id: B, status: "CANCELLED", deletedAt: null, organiserSettled: false, finalPriceCents: 19_000 } });
    expect(findings(single)).toEqual([]);
    expect(figures(single)).toEqual([]);
  });

  it("#3913 lens 3: the attribution search is bounded - many reviews and share credits finish fast, and a search the budget cuts short fails closed, never exact", () => {
    const cancelledBooking = { id: B, status: "CANCELLED" as const, deletedAt: null, organiserSettled: false, finalPriceCents: 19_000 };
    /** Seven reviews, each posted at `posted(i)` against a `shareOf(i)` share, with give-backs as posted and 20 share credits. */
    const many = (shareOf: (i: number) => number, posted: (i: number) => number, giveBacks: boolean, mintOf: (j: number) => number) => {
      const ids = Array.from({ length: 7 }, (_, i) => `task-many-${i}`);
      return row({
        lines: new Ledger().post(ids.map((id, i) => planAgreedAdjustmentLine({ bookingId: B, lodgeId: LODGE, manualRefundTaskId: id, direction: "REFUND_TO_MEMBER", amountCents: posted(i), note: "agreed", officerMemberId: "officer" })), LATER).lines,
        credits: [
          ...(giveBacks ? ids.map((id, i) => giveBack(posted(i), `c-give-${id}`)) : []),
          ...Array.from({ length: 20 }, (_, j) => credit(`c-mint-${j}`, "BOOKING_MODIFICATION_REFUND", mintOf(j))),
        ],
        tasks: ids.map((id, i) => ({ ...task, id, amountCents: shareOf(i) })),
        booking: cancelledBooking,
      });
    };
    const timed = (subject: BookingLedgerCensusRow) => {
      const before = process.hrtime.bigint();
      const evaluation = evaluateBookingLedgerIdentities(subject);
      return { evaluation, ms: realElapsedMs(before) };
    };
    const details = (evaluation: ReturnType<typeof evaluateBookingLedgerIdentities>) => evaluation.bookingInstances.map((instance) => instance.detail);
    // Every share posted whole beside 20 unrelated share credits: exact, at once.
    const whole = timed(many((i) => 10_000 + i * 1_000, (i) => 10_000 + i * 1_000, false, (j) => 37 + j * 101));
    expect(whole.evaluation.integrity).toEqual([]);
    expect(whole.evaluation.bookingInstances).toEqual([]);
    expect(whole.ms).toBeLessThan(1_000);
    // Give-backs that could be swapped between the shares: the class, found at once.
    const swappable = timed(many((i) => 10_000 + i * 1_000, (i) => 5_000 + i * 100, true, (j) => 37 + j * 101));
    expect(details(swappable.evaluation)[0]).toBe("review stand-ins after the cancellation");
    expect(swappable.ms).toBeLessThan(1_000);
    // Each share just above its own give-back ($10 doubling, $0.50 over) and
    // share credits of 1 to 20 cents: one making only, but proving it would
    // take minutes. The budget stops the search and the booking fails closed.
    const deepRow = many((i) => 1_000 * 2 ** i + 50, (i) => 1_000 * 2 ** i, true, (j) => j + 1);
    const deep = timed(deepRow);
    expect(deep.evaluation.integrity).toEqual([]);
    expect(details(deep.evaluation)).toEqual([
      "review stand-ins after the cancellation, too many to attribute within the census's search budget",
      "their own refunds to the capture",
      "review give-back and share credit rows beside them",
    ]);
    expect(deep.evaluation.bookingInstances.map((instance) => instance.name)).toEqual(Array(3).fill("AMBIGUOUS_REVIEW_GIVE_BACK"));
    expect(report([deepRow]).gateClosedBecause).toContain("3 unacknowledged instance(s) of AMBIGUOUS_REVIEW_GIVE_BACK on 1 booking(s): the owner acknowledges each on #3583");
    expect(deep.ms).toBeLessThan(5_000);
  });

  it("before a cancellation the stand-in is the typed share, whatever rows the booking holds", () => {
    const live = row({ lines: new Ledger().post([share(2_500)], LATER).lines, credits: [giveBack(2_500)], tasks: [task] });
    expect(findings(live)).toEqual(["SOURCE_DRIFT:line-1"]);
  });
});

describe("AMBIGUOUS_REVIEW_GIVE_BACK: a live booking whose give-back rows no task can be told from fails closed (#3583 delta review)", () => {
  const K = "task-k";
  const completed = (id: string, amountCents: number) =>
    ({ id, kind: "EDIT_FINANCIAL_REVIEW" as const, status: "COMPLETED" as const, amountCents, settlementDirection: "REFUND_TO_MEMBER" as const, paymentId: null, lateCaptureApprovalIntentId: null });
  const dismissed = (id: string) => ({ ...completed(id, 0), status: "DISMISSED" as const, amountCents: null, settlementDirection: null });
  const giveBack = (id: string, cents: number) => credit(id, "BOOKING_APPLIED", cents, { sourceBookingId: B });
  const giveBackLine = (taskId: string, cents: number) => ({
    ...planAgreedAdjustmentLine({ bookingId: B, lodgeId: LODGE, manualRefundTaskId: taskId, direction: "REFUND_TO_MEMBER", amountCents: cents, note: "agreed", officerMemberId: "officer" }),
    postingKey: agreedGiveBackKey(taskId),
  });
  const rebased = (id: string, taskId: string, movementCents: number) =>
    ({ id, modificationType: "PRICE_REBASE", priceDiffCents: 0, changeFeeCents: 0, createdAt: LATER, reviewRebase: { taskId, movementCents } });
  const figures = (subject: BookingLedgerCensusRow) =>
    Object.fromEntries(evaluateBookingLedgerIdentities(subject).bookingInstances.map((instance) => [instance.detail, instance.cents]));
  const acknowledge = (subject: BookingLedgerCensusRow) =>
    evaluateBookingLedgerIdentities(subject).bookingInstances.map((instance) => ({ bookingId: B, class: "AMBIGUOUS_REVIEW_GIVE_BACK" as const, cents: instance.cents, reference: "owner, #3583" }));

  /**
   * P1: K's $50 share given back on a covered $190 booking, its line −$50,
   * beside a DISMISSED review D whose re-price took $50 off (real planner
   * lines). Every identity agrees; only the class can say the line is there.
   */
  function p1(kLine: boolean): BookingLedgerCensusRow {
    const ledger = confirmedLedger();
    const creditRows = [credit("c-applied", "BOOKING_APPLIED", -19_000), giveBack("c-k", 5_000)];
    credits(ledger, creditRows);
    const nights = (d2: number) => [guestSide("g1", [[D1, 5_000], [D2, d2]]), guestSide("g2", [[D1, 5_000], [D2, d2]])];
    const plan = planModificationChargeLines({
      bookingId: B,
      lodgeId: LODGE,
      bookingModificationId: "m-d",
      before: { guests: nights(5_000), promoAdjustmentCents: -1_000 },
      after: { guests: nights(2_500), promoAdjustmentCents: -1_000 },
      changeFeeCents: 0,
      expectedCents: -5_000,
      postedLines: ledger.reversible() as never,
    });
    if (plan.kind !== "lines") throw new Error(plan.reason);
    ledger.post(plan.postings, LATER);
    if (kLine) ledger.post([giveBackLine(K, 5_000)], LATER);
    return row({
      lines: ledger.lines,
      credits: creditRows,
      tasks: [completed(K, 5_000), dismissed("task-d")],
      modifications: [rebased("m-d", "task-d", -5_000)],
      booking: { id: B, status: "PAID", deletedAt: null, organiserSettled: false, finalPriceCents: 14_000 },
      payment: payment({ amountCents: 0, creditAppliedCents: 14_000 }),
    });
  }

  it("P1: the correct shape is the class, not agreement; acknowledged to the cent it opens, and deleting K's line makes the acknowledgement stale", () => {
    const correct = p1(true);
    expect(evaluateBookingLedgerIdentities(correct).identities.filter((result) => !["AGREE", "NOT_APPLICABLE"].includes(result.status))).toEqual([]);
    expect(figures(correct)).toEqual({ "agreed give-back lines": 5_000, "review give-back rows": 5_000, "re-price drops on reviews with no give-back line": 5_000 });
    expect(report([correct]).verdict).toBe("GATE_CLOSED");
    expect(draftBookingLedgerAcknowledgements(report([correct])).entries.map((entry) => entry.class)).toEqual(Array(3).fill("AMBIGUOUS_REVIEW_GIVE_BACK"));
    expect(report([correct], acknowledge(correct)).verdict).toBe("GATE_OPEN");

    const deleted = p1(false);
    expect(evaluateBookingLedgerIdentities(deleted).identities.filter((result) => !["AGREE", "NOT_APPLICABLE"].includes(result.status))).toEqual([]);
    const after = report([deleted], acknowledge(correct));
    expect(after.verdict).toBe("GATE_CLOSED");
    expect(after.acknowledged.stale.map((entry) => entry.foundCents)).toEqual([[0]]);
  });

  /** P2/P3 as the reviewer built them: the figures move, so the sign-off does not carry over. */
  const live = (tasks: BookingLedgerCensusRow["tasks"], rows: BookingLedgerCensusRow["credits"], lines: BookingLedgerPosting[], modifications: BookingLedgerCensusRow["modifications"]) =>
    row({ lines: confirmedLedger().post(lines, LATER).lines, credits: rows, tasks, modifications, payment: payment({ amountCents: 0, creditAppliedCents: 19_000 }) });

  it("P2: an unpaid-route give-back with no line beside a dismissed re-price; a forged K line moves the class, it does not agree", () => {
    const shape = (lines: BookingLedgerPosting[]) => live([completed(K, 4_000), dismissed("task-d")], [giveBack("c-k", 4_000)], lines, [rebased("m-d", "task-d", -5_000)]);
    const correct = shape([]);
    const forged = shape([giveBackLine(K, 4_000)]);
    expect(Object.values(figures(correct))).toEqual([0, 4_000, 5_000]);
    expect(Object.values(figures(forged))).toEqual([4_000, 4_000, 5_000]);
    expect(evaluateBookingLedgerIdentities(forged).integrity).toEqual([]);
    const after = report([forged], acknowledge(correct));
    expect(after.verdict).toBe("GATE_CLOSED");
    expect(after.acknowledged.stale).toHaveLength(1);
  });

  it("P3: an overstated line that borrows a sibling's row is caught by the moved figure", () => {
    const A = "task-a";
    const shape = (aLineCents: number) =>
      live([completed(A, 7_000), completed("task-b", 6_000)], [giveBack("c-a", 4_000), giveBack("c-b", 6_000)], [giveBackLine(A, aLineCents)], [rebased("m-b", "task-b", -6_000)]);
    expect(evaluateBookingLedgerIdentities(shape(6_000)).integrity).toEqual([]);
    const after = report([shape(6_000)], acknowledge(shape(4_000)));
    expect(after.verdict).toBe("GATE_CLOSED");
    expect(after.acknowledged.stale.map((entry) => entry.cents)).toEqual([4_000]);
  });

  it("P4: a forged line with no sibling drop is not ambiguous: it is source drift, as before", () => {
    const forged = live([completed(K, 5_000), completed("task-x", 5_000)], [giveBack("c-k", 5_000)], [giveBackLine(K, 5_000), giveBackLine("task-x", 5_000)], []);
    const evaluation = evaluateBookingLedgerIdentities(forged);
    expect(evaluation.bookingInstances).toEqual([]);
    expect(evaluation.integrity.map((finding) => finding.kind)).toEqual(["SOURCE_DRIFT"]);
  });

  it("a cancelled booking's rows no two tasks' stand-ins draw on are not ambiguous: its owed(b) == 0 checks the total exactly", () => {
    const cancelled = live([completed(K, 4_000), dismissed("task-d")], [giveBack("c-k", 4_000)], [], [rebased("m-d", "task-d", -5_000)]);
    expect(evaluateBookingLedgerIdentities({ ...cancelled, booking: { ...cancelled.booking, status: "CANCELLED" } }).bookingInstances).toEqual([]);
  });
});

describe("a one-cent mutation either way, of a line or a column, is a disagreement naming the booking, both figures and the delta", () => {
  const cases: Array<[BookingLedgerIdentity, () => BookingLedgerCensusRow, CensusLedgerLine["kind"], Parameters<typeof bumpPayment>[1] | "finalPriceCents"]> = [
    ["PRICE", cardPaid, "GUEST_NIGHT", "finalPriceCents"],
    ["CAPTURED", cardPaid, "CARD_CAPTURE", "amountCents"],
    ["CREDIT_APPLIED", creditAndCard, "CREDIT_APPLIED", "creditAppliedCents"],
    ["REFUNDED", reducedAndRefunded, "CARD_REFUND", "refundedAmountCents"],
    ["CHANGE_FEE", reducedAndRefunded, "CHANGE_FEE", "changeFeeCents"],
    ["ADDITIONAL", raisedWithAsk, "GUEST_NIGHT", "additionalAmountCents"],
    ["OWED", () => reductionCredited(true), "CREDIT_ISSUED", "amountCents"],
  ];
  const directions: Array<1 | -1> = [1, -1];

  for (const by of directions) {
    it.each(cases)(`%s: the line, ${by > 0 ? "+" : "−"}1 cent`, (name, build, kind) => {
      const before = identity(build(), name);
      const mutated = bumpLine(build(), kind, by);
      const after = identity(mutated, name);
      expect(after.status).toBe("DISAGREE");
      expect(after.columnCents).toBe(before.columnCents);
      expect(Math.abs(after.ledgerCents - before.ledgerCents)).toBe(1);
      expect(after.deltaCents).toBe(after.columnCents - after.ledgerCents);
      expect(report([mutated]).disagreements).toContainEqual({ bookingId: B, identity: name, columnCents: after.columnCents, ledgerCents: after.ledgerCents, deltaCents: after.deltaCents });
    });

    it.each(cases)(`%s: the column, ${by > 0 ? "+" : "−"}1 cent`, (name, build, _kind, column) => {
      const subject = build();
      const bumped =
        column === "finalPriceCents"
          ? { ...subject, booking: { ...subject.booking, finalPriceCents: subject.booking.finalPriceCents + by } }
          : bumpPayment(subject, column, by);
      const result = identity(bumped, name);
      expect(result.status).toBe("DISAGREE");
      expect(Math.abs(result.deltaCents)).toBe(1);
    });
  }

  it("the cancelled form (owed is zero) disagrees on a one-cent line either way", () => {
    expect(identity(bumpLine(cashCancelled("COMPLETED"), "CANCELLATION_FEE"), "PRICE")).toMatchObject({ status: "DISAGREE", columnCents: 0, ledgerCents: 1, deltaCents: -1 });
    expect(identity(bumpLine(cashCancelled("COMPLETED"), "CANCELLATION_FEE", -1), "PRICE")).toMatchObject({ status: "DISAGREE", columnCents: 0, ledgerCents: -1, deltaCents: 1 });
  });
});

// ---------------------------------------------------------------------------
// The class fixtures
// ---------------------------------------------------------------------------

/** Confirmed by a mark-paid since reversed; the column keeps the primary's face amount. */
function nothingCaptured(): BookingLedgerCensusRow {
  const ledger = confirmedLedger();
  const paid = row({ lines: [], transactions: [txn("t1", 19_000)], payment: payment({ source: "INTERNET_BANKING" }) });
  settle(ledger, paid, true);
  const reversed = { ...paid, transactions: [txn("t1", 19_000, { status: "FAILED" })] };
  settle(ledger, reversed, false, LATER);
  return { ...reversed, booking: { ...paid.booking, status: "PAYMENT_PENDING" }, payment: payment({ source: "INTERNET_BANKING", status: "PENDING" }), lines: ledger.lines };
}

/** #1641's shape: a full-price card capture beside $40 of applied credit nobody allocated — paid twice. */
function cardDoublePay(): BookingLedgerCensusRow {
  const ledger = confirmedLedger();
  const rows = [credit("c1", "BOOKING_APPLIED", -4_000)];
  const subject = row({ lines: [], transactions: [txn("t1", 19_000)], credits: rows, payment: payment({ creditAppliedCents: 0 }) });
  credits(ledger, rows);
  settle(ledger, subject);
  return { ...subject, lines: ledger.lines };
}

/** $150 applied, $40 captured: the Xero allocation repair capped the column at the payment amount. */
function xeroCappedCredit(): BookingLedgerCensusRow {
  const ledger = confirmedLedger();
  // Stamped with the Xero note the allocation repair recorded.
  const rows = [credit("c1", "BOOKING_APPLIED", -15_000, { xeroCreditNoteId: "cn-repair" })];
  const subject = row({ lines: [], transactions: [txn("t1", 4_000)], credits: rows, payment: payment({ amountCents: 4_000, creditAppliedCents: 4_000 }) });
  credits(ledger, rows);
  settle(ledger, subject);
  return { ...subject, lines: ledger.lines };
}

/** Card paid, cancelled at 50% to account credit: the cancel's credit branch allocated the refund. */
function cancelledToCredit(): BookingLedgerCensusRow {
  const ledger = confirmedLedger();
  const base = row({ lines: [], transactions: [txn("t1", 19_000, { refundedAmountCents: 9_500 })] });
  settle(ledger, base);
  const cancel = planCancellationChargeLines({ bookingId: B, lodgeId: LODGE, keptCents: 9_500, chargeLines: ledger.reversible(), adjustmentLines: [] });
  if (cancel.kind !== "lines") throw new Error("cancel plan refused");
  ledger.post(cancel.postings, LATER);
  const rows = [credit("c-cancel", "CANCELLATION_REFUND", 9_500, { description: cancellationCreditDescription(B) })];
  credits(ledger, rows);
  return { ...base, booking: { ...base.booking, status: "CANCELLED" }, credits: rows, payment: payment({ refundedAmountCents: 9_500 }), cancellation: { refundMethod: "credit", settledAmountCents: 9_500, keptCents: 9_500 }, lines: ledger.lines };
}

/** A $45 card refund recorded, then failed: the ledger reversed it, the pre-#3640 column kept counting it. */
function failedRefund(): BookingLedgerCensusRow {
  const ledger = confirmedLedger();
  const recorded = row({ lines: [], transactions: [txn("t1", 19_000, { refundedAmountCents: 4_500 })], refunds: [{ id: "r1", status: "succeeded", amountCents: 4_500, paymentTransactionId: "t1" }] });
  settle(ledger, recorded);
  const failed = { ...recorded, refunds: [{ ...recorded.refunds[0]!, status: "failed" }] };
  settle(ledger, failed, false, LATER);
  return { ...failed, payment: payment({ refundedAmountCents: 4_500 }), lines: ledger.lines };
}

/** A legacy payment's transactions seeded with a $20 refund and no refund row. */
function legacySeed(): BookingLedgerCensusRow {
  const subject = cardPaid();
  return { ...subject, transactions: [txn("t1", 19_000, { refundedAmountCents: 2_000, reason: "legacy_primary_backfill" })], payment: payment({ refundedAmountCents: 2_000 }) };
}

/** V3: a late capture on a deleted booking, handed back by an officer on its card payment. */
function v3(): BookingLedgerCensusRow {
  const ledger = new Ledger();
  const base = row({ lines: [], booking: { id: B, status: "PENDING", deletedAt: LATER, organiserSettled: false, finalPriceCents: 19_000 }, transactions: [txn("t1", 19_000, { refundedAmountCents: 19_000 })] });
  settle(ledger, base);
  return {
    ...base,
    lines: ledger.lines,
    payment: payment({ refundedAmountCents: 19_000 }),
    tasks: [{ id: "task-v3", kind: "DELETED_BOOKING_LATE_CAPTURE", status: "COMPLETED", amountCents: 19_000, settlementDirection: null, paymentId: "pay-3583", lateCaptureApprovalIntentId: null }],
  };
}

/** The edit's $5 change fee, then a cancellation that kept only $3 and so took the fee back. */
function changeFeeTakenBack(): BookingLedgerCensusRow {
  const edited = reducedAndRefunded();
  const ledger = new Ledger();
  ledger.lines = [...(edited.lines as Line[])];
  const cancel = planCancellationChargeLines({ bookingId: B, lodgeId: LODGE, keptCents: 300, chargeLines: ledger.reversible(), adjustmentLines: [] });
  if (cancel.kind !== "lines" || !cancel.changeFeesReversed) throw new Error("expected the change fee reversed");
  ledger.post(cancel.postings, LATER);
  return { ...edited, booking: { ...edited.booking, status: "CANCELLED" }, lines: ledger.lines };
}

/** A CHARGE share the price does not carry: no adjustment line, the ask outstanding (LANE-SYNC, 30 Sep). */
function retainedShare(collected: boolean): BookingLedgerCensusRow {
  const subject = cardPaid();
  const ledger = new Ledger();
  ledger.lines = [...(subject.lines as Line[])];
  const transactions = [txn("t1", 19_000), txn("a1", 2_500, { kind: "ADDITIONAL", status: collected ? "SUCCEEDED" : "PENDING", createdAt: LATER })];
  if (collected) settle(ledger, { ...subject, transactions }, false, LATER);
  return {
    ...subject,
    lines: ledger.lines,
    transactions,
    tasks: [{ id: "task-share", kind: "EDIT_FINANCIAL_REVIEW", status: "COMPLETED", amountCents: 2_500, settlementDirection: "CHARGE_TO_MEMBER", paymentId: "pay-3583", lateCaptureApprovalIntentId: null }],
    payment: payment({ amountCents: collected ? 21_500 : 19_000, additionalAmountCents: 2_500, additionalPaymentStatus: collected ? "SUCCEEDED" : "PENDING" }),
  };
}

/** #3791: credit-only $200, a $50 review share refunded as credit (minted, pre-fix), cancelled at a tier. owed = +$50. */
function defect3791(restoredCents = 20_000): BookingLedgerCensusRow {
  const ledger = confirmedLedger(0);
  const applied = [credit("c1", "BOOKING_APPLIED", -20_000)];
  credits(ledger, applied);
  ledger.post([planAgreedAdjustmentLine({ bookingId: B, lodgeId: LODGE, manualRefundTaskId: "task-3791", direction: "REFUND_TO_MEMBER", amountCents: 5_000, note: "share", officerMemberId: "officer" })], LATER);
  const mint = [...applied, credit("c2", "BOOKING_MODIFICATION_REFUND", 5_000)];
  credits(ledger, mint);
  const keptCents = 20_000 - restoredCents;
  const cancel = planCancellationChargeLines({ bookingId: B, lodgeId: LODGE, keptCents, chargeLines: ledger.reversible(), adjustmentLines: ledger.adjustments() });
  if (cancel.kind !== "lines") throw new Error("cancel plan refused");
  ledger.post(cancel.postings, LATER);
  const all = [...mint, credit("c3", "CANCELLATION_REFUND", restoredCents, { restoredFromBookingId: B })];
  credits(ledger, all);
  return row({
    lines: ledger.lines,
    booking: { id: B, status: "CANCELLED", deletedAt: null, organiserSettled: false, finalPriceCents: 20_000 },
    payment: payment({ amountCents: 0, creditAppliedCents: 20_000 }),
    credits: all,
    tasks: [{ id: "task-3791", kind: "EDIT_FINANCIAL_REVIEW", status: "COMPLETED", amountCents: 5_000, settlementDirection: "REFUND_TO_MEMBER", paymentId: null, lateCaptureApprovalIntentId: null }],
    cancellation: { refundMethod: "credit", settledAmountCents: restoredCents, keptCents },
  });
}

/** #3792: $80 credit + $120 by bank transfer, the late capacity cancel minted the cash, never restored the $80. */
function defect3792(): BookingLedgerCensusRow {
  const ledger = new Ledger();
  const applied = [credit("c1", "BOOKING_APPLIED", -8_000)];
  credits(ledger, applied);
  const base = row({ lines: [], booking: { id: B, status: "CANCELLED", deletedAt: null, organiserSettled: false, finalPriceCents: 20_000 }, transactions: [txn("t1", 12_000)], payment: payment({ source: "INTERNET_BANKING", amountCents: 12_000, creditAppliedCents: 8_000 }) });
  settle(ledger, base);
  const all = [...applied, credit("c2", "CANCELLATION_REFUND", 12_000, { description: "Internet Banking payment credit for booking bk-3583" })];
  credits(ledger, all);
  return { ...base, credits: all, lines: ledger.lines };
}


// ---------------------------------------------------------------------------
// Every named class: its fixture lands in it; a cent either way, or its
// evidence taken away, and it does not
// ---------------------------------------------------------------------------

type Mutate = (subject: BookingLedgerCensusRow, by: 1 | -1) => BookingLedgerCensusRow;
const withTasks = (status: "OPEN" | "COMPLETED" | "DISMISSED") => (s: BookingLedgerCensusRow) => ({ ...s, tasks: s.tasks.map((task) => ({ ...task, status })) });
const unstamped = (s: BookingLedgerCensusRow) => ({ ...s, credits: s.credits.map((c) => ({ ...c, xeroCreditNoteId: null })) });
const stamped = (s: BookingLedgerCensusRow) => ({ ...s, credits: s.credits.map((c) => ({ ...c, xeroCreditNoteId: "cn-allocated" })) });
const onCard = (s: BookingLedgerCensusRow) => ({ ...s, payment: { ...s.payment!, source: "STRIPE" as const } });
const withoutRefundLines = (s: BookingLedgerCensusRow) => ({ ...s, lines: s.lines.filter((line) => line.anchorKind !== "PAYMENT_REFUND") });

describe("every named class lands in its class; a cent either way, or its evidence removed, is a generic disagreement", () => {
  const cases: Array<[string, BookingLedgerIdentity, () => BookingLedgerCensusRow, Mutate, (s: BookingLedgerCensusRow) => BookingLedgerCensusRow, string?]> = [
    ["NOTHING_CAPTURED", "CAPTURED", nothingCaptured, (s, by) => bumpPayment(s, "amountCents", by), (s) => ({ ...s, transactions: [] })],
    ["NOTHING_CAPTURED", "OWED", nothingCaptured, (s, by) => bumpPayment(s, "amountCents", by), (s) => ({ ...s, transactions: [] })],
    ["CREDIT_MIRROR_XERO_CAP", "CREDIT_APPLIED", xeroCappedCredit, (s, by) => bumpPayment(s, "creditAppliedCents", by), unstamped],
    ["CREDIT_MIRROR_XERO_CAP", "OWED", xeroCappedCredit, (s, by) => bumpPayment(s, "creditAppliedCents", by), unstamped],
    ["KNOWN_DEFECT_HISTORY", "CREDIT_APPLIED", cardDoublePay, (s, by) => bumpPayment(s, "creditAppliedCents", by), stamped, "#1641"],
    ["KNOWN_DEFECT_HISTORY", "OWED", cardDoublePay, (s, by) => bumpPayment(s, "amountCents", by), stamped, "#1641"],
    ["REFUND_MIRROR_HAND_BACK", "REFUNDED", () => cashCancelled("COMPLETED"), (s, by) => bumpPayment(s, "refundedAmountCents", by), withTasks("OPEN")],
    [
      "REFUND_MIRROR_CREDIT_ALLOCATION",
      "REFUNDED",
      cancelledToCredit,
      (s, by) => bumpPayment(s, "refundedAmountCents", by),
      (s) => ({ ...s, credits: s.credits.map((c) => ({ ...c, description: `Internet Banking payment credit for booking ${B}` })) }),
    ],
    // Its evidence is the refund's own line, posted and then reversed: without it, the failure explains nothing.
    ["REFUND_MIRROR_FAILED_REFUND", "REFUNDED", failedRefund, (s, by) => bumpPayment(s, "refundedAmountCents", by), withoutRefundLines],
    ["REFUND_MIRROR_FAILED_REFUND", "OWED", failedRefund, (s, by) => bumpPayment(s, "refundedAmountCents", by), withoutRefundLines],
    ["REFUND_MIRROR_LEGACY_SEED", "REFUNDED", legacySeed, (s, by) => bumpPayment(s, "refundedAmountCents", by), (s) => ({ ...s, transactions: s.transactions.map((t) => ({ ...t, reason: null })) })],
    ["V3_LEGACY_HAND_BACK", "REFUNDED", v3, (s, by) => bumpPayment(s, "refundedAmountCents", by), (s) => ({ ...s, booking: { ...s.booking, deletedAt: null } })],
    [
      "CHANGE_FEE_REVERSED_BY_CANCELLATION",
      "CHANGE_FEE",
      changeFeeTakenBack,
      (s, by) => bumpPayment(s, "changeFeeCents", by),
      (s) => ({ ...s, lines: s.lines.map((line) => (line.kind === "CHANGE_FEE" && line.anchorKind === "CANCELLATION" ? { ...line, anchorKind: "MODIFICATION" as const } : line)) }),
    ],
    ["RETAINED_REVIEW_SHARE", "ADDITIONAL", () => retainedShare(false), (s, by) => bumpPayment(s, "additionalAmountCents", by), withTasks("OPEN")],
    ["IN_FLIGHT_HAND_BACK", "PRICE", () => cashCancelled("OPEN"), (s, by) => bumpLine(s, "CANCELLATION_FEE", by), onCard],
    ["D2_DISMISSED_HAND_BACK", "PRICE", () => cashCancelled("DISMISSED"), (s, by) => bumpLine(s, "CANCELLATION_FEE", by), onCard],
    [
      "IN_FLIGHT_REFUND",
      "PRICE",
      () => cardCancelled(9_500, false),
      (s, by) => bumpLine(s, "CANCELLATION_FEE", by),
      (s) => ({ ...s, recoveryOperations: s.recoveryOperations.map((op) => ({ ...op, status: "FAILED" as const })) }),
    ],
    [
      "V5_PLANNED_REFUND_SHORT",
      "PRICE",
      () => cardCancelled(9_000, true),
      (s, by) => bumpLine(s, "CANCELLATION_FEE", by),
      (s) => ({ ...s, cancellation: { ...s.cancellation!, refundMethod: "credit" } }),
    ],
    ["KNOWN_DEFECT_HISTORY", "PRICE", () => defect3791(), (s, by) => bumpLine(s, "CREDIT_ISSUED", by), (s) => ({ ...s, tasks: [] }), "#3791"],
    ["KNOWN_DEFECT_HISTORY", "PRICE", () => defect3791(10_000), (s, by) => bumpLine(s, "CREDIT_ISSUED", by), (s) => ({ ...s, tasks: [] }), "#3791"],
    ["KNOWN_DEFECT_HISTORY", "PRICE", defect3792, (s, by) => bumpLine(s, "BANK_RECEIPT", by), onCard, "#3792"],
  ];

  it.each(cases)("%s on %s", (name, which, build, plusCent, removeEvidence, detail) => {
    const classified = identity(build(), which);
    expect(classified.status).toBe("CLASSIFIED");
    expect(classified.explainedBy.map((component) => component.name)).toEqual([name]);
    if (detail) expect(classified.explainedBy[0]?.detail).toContain(detail);
    expect(classified.explainedBy.reduce((sum, component) => sum + component.cents, 0)).toBe(classified.deltaCents);
    for (const by of [1, -1] as const) {
      const generic = identity(plusCent(build(), by), which);
      expect(generic.status, `${name} ${by > 0 ? "+" : "−"}1 cent`).toBe("DISAGREE");
      expect(generic.explainedBy).toEqual([]);
    }
    // The evidence the component is computed from, taken away: the delta is
    // unchanged, so a class that read the delta would still fire. It must not.
    const bare = identity(removeEvidence(build()), which);
    expect(bare.deltaCents, `${name}: removing evidence must not move the delta`).toBe(classified.deltaCents);
    expect(bare.status, `${name} without its evidence`).toBe("DISAGREE");
  });

  it("an in-flight card refund planned short is both classes at once, summing exactly", () => {
    const result = identity(cardCancelled(9_000, false), "PRICE");
    expect(result.status).toBe("CLASSIFIED");
    expect(result.explainedBy.map((component) => component.name).sort()).toEqual(["IN_FLIGHT_REFUND", "V5_PLANNED_REFUND_SHORT"]);
  });

  it("RETAINED_COLLECTED is information: once the share is collected every identity agrees and owed reads −share", () => {
    const evaluation = evaluateBookingLedgerIdentities(retainedShare(true));
    expect(evaluation.identities.filter((result) => result.status !== "AGREE" && result.status !== "NOT_APPLICABLE")).toEqual([]);
    expect(evaluation.info.retainedCollectedCents).toBe(2_500);
  });

  it("RETAINED_REVIEW_SHARE does not swallow a stale ask for a share a closure re-price already carried", () => {
    const shared = retainedShare(false);
    const ledger = new Ledger();
    ledger.lines = [...(shared.lines as Line[])];
    const plan = planModificationChargeLines({
      bookingId: B,
      lodgeId: LODGE,
      bookingModificationId: "m-rebase",
      before: { guests: [guestSide("g1", [[D1, 5_000], [D2, 5_000]]), guestSide("g2", [[D1, 5_000], [D2, 5_000]])], promoAdjustmentCents: -1_000 },
      after: { guests: [guestSide("g1", [[D1, 5_000], [D2, 7_500]]), guestSide("g2", [[D1, 5_000], [D2, 5_000]])], promoAdjustmentCents: -1_000 },
      changeFeeCents: 0,
      expectedCents: 2_500,
      postedLines: ledger.reversible() as never,
    });
    if (plan.kind !== "lines") throw new Error(plan.reason);
    ledger.post(plan.postings, LATER);
    // The member has since paid the share another way; the ask is stale.
    const transactions = [...shared.transactions, txn("t2", 2_500, { createdAt: LATER })];
    settle(ledger, { ...shared, transactions }, false, LATER);
    const stale = {
      ...shared,
      lines: ledger.lines,
      transactions,
      booking: { ...shared.booking, finalPriceCents: 21_500 },
      modifications: [{ id: "m-rebase", modificationType: "PRICE_REBASE", priceDiffCents: 0, changeFeeCents: 0, createdAt: LATER, reviewRebase: null }],
      payment: payment({ amountCents: 21_500, additionalAmountCents: 2_500, additionalPaymentStatus: "PENDING" }),
    };
    expect(identity(stale, "ADDITIONAL")).toMatchObject({ status: "DISAGREE", columnCents: 2_500, ledgerCents: 0 });
  });

  it("GROUP_SETTLEMENT_OFF_LEDGER is a booking-level class, and a child with a transaction of its own is a coverage gap instead", () => {
    const child = row({ lines: [], booking: { id: B, status: "PAID", deletedAt: null, organiserSettled: true, finalPriceCents: 19_000 } });
    expect(evaluateBookingLedgerIdentities(child)).toMatchObject({ bookingClass: "GROUP_SETTLEMENT_OFF_LEDGER", coverage: [] });
    expect(evaluateBookingLedgerIdentities({ ...child, transactions: [txn("t1", 19_000)] })).toMatchObject({ bookingClass: null, coverage: ["NO_LINES"] });
  });
});

describe("coverage: the gap before the back-post, named and holding the gate", () => {
  it("NO_LINES: money columns and no line at all", () => {
    expect(evaluateBookingLedgerIdentities(row({ lines: [], transactions: [txn("t1", 19_000)] })).coverage).toEqual(["NO_LINES"]);
    expect(evaluateBookingLedgerIdentities(row({ lines: [], booking: { id: B, status: "PENDING", deletedAt: null, organiserSettled: false, finalPriceCents: 19_000 }, payment: payment({ status: "PENDING" }) })).coverage).toEqual([]);
  });

  it("NOT_CONFIRMED_ON_LEDGER: a paid booking with lines but no confirmation", () => {
    const ledger = new Ledger();
    const subject = row({ lines: [], transactions: [txn("t1", 19_000)] });
    settle(ledger, subject);
    const evaluation = evaluateBookingLedgerIdentities({ ...subject, lines: ledger.lines });
    expect(evaluation.coverage).toEqual(["NOT_CONFIRMED_ON_LEDGER"]);
    expect(evaluation.identities.find((result) => result.identity === "PRICE")?.status).toBe("COVERAGE");
  });

  it("UNPOSTED_EDIT: an edit after confirmation that posted nothing, to the cent; a cent either way, or the edit made before confirmation, is a disagreement", () => {
    const subject = { ...cardPaid(), booking: { id: B, status: "PAID" as const, deletedAt: null, organiserSettled: false, finalPriceCents: 21_500 }, modifications: [{ id: "m9", modificationType: "BATCH_MODIFY", priceDiffCents: 2_500, changeFeeCents: 0, createdAt: LATER, reviewRebase: null }] };
    expect(identity(subject, "PRICE")).toMatchObject({ status: "COVERAGE", deltaCents: 2_500 });
    expect(evaluateBookingLedgerIdentities(subject).coverage).toEqual(["UNPOSTED_EDIT"]);
    for (const by of [1, -1]) expect(identity({ ...subject, booking: { ...subject.booking, finalPriceCents: 21_500 + by } }, "PRICE").status).toBe("DISAGREE");
    expect(identity({ ...subject, modifications: [{ ...subject.modifications[0]!, createdAt: EARLIER }] }, "PRICE").status).toBe("DISAGREE");
  });

  it("one rule with the back-post: an unposted edit a later edit with lines has passed is carried; the latest stays awaiting (review M1)", () => {
    const at = (iso: string) => new Date(iso);
    const confirmation = { anchorKind: "CONFIRMATION" as const, anchorId: B, postedAt: at("2026-06-01T00:00:00.000Z") };
    const edits = [
      { id: "e1", createdAt: at("2026-06-02T00:00:00.000Z") },
      { id: "e2", createdAt: at("2026-06-03T00:00:00.000Z") },
      { id: "e3", createdAt: at("2026-06-04T00:00:00.000Z") },
      { id: "e0", createdAt: at("2026-05-01T00:00:00.000Z") },
    ];
    const onE2 = { anchorKind: "MODIFICATION" as const, anchorId: "e2", postedAt: at("2026-06-05T00:00:00.000Z") };
    expect(postConfirmationEditsWithoutLines(edits, [confirmation])).toEqual({ awaiting: ["e1", "e2", "e3"], carriedByLater: [] });
    expect(postConfirmationEditsWithoutLines(edits, [confirmation, onE2])).toEqual({ awaiting: ["e3"], carriedByLater: ["e1"] });
    expect(postConfirmationEditsWithoutLines(edits, [])).toEqual({ awaiting: [], carriedByLater: [] });

    // In the census: with no later posted edit it is coverage; passed by one, too.
    const unposted = { id: "m9", modificationType: "BATCH_MODIFY", priceDiffCents: 2_500, changeFeeCents: 0, createdAt: LATER, reviewRebase: null };
    const subject = { ...cardPaid(), booking: { id: B, status: "PAID" as const, deletedAt: null, organiserSettled: false, finalPriceCents: 21_500 }, modifications: [unposted] };
    expect(identity(subject, "PRICE").status).toBe("COVERAGE");
    const later = { id: "m10", modificationType: "BATCH_MODIFY", priceDiffCents: 0, changeFeeCents: 500, createdAt: new Date(LATER.getTime() + 60_000), reviewRebase: null };
    // m10's change fee, as the edit planner posts it (the back-post's own change-fee-only plan).
    const feePlan = planModificationChargeLines({
      bookingId: B,
      lodgeId: "lodge",
      bookingModificationId: "m10",
      before: { guests: [], promoAdjustmentCents: 0 },
      after: { guests: [], promoAdjustmentCents: 0 },
      changeFeeCents: 500,
      expectedCents: 500,
      postedLines: [],
    });
    const fee = new Ledger().post(feePlan.kind === "lines" ? feePlan.postings : [], later.createdAt).lines.map((line) => ({ ...line, id: `fee-${line.id}` }));
    expect(fee).toHaveLength(1);
    const passed = { ...subject, payment: payment({ ...subject.payment, changeFeeCents: 500 }), modifications: [unposted, later], lines: [...subject.lines, ...fee] };
    // A live edit never absorbs a refused one, so the carried edit's money is coverage (delta M-1).
    expect(identity(passed, "PRICE")).toMatchObject({ status: "COVERAGE", deltaCents: 2_500 });
  });

  it("a refused edit a later posted edit passed, beside one still awaiting, is coverage for both — never a signable disagreement (delta M-1)", () => {
    const at = (offset: number) => new Date(LATER.getTime() + offset * 60_000);
    const refusedA = { id: "ma", modificationType: "GUEST_UPDATE", priceDiffCents: 1_000, changeFeeCents: 0, createdAt: at(0), reviewRebase: null };
    const postedB = { id: "mb", modificationType: "BATCH_MODIFY", priceDiffCents: 0, changeFeeCents: 500, createdAt: at(1), reviewRebase: null };
    const refusedC = { id: "mc", modificationType: "GUEST_UPDATE", priceDiffCents: 500, changeFeeCents: 0, createdAt: at(2), reviewRebase: null };
    const feePlan = planModificationChargeLines({
      bookingId: B,
      lodgeId: "lodge",
      bookingModificationId: "mb",
      before: { guests: [], promoAdjustmentCents: 0 },
      after: { guests: [], promoAdjustmentCents: 0 },
      changeFeeCents: 500,
      expectedCents: 500,
      postedLines: [],
    });
    const fee = new Ledger().post(feePlan.kind === "lines" ? feePlan.postings : [], postedB.createdAt).lines.map((line) => ({ ...line, id: `fee-${line.id}` }));
    const base = cardPaid();
    const subject = {
      ...base,
      booking: { ...base.booking, finalPriceCents: base.booking.finalPriceCents + 1_500 },
      payment: payment({ ...base.payment, changeFeeCents: 500 }),
      modifications: [refusedA, postedB, refusedC],
      lines: [...base.lines, ...fee],
    };
    const evaluation = evaluateBookingLedgerIdentities(subject);
    expect(identity(subject, "PRICE")).toMatchObject({ status: "COVERAGE", deltaCents: 1_500 });
    expect(identity(subject, "OWED").status).toBe("COVERAGE");
    expect(evaluation.coverage).toContain("UNPOSTED_EDIT");
    // Awaiting alone still wins where it is exact: the carried edit is then on the ledger.
    expect(identity({ ...subject, booking: { ...subject.booking, finalPriceCents: subject.booking.finalPriceCents - 1_000 } }, "PRICE")).toMatchObject({ status: "COVERAGE", deltaCents: 500 });
    for (const by of [1, -1]) expect(identity({ ...subject, booking: { ...subject.booking, finalPriceCents: subject.booking.finalPriceCents + by } }, "PRICE").status).toBe("DISAGREE");
  });

  it("UNPOSTED_CHANGE_FEE: a fee charged before confirmation has no line (#3611 V4)", () => {
    const subject = { ...cardPaid(), payment: payment({ changeFeeCents: 500 }), modifications: [{ id: "m0", modificationType: "BATCH_MODIFY", priceDiffCents: 0, changeFeeCents: 500, createdAt: EARLIER, reviewRebase: null }] };
    expect(identity(subject, "CHANGE_FEE")).toMatchObject({ status: "COVERAGE", deltaCents: 500 });
    for (const by of [1, -1] as const) expect(identity(bumpPayment(subject, "changeFeeCents", by), "CHANGE_FEE").status).toBe("DISAGREE");
    expect(identity({ ...subject, modifications: [] }, "CHANGE_FEE").status).toBe("DISAGREE");
  });

  it("UNPOSTED_CREDIT is a booking-level gap too: an unposted applied row on a booking no identity it changes applies to", () => {
    const ledger = new Ledger();
    const subject = row({
      lines: [],
      booking: { id: B, status: "PENDING", deletedAt: null, organiserSettled: false, finalPriceCents: 19_000 },
      transactions: [txn("t1", 19_000)],
      credits: [credit("c-applied", "BOOKING_APPLIED", -1_000)],
      // The mirror never counted it either, so CREDIT_APPLIED reads 0 == 0.
      payment: payment({ creditAppliedCents: 0 }),
    });
    settle(ledger, subject);
    const evaluation = evaluateBookingLedgerIdentities({ ...subject, lines: ledger.lines });
    expect(evaluation.identities.filter((result) => result.status !== "AGREE" && result.status !== "NOT_APPLICABLE")).toEqual([]);
    expect(evaluation.coverage).toEqual(["UNPOSTED_CREDIT"]);
  });

  it("UNPOSTED_CREDIT: a credit row with no line, and without the row the same columns disagree", () => {
    const missing = reductionCredited(false);
    expect(evaluateBookingLedgerIdentities(missing).coverage).toEqual(["UNPOSTED_CREDIT"]);
    expect(identity({ ...missing, credits: [] }, "REFUNDED").status).toBe("DISAGREE");
    expect(identity({ ...missing, credits: [] }, "OWED").status).toBe("DISAGREE");
  });
});

describe("integrity: what must hold of the lines whatever the columns say", () => {
  const withLine = (extra: Partial<CensusLedgerLine>) => {
    const subject = cardPaid();
    const capture = subject.lines.find((line) => line.kind === "CARD_CAPTURE")!;
    return { ...subject, lines: [...subject.lines, { ...capture, id: "rogue", postingKey: "capture:rogue", ...extra }] };
  };
  const kinds = (subject: BookingLedgerCensusRow) => evaluateBookingLedgerIdentities(subject).integrity.map((finding) => finding.kind);

  it("a reversal of a line the booking does not hold", () => {
    expect(kinds(withLine({ sign: -1, amountCents: -19_000, reversesLineId: "elsewhere", postingKey: "reversal:elsewhere" }))).toContain("REVERSAL_TARGET_MISSING");
  });

  it("a reversal that is not the exact opposite of its target", () => {
    const capture = cardPaid().lines.find((line) => line.kind === "CARD_CAPTURE")!;
    expect(kinds(withLine({ sign: -1, unitCents: 18_999, amountCents: -18_999, reversesLineId: capture.id, postingKey: `reversal:${capture.id}` }))).toEqual(["REVERSAL_NOT_OPPOSITE"]);
    expect(kinds(withLine({ sign: -1, amountCents: -19_000, reversesLineId: capture.id, postingKey: `reversal:${capture.id}` }))).toEqual([]);
  });

  it("two live lines for one guest's one night", () => {
    const subject = cardPaid();
    const night = subject.lines.find((line) => line.kind === "GUEST_NIGHT")!;
    expect(kinds({ ...subject, lines: [...subject.lines, { ...night, id: "twice", postingKey: "confirmation:again" }] })).toEqual(["DUPLICATE_LIVE_NIGHT"]);
  });

  it("a key in no namespace the key builders make, and a key on an anchor its namespace never posts under", () => {
    expect(kinds(withLine({ postingKey: "rogue:1", anchorId: "t1" }))).toContain("UNKNOWN_KEY_NAMESPACE");
    const subject = cardPaid();
    const capture = subject.lines.find((line) => line.kind === "CARD_CAPTURE")!;
    expect(kinds({ ...subject, lines: subject.lines.map((line) => (line === capture ? { ...line, postingKey: "credit:t1" } : line)) })).toEqual(["KEY_ANCHOR_MISMATCH"]);
  });

  it("a live line whose source row is gone, or says another amount", () => {
    expect(kinds(withLine({ anchorId: "no-such-transaction" }))).toEqual(["SOURCE_DRIFT"]);
    expect(kinds({ ...cardPaid(), transactions: [txn("t1", 19_001)] })).toEqual(["SOURCE_DRIFT"]);
    const drifted = creditAndCard();
    expect(kinds({ ...drifted, credits: [{ ...drifted.credits[0]!, amountCents: -3_999 }] })).toEqual(["SOURCE_DRIFT"]);
  });

  it("a cancellation fee that is not the kept figure the CANCELLED event froze", () => {
    const subject = cashCancelled("COMPLETED");
    expect(kinds(subject)).toEqual([]);
    expect(kinds({ ...subject, cancellation: { ...subject.cancellation!, keptCents: 9_499 } })).toEqual(["SOURCE_DRIFT"]);
  });
});

describe("paging inside the snapshot", () => {
  it("evaluates every booking exactly once across page boundaries, each credit row with the booking it belongs to", async () => {
    const stored = ["a", "b", "c", "d", "e"].map((id) => ({
      id,
      status: "PENDING" as const,
      deletedAt: null,
      organiserSettled: false,
      finalPriceCents: 0,
      payment: null,
      manualRefundTasks: [],
      modifications: [],
      paymentRecoveryOperations: [],
      events: [],
      ledgerLines: [],
    }));
    // Issued FROM b (page 1) though it names e (page 3); applied TO e though it names a.
    const creditRows = [
      { ...credit("x", "CANCELLATION_REFUND", 1_000), sourceBookingId: "b", appliedToBookingId: "e" },
      { ...credit("y", "BOOKING_APPLIED", -500), appliedToBookingId: "e", sourceBookingId: "a" },
    ];
    const pages: string[][] = [];
    const tx = {
      booking: {
        findMany: vi.fn(async ({ where, take }: { where: { id?: { gt: string } }; take: number }) => {
          const page = stored.filter((booking) => !where.id || booking.id > where.id.gt).slice(0, take);
          pages.push(page.map((booking) => booking.id));
          return page;
        }),
      },
      memberCredit: {
        findMany: vi.fn(async ({ where }: { where: { OR: Array<{ type: unknown; appliedToBookingId?: { in: string[] }; sourceBookingId?: { in: string[] } }> } }) =>
          creditRows.filter((credit) =>
            where.OR.some((clause) =>
              clause.appliedToBookingId
                ? credit.type === "BOOKING_APPLIED" && clause.appliedToBookingId.in.includes(credit.appliedToBookingId ?? "")
                : credit.type !== "BOOKING_APPLIED" && clause.sourceBookingId!.in.includes(credit.sourceBookingId ?? ""),
            ),
          ),
        ),
      },
    };
    const seen: Array<[string, string[]]> = [];
    const evaluations = await evaluateBookingLedgerPages(tx as never, 2, (subject) => {
      seen.push([subject.booking.id, subject.credits.map((credit) => credit.id)]);
      return evaluateBookingLedgerIdentities(subject);
    });
    expect(pages).toEqual([["a", "b"], ["c", "d"], ["e"]]);
    expect(evaluations.map((evaluation) => evaluation.bookingId)).toEqual(["a", "b", "c", "d", "e"]);
    expect(seen).toEqual([["a", []], ["b", ["x"]], ["c", []], ["d", []], ["e", ["y"]]]);
  });
});

describe("the owner's acknowledgements", () => {
  it("an exact match moves a gate-holding class instance to acknowledged, and the gate opens", () => {
    const summary = report([defect3791()], [{ bookingId: B, class: "KNOWN_DEFECT_HISTORY", cents: -5_000, reference: "written off, decision on #3583" }]);
    expect(summary.acknowledged.matched).toHaveLength(1);
    expect(summary.verdict).toBe("GATE_OPEN");
  });

  it("a mismatched amount is stale and still holds the gate; an entry matching nothing is reported", () => {
    const stale = report([defect3791()], [{ bookingId: B, class: "KNOWN_DEFECT_HISTORY", cents: -4_999, reference: "x" }]);
    expect(stale.acknowledged.stale).toEqual([expect.objectContaining({ cents: -4_999, foundCents: [-5_000] })]);
    expect(stale.verdict).toBe("GATE_CLOSED");
    expect(stale.gateClosedBecause).toContain("1 stale acknowledgement(s): the figure moved since it was signed off");
    const nothing = report([cardPaid()], [{ bookingId: "no-such-booking", identity: "CAPTURED", cents: 1, reference: "x" }]);
    expect(nothing.acknowledged.unmatched).toHaveLength(1);
    expect(nothing.verdict).toBe("GATE_OPEN");
  });

  it("a disagreement acknowledged to the cent leaves the disagreements, one entry per identity", () => {
    const drifted = bumpPayment(cardPaid(), "amountCents");
    const once = report([drifted], [{ bookingId: B, identity: "CAPTURED", cents: 1, reference: "x" }]);
    expect(once.disagreements.map((row) => row.identity)).toEqual(["OWED"]);
    const both = report([drifted], [
      { bookingId: B, identity: "CAPTURED", cents: 1, reference: "x" },
      { bookingId: B, identity: "OWED", cents: -1, reference: "x" },
    ]);
    expect(both.disagreements).toEqual([]);
    expect(both.verdict).toBe("GATE_OPEN");
  });
});

describe("the verdict", () => {
  it("GATE_OPEN on agreement, and on class instances the owner has acknowledged to the cent", () => {
    expect(report([cardPaid(), raisedWithAsk()]).verdict).toBe("GATE_OPEN");
    const acknowledged = report(
      [cardPaid(), raisedWithAsk(), cashCancelled("OPEN"), retainedShare(false)],
      [
        { bookingId: B, class: "IN_FLIGHT_HAND_BACK", cents: 9_500, reference: "hand-back in progress" },
        { bookingId: B, class: "RETAINED_REVIEW_SHARE", cents: 2_500, reference: "share agreed, ask outstanding" },
      ],
    );
    expect(acknowledged.unacknowledgedClassInstances).toBe(0);
    expect(acknowledged.verdict).toBe("GATE_OPEN");
  });

  it("closes on a disagreement, a coverage gap, an integrity finding, or a class the policy says holds it", () => {
    expect(report([bumpPayment(cardPaid(), "amountCents")]).verdict).toBe("GATE_CLOSED");
    expect(report([row({ lines: [], transactions: [txn("t1", 19_000)] })]).verdict).toBe("GATE_CLOSED");
    const capture = cardPaid().lines.find((line) => line.kind === "CARD_CAPTURE")!;
    expect(report([{ ...cardPaid(), lines: [...cardPaid().lines.filter((line) => line !== capture), { ...capture, postingKey: "rogue:1" }] }]).verdict).toBe("GATE_CLOSED");
    const defect = report([defect3791()]);
    expect(defect.verdict).toBe("GATE_CLOSED");
    expect(defect.gateClosedBecause).toEqual(["1 booking(s) in KNOWN_DEFECT_HISTORY, which holds the gate"]);
  });

  it("the owner's two decisions on #3583 (both A) are the policy: KNOWN_DEFECT_HISTORY holds, GROUP_SETTLEMENT_OFF_LEDGER is listed only", () => {
    expect(BOOKING_LEDGER_CENSUS_GATE_POLICY).toEqual({ knownDefectHistoryHoldsGate: true, groupSettlementOffLedgerHoldsGate: false });
    const child = row({ lines: [], booking: { id: B, status: "PAID", deletedAt: null, organiserSettled: true, finalPriceCents: 19_000 } });
    const summary = report([child]);
    expect(summary.classes.GROUP_SETTLEMENT_OFF_LEDGER).toMatchObject({ gateRule: "OPEN", holdsGate: false, bookings: 1, unacknowledged: 0 });
    expect(summary.unacknowledgedClassInstances).toBe(0);
    expect(summary.verdict).toBe("GATE_OPEN");
  });

  it("reports per identity applicable, agree, disagree, classified and coverage counts, and the #1620 line with each booking", () => {
    const strand = { ...creditAndCard(), payment: payment({ source: "INTERNET_BANKING", amountCents: 15_000, creditAppliedCents: 4_000, status: "PENDING" }) };
    const summary = report([cardPaid(), bumpPayment(cardPaid(), "amountCents"), nothingCaptured(), strand]);
    expect(summary.identities.CAPTURED).toEqual({ applicable: 4, agree: 2, disagree: 1, classified: 1, coverage: 0 });
    expect(summary.info.ibUnallocatedAppliedCredit).toEqual({
      realized: { bookings: 0, cents: 0, items: [] },
      unverified: { bookings: 1, cents: 4_000, items: [{ bookingId: B, cents: 4_000, evidence: "unverified" }] },
    });
  });
});

describe("#1620's line reads settlement evidence, never the payment mirror (#3632, ported from the retired audit)", () => {
  type Txn = BookingLedgerCensusRow["transactions"][number];
  /** A live internet-banking booking carrying $40 of applied credit no Xero note allocates, on invoice inv_1. */
  const strand = (paymentOverrides: Partial<NonNullable<BookingLedgerCensusRow["payment"]>> = {}, transactions: Txn[] = []) => {
    const base = creditAndCard();
    return {
      ...base,
      transactions,
      payment: payment({ source: "INTERNET_BANKING", amountCents: 15_000, creditAppliedCents: 4_000, status: "PENDING", xeroInvoiceId: "inv_1", ...paymentOverrides }),
    };
  };
  const ibReceipt = (overrides: Partial<Txn> = {}) => txn("t-ib", 15_000, { source: "INTERNET_BANKING", xeroInvoiceId: "inv_1", ...overrides });
  const line = (subject: BookingLedgerCensusRow) => evaluateBookingLedgerIdentities(subject).info.ibUnallocatedAppliedCredit;

  it("a row without current settlement evidence is unverified, not unpaid", () => {
    expect(line(strand())).toEqual({ evidence: "unverified", cents: 4_000 });
  });

  it("a current Xero-reconciled IB PRIMARY receipt makes it realized", () => {
    expect(line(strand({ status: "SUCCEEDED" }, [ibReceipt()]))).toEqual({ evidence: "xero-primary-receipt", cents: 4_000 });
    expect(report([strand({ status: "SUCCEEDED" }, [ibReceipt()])]).info.ibUnallocatedAppliedCredit.realized).toMatchObject({ bookings: 1, cents: 4_000 });
  });

  it("a manually recorded settlement is realized without Xero linkage", () => {
    expect(line(strand({ manuallyMarkedPaidAt: new Date("2026-08-01T00:00:00.000Z"), xeroInvoiceId: null }))?.evidence).toBe("manual-settlement");
  });

  it.each([
    ["a card-origin Stripe PRIMARY on the same invoice", {}, [ibReceipt({ source: "STRIPE", status: "REFUNDED" })]],
    ["a captured ADDITIONAL transaction", {}, [ibReceipt({ kind: "ADDITIONAL" })]],
    ["a captured receipt for a superseded invoice", { status: "SUCCEEDED" as const }, [ibReceipt({ xeroInvoiceId: "inv_old" })]],
    ["an invoice-less receipt on a payment with no current invoice", { xeroInvoiceId: null }, [ibReceipt({ xeroInvoiceId: null })]],
    ["a credit-note repair that changed only the mirror", { status: "REFUNDED" as const }, []],
  ] as const)("%s stays unverified", (_name, paymentOverrides, transactions) => {
    expect(line(strand(paymentOverrides, [...transactions]))?.evidence).toBe("unverified");
  });

  it("a bank transfer proven paid is never NOTHING_CAPTURED, whatever its mirror says", () => {
    const unpaid = nothingCaptured();
    expect(identity(unpaid, "CAPTURED").status).toBe("CLASSIFIED");
    const settled = { ...unpaid, payment: { ...unpaid.payment!, manuallyMarkedPaidAt: new Date("2026-08-01T00:00:00.000Z") } };
    expect(identity(settled, "CAPTURED").status).toBe("DISAGREE");
  });
});

describe("the acknowledgement draft (--write-acknowledgement-draft)", () => {
  /** Each fixture under its own booking id, so one report holds them side by side. */
  const as = (bookingId: string, subject: BookingLedgerCensusRow) => ({ ...evaluateBookingLedgerIdentities(subject), bookingId });
  const evaluations = () => [
    as("in-flight", cashCancelled("OPEN")),
    as("unpaid", nothingCaptured()),
    as("defect", defect3791()),
    as("drifted", bumpPayment(cardPaid(), "amountCents")),
    as("no-lines", row({ lines: [], transactions: [txn("t1", 19_000)] })),
    as("group", row({ lines: [], booking: { id: B, status: "PAID", deletedAt: null, organiserSettled: true, finalPriceCents: 19_000 } })),
  ];
  const census = (acknowledgements: Parameters<typeof summarizeBookingLedgerCensus>[2] = []) => summarizeBookingLedgerCensus(evaluations(), null, acknowledgements);

  it("drafts one entry per unacknowledged class instance, to the cent, in the format --acknowledged reads", () => {
    const draft = draftBookingLedgerAcknowledgements(census());
    expect(draft.entries.map(({ bookingId, class: name, cents }) => [bookingId, name, cents])).toEqual([
      ["unpaid", "NOTHING_CAPTURED", 19_000],
      ["unpaid", "NOTHING_CAPTURED", -19_000],
      ["in-flight", "IN_FLIGHT_HAND_BACK", 9_500],
    ]);
    expect(BOOKING_LEDGER_ACKNOWLEDGEMENT_FILE.parse(JSON.parse(JSON.stringify(draft.entries)))).toEqual(draft.entries);
    expect(draft.entries.every((entry) => entry.reference.startsWith("DRAFT"))).toBe(true);
  });

  it("leaves out KNOWN_DEFECT_HISTORY, naming how many and why, and every disagreement, coverage gap and integrity finding", () => {
    const draft = draftBookingLedgerAcknowledgements(census());
    expect(draft.entries.some((entry) => entry.class === "KNOWN_DEFECT_HISTORY")).toBe(false);
    expect(draft.excluded).toEqual([{ class: "KNOWN_DEFECT_HISTORY", instances: 1, bookings: 1, reason: expect.stringContaining("owner decision 1") }]);
    expect(draft.entries.some((entry) => ["drifted", "no-lines", "group", "defect"].includes(entry.bookingId))).toBe(false);
    expect(draft.entries.every((entry) => entry.identity === undefined && entry.class !== undefined)).toBe(true);
  });

  it("round-trips: fed back, it releases exactly those instances; the rest still hold, and a moved figure goes stale", () => {
    const draft = draftBookingLedgerAcknowledgements(census());
    const signed = census(draft.entries);
    expect(signed.acknowledged.matched).toHaveLength(draft.entries.length);
    expect(signed.acknowledged.stale).toEqual([]);
    expect(signed.unacknowledgedClassInstances).toBe(1); // the KNOWN_DEFECT_HISTORY instance
    // What a draft can never release still holds: the disagreement, the coverage gap, the defect.
    expect(signed.verdict).toBe("GATE_CLOSED");
    expect(signed.disagreements.map((row) => row.bookingId)).toContain("drifted");
    expect(signed.coverage.NO_LINES).toEqual(["no-lines"]);
    expect(signed.gateClosedBecause.some((reason) => reason.includes("NOTHING_CAPTURED") || reason.includes("IN_FLIGHT_HAND_BACK"))).toBe(false);
    expect(signed.gateClosedBecause).toContain("1 booking(s) in KNOWN_DEFECT_HISTORY, which holds the gate");
    expect(draftBookingLedgerAcknowledgements(signed).entries).toEqual([]);

    const moved = census(draft.entries.map((entry) => (entry.class === "IN_FLIGHT_HAND_BACK" ? { ...entry, cents: entry.cents - 500 } : entry)));
    expect(moved.acknowledged.stale).toEqual([expect.objectContaining({ class: "IN_FLIGHT_HAND_BACK", cents: 9_000, foundCents: [9_500] })]);
    expect(moved.gateClosedBecause.some((reason) => reason.includes("IN_FLIGHT_HAND_BACK"))).toBe(true);
  });
});

/*
  #3829 composed this census with epic #3813's by-hand refunds: an edit's
  reduction on an internet-banking booking raises a CANCELLED_BOOKING_HAND_BACK
  marked by its occurrence key (`INV-PAY-117`). On a cancelled booking that open
  task is money still going back, exactly as the cancellation's own hand-back is,
  and the ledger has not posted its bank refund yet - so it belongs in
  IN_FLIGHT_HAND_BACK. Excluding it (as the cancellation-only readers must)
  would leave its cents unexplained here.
*/
describe("an open edit refund hand-back on a cancelled internet-banking booking is in flight (#3829, INV-PAY-117)", () => {
  /** $190 marked paid, an edit removes a $50 night ($50 hand-back open), cancelled at 50% of the $140 left: $70 kept, $70 handed back. */
  function editedThenCancelled(): BookingLedgerCensusRow {
    const ledger = confirmedLedger();
    const base = row({ lines: [], transactions: [txn("t1", 19_000)], payment: payment({ source: "INTERNET_BANKING" }) });
    settle(ledger, base, true);
    const edit = planModificationChargeLines({
      bookingId: B,
      lodgeId: LODGE,
      bookingModificationId: "m1",
      before: { guests: [guestSide("g1", [[D1, 5_000], [D2, 5_000]]), guestSide("g2", [[D1, 5_000], [D2, 5_000]])], promoAdjustmentCents: -1_000 },
      after: { guests: [guestSide("g1", [[D1, 5_000], [D2, 5_000]]), guestSide("g2", [[D1, 5_000]])], promoAdjustmentCents: -1_000 },
      changeFeeCents: 0,
      expectedCents: -5_000,
      postedLines: ledger.reversible() as never,
    });
    if (edit.kind !== "lines") throw new Error(`edit plan refused: ${edit.reason}`);
    ledger.post(edit.postings, LATER);
    const cancel = planCancellationChargeLines({ bookingId: B, lodgeId: LODGE, keptCents: 7_000, chargeLines: ledger.reversible(), adjustmentLines: ledger.adjustments() });
    if (cancel.kind !== "lines") throw new Error("cancel plan refused");
    ledger.post(cancel.postings, LATER);
    const handBack = { kind: "CANCELLED_BOOKING_HAND_BACK" as const, status: "OPEN" as const, settlementDirection: null, paymentId: "pay-3583", lateCaptureApprovalIntentId: null };
    return {
      ...base,
      lines: ledger.lines,
      booking: { ...base.booking, status: "CANCELLED", finalPriceCents: 14_000 },
      modifications: [{ id: "m1", modificationType: "BATCH_MODIFY", priceDiffCents: -5_000, changeFeeCents: 0, createdAt: LATER, reviewRebase: null }],
      tasks: [
        { ...handBack, id: "task-cancel", amountCents: 7_000 },
        { ...handBack, id: "task-edit", amountCents: 5_000 },
      ],
      cancellation: { refundMethod: "manual", settledAmountCents: 7_000, keptCents: 7_000 },
    };
  }

  it("both open hand-backs explain what the member is still owed", () => {
    expect(identity(editedThenCancelled(), "PRICE")).toMatchObject({
      status: "CLASSIFIED",
      deltaCents: 12_000,
      explainedBy: [{ name: "IN_FLIGHT_HAND_BACK", cents: 12_000 }],
    });
  });

  it("MUTATION: without the edit's hand-back the same booking disagrees", () => {
    const subject = editedThenCancelled();
    expect(identity({ ...subject, tasks: subject.tasks.filter((task) => task.id !== "task-edit") }, "PRICE")).toMatchObject({
      status: "DISAGREE",
      explainedBy: [],
    });
  });
});
