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
import { mirrorPlanRefundUnmade } from "@/lib/group-settlement-refund-plan";
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
        { status: "OPEN", kind: "CANCELLED_BOOKING_HAND_BACK", amountCents: 10_000, partPaymentReviewPaymentId: null, occurrenceKey: null, reason: "Cancellation refund owed by hand" },
      ],
    });
    const db = reconciliationDb();
    // The payment reaches the read twice - through its open task and its open
    // card refund - and is counted once.
    const withId = { id: "pay-both", ...both };
    db.manualRefundTask.findMany.mockResolvedValue([
      { ...both.booking.manualRefundTasks[0], booking: { payment: withId } },
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

  it("#4042: a group organiser's OPEN hand-back counts once in Refunds owed at its own amount, and never comes off the organiser's Net Collected", async () => {
    // The organiser's own payment holds $200.00; the group task owes $300.00
    // of joiners' refunds, which the joiners' payments already read refunded.
    const [failed] = OWED_RECONCILIATION_PAYMENTS;
    const groupTask = { status: "OPEN", kind: "CANCELLED_BOOKING_HAND_BACK", amountCents: 30_000, partPaymentReviewPaymentId: null, occurrenceKey: "group-organiser-hand-back:settle-1", reason: "Group organiser hand-back" };
    const organiser = owedReconciliationPaymentRow({ ...failed, manualRefundTasks: [groupTask] });
    const withoutTask = owedReconciliationPaymentRow({ ...failed, manualRefundTasks: [] });

    // Net Collected: the organiser's payment reads exactly as with no task.
    expect(getNetCollectedPaymentParts(organiser)).toEqual(getNetCollectedPaymentParts(withoutTask));

    // Refunds owed: the payment's own owed parts, plus the task at its full amount, once.
    const withId = { id: "pay-organiser", ...organiser };
    const ownOnly = reconciliationDb();
    ownOnly.manualRefundTask.findMany.mockResolvedValue([]);
    ownOnly.paymentRecoveryOperation.findMany = operationReads(() => [{ payment: withId }]);
    ownOnly.memberCredit.groupBy.mockResolvedValue([]);
    const before = (await readRefundsAndCreditsOwed(ownOnly as never)).refundsOwedCents;

    const db = reconciliationDb();
    db.manualRefundTask.findMany.mockResolvedValue([{ ...groupTask, booking: { payment: withId } }]);
    db.paymentRecoveryOperation.findMany = operationReads(() => [{ payment: withId }]);
    db.memberCredit.groupBy.mockResolvedValue([]);
    expect((await readRefundsAndCreditsOwed(db as never)).refundsOwedCents).toBe(before + 30_000);

    // Its payment reached only through the task: the task alone, uncapped.
    const taskOnly = reconciliationDb();
    taskOnly.manualRefundTask.findMany.mockResolvedValue([{ ...groupTask, booking: { payment: withId } }]);
    taskOnly.paymentRecoveryOperation.findMany = operationReads(() => []);
    taskOnly.memberCredit.groupBy.mockResolvedValue([]);
    expect((await readRefundsAndCreditsOwed(taskOnly as never)).refundsOwedCents).toBe(30_000);
  });

  it("#4097 (`INV-PAY-129`): a cancellation's card refund shortfall counts in Refunds owed and off Net Collected, once", async () => {
    // $100.00 captured by card, $60.00 refunded to it, $40.00 the plan could not carry.
    const shortfallTask = { status: "OPEN", kind: "CANCELLED_BOOKING_HAND_BACK", amountCents: 4_000, partPaymentReviewPaymentId: null, occurrenceKey: "cancel-card-shortfall:b-short", reason: "Card refund shortfall" };
    const row = owedReconciliationPaymentRow({
      bookingId: "b-short",
      memberId: "m-short",
      bookingStatus: "CANCELLED",
      status: "PARTIALLY_REFUNDED",
      amountCents: 10_000,
      refundedAmountCents: 6_000,
      source: "STRIPE",
      capturedLedgerRows: 1,
      deletedAt: null,
      creditsApplied: [],
      creditsFromCancellation: [],
      manualRefundTasks: [shortfallTask],
      recoveryOperations: [],
      refunds: [],
    });

    const parts = getNetCollectedPaymentParts(row);
    expect(parts.handBackOwedCents).toBe(4_000);
    expect(parts.heldCashCents).toBe(0);

    const db = reconciliationDb();
    db.manualRefundTask.findMany.mockResolvedValue([{ ...shortfallTask, booking: { payment: { id: "pay-short", ...row } } }]);
    db.paymentRecoveryOperation.findMany = operationReads(() => []);
    db.memberCredit.groupBy.mockResolvedValue([]);
    expect((await readRefundsAndCreditsOwed(db as never)).refundsOwedCents).toBe(4_000);

    // Paid back or dismissed, it is owed nowhere.
    const closed = owedReconciliationPaymentRow({
      bookingId: "b-short", memberId: "m-short", bookingStatus: "CANCELLED", status: "PARTIALLY_REFUNDED",
      amountCents: 10_000, refundedAmountCents: 6_000, source: "STRIPE", capturedLedgerRows: 1, deletedAt: null,
      creditsApplied: [], creditsFromCancellation: [], manualRefundTasks: [{ ...shortfallTask, status: "DISMISSED" }],
      recoveryOperations: [], refunds: [],
    });
    expect(getNetCollectedPaymentParts(closed).handBackOwedCents).toBe(0);
  });

  it("never takes one payment's money off twice across a hand-back and a card refund", () => {
    const [failed] = rows;
    const both = {
      ...failed,
      booking: {
        ...failed.booking,
        manualRefundTasks: [
          { status: "OPEN", kind: "CANCELLED_BOOKING_HAND_BACK", amountCents: 10_000, partPaymentReviewPaymentId: null, occurrenceKey: null, reason: "Cancellation refund owed by hand" },
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
  #4083 (`INV-PAY-128`): a booking edit's card refund Stripe refused (failed or
  canceled) is queued as a recovery row whose plan is exactly the refused
  slices. It counts in "Refunds owed" at what was refused - the slice Stripe
  made is not owed, and a refusal is never taken as progress - until a retry
  under a fresh key makes it.
*/
describe("a refused edit refund counts in Refunds owed (#4083)", () => {
  const [base] = OWED_RECONCILIATION_PAYMENTS;
  const edited = new Date("2026-06-20T00:00:00.000Z");
  const queuedAt = new Date("2026-06-20T00:00:01.000Z");
  const refusedSlice = { paymentTransactionId: "txn-primary", amountCents: 4_000 };
  // A $100.00 edit refund: $60.00 made from the newer charge, $40.00 refused on the older one.
  const row = (overrides: { status?: string; stripeKeySuffix?: string; retried?: { status: string } } = {}) => ({
    ...base,
    bookingId: "b-edit-refund-refused",
    bookingStatus: "CONFIRMED",
    status: "PARTIALLY_REFUNDED",
    amountCents: 20_000,
    refundedAmountCents: 6_000,
    capturedLedgerRows: 2,
    recoveryOperations: [
      {
        id: "op-edit-refund-refused",
        type: "REFUND_BOOKING_MODIFICATION",
        status: overrides.status ?? "PENDING",
        idempotencyKey: "booking_modification_refund_mod-refused",
        amountCents: 4_000,
        allocationPlan: [{ ...refusedSlice, ...(overrides.stripeKeySuffix ? { stripeKeySuffix: overrides.stripeKeySuffix } : {}) }],
        paymentTransactionId: null,
        createdAt: queuedAt,
        succeededAt: null,
      },
    ],
    refunds: [
      { paymentTransactionId: "txn-additional", amountCents: 6_000, status: "succeeded", createdAt: edited },
      { paymentTransactionId: "txn-primary", amountCents: 4_000, status: "failed", createdAt: edited },
      ...(overrides.retried
        ? [{ paymentTransactionId: "txn-primary", amountCents: 4_000, status: overrides.retried.status, createdAt: new Date("2026-06-20T00:05:00.000Z") }]
        : []),
    ],
  });
  const owedFor = async (reconciliation: ReturnType<typeof row>) => {
    const payment = { id: "pay-edit-refund-refused", ...owedReconciliationPaymentRow(reconciliation as never) };
    const db = reconciliationDb();
    db.manualRefundTask.findMany.mockResolvedValue([]);
    db.paymentRecoveryOperation.findMany = operationReads(() =>
      reconciliation.recoveryOperations.filter((operation) => operation.status !== "SUCCEEDED").map(() => ({ payment })),
    );
    db.memberCredit.groupBy.mockResolvedValue([]);
    return (await readRefundsAndCreditsOwed(db as never)).refundsOwedCents;
  };

  it("counts exactly the refused $40.00, not the $60.00 Stripe made", async () => {
    expect(await owedFor(row())).toBe(4_000);
  });

  it("still counts it when the runner's retry under a fresh key was refused again", async () => {
    expect(await owedFor(row({ stripeKeySuffix: "refused1", retried: { status: "canceled" } }))).toBe(4_000);
  });

  it("counts nothing once the retry made it and the row closed", async () => {
    expect(await owedFor(row({ status: "SUCCEEDED", stripeKeySuffix: "refused1", retried: { status: "succeeded" } }))).toBe(0);
  });

  it("a dead row (retries spent) still counts until the treasurer closes it", async () => {
    expect(await owedFor(row({ status: "FAILED", stripeKeySuffix: "refused4" }))).toBe(4_000);
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

  it("is the rule the refund appeal waits on: a settlement owes here exactly when its combined refund is unmade (#3956, INV-SSOT)", () => {
    for (const settlement of settlements) {
      expect(mirrorPlanRefundUnmade(settlement), settlement.id).toBe(legacyGroupSettlementRefundOwedCents([settlement]) > 0);
    }
    expect(settlements.filter((settlement) => mirrorPlanRefundUnmade(settlement)).map((settlement) => settlement.id)).toEqual([
      "s-open",
      "s-dead",
    ]);
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
    db.manualRefundTask.findMany.mockResolvedValue([{ ...first!, booking: { payment: uncaptured } }]);

    const owed = await readRefundsAndCreditsOwed(db as never);

    expect(owed.refundsOwedCents).toBe(first!.amountCents);
  });
});
