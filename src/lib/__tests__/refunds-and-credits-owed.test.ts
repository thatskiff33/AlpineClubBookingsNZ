// #3372 (owner, 7 Oct 2026): "Those numbers need to reconcile as the total of
// all refunds owed but not yet paid and all credits issued and not yet
// applied/used." Each figure is checked against an independent sum of the
// shared fixture, not against the code's own arithmetic.
import { describe, expect, it, vi } from "vitest";

import {
  OWED_RECONCILIATION_CREDIT_ENTRIES,
  OWED_RECONCILIATION_EXPECTED,
  OWED_RECONCILIATION_PAYMENTS,
  REFUNDS_AND_CREDITS_OWED_FIXTURE,
  creditBalanceGroupRows,
  owedReconciliationCardRefundRows,
  owedReconciliationCreditGroupRows,
  owedReconciliationPaymentRow,
  owedReconciliationTaskRows,
  refundsOwedTaskRows,
} from "@/lib/__tests__/helpers/net-collected-scope-fixture";
import { getNetCollectedPaymentParts, summarizeCollectedCash } from "@/lib/payment-net-collected";
import {
  legacyGroupSettlementRefundOwedCents,
  readRefundsAndCreditsOwed,
} from "@/lib/refunds-and-credits-owed";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

/** Whether a `paymentRecoveryOperation.findMany` is the club-wide group settlement read. */
function isGroupSettlementQuery(args: unknown): boolean {
  const where = (args as { where?: { idempotencyKey?: unknown } } | undefined)?.where;
  return Boolean(where?.idempotencyKey);
}

/**
 * The two card refund reads, told apart by their `where`: the per-payment card
 * refunds, and the club-wide group settlement refunds (owner, 8 Oct 2026).
 */
function operationReads(cardRefunds: () => unknown[], groupRefunds: () => unknown[] = () => []) {
  return vi.fn(async (args?: unknown): Promise<unknown[]> => (isGroupSettlementQuery(args) ? groupRefunds() : cardRefunds()));
}

// The scope fixture's open tasks sit on bookings with no payment behind them,
// so the read takes each at its own amount.
function fakeDb() {
  return {
    manualRefundTask: { findMany: vi.fn(async (): Promise<unknown[]> => refundsOwedTaskRows()) },
    paymentRecoveryOperation: { findMany: operationReads(() => []) },
    groupBookingSettlement: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
    memberCredit: { groupBy: vi.fn(async (): Promise<unknown[]> => creditBalanceGroupRows()) },
  };
}

function reconciliationDb() {
  return {
    manualRefundTask: { findMany: vi.fn(async (): Promise<unknown[]> => owedReconciliationTaskRows()) },
    paymentRecoveryOperation: { findMany: operationReads(owedReconciliationCardRefundRows) },
    groupBookingSettlement: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
    memberCredit: { groupBy: vi.fn(async (): Promise<unknown[]> => owedReconciliationCreditGroupRows()) },
  };
}

describe("Refunds owed and Credits owed reconcile to their totals", () => {
  it("Refunds owed is the sum of every open refund obligation", async () => {
    const db = fakeDb();
    const owed = await readRefundsAndCreditsOwed(db as never);

    const openObligations = REFUNDS_AND_CREDITS_OWED_FIXTURE.openTasks
      .filter((task) => task.refundOwed)
      .reduce((sum, task) => sum + (task.amountCents ?? 0), 0);
    expect(owed.refundsOwedCents).toBe(openObligations);
    expect(owed.refundsOwedCents).toBe(REFUNDS_AND_CREDITS_OWED_FIXTURE.expectedRefundsOwedCents);
    // Read as at today, with no date, lodge or booking filter: every OPEN task...
    expect(db.manualRefundTask.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: "OPEN" } }),
    );
    // ...and every unclosed card refund, whatever booking it is on.
    expect(db.paymentRecoveryOperation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: { not: "SUCCEEDED" },
          type: { in: ["REFUND_BOOKING_MODIFICATION", "REFUND_SUPERSEDED_PAYMENT"] },
        },
      }),
    );
  });

  it("Credits owed is the sum of members' unused credit balances", async () => {
    const owed = await readRefundsAndCreditsOwed(fakeDb() as never);

    const balances = new Map<string, number>();
    for (const entry of REFUNDS_AND_CREDITS_OWED_FIXTURE.creditEntries) {
      balances.set(entry.memberId, (balances.get(entry.memberId) ?? 0) + entry.amountCents);
    }
    const unused = [...balances.values()].filter((cents) => cents > 0).reduce((a, b) => a + b, 0);
    expect(owed.creditsOwedCents).toBe(unused);
    expect(owed.creditsOwedCents).toBe(REFUNDS_AND_CREDITS_OWED_FIXTURE.expectedCreditsOwedCents);
  });

  it("drops a refund from Refunds owed once it is paid back, dismissed or kept", async () => {
    const db = fakeDb();
    db.manualRefundTask.findMany.mockResolvedValue(
      refundsOwedTaskRows().map((task) => ({ ...task, status: "COMPLETED" })),
    );
    expect((await readRefundsAndCreditsOwed(db as never)).refundsOwedCents).toBe(0);
  });
});

/*
  #3372 (owner, 7 Oct 2026, decisions (c) and (d)), and the #3924 money
  review: a card refund Stripe has not yet paid, a late card charge awaiting
  the treasurer, and late bank cash credited back each come off Net Collected
  for their own booking and appear once in Refunds owed or Credits owed.
*/
describe("Net Collected, Refunds owed and Credits owed reconcile to the cent", () => {
  const rows = OWED_RECONCILIATION_PAYMENTS.map(owedReconciliationPaymentRow);

  it("Net Collected takes every amount owed back off its own booking", () => {
    const summary = summarizeCollectedCash(rows);

    expect(summary.netCollectedCents).toBe(OWED_RECONCILIATION_EXPECTED.netCollectedCents);
    expect(summary.cardRefundOwedCents).toBe(OWED_RECONCILIATION_EXPECTED.cardRefundOwedCents);
    expect(summary.lateCaptureOwedCents).toBe(OWED_RECONCILIATION_EXPECTED.lateCaptureOwedCents);
    expect(summary.lateCashCreditedCents).toBe(OWED_RECONCILIATION_EXPECTED.lateCashCreditedCents);
    expect(summary.handBackOwedCents).toBe(0);
  });

  it("nets a partly sent card refund against its recorded slices only", () => {
    const partlySent = rows[1];
    const parts = getNetCollectedPaymentParts(partlySent);

    // $300.00 paid, $120.00 on the refunded total ($20.00 before the cancel,
    // the operation's $100.00 slice): $180.00 left, of which the operation
    // still owes $150.00, so the club keeps $30.00.
    expect(parts.cardRefundOwedCents).toBe(15_000);
    expect(parts.heldCashCents).toBe(3_000);
  });

  it("Refunds owed is every refund owed, by hand, by card or a late charge awaiting the treasurer", async () => {
    const owed = await readRefundsAndCreditsOwed(reconciliationDb() as never);

    expect(owed.refundsOwedCents).toBe(OWED_RECONCILIATION_EXPECTED.refundsOwedCents);
    // Independently: what each in-scope booking had taken off, plus the
    // deleted booking's late capture, which Net Collected never counted.
    const summary = summarizeCollectedCash(rows);
    const deletedBookingOwed = OWED_RECONCILIATION_PAYMENTS.filter((row) => row.deletedAt !== null)
      .flatMap((row) => row.manualRefundTasks)
      .reduce((sum, task) => sum + (task.amountCents ?? 0), 0);
    expect(owed.refundsOwedCents).toBe(
      summary.handBackOwedCents +
        summary.cardRefundOwedCents +
        summary.lateCaptureOwedCents +
        deletedBookingOwed,
    );
  });

  it("Credits owed holds the late bank cash Net Collected took off", async () => {
    const owed = await readRefundsAndCreditsOwed(reconciliationDb() as never);

    expect(owed.creditsOwedCents).toBe(OWED_RECONCILIATION_EXPECTED.creditsOwedCents);
    const ledger = OWED_RECONCILIATION_CREDIT_ENTRIES.reduce((sum, entry) => sum + entry.amountCents, 0);
    expect(owed.creditsOwedCents).toBe(ledger);
    expect(owed.creditsOwedCents).toBeGreaterThanOrEqual(
      summarizeCollectedCash(rows).lateCashCreditedCents,
    );
  });

  it("counts a late charge as collected once the treasurer keeps it", async () => {
    const kept = OWED_RECONCILIATION_PAYMENTS.map((row) =>
      row.bookingId === "b-late-capture-held"
        ? { ...row, manualRefundTasks: row.manualRefundTasks.map((task) => ({ ...task, status: "DISMISSED" })) }
        : row,
    );
    expect(summarizeCollectedCash(kept.map(owedReconciliationPaymentRow)).netCollectedCents).toBe(
      OWED_RECONCILIATION_EXPECTED.netCollectedCents + 4_000,
    );
  });

  it("reads, payment by payment, exactly what Net Collected took off (#3924 money review, F5)", async () => {
    // $200.00 held, a $100.00 hand-back AND the $150.00 card refund: Net
    // Collected can take only $200.00 off, so "Refunds owed" must say $200.00
    // too - not the $250.00 an uncapped task sum plus a separately capped card
    // part would read.
    const [failed] = OWED_RECONCILIATION_PAYMENTS;
    const both = owedReconciliationPaymentRow({
      ...failed,
      manualRefundTasks: [
        { status: "OPEN", kind: "CANCELLED_BOOKING_HAND_BACK", amountCents: 10_000, partPaymentReviewPaymentId: null },
      ],
    });
    const db = reconciliationDb();
    // The payment reaches the read twice - through its open task and its open
    // card refund - and is counted once.
    const withId = { id: "pay-both", ...both };
    db.manualRefundTask.findMany.mockResolvedValue([
      { ...both.booking.manualRefundTasks[0], booking: { deletedAt: null, payment: withId } },
    ]);
    db.paymentRecoveryOperation.findMany = operationReads(() => [{ payment: withId }]);
    db.memberCredit.groupBy.mockResolvedValue([]);

    const owed = await readRefundsAndCreditsOwed(db as never);
    const parts = getNetCollectedPaymentParts(both);

    expect(owed.refundsOwedCents).toBe(20_000);
    expect(owed.refundsOwedCents).toBe(
      parts.handBackOwedCents + parts.cardRefundOwedCents + parts.lateCaptureOwedCents,
    );
    expect(parts.capturedGrossCents - parts.heldCashCents - owed.refundsOwedCents).toBe(0);
  });

  it("never takes one payment's money off twice across a hand-back and a card refund", () => {
    const [failed] = rows;
    const both = {
      ...failed,
      booking: {
        ...failed.booking,
        manualRefundTasks: [
          { status: "OPEN", kind: "CANCELLED_BOOKING_HAND_BACK", amountCents: 10_000, partPaymentReviewPaymentId: null },
        ],
      },
    };
    const parts = getNetCollectedPaymentParts(both);

    // $200.00 held: the $100.00 hand-back first, then only the $100.00 left of
    // the $150.00 card refund. Never below nil.
    expect(parts.handBackOwedCents).toBe(10_000);
    expect(parts.cardRefundOwedCents).toBe(10_000);
    expect(parts.heldCashCents).toBe(0);
  });
});

/*
  #3372 (owner, 8 Oct 2026: "Separate club-wide line"): a group settlement's
  card refund from before #3653 can be tied to no child's booking, so its
  unsent remainder counts in Refunds owed as one club-wide amount - never
  against a booking and never in Net Collected.
*/
describe("pre-#3653 group settlement card refunds: one club-wide line in Refunds owed", () => {
  const plan = (cents: Record<string, number>) => cents;
  const settlements = [
    // Open, still to send: the whole plan.
    { id: "s-open", status: "SUCCEEDED", stripePaymentIntentId: "pi_s_open", refundPlan: plan({ c1: 3_000, c2: 2_000 }) },
    // Dead (retries spent), still to send.
    { id: "s-dead", status: "SUCCEEDED", stripePaymentIntentId: "pi_s_dead", refundPlan: plan({ c3: 1_500 }) },
    // The refund went; only the children's mirrors were left.
    { id: "s-sent", status: "REFUNDED", stripePaymentIntentId: "pi_s_sent", refundPlan: plan({ c4: 9_000 }) },
    // Nothing was ever captured.
    { id: "s-failed", status: "FAILED", stripePaymentIntentId: "pi_s_failed", refundPlan: plan({ c5: 7_000 }) },
    // A #3653 per-child plan reads as empty: each child has its own operation.
    { id: "s-per-child", status: "SUCCEEDED", stripePaymentIntentId: "pi_s_pc", refundPlan: { perChildRefunds: { c6: 4_000 } } },
  ];
  const groupOps = settlements.map((settlement) => ({ idempotencyKey: `group_settlement_refund_recovery_${settlement.id}` }));

  it("counts what the unclosed ones still have to send: $65.00 here", () => {
    expect(legacyGroupSettlementRefundOwedCents(settlements)).toBe(6_500);
  });

  it("adds that one amount to Refunds owed, beside every booking's own, and reads only the unclosed rows", async () => {
    const db = reconciliationDb();
    const without = (await readRefundsAndCreditsOwed(db as never)).refundsOwedCents;
    db.paymentRecoveryOperation.findMany = operationReads(owedReconciliationCardRefundRows, () => groupOps);
    db.groupBookingSettlement.findMany = vi.fn(async (): Promise<unknown[]> => settlements);

    const owed = await readRefundsAndCreditsOwed(db as never);

    expect(owed.refundsOwedCents).toBe(without + 6_500);
    expect(db.paymentRecoveryOperation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { idempotencyKey: { startsWith: "group_settlement_refund_recovery_" }, status: { not: "SUCCEEDED" } },
      }),
    );
    expect(db.groupBookingSettlement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: settlements.map((settlement) => settlement.id) } } }),
    );
  });

  it("it never reaches Net Collected: no booking's figure moves", () => {
    const rows = OWED_RECONCILIATION_PAYMENTS.map(owedReconciliationPaymentRow);
    expect(summarizeCollectedCash(rows).netCollectedCents).toBe(OWED_RECONCILIATION_EXPECTED.netCollectedCents);
  });
});

describe("#3924 round 4 (M7): a hand-back promised on a payment that shows no capture is still owed", () => {
  it("counts at its own amount, not at the nothing Net Collected counts for that payment", async () => {
    const db = fakeDb();
    const [first] = refundsOwedTaskRows().filter((task) => task.kind === "CANCELLED_BOOKING_HAND_BACK" && (task.amountCents ?? 0) > 0);
    expect(first).toBeDefined();
    const [template] = OWED_RECONCILIATION_PAYMENTS;
    // A pre-ledger bank-transfer payment the Xero inbound marked part-refunded:
    // no captured ledger row, so `netCollectedPaymentTookMoney` reads no capture.
    const uncaptured = {
      id: "pay-uncaptured",
      ...owedReconciliationPaymentRow(template!),
      status: "PARTIALLY_REFUNDED",
      source: "INTERNET_BANKING",
      _count: { transactions: 0 },
      recoveryOperations: [],
      refunds: [],
    };
    db.manualRefundTask.findMany.mockResolvedValue([{ ...first!, booking: { deletedAt: null, payment: uncaptured } }]);

    const owed = await readRefundsAndCreditsOwed(db as never);

    expect(owed.refundsOwedCents).toBe(first!.amountCents);
  });
});
