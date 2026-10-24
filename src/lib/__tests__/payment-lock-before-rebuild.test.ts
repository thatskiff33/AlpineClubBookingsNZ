import { PaymentStatus, PaymentTransactionKind } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

// Every store here is passed in; the module client is never reached, so the
// suite runs without a DATABASE_URL.
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { IntentLedgerRowOnAnotherPaymentError } from "@/lib/payment-intent-ledger-row-write";

import {
  applyLocalRefundAllocation,
  markPaymentIntentTransactionFailed,
  markPaymentIntentTransactionSucceeded,
  reconcilePaymentAggregates,
  recordInternetBankingPaymentTransaction,
  upsertPaymentIntentTransaction,
  writeRaisedAdditionalRequestAmount,
  type PaymentStore,
} from "@/lib/payment-transactions";

/**
 * #4217 (`INV-LOCK-002`): every writer of a payment's ledger rows takes the
 * Payment row (`lockPaymentForRefundedTotal`) BEFORE its first row write, and
 * the aggregate rebuild takes it before it reads. Each runs inside the caller's
 * transaction or a short one of its own (`withStoreTransaction`), so the lock is
 * held until the rebuild has written.
 *
 * The store here records every call, in order, on whichever client made it, so
 * the order is read off the log rather than inferred. The proof that the order
 * prevents a stale total and a deadlock against real PostgreSQL is
 * `payment-lock-before-rebuild.realdb.test.ts`.
 */

const PAYMENT_ID = "payment_4217";
const INTENT_ID = "pi_4217";
const ROW_ID = "txn_4217";

type Call = { client: "root" | "tx"; op: string; sql?: string; values?: unknown[] };

const WRITE_OPS = new Set(["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"]);

function isPaymentRowLock(call: Call): boolean {
  return (
    call.op === "$executeRaw" &&
    (call.sql ?? "").includes('FROM "Payment" WHERE "id" = ? FOR NO KEY UPDATE') &&
    call.values?.[0] === PAYMENT_ID
  );
}

function isRowWrite(call: Call): boolean {
  const [, method] = call.op.split(".");
  return method !== undefined && WRITE_OPS.has(method);
}

/**
 * A client whose every model method and `$executeRaw` is recorded. Reads answer
 * from `answers` (by `model.method`), writes answer `{ count: 1 }` - enough for
 * each writer to reach its write; the rebuild then finds no payment and stops.
 */
function recordingClient(
  log: Call[],
  client: Call["client"],
  answers: Record<string, (args: unknown) => unknown>,
) {
  const model = (name: string) =>
    new Proxy({} as Record<string, ReturnType<typeof vi.fn>>, {
      get: (methods, method: string) =>
        (methods[method] ??= vi.fn(async (args: unknown) => {
          const op = `${name}.${method}`;
          log.push({ client, op });
          if (answers[op]) return answers[op](args);
          return WRITE_OPS.has(method) ? { count: 1 } : null;
        })),
    });
  return {
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      log.push({ client, op: "$executeRaw", sql: strings.join("?"), values });
      return 1;
    }),
    payment: model("payment"),
    paymentTransaction: model("paymentTransaction"),
    paymentRefund: model("paymentRefund"),
    bookingLedgerLine: model("bookingLedgerLine"),
  };
}

const intentRow = {
  id: ROW_ID,
  paymentId: PAYMENT_ID,
  kind: PaymentTransactionKind.ADDITIONAL,
  status: PaymentStatus.PENDING,
  stripePaymentIntentId: INTENT_ID,
};

/** The intent's row is found by the pure read and again under the lock. */
const ANSWERS: Record<string, (args: unknown) => unknown> = {
  "paymentTransaction.findUnique": () => ({ ...intentRow }),
};

const WRITERS: Array<[string, (store: PaymentStore) => Promise<unknown>]> = [
  [
    "upsertPaymentIntentTransaction",
    (store) =>
      upsertPaymentIntentTransaction({
        paymentId: PAYMENT_ID,
        kind: PaymentTransactionKind.ADDITIONAL,
        paymentIntentId: INTENT_ID,
        amountCents: 5_000,
        status: PaymentStatus.PENDING,
        stripeCustomerId: "cus_4217",
        store,
      }),
  ],
  [
    "writeRaisedAdditionalRequestAmount",
    (store) =>
      writeRaisedAdditionalRequestAmount({
        paymentId: PAYMENT_ID,
        paymentIntentId: INTENT_ID,
        amountCents: 6_000,
        carriedAskCents: 0,
        store,
      }),
  ],
  [
    "recordInternetBankingPaymentTransaction",
    (store) => recordInternetBankingPaymentTransaction({ paymentId: PAYMENT_ID, amountCents: 5_000, store }),
  ],
  [
    "markPaymentIntentTransactionSucceeded",
    (store) => markPaymentIntentTransactionSucceeded({ paymentIntentId: INTENT_ID, amountCents: 5_000, store }),
  ],
  [
    "markPaymentIntentTransactionFailed",
    (store) => markPaymentIntentTransactionFailed({ paymentIntentId: INTENT_ID, store }),
  ],
  ["reconcilePaymentAggregates", (store) => reconcilePaymentAggregates({ paymentId: PAYMENT_ID, store })],
];

/** The two writers that must first learn which payment, by a read. */
const LOCATES_FIRST = new Set(["markPaymentIntentTransactionSucceeded", "markPaymentIntentTransactionFailed"]);

describe("#4217: the Payment row is locked before any ledger row is written or the rebuild reads", () => {
  it.each(WRITERS)("MUTATION: %s takes the Payment row lock as its first statement (after only a pure read)", async (name, run) => {
    const log: Call[] = [];
    const store = recordingClient(log, "tx", ANSWERS) as unknown as PaymentStore;

    await run(store);

    const lockAt = log.findIndex(isPaymentRowLock);
    expect(lockAt, `${name} never locked the Payment row`).toBeGreaterThanOrEqual(0);
    const before = log.slice(0, lockAt);
    if (LOCATES_FIRST.has(name)) {
      // Only the read that names the payment, and nothing written.
      expect(before.map((call) => call.op)).toEqual(["paymentTransaction.findUnique"]);
    } else {
      expect(before, `${name} ran ${JSON.stringify(before)} before the lock`).toEqual([]);
    }
    expect(log.some(isRowWrite) || name === "reconcilePaymentAggregates", `${name} wrote nothing`).toBe(true);
    const firstWrite = log.findIndex(isRowWrite);
    if (firstWrite >= 0) expect(lockAt).toBeLessThan(firstWrite);
  });

  it.each(WRITERS)("MUTATION: %s, given the root client, locks inside the short transaction it opens", async (_name, run) => {
    const log: Call[] = [];
    const tx = recordingClient(log, "tx", ANSWERS);
    const root = {
      ...recordingClient(log, "root", ANSWERS),
      $connect: vi.fn(),
      $transaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn(tx)),
    };

    await run(root as unknown as PaymentStore);

    expect(root.$transaction).toHaveBeenCalledTimes(1);
    // Nothing is locked or written on the root client: the lock would end with
    // its own autocommit statement, before the write it is meant to cover.
    expect(log.filter((call) => call.client === "root" && (call.op === "$executeRaw" || isRowWrite(call)))).toEqual([]);
    const lockAt = log.findIndex(isPaymentRowLock);
    expect(log[lockAt]?.client).toBe("tx");
  });

  it("MUTATION (#4287, INV-ADDPAY-043): a hand-back's allocation takes the Payment row before it reads, so the completion's later note decision reads under it", async () => {
    // The hand-back completion decides whether its Xero note stands on its own
    // task only after this allocation, on the same transaction
    // (`manual-refund-task.test.ts` pins that order); the lock taken here is
    // what makes a second completion on the payment read after the first commits.
    const log: Call[] = [];
    const store = recordingClient(log, "tx", {}) as unknown as PaymentStore;

    await expect(applyLocalRefundAllocation({ paymentId: PAYMENT_ID, amountCents: 3_000, store })).rejects.toThrow("Payment not found");

    expect(log.findIndex(isPaymentRowLock)).toBe(0);
  });

  it("mark-failed leaves a row captured after its re-read alone: the FAILED write is status-guarded", async () => {
    const log: Call[] = [];
    const store = recordingClient(log, "tx", {
      ...ANSWERS,
      "paymentTransaction.updateMany": () => ({ count: 0 }),
    }) as unknown as PaymentStore & {
      paymentTransaction: { updateMany: ReturnType<typeof vi.fn> };
    };

    await markPaymentIntentTransactionFailed({ paymentIntentId: INTENT_ID, store });

    expect(store.paymentTransaction.updateMany).toHaveBeenCalledWith({
      where: { id: ROW_ID, status: { notIn: expect.arrayContaining([PaymentStatus.SUCCEEDED, PaymentStatus.REFUNDED]) } },
      data: { status: PaymentStatus.FAILED },
    });
    // A lost guard runs no rebuild.
    expect(log.filter((call) => call.op === "payment.findUnique")).toEqual([]);
  });

  it("MUTATION: an intent's row on another payment than the one the pure read named is refused under the lock, never written", async () => {
    // The Payment pointer names the intent; its row sits on another payment.
    let rowReads = 0;
    const log: Call[] = [];
    const store = recordingClient(log, "tx", {
      "paymentTransaction.findUnique": () => (rowReads++ === 0 ? null : { ...intentRow, paymentId: "payment_other" }),
      "payment.findUnique": () => ({ id: PAYMENT_ID }),
    }) as unknown as PaymentStore;

    const refusal = markPaymentIntentTransactionSucceeded({ paymentIntentId: INTENT_ID, amountCents: 5_000, store });
    await expect(refusal).rejects.toBeInstanceOf(IntentLedgerRowOnAnotherPaymentError);
    await expect(refusal).rejects.toThrow(/belongs to payment payment_other, not the locked payment payment_4217/);
    expect(log.filter(isRowWrite)).toEqual([]);
  });

  // #4217 review (F3): the upsert's row write is pinned to the payment it
  // locked, so one payment's lock can never cover a move of another's row.
  it("MUTATION: the upsert writes only the locked payment's row for the intent", async () => {
    const log: Call[] = [];
    const store = recordingClient(log, "tx", ANSWERS) as unknown as PaymentStore & {
      paymentTransaction: { updateMany: ReturnType<typeof vi.fn> };
    };

    await upsertPaymentIntentTransaction({
      paymentId: PAYMENT_ID,
      kind: PaymentTransactionKind.ADDITIONAL,
      paymentIntentId: INTENT_ID,
      amountCents: 5_000,
      status: PaymentStatus.PENDING,
      store,
    });

    for (const [args] of store.paymentTransaction.updateMany.mock.calls) {
      const { where, data } = args as { where: Record<string, unknown>; data: Record<string, unknown> };
      expect(where).toMatchObject({ stripePaymentIntentId: INTENT_ID, paymentId: PAYMENT_ID });
      expect(data).not.toHaveProperty("paymentId");
    }
  });

  it("MUTATION: the upsert refuses the intent's row when it is on another payment, writing nothing to it", async () => {
    const log: Call[] = [];
    const store = recordingClient(log, "tx", {
      // Neither update matches (the row is another payment's), the insert meets it.
      "paymentTransaction.updateMany": () => ({ count: 0 }),
      "paymentTransaction.createMany": () => ({ count: 0 }),
      "paymentTransaction.findUnique": () => ({ paymentId: "payment_other", bookingModificationId: null }),
    }) as unknown as PaymentStore;

    await expect(
      upsertPaymentIntentTransaction({
        paymentId: PAYMENT_ID,
        kind: PaymentTransactionKind.ADDITIONAL,
        paymentIntentId: INTENT_ID,
        amountCents: 5_000,
        status: PaymentStatus.PENDING,
        store,
      }),
    ).rejects.toBeInstanceOf(IntentLedgerRowOnAnotherPaymentError);
    // No rebuild ran: the refusal rolls the writer's transaction back.
    expect(log.some((call) => call.op === "payment.findUnique")).toBe(false);
  });
});
