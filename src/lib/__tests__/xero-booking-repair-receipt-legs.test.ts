/**
 * #4434 (`INV-PAY-139`): the repair tool's part-sent split receipt flag. A
 * receipt row that stored a multi-leg plan and linked only some legs is named
 * for an officer once no worker will send the rest (the row SUCCEEDED, for
 * example an older release completing it on one link during the deploy
 * window, or was CANCELLED). A row still in the worker's hands takes the
 * ordinary retry path: the worker resends only unlinked legs. A plan with no
 * leg linked is left to the existing unrecorded, retry and refused paths, so
 * one capture never gets two findings.
 */
import { describe, expect, it } from "vitest";
import {
  addKeptChangeCaptureFinding,
  addUnrecordedAdditionalCaptureFindings,
  type AdditionalCaptureReceiptEvidence,
  type KeptChangeCaptureRepairEvidence,
} from "@/lib/xero-booking-repair-additional-capture";
import { XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE } from "@/lib/additional-capture-receipt-payload";
import type { XeroOperationRecord } from "@/lib/xero-booking-repair-types";

// One capture of 9000 cents, planned across two invoices.
const CAPTURE_ID = "ptx_capture";
const plan = {
  target: "GAP_INVOICE",
  invoiceId: "inv_gap",
  amountCents: 5000,
  capturedCents: 9000,
  date: "2026-07-01",
  legs: [
    { target: "GAP_INVOICE", invoiceId: "inv_gap", amountCents: 5000 },
    { target: "PRIMARY_INVOICE", invoiceId: "inv_primary", amountCents: 4000 },
  ],
  targetInvoiceIds: ["inv_gap", "inv_primary"],
};

function receiptRow(status: string, overrides: Partial<XeroOperationRecord> = {}): XeroOperationRecord {
  return {
    id: `op_${status.toLowerCase()}`,
    direction: "OUTBOUND",
    entityType: "PAYMENT",
    operationType: "CREATE",
    localModel: "PaymentTransaction",
    localId: CAPTURE_ID,
    status,
    idempotencyKey: "receipt-key",
    correlationKey: null,
    queueType: XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE,
    lastErrorCode: status === "FAILED" ? "XERO_SERVER_ERROR" : null,
    lastErrorMessage: status === "FAILED" ? "Xero returned 503" : null,
    requestPayload: {
      queueType: XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE,
      bookingId: "booking_1",
      paymentId: "payment_1",
      paymentTransactionId: CAPTURE_ID,
      paymentIntentId: "pi_change",
      plan,
    },
    responsePayload: null,
    xeroObjectType: null,
    xeroObjectId: null,
    xeroObjectNumber: null,
    xeroObjectUrl: null,
    createdByMemberId: null,
    startedAt: null,
    completedAt: null,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    replayable: true,
    manuallyResolvedAt: null,
    manuallyResolvedReason: null,
    ...overrides,
  } as XeroOperationRecord;
}

const link = (invoiceId: string, leg: number) => ({ metadata: { invoiceId, leg } });

type Finding = { code: string; severity: string; summary: string; safeToAutoApply: boolean };

function changeCaptureFindings(operations: XeroOperationRecord[], links: { metadata: unknown }[]): Finding[] {
  const findings: Finding[] = [];
  const evidence: AdditionalCaptureReceiptEvidence = {
    operationsByTransactionId: new Map([[CAPTURE_ID, operations]]),
    recordedTransactionIds: new Set(links.length > 0 ? [CAPTURE_ID] : []),
    linksByTransactionId: new Map([[CAPTURE_ID, links]]),
    recordedElsewhereIntentIds: new Set(),
    primaryCoverageKnown: true,
    receiptModificationIds: new Set(),
  } as unknown as AdditionalCaptureReceiptEvidence;
  addUnrecordedAdditionalCaptureFindings({
    findings: findings as never,
    actionMap: new Map(),
    booking: { id: "booking_1", status: "CONFIRMED" },
    paymentId: "payment_1",
    captures: [{ id: CAPTURE_ID, kind: "ADDITIONAL", stripePaymentIntentId: "pi_change", amountCents: 9000 }],
    evidence,
  });
  return findings;
}

function keptCaptureFindings(operations: XeroOperationRecord[], links: { metadata: unknown }[]): Finding[] {
  const findings: Finding[] = [];
  const found: KeptChangeCaptureRepairEvidence = {
    evidence: { answeredByChangeInvoice: false, changeId: "mod_change", settledAgainstPrimary: false, changeInvoices: "none", billedByGapInvoice: true, primaryMissedChange: false },
    route: "receipt",
    receiptOperations: operations,
    receiptLinked: links.length > 0,
    receiptLinks: links,
    recordedElsewhere: false,
    alreadyRecordedCents: 0,
    primaryInvoiceIdSynced: true,
  } as unknown as KeptChangeCaptureRepairEvidence;
  addKeptChangeCaptureFinding({
    findings: findings as never,
    actionMap: new Map(),
    booking: { id: "booking_1" },
    payment: { id: "payment_1", source: "STRIPE", xeroInvoiceId: "inv_primary" },
    transaction: { stripePaymentIntentId: "pi_change", status: "SUCCEEDED", amountCents: 9000 },
    kept: { taskId: "task_kept" },
    found,
  });
  return findings;
}

describe.each([
  ["a change capture", changeCaptureFindings, "ADDITIONAL_CAPTURE_NOT_RECORDED_IN_XERO"],
  ["a kept change capture", keptCaptureFindings, "KEPT_LATE_CAPTURE_NOT_RECORDED_IN_XERO"],
] as const)("repair: a part-sent split receipt on %s", (_label, run, code) => {
  it("MUTATION: a finished row with 2 legs planned and 1 linked is named once for an officer", () => {
    expect(run([receiptRow("SUCCEEDED")], [link("inv_gap", 0)])).toEqual([
      expect.objectContaining({ code, severity: "manual_review", summary: "receipt planned 2 legs, 1 linked", safeToAutoApply: false }),
    ]);
  });

  it("MUTATION: a withdrawn row with a leg unsent is named for an officer too", () => {
    expect(run([receiptRow("CANCELLED")], [link("inv_gap", 0)])).toEqual([
      expect.objectContaining({ code, summary: "receipt planned 2 legs, 1 linked" }),
    ]);
  });

  it("control: both legs linked raises nothing", () => {
    expect(run([receiptRow("SUCCEEDED")], [link("inv_gap", 0), link("inv_primary", 1)])).toEqual([]);
  });

  it("MUTATION review finding 2: a retryable failed row part-sent is offered its retry, not only an officer's review", () => {
    const findings = run([receiptRow("FAILED")], [link("inv_gap", 0)]);
    expect(findings).toEqual([expect.objectContaining({ code: "BLOCKED_BY_XERO_OPERATION", severity: "warning" })]);
    expect(findings.some((finding) => finding.summary.startsWith("receipt planned"))).toBe(false);
  });

  it("MUTATION review finding 2: a row the worker is still sending raises nothing", () => {
    expect(run([receiptRow("RUNNING")], [link("inv_gap", 0)])).toEqual([]);
    expect(run([receiptRow("PENDING")], [link("inv_gap", 0)])).toEqual([]);
  });

  it("MUTATION review finding 2: no leg linked is not part-sent, so a failed row gets one retry finding and no split finding", () => {
    const findings = run([receiptRow("FAILED")], []);
    expect(findings).toEqual([expect.objectContaining({ code: "BLOCKED_BY_XERO_OPERATION" })]);
  });

  it("MUTATION: a finished row with no leg linked keeps its existing reading and raises no split finding", () => {
    expect(run([receiptRow("SUCCEEDED")], []).some((finding) => finding.summary.startsWith("receipt planned"))).toBe(false);
  });
});
