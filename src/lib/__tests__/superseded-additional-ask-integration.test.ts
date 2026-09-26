import {
  PaymentRecoveryOperationStatus,
  PaymentSource,
  PaymentStatus,
  PaymentTransactionKind,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
  #3341 — MINT, SUPERSEDE, RESULTING ASK, WITH NOTHING ON THE SEAM.

  The witness `INV-OPS-015` requires (`money-seam-mock-census.test.ts` pins this
  file by name). #3340 lost $135 because no suite ever ran the ask SIZING and the
  supersede MACHINERY together: every suite that touched
  `queueSupersededAdditionalIntentCancellations` mocked it. Here every link runs
  for real, over one in-memory ledger that actually holds the row being retired:

    sizeAdditionalAsk                          (the one home of the arithmetic)
      -> createModificationAdditionalPaymentIntent   (the minter)
        -> upsertPaymentIntentTransaction -> reconcilePaymentAggregates
        -> queueSupersededAdditionalIntentCancellations
          -> enqueuePaymentIntentCancellationRecovery
          -> runPaymentRecoveryOperationNow -> cancel -> reconcile

  Only the leaves are doubles: Stripe (a provider), the database (this ledger),
  the booking-ledger line sync `reconcilePaymentAggregates` ends in (#3581, proved
  against Postgres in its own realdb suite) and the logger.

  THE SCENARIO IS THE LIVE ONE: a $130 booking paid in full, edited up $70 and
  left unpaid, then edited up $70 again. The member owes $140. Before #3340 the
  second edit asked for $70 and retired the first $70 ask, so that money stopped
  being owed. Replace the carried term in `sizeAdditionalAsk` with zero and the
  first case below fails on exactly that figure.
*/

type Row = Record<string, unknown>;

const ledger = vi.hoisted(() => ({
  payments: [] as Row[],
  transactions: [] as Row[],
  operations: [] as Row[],
  clock: 0,
}));

const stripe = vi.hoisted(() => ({
  createPaymentIntent: vi.fn(),
  findOrCreateCustomer: vi.fn(),
  cancelPaymentIntentIfCancellableWithResult: vi.fn(),
}));

vi.mock("@/lib/prisma", () => {
  const tick = () => new Date(Date.UTC(2026, 8, 1) + ++ledger.clock * 1000);

  const matches = (row: Row, where: Row = {}): boolean =>
    Object.entries(where).every(([field, condition]) => {
      const value = row[field];
      if (condition !== null && typeof condition === "object" && !(condition instanceof Date)) {
        const c = condition as Record<string, unknown>;
        if ("in" in c && !(c.in as unknown[]).includes(value)) return false;
        if ("not" in c && (value === null || value === c.not)) return false;
        if ("gt" in c && !((value as number) > (c.gt as number))) return false;
        if ("lt" in c && !((value as number) < (c.lt as number))) return false;
        if ("lte" in c && !(value !== null && (value as Date) <= (c.lte as Date))) return false;
        return true;
      }
      return value === condition;
    });

  const apply = (row: Row, data: Row) => {
    for (const [field, value] of Object.entries(data)) {
      if (value !== null && typeof value === "object" && "increment" in (value as Row)) {
        row[field] = (row[field] as number) + ((value as Row).increment as number);
      } else if (value !== undefined) {
        row[field] = value;
      }
    }
    return row;
  };

  const project = (row: Row, select?: Row) =>
    select ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])) : { ...row };

  const withTransactions = (payment: Row) => ({
    ...payment,
    transactions: ledger.transactions
      .filter((transaction) => transaction.paymentId === payment.id)
      .sort((a, b) => (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime())
      .map((transaction) => ({ ...transaction })),
  });

  const transactionDefaults = (): Row => ({
    source: PaymentSource.STRIPE,
    refundedAmountCents: 0,
    paymentMethodId: null,
    reference: null,
    xeroInvoiceId: null,
    xeroInvoiceNumber: null,
    withdrawnAt: null,
    carriedAskCents: 0,
    reason: null,
  });

  return {
    prisma: {
      payment: {
        findUnique: async ({ where, include }: { where: Row; include?: Row }) => {
          const payment = ledger.payments.find((row) => matches(row, where));
          if (!payment) return null;
          return include?.transactions ? withTransactions(payment) : { ...payment };
        },
        update: async ({ where, data }: { where: Row; data: Row }) => {
          const payment = ledger.payments.find((row) => matches(row, where));
          if (!payment) throw new Error(`no payment ${JSON.stringify(where)}`);
          return { ...apply(payment, data) };
        },
      },
      paymentTransaction: {
        findMany: async ({ where, select }: { where: Row; select?: Row }) =>
          ledger.transactions.filter((row) => matches(row, where)).map((row) => project(row, select)),
        create: async ({ data }: { data: Row }) => {
          const row = { id: `txn_${ledger.transactions.length + 1}`, ...transactionDefaults(), createdAt: tick(), ...data };
          ledger.transactions.push(row);
          return { ...row };
        },
        upsert: async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
          const existing = ledger.transactions.find((row) => matches(row, where));
          if (existing) return { ...apply(existing, update) };
          const row = { id: `txn_${ledger.transactions.length + 1}`, ...transactionDefaults(), createdAt: tick(), ...create };
          ledger.transactions.push(row);
          return { ...row };
        },
        updateMany: async ({ where, data }: { where: Row; data: Row }) => {
          const hit = ledger.transactions.filter((row) => matches(row, where));
          hit.forEach((row) => apply(row, data));
          return { count: hit.length };
        },
      },
      paymentRecoveryOperation: {
        upsert: async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
          const existing = ledger.operations.find((row) => matches(row, where));
          if (existing) return { ...apply(existing, update) };
          const row = { id: `op_${ledger.operations.length + 1}`, attempts: 0, createdAt: tick(), ...create };
          ledger.operations.push(row);
          return { ...row };
        },
        updateMany: async ({ where, data }: { where: Row; data: Row }) => {
          const hit = ledger.operations.filter((row) => matches(row, where));
          hit.forEach((row) => apply(row, data));
          return { count: hit.length };
        },
        findUnique: async ({ where }: { where: Row }) => {
          const row = ledger.operations.find((candidate) => matches(candidate, where));
          return row ? { ...row } : null;
        },
      },
    },
  };
});

vi.mock("@/lib/stripe", () => ({
  createPaymentIntent: stripe.createPaymentIntent,
  findOrCreateCustomer: stripe.findOrCreateCustomer,
  cancelPaymentIntentIfCancellableWithResult: stripe.cancelPaymentIntentIfCancellableWithResult,
  processRefund: vi.fn(),
}));
vi.mock("@/lib/booking-ledger-settlement-sync", () => ({
  syncBookingLedgerSettlements: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { sizeAdditionalAsk } from "@/lib/additional-payment-ask";
import {
  createModificationAdditionalPaymentIntent,
  type BookingModificationPaymentContext,
} from "@/lib/booking-modification-settlement";
import { reconcilePaymentAggregates } from "@/lib/payment-transactions";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const PAYMENT_ID = "payment_3341";
const BOOKING_ID = "booking_3341";

function seedPaidBooking() {
  ledger.payments.push({
    id: PAYMENT_ID,
    bookingId: BOOKING_ID,
    amountCents: 13000,
    creditAppliedCents: 0,
    refundedAmountCents: 0,
    status: PaymentStatus.SUCCEEDED,
    source: PaymentSource.STRIPE,
    reference: null,
    stripeCustomerId: "cus_3341",
    stripePaymentIntentId: "pi_primary",
    stripePaymentMethodId: null,
    stripeSetupIntentId: null,
    xeroInvoiceId: null,
    xeroInvoiceNumber: null,
    additionalPaymentIntentId: null,
    additionalAmountCents: 0,
    additionalPaymentStatus: "NONE",
  });
  ledger.transactions.push({
    id: "txn_primary",
    paymentId: PAYMENT_ID,
    kind: PaymentTransactionKind.PRIMARY,
    source: PaymentSource.STRIPE,
    stripePaymentIntentId: "pi_primary",
    amountCents: 13000,
    refundedAmountCents: 0,
    status: PaymentStatus.SUCCEEDED,
    paymentMethodId: "pm_1",
    reference: null,
    xeroInvoiceId: null,
    xeroInvoiceNumber: null,
    withdrawnAt: null,
    carriedAskCents: 0,
    reason: null,
    createdAt: new Date(Date.UTC(2026, 7, 1)),
  });
}

function payment(): Row {
  const row = ledger.payments.find((candidate) => candidate.id === PAYMENT_ID);
  if (!row) throw new Error("payment missing");
  return row;
}

function additionalRows(): Row[] {
  return ledger.transactions.filter((row) => row.kind === PaymentTransactionKind.ADDITIONAL);
}

/**
 * One price-increasing edit, the way every edit door does it: size the ask from
 * the payment AS THE LEDGER NOW RECORDS IT, then hand it to the shared minter.
 */
async function editUp(modificationId: string, priceDiffCents: number, changeFeeCents = 0) {
  const current = payment();
  const additionalAsk = sizeAdditionalAsk({
    priceDiffCents,
    changeFeeCents,
    payment: {
      additionalAmountCents: current.additionalAmountCents as number,
      additionalPaymentStatus: current.additionalPaymentStatus as string,
    },
  });
  const context: BookingModificationPaymentContext = {
    pendingRefundAmountCents: 0,
    paymentId: PAYMENT_ID,
    additionalAsk,
    hasSucceededPayment: true,
    hasIssuedXeroInvoice: false,
    paymentCustomerId: "cus_3341",
    memberEmail: "member@example.test",
    memberName: "Ada Member",
    memberFirstName: "Ada",
    memberId: "member_3341",
    bookingModificationId: modificationId,
    priceLines: null,
  };
  return createModificationAdditionalPaymentIntent({
    format: CLUB_FORMAT_TEST,
    bookingId: BOOKING_ID,
    result: context,
    reason: "modification_price_increase",
    idempotencyKey: `mod_${BOOKING_ID}_${modificationId}`,
    failureMessage: "mint failed",
  });
}

/** What the member can still be charged: the live, uncollected ADDITIONAL asks. */
function collectibleCents(): number {
  return additionalRows()
    .filter((row) => row.status === PaymentStatus.PENDING || row.status === PaymentStatus.PROCESSING)
    .reduce((sum, row) => sum + (row.amountCents as number), 0);
}

beforeEach(() => {
  ledger.payments.length = 0;
  ledger.transactions.length = 0;
  ledger.operations.length = 0;
  ledger.clock = 0;
  let minted = 0;
  stripe.createPaymentIntent.mockReset().mockImplementation(async () => {
    minted += 1;
    return { id: `pi_add_${minted}`, client_secret: `pi_add_${minted}_secret` };
  });
  stripe.findOrCreateCustomer.mockReset().mockResolvedValue({ id: "cus_3341" });
  stripe.cancelPaymentIntentIfCancellableWithResult
    .mockReset()
    .mockResolvedValue({ canceled: true, paymentIntent: { status: "canceled" } });
  seedPaidBooking();
});

describe("mint -> supersede -> resulting ask, every seam real (#3341, INV-OPS-015)", () => {
  it("a second unpaid edit asks for BOTH edits and retires the first ask (the live #3340 shape)", async () => {
    const first = await editUp("mod_1", 7000);
    expect(first.additionalPaymentIntentId).toBe("pi_add_1");
    expect(payment().additionalAmountCents).toBe(7000);

    const second = await editUp("mod_2", 7000);
    expect(second.additionalPaymentIntentId).toBe("pi_add_2");

    // The new instrument carries the unpaid first ask, and says so.
    expect(stripe.createPaymentIntent).toHaveBeenLastCalledWith(
      expect.objectContaining({ amountCents: 14000, metadata: expect.objectContaining({ type: "modification_additional" }) }),
    );
    const [retired, live] = additionalRows();
    expect(live).toMatchObject({ stripePaymentIntentId: "pi_add_2", amountCents: 14000, carriedAskCents: 7000, status: PaymentStatus.PENDING });

    // The supersede really ran: the first intent was cancelled at Stripe and its
    // row retired through the durable operation, not merely queued.
    expect(stripe.cancelPaymentIntentIfCancellableWithResult).toHaveBeenCalledWith("pi_add_1");
    expect(retired).toMatchObject({ stripePaymentIntentId: "pi_add_1", status: PaymentStatus.FAILED });
    expect(ledger.operations).toEqual([
      expect.objectContaining({ paymentIntentId: "pi_add_1", amountCents: 7000, status: PaymentRecoveryOperationStatus.SUCCEEDED }),
    ]);

    // The resulting ask: what the Payment mirrors, and what can still be
    // collected, both equal what the member owes — $140, not $70.
    expect(payment()).toMatchObject({ additionalAmountCents: 14000, additionalPaymentIntentId: "pi_add_2", additionalPaymentStatus: "PENDING" });
    expect(collectibleCents()).toBe(14000);
  });

  it("carries the unpaid ask under a change fee too: own net plus carried, never the fee alone", async () => {
    await editUp("mod_1", 7000);
    await editUp("mod_2", 5000, 1000);

    expect(additionalRows()[1]).toMatchObject({ amountCents: 13000, carriedAskCents: 7000 });
    expect(payment().additionalAmountCents).toBe(13000);
    expect(collectibleCents()).toBe(13000);
  });

  it("carries nothing once the first ask is paid, so a paid extra is never billed twice", async () => {
    await editUp("mod_1", 7000);
    const first = additionalRows()[0];
    first.status = PaymentStatus.SUCCEEDED;
    await reconcilePaymentAggregates({ paymentId: PAYMENT_ID });
    expect(payment()).toMatchObject({ additionalAmountCents: 7000, additionalPaymentStatus: "SUCCEEDED" });

    await editUp("mod_2", 7000);

    expect(additionalRows()[1]).toMatchObject({ amountCents: 7000, carriedAskCents: 0 });
    // A captured intent is not a supersede candidate: nothing was cancelled.
    expect(stripe.cancelPaymentIntentIfCancellableWithResult).not.toHaveBeenCalled();
    expect(payment().additionalAmountCents).toBe(7000);
  });

  it("still mirrors the NEW ask when the immediate cancel fails and only the queued row stands", async () => {
    await editUp("mod_1", 7000);
    stripe.cancelPaymentIntentIfCancellableWithResult.mockRejectedValue(new Error("stripe is down"));

    await editUp("mod_2", 7000);

    // The durable operation is the guarantee; it is still owed a retry.
    expect(ledger.operations).toEqual([
      expect.objectContaining({ paymentIntentId: "pi_add_1", status: PaymentRecoveryOperationStatus.FAILED }),
    ]);
    // Row written before the supersede (#3340 fix round), so the reconcile the
    // mint ran reads the new ask as the latest ADDITIONAL, not the retired one.
    expect(payment()).toMatchObject({ additionalAmountCents: 14000, additionalPaymentIntentId: "pi_add_2" });
  });
});
