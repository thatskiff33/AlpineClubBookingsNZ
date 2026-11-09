/**
 * #4866 (`INV-PAY-145`): what a cancellation leaves to a live superseded
 * capture's refund, per charge (`supersededCaptureHeldBack`), and the card
 * planner leaving it alone (`planCardRefundFromLedger`). The cancel's claim
 * and the preview run both; `superseded-refund-cancel-hold-back.realdb.test.ts`
 * proves the whole path, and the race, against PostgreSQL.
 */
import { describe, expect, it } from "vitest";

import { planCardRefundFromLedger } from "@/lib/payment-transactions";
import {
  readSupersededCaptureHeldBack,
  supersededCaptureHeldBack as heldBackOf,
  type SupersededHoldBackCharge,
} from "@/lib/superseded-capture-hold-back";
import type { SupersededOwningRow } from "@/lib/superseded-intent-ownership";

type SupersededHoldBackOperation = SupersededOwningRow;

/** The owning rows alone, nothing owed back again unless given. */
const supersededCaptureHeldBack = (owning: SupersededHoldBackOperation[], charges: SupersededHoldBackCharge[], owedAgainByIntent = new Map<string, number>()) =>
  heldBackOf({ owning, owedAgainByIntent }, charges);

const PAYMENT = "pay-4866";

const charge = (id: string, amountCents: number, refundedAmountCents = 0, status: SupersededHoldBackCharge["status"] = "SUCCEEDED"): SupersededHoldBackCharge => ({
  id,
  paymentId: PAYMENT,
  status,
  stripePaymentIntentId: `pi_${id}`,
  amountCents,
  refundedAmountCents,
});

const supersededRefund = (paymentTransactionId: string, amountCents: number, allocationPlan: unknown = null): SupersededHoldBackOperation => ({
  type: "REFUND_SUPERSEDED_PAYMENT" as const,
  paymentId: PAYMENT,
  paymentTransactionId,
  amountCents,
  allocationPlan,
});

const cancelRow = (paymentTransactionId: string, amountCents: number): SupersededHoldBackOperation => ({
  type: "CANCEL_PAYMENT_INTENT" as const,
  paymentId: PAYMENT,
  paymentTransactionId,
  amountCents,
  allocationPlan: null,
});

describe("supersededCaptureHeldBack (#4866)", () => {
  it("a plan-less refund row holds what its runner would send: what its charge still holds, up to its amount", () => {
    expect(supersededCaptureHeldBack([supersededRefund("sup", 6_500)], [charge("prim", 13_000), charge("sup", 6_500)])).toEqual({
      byTransaction: new Map([["sup", 6_500]]),
      totalCents: 6_500,
    });
    // Part already refunded (its own earlier request, or another door's before it was raised): only the rest.
    expect(supersededCaptureHeldBack([supersededRefund("sup", 6_500)], [charge("sup", 6_500, 2_000, "PARTIALLY_REFUNDED")]).totalCents).toBe(4_500);
    // Nothing left on the charge: nothing held.
    expect(supersededCaptureHeldBack([supersededRefund("sup", 6_500)], [charge("sup", 6_500, 6_500, "REFUNDED")]).byTransaction).toEqual(new Map([["sup", 0]]));
  });

  it("a refund row with a stored plan holds its unmarked slices, never more than its charge holds", () => {
    const plan = [{ paymentTransactionId: "sup", amountCents: 6_500, stripeKeySuffix: "r1" }];
    expect(supersededCaptureHeldBack([supersededRefund("sup", 6_500, plan)], [charge("sup", 6_500)]).totalCents).toBe(6_500);
    const marked = [{ paymentTransactionId: "sup", amountCents: 6_500, madeRefundId: "re_1" }];
    expect(supersededCaptureHeldBack([supersededRefund("sup", 6_500, marked)], [charge("sup", 6_500)]).totalCents).toBe(0);
    expect(supersededCaptureHeldBack([supersededRefund("sup", 6_500, plan)], [charge("sup", 6_500, 5_000, "PARTIALLY_REFUNDED")]).totalCents).toBe(1_500);
  });

  it("a cancel row in flight holds the whole of its charge once the hand-off flipped it captured, and nothing before", () => {
    expect(supersededCaptureHeldBack([cancelRow("sup", 6_500)], [charge("sup", 6_500)]).totalCents).toBe(6_500);
    expect(supersededCaptureHeldBack([cancelRow("sup", 6_500)], [charge("sup", 6_500, 0, "PENDING")]).totalCents).toBe(0);
  });

  it("a cancel row and its refund row on one charge hold it once", () => {
    expect(supersededCaptureHeldBack([cancelRow("sup", 6_500), supersededRefund("sup", 6_500)], [charge("sup", 6_500)])).toEqual({
      byTransaction: new Map([["sup", 6_500]]),
      totalCents: 6_500,
    });
  });

  it("a row naming no charge of this payment holds nothing", () => {
    expect(supersededCaptureHeldBack([supersededRefund("elsewhere", 6_500)], [charge("sup", 6_500)]).totalCents).toBe(0);
    expect(supersededCaptureHeldBack([{ ...supersededRefund("sup", 6_500), paymentId: "another" }], [charge("sup", 6_500)]).totalCents).toBe(0);
    expect(supersededCaptureHeldBack([{ ...supersededRefund("sup", 6_500), paymentTransactionId: null }], [charge("sup", 6_500)]).totalCents).toBe(0);
  });

  it("holds what open rows owe back again after a superseded refund failed later, by the capture's intent (#4221's cents)", () => {
    // R closed; its refund failed later; a failed-later row owes the $65.00 again: the charge holds it all again.
    expect(supersededCaptureHeldBack([], [charge("prim", 13_000), charge("sup", 6_500)], new Map([["pi_sup", 6_500]]))).toEqual({
      byTransaction: new Map([["sup", 6_500]]),
      totalCents: 6_500,
    });
    // Never more than the charge holds, and nothing on a charge no longer captured.
    expect(supersededCaptureHeldBack([], [charge("sup", 6_500, 2_000, "PARTIALLY_REFUNDED")], new Map([["pi_sup", 6_500]])).totalCents).toBe(4_500);
    expect(supersededCaptureHeldBack([supersededRefund("sup", 6_500)], [charge("sup", 6_500)], new Map([["pi_sup", 6_500]])).totalCents).toBe(6_500);
    expect(supersededCaptureHeldBack([], [charge("sup", 6_500, 0, "PENDING")], new Map([["pi_sup", 6_500]])).totalCents).toBe(0);
  });

  it("reads ownership through the Xero reading's one home: the same rows, and the payment only when a superseded row exists", async () => {
    const findMany = async ({ where }: { where: { OR: unknown[] } }) => {
      seenWhere.push(where);
      return rows;
    };
    const seenWhere: unknown[] = [];
    let rows: unknown[] = [];
    let paymentReads = 0;
    const db = {
      paymentRecoveryOperation: { findMany },
      payment: { findUnique: async () => { paymentReads += 1; return { status: "SUCCEEDED", amountCents: 6_500, refundedAmountCents: 0, recoveryOperations: [], refunds: [] }; } },
      paymentTransaction: { findMany: async () => [charge("sup", 6_500)] },
    };
    expect(await readSupersededCaptureHeldBack(db as never, PAYMENT)).toEqual({ byTransaction: new Map(), totalCents: 0 });
    expect(paymentReads).toBe(0);
    // The shared reading's rows: superseded refunds of any status, open failed-later and card refund rows, in-flight cancels.
    expect(JSON.stringify(seenWhere[0])).toContain("REFUND_SUPERSEDED_PAYMENT");
    expect(JSON.stringify(seenWhere[0])).toContain("CANCEL_PAYMENT_INTENT");
    expect(JSON.stringify(seenWhere[0])).toContain(String.raw`card\\_refund\\_failed\\_later\\_`); // the failed-later key prefix, escaped for LIKE
    rows = [{ id: "r", type: "REFUND_SUPERSEDED_PAYMENT", status: "SUCCEEDED", paymentId: PAYMENT, paymentIntentId: "pi_sup", paymentTransactionId: "sup", idempotencyKey: "k", attempts: 1, nextRetryAt: null, amountCents: 6_500, allocationPlan: null }];
    // A closed superseded refund owns nothing of its own; nothing owed back again here.
    expect(await readSupersededCaptureHeldBack(db as never, PAYMENT)).toEqual({ byTransaction: new Map(), totalCents: 0 });
    expect(paymentReads).toBe(1);
  });
});

describe("planCardRefundFromLedger leaves a held-back charge alone (#4866)", () => {
  const ledger = [
    { id: "prim", source: "STRIPE" as const, stripePaymentIntentId: "pi_prim", status: "SUCCEEDED" as const, amountCents: 13_000, refundedAmountCents: 0, createdAt: new Date("2026-05-01T00:00:00.000Z"), insertionSeq: 1 },
    { id: "sup", source: "STRIPE" as const, stripePaymentIntentId: "pi_sup", status: "SUCCEEDED" as const, amountCents: 6_500, refundedAmountCents: 0, createdAt: new Date("2026-06-01T00:00:00.000Z"), insertionSeq: 2 },
  ];

  it("without a hold-back the newest charge goes first, as before", () => {
    expect(planCardRefundFromLedger(ledger, 13_000)).toEqual({
      slices: [
        { paymentTransactionId: "sup", amountCents: 6_500 },
        { paymentTransactionId: "prim", amountCents: 6_500 },
      ],
      plannedAmountCents: 13_000,
      totalRefundableCents: 19_500,
    });
  });

  it("with one, the held cents are in no slice and not refundable", () => {
    expect(planCardRefundFromLedger(ledger, 13_000, new Map([["sup", 6_500]]))).toEqual({
      slices: [{ paymentTransactionId: "prim", amountCents: 13_000 }],
      plannedAmountCents: 13_000,
      totalRefundableCents: 13_000,
    });
    // Part held: the rest of that charge is still the booking's to refund.
    expect(planCardRefundFromLedger(ledger, 15_000, new Map([["sup", 4_500]]))).toEqual({
      slices: [
        { paymentTransactionId: "sup", amountCents: 2_000 },
        { paymentTransactionId: "prim", amountCents: 13_000 },
      ],
      plannedAmountCents: 15_000,
      totalRefundableCents: 15_000,
    });
    // More asked than the booking's charges hold: a short plan, never the held cents.
    expect(planCardRefundFromLedger(ledger, 19_500, new Map([["sup", 6_500]])).plannedAmountCents).toBe(13_000);
  });
});
