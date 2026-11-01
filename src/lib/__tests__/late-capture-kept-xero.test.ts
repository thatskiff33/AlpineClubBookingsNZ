import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enqueueXeroKeptLateCaptureInvoiceOperation: vi.fn(),
  kickQueuedXeroOutboxOperationsIfConnected: vi.fn(),
  releaseXeroSupplementaryInvoiceForCapturedPaymentIntent: vi.fn(),
  creditBackLateCaptureRefunds: vi.fn(),
  transactionFindUnique: vi.fn(),
  taskFindUnique: vi.fn(),
  paymentFindUnique: vi.fn(),
  linkFindMany: vi.fn(),
  linkFindFirst: vi.fn(),
  operationFindFirst: vi.fn(),
  operationFindMany: vi.fn(),
  modificationFindUnique: vi.fn(),
  executeRaw: vi.fn(),
  lockKeptLateCaptureTask: vi.fn(),
  lockSupplementaryInvoiceAnchor: vi.fn(),
  findLiveKeptReceiptRow: vi.fn(),
  enqueueAdditionalCaptureReceiptOperation: vi.fn(),
  readCreditReleaseCaptureShare: vi.fn(),
  readPrimaryInvoiceFeeAtLink: vi.fn(),
  findPrimaryInvoiceGapInvoice: vi.fn(),
  readPrimaryInvoiceGapBilling: vi.fn(),
  actualGapAnchors: {} as Record<string, (...a: unknown[]) => unknown>,
}));

// Review N2: the gap invoice's anchors are read through the recorder's own
// helpers; each defaults to the real one (the recorder reads it too) and a
// test may answer it directly.
vi.mock("@/lib/xero-primary-invoice-gap-anchors", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/xero-primary-invoice-gap-anchors");
  Object.assign(mocks.actualGapAnchors, actual);
  return {
    ...actual,
    readPrimaryInvoiceFeeAtLink: (...a: unknown[]) => mocks.readPrimaryInvoiceFeeAtLink(...a),
    findPrimaryInvoiceGapInvoice: (...a: unknown[]) => mocks.findPrimaryInvoiceGapInvoice(...a),
    readPrimaryInvoiceGapBilling: (...a: unknown[]) => mocks.readPrimaryInvoiceGapBilling(...a),
  };
});

vi.mock("@/lib/xero-kept-late-capture-invoice", () => ({
  enqueueXeroKeptLateCaptureInvoiceOperation: (...a: unknown[]) =>
    mocks.enqueueXeroKeptLateCaptureInvoiceOperation(...a),
  keptLateCaptureDocumentDate: () => "2026-06-10",
  lockKeptLateCaptureTask: (...a: unknown[]) => mocks.lockKeptLateCaptureTask(...a),
}));
vi.mock("@/lib/xero-operation-outbox", () => ({
  kickQueuedXeroOutboxOperationsIfConnected: (...a: unknown[]) =>
    mocks.kickQueuedXeroOutboxOperationsIfConnected(...a),
  lockSupplementaryInvoiceAnchor: (...a: unknown[]) => mocks.lockSupplementaryInvoiceAnchor(...a),
}));
// The REAL retired codes: a copy here would let the constant drift unseen.
vi.mock("@/lib/xero-supplementary-invoice-late-capture", async (importOriginal) => ({
  RETIRED_CODES_ANSWERING_CAPTURE: (
    (await importOriginal()) as typeof import("@/lib/xero-supplementary-invoice-late-capture")
  ).RETIRED_CODES_ANSWERING_CAPTURE,
  releaseXeroSupplementaryInvoiceForCapturedPaymentIntent: (...a: unknown[]) =>
    mocks.releaseXeroSupplementaryInvoiceForCapturedPaymentIntent(...a),
}));
vi.mock("@/lib/kept-late-capture-receipt-rows", () => ({
  findLiveKeptReceiptRow: (...a: unknown[]) => mocks.findLiveKeptReceiptRow(...a),
}));
vi.mock("@/lib/additional-capture-receipt-enqueue", () => ({
  enqueueAdditionalCaptureReceiptOperation: (...a: unknown[]) => mocks.enqueueAdditionalCaptureReceiptOperation(...a),
}));
vi.mock("@/lib/additional-capture-xero-receipt", () => ({
  additionalCaptureReceiptKey: (intent: string) => `receipt-key:${intent}`,
}));
vi.mock("@/lib/credit-release-capture-share", () => ({
  readCreditReleaseCaptureShare: (...a: unknown[]) => mocks.readCreditReleaseCaptureShare(...a),
}));
vi.mock("@/lib/late-capture-refund-credit-note", () => ({
  creditBackLateCaptureRefunds: (...a: unknown[]) => mocks.creditBackLateCaptureRefunds(...a),
}));
vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  finishKeptLateCaptureXeroRecord,
  planKeptLateCaptureXeroRecord,
  readKeptChangeCaptureEvidence,
} from "@/lib/late-capture-kept-xero";
import {
  decideLateCapture,
  keptChangeCaptureRoute,
  keptLateCaptureInvoiceAsked,
  keptLateCaptureRecordRoute,
  type KeptChangeCaptureEvidence,
} from "@/lib/late-capture-kept-xero-rules";
import type { ClubTimeZone } from "@/lib/club-time";
import logger from "@/lib/logger";
import { matchesWhere } from "@/lib/__tests__/support/prisma-where";
import { supplementaryInvoicesMovedOffIntentWhere } from "@/lib/supplementary-invoice-parked-from";

/**
 * #3635 (owner decision 29 Sep 2026): a late capture a treasurer KEPT on a
 * cancelled booking is recorded in Xero by the app. The one decision, and the
 * dismissal's two halves; the document itself is
 * `xero-kept-late-capture-invoice.test.ts`'s and the resulting books
 * `xero-kept-late-capture-ledger.test.ts`'s.
 */
const store = {
  paymentTransaction: { findUnique: (...a: unknown[]) => mocks.transactionFindUnique(...a) },
  manualRefundTask: { findUnique: (...a: unknown[]) => mocks.taskFindUnique(...a) },
  payment: { findUnique: (...a: unknown[]) => mocks.paymentFindUnique(...a) },
  // The payment's active PRIMARY_INVOICE links (`bookingHasPrimaryXeroInvoice`).
  xeroObjectLink: {
    findMany: (...a: unknown[]) => mocks.linkFindMany(...a),
    findFirst: (...a: unknown[]) => mocks.linkFindFirst(...a),
  },
  xeroSyncOperation: {
    findFirst: (...a: unknown[]) => mocks.operationFindFirst(...a),
    findMany: (...a: unknown[]) => mocks.operationFindMany(...a),
  },
  bookingModification: { findUnique: (...a: unknown[]) => mocks.modificationFindUnique(...a) },
  $executeRaw: (...a: unknown[]) => mocks.executeRaw(...a),
};

function plan() {
  return planKeptLateCaptureXeroRecord({
    manualRefundTaskId: "task_kept",
    bookingId: "booking-1",
    paymentIntentId: "pi_late",
    actingMemberId: "treasurer-1",
    clubZone: "Pacific/Auckland" as ClubTimeZone,
    store: store as never,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transactionFindUnique.mockResolvedValue({
    kind: "PRIMARY",
    status: "SUCCEEDED",
    amountCents: 24000,
    paymentId: "payment-1",
  });
  mocks.taskFindUnique.mockResolvedValue({ createdAt: new Date("2026-06-10T01:00:00Z"), status: "DISMISSED" });
  mocks.paymentFindUnique.mockResolvedValue({ xeroInvoiceId: null });
  mocks.linkFindMany.mockResolvedValue([]);
  mocks.linkFindFirst.mockResolvedValue(null);
  mocks.operationFindFirst.mockResolvedValue(null);
  mocks.operationFindMany.mockReset().mockResolvedValue([]);
  mocks.modificationFindUnique.mockResolvedValue({ newData: {} });
  mocks.findLiveKeptReceiptRow.mockResolvedValue(null);
  mocks.readCreditReleaseCaptureShare.mockResolvedValue({ ownCents: 0, held: false });
  mocks.readPrimaryInvoiceFeeAtLink.mockImplementation((...a: unknown[]) => mocks.actualGapAnchors.readPrimaryInvoiceFeeAtLink!(...a));
  mocks.findPrimaryInvoiceGapInvoice.mockImplementation((...a: unknown[]) => mocks.actualGapAnchors.findPrimaryInvoiceGapInvoice!(...a));
  mocks.readPrimaryInvoiceGapBilling.mockImplementation((...a: unknown[]) => mocks.actualGapAnchors.readPrimaryInvoiceGapBilling!(...a));
  mocks.enqueueAdditionalCaptureReceiptOperation.mockResolvedValue({ outcome: "queued", queueOperationId: "op_receipt" });
  mocks.enqueueXeroKeptLateCaptureInvoiceOperation.mockResolvedValue({
    queueOperationId: "op_kept",
    message: "queued",
  });
  mocks.kickQueuedXeroOutboxOperationsIfConnected.mockResolvedValue(undefined);
  mocks.creditBackLateCaptureRefunds.mockResolvedValue(undefined);
  mocks.releaseXeroSupplementaryInvoiceForCapturedPaymentIntent.mockResolvedValue({
    released: 1,
    queueOperationIds: ["op_supp"],
    outcome: "released",
  });
});

describe("decideLateCapture (the one decision)", () => {
  const capture = { status: "SUCCEEDED" as const, amountCents: 24000 };
  it("lets a task decide; with none, the webhook's routing", () => {
    expect(decideLateCapture({ taskStatus: "OPEN", bookingStatus: "CANCELLED", superseded: false, capture })).toEqual({
      state: "awaiting-decision",
      recordCents: 0,
    });
    expect(
      decideLateCapture({ taskStatus: "COMPLETED", bookingStatus: "CANCELLED", superseded: false, capture }),
    ).toEqual({ state: "refunded", recordCents: 0 });
    expect(
      decideLateCapture({ taskStatus: "DISMISSED", bookingStatus: "CANCELLED", superseded: false, capture }),
    ).toEqual({ state: "kept", recordCents: 24000 });
    expect(decideLateCapture({ taskStatus: null, bookingStatus: "CANCELLED", superseded: false, capture }).state).toBe(
      "refunded",
    );
    expect(decideLateCapture({ taskStatus: null, bookingStatus: "CONFIRMED", superseded: true, capture }).state).toBe(
      "refunded",
    );
    expect(decideLateCapture({ taskStatus: null, bookingStatus: "CONFIRMED", superseded: false, capture }).state).toBe(
      "kept",
    );
  });

  // #3924 round 6 (owner, 8 Oct 2026: "Record receipt, then credit").
  it("MUTATION: an approved refund closed as paid another way is still refunded, but Xero owes the GROSS receipt", () => {
    expect(
      decideLateCapture({
        taskStatus: "COMPLETED",
        bookingStatus: "CANCELLED",
        superseded: false,
        capture,
        refundClosedPaidAnotherWay: true,
      }),
    ).toEqual({ state: "refunded", recordCents: 24000 });
    // Only an approval's close: an undecided task owes nothing yet.
    expect(
      decideLateCapture({ taskStatus: "OPEN", bookingStatus: "CANCELLED", superseded: false, capture, refundClosedPaidAnotherWay: true }),
    ).toEqual({ state: "awaiting-decision", recordCents: 0 });
    // And never a charge that was not taken.
    expect(
      decideLateCapture({
        taskStatus: "COMPLETED",
        bookingStatus: "CANCELLED",
        superseded: false,
        capture: { status: "FAILED", amountCents: 24000 },
        refundClosedPaidAnotherWay: true,
      }).recordCents,
    ).toBe(0);
  });

  it("records the GROSS capture, even one refunded since - the refund is its own note", () => {
    for (const status of ["PARTIALLY_REFUNDED", "REFUNDED"] as const) {
      expect(
        decideLateCapture({
          taskStatus: "DISMISSED",
          bookingStatus: "CANCELLED",
          superseded: false,
          capture: { status, amountCents: 24000 },
        }).recordCents,
      ).toBe(24000);
    }
    expect(
      decideLateCapture({
        taskStatus: "DISMISSED",
        bookingStatus: "CANCELLED",
        superseded: false,
        capture: { status: "FAILED", amountCents: 24000 },
      }).recordCents,
    ).toBe(0);
  });

  it("sends a change payment on an invoiced booking to its change's evidence, everything else to the kept invoice", () => {
    expect(keptLateCaptureRecordRoute({ captureKind: "ADDITIONAL", bookingHasPrimaryInvoice: true })).toBe(
      "by-change-evidence",
    );
    expect(keptLateCaptureRecordRoute({ captureKind: "ADDITIONAL", bookingHasPrimaryInvoice: false })).toBe(
      "kept-invoice",
    );
    expect(keptLateCaptureRecordRoute({ captureKind: "PRIMARY", bookingHasPrimaryInvoice: true })).toBe(
      "kept-invoice",
    );
  });

  it("counts a kept invoice row in any state but CANCELLED as already asked for", () => {
    for (const status of ["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "PARTIAL"]) {
      expect(keptLateCaptureInvoiceAsked([{ queueType: "KEPT_LATE_CAPTURE_INVOICE", status }])).toBe(true);
    }
    expect(keptLateCaptureInvoiceAsked([{ queueType: "KEPT_LATE_CAPTURE_INVOICE", status: "CANCELLED" }])).toBe(
      false,
    );
  });
});

describe("planKeptLateCaptureXeroRecord", () => {
  it("queues the kept invoice for the gross cents dated the capture day, INSIDE the caller's transaction", async () => {
    await expect(plan()).resolves.toEqual({ kind: "kept-invoice-queued", queueOperationId: "op_kept" });
    expect(mocks.enqueueXeroKeptLateCaptureInvoiceOperation).toHaveBeenCalledWith({
      manualRefundTaskId: "task_kept",
      bookingId: "booking-1",
      paymentIntentId: "pi_late",
      capturedCents: 24000,
      capturedOn: "2026-06-10",
      createdByMemberId: "treasurer-1",
      store,
    });
  });

  it("still queues the gross receipt for a capture refunded in the dashboard since", async () => {
    mocks.transactionFindUnique.mockResolvedValue({
      kind: "PRIMARY",
      status: "REFUNDED",
      amountCents: 24000,
      paymentId: "payment-1",
    });
    await plan();
    expect(mocks.enqueueXeroKeptLateCaptureInvoiceOperation).toHaveBeenCalledWith(
      expect.objectContaining({ capturedCents: 24000 }),
    );
  });

  it("hands a kept change payment on an invoiced booking to the late-capture release", async () => {
    mocks.transactionFindUnique.mockResolvedValue({
      kind: "ADDITIONAL",
      status: "SUCCEEDED",
      amountCents: 2500,
      paymentId: "payment-1",
    });
    mocks.paymentFindUnique.mockResolvedValue({ xeroInvoiceId: "inv_primary" });
    // #4324: one its change invoice answers - here, parked on its intent.
    mocks.operationFindMany.mockResolvedValueOnce([{ status: "WAITING_PAYMENT", lastErrorCode: null }]);
    await expect(plan()).resolves.toEqual({ kind: "change-payment", paymentIntentId: "pi_late" });
    expect(mocks.enqueueXeroKeptLateCaptureInvoiceOperation).not.toHaveBeenCalled();
  });

  it("gives a kept change payment on a booking Xero never invoiced the kept invoice (review F3)", async () => {
    mocks.transactionFindUnique.mockResolvedValue({
      kind: "ADDITIONAL",
      status: "SUCCEEDED",
      amountCents: 2500,
      paymentId: "payment-1",
    });
    await expect(plan()).resolves.toMatchObject({ kind: "kept-invoice-queued" });
    expect(mocks.enqueueXeroKeptLateCaptureInvoiceOperation).toHaveBeenCalledWith(
      expect.objectContaining({ capturedCents: 2500 }),
    );
  });

  it("does nothing for an intent with no recorded capture", async () => {
    mocks.transactionFindUnique.mockResolvedValue(null);
    await expect(plan()).resolves.toEqual({ kind: "none" });
  });

  it("#4324: takes the task row first and queues nothing for a task no longer kept (a stale repair snapshot)", async () => {
    mocks.taskFindUnique.mockResolvedValue({ createdAt: new Date("2026-06-10T01:00:00Z"), status: "OPEN" });
    await expect(plan()).resolves.toEqual({ kind: "none" });
    expect(mocks.lockKeptLateCaptureTask).toHaveBeenCalledWith(store, "task_kept");
    expect(mocks.lockKeptLateCaptureTask.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.taskFindUnique.mock.invocationCallOrder[0]!,
    );
    expect(mocks.enqueueXeroKeptLateCaptureInvoiceOperation).not.toHaveBeenCalled();
  });
});

/**
 * #4324 (owner decision 25 Oct 2026, Q1 "split on the evidence";
 * `INV-PAY-144`): a kept CHANGE capture on a cancelled booking whose primary
 * invoice exists. The books each route produces are
 * `xero-kept-late-capture-ledger.test.ts`'s (e3, e4).
 */
describe("#4324: a kept change capture on an invoiced booking", () => {
  const evidence = (overrides: Partial<KeptChangeCaptureEvidence> = {}): KeptChangeCaptureEvidence => ({
    answeredByChangeInvoice: false,
    changeId: "mod_change",
    settledAgainstPrimary: false,
    changeInvoices: "none",
    billedByGapInvoice: false,
    primaryMissedChange: false,
    ...overrides,
  });

  it("keptChangeCaptureRoute: one row per branch of the owner's split", () => {
    expect(keptChangeCaptureRoute(evidence({ answeredByChangeInvoice: true, changeInvoices: "withdrawn" }))).toBe("change-invoice");
    expect(keptChangeCaptureRoute(evidence({ answeredByChangeInvoice: true, changeId: null }))).toBe("change-invoice");
    expect(keptChangeCaptureRoute(evidence({ changeId: null }))).toBe("change-unknown");
    expect(keptChangeCaptureRoute(evidence({ settledAgainstPrimary: true, changeInvoices: "withdrawn" }))).toBe("receipt");
    expect(keptChangeCaptureRoute(evidence({ changeInvoices: "none" }))).toBe("receipt");
    expect(keptChangeCaptureRoute(evidence({ changeInvoices: "live" }))).toBe("receipt");
    expect(keptChangeCaptureRoute(evidence({ changeInvoices: "withdrawn" }))).toBe("kept-invoice");
    // A live #3980 gap invoice anchored on the change bills it, whatever its own invoices did.
    expect(keptChangeCaptureRoute(evidence({ billedByGapInvoice: true, changeInvoices: "withdrawn" }))).toBe("receipt");
    expect(keptChangeCaptureRoute(evidence({ billedByGapInvoice: true, changeId: null }))).toBe("change-unknown");
    expect(keptChangeCaptureRoute(evidence({ billedByGapInvoice: true, answeredByChangeInvoice: true }))).toBe("change-invoice");
    // Codex re-review: a change the primary missed (it raced the create) and no gap still bills is billed nowhere.
    expect(keptChangeCaptureRoute(evidence({ primaryMissedChange: true, changeInvoices: "none" }))).toBe("kept-invoice");
    expect(keptChangeCaptureRoute(evidence({ primaryMissedChange: true, changeInvoices: "withdrawn" }))).toBe("kept-invoice");
    expect(keptChangeCaptureRoute(evidence({ primaryMissedChange: true, billedByGapInvoice: true }))).toBe("receipt");
    expect(keptChangeCaptureRoute(evidence({ primaryMissedChange: true, changeInvoices: "live" }))).toBe("receipt");
  });

  describe("readKeptChangeCaptureEvidence: a change invoice answers the capture exactly where the release does not answer none-queued", () => {
    const read = (rows: Array<{ status: string; lastErrorCode: string | null; requestPayload?: Record<string, unknown> }>) => {
      mocks.operationFindMany.mockResolvedValueOnce(rows).mockResolvedValueOnce([]);
      return readKeptChangeCaptureEvidence(store as never, { paymentIntentId: "pi_late", changeId: "mod_change", bookingId: "booking-1", primaryInvoiceId: null });
    };
    for (const status of ["WAITING_PAYMENT", "PENDING", "RUNNING", "SUCCEEDED", "FAILED", "PARTIAL"]) {
      it(`a ${status} row naming the intent answers it (the release releases, reports or finds it)`, async () => {
        await expect(read([{ status, lastErrorCode: null }])).resolves.toMatchObject({ answeredByChangeInvoice: true });
      });
    }
    for (const code of ["STALE_WAITING_PAYMENT", "STALE_WAITING_PAYMENT_CAPTURED", "STALE_WAITING_PAYMENT_COVERED"]) {
      it(`MUTATION: a CANCELLED row stamped ${code} answers it (revived, alerted or covered)`, async () => {
        await expect(read([{ status: "CANCELLED", lastErrorCode: code }])).resolves.toMatchObject({ answeredByChangeInvoice: true });
      });
    }
    for (const code of ["KEPT_LATE_CAPTURE_WITHDRAWN", null]) {
      it(`a CANCELLED row stamped ${code} was withdrawn, and answers nothing`, async () => {
        await expect(read([{ status: "CANCELLED", lastErrorCode: code }])).resolves.toMatchObject({ answeredByChangeInvoice: false });
      });
    }

    it("MUTATION #3403 LANE-SYNC: asks for an invoice naming the intent, or one moved off it onto a carrier and still waiting there", async () => {
      await read([]);
      expect(mocks.operationFindMany.mock.calls[0]![0]).toMatchObject({
        where: {
          queueType: "SUPPLEMENTARY_INVOICE",
          OR: [
            { requestPayload: { path: ["paymentIntentId"], equals: "pi_late" } },
            supplementaryInvoicesMovedOffIntentWhere("pi_late"),
          ],
        },
      });
      expect(supplementaryInvoicesMovedOffIntentWhere("pi_late")).toMatchObject({
        queueType: "SUPPLEMENTARY_INVOICE",
        status: "WAITING_PAYMENT",
        localModel: "BookingModification",
        requestPayload: { path: ["parkedFromPaymentIntentId"], equals: "pi_late" },
      });
    });

    it("a moved waiting invoice answers the superseded capture, while another carrier's invoice does not", async () => {
      const moved = {
        queueType: "SUPPLEMENTARY_INVOICE", direction: "OUTBOUND", entityType: "INVOICE", operationType: "CREATE",
        localModel: "BookingModification", status: "WAITING_PAYMENT", lastErrorCode: null,
        requestPayload: { paymentIntentId: "pi_carrier", parkedFromPaymentIntentId: "pi_late" },
      };
      mocks.operationFindMany.mockImplementation(async ({ where }) => [moved].filter((row) => matchesWhere(row, where)));
      const input = { paymentIntentId: "pi_late", changeId: null, bookingId: "booking-1", primaryInvoiceId: null };
      await expect(readKeptChangeCaptureEvidence(store as never, input)).resolves.toMatchObject({ answeredByChangeInvoice: true });
      moved.requestPayload.parkedFromPaymentIntentId = "pi_other";
      await expect(readKeptChangeCaptureEvidence(store as never, input)).resolves.toMatchObject({ answeredByChangeInvoice: false });
    });

    for (const status of ["PENDING", "RUNNING", "SUCCEEDED", "PARTIAL", "FAILED"]) {
      it(`an unpaid ${status} invoice needs a receipt even when it names the capture`, async () => {
        await expect(read([{ status, lastErrorCode: null, requestPayload: { paymentIntentId: "pi_late", recordPayment: false } }]))
          .resolves.toMatchObject({ answeredByChangeInvoice: false });
      });
    }

    it("reads the #3980 marker and the change's own invoices, never the gap invoice a marked edit anchors", async () => {
      mocks.modificationFindUnique.mockResolvedValue({
        newData: { primaryInvoiceSettlement: { settledAgainstPrimaryInvoice: true } },
      });
      mocks.operationFindMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ status: "PENDING", requestPayload: { primaryInvoiceGap: true } }]);
      await expect(
        readKeptChangeCaptureEvidence(store as never, { paymentIntentId: "pi_late", changeId: "mod_change", bookingId: "booking-1", primaryInvoiceId: null }),
      ).resolves.toEqual(evidence({ settledAgainstPrimary: true, changeInvoices: "none", billedByGapInvoice: false }));
      expect(mocks.operationFindMany.mock.calls[1]![0]).toMatchObject({
        where: {
          queueType: "SUPPLEMENTARY_INVOICE",
          OR: [
            { localModel: "BookingModification", localId: "mod_change" },
            { requestPayload: { path: ["bookingModificationId"], equals: "mod_change" } },
          ],
        },
      });
    });

    describe("MUTATION review N2 (`INV-SSOT`): the gap invoice bills the change by the recorder's own reading (`findPrimaryInvoiceGapInvoice` and its anchors)", () => {
      const figures = { atLink: {}, operationId: "op_primary" };
      const gap = (over: { anchorIds?: string[]; status?: string | null; linkActive?: boolean | null }) => ({
        anchorIds: over.anchorIds ?? ["mod_change"],
        operation: over.status === null ? null : { id: "op_gap", status: over.status ?? "PENDING", requestPayload: {}, responsePayload: null, manuallyResolvedAt: null },
        link: over.linkActive === null || over.linkActive === undefined ? null : { id: "link_gap", xeroObjectId: "inv_gap", active: over.linkActive },
      });
      /** The change's own rows withdrawn, beside whatever gap row the old reading looked for on the change itself. */
      const read = async (
        found: ReturnType<typeof gap> | null,
        ownGapRow?: { status: string },
        billing: { racingKnown?: boolean; racingIds?: string[] } = {},
      ) => {
        mocks.readPrimaryInvoiceFeeAtLink.mockResolvedValueOnce(figures);
        mocks.readPrimaryInvoiceGapBilling.mockResolvedValueOnce({
          racingKnown: billing.racingKnown ?? true,
          racingIds: billing.racingIds ?? found?.anchorIds ?? [],
          gap: found,
        });
        mocks.operationFindMany
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
            { status: "CANCELLED", requestPayload: {} },
            ...(ownGapRow ? [{ status: ownGapRow.status, requestPayload: { primaryInvoiceGap: true } }] : []),
          ]);
        return readKeptChangeCaptureEvidence(store as never, {
          paymentIntentId: "pi_late",
          changeId: "mod_change",
          bookingId: "booking-1",
          primaryInvoiceId: "inv_primary",
        });
      };

      it("bills a change that is a SECOND racing anchor - the gap row sits on the first, never on this change", async () => {
        await expect(read(gap({ anchorIds: ["mod_first", "mod_change"], status: "PENDING" }))).resolves.toMatchObject({
          changeInvoices: "withdrawn",
          billedByGapInvoice: true,
        });
        expect(mocks.readPrimaryInvoiceGapBilling).toHaveBeenCalledWith("booking-1", figures, store);
      });

      for (const status of ["PENDING", "RUNNING", "WAITING_PAYMENT", "FAILED"]) {
        it(`bills it while the gap invoice may still reach Xero (${status}, not yet linked)`, async () => {
          await expect(read(gap({ status }))).resolves.toMatchObject({ billedByGapInvoice: true });
        });
      }

      it("bills it where Xero has the gap invoice linked", async () => {
        await expect(read(gap({ status: "SUCCEEDED", linkActive: true }))).resolves.toMatchObject({ billedByGapInvoice: true });
      });

      for (const status of ["SUCCEEDED", "PARTIAL"]) {
        it(`bills NOTHING where the gap invoice was voided in Xero (row ${status}, link deactivated) - a receipt on it would only be refused`, async () => {
          await expect(read(gap({ status, linkActive: false }), { status })).resolves.toMatchObject({
            changeInvoices: "withdrawn",
            billedByGapInvoice: false,
          });
        });
      }

      it("bills nothing where the gap invoice was withdrawn, or does not bill this change, or there is no gap", async () => {
        await expect(read(gap({ status: "CANCELLED" }), { status: "CANCELLED" })).resolves.toMatchObject({ billedByGapInvoice: false });
        await expect(read(gap({ anchorIds: ["mod_other"], status: "PENDING" }))).resolves.toMatchObject({ billedByGapInvoice: false });
        await expect(read(null)).resolves.toMatchObject({ billedByGapInvoice: false });
      });

      it("reads no gap without the primary invoice's id or its stored figures", async () => {
        mocks.operationFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
        await expect(
          readKeptChangeCaptureEvidence(store as never, { paymentIntentId: "pi_late", changeId: "mod_change", bookingId: "booking-1", primaryInvoiceId: null }),
        ).resolves.toMatchObject({ billedByGapInvoice: false });
        mocks.readPrimaryInvoiceFeeAtLink.mockResolvedValueOnce(null);
        mocks.operationFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
        await expect(
          readKeptChangeCaptureEvidence(store as never, { paymentIntentId: "pi_late", changeId: "mod_change", bookingId: "booking-1", primaryInvoiceId: "inv_primary" }),
        ).resolves.toMatchObject({ billedByGapInvoice: false });
        expect(mocks.readPrimaryInvoiceGapBilling).not.toHaveBeenCalled();
      });

      describe("MUTATION Codex re-review: the #3980 marker is the primary's billing only where the primary did not miss the change", () => {
        const marked = () =>
          mocks.modificationFindUnique.mockResolvedValueOnce({
            newData: { primaryInvoiceSettlement: { settledAgainstPrimaryInvoice: true } },
          });
        /** Only the gap row on the change itself, no own invoice: what a raced edit's rows look like. */
        const readGapOnly = (found: ReturnType<typeof gap> | null, billing: { racingKnown?: boolean; racingIds?: string[] } = {}) => {
          mocks.readPrimaryInvoiceFeeAtLink.mockResolvedValueOnce(figures);
          mocks.readPrimaryInvoiceGapBilling.mockResolvedValueOnce({
            racingKnown: billing.racingKnown ?? true,
            racingIds: billing.racingIds ?? found?.anchorIds ?? [],
            gap: found,
          });
          mocks.operationFindMany
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce(found?.operation ? [{ status: found.operation.status, requestPayload: { primaryInvoiceGap: true } }] : []);
          return readKeptChangeCaptureEvidence(store as never, {
            paymentIntentId: "pi_late",
            changeId: "mod_change",
            bookingId: "booking-1",
            primaryInvoiceId: "inv_primary",
          });
        };

        it("a marked edit that raced the primary, gap-only rows, its gap voided in Xero: billed nowhere - the kept invoice, never the refused receipt", async () => {
          marked();
          const read = await readGapOnly(gap({ status: "SUCCEEDED", linkActive: false }));
          expect(read).toEqual(
            evidence({ settledAgainstPrimary: false, changeInvoices: "none", billedByGapInvoice: false, primaryMissedChange: true }),
          );
          expect(keptChangeCaptureRoute(read)).toBe("kept-invoice");
        });

        it("the marked variant of the voided fixture (an own invoice withdrawn beside it): the kept invoice", async () => {
          marked();
          const withdrawn = await read(gap({ status: "SUCCEEDED", linkActive: false }), { status: "SUCCEEDED" });
          expect(withdrawn).toMatchObject({ settledAgainstPrimary: false, changeInvoices: "withdrawn", primaryMissedChange: true });
          expect(keptChangeCaptureRoute(withdrawn)).toBe("kept-invoice");
        });

        it("a marked edit that raced the primary, its gap invoice withdrawn unsent: the kept invoice", async () => {
          marked();
          await expect(readGapOnly(gap({ status: "CANCELLED" })).then(keptChangeCaptureRoute)).resolves.toBe("kept-invoice");
        });

        it("a raced, unmarked edit with gap-only rows and a voided gap: the kept invoice (no own invoice no longer means the primary bills it)", async () => {
          const read = await readGapOnly(gap({ status: "SUCCEEDED", linkActive: false }));
          expect(read).toMatchObject({ settledAgainstPrimary: false, changeInvoices: "none", primaryMissedChange: true });
          expect(keptChangeCaptureRoute(read)).toBe("kept-invoice");
        });

        for (const [label, found] of [
          ["linked in Xero", gap({ status: "SUCCEEDED", linkActive: true })],
          ["still on its way (PENDING)", gap({ status: "PENDING" })],
          ["retryable (FAILED)", gap({ status: "FAILED" })],
          ["billing it as a second anchor", gap({ anchorIds: ["mod_first", "mod_change"], status: "SUCCEEDED", linkActive: true })],
        ] as const) {
          it(`a marked edit that raced the primary, its gap invoice ${label}: its receipt on the gap`, async () => {
            marked();
            const read = await readGapOnly(found);
            expect(read).toMatchObject({ billedByGapInvoice: true, primaryMissedChange: true, settledAgainstPrimary: false });
            expect(keptChangeCaptureRoute(read)).toBe("receipt");
          });
        }

        it("a marked edit in the primary's snapshot (the primary billed it): its receipt on the primary, as before", async () => {
          marked();
          const read = await readGapOnly(null, { racingKnown: true, racingIds: [] });
          expect(read).toMatchObject({ settledAgainstPrimary: true, primaryMissedChange: false });
          expect(keptChangeCaptureRoute(read)).toBe("receipt");
        });

        it("no snapshot stored (an older create): the marker stands unless a gap invoice was raised on the change", async () => {
          marked();
          await expect(readGapOnly(null, { racingKnown: false, racingIds: ["mod_change"] })).resolves.toMatchObject({
            settledAgainstPrimary: true,
            primaryMissedChange: false,
          });
          marked();
          await expect(readGapOnly(gap({ status: "SUCCEEDED", linkActive: false }), { racingKnown: false, racingIds: [] })).resolves.toMatchObject({
            settledAgainstPrimary: false,
            primaryMissedChange: true,
          });
          marked();
          await expect(readGapOnly(gap({ status: "CANCELLED" }), { racingKnown: false, racingIds: [] })).resolves.toMatchObject({
            settledAgainstPrimary: true,
            primaryMissedChange: false,
          });
        });
      });
    });

    describe("MUTATION review F3 (money): the change's own invoice is live only where it bills THIS capture, as the recorder reads it", () => {
      const readOwn = (own: Array<{ status: string; requestPayload: Record<string, unknown> }>) => {
        mocks.operationFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce(own);
        return readKeptChangeCaptureEvidence(store as never, { paymentIntentId: "pi_late", changeId: "mod_change", bookingId: "booking-1", primaryInvoiceId: null });
      };
      it("moved onto a carrier and released there (paid with the carrier's money): withdrawn for this capture, so the kept invoice", async () => {
        const evidence = await readOwn([{ status: "SUCCEEDED", requestPayload: { paymentIntentId: "pi_carrier", parkedFromPaymentIntentId: "pi_late" } }]);
        expect(evidence).toMatchObject({ answeredByChangeInvoice: false, changeInvoices: "withdrawn" });
        expect(keptChangeCaptureRoute(evidence)).toBe("kept-invoice");
      });
      it("released by the carrier, linked in Xero: the link is that invoice's, still withdrawn for this capture", async () => {
        mocks.linkFindFirst.mockResolvedValueOnce({ id: "link_change" });
        await expect(readOwn([{ status: "SUCCEEDED", requestPayload: { paymentIntentId: "pi_carrier" } }])).resolves.toMatchObject({ changeInvoices: "withdrawn" });
      });
      it("still WAITING on a different intent: withdrawn for this capture, so the kept invoice", async () => {
        const evidence = await readOwn([{ status: "WAITING_PAYMENT", requestPayload: { paymentIntentId: "pi_other" } }]);
        expect(evidence).toMatchObject({ answeredByChangeInvoice: false, changeInvoices: "withdrawn" });
        expect(keptChangeCaptureRoute(evidence)).toBe("kept-invoice");
      });
      it("live where it names this capture, names none, or was raised unpaid (the receipt's target)", async () => {
        for (const requestPayload of [{ paymentIntentId: "pi_late" }, {}, { paymentIntentId: "pi_carrier", recordPayment: false }]) {
          await expect(readOwn([{ status: "SUCCEEDED", requestPayload }])).resolves.toMatchObject({ changeInvoices: "live" });
        }
      });
      it("reads the latest live one, as the recorder does", async () => {
        await readOwn([]);
        expect(mocks.operationFindMany.mock.calls[1]![0]).toMatchObject({ orderBy: { createdAt: "desc" } });
        await expect(
          readOwn([
            { status: "SUCCEEDED", requestPayload: { paymentIntentId: "pi_carrier" } },
            { status: "SUCCEEDED", requestPayload: { paymentIntentId: "pi_late" } },
          ]),
        ).resolves.toMatchObject({ changeInvoices: "withdrawn" });
      });
    });

    describe("owner decision Q1 (#4324): a capture with no readable change queues nothing, whatever names its intent", () => {
      const readNaming = (rows: Array<{ status: string; lastErrorCode: string | null; requestPayload: Record<string, unknown> }>) => {
        mocks.operationFindMany.mockResolvedValueOnce(rows);
        return readKeptChangeCaptureEvidence(store as never, { paymentIntentId: "pi_late", changeId: null, bookingId: "booking-1", primaryInvoiceId: null });
      };
      for (const status of ["PENDING", "SUCCEEDED"]) {
        it(`an unpaid ${status} invoice naming its intent: still change-unknown (a repair finding), never a receipt`, async () => {
          const evidence = await readNaming([{ status, lastErrorCode: null, requestPayload: { paymentIntentId: "pi_late", recordPayment: false } }]);
          expect(evidence).toMatchObject({ answeredByChangeInvoice: false, changeId: null });
          expect(keptChangeCaptureRoute(evidence)).toBe("change-unknown");
        });
      }
    });

    it("reads the change's invoices as withdrawn only when every one is CANCELLED, and live where Xero has one linked", async () => {
      mocks.operationFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ status: "CANCELLED", requestPayload: {} }]);
      await expect(
        readKeptChangeCaptureEvidence(store as never, { paymentIntentId: "pi_late", changeId: "mod_change", bookingId: "booking-1", primaryInvoiceId: null }),
      ).resolves.toMatchObject({ changeInvoices: "withdrawn" });
      mocks.operationFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ status: "CANCELLED", requestPayload: {} }]);
      mocks.linkFindFirst.mockResolvedValueOnce({ id: "link_change" });
      await expect(
        readKeptChangeCaptureEvidence(store as never, { paymentIntentId: "pi_late", changeId: "mod_change", bookingId: "booking-1", primaryInvoiceId: null }),
      ).resolves.toMatchObject({ changeInvoices: "live" });
    });
  });

  describe("planKeptLateCaptureXeroRecord", () => {
    beforeEach(() => {
      mocks.transactionFindUnique.mockResolvedValue({
        kind: "ADDITIONAL",
        status: "SUCCEEDED",
        amountCents: 8000,
        paymentId: "payment-1",
        bookingModificationId: "mod_change",
        reason: null,
      });
      mocks.paymentFindUnique.mockResolvedValue({ xeroInvoiceId: "inv_primary" });
    });

    it("hands it to the late-capture release where a change invoice answers it", async () => {
      mocks.operationFindMany.mockResolvedValueOnce([{ status: "WAITING_PAYMENT", lastErrorCode: null }]).mockResolvedValue([]);
      await expect(plan()).resolves.toEqual({ kind: "change-payment", paymentIntentId: "pi_late" });
      expect(mocks.enqueueAdditionalCaptureReceiptOperation).not.toHaveBeenCalled();
      expect(mocks.enqueueXeroKeptLateCaptureInvoiceOperation).not.toHaveBeenCalled();
    });

    for (const code of ["STALE_WAITING_PAYMENT", "STALE_WAITING_PAYMENT_CAPTURED", "STALE_WAITING_PAYMENT_COVERED"]) {
      it(`MUTATION: a change invoice the reaper retired (${code}) still answers it, though every change row is CANCELLED - never a kept invoice`, async () => {
        const retired = { status: "CANCELLED", lastErrorCode: code, requestPayload: {} };
        mocks.operationFindMany.mockResolvedValueOnce([retired]).mockResolvedValueOnce([retired]);
        await expect(plan()).resolves.toEqual({ kind: "change-payment", paymentIntentId: "pi_late" });
        expect(mocks.enqueueXeroKeptLateCaptureInvoiceOperation).not.toHaveBeenCalled();
        expect(mocks.enqueueAdditionalCaptureReceiptOperation).not.toHaveBeenCalled();
      });
    }

    it("MUTATION e3: queues its receipt on the caller's transaction where the primary bills the change, under the change's anchor after the task row", async () => {
      mocks.modificationFindUnique.mockResolvedValue({
        newData: { primaryInvoiceSettlement: { settledAgainstPrimaryInvoice: true } },
      });
      await expect(plan()).resolves.toEqual({ kind: "receipt-queued", queueOperationId: "op_receipt" });
      expect(mocks.enqueueAdditionalCaptureReceiptOperation).toHaveBeenCalledWith("pi_late", {
        store,
        keptLateCapture: true,
        createdByMemberId: "treasurer-1",
      });
      expect(mocks.enqueueXeroKeptLateCaptureInvoiceOperation).not.toHaveBeenCalled();
      expect(mocks.lockSupplementaryInvoiceAnchor).toHaveBeenCalledWith(store, "mod_change");
      const taskLock = mocks.lockKeptLateCaptureTask.mock.invocationCallOrder[0]!;
      const anchorLock = mocks.lockSupplementaryInvoiceAnchor.mock.invocationCallOrder[0]!;
      expect(taskLock).toBeLessThan(anchorLock);
      expect(anchorLock).toBeLessThan(mocks.operationFindMany.mock.invocationCallOrder[0]!);
    });

    it("MUTATION e4: queues the kept invoice where the change's invoice was withdrawn, so nothing bills it", async () => {
      mocks.operationFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ status: "CANCELLED", requestPayload: {} }]);
      await expect(plan()).resolves.toEqual({ kind: "kept-invoice-queued", queueOperationId: "op_kept" });
      expect(mocks.enqueueXeroKeptLateCaptureInvoiceOperation).toHaveBeenCalledWith(
        expect.objectContaining({ capturedCents: 8000, paymentIntentId: "pi_late" }),
      );
      expect(mocks.enqueueAdditionalCaptureReceiptOperation).not.toHaveBeenCalled();
    });

    describe("MUTATION review N2: a change billed by the gap invoice, by the recorder's reading", () => {
      const gapOn = (anchorIds: string[], status: string, linkActive: boolean | null) => ({
        anchorIds,
        operation: { id: "op_gap", status, requestPayload: {}, responsePayload: null, manuallyResolvedAt: null },
        link: linkActive === null ? null : { id: "link_gap", xeroObjectId: "inv_gap", active: linkActive },
      });
      const billing = (found: ReturnType<typeof gapOn>) =>
        mocks.readPrimaryInvoiceGapBilling.mockResolvedValue({ racingKnown: true, racingIds: found.anchorIds, gap: found });
      beforeEach(() => {
        mocks.readPrimaryInvoiceFeeAtLink.mockResolvedValue({ atLink: {}, operationId: "op_primary" });
      });

      it("own invoices withdrawn, a second racing anchor of a live gap invoice: its receipt, never a kept invoice beside the gap", async () => {
        mocks.findPrimaryInvoiceGapInvoice.mockResolvedValue(gapOn(["mod_first", "mod_change"], "SUCCEEDED", true));
        billing(gapOn(["mod_first", "mod_change"], "SUCCEEDED", true));
        mocks.operationFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ status: "CANCELLED", requestPayload: {} }]);
        await expect(plan()).resolves.toEqual({ kind: "receipt-queued", queueOperationId: "op_receipt" });
        expect(mocks.enqueueXeroKeptLateCaptureInvoiceOperation).not.toHaveBeenCalled();
      });

      it("own invoices withdrawn, the gap invoice voided in Xero: billed nowhere, so the kept invoice - never a receipt the worker would refuse", async () => {
        mocks.findPrimaryInvoiceGapInvoice.mockResolvedValue(gapOn(["mod_change"], "SUCCEEDED", false));
        billing(gapOn(["mod_change"], "SUCCEEDED", false));
        mocks.operationFindMany
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ status: "CANCELLED", requestPayload: {} }, { status: "SUCCEEDED", requestPayload: { primaryInvoiceGap: true } }])
          .mockResolvedValue([]);
        await expect(plan()).resolves.toMatchObject({ kind: "kept-invoice-queued" });
        expect(mocks.enqueueAdditionalCaptureReceiptOperation).not.toHaveBeenCalled();
      });

      it("MUTATION Codex re-review: a MARKED edit that raced the primary, gap-only rows, its gap voided - the kept invoice for the whole capture, never the refused receipt", async () => {
        mocks.modificationFindUnique.mockResolvedValue({
          newData: { primaryInvoiceSettlement: { settledAgainstPrimaryInvoice: true } },
        });
        mocks.findPrimaryInvoiceGapInvoice.mockResolvedValue(gapOn(["mod_change"], "SUCCEEDED", false));
        billing(gapOn(["mod_change"], "SUCCEEDED", false));
        mocks.operationFindMany
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ status: "SUCCEEDED", requestPayload: { primaryInvoiceGap: true } }])
          .mockResolvedValue([]);
        await expect(plan()).resolves.toMatchObject({ kind: "kept-invoice-queued" });
        expect(mocks.enqueueXeroKeptLateCaptureInvoiceOperation).toHaveBeenCalledWith(
          expect.objectContaining({ capturedCents: 8000, paymentIntentId: "pi_late" }),
        );
        expect(mocks.enqueueAdditionalCaptureReceiptOperation).not.toHaveBeenCalled();
      });

      it("a MARKED edit the primary billed (in its snapshot), no gap: its receipt on the primary, as before", async () => {
        mocks.modificationFindUnique.mockResolvedValue({
          newData: { primaryInvoiceSettlement: { settledAgainstPrimaryInvoice: true } },
        });
        mocks.readPrimaryInvoiceGapBilling.mockResolvedValue({ racingKnown: true, racingIds: [], gap: null });
        mocks.operationFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ status: "CANCELLED", requestPayload: {} }]);
        await expect(plan()).resolves.toEqual({ kind: "receipt-queued", queueOperationId: "op_receipt" });
        expect(mocks.enqueueXeroKeptLateCaptureInvoiceOperation).not.toHaveBeenCalled();
      });
    });

    it("queues nothing where no change can be read from the capture, and locks the booking", async () => {
      mocks.transactionFindUnique.mockResolvedValue({
        kind: "ADDITIONAL",
        status: "SUCCEEDED",
        amountCents: 8000,
        paymentId: "payment-1",
        bookingModificationId: null,
        reason: null,
      });
      await expect(plan()).resolves.toEqual({ kind: "none" });
      expect(mocks.lockSupplementaryInvoiceAnchor).toHaveBeenCalledWith(store, "booking-1");
      expect(mocks.enqueueAdditionalCaptureReceiptOperation).not.toHaveBeenCalled();
      expect(mocks.enqueueXeroKeptLateCaptureInvoiceOperation).not.toHaveBeenCalled();
    });

    it("MUTATION owner decision Q1 (#4324): no change stamp, even with an unpaid invoice naming the capture - queues nothing (a repair finding)", async () => {
      mocks.transactionFindUnique.mockResolvedValue({
        kind: "ADDITIONAL",
        status: "SUCCEEDED",
        amountCents: 8000,
        paymentId: "payment-1",
        bookingModificationId: null,
        reason: null,
      });
      mocks.operationFindMany.mockResolvedValueOnce([
        { status: "SUCCEEDED", lastErrorCode: null, requestPayload: { paymentIntentId: "pi_late", recordPayment: false } },
      ]);
      await expect(plan()).resolves.toEqual({ kind: "none" });
      expect(mocks.lockSupplementaryInvoiceAnchor).toHaveBeenCalledWith(store, "booking-1");
      expect(mocks.enqueueAdditionalCaptureReceiptOperation).not.toHaveBeenCalled();
      expect(mocks.enqueueXeroKeptLateCaptureInvoiceOperation).not.toHaveBeenCalled();
    });

    it("MUTATION review F3: the change's invoice moved onto a carrier and released there - the kept invoice, never a receipt on the primary", async () => {
      mocks.operationFindMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ status: "SUCCEEDED", requestPayload: { paymentIntentId: "pi_carrier", parkedFromPaymentIntentId: "pi_late" } }])
        .mockResolvedValue([]);
      await expect(plan()).resolves.toEqual({ kind: "kept-invoice-queued", queueOperationId: "op_kept" });
      expect(mocks.enqueueXeroKeptLateCaptureInvoiceOperation).toHaveBeenCalledWith(expect.objectContaining({ capturedCents: 8000, paymentIntentId: "pi_late" }));
      expect(mocks.enqueueAdditionalCaptureReceiptOperation).not.toHaveBeenCalled();
    });

    it("MUTATION (INV-PAY-139): returns the capture's receipt already queued, whatever the evidence says now", async () => {
      mocks.operationFindFirst.mockResolvedValue({ id: "op_receipt_existing" });
      mocks.operationFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ status: "CANCELLED", requestPayload: {} }]);
      await expect(plan()).resolves.toEqual({ kind: "receipt-queued", queueOperationId: "op_receipt_existing" });
      expect(mocks.operationFindFirst).toHaveBeenCalledWith({
        where: { correlationKey: "receipt-key:pi_late", status: { not: "CANCELLED" } },
        select: { id: true },
      });
      expect(mocks.enqueueXeroKeptLateCaptureInvoiceOperation).not.toHaveBeenCalled();
    });

    it("a re-kept capture gets a new receipt for its issued unpaid invoice", async () => {
      mocks.operationFindMany.mockResolvedValue([
        { status: "SUCCEEDED", lastErrorCode: null, requestPayload: { paymentIntentId: "pi_late", recordPayment: false } },
      ]);
      await expect(plan()).resolves.toEqual({ kind: "receipt-queued", queueOperationId: "op_receipt" });
      expect(mocks.enqueueAdditionalCaptureReceiptOperation).toHaveBeenCalledWith("pi_late", expect.objectContaining({ store, keptLateCapture: true }));
      expect(mocks.enqueueXeroKeptLateCaptureInvoiceOperation).not.toHaveBeenCalled();
    });

    it("MUTATION (INV-PAY-139): returns the capture's kept invoice already queued, never a receipt beside it", async () => {
      mocks.findLiveKeptReceiptRow.mockResolvedValue({ id: "op_kept" });
      mocks.modificationFindUnique.mockResolvedValue({
        newData: { primaryInvoiceSettlement: { settledAgainstPrimaryInvoice: true } },
      });
      await expect(plan()).resolves.toEqual({ kind: "kept-invoice-queued", queueOperationId: "op_kept" });
      expect(mocks.enqueueAdditionalCaptureReceiptOperation).not.toHaveBeenCalled();
    });

    describe("MUTATION (#4253 credit-release sweep, review M-F1/M-F2): its share of the capture is never recorded twice", () => {
      const withdrawn = () =>
        mocks.operationFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ status: "CANCELLED", requestPayload: {} }]);
      const unknownChange = () =>
        mocks.transactionFindUnique.mockResolvedValue({
          kind: "ADDITIONAL",
          status: "SUCCEEDED",
          amountCents: 8000,
          paymentId: "payment-1",
          bookingModificationId: null,
          reason: null,
        });

      it("kept-invoice route: the kept invoice records only the part the sweep does not", async () => {
        withdrawn();
        mocks.readCreditReleaseCaptureShare.mockResolvedValue({ ownCents: 5000, held: false });
        await expect(plan()).resolves.toEqual({ kind: "kept-invoice-queued", queueOperationId: "op_kept" });
        expect(mocks.readCreditReleaseCaptureShare).toHaveBeenCalledWith("pi_late", store);
        expect(mocks.enqueueXeroKeptLateCaptureInvoiceOperation).toHaveBeenCalledWith(
          expect.objectContaining({ capturedCents: 3000, paymentIntentId: "pi_late" }),
        );
      });

      it("kept-invoice route: nothing where the sweep records all of it, or holds it for an officer", async () => {
        withdrawn();
        mocks.readCreditReleaseCaptureShare.mockResolvedValue({ ownCents: 8000, held: false });
        await expect(plan()).resolves.toEqual({ kind: "none" });
        withdrawn();
        mocks.readCreditReleaseCaptureShare.mockResolvedValue({ ownCents: 0, held: true });
        await expect(plan()).resolves.toEqual({ kind: "none" });
        expect(mocks.enqueueXeroKeptLateCaptureInvoiceOperation).not.toHaveBeenCalled();
      });

      it("change-unknown: a capture the sweep records or holds is logged at info, never as unrecorded", async () => {
        unknownChange();
        mocks.readCreditReleaseCaptureShare.mockResolvedValue({ ownCents: 8000, held: false });
        await expect(plan()).resolves.toEqual({ kind: "none" });
        unknownChange();
        mocks.readCreditReleaseCaptureShare.mockResolvedValue({ ownCents: 0, held: true });
        await expect(plan()).resolves.toEqual({ kind: "none" });
        expect(logger.error).not.toHaveBeenCalled();
        expect(logger.info).toHaveBeenCalledTimes(2);
      });

      it("change-unknown: one nothing records is an error", async () => {
        unknownChange();
        await expect(plan()).resolves.toEqual({ kind: "none" });
        expect(logger.error).toHaveBeenCalledTimes(1);
      });
    });

    describe("MUTATION review MF2 (round 3, `INV-SSOT`): the kept invoice is sized by the one reading of who records the capture (`readCaptureRecorder`)", () => {
      const withdrawn = () =>
        mocks.operationFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ status: "CANCELLED", requestPayload: {} }]);
      /** Answers `readCaptureRecorder`'s reads: a kept-capture invoice naming the intent, or a gap invoice covering part of it. */
      const recorderRows = (rows: { kept?: boolean; gapCoveredCents?: number }) =>
        mocks.operationFindFirst.mockImplementation(async ({ where }: { where?: Record<string, any> } = {}) => {
          if (where?.queueType === "KEPT_LATE_CAPTURE_INVOICE" && rows.kept) return { id: "op_kept_other" };
          if (where?.requestPayload?.path?.[0] === "coveredPaymentIntentIds" && rows.gapCoveredCents !== undefined) {
            return {
              id: "op_gap",
              requestPayload: { coveredPaymentIntentIds: ["pi_late"], coveredCaptureCents: { pi_late: rows.gapCoveredCents } },
            };
          }
          return null;
        });

      it("a gap invoice's payment took part of it: the kept invoice records only the rest", async () => {
        withdrawn();
        recorderRows({ gapCoveredCents: 2000 });
        await expect(plan()).resolves.toEqual({ kind: "kept-invoice-queued", queueOperationId: "op_kept" });
        expect(mocks.enqueueXeroKeptLateCaptureInvoiceOperation).toHaveBeenCalledWith(
          expect.objectContaining({ capturedCents: 6000, paymentIntentId: "pi_late" }),
        );
      });

      it("the gap's part and the sweep's share together: one figure, never either twice", async () => {
        withdrawn();
        recorderRows({ gapCoveredCents: 2000 });
        mocks.readCreditReleaseCaptureShare.mockResolvedValue({ ownCents: 1000, held: false });
        await plan();
        expect(mocks.enqueueXeroKeptLateCaptureInvoiceOperation).toHaveBeenCalledWith(expect.objectContaining({ capturedCents: 5000 }));
      });

      it("another kept-capture invoice already records it: nothing more", async () => {
        withdrawn();
        recorderRows({ kept: true });
        await expect(plan()).resolves.toEqual({ kind: "none" });
        expect(mocks.enqueueXeroKeptLateCaptureInvoiceOperation).not.toHaveBeenCalled();
      });

      it("without the primary invoice's id (an active link only): the sweep's share and a kept invoice naming it are what is read", async () => {
        mocks.paymentFindUnique.mockResolvedValue({ xeroInvoiceId: null });
        mocks.linkFindMany.mockResolvedValue([{ role: "PRIMARY_INVOICE", xeroObjectType: "INVOICE", active: true }]);
        withdrawn();
        mocks.readCreditReleaseCaptureShare.mockResolvedValue({ ownCents: 5000, held: false });
        await expect(plan()).resolves.toEqual({ kind: "kept-invoice-queued", queueOperationId: "op_kept" });
        expect(mocks.enqueueXeroKeptLateCaptureInvoiceOperation).toHaveBeenCalledWith(expect.objectContaining({ capturedCents: 3000 }));
        withdrawn();
        recorderRows({ kept: true });
        await expect(plan()).resolves.toEqual({ kind: "none" });
        expect(mocks.enqueueXeroKeptLateCaptureInvoiceOperation).toHaveBeenCalledTimes(1);
      });

      it("MUTATION review A-UNSYNCED-KEEP: the field drifted to null beside an active link - the link's id runs the full reading", async () => {
        mocks.paymentFindUnique.mockResolvedValue({ xeroInvoiceId: null });
        mocks.linkFindMany.mockResolvedValue([
          { role: "PRIMARY_INVOICE", xeroObjectType: "INVOICE", active: true, xeroObjectId: "inv_primary_link" },
        ]);
        expect(mocks.linkFindMany.mock.calls).toEqual([]);
        withdrawn();
        recorderRows({ gapCoveredCents: 2000 });
        await expect(plan()).resolves.toEqual({ kind: "kept-invoice-queued", queueOperationId: "op_kept" });
        expect(mocks.linkFindMany.mock.calls[0]![0]).toMatchObject({ select: { xeroObjectId: true } });
        expect(mocks.enqueueXeroKeptLateCaptureInvoiceOperation).toHaveBeenCalledWith(expect.objectContaining({ capturedCents: 6000 }));
      });
    });

    it("review D-F3: a receipt refused for no primary invoice id is logged as an error, not a warning", async () => {
      mocks.modificationFindUnique.mockResolvedValue({
        newData: { primaryInvoiceSettlement: { settledAgainstPrimaryInvoice: true } },
      });
      mocks.enqueueAdditionalCaptureReceiptOperation.mockResolvedValue({ outcome: "not-eligible", reason: "no-primary-invoice" });
      await expect(plan()).resolves.toEqual({ kind: "none" });
      expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ reason: "no-primary-invoice" }), expect.any(String));
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("records nothing where the receipt's enqueue finds another document records it", async () => {
      mocks.enqueueAdditionalCaptureReceiptOperation.mockResolvedValue({
        outcome: "not-eligible",
        reason: "recorded-by-supplementary-invoice",
      });
      await expect(plan()).resolves.toEqual({ kind: "none" });
      expect(mocks.enqueueXeroKeptLateCaptureInvoiceOperation).not.toHaveBeenCalled();
    });
  });
});

describe("finishKeptLateCaptureXeroRecord", () => {
  it("releases a kept change payment's invoice, credits back any refund already taken, and kicks the outbox", async () => {
    await finishKeptLateCaptureXeroRecord({ kind: "change-payment", paymentIntentId: "pi_late" });
    expect(mocks.releaseXeroSupplementaryInvoiceForCapturedPaymentIntent).toHaveBeenCalledWith("pi_late");
    expect(mocks.creditBackLateCaptureRefunds).toHaveBeenCalledWith("pi_late");
    expect(mocks.kickQueuedXeroOutboxOperationsIfConnected).toHaveBeenCalledTimes(1);
  });

  it("#4324: kicks the outbox for a queued receipt, releasing nothing", async () => {
    await finishKeptLateCaptureXeroRecord({ kind: "receipt-queued", queueOperationId: "op_receipt" });
    expect(mocks.kickQueuedXeroOutboxOperationsIfConnected).toHaveBeenCalledTimes(1);
    expect(mocks.releaseXeroSupplementaryInvoiceForCapturedPaymentIntent).not.toHaveBeenCalled();
  });

  it("kicks the outbox for a queued kept invoice", async () => {
    await finishKeptLateCaptureXeroRecord({ kind: "kept-invoice-queued", queueOperationId: "op_kept" });
    expect(mocks.kickQueuedXeroOutboxOperationsIfConnected).toHaveBeenCalledTimes(1);
  });

  it("never throws: the decision has already committed", async () => {
    mocks.releaseXeroSupplementaryInvoiceForCapturedPaymentIntent.mockRejectedValue(new Error("db down"));
    await expect(
      finishKeptLateCaptureXeroRecord({ kind: "change-payment", paymentIntentId: "pi_late" }),
    ).resolves.toBeUndefined();
  });
});

describe("a waiting unpaid change invoice's kept capture", () => {
  for (const outcome of ["alerted", "already-alerted", "left-retired", "awaiting-decision", "none-queued"]) {
    it(`a release answering ${outcome} preserves manual attention without a receipt on the primary`, async () => {
      mocks.releaseXeroSupplementaryInvoiceForCapturedPaymentIntent.mockResolvedValue({ outcome, released: 0, queueOperationIds: [] });
      await finishKeptLateCaptureXeroRecord({ kind: "change-payment", paymentIntentId: "pi_late" });
      expect(mocks.enqueueAdditionalCaptureReceiptOperation).not.toHaveBeenCalled();
      expect(mocks.kickQueuedXeroOutboxOperationsIfConnected).not.toHaveBeenCalled();
    });
  }

  it("releases the invoice, queues its receipt through the recorder, then credits earlier refunds", async () => {
    await finishKeptLateCaptureXeroRecord({ kind: "change-payment", paymentIntentId: "pi_late" });
    expect(mocks.enqueueAdditionalCaptureReceiptOperation).toHaveBeenCalledWith("pi_late", { keptLateCapture: true, requireUnpaidChangeInvoice: true });
    expect(mocks.releaseXeroSupplementaryInvoiceForCapturedPaymentIntent.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.enqueueAdditionalCaptureReceiptOperation.mock.invocationCallOrder[0]!);
    expect(mocks.enqueueAdditionalCaptureReceiptOperation.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.creditBackLateCaptureRefunds.mock.invocationCallOrder[0]!);
  });
});
