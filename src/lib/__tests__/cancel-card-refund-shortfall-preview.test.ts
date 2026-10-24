/**
 * #4119 (`INV-PAY-131`): the cancel preview's card line is sized as the cancel
 * sizes it - the cancel's card refund plan (`planCardRefundFromLedger`), then
 * its split, behind the cancel's own gate (`cancelRaisesCardShortfall`) - read
 * in one read-only `RepeatableRead` snapshot, and the preview never writes.
 *
 * The parity cases run the cancel's own planner (`planStripeRefundAllocation`)
 * and hand-back raise (`raiseCancelCardShortfallHandBack`) beside the preview
 * (`previewCancelCardRefundSplit`) on ONE in-memory payment, and require the
 * same card part, bank part and check part. The mirror fold the cancel's claim
 * writes through a compare-and-set is proven through the real cancel against
 * PostgreSQL (`cancel-card-refund-shortfall.realdb.test.ts`); here its walk is
 * pinned on its own.
 *
 * MUTATION PROOF. Size the preview from the payment's amount instead of the
 * plan (`plannedCardRefundCents: refundAmountCents`) and every short-plan case
 * fails; drop the in-memory fold and "a partly refunded mirror" fails; drop the
 * legacy rows and "a pre-ledger payment" fails; drop the branch gate and
 * "only where the cancel raises the parts" fails; load the ledger in another
 * order and "in the claim's order" fails; drop the snapshot's isolation level
 * and "one read-only snapshot" fails.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/email", () => ({ sendAdminManualRefundTaskAlert: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { cancelRaisesCardShortfall, raiseCancelCardShortfallHandBack } from "@/lib/cancel-card-refund-shortfall";
import { cancelPreviewCardShortfall, previewCancelCardRefundSplit } from "@/lib/cancel-card-refund-shortfall-preview";
import { foldMirrorRefundIntoLedger } from "@/lib/mirror-refund-fold";
import { compareLedgerRowsOldestFirst, LEDGER_ROWS_OLDEST_FIRST } from "@/lib/payment-ledger-order";
import { paidCancellationBranch } from "@/lib/paid-cancellation-event";
import { planStripeRefundAllocation } from "@/lib/payment-transactions";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

type Txn = {
  id: string;
  paymentId: string;
  source: "STRIPE" | "INTERNET_BANKING" | "CASH";
  stripePaymentIntentId: string | null;
  status: "SUCCEEDED" | "PARTIALLY_REFUNDED" | "REFUNDED" | "PENDING" | "FAILED";
  amountCents: number;
  refundedAmountCents: number;
  createdAt: Date;
  /** Assigned by `store` in the order the rows are given, as the database's sequence would (#4132). */
  insertionSeq?: number;
};

type PaymentRow = {
  id: string;
  status: string;
  amountCents: number;
  refundedAmountCents: number;
  stripePaymentIntentId: string | null;
  stripePaymentMethodId: string | null;
  additionalPaymentIntentId: string | null;
  additionalPaymentStatus: string | null;
  additionalAmountCents: number;
};

function card(cents: number, refunded = 0, day = 1): Txn {
  return { id: `txn-card-${day}`, paymentId: "payment-1", source: "STRIPE", stripePaymentIntentId: `pi_${day}`, status: "SUCCEEDED", amountCents: cents, refundedAmountCents: refunded, createdAt: new Date(Date.UTC(2026, 4, day)) };
}

function bank(cents: number, refunded = 0, day = 20): Txn {
  return { id: `txn-bank-${day}`, paymentId: "payment-1", source: "INTERNET_BANKING", stripePaymentIntentId: null, status: "SUCCEEDED", amountCents: cents, refundedAmountCents: refunded, createdAt: new Date(Date.UTC(2026, 4, day)) };
}

/**
 * One payment and its ledger, read the way the planner (`payment.findUnique`
 * with its transactions) and the non-card headroom (`paymentTransaction.findMany`
 * over captured rows) read them; a backfill `create` appends a row and counts.
 * The transactions come back oldest first, ties in insertion order
 * (`LEDGER_ROWS_OLDEST_FIRST`, #4132): each row is numbered in the order given.
 */
function store(transactions: Txn[], payment: Partial<PaymentRow> = {}) {
  const rows = transactions.map((row, index) => ({ ...row, insertionSeq: index + 1 }));
  const row: PaymentRow = {
    id: "payment-1",
    status: "SUCCEEDED",
    amountCents: rows.reduce((sum, txn) => sum + txn.amountCents, 0),
    refundedAmountCents: 0,
    stripePaymentIntentId: null,
    stripePaymentMethodId: null,
    additionalPaymentIntentId: null,
    additionalPaymentStatus: null,
    additionalAmountCents: 0,
    ...payment,
  };
  const tasks: Record<string, { id: string; status: string; amountCents: number }> = {};
  const ordered = () => [...rows].sort(compareLedgerRowsOldestFirst);
  const db = {
    rows,
    $executeRaw: vi.fn(async () => 0),
    $transaction: vi.fn<(run: (tx: unknown) => unknown, options?: unknown) => Promise<unknown>>(async (run): Promise<unknown> => run(db)),
    payment: {
      findUnique: vi.fn(async () => ({
        ...row,
        transactions: ordered().map((txn) => ({ ...txn })),
      })),
    },
    paymentTransaction: {
      findMany: vi.fn(async ({ where }: { where: { status: { in: string[] } } }) => rows.filter((txn) => where.status.in.includes(txn.status)).map((txn) => ({ ...txn }))),
      create: vi.fn(async ({ data }: { data: Omit<Txn, "id" | "createdAt"> }) => {
        const created = { ...data, id: `txn-backfilled-${rows.length}`, createdAt: new Date(Date.UTC(2026, 6, 1)), insertionSeq: rows.length + 1 } as Txn & { insertionSeq: number };
        rows.push(created);
        return created;
      }),
    },
    manualRefundTask: {
      createMany: vi.fn(async ({ data }: { data: Array<{ occurrenceKey: string; amountCents: number }> }) => {
        const task = data[0]!;
        if (tasks[task.occurrenceKey]) return { count: 0 };
        tasks[task.occurrenceKey] = { id: `task-${Object.keys(tasks).length + 1}`, status: "OPEN", amountCents: task.amountCents };
        return { count: 1 };
      }),
      findUnique: vi.fn(async ({ where }: { where: { occurrenceKey: string } }) => tasks[where.occurrenceKey] ?? null),
    },
  };
  return db;
}

/** What the cancel's claim does with the same inputs: plan, then raise what the plan cannot carry. */
async function cancelSide(db: ReturnType<typeof store>, refundAmountCents: number) {
  const { plannedAmountCents } = await planStripeRefundAllocation({ paymentId: "payment-1", amountCents: refundAmountCents, store: db as never });
  const raised = await raiseCancelCardShortfallHandBack(db as never, {
    bookingId: "booking-1",
    paymentId: "payment-1",
    refundAmountCents,
    plannedCardRefundCents: plannedAmountCents,
    format: CLUB_FORMAT_TEST,
  });
  return raised ? { cardCents: raised.cardCents, bankCents: raised.bank?.cents ?? 0, checkCents: raised.check?.cents ?? 0 } : null;
}

describe("the cancel preview sizes the card line as the cancel does (#4119)", () => {
  it.each([
    { shape: "a card charge that carries the whole refund", ledger: [card(20_000)], due: 15_000, expected: null },
    { shape: "a bank-paid part the card cannot refund", ledger: [card(14_000), bank(6_000)], due: 20_000, expected: { cardCents: 14_000, bankCents: 6_000, checkCents: 0 } },
    { shape: "a card already refunded in the ledger, not in the record", ledger: [card(14_000, 4_000), bank(6_000)], due: 20_000, expected: { cardCents: 10_000, bankCents: 6_000, checkCents: 4_000 } },
    { shape: "a zero plan", ledger: [{ ...card(14_000, 14_000), status: "REFUNDED" as const }, bank(6_000)], due: 6_000, expected: { cardCents: 0, bankCents: 6_000, checkCents: 0 } },
    { shape: "nothing holds the rest", ledger: [{ ...card(10_000, 10_000), status: "REFUNDED" as const }], due: 4_000, expected: { cardCents: 0, bankCents: 0, checkCents: 4_000 } },
    { shape: "two card charges, newest first", ledger: [card(5_000, 0, 1), card(5_000, 2_000, 2), bank(3_000)], due: 12_000, expected: { cardCents: 8_000, bankCents: 3_000, checkCents: 1_000 } },
    { shape: "an uncaptured card charge counts for nothing", ledger: [card(8_000), { ...card(4_000, 0, 9), status: "PENDING" as const }], due: 12_000, expected: { cardCents: 8_000, bankCents: 0, checkCents: 4_000 } },
  ])("agrees with the cancel's plan and raise: $shape", async ({ ledger, due, expected }) => {
    const previewDb = store(ledger);
    const preview = await previewCancelCardRefundSplit(previewDb as never, { paymentId: "payment-1", refundAmountCents: due });
    expect(preview).toEqual(expected);
    expect(previewDb.paymentTransaction.create).not.toHaveBeenCalled();
    expect(previewDb.manualRefundTask.createMany).not.toHaveBeenCalled();
    expect(await cancelSide(store(ledger), due)).toEqual(preview);
  });

  it("a pre-ledger payment: read as its backfill would write it, without writing, and as the cancel then plans it", async () => {
    // No ledger rows: a $150.00 card intent with $30.00 of it refunded, on the record only.
    const legacy = { stripePaymentIntentId: "pi_legacy", amountCents: 15_000, refundedAmountCents: 3_000, status: "PARTIALLY_REFUNDED" };
    const db = store([], legacy);
    const preview = await previewCancelCardRefundSplit(db as never, { paymentId: "payment-1", refundAmountCents: 15_000 });
    expect(preview).toEqual({ cardCents: 12_000, bankCents: 0, checkCents: 3_000 });
    expect(db.paymentTransaction.create).not.toHaveBeenCalled();
    // The cancel backfills the same row, then plans the same card part.
    expect(await cancelSide(db, 15_000)).toEqual(preview);
    expect(db.paymentTransaction.create).toHaveBeenCalledTimes(1);
  });

  it("a partly refunded mirror: its unattributed refund is folded onto the oldest captured rows first, as the cancel's claim folds it", async () => {
    // The record shows $50.00 refunded that no ledger row does (a folded credit
    // note). Folded oldest first: $40.00 onto the $40.00 card (the oldest, and
    // all it will take), then the last $10.00 onto the bank part.
    const db = store([card(4_000, 0, 1), bank(6_000, 0, 2), card(10_000, 0, 3)], { status: "PARTIALLY_REFUNDED", refundedAmountCents: 5_000 });
    expect(await previewCancelCardRefundSplit(db as never, { paymentId: "payment-1", refundAmountCents: 15_000 })).toEqual({
      cardCents: 10_000,
      bankCents: 5_000,
      checkCents: 0,
    });
    // Unfolded, the card would have been quoted $140.00 - $40.00 the cancel will not send it.
    expect(await previewCancelCardRefundSplit(store([card(4_000, 0, 1), bank(6_000, 0, 2), card(10_000, 0, 3)]) as never, { paymentId: "payment-1", refundAmountCents: 15_000 })).toEqual({
      cardCents: 14_000,
      bankCents: 1_000,
      checkCents: 0,
    });
  });
});

describe("the preview and the claim read the ledger in one order (#4119)", () => {
  it("loads the capture ledger in the claim's order, oldest first", async () => {
    const db = store([card(14_000), bank(6_000, 0, 2)]);
    await previewCancelCardRefundSplit(db as never, { paymentId: "payment-1", refundAmountCents: 14_000 });
    expect(db.payment.findUnique).toHaveBeenCalledWith(expect.objectContaining({ include: { transactions: { orderBy: [...LEDGER_ROWS_OLDEST_FIRST] } } }));
    expect(LEDGER_ROWS_OLDEST_FIRST).toEqual([{ createdAt: "asc" }, { insertionSeq: "asc" }]);
  });
});

describe("the mirror fold is one walk (#1491, #4119)", () => {
  const rows = () => [
    { id: "a", amountCents: 3_000, refundedAmountCents: 1_000 },
    { id: "b", amountCents: 5_000, refundedAmountCents: 0 },
  ];

  it("folds only a partly refunded mirror, and does not read the rows otherwise", async () => {
    const read = vi.fn(rows);
    const apply = vi.fn(() => 0);
    await foldMirrorRefundIntoLedger({ status: "SUCCEEDED", refundedAmountCents: 9_000 }, read, apply);
    expect(read).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it("walks oldest first, offering each row what is left, and carries what it did not take to the next", async () => {
    const offered: Array<[string, number]> = [];
    // The mirror shows $40.00 refunded; the ledger $10.00. The first row takes only $20.00.
    await foldMirrorRefundIntoLedger({ status: "PARTIALLY_REFUNDED", refundedAmountCents: 4_000 }, rows, (row, cents) => {
      offered.push([row.id, cents]);
      return Math.min(cents, row.amountCents - row.refundedAmountCents);
    });
    expect(offered).toEqual([["a", 3_000], ["b", 1_000]]);
  });

  it("stops once nothing is left to fold, and folds nothing when the ledger already shows it all", async () => {
    const apply = vi.fn((_row: unknown, cents: number) => cents);
    await foldMirrorRefundIntoLedger({ status: "PARTIALLY_REFUNDED", refundedAmountCents: 1_500 }, rows, apply);
    expect(apply).toHaveBeenCalledTimes(1);
    apply.mockClear();
    await foldMirrorRefundIntoLedger({ status: "PARTIALLY_REFUNDED", refundedAmountCents: 1_000 }, rows, apply);
    expect(apply).not.toHaveBeenCalled();
  });
});

describe("the preview asks only where the cancel raises the parts (#4119)", () => {
  const short = [card(14_000), bank(6_000)];
  const ask = (payment: { source: string; manuallyMarkedPaidAt: Date | null }, organiserCard = false, refundAmountCents = 20_000, organiserByBank = false) =>
    cancelPreviewCardShortfall(store(short) as never, { payment: { id: "payment-1", ...payment }, organiserCard, organiserByBank, refundAmountCents });

  it("a card refund on the card branch: the split, read in one read-only RepeatableRead snapshot", async () => {
    const db = store(short);
    expect(await cancelPreviewCardShortfall(db as never, { payment: { id: "payment-1", source: "STRIPE", manuallyMarkedPaidAt: null }, organiserCard: false, organiserByBank: false, refundAmountCents: 20_000 })).toEqual({
      cardShortfall: { cardCents: 14_000, bankCents: 6_000, checkCents: 0 },
    });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "RepeatableRead" });
    expect(String((db.$executeRaw.mock.calls[0] as unknown[])[0])).toContain("SET TRANSACTION READ ONLY");
    // Its first statement, before the payment is read.
    expect(db.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(db.payment.findUnique.mock.invocationCallOrder[0]!);
  });

  it("splits exactly where the cancel's own gate on the cancel's own branch raises the parts", async () => {
    for (const source of ["STRIPE", "INTERNET_BANKING"]) {
      for (const manuallyMarkedPaidAt of [null, new Date("2026-06-01T00:00:00.000Z")]) {
        for (const organiserCard of [false, true]) {
          for (const organiserByBank of [false, true]) {
            for (const cents of [0, 20_000]) {
              // As the cancel's claim resolves them: the forced method, then the branch. #3949: the organiser paid by
              // internet banking is refunded by hand on the card tier.
              const byBank = organiserByBank && !organiserCard;
              const refundMethod = source === "INTERNET_BANKING" && !organiserCard && !byBank ? "credit" : "card";
              const branch = paidCancellationBranch({ manualDisposition: !organiserCard && (manuallyMarkedPaidAt !== null || byBank), refundMethod, refundAmountCents: cents });
              const raises = cancelRaisesCardShortfall({ branch, organiserCard });
              const facts = JSON.stringify({ source, manuallyMarkedPaidAt, organiserCard, organiserByBank, cents });
              expect(Boolean((await ask({ source, manuallyMarkedPaidAt }, organiserCard, cents, organiserByBank)).cardShortfall), facts).toBe(raises);
            }
          }
        }
      }
    }
  });

  it("the gate: the card branch only, and never the organiser's card", () => {
    expect(cancelRaisesCardShortfall({ branch: "card", organiserCard: false })).toBe(true);
    expect(cancelRaisesCardShortfall({ branch: "card", organiserCard: true })).toBe(false);
    for (const branch of ["manual", "credit", "none"] as const) expect(cancelRaisesCardShortfall({ branch, organiserCard: false })).toBe(false);
  });

  it.each([
    { why: "an internet banking payment refunds as account credit", payment: { source: "INTERNET_BANKING", manuallyMarkedPaidAt: null }, organiserCard: false, cents: 20_000 },
    { why: "a joiner's booking the organiser paid refunds to the organiser's card", payment: { source: "STRIPE", manuallyMarkedPaidAt: null }, organiserCard: true, cents: 20_000 },
    { why: "a payment marked paid by hand is handed back by hand", payment: { source: "STRIPE", manuallyMarkedPaidAt: new Date("2026-06-01T00:00:00.000Z") }, organiserCard: false, cents: 20_000 },
    { why: "no refund is due", payment: { source: "STRIPE", manuallyMarkedPaidAt: null }, organiserCard: false, cents: 0 },
    // #3949 (owner decision, 22 Oct 2026): the cancel raises the organiser's hand-back, never a card refund.
    { why: "a joiner's booking the organiser paid by internet banking is refunded to them by hand", payment: { source: "INTERNET_BANKING", manuallyMarkedPaidAt: null }, organiserCard: false, cents: 20_000, organiserByBank: true },
  ])("nothing when $why", async ({ payment, organiserCard, cents, organiserByBank }) => {
    expect(await ask(payment, organiserCard, cents, organiserByBank)).toEqual({});
  });
});
