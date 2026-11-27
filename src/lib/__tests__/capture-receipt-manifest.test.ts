import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

/**
 * #4525 (Ledger M13): the capture-receipt recorder the five capture senders
 * call once a Xero payment id is stored. It plans against the capture's live
 * receipt and what other receipts already cover, writes once under the
 * payment's key, and never throws: a sender's result never depends on it.
 */

const mocks = vi.hoisted(() => {
  const tx = {
    $executeRaw: vi.fn(),
    memberMoneyEvent: { findUnique: vi.fn() },
    memberMoneyExportCoverage: { aggregate: vi.fn(), createMany: vi.fn(), findFirst: vi.fn() },
    memberMoneyExportManifest: { findUnique: vi.fn(), createMany: vi.fn() },
  };
  return {
    tx,
    xeroSyncOperation: { findFirst: vi.fn() },
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: mocks.$transaction, xeroSyncOperation: mocks.xeroSyncOperation } }));
vi.mock("@/lib/logger", () => ({ default: mocks.logger }));

import { recordCaptureReceiptManifest, type CaptureReceiptManifestInput } from "@/lib/member-money/internal/capture-receipt-manifest";

const INTENT = "pi_receipt";
const input = (overrides: Partial<CaptureReceiptManifestInput> = {}): CaptureReceiptManifestInput => ({
  bookingId: "booking-1",
  paymentIntentId: INTENT,
  paymentKey: "payment:pay-1:invoice-payment:v1",
  amountCents: 5000,
  providerPaymentId: "XERO-PAY-1",
  invoiceId: "XERO-INV-1",
  reference: `Stripe ${INTENT}`,
  bankCode: "606",
  ...overrides,
});
const receiptJournal = (debitCents: number, reversed = false) => ({
  journal: { reversedBy: reversed ? { id: "rev" } : null, lines: [{ amountCents: debitCents }] },
});
const manifestRow = () => mocks.tx.memberMoneyExportManifest.createMany.mock.calls[0]?.[0].data[0];
const coverageRows = () => mocks.tx.memberMoneyExportCoverage.createMany.mock.calls[0]?.[0].data;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tx.$executeRaw.mockResolvedValue(1);
  mocks.tx.memberMoneyEvent.findUnique.mockResolvedValue(receiptJournal(8000));
  mocks.tx.memberMoneyExportCoverage.aggregate.mockResolvedValue({ _sum: { coveredCents: null } });
  mocks.tx.memberMoneyExportManifest.findUnique.mockResolvedValue(null);
  mocks.tx.memberMoneyExportManifest.createMany.mockResolvedValue({ count: 1 });
  mocks.tx.memberMoneyExportCoverage.createMany.mockResolvedValue({ count: 1 });
  // #4525 (ALP-437): no released generation of the capture, so each row is generation 0.
  mocks.tx.memberMoneyExportCoverage.findFirst.mockResolvedValue(null);
  mocks.xeroSyncOperation.findFirst.mockResolvedValue(null);
});

describe("recordCaptureReceiptManifest (#4525)", () => {
  it("writes one COVERED receipt naming the capture under the payment's key, after locking the capture's row", async () => {
    await recordCaptureReceiptManifest(input());
    expect(manifestRow()).toMatchObject({
      documentRole: "CAPTURE_RECEIPT", legacyKey: input().paymentKey, bookingId: "booking-1",
      outcome: "COVERED", reason: null, lineTotalCents: 5000, providerInvoiceId: "XERO-PAY-1",
    });
    expect(coverageRows()).toEqual([expect.objectContaining({
      documentRole: "CAPTURE_RECEIPT", account: "STRIPE_CLEARING", chargeIdentity: `capture:${INTENT}`,
      coveredCents: 5000, taxCode: null, sliceKey: input().paymentKey,
    })]);
    // The row lock comes before any read the plan depends on.
    expect(mocks.tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(mocks.tx.memberMoneyEvent.findUnique.mock.invocationCallOrder[0]!);
    expect(mocks.tx.$executeRaw.mock.calls[0]?.slice(1)).toEqual([INTENT]);
    // Other receipts' cover is read under other keys only.
    expect(mocks.tx.memberMoneyExportCoverage.aggregate).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ chargeIdentity: `capture:${INTENT}`, sliceKey: { not: input().paymentKey } }),
    }));
  });

  it("records a CONFLICT with no coverage when other receipts already used the capture's cash", async () => {
    mocks.tx.memberMoneyExportCoverage.aggregate.mockResolvedValue({ _sum: { coveredCents: 3001 } });
    await recordCaptureReceiptManifest(input());
    expect(manifestRow()).toMatchObject({ outcome: "CONFLICT", reason: "CAPTURE_CENTS", lineTotalCents: 0 });
    expect(mocks.tx.memberMoneyExportCoverage.createMany).not.toHaveBeenCalled();
  });

  it("records CAPTURE_NOT_JOURNALLED for a reversed receipt, and for a payment naming no capture without locking or reading", async () => {
    mocks.tx.memberMoneyEvent.findUnique.mockResolvedValue(receiptJournal(8000, true));
    await recordCaptureReceiptManifest(input());
    expect(manifestRow()).toMatchObject({ outcome: "CONFLICT", reason: "CAPTURE_NOT_JOURNALLED" });

    vi.clearAllMocks();
    await recordCaptureReceiptManifest(input({ paymentIntentId: null }));
    expect(manifestRow()).toMatchObject({ outcome: "CONFLICT", reason: "CAPTURE_NOT_JOURNALLED" });
    expect(mocks.tx.$executeRaw).not.toHaveBeenCalled();
    expect(mocks.tx.memberMoneyEvent.findUnique).not.toHaveBeenCalled();
  });

  it("leaves a key already recorded alone", async () => {
    mocks.tx.memberMoneyExportManifest.findUnique.mockResolvedValue({ payloadHash: "0".repeat(64), providerInvoiceId: "XERO-PAY-1" });
    await recordCaptureReceiptManifest(input());
    expect(mocks.tx.memberMoneyExportManifest.createMany).not.toHaveBeenCalled();
  });

  it("swallows a database failure or a lost unique race, and never throws to the sender", async () => {
    mocks.tx.memberMoneyExportManifest.createMany.mockRejectedValueOnce(new Error("manifest store down"));
    await expect(recordCaptureReceiptManifest(input())).resolves.toBeUndefined();
    expect(mocks.logger.error).toHaveBeenCalledTimes(1);

    mocks.tx.memberMoneyExportManifest.createMany.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "test" }));
    await expect(recordCaptureReceiptManifest(input())).resolves.toBeUndefined();
    expect(mocks.logger.error).toHaveBeenCalledTimes(1);
  });

  it("hashes the bank code the payment operation stored under the key when the sender does not name it", async () => {
    mocks.xeroSyncOperation.findFirst.mockResolvedValue({ requestPayload: { payments: [{ account: { code: "607" } }] } });
    await recordCaptureReceiptManifest(input({ bankCode: undefined }));
    expect(mocks.xeroSyncOperation.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { idempotencyKey: input().paymentKey, entityType: "PAYMENT" },
    }));
    expect(manifestRow().frozenMapping).toMatchObject({ bankCode: "607" });
  });

  it("records nothing for a payment of no cents", async () => {
    await recordCaptureReceiptManifest(input({ amountCents: 0 }));
    expect(mocks.$transaction).not.toHaveBeenCalled();
  });
});
