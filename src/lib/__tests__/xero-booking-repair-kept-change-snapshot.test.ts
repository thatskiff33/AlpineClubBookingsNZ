/**
 * #4381 (lane re-review of #5534): what the repair tool does with the kept
 * change capture's snapshot (`loadKeptChangeCaptureEvidence`) - a live
 * kept-capture invoice is that invoice's record, a receipt row that stood down
 * for another writer is not live, and a close the credit-release sweep holds
 * is named as waiting for its note, never to record by hand. Direct calls of
 * each consumer, so each flag is pinned on its own.
 */
import { describe, expect, it } from "vitest";
import { XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE } from "@/lib/additional-capture-receipt-payload";
import { addKeptChangeCaptureFinding, keptChangeCaptureQueuesKeptInvoice } from "@/lib/xero-booking-repair-additional-capture";
import type { KeptChangeCaptureRepairEvidence } from "@/lib/xero-booking-repair-kept-change-evidence";
import { addPaidAnotherWayReceiptFinding, closedChangeCapture } from "@/lib/xero-booking-repair-paid-another-way";
import type { XeroOperationRecord } from "@/lib/xero-booking-repair-types";

const PAYMENT = { id: "payment_1", source: "STRIPE", xeroInvoiceId: "inv_primary" };
const TRANSACTION = { stripePaymentIntentId: "pi_kept", status: "SUCCEEDED" as const, amountCents: 8000 };

const evidence = (over: Partial<KeptChangeCaptureRepairEvidence> = {}): KeptChangeCaptureRepairEvidence => ({
  changeId: "mod_change",
  route: "receipt",
  liveKeptInvoice: false,
  receiptOperations: [],
  receiptLinked: false,
  receiptLinks: [],
  receiptStoodDown: false,
  recordedElsewhere: false,
  creditReleaseSweep: false,
  alreadyRecordedCents: 0,
  primaryInvoiceIdSynced: true,
  ...over,
});

/** A receipt row that finished with nothing sent: stood down for another writer, or not. */
const finishedReceipt = {
  id: "op_receipt",
  localModel: "PaymentTransaction",
  localId: "txn_kept",
  status: "SUCCEEDED",
  queueType: XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE,
  requestPayload: { queueType: XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE, paymentIntentId: "pi_kept" },
  responsePayload: { skipped: "recorded-by-primary-invoice" },
} as unknown as XeroOperationRecord;

type Finding = { code: string; severity: string; summary: string; details: Record<string, unknown> };

function keptFindings(found: KeptChangeCaptureRepairEvidence): Finding[] {
  const findings: Finding[] = [];
  addKeptChangeCaptureFinding({
    findings: findings as never,
    actionMap: new Map(),
    booking: { id: "booking_1" },
    payment: PAYMENT,
    transaction: TRANSACTION,
    kept: { taskId: "task_kept" },
    found,
  });
  return findings;
}

function closeFindings(found: KeptChangeCaptureRepairEvidence): Finding[] {
  const findings: Finding[] = [];
  addPaidAnotherWayReceiptFinding({
    findings: findings as never,
    actionMap: new Map(),
    booking: { id: "booking_1", status: "CANCELLED" },
    paymentId: "payment_1",
    transaction: TRANSACTION,
    lateTask: {
      taskId: "task_kept",
      status: "COMPLETED",
      operations: [],
      paidAnotherWayClose: {
        xeroRefundNote: "after-receipt",
        raisedAt: new Date("2026-06-01T00:00:00.000Z"),
        receiptState: {
          receipt: { kind: "none" },
          close: { id: "close_1", amountCents: 6000 },
          noteAsked: false,
          invoiceLinked: false,
          paymentLinked: false,
          recordByHandCents: 0,
          cardNoteMayBeInXeroCents: 0,
        },
        paidBackLabel: "$60.00",
      },
    } as never,
    keptInvoice: null,
    changeCapture: { payment: PAYMENT, found },
  });
  return findings;
}

const codes = (findings: Finding[]) => findings.map((finding) => finding.code);

describe("a live kept-capture invoice (`liveKeptInvoice`) is that invoice's record", () => {
  it("MUTATION: the keep's finding names nothing; control: without it, the unrecorded capture is named", () => {
    expect(keptFindings(evidence({ liveKeptInvoice: true }))).toEqual([]);
    expect(codes(keptFindings(evidence()))).toEqual(["KEPT_LATE_CAPTURE_NOT_RECORDED_IN_XERO"]);
  });

  it("MUTATION: no second kept-capture invoice is queued for a change it bills", () => {
    const routed = { route: "kept-invoice" as const };
    expect(keptChangeCaptureQueuesKeptInvoice(evidence({ ...routed, liveKeptInvoice: true }), TRANSACTION)).toBe(false);
    expect(keptChangeCaptureQueuesKeptInvoice(evidence(routed), TRANSACTION)).toBe(true);
  });

  it("MUTATION: a paid-another-way close is not split by the change's evidence", () => {
    const context = (found: KeptChangeCaptureRepairEvidence) => ({ keptChangeCaptures: new Map([["pi_kept", found]]) });
    const transaction = { kind: "ADDITIONAL" as const, stripePaymentIntentId: "pi_kept" };
    expect(closedChangeCapture(context(evidence({ liveKeptInvoice: true })), PAYMENT, [], transaction)).toBeUndefined();
    expect(closedChangeCapture(context(evidence()), PAYMENT, [], transaction)).toMatchObject({ payment: PAYMENT });
  });
});

describe("a receipt row that stood down for another writer (`receiptStoodDown`) is not live", () => {
  const stoodDown = (over: Partial<KeptChangeCaptureRepairEvidence> = {}) =>
    evidence({ receiptOperations: [finishedReceipt], receiptStoodDown: true, ...over });

  it("MUTATION: the close with no note is named to record by hand; control: a live row of its own is the close's receipt", () => {
    expect(closeFindings(stoodDown())).toEqual([
      expect.objectContaining({
        code: "PAID_ANOTHER_WAY_REFUND_NOTE_RECORD_BY_HAND",
        details: expect.objectContaining({ noRefundNote: "recorded-elsewhere", recordByHandCents: 6000 }),
      }),
    ]);
    expect(codes(closeFindings(evidence({ receiptOperations: [finishedReceipt] })))).not.toContain(
      "PAID_ANOTHER_WAY_REFUND_NOTE_RECORD_BY_HAND",
    );
  });

  it("MUTATION: held by the credit-release sweep - named as waiting for its note, never to record by hand", () => {
    const findings = closeFindings(stoodDown({ creditReleaseSweep: true }));
    expect(findings).toEqual([
      expect.objectContaining({
        code: "PAID_ANOTHER_WAY_REFUND_NOTE_AWAITS_CREDIT_RELEASE",
        severity: "info",
        details: expect.objectContaining({ noRefundNote: "credit-release-sweep", closeAmountCents: 6000 }),
      }),
    ]);
    expect(findings[0].summary).toContain("Do not record it by hand in Xero, or it would be credited twice.");
    expect(findings[0].details).not.toHaveProperty("recordByHandCents");
  });
});
