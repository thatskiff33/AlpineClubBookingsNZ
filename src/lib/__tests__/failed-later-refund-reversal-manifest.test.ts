/**
 * #4525 (Ledger M13): the FAILED_LATER_REFUND_REVERSAL export manifest that
 * `createXeroCardRefundReversalInvoice` records after its send. The recorder
 * runs against stubbed journal and close reads, with the manifest writer
 * stubbed. A close names its card refund row, the row names the refund Stripe
 * failed later, and the invoice covers that refund's R13 whole or not at all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  writeExportManifest: vi.fn(),
  manualRefundTaskFindUnique: vi.fn(),
  operationFindUnique: vi.fn(),
  eventFindUnique: vi.fn(),
  manifestFindFirst: vi.fn(),
  coverageFindFirst: vi.fn(),
  syncOperationFindUnique: vi.fn(),
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/prisma", () => {
  const prisma = {
    $transaction: (run: (tx: unknown) => unknown) => run(prisma),
    manualRefundTask: { findUnique: mocks.manualRefundTaskFindUnique },
    paymentRecoveryOperation: { findUnique: mocks.operationFindUnique },
    memberMoneyEvent: { findUnique: mocks.eventFindUnique },
    memberMoneyExportManifest: { findFirst: mocks.manifestFindFirst },
    memberMoneyExportCoverage: { findFirst: mocks.coverageFindFirst },
    xeroSyncOperation: { findUnique: mocks.syncOperationFindUnique },
  };
  return { prisma };
});
vi.mock("@/lib/logger", () => ({ default: mocks.logger }));
vi.mock("@/lib/member-money/internal/store", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/member-money/internal/store")),
  writeExportManifest: mocks.writeExportManifest,
}));

import { recordFailedLaterRefundReversalManifest } from "@/lib/member-money/doors";
import { cardRefundPaidAnotherWayOccurrenceKey } from "@/lib/manual-refund-task-settlement-rules";
import { buildCardRefundFailedLaterRecoveryKey } from "@/lib/payment-recovery-keys";
import { buildCardRefundStillOwedRecoveryKey } from "@/lib/card-refund-still-owed-keys";
import { hutFeeRefundLine } from "@/lib/xero-hut-fee-line-codes";
import { cardRefundReversalInvoiceKey } from "@/lib/xero-card-refund-reversal-invoice";

const BOOKING_ID = "cmbooking0001xyz";
const PAYMENT_ID = "cmpayment0001xyz";
const CLOSE_ID = "close_1";
const OPERATION_ID = "recovery_1";
const REFUND_ID = "re_failed_1";
const R12_JOURNAL = "journal_r12";
const LEGACY_KEY = cardRefundReversalInvoiceKey(PAYMENT_ID, CLOSE_ID);
const MAPPING = { code: "210", itemCode: null, codeExplicitlyConfigured: true } as never;

const line = (cents: number) => hutFeeRefundLine("Failed card refund's money returned", cents, MAPPING);

function closeOf(operationId: string) {
  return { kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: cardRefundPaidAnotherWayOccurrenceKey(operationId, { xeroRefundNote: "now" }) };
}

function recoveryRow(id: string, idempotencyKey: string, allocationPlan: unknown = null) {
  return { id, type: "REFUND_BOOKING_MODIFICATION", idempotencyKey, stripeKeyPrefix: null, bookingId: BOOKING_ID,
    paymentId: PAYMENT_ID, paymentIntentId: "pi_1", amountCents: 8_000, allocationPlan };
}

/** The journal: R12 for the failed refund, reversed by its R13 for `reversedCents` (null: not reversed). */
function journal(reversedCents: number | null) {
  mocks.eventFindUnique.mockImplementation(async ({ where }: { where: { eventKey: string } }) => {
    if (where.eventKey === `refund:${REFUND_ID}`) return { journal: { id: R12_JOURNAL } };
    if (where.eventKey === `reversal:${R12_JOURNAL}` && reversedCents !== null) {
      return { journal: { lines: [
        { account: "STRIPE_CLEARING", side: "DEBIT", amountCents: reversedCents },
        { account: "MEMBER_RECEIVABLE", side: "CREDIT", amountCents: reversedCents },
      ] } };
    }
    return null;
  });
}

const record = (lines = [line(8_000)]) => recordFailedLaterRefundReversalManifest({
  paymentId: PAYMENT_ID, bookingId: BOOKING_ID, closeTaskId: CLOSE_ID, invoiceId: "inv_1", legacyKey: LEGACY_KEY,
  source: { kind: "BUILT", lines },
});

const written = () => mocks.writeExportManifest.mock.calls[0]![1];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.writeExportManifest.mockResolvedValue("WRITTEN");
  mocks.manualRefundTaskFindUnique.mockResolvedValue(closeOf(OPERATION_ID));
  mocks.operationFindUnique.mockResolvedValue(recoveryRow(OPERATION_ID, buildCardRefundFailedLaterRecoveryKey(REFUND_ID)));
  mocks.manifestFindFirst.mockResolvedValue(null);
  mocks.coverageFindFirst.mockResolvedValue(null);
  journal(8_000);
});

describe("recordFailedLaterRefundReversalManifest", () => {
  it("covers the failed refund's R13 on Stripe clearing, whole, under the sender's key and invoice", async () => {
    await record();
    expect(mocks.writeExportManifest).toHaveBeenCalledTimes(1);
    expect(written()).toMatchObject({
      documentRole: "FAILED_LATER_REFUND_REVERSAL",
      legacyKey: LEGACY_KEY,
      bookingId: BOOKING_ID,
      providerInvoiceId: "inv_1",
      outcome: "COVERED",
      reason: null,
      lineTotalCents: 8_000,
      coverage: [{ account: "STRIPE_CLEARING", chargeIdentity: `reversal:${R12_JOURNAL}`, coveredCents: 8_000, taxCode: null }],
    });
  });

  it("an invoice for less than the failed refund (a part close) is a CENTS conflict with no coverage", async () => {
    await record([line(3_000)]);
    expect(written()).toMatchObject({ outcome: "CONFLICT", reason: "CENTS", lineTotalCents: 3_000, coverage: [] });
  });

  it("a refund whose R12 is not reversed yet answers no R13: COMPONENT_UNUSABLE", async () => {
    journal(null);
    await record();
    expect(written()).toMatchObject({ outcome: "CONFLICT", reason: "COMPONENT_UNUSABLE", coverage: [] });
  });

  it("a row owed for two failed refunds names no one R13: COMPONENT_UNUSABLE", async () => {
    mocks.operationFindUnique.mockResolvedValue(recoveryRow(OPERATION_ID, "booking_cancellation_refund_x", [
      { paymentTransactionId: "tx_1", amountCents: 4_000, failedRefundIds: [REFUND_ID] },
      { paymentTransactionId: "tx_2", amountCents: 4_000, failedRefundIds: ["re_failed_2"] },
    ]));
    await record();
    expect(written()).toMatchObject({ outcome: "CONFLICT", reason: "COMPONENT_UNUSABLE", coverage: [] });
  });

  it("a still-owed rest's close reads the failed refund from the row it was first owed on", async () => {
    const rest = "recovery_rest";
    const firstClose = "close_0";
    mocks.manualRefundTaskFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === CLOSE_ID ? closeOf(rest) : where.id === firstClose ? closeOf(OPERATION_ID) : null);
    mocks.operationFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === rest ? recoveryRow(rest, buildCardRefundStillOwedRecoveryKey(firstClose))
        : recoveryRow(OPERATION_ID, buildCardRefundFailedLaterRecoveryKey(REFUND_ID)));
    await record();
    expect(written()).toMatchObject({ outcome: "COVERED", coverage: [{ chargeIdentity: `reversal:${R12_JOURNAL}` }] });
  });

  it("an R13 an earlier reversal already covers is ALREADY_COVERED, with no second coverage row", async () => {
    mocks.coverageFindFirst.mockResolvedValue({ chargeIdentity: `reversal:${R12_JOURNAL}` });
    await record();
    expect(written()).toMatchObject({ outcome: "CONFLICT", reason: "ALREADY_COVERED", coverage: [] });
  });

  it("a replay hashes the operation's stored lines, and records nothing for a row that stored none", async () => {
    const stored = [line(8_000)];
    mocks.syncOperationFindUnique.mockResolvedValue({ requestPayload: { invoices: [{ lineItems: stored }] } });
    await recordFailedLaterRefundReversalManifest({ paymentId: PAYMENT_ID, bookingId: BOOKING_ID, closeTaskId: CLOSE_ID,
      invoiceId: "inv_1", legacyKey: LEGACY_KEY, source: { kind: "REPLAY", operationId: "op_1" } });
    expect(mocks.syncOperationFindUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "op_1" } }));
    expect(written()).toMatchObject({ outcome: "COVERED", frozenMapping: { source: "STORED_REQUEST" } });

    vi.clearAllMocks();
    mocks.syncOperationFindUnique.mockResolvedValue({ requestPayload: { queueType: "CARD_REFUND_REVERSAL_INVOICE" } });
    await recordFailedLaterRefundReversalManifest({ paymentId: PAYMENT_ID, bookingId: BOOKING_ID, closeTaskId: CLOSE_ID,
      invoiceId: "inv_1", legacyKey: LEGACY_KEY, source: { kind: "REPLAY", operationId: "op_1" } });
    expect(mocks.writeExportManifest).not.toHaveBeenCalled();
  });

  it("swallows and logs a database failure, and a lost unique race", async () => {
    mocks.writeExportManifest.mockRejectedValueOnce(new Error("connection reset"));
    await expect(record()).resolves.toBeUndefined();
    expect(mocks.logger.error).toHaveBeenCalledTimes(1);

    mocks.writeExportManifest.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "test" }));
    await expect(record()).resolves.toBeUndefined();
    expect(mocks.logger.error).toHaveBeenCalledTimes(1);
  });
});
