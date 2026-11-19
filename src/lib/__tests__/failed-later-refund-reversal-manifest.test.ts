/**
 * #4525 (Ledger M13): the FAILED_LATER_REFUND_REVERSAL export manifest that
 * `createXeroCardRefundReversalInvoice` records after its send. The recorder
 * runs against stubbed journal and close reads, with the manifest writer
 * stubbed. A close names its card refund row, the row names the refund Stripe
 * failed later, and the invoice covers that refund's R13 whole or not at all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { LineAmountTypes } from "xero-node";

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
// #4632: a replay must never consult the schedule; a case moves it to prove that.
vi.mock("@/lib/xero-tax-anchors", () => import("./support/xero-tax-anchors-baseline"));
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
import { BASELINE_XERO_TAX_RENDERING as BASELINE, type XeroTaxRendering } from "@/lib/xero-tax-rendering";
import { resolveXeroTaxRendering } from "@/lib/xero-tax-anchors";

const BOOKING_ID = "cmbooking0001xyz";
const PAYMENT_ID = "cmpayment0001xyz";
const CLOSE_ID = "close_1";
const OPERATION_ID = "recovery_1";
const REFUND_ID = "re_failed_1";
const R12_JOURNAL = "journal_r12";
const LEGACY_KEY = cardRefundReversalInvoiceKey(PAYMENT_ID, CLOSE_ID);
const MAPPING = { code: "210", itemCode: null, codeExplicitlyConfigured: true } as never;

const line = (cents: number, rendering: XeroTaxRendering = BASELINE) =>
  hutFeeRefundLine("Failed card refund's money returned", cents, MAPPING, rendering);

function closeOf(operationId: string) {
  return { kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: cardRefundPaidAnotherWayOccurrenceKey(operationId, { xeroRefundNote: "now" }) };
}

function recoveryRow(id: string, idempotencyKey: string, allocationPlan: unknown = null) {
  return { id, type: "REFUND_BOOKING_MODIFICATION", idempotencyKey, stripeKeyPrefix: null, bookingId: BOOKING_ID,
    paymentId: PAYMENT_ID, paymentIntentId: "pi_1", amountCents: 8_000, allocationPlan };
}

/**
 * The journal: R12 for the failed refund, reversed by its R13 for `reversedCents` (null: not reversed).
 * `r12: false` posts no R12; `clearing: false` gives the R13 no Stripe-clearing debit; `r13Reversed` undoes the R13.
 */
function journal(reversedCents: number | null, options: { r12?: boolean; clearing?: boolean; r13Reversed?: boolean } = {}) {
  const { r12 = true, clearing = true, r13Reversed = false } = options;
  mocks.eventFindUnique.mockImplementation(async ({ where }: { where: { eventKey: string } }) => {
    if (where.eventKey === `refund:${REFUND_ID}`) return r12 ? { journal: { id: R12_JOURNAL } } : null;
    if (where.eventKey === `reversal:${R12_JOURNAL}` && reversedCents !== null) {
      return { journal: { reversedBy: r13Reversed ? { id: "journal_r13_undo" } : null, lines: [
        { account: clearing ? "STRIPE_CLEARING" : "BANK", side: "DEBIT", amountCents: reversedCents },
        { account: "MEMBER_RECEIVABLE", side: "CREDIT", amountCents: reversedCents },
      ] } };
    }
    return null;
  });
}

/** The problem the recorder logged with its conflict. */
const loggedProblem = () => (mocks.logger.warn.mock.calls[0]?.[0] as { problem?: string } | undefined)?.problem;

const record = (lines = [line(8_000)], taxRendering: XeroTaxRendering = BASELINE) => recordFailedLaterRefundReversalManifest({
  paymentId: PAYMENT_ID, bookingId: BOOKING_ID, closeTaskId: CLOSE_ID, invoiceId: "inv_1", legacyKey: LEGACY_KEY,
  source: { kind: "BUILT", lines, taxRendering },
});

const replay = () => recordFailedLaterRefundReversalManifest({ paymentId: PAYMENT_ID, bookingId: BOOKING_ID, closeTaskId: CLOSE_ID,
  invoiceId: "inv_1", legacyKey: LEGACY_KEY, source: { kind: "REPLAY", operationId: "op_1" } });

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

  it.each([
    {
      name: "a close that is not a card refund's paid-another-way close",
      arrange: () => mocks.manualRefundTaskFindUnique.mockResolvedValue({ kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: "hand-back:other" }),
      problem: `close ${CLOSE_ID} is not a card refund's paid-another-way close`,
    },
    {
      name: "a close that is gone",
      arrange: () => mocks.manualRefundTaskFindUnique.mockResolvedValue(null),
      problem: `close ${CLOSE_ID} is not a card refund's paid-another-way close`,
    },
    {
      name: "a card refund row the close names that is gone",
      arrange: () => mocks.operationFindUnique.mockResolvedValue(null),
      problem: `the card refund row ${OPERATION_ID} close ${CLOSE_ID} names is gone`,
    },
    {
      name: "a failed refund with no R12 posted",
      arrange: () => journal(8_000, { r12: false }),
      problem: `no card refund cash is posted for refund:${REFUND_ID}`,
    },
    {
      name: "an R13 that moves nothing back onto Stripe clearing",
      arrange: () => journal(8_000, { clearing: false }),
      problem: `reversal:${R12_JOURNAL} moves nothing back onto STRIPE_CLEARING`,
    },
    {
      name: "an R13 that was itself reversed",
      arrange: () => journal(8_000, { r13Reversed: true }),
      problem: `reversal:${R12_JOURNAL} was itself reversed`,
    },
  ])("$name answers no live R13: COMPONENT_UNUSABLE, with the reason logged", async ({ arrange, problem }) => {
    arrange();
    await record();
    expect(written()).toMatchObject({ outcome: "CONFLICT", reason: "COMPONENT_UNUSABLE", coverage: [] });
    expect(loggedProblem()).toBe(problem);
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

    // An empty stored invoice is read as stored (one reader, `storedInvoiceRequestLines`): a CENTS conflict, not silence.
    vi.clearAllMocks();
    mocks.writeExportManifest.mockResolvedValue("WRITTEN");
    mocks.syncOperationFindUnique.mockResolvedValue({ requestPayload: { invoices: [{ lineItems: [] }] } });
    await recordFailedLaterRefundReversalManifest({ paymentId: PAYMENT_ID, bookingId: BOOKING_ID, closeTaskId: CLOSE_ID,
      invoiceId: "inv_1", legacyKey: LEGACY_KEY, source: { kind: "REPLAY", operationId: "op_1" } });
    expect(written()).toMatchObject({ outcome: "CONFLICT", reason: "CENTS", lineTotalCents: 0, coverage: [] });

    vi.clearAllMocks();
    mocks.syncOperationFindUnique.mockResolvedValue({ requestPayload: { queueType: "CARD_REFUND_REVERSAL_INVOICE" } });
    await recordFailedLaterRefundReversalManifest({ paymentId: PAYMENT_ID, bookingId: BOOKING_ID, closeTaskId: CLOSE_ID,
      invoiceId: "inv_1", legacyKey: LEGACY_KEY, source: { kind: "REPLAY", operationId: "op_1" } });
    expect(mocks.writeExportManifest).not.toHaveBeenCalled();
  });

  it.each([
    ["the baseline (registered, OUTPUT2)", BASELINE],
    ["a registered period with another code", { lineAmountTypes: "Inclusive", taxType: "OUTPUT3" }],
    ["an unregistered period", { lineAmountTypes: "NoTax" }],
  ] as Array<[string, XeroTaxRendering]>)("#4632: a built reversal freezes the rendering it was sent with, under %s", async (_label, rendering) => {
    await record([line(8_000, rendering)], rendering);
    expect(written()).toMatchObject({
      outcome: "COVERED",
      frozenMapping: { source: "BUILT", lineAmountTypes: rendering.lineAmountTypes, lineCodes: [{ accountCode: "210", taxType: rendering.taxType ?? null }] },
    });
  });

  it("#4632: a replay keeps its stored request's own basis and line tax type after a scheduled change, never the schedule's", async () => {
    // The schedule now says unregistered; the invoice was raised under the baseline and stored so.
    vi.mocked(resolveXeroTaxRendering).mockResolvedValue({ lineAmountTypes: LineAmountTypes.NoTax });
    mocks.syncOperationFindUnique.mockResolvedValue({ requestPayload: { invoices: [{ lineAmountTypes: "Inclusive", lineItems: [line(8_000)] }] } });
    await replay();
    expect(written()).toMatchObject({
      outcome: "COVERED",
      frozenMapping: { source: "STORED_REQUEST", lineAmountTypes: "Inclusive", lineCodes: [{ taxType: "OUTPUT2" }] },
    });
    expect(resolveXeroTaxRendering).not.toHaveBeenCalled();

    // A stored request that holds no basis freezes null, never a guess.
    vi.clearAllMocks();
    mocks.writeExportManifest.mockResolvedValue("WRITTEN");
    mocks.syncOperationFindUnique.mockResolvedValue({ requestPayload: { invoices: [{ lineItems: [line(8_000)] }] } });
    await replay();
    expect(written()).toMatchObject({ frozenMapping: { source: "STORED_REQUEST", lineAmountTypes: null } });
    vi.mocked(resolveXeroTaxRendering).mockReset();
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
