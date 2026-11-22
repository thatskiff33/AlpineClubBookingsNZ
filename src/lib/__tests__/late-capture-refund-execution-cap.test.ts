import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #4383 (`INV-PAY-110`, `INV-PAY-139`): THE REFUND NOTE'S EXECUTION-TIME CAP
 * stops at what a capped receipt recorded. A late capture of $80 whose own
 * receipt recorded $50 (its invoice had room for no more) and which was then
 * refunded in full may have a note queued for the whole $80 - by a release
 * before this fix, or by any writer that sized it wider. The real
 * `createXeroCreditNote` sizes it from the real note-eligible cash
 * (`resolveRefundNoteEligibleCash`) over the real receipt verdict
 * (`readLateCaptureXeroReceipt`), so it bills Xero for $50 at most.
 *
 * Storage is in memory and Xero is a seam: the note's line is the first
 * thing built from the sized amount, so it records the amount and stops the
 * run there, before any Xero write.
 */
const state = vi.hoisted(() => ({
  coveredCents: 0,
  plannedLegs: [5000] as number[],
  billed: [] as number[],
  completed: [] as unknown[],
}));

const XERO_REACHED = "the note reached its Xero line";

vi.mock("@/lib/prisma", () => {
  const receiptPayload = () => ({
    queueType: "ADDITIONAL_CAPTURE_RECEIPT",
    bookingId: "booking_1",
    paymentId: "payment_1",
    paymentTransactionId: "ptx_late",
    paymentIntentId: "pi_late",
    plan: {
      target: "PRIMARY_INVOICE",
      invoiceId: "inv_primary",
      amountCents: state.plannedLegs[0],
      capturedCents: 8000,
      date: "2026-06-20",
      legs: state.plannedLegs.map((amountCents) => ({ target: "PRIMARY_INVOICE", invoiceId: "inv_primary", amountCents })),
    },
  });
  return {
    prisma: {
      payment: {
        findUnique: async ({ where }: { where: { id: string } }) => ({
          id: where.id,
          bookingId: "booking_1",
          source: "STRIPE",
          refundedAmountCents: 8000,
          xeroInvoiceId: "inv_primary",
          xeroRefundCreditNoteId: null,
          booking: { id: "booking_1", status: "CANCELLED", checkIn: new Date("2026-08-01"), checkOut: new Date("2026-08-03") },
        }),
      },
      paymentRefund: {
        findMany: async () => [{ stripePaymentIntentId: "pi_late", amountCents: 8000, status: "succeeded" }],
      },
      paymentTransaction: {
        findUnique: async () => ({ amountCents: 8000 }),
      },
      manualRefundTask: {
        findUnique: async () => ({ id: "task_late" }),
        findMany: async () => [{ lateCaptureApprovalIntentId: "pi_late", reason: null, status: "DISMISSED" }],
      },
      xeroObjectLink: {
        // The receipt's payment link on the capture's row; no kept invoice, no change invoice.
        findFirst: async ({ where }: { where: { role?: string } }) =>
          where.role === "ADDITIONAL_CAPTURE_PAYMENT" ? { metadata: { invoiceId: "inv_primary" } } : null,
        findMany: async () => [],
      },
      xeroSyncOperation: {
        findMany: async ({ where }: { where: { queueType?: string } }) =>
          where.queueType === "ADDITIONAL_CAPTURE_RECEIPT"
            ? [{ localId: "ptx_late", status: "SUCCEEDED", manuallyResolvedAt: null, requestPayload: receiptPayload(), responsePayload: null }]
            : [],
      },
    },
  };
});
vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/stripe-cash-refund-evidence", () => ({
  resolveStripeCashRefundEvidence: async () => ({ source: "provider-ledger", cashRefundCents: 8000 }),
}));
// The capture's task row already marks it late; nothing landed after the cancel besides.
vi.mock("@/lib/late-capture-landed-after", () => ({ findCapturesLandedAfterCancellation: async () => new Set() }));
vi.mock("@/lib/xero-refund-note-in-flight", () => ({
  assertNoRefundCreditNoteInFlight: async () => undefined,
  passUnrecordedRefundNoteFence: async () => "open",
}));
vi.mock("@/lib/xero-resolved-in-xero-fences", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/xero-resolved-in-xero-fences")),
  readResolvedRefundCreditNoteCoverage: async () => ({ coveredCents: 0, unreadableOperationIds: [] }),
  sumRefundCreditNoteCoverageCents: async () => state.coveredCents,
}));
vi.mock("@/lib/card-refund-paid-another-way-cash", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/card-refund-paid-another-way-cash")),
  readPaidAnotherWayUncoveredCents: async () => 0,
}));
vi.mock("@/lib/xero-refund-note-status", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/xero-refund-note-status")),
  refundNoteKeyAfterVoidParts: async () => [],
  readCanonicalRefundNoteField: async () => null,
}));
vi.mock("@/lib/xero-sync", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/xero-sync")),
  completeXeroSyncOperation: async (_claim: unknown, outcome: unknown) => {
    state.completed.push(outcome);
  },
}));
vi.mock("@/lib/xero-api-client", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/xero-api-client")),
  getAuthenticatedXeroClient: async () => ({ xero: {}, tenantId: "tenant" }),
}));
vi.mock("@/lib/organisation-xero-contacts", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/organisation-xero-contacts")),
  findOrCreateXeroContactForInvoicedParty: async () => "contact_1",
}));
vi.mock("@/lib/xero-mappings", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/xero-mappings")),
  getResolvedAccountMapping: async () => ({}),
}));
vi.mock("@/lib/xero-tax-anchors", () => ({ resolveXeroTaxRendering: async () => ({}) }));
vi.mock("@/lib/xero-hut-fee-line-codes", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/xero-hut-fee-line-codes")),
  hutFeeRefundLine: (_description: string, amountCents: number) => {
    state.billed.push(amountCents);
    throw new Error(XERO_REACHED);
  },
}));

import { createXeroCreditNote } from "@/lib/xero-credit-notes";

const OVERSIZED_ASK = { refundMethod: "card", paymentIntentId: "pi_late", watermarkCents: 0, documentDate: "2026-06-25" } as const;

beforeEach(() => {
  state.coveredCents = 0;
  state.plannedLegs = [5000];
  state.billed = [];
  state.completed = [];
});

describe("createXeroCreditNote: a late capture's note at execution time (#4383)", () => {
  it("MUTATION: an $80 ask for a capture its receipt recorded as $50 bills Xero for $50", async () => {
    await expect(createXeroCreditNote("payment_1", 8000, OVERSIZED_ASK)).rejects.toThrow(XERO_REACHED);
    expect(state.billed).toEqual([5000]);
  });

  it("MUTATION: once notes cover the $50, the same ask raises nothing", async () => {
    state.coveredCents = 5000;
    await expect(createXeroCreditNote("payment_1", 8000, OVERSIZED_ASK)).resolves.toBe("");
    expect(state.billed).toEqual([]);
  });

  it("an uncapped receipt bills the whole refund, as before", async () => {
    state.plannedLegs = [8000];
    await expect(createXeroCreditNote("payment_1", 8000, OVERSIZED_ASK)).rejects.toThrow(XERO_REACHED);
    expect(state.billed).toEqual([8000]);
  });
});
