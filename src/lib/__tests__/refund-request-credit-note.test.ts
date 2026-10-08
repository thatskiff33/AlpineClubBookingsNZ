/**
 * #3827, owner decision D-3813-8 (#3492, `INV-PAY-118`): a refund request's
 * OWN Xero refund credit note. The pure seams: which task names a request,
 * which payload carries it, the link role its note is recorded under, the
 * retry input that must not re-enter per-delta mode, and the canonical-note
 * finder that must never absorb a cancellation's note into a request's.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import {
  readRefundRequestIdFromPayload,
  REFUND_REQUEST_CREDIT_NOTE_ROLE,
} from "@/lib/refund-request-credit-note";
import {
  refundRequestHandBackOccurrenceKey,
  refundRequestIdOfHandBack,
} from "@/lib/manual-refund-task-settlement-rules";
import { refundCreditNoteCompletion } from "@/lib/xero-refund-note-settlement";
import { parsePaymentCreditNoteRetryInput } from "@/lib/xero-payment-credit-note-payload";
import { readQueuedOutboxPayload } from "@/lib/xero-operation-outbox-payload";
import { findCanonicalPaymentRefundCreditNote } from "@/lib/xero-sync";

describe("which task, and which payload, names a refund request", () => {
  it("reads the request off a refund-request hand-back's key, and nothing else's", () => {
    expect(
      refundRequestIdOfHandBack({ kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: refundRequestHandBackOccurrenceKey("req-1") }),
    ).toBe("req-1");
    expect(refundRequestIdOfHandBack({ kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: "edit-refund-hand-back:mod-1" })).toBeNull();
    expect(refundRequestIdOfHandBack({ kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: null })).toBeNull();
    expect(refundRequestIdOfHandBack({ kind: "EDIT_FINANCIAL_REVIEW", occurrenceKey: "refund-request-hand-back:req-1" })).toBeNull();
  });

  it("reads it off either payload shape's top level", () => {
    expect(readRefundRequestIdFromPayload({ queueType: "REFUND_CREDIT_NOTE", refundRequestId: "req-1" })).toBe("req-1");
    expect(readRefundRequestIdFromPayload({ creditNotes: [], refundRequestId: "req-2" })).toBe("req-2");
    expect(readRefundRequestIdFromPayload({ refundRequestId: "" })).toBeNull();
    expect(readRefundRequestIdFromPayload(null)).toBeNull();
    expect(readRefundRequestIdFromPayload(["req-1"])).toBeNull();
  });

  it("the queued payload keeps it, and its retry never re-enters per-delta mode", () => {
    const queued = { queueType: "REFUND_CREDIT_NOTE", refundAmountCents: 4000, refundMethod: "internet-banking", refundRequestId: "req-1" };
    expect(readQueuedOutboxPayload(queued)).toMatchObject({ refundAmountCents: 4000 });
    const retry = parsePaymentCreditNoteRetryInput({ requestPayload: queued });
    expect(retry).toMatchObject({ amountCents: 4000, kind: "refund", refundRequestId: "req-1" });
    expect(retry).not.toHaveProperty("watermarkCents");
    // An executed payload (the Xero request written over the queued one).
    const executed = parsePaymentCreditNoteRetryInput({
      requestPayload: { creditNotes: [], allocation: { invoiceId: "inv-1", amount: 30 }, refundMethod: "internet-banking", refundRequestId: "req-2" },
    });
    expect(executed).toMatchObject({ amountCents: 3000, refundRequestId: "req-2" });
    // Any other refund note keeps its per-delta watermark.
    expect(parsePaymentCreditNoteRetryInput({ requestPayload: { queueType: "REFUND_CREDIT_NOTE", refundAmountCents: 500 } })).toMatchObject({
      watermarkCents: 0,
    });
  });
});

describe("the link a request's note is recorded under", () => {
  const base = {
    paymentId: "pay-1",
    creditNoteId: "cn-1",
    creditNoteNumber: "CN-1",
    originalInvoiceId: "inv-1",
    refundMethod: "internet-banking" as const,
    outcome: { refundPaymentResponseBody: null, payments: [], refundPaymentErr: null, refundPaymentSkipReason: null },
  };
  function noteLinkRole(completion: ReturnType<typeof refundCreditNoteCompletion>) {
    return completion.extraLinks?.find((link) => link.xeroObjectType === "CREDIT_NOTE")?.role;
  }

  it("a request's note takes its own role, which none of the one-note machinery selects", () => {
    expect(REFUND_REQUEST_CREDIT_NOTE_ROLE).not.toBe("REFUND_CREDIT_NOTE");
    expect(noteLinkRole(refundCreditNoteCompletion({ ...base, refundRequestId: "req-1" }))).toBe(REFUND_REQUEST_CREDIT_NOTE_ROLE);
  });

  it("every other refund note keeps the payment's one refund-note role", () => {
    expect(noteLinkRole(refundCreditNoteCompletion(base))).toBe("REFUND_CREDIT_NOTE");
    expect(noteLinkRole(refundCreditNoteCompletion({ ...base, refundRequestId: null }))).toBe("REFUND_CREDIT_NOTE");
  });
});

describe("the canonical refund note never absorbs a request's note", () => {
  function db(rows: {
    requestNotes?: string[];
    refundNoteLinks?: Array<{ xeroObjectId: string; xeroObjectNumber: string | null }>;
    refundPayments?: Array<{ metadata: unknown }>;
    succeeded?: { xeroObjectId: string; xeroObjectNumber: string | null } | null;
  }) {
    const operationFindFirst = vi.fn(async ({ where }: { where: { xeroObjectId: { notIn?: string[] } } }) => {
      const op = rows.succeeded ?? null;
      if (op && where.xeroObjectId.notIn?.includes(op.xeroObjectId)) return null;
      return op;
    });
    return {
      operationFindFirst,
      store: {
        payment: { findUnique: async () => ({ xeroRefundCreditNoteId: null }) },
        xeroObjectLink: {
          findMany: async ({ where }: { where: { role: string } }) => {
            if (where.role === REFUND_REQUEST_CREDIT_NOTE_ROLE) return (rows.requestNotes ?? []).map((xeroObjectId) => ({ xeroObjectId }));
            if (where.role === "REFUND_CREDIT_NOTE") return rows.refundNoteLinks ?? [];
            if (where.role === "REFUND_PAYMENT") return rows.refundPayments ?? [];
            return [];
          },
        },
        xeroSyncOperation: { findFirst: operationFindFirst },
      },
    };
  }

  it("skips a request note's settling payment and its succeeded operation", async () => {
    const { store } = db({
      requestNotes: ["cn-request"],
      refundPayments: [{ metadata: { creditNoteId: "cn-request" } }],
      succeeded: { xeroObjectId: "cn-request", xeroObjectNumber: "CN-9" },
    });
    await expect(findCanonicalPaymentRefundCreditNote("pay-1", store as never)).resolves.toBeNull();
  });

  it("still finds the payment's own refund note beside a request's", async () => {
    const { store } = db({
      requestNotes: ["cn-request"],
      refundPayments: [{ metadata: { creditNoteId: "cn-request" } }, { metadata: { creditNoteId: "cn-cancel" } }],
    });
    await expect(findCanonicalPaymentRefundCreditNote("pay-1", store as never)).resolves.toMatchObject({
      xeroObjectId: "cn-cancel",
      source: "refund_payment",
    });
  });

  it("with no request notes, the operation fallback is unchanged", async () => {
    const { store, operationFindFirst } = db({ succeeded: { xeroObjectId: "cn-cancel", xeroObjectNumber: "CN-1" } });
    await expect(findCanonicalPaymentRefundCreditNote("pay-1", store as never)).resolves.toMatchObject({
      xeroObjectId: "cn-cancel",
      source: "operation",
    });
    expect(operationFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ xeroObjectId: { not: null } }) }),
    );
  });
});
