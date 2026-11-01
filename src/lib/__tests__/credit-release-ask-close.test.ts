import { PaymentStatus, PaymentTransactionKind } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const tx = {
    $executeRaw: vi.fn(),
    paymentTransaction: { updateMany: vi.fn() },
    payment: { findUnique: vi.fn() },
  };
  return {
    tx,
    prisma: {
      paymentTransaction: { findFirst: vi.fn(), findMany: vi.fn() },
      payment: { findMany: vi.fn() },
      $transaction: vi.fn(),
    },
    audit: vi.fn(),
    lockPayment: vi.fn(),
    recordBank: vi.fn(),
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/audit", () => ({ createAuditLog: mocks.audit }));
vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/stripe", () => ({ cancelPaymentIntentIfCancellableWithResult: vi.fn() }));
vi.mock("@/lib/payment-transactions", () => ({
  lockPaymentForRefundedTotal: mocks.lockPayment,
  recordInternetBankingPaymentTransaction: mocks.recordBank,
}));
vi.mock("@/lib/xero-invoice-balance", async () => {
  const actual = (await vi.importActual("@/lib/xero-invoice-balance")) as typeof import("@/lib/xero-invoice-balance");
  return { ...actual, readXeroInvoiceBalance: vi.fn() };
});

import { closeCreditReleaseAsksPaidInXero, CREDIT_RELEASE_PAID_IN_XERO_REASON, recordReleasePaidInXeroCash } from "@/lib/credit-release-ask-close";
import {
  CREDIT_RELEASE_ASK_REASON,
} from "@/lib/credit-release-ask-keys";

/*
  #4253 (`INV-ADDPAY-045`, owner decision D6): a request is closed when Xero shows its
  invoice paid, the card payment cancelled first, and the money written as bank cash.
*/
const NOW = new Date("2026-07-01T00:00:00.000Z");
const ask = { id: "ask-1", paymentId: "pay-1", amountCents: 4000, carriedAskCents: 0, stripePaymentIntentId: "pi_1" };

const payment = {
  id: "pay-1",
  xeroInvoiceId: "inv-1",
  additionalPaymentIntentId: "pi_1",
  booking: { id: "bk-1", memberId: "m-1", member: { id: "m-1", firstName: "A", lastName: "B", email: "a@example.test" } },
};

const paid = { invoiceId: "inv-1", status: "PAID", amountDueCents: 0, invoiceNumber: "INV-1" };
const open = { invoiceId: "inv-1", status: "AUTHORISED", amountDueCents: 4000, invoiceNumber: "INV-1" };

function deps(balance = paid, cancel: unknown = { canceled: true, paymentIntent: { status: "canceled" } }) {
  return {
    readInvoiceBalance: vi.fn().mockResolvedValue(balance),
    cancelIntent: vi.fn().mockResolvedValue(cancel),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.payment.findMany.mockResolvedValue([payment]);
  mocks.prisma.paymentTransaction.findFirst.mockResolvedValue(ask);
  mocks.tx.payment.findUnique.mockResolvedValue({
    additionalPaymentIntentId: "pi_1",
    additionalPaymentStatus: PaymentStatus.PENDING,
    booking: { status: "CONFIRMED", deletedAt: null },
  });
  mocks.prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(mocks.tx));
  mocks.tx.paymentTransaction.updateMany.mockResolvedValue({ count: 1 });
});

describe("closeCreditReleaseAsksPaidInXero", () => {
  it("only looks at uncollected asks on bookings that can still be paid, holding an unpaid credit-release request", async () => {
    await closeCreditReleaseAsksPaidInXero({ deps: deps(), now: NOW });
    const where = mocks.prisma.payment.findMany.mock.calls[0]![0].where;
    expect(where).toMatchObject({
      additionalAmountCents: { gt: 0 },
      additionalPaymentStatus: { not: PaymentStatus.SUCCEEDED },
      booking: { deletedAt: null },
    });
    expect(where.booking.status.in).not.toContain("CANCELLED");
    expect(where.booking.status.in).not.toContain("BUMPED");
    expect(where.transactions.some).toMatchObject({
      kind: PaymentTransactionKind.ADDITIONAL,
      reason: CREDIT_RELEASE_ASK_REASON,
      withdrawnAt: null,
    });
    // The row closed is the one the payment's summary points at, and only an unpaid one.
    const rowWhere = mocks.prisma.paymentTransaction.findFirst.mock.calls[0]![0].where;
    expect(rowWhere.stripePaymentIntentId).toBe("pi_1");
    expect(rowWhere.status.in).not.toContain(PaymentStatus.SUCCEEDED);
  });

  it("cancels the card payment, retires the request and books the money as bank cash", async () => {
    const d = deps();
    const result = await closeCreditReleaseAsksPaidInXero({ deps: d, now: NOW });
    expect(result).toEqual({ closed: 1, left: 0 });
    expect(d.cancelIntent).toHaveBeenCalledWith("pi_1", { cancellationReason: "duplicate" });
    expect(mocks.tx.paymentTransaction.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: PaymentStatus.FAILED, withdrawnAt: NOW } }),
    );
    expect(mocks.recordBank).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "pay-1",
        kind: PaymentTransactionKind.ADDITIONAL,
        amountCents: 4000,
        status: PaymentStatus.SUCCEEDED,
        reason: CREDIT_RELEASE_PAID_IN_XERO_REASON,
        store: mocks.tx,
      }),
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "payment.credit_release_ask.closed_paid_in_xero" }),
      mocks.tx,
    );
  });

  describe("a request that carried earlier ones (#4253 release 2, INV-ADDPAY-049)", () => {
    const carrying = { ...ask, amountCents: 9000, carriedAskCents: 5000 };
    const row = (id: string, reason: string | null, carriedAskCents = 0) => ({ id, reason, carriedAskCents, withdrawnAt: null });

    it("closes one that carried only an earlier released-credit request, writing its whole amount as cash", async () => {
      mocks.prisma.paymentTransaction.findFirst.mockResolvedValue(carrying);
      mocks.prisma.paymentTransaction.findMany.mockResolvedValue([
        row("ask-1", CREDIT_RELEASE_ASK_REASON, 5000),
        row("ask-0", CREDIT_RELEASE_ASK_REASON),
      ]);
      expect(await closeCreditReleaseAsksPaidInXero({ deps: deps(), now: NOW })).toEqual({ closed: 1, left: 0 });
      // The fence pins the row's own carried figure.
      expect(mocks.tx.paymentTransaction.updateMany.mock.calls[0]![0].where).toMatchObject({ id: "ask-1", carriedAskCents: 5000 });
      expect(mocks.recordBank).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 9000 }));
    });

    it("leaves one that carried an edit: part of it is owed on another invoice", async () => {
      mocks.prisma.paymentTransaction.findFirst.mockResolvedValue(carrying);
      mocks.prisma.paymentTransaction.findMany.mockResolvedValue([
        row("ask-1", CREDIT_RELEASE_ASK_REASON, 5000),
        row("ask-0", "booking_modification"),
      ]);
      const d = deps();
      expect(await closeCreditReleaseAsksPaidInXero({ deps: d, now: NOW })).toEqual({ closed: 0, left: 1 });
      expect(d.readInvoiceBalance).not.toHaveBeenCalled();
      expect(d.cancelIntent).not.toHaveBeenCalled();
    });

    it("leaves one whose carried rows are not all in hand, or that is not the newest row", async () => {
      mocks.prisma.paymentTransaction.findFirst.mockResolvedValue(carrying);
      mocks.prisma.paymentTransaction.findMany.mockResolvedValue([row("ask-1", CREDIT_RELEASE_ASK_REASON, 5000)]);
      expect(await closeCreditReleaseAsksPaidInXero({ deps: deps(), now: NOW })).toEqual({ closed: 0, left: 1 });
      mocks.prisma.paymentTransaction.findMany.mockResolvedValue([
        row("cash-1", null),
        row("ask-1", CREDIT_RELEASE_ASK_REASON, 5000),
        row("ask-0", CREDIT_RELEASE_ASK_REASON),
      ]);
      expect(await closeCreditReleaseAsksPaidInXero({ deps: deps(), now: NOW })).toEqual({ closed: 0, left: 1 });
      expect(mocks.recordBank).not.toHaveBeenCalled();
    });
  });

  it("leaves a request alone while Xero still shows the invoice open, and never cancels its card payment", async () => {
    const d = deps(open);
    expect(await closeCreditReleaseAsksPaidInXero({ deps: d, now: NOW })).toEqual({ closed: 0, left: 1 });
    expect(d.cancelIntent).not.toHaveBeenCalled();
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("leaves a request alone when Xero cannot be read", async () => {
    const d = deps();
    (d as { readInvoiceBalance: ReturnType<typeof vi.fn> }).readInvoiceBalance.mockRejectedValue(new Error("down"));
    expect(await closeCreditReleaseAsksPaidInXero({ deps: d, now: NOW })).toEqual({ closed: 0, left: 1 });
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("leaves a payment whose live ask is not a credit-release request", async () => {
    mocks.prisma.paymentTransaction.findFirst.mockResolvedValue(null);
    const d = deps();
    expect(await closeCreditReleaseAsksPaidInXero({ deps: d, now: NOW })).toEqual({ closed: 0, left: 1 });
    expect(d.cancelIntent).not.toHaveBeenCalled();
  });

  it.each(["succeeded", "processing"])("leaves a request whose card payment is %s: the card won", async (status) => {
    const d = deps(paid, { canceled: false, paymentIntent: { status } });
    expect(await closeCreditReleaseAsksPaidInXero({ deps: d, now: NOW })).toEqual({ closed: 0, left: 1 });
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    expect(mocks.recordBank).not.toHaveBeenCalled();
  });

  it("writes no cash when the fence is lost to another writer", async () => {
    mocks.tx.paymentTransaction.updateMany.mockResolvedValue({ count: 0 });
    expect(await closeCreditReleaseAsksPaidInXero({ deps: deps(), now: NOW })).toEqual({ closed: 0, left: 1 });
    expect(mocks.recordBank).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("writes no cash when the request stopped being the live ask while the card payment was cancelled", async () => {
    mocks.tx.payment.findUnique.mockResolvedValue({
      additionalPaymentIntentId: "pi_newer",
      additionalPaymentStatus: PaymentStatus.PENDING,
      booking: { status: "CONFIRMED", deletedAt: null },
    });
    expect(await closeCreditReleaseAsksPaidInXero({ deps: deps(), now: NOW })).toEqual({ closed: 0, left: 1 });
    expect(mocks.recordBank).not.toHaveBeenCalled();
  });

  it.each(["CANCELLED", "BUMPED"])("writes no cash on a booking that was %s meanwhile", async (status) => {
    mocks.tx.payment.findUnique.mockResolvedValue({
      additionalPaymentIntentId: "pi_1",
      additionalPaymentStatus: PaymentStatus.FAILED,
      booking: { status, deletedAt: null },
    });
    expect(await closeCreditReleaseAsksPaidInXero({ deps: deps(), now: NOW })).toEqual({ closed: 0, left: 1 });
    expect(mocks.recordBank).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("takes the global key and the payment lock before the fence", async () => {
    await closeCreditReleaseAsksPaidInXero({ deps: deps(), now: NOW });
    expect(mocks.tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(mocks.lockPayment).toHaveBeenCalledWith(mocks.tx, "pay-1");
    expect(mocks.tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(mocks.lockPayment.mock.invocationCallOrder[0]!);
    expect(mocks.lockPayment.mock.invocationCallOrder[0]).toBeLessThan(mocks.tx.paymentTransaction.updateMany.mock.invocationCallOrder[0]!);
  });
});

describe("recordReleasePaidInXeroCash (an invoice already settled when the request would be raised)", () => {
  const booking = { id: "bk-1", status: "CONFIRMED", deletedAt: null, finalPriceCents: 40_000, memberId: "m-1", member: { id: "m-1", firstName: "A", lastName: "B", email: "a@example.test" }, organisation: null };
  // The release cut the credit from 4000 to 0, so $40.00 of the $400.00 price is unpaid and unasked.
  const owing = { amountCents: 36_000, refundedAmountCents: 0, changeFeeCents: 0, creditAppliedCents: 0, additionalAmountCents: 0, additionalPaymentStatus: null, booking };
  const call = (releasedCents = 4000) => recordReleasePaidInXeroCash({ paymentId: "pay-1", releasedCents, balance: { invoiceId: "inv-1", invoiceNumber: "INV-1" } });

  beforeEach(() => {
    mocks.tx.payment.findUnique.mockResolvedValue(owing);
  });

  it("writes the money as bank cash on the invoice, under the global key then the payment lock, with an audit", async () => {
    await expect(call()).resolves.toBe(4000);
    expect(mocks.tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(mocks.lockPayment).toHaveBeenCalledWith(mocks.tx, "pay-1");
    expect(mocks.recordBank).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "pay-1",
        kind: PaymentTransactionKind.ADDITIONAL,
        amountCents: 4000,
        status: PaymentStatus.SUCCEEDED,
        xeroInvoiceId: "inv-1",
        reason: CREDIT_RELEASE_PAID_IN_XERO_REASON,
        store: mocks.tx,
      }),
    );
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "payment.credit_release_ask.closed_paid_in_xero" }), mocks.tx);
  });

  it("never writes more than the ledger shows unasked, so a repeat writes nothing", async () => {
    mocks.tx.payment.findUnique.mockResolvedValue({ ...owing, amountCents: 38_500 });
    await expect(call()).resolves.toBe(1500);
    mocks.tx.payment.findUnique.mockResolvedValue({ ...owing, amountCents: 40_000 });
    await expect(call()).resolves.toBe(0);
    expect(mocks.recordBank).toHaveBeenCalledTimes(1);
  });

  it("writes nothing for a booking that ended or was cancelled", async () => {
    mocks.tx.payment.findUnique.mockResolvedValue({ ...owing, booking: { ...booking, status: "CANCELLED" } });
    await expect(call()).resolves.toBe(0);
    expect(mocks.recordBank).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
