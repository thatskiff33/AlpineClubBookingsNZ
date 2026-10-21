import { PaymentStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  AdditionalAskAttributionConflictError,
  IntentLedgerRowOnAnotherPaymentError,
  IntentLedgerRowVanishedError,
  writePaymentIntentTransaction,
} from "@/lib/payment-intent-ledger-row-write";
import { CAPTURED_TRANSACTION_STATUS_LIST } from "@/lib/payment-transaction-status";

/**
 * #4081: no write of an intent's ledger row lowers a captured row's status -
 * neither an edit's ask write claiming a row that names no edit (a webhook's),
 * nor the plain write a card attach or a late SUCCEEDED makes. The real
 * statements' atomicity is proved on PostgreSQL in
 * `additional-ask-reduction.realdb.test.ts`; this pins the rule over a
 * strict in-memory ledger that answers only the filters the write sends.
 */
type Row = Record<string, unknown>;

function ledger(rows: Row[]) {
  // Every row is the written payment's unless a case says otherwise (#4217).
  for (const row of rows) row.paymentId ??= "payment-1";
  const refuse = (what: string): never => {
    throw new Error(`in-memory ledger: unsupported ${what}`);
  };
  const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([field, condition]) => {
      if (field === "OR") return (condition as Row[]).some((branch) => matches(row, branch));
      if (condition !== null && typeof condition === "object") {
        const c = condition as Row;
        for (const operator of Object.keys(c)) if (operator !== "in" && operator !== "notIn") refuse(`operator ${operator}`);
        if ("in" in c) return (c.in as unknown[]).includes(row[field]);
        return !(c.notIn as unknown[]).includes(row[field]);
      }
      return row[field] === condition;
    });
  const store = {
    paymentTransaction: {
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const hit = rows.filter((row) => matches(row, where));
        // As Prisma: an `undefined` field is left as it is.
        for (const row of hit) for (const [field, value] of Object.entries(data)) if (value !== undefined) row[field] = value;
        return { count: hit.length };
      },
      findUnique: async ({ where, select }: { where: Row; select: Row }) => {
        const row = rows.find((candidate) => matches(candidate, where));
        return row ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])) : null;
      },
      createMany: async ({ data, skipDuplicates }: { data: Row[]; skipDuplicates: boolean }) => {
        if (!skipDuplicates) refuse("createMany without skipDuplicates");
        let count = 0;
        for (const row of data) {
          if (rows.some((existing) => existing.stripePaymentIntentId === row.stripePaymentIntentId)) continue;
          rows.push({ bookingModificationId: null, ...row });
          count += 1;
        }
        return { count };
      },
    },
  };
  return store as never;
}

const INTENT = "pi_4081";

function write(store: never, status: PaymentStatus, bookingModificationId?: string) {
  const fields = { kind: "ADDITIONAL" as const, source: "STRIPE" as const, amountCents: 6_000, reason: "modification_additional_recovery" };
  return writePaymentIntentTransaction(store, {
    paymentId: "payment-1",
    paymentIntentId: INTENT,
    bookingModificationId,
    create: { ...fields, paymentId: "payment-1", stripePaymentIntentId: INTENT, status, ...(bookingModificationId ? { bookingModificationId } : {}) },
    update: { ...fields, status, ...(bookingModificationId ? { bookingModificationId } : {}) },
  });
}

// #4217 review (F3): the write is pinned to the payment its writer locked; an
// intent's row on another payment is refused and left exactly as it was.
describe("#4217: an intent's ledger row never moves payment", () => {
  it.each([undefined, "mod-y"])("refuses the intent's row on another payment, untouched (edit %s)", async (bookingModificationId) => {
    const rows: Row[] = [{ paymentId: "payment-other", stripePaymentIntentId: INTENT, status: PaymentStatus.PENDING, bookingModificationId: null, amountCents: 1_000 }];

    const refusal = write(ledger(rows), PaymentStatus.PROCESSING, bookingModificationId);

    await expect(refusal).rejects.toBeInstanceOf(IntentLedgerRowOnAnotherPaymentError);
    await expect(refusal).rejects.toMatchObject({ lockedPaymentId: "payment-1", rowPaymentId: "payment-other" });
    expect(rows).toEqual([{ paymentId: "payment-other", stripePaymentIntentId: INTENT, status: PaymentStatus.PENDING, bookingModificationId: null, amountCents: 1_000 }]);
  });
});

describe("#4081: writing an intent's ledger row never lowers a captured status", () => {
  it.each(CAPTURED_TRANSACTION_STATUS_LIST)(
    "an edit's PENDING write claims a webhook's %s row - it names the edit and keeps the status",
    async (captured) => {
      const rows: Row[] = [{ stripePaymentIntentId: INTENT, status: captured, bookingModificationId: null, reason: null }];

      await write(ledger(rows), PaymentStatus.PENDING, "mod-y");

      expect(rows).toEqual([
        expect.objectContaining({ status: captured, bookingModificationId: "mod-y", reason: "modification_additional_recovery" }),
      ]);
    },
  );

  it.each(CAPTURED_TRANSACTION_STATUS_LIST)("a plain PROCESSING write over a %s row keeps the status", async (captured) => {
    const rows: Row[] = [{ stripePaymentIntentId: INTENT, status: captured, bookingModificationId: null }];

    await write(ledger(rows), PaymentStatus.PROCESSING);

    expect(rows).toEqual([expect.objectContaining({ status: captured, amountCents: 6_000 })]);
  });

  it.each([PaymentStatus.REFUNDED, PaymentStatus.PARTIALLY_REFUNDED])(
    "a late SUCCEEDED write over a %s row leaves the refund's status",
    async (refunded) => {
      const rows: Row[] = [{ stripePaymentIntentId: INTENT, status: refunded, bookingModificationId: null }];

      await write(ledger(rows), PaymentStatus.SUCCEEDED);

      expect(rows[0]!.status).toBe(refunded);
    },
  );

  it.each([PaymentStatus.PENDING, PaymentStatus.PROCESSING, PaymentStatus.FAILED])(
    "a row not captured (%s) still takes the write's status, as before",
    async (uncaptured) => {
      const rows: Row[] = [{ stripePaymentIntentId: INTENT, status: uncaptured, bookingModificationId: null }];

      await write(ledger(rows), PaymentStatus.SUCCEEDED, "mod-y");

      expect(rows).toEqual([expect.objectContaining({ status: PaymentStatus.SUCCEEDED, bookingModificationId: "mod-y" })]);
    },
  );

  it("inserts a new intent's row with the write's status", async () => {
    const rows: Row[] = [];

    await write(ledger(rows), PaymentStatus.PENDING, "mod-y");

    expect(rows).toEqual([expect.objectContaining({ stripePaymentIntentId: INTENT, status: PaymentStatus.PENDING, bookingModificationId: "mod-y" })]);
  });

  it.each([PaymentStatus.PENDING, PaymentStatus.SUCCEEDED])(
    "an edit's write refuses a %s row naming another edit, and leaves it exactly as it was",
    async (status) => {
      const before = { paymentId: "payment-1", stripePaymentIntentId: INTENT, status, bookingModificationId: "mod-x", amountCents: 7_000 };
      const rows: Row[] = [{ ...before }];

      await expect(write(ledger(rows), PaymentStatus.PENDING, "mod-y")).rejects.toBeInstanceOf(AdditionalAskAttributionConflictError);

      expect(rows).toEqual([before]);
    },
  );

  it.each([["an edit's write", "mod-y"], ["a plain write", undefined]] as const)(
    "%s whose row vanishes after the insert's conflict throws the retryable error, never the attribution refusal",
    async (_writer, bookingModificationId) => {
      // The insert meets a concurrent writer's row (ON CONFLICT DO NOTHING),
      // which is deleted before the update that follows it.
      const rows: Row[] = [];
      const store = ledger(rows) as unknown as { paymentTransaction: { createMany: (args: unknown) => Promise<{ count: number }> } };
      store.paymentTransaction.createMany = async () => ({ count: 0 });

      const written = write(store as never, PaymentStatus.PENDING, bookingModificationId);

      await expect(written).rejects.toBeInstanceOf(IntentLedgerRowVanishedError);
      await expect(written).rejects.not.toBeInstanceOf(AdditionalAskAttributionConflictError);
    },
  );
});
