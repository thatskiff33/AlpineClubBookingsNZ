import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #3635 round-3 R1 (`INV-PAY-110`): the cash a refund credit note may answer is
 * the payment's cash refund evidence LESS the refunds of late captures the app
 * never recorded in Xero - the one figure the enqueue, the executor, the
 * self-heal's gap reader and the hardening report all read.
 */
const state = vi.hoisted(() => ({
  refunds: [] as Array<{ paymentId: string; stripePaymentIntentId: string | null; amountCents: number; status: string }>,
  tasks: [] as Array<{ id: string; lateCaptureApprovalIntentId: string | null; reason: string | null }>,
  keptLinks: [] as Array<{ localId: string; xeroObjectId: string }>,
  resolvedKept: [] as string[],
  supplementary: [] as Array<{ paymentIntentId: string; status: string; xeroObjectId: string | null }>,
  /** #4170: captures the primary late-capture handler marked as its own write. */
  markedIntents: [] as string[],
  /** #4170: intents a cancel claim (`CANCEL_PAYMENT_INTENT` recovery) names. */
  cancelClaims: [] as string[],
  bookingStatus: "CANCELLED",
  /** #4383: the capture's gross, and its own receipt's stored plan and payment link. */
  captureCents: 24000,
  ownReceipt: null as null | { legs: number[]; capturedCents: number; linked: boolean },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    paymentRefund: {
      groupBy: async ({ where }: { where: { paymentId: string } }) => {
        const byStatus = new Map<string, { sum: number; count: number }>();
        for (const row of state.refunds.filter((r) => r.paymentId === where.paymentId)) {
          const bucket = byStatus.get(row.status) ?? { sum: 0, count: 0 };
          bucket.sum += row.amountCents;
          bucket.count += 1;
          byStatus.set(row.status, bucket);
        }
        return [...byStatus].map(([status, b]) => ({ status, _sum: { amountCents: b.sum }, _count: { _all: b.count } }));
      },
      findMany: async ({ where }: { where: { paymentId: string } }) =>
        state.refunds.filter((r) => r.paymentId === where.paymentId && r.stripePaymentIntentId),
    },
    memberCredit: { aggregate: async () => ({ _sum: { amountCents: 0 } }) },
    payment: { findUnique: async () => ({ booking: { status: state.bookingStatus } }) },
    paymentTransaction: {
      findUnique: async () => ({ amountCents: state.captureCents }),
      findMany: async ({ where }: { where: { stripePaymentIntentId: { in: string[] } } }) =>
        where.stripePaymentIntentId.in.map((intent) => ({
          stripePaymentIntentId: intent,
          reason: state.markedIntents.includes(intent) ? "cancelled_booking_late_capture" : null,
        })),
    },
    paymentRecoveryOperation: {
      findMany: async ({ where }: { where: { paymentIntentId: string | { in: string[] } } }) => {
        const asked = typeof where.paymentIntentId === "string" ? [where.paymentIntentId] : where.paymentIntentId.in;
        return state.cancelClaims.filter((intent) => asked.includes(intent)).map((paymentIntentId) => ({ paymentIntentId }));
      },
    },
    manualRefundTask: {
      // #3924 round 4: the cash evidence's paid-another-way read (on the payment, by key prefix; #4097,
      // with a paid-back card refund shortfall beside it) finds none here.
      findMany: async ({ where }: { where: { paymentId?: string; OR: [{ lateCaptureApprovalIntentId: { in: string[] } }, { reason: { in: string[] } }] } }) =>
        where.paymentId !== undefined ? [] :
        state.tasks.filter(
          (t) =>
            (t.lateCaptureApprovalIntentId && where.OR[0].lateCaptureApprovalIntentId.in.includes(t.lateCaptureApprovalIntentId)) ||
            (t.reason && where.OR[1].reason.in.includes(t.reason)),
        ),
      findUnique: async ({ where }: { where: { lateCaptureApprovalIntentId: string } }) =>
        state.tasks.find((t) => t.lateCaptureApprovalIntentId === where.lateCaptureApprovalIntentId) ?? null,
    },
    xeroObjectLink: {
      // #3924 round 10: a change's own invoice link is asked too; none here.
      findFirst: async ({ where }: { where: { localId: string; role?: string } }) =>
        where.role === "SUPPLEMENTARY_INVOICE"
          ? null
          : where.role === "ADDITIONAL_CAPTURE_PAYMENT"
            ? state.ownReceipt?.linked
              ? { metadata: { invoiceId: "inv_primary" } }
              : null
            : (state.keptLinks.find((l) => l.localId === where.localId) ?? null),
    },
    xeroSyncOperation: {
      // Round 10: the kept receipt's resolved rows are read with their invoice id.
      findMany: async ({ where }: { where: { queueType?: string; localId?: string; requestPayload?: { equals: string } } }) =>
        where.queueType === "ADDITIONAL_CAPTURE_RECEIPT"
          ? ownReceiptRows()
          : where.queueType === "KEPT_LATE_CAPTURE_INVOICE"
          ? state.resolvedKept.filter((id) => id === where.localId).map(() => ({ xeroObjectId: null }))
          : state.supplementary
              .filter((row) => row.paymentIntentId === where.requestPayload?.equals)
              .map((row) => ({ ...row, manuallyResolvedAt: null })),
    },
  },
}));

import { resolveRefundNoteEligibleCash } from "@/lib/refund-note-eligible-cash";

/** #4383: the capture's own receipt row, its plan stored before the Xero call. */
function ownReceiptRows() {
  const receipt = state.ownReceipt;
  if (!receipt) return [];
  const legs = receipt.legs.map((amountCents, index) => ({ target: "PRIMARY_INVOICE", invoiceId: `inv_${index}`, amountCents }));
  return [
    {
      localId: "ptx_late",
      status: receipt.linked ? "SUCCEEDED" : "RUNNING",
      manuallyResolvedAt: null,
      responsePayload: null,
      requestPayload: {
        queueType: "ADDITIONAL_CAPTURE_RECEIPT",
        bookingId: "booking_1",
        paymentId: "payment_1",
        paymentTransactionId: "ptx_late",
        paymentIntentId: "pi_late",
        plan: { ...legs[0], capturedCents: receipt.capturedCents, date: "2026-06-20", legs },
      },
    },
  ];
}
import { cancelledBookingPrimaryPaymentRefundReason } from "@/lib/deleted-booking-modification-payment";

const PAYMENT = { id: "payment_1", bookingId: "booking_1", refundedAmountCents: 34000 };

beforeEach(() => {
  state.refunds = [
    { paymentId: "payment_1", stripePaymentIntentId: "pi_ordinary", amountCents: 10000, status: "succeeded" },
    { paymentId: "payment_1", stripePaymentIntentId: "pi_late", amountCents: 24000, status: "succeeded" },
  ];
  state.tasks = [];
  state.keptLinks = [];
  state.resolvedKept = [];
  state.supplementary = [];
  state.markedIntents = [];
  state.cancelClaims = [];
  state.bookingStatus = "CANCELLED";
  state.captureCents = 24000;
  state.ownReceipt = null;
});

describe("resolveRefundNoteEligibleCash", () => {
  it("is the cash evidence when no refund is of a late capture", async () => {
    await expect(resolveRefundNoteEligibleCash(PAYMENT)).resolves.toMatchObject({
      eligibleCashCents: 34000,
      lateCaptureExcludedCents: 0,
    });
  });

  it("leaves out a refund of a late capture Xero never received, owned by an approval task", async () => {
    state.tasks = [{ id: "task_late", lateCaptureApprovalIntentId: "pi_late", reason: null }];
    await expect(resolveRefundNoteEligibleCash(PAYMENT)).resolves.toMatchObject({
      eligibleCashCents: 10000,
      lateCaptureExcludedCents: 24000,
    });
  });

  it("leaves out a capture the primary late-capture handler marked as its own, before any record row exists (#4170)", async () => {
    state.markedIntents = ["pi_late"];
    await expect(resolveRefundNoteEligibleCash(PAYMENT)).resolves.toMatchObject({
      eligibleCashCents: 10000,
      lateCaptureExcludedCents: 24000,
    });
  });

  it("leaves out a capture a cancel claim names, so a refund made before the late notice is not noted either (#4170)", async () => {
    state.cancelClaims = ["pi_late"];
    await expect(resolveRefundNoteEligibleCash(PAYMENT)).resolves.toMatchObject({
      eligibleCashCents: 10000,
      lateCaptureExcludedCents: 24000,
    });
  });

  it("counts that evidence only on a cancelled booking: a superseded intent's claim on a live booking is no late capture", async () => {
    state.cancelClaims = ["pi_late"];
    state.markedIntents = ["pi_late"];
    state.bookingStatus = "CONFIRMED";
    await expect(resolveRefundNoteEligibleCash(PAYMENT)).resolves.toMatchObject({ eligibleCashCents: 34000 });
  });

  it("leaves out one the webhook refunded automatically, found by its frozen record reason", async () => {
    state.tasks = [
      { id: "task_auto", lateCaptureApprovalIntentId: null, reason: cancelledBookingPrimaryPaymentRefundReason("pi_late") },
    ];
    await expect(resolveRefundNoteEligibleCash(PAYMENT)).resolves.toMatchObject({ eligibleCashCents: 10000 });
  });

  it("counts it once the app recorded the capture's receipt: its kept invoice, or its change's released invoice", async () => {
    state.tasks = [{ id: "task_late", lateCaptureApprovalIntentId: "pi_late", reason: null }];
    state.keptLinks = [{ localId: "task_late", xeroObjectId: "inv_kept" }];
    await expect(resolveRefundNoteEligibleCash(PAYMENT)).resolves.toMatchObject({ eligibleCashCents: 34000 });

    state.keptLinks = [];
    state.supplementary = [{ paymentIntentId: "pi_late", status: "PENDING", xeroObjectId: null }];
    await expect(resolveRefundNoteEligibleCash(PAYMENT)).resolves.toMatchObject({ eligibleCashCents: 34000 });
  });

  it("leaves out a capture whose receipt an officer recorded by hand: its refunds are recorded by hand too", async () => {
    state.tasks = [{ id: "task_late", lateCaptureApprovalIntentId: "pi_late", reason: null }];
    state.resolvedKept = ["task_late"];
    await expect(resolveRefundNoteEligibleCash(PAYMENT)).resolves.toMatchObject({ eligibleCashCents: 10000 });
  });

  it("does not subtract a failed refund of a late capture, which was never cash", async () => {
    state.tasks = [{ id: "task_late", lateCaptureApprovalIntentId: "pi_late", reason: null }];
    state.refunds[1].status = "failed";
    await expect(
      resolveRefundNoteEligibleCash({ ...PAYMENT, refundedAmountCents: 10000 }),
    ).resolves.toMatchObject({ eligibleCashCents: 10000, lateCaptureExcludedCents: 0 });
  });

  describe("#4383: a receipt capped at its invoice's room", () => {
    const refundLate = (amountCents: number) => {
      state.refunds[1].amountCents = amountCents;
      return { ...PAYMENT, refundedAmountCents: 10000 + amountCents };
    };
    beforeEach(() => {
      state.tasks = [{ id: "task_late", lateCaptureApprovalIntentId: "pi_late", reason: null }];
      state.captureCents = 8000;
      state.ownReceipt = { legs: [5000], capturedCents: 8000, linked: true };
    });

    it("MUTATION: an $80 capture recorded as $50 and refunded in full: $50 is eligible, $30 excluded - linked or decided", async () => {
      const payment = refundLate(8000);
      await expect(resolveRefundNoteEligibleCash(payment)).resolves.toMatchObject({
        eligibleCashCents: 15000,
        lateCaptureExcludedCents: 3000,
      });
      state.ownReceipt = { legs: [5000], capturedCents: 8000, linked: false };
      await expect(resolveRefundNoteEligibleCash(payment)).resolves.toMatchObject({
        eligibleCashCents: 15000,
        lateCaptureExcludedCents: 3000,
      });
    });

    it("a $30 refund of it, below what was recorded, is eligible in full", async () => {
      await expect(resolveRefundNoteEligibleCash(refundLate(3000))).resolves.toMatchObject({
        eligibleCashCents: 13000,
        lateCaptureExcludedCents: 0,
      });
    });

    it("an uncapped receipt is unchanged: the whole refund is eligible", async () => {
      state.ownReceipt = { legs: [8000], capturedCents: 8000, linked: true };
      await expect(resolveRefundNoteEligibleCash(refundLate(8000))).resolves.toMatchObject({
        eligibleCashCents: 18000,
        lateCaptureExcludedCents: 0,
      });
    });
  });
});
