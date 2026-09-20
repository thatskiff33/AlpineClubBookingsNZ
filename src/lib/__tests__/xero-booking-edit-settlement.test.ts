import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enqueueXeroBookingInvoiceOperation: vi.fn(),
  enqueueXeroBookingInvoiceUpdateOperation: vi.fn(),
  enqueueXeroModificationAccountCreditNoteOperation: vi.fn(),
  enqueueXeroModificationCreditNoteOperation: vi.fn(),
  enqueueXeroSupplementaryInvoiceOperation: vi.fn(),
  kickQueuedXeroOutboxOperationsIfConnected: vi.fn(),
  recordSkippedXeroBookingInvoiceUpdateOperation: vi.fn(),
}));

vi.mock("@/lib/xero-operation-outbox", () => mocks);

vi.mock("@/lib/logger", () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { wouldQueueCheckInDatedInvoiceUpdate } from "@/lib/xero-booking-edit-conditions";
import {
  classifyXeroBookingEditSettlement,
  queueXeroBookingEditSettlement,
} from "@/lib/xero-booking-edit-settlement";

// #1729 drift contract: the ordinary-edit Xero lock-date guard consults
// wouldQueueCheckInDatedInvoiceUpdate pre-transaction, so the predicate must
// be true EXACTLY when the classifier queues the check-in-dated primary
// invoice date/narration update. Sweep the full input space the decision
// depends on.
describe("wouldQueueCheckInDatedInvoiceUpdate (issue #1729)", () => {
  it("agrees with classifyXeroBookingEditSettlement's queue decision across the whole condition space", () => {
    for (const hasIssuedXeroInvoice of [true, false]) {
      for (const originalPaymentStatus of [
        "PENDING",
        "SUCCEEDED",
        "PARTIALLY_REFUNDED",
        "REFUNDED",
        null,
        undefined,
      ]) {
        for (const datesChanged of [true, false, undefined]) {
          for (const guestIdentityChanged of [true, false, undefined]) {
            const input = {
              hasIssuedXeroInvoice,
              originalPaymentStatus,
              datesChanged,
              guestIdentityChanged,
            };
            const queues =
              classifyXeroBookingEditSettlement({
                ...input,
                priceDiffCents: 0,
              }).primaryInvoiceUpdateAction.type === "queue";
            expect(
              wouldQueueCheckInDatedInvoiceUpdate(input),
              `predicate must match classify for ${JSON.stringify(input)}`,
            ).toBe(queues);
          }
        }
      }
    }
  });
});

describe("classifyXeroBookingEditSettlement", () => {
  it("waits for confirmed additional Stripe payment before supplementary invoice payment recording", () => {
    const decision = classifyXeroBookingEditSettlement({
      hasIssuedXeroInvoice: true,
      originalPaymentStatus: "SUCCEEDED",
      priceDiffCents: 4500,
      changeFeeCents: 500,
      datesChanged: true,
      requiresAdditionalStripePayment: true,
      additionalPaymentIntentId: "pi_additional",
    });

    expect(decision.financialAction).toEqual({
      type: "supplementary-invoice",
      priceDiffCents: 4500,
      changeFeeCents: 500,
      recordPayment: true,
      waitForPaymentIntentId: "pi_additional",
      reason: expect.stringContaining("after the additional Stripe payment succeeds"),
    });
    expect(decision.primaryInvoiceUpdateAction).toEqual({
      type: "skip",
      reason: expect.stringContaining("Skipped primary Xero invoice update"),
    });
  });

  it("creates an unpaid supplementary invoice for invoice-backed unpaid increases", () => {
    const decision = classifyXeroBookingEditSettlement({
      hasIssuedXeroInvoice: true,
      originalPaymentStatus: "PENDING",
      priceDiffCents: 3000,
      datesChanged: false,
    });

    expect(decision.financialAction).toEqual({
      type: "supplementary-invoice",
      priceDiffCents: 3000,
      changeFeeCents: 0,
      recordPayment: false,
      waitForPaymentIntentId: null,
      reason: expect.stringContaining("unpaid supplementary invoice"),
    });
    expect(decision.primaryInvoiceUpdateAction.type).toBe("none");
  });

  // #1356 (F16): a price reduction combined with a larger late-change fee must
  // keep the SIGNED reduction on the supplementary invoice so the components
  // sum to the net the member actually pays (Stripe captures the net).
  it("passes mixed-sign components through signed so they sum to the net charge", () => {
    const decision = classifyXeroBookingEditSettlement({
      hasIssuedXeroInvoice: true,
      originalPaymentStatus: "SUCCEEDED",
      priceDiffCents: -500,
      changeFeeCents: 1000,
      datesChanged: true,
      requiresAdditionalStripePayment: true,
      additionalPaymentIntentId: "pi_mixed",
    });

    expect(decision.xeroNetAmountCents).toBe(500);
    expect(decision.financialAction).toEqual({
      type: "supplementary-invoice",
      priceDiffCents: -500,
      changeFeeCents: 1000,
      recordPayment: true,
      waitForPaymentIntentId: "pi_mixed",
      reason: expect.stringContaining("after the additional Stripe payment succeeds"),
    });
  });

  it("uses modification credit notes for negative deltas", () => {
    const decision = classifyXeroBookingEditSettlement({
      hasIssuedXeroInvoice: true,
      originalPaymentStatus: "SUCCEEDED",
      priceDiffCents: -2500,
      changeFeeCents: 500,
    });

    expect(decision.financialAction).toEqual({
      type: "modification-credit-note",
      refundAmountCents: 2000,
      // `INV-PAY-101`: no method stated and no credit election reads as the
      // card refund every such note was before #3529.
      refundMethod: "card",
      reason: expect.stringContaining("modification credit note"),
    });
  });

  it("carries an explicit bank-transfer refund method onto the modification credit note (INV-PAY-101)", () => {
    const decision = classifyXeroBookingEditSettlement({
      hasIssuedXeroInvoice: true,
      originalPaymentStatus: "SUCCEEDED",
      priceDiffCents: -2500,
      refundMethod: "internet-banking",
    });

    expect(decision.financialAction).toMatchObject({
      type: "modification-credit-note",
      refundAmountCents: 2500,
      refundMethod: "internet-banking",
    });
  });

  it("words a card-elected reduction as a bank transfer when Stripe captured nothing (INV-PAY-101, review of #3537)", () => {
    // An internet-banking-paid booking can be reduced "to card" - the member's
    // choice is money back rather than credit - but no Stripe refund runs
    // (`hasSucceededPayment` is false), so the club returns the money itself.
    const decision = classifyXeroBookingEditSettlement({
      hasIssuedXeroInvoice: true,
      originalPaymentStatus: "SUCCEEDED",
      priceDiffCents: -2500,
      settlementMethod: "card",
      settlementAmountCents: 2500,
      refundedThroughStripe: false,
    });

    expect(decision.financialAction).toMatchObject({
      type: "modification-credit-note",
      refundMethod: "internet-banking",
    });

    // MUTATION: a Stripe-captured payment reduced to card IS a card refund.
    expect(
      classifyXeroBookingEditSettlement({
        hasIssuedXeroInvoice: true,
        originalPaymentStatus: "SUCCEEDED",
        priceDiffCents: -2500,
        settlementMethod: "card",
        settlementAmountCents: 2500,
        refundedThroughStripe: true,
      }).financialAction,
    ).toMatchObject({ refundMethod: "card" });
  });

  it("uses unapplied account-credit notes for credit-settled negative deltas", () => {
    const decision = classifyXeroBookingEditSettlement({
      hasIssuedXeroInvoice: true,
      originalPaymentStatus: "SUCCEEDED",
      priceDiffCents: -5000,
      settlementMethod: "credit",
      settlementAmountCents: 3750,
    });

    expect(decision.financialAction).toEqual({
      type: "modification-account-credit-note",
      refundAmountCents: 3750,
      reason: expect.stringContaining("account credit"),
    });
  });

  it("allows safe primary narration updates for unpaid invoice date-only changes", () => {
    const decision = classifyXeroBookingEditSettlement({
      hasIssuedXeroInvoice: true,
      originalPaymentStatus: "PENDING",
      priceDiffCents: 0,
      datesChanged: true,
    });

    expect(decision.financialAction.type).toBe("none");
    expect(decision.primaryInvoiceUpdateAction).toEqual({
      type: "queue",
      reason: expect.stringContaining("safe primary invoice"),
    });
  });

  it("allows safe primary narration updates for unpaid invoice guest-name changes", () => {
    const decision = classifyXeroBookingEditSettlement({
      hasIssuedXeroInvoice: true,
      originalPaymentStatus: "PENDING",
      priceDiffCents: 0,
      datesChanged: false,
      guestIdentityChanged: true,
    });

    expect(decision.financialAction.type).toBe("none");
    expect(decision.primaryInvoiceUpdateAction).toEqual({
      type: "queue",
      reason: expect.stringContaining("safe primary invoice"),
    });
  });

  it("skips primary narration updates for paid invoice guest-name changes", () => {
    const decision = classifyXeroBookingEditSettlement({
      hasIssuedXeroInvoice: true,
      originalPaymentStatus: "SUCCEEDED",
      priceDiffCents: 0,
      guestIdentityChanged: true,
    });

    expect(decision.financialAction.type).toBe("none");
    expect(decision.primaryInvoiceUpdateAction).toEqual({
      type: "skip",
      reason: expect.stringContaining("Skipped primary Xero invoice update"),
    });
  });
});

describe("queueXeroBookingEditSettlement (side effects)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enqueueXeroBookingInvoiceOperation.mockResolvedValue({
      queueOperationId: "op-primary",
    });
    mocks.enqueueXeroBookingInvoiceUpdateOperation.mockResolvedValue({
      queueOperationId: "op-update",
    });
    mocks.enqueueXeroModificationCreditNoteOperation.mockResolvedValue({
      queueOperationId: "op-credit",
    });
    mocks.enqueueXeroModificationAccountCreditNoteOperation.mockResolvedValue({
      queueOperationId: "op-account-credit",
    });
    mocks.enqueueXeroSupplementaryInvoiceOperation.mockResolvedValue({
      queueOperationId: "op-supp",
    });
    mocks.kickQueuedXeroOutboxOperationsIfConnected.mockResolvedValue(null);
    mocks.recordSkippedXeroBookingInvoiceUpdateOperation.mockResolvedValue(
      undefined,
    );
  });

  it("queues a supplementary invoice waiting on the additional Stripe payment and records a primary-update skip", async () => {
    const decision = await queueXeroBookingEditSettlement({
      bookingId: "booking_1",
      bookingModificationId: "mod_1",
      createdByMemberId: "admin_1",
      hasIssuedXeroInvoice: true,
      originalPaymentStatus: "SUCCEEDED",
      priceDiffCents: 4500,
      changeFeeCents: 500,
      datesChanged: true,
      requiresAdditionalStripePayment: true,
      additionalPaymentIntentId: "pi_additional",
    });

    expect(decision.financialAction.type).toBe("supplementary-invoice");
    expect(mocks.enqueueXeroSupplementaryInvoiceOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "booking_1",
        priceDiffCents: 4500,
        changeFeeCents: 500,
        bookingModificationId: "mod_1",
      }),
      expect.objectContaining({
        createdByMemberId: "admin_1",
        paymentIntentId: "pi_additional",
        waitForConfirmedAdditionalPayment: true,
        recordPayment: true,
      }),
    );
    expect(
      mocks.recordSkippedXeroBookingInvoiceUpdateOperation,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "booking_1",
        bookingModificationId: "mod_1",
        createdByMemberId: "admin_1",
      }),
    );
    expect(mocks.kickQueuedXeroOutboxOperationsIfConnected).toHaveBeenCalled();
  });

  it("queues a mixed-sign supplementary invoice with the signed price reduction (#1356)", async () => {
    const decision = await queueXeroBookingEditSettlement({
      bookingId: "booking_mixed",
      bookingModificationId: "mod_mixed",
      createdByMemberId: "admin_1",
      hasIssuedXeroInvoice: true,
      originalPaymentStatus: "SUCCEEDED",
      priceDiffCents: -500,
      changeFeeCents: 1000,
      datesChanged: true,
      requiresAdditionalStripePayment: true,
      additionalPaymentIntentId: "pi_mixed",
    });

    expect(decision.financialAction.type).toBe("supplementary-invoice");
    expect(mocks.enqueueXeroSupplementaryInvoiceOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "booking_mixed",
        priceDiffCents: -500,
        changeFeeCents: 1000,
        bookingModificationId: "mod_mixed",
      }),
      expect.objectContaining({
        paymentIntentId: "pi_mixed",
        waitForConfirmedAdditionalPayment: true,
        recordPayment: true,
      }),
    );
    expect(mocks.enqueueXeroModificationCreditNoteOperation).not.toHaveBeenCalled();
  });

  it("queues a modification credit note for a negative delta on a paid booking", async () => {
    const decision = await queueXeroBookingEditSettlement({
      bookingId: "booking_2",
      bookingModificationId: "mod_2",
      createdByMemberId: "admin_1",
      hasIssuedXeroInvoice: true,
      originalPaymentStatus: "SUCCEEDED",
      priceDiffCents: -3000,
      datesChanged: false,
    });

    expect(decision.financialAction.type).toBe("modification-credit-note");
    expect(
      mocks.enqueueXeroModificationCreditNoteOperation,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "booking_2",
        refundAmountCents: 3000,
        bookingModificationId: "mod_2",
        refundMethod: "card",
      }),
      expect.objectContaining({ createdByMemberId: "admin_1" }),
    );
    expect(mocks.enqueueXeroSupplementaryInvoiceOperation).not.toHaveBeenCalled();
  });

  it("hands an explicit bank-transfer refund method to the modification credit note enqueue (INV-PAY-101)", async () => {
    await queueXeroBookingEditSettlement({
      bookingId: "booking_2",
      bookingModificationId: "mod_2",
      createdByMemberId: "admin_1",
      hasIssuedXeroInvoice: true,
      originalPaymentStatus: "SUCCEEDED",
      priceDiffCents: -3000,
      datesChanged: false,
      refundMethod: "internet-banking",
    });

    expect(
      mocks.enqueueXeroModificationCreditNoteOperation,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ refundMethod: "internet-banking" }),
      expect.anything(),
    );
  });

  it("queues a modification account-credit note for a credit-settled negative delta", async () => {
    const decision = await queueXeroBookingEditSettlement({
      bookingId: "booking_3",
      bookingModificationId: "mod_3",
      createdByMemberId: "admin_1",
      hasIssuedXeroInvoice: true,
      originalPaymentStatus: "SUCCEEDED",
      priceDiffCents: -5000,
      settlementMethod: "credit",
      settlementAmountCents: 3750,
      datesChanged: false,
    });

    expect(decision.financialAction.type).toBe("modification-account-credit-note");
    expect(
      mocks.enqueueXeroModificationAccountCreditNoteOperation,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "booking_3",
        refundAmountCents: 3750,
        bookingModificationId: "mod_3",
      }),
      expect.objectContaining({ createdByMemberId: "admin_1" }),
    );
    expect(mocks.enqueueXeroModificationCreditNoteOperation).not.toHaveBeenCalled();
  });
});
