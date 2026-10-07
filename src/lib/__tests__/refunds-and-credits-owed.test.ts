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
import { readRefundsAndCreditsOwed } from "@/lib/refunds-and-credits-owed";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

// The scope fixture's open tasks sit on bookings with no payment behind them,
// so the read takes each at its own amount.
function fakeDb() {
  return {
    manualRefundTask: { findMany: vi.fn(async (): Promise<unknown[]> => refundsOwedTaskRows()) },
    paymentRecoveryOperation: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
    memberCredit: { groupBy: vi.fn(async (): Promise<unknown[]> => creditBalanceGroupRows()) },
  };
}

function reconciliationDb() {
  return {
    manualRefundTask: { findMany: vi.fn(async (): Promise<unknown[]> => owedReconciliationTaskRows()) },
    paymentRecoveryOperation: {
      findMany: vi.fn(async (): Promise<unknown[]> => owedReconciliationCardRefundRows()),
    },
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
    db.paymentRecoveryOperation.findMany.mockResolvedValue([{ payment: withId }]);
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
