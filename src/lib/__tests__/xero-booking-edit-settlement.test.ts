import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enqueueXeroBookingInvoiceOperation: vi.fn(),
  enqueueXeroBookingInvoiceUpdateOperation: vi.fn(),
  enqueueXeroModificationAccountCreditNoteOperation: vi.fn(),
  enqueueXeroModificationCreditNoteOperation: vi.fn(),
  enqueueXeroRefundCreditNoteOperation: vi.fn(),
  enqueueXeroSupplementaryInvoiceOperation: vi.fn(),
  kickQueuedXeroOutboxOperationsIfConnected: vi.fn(),
  recordSkippedXeroBookingInvoiceUpdateOperation: vi.fn(),
}));

vi.mock("@/lib/xero-operation-outbox", () => mocks);

// #3979: the queue reads whether a bank receipt was captured, only when the
// aggregate status alone would refuse an invoice correction. Default: one was
// (the answer the aggregate gave before #3979).
const receiptFindFirst = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prisma", () => ({ prisma: { paymentTransaction: { findFirst: receiptFindFirst } } }));
beforeEach(() => {
  receiptFindFirst.mockReset();
  receiptFindFirst.mockResolvedValue({ id: "ptx-captured" });
});

vi.mock("@/lib/logger", () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// #3403 review (M5): an invoice parked on an ask a later request already
// superseded follows it at once; proven in its own suite and on PostgreSQL.
const followForIntent = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/superseded-ask-invoice-carry", () => ({ followSupersededAskInvoicesForIntentSafely: followForIntent }));

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import logger from "@/lib/logger";
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

  it("uses a refund credit note for a card reduction, the historical default included (#3993)", () => {
    const decision = classifyXeroBookingEditSettlement({
      hasIssuedXeroInvoice: true,
      originalPaymentStatus: "SUCCEEDED",
      priceDiffCents: -2500,
      changeFeeCents: 500,
    });

    expect(decision.financialAction).toEqual({
      type: "refund-credit-note",
      refundAmountCents: 2000,
      allocatedGiveBackCents: 0,
      reason: expect.stringContaining("refund credit note"),
    });
  });

  it("keeps an account-credit share on an allocated modification note when settlementMethod is card", () => {
    const decision = classifyXeroBookingEditSettlement({
      hasIssuedXeroInvoice: true,
      originalPaymentStatus: "SUCCEEDED",
      priceDiffCents: -5000,
      settlementMethod: "card",
      refundMethod: "account-credit",
      settlementAmountCents: 5000,
    });

    expect(decision.financialAction).toMatchObject({
      type: "modification-credit-note",
      refundMethod: "account-credit",
      refundAmountCents: 5000,
    });
  });

  it("leaves an organiser child's card refund for the executor that raises the one note", () => {
    const decision = classifyXeroBookingEditSettlement({
      hasIssuedXeroInvoice: true,
      originalPaymentStatus: "SUCCEEDED",
      priceDiffCents: -2500,
      refundedThroughStripe: true,
      organiserChildRefundOwnsCreditNote: true,
    });

    expect(decision.financialAction.type).toBe("none");
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

    // MUTATION: a Stripe-captured payment reduced to card is a refund note, not
    // a modification note worded as a card refund.
    expect(
      classifyXeroBookingEditSettlement({
        hasIssuedXeroInvoice: true,
        originalPaymentStatus: "SUCCEEDED",
        priceDiffCents: -2500,
        settlementMethod: "card",
        settlementAmountCents: 2500,
        refundedThroughStripe: true,
      }).financialAction,
    ).toMatchObject({ type: "refund-credit-note", refundAmountCents: 2500 });
  });

  // #3536 (`INV-PAY-101`): an UNPAID pay-on-account invoice lowered by an edit
  // refunds nothing, so it is an invoice correction rather than a bank transfer.
  it("words a reduction of an unpaid invoice as an invoice correction with no refund method (#3536)", () => {
    const decision = classifyXeroBookingEditSettlement({
      hasIssuedXeroInvoice: true,
      originalPaymentStatus: "PENDING",
      priceDiffCents: -2500,
      settlementMethod: "card",
      refundedThroughStripe: false,
    });

    expect(decision.financialAction).toEqual({
      type: "modification-credit-note",
      refundAmountCents: 2500,
      noteWording: "invoice-correction",
      // #3809 (composed by #3829): no applied credit given back on this edit.
      allocatedGiveBackCents: 0,
      reason: expect.stringContaining("modification credit note"),
    });
  });

  it("MUTATION: only an unpaid invoice is a correction - a paid one, an unknown status or a caller's own method keeps its words (#3536)", () => {
    const base = {
      hasIssuedXeroInvoice: true,
      priceDiffCents: -2500,
      settlementMethod: "card" as const,
      refundedThroughStripe: false,
    };
    // Paid by internet banking: the club returns the money, and says so.
    for (const originalPaymentStatus of ["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED"]) {
      const { financialAction } = classifyXeroBookingEditSettlement({ ...base, originalPaymentStatus });
      expect(financialAction).toMatchObject({ refundMethod: "internet-banking" });
      expect(financialAction).not.toHaveProperty("noteWording");
    }
    // A status nobody stated is not evidence the invoice is unpaid.
    const unknown = classifyXeroBookingEditSettlement(base).financialAction;
    expect(unknown).toMatchObject({ refundMethod: "internet-banking" });
    expect(unknown).not.toHaveProperty("noteWording");
    // A Stripe-captured payment is never a correction, and a named method wins.
    expect(
      classifyXeroBookingEditSettlement({
        ...base,
        originalPaymentStatus: "PENDING",
        refundedThroughStripe: true,
      }).financialAction,
    ).toMatchObject({ type: "refund-credit-note", refundAmountCents: 2500 });
    const named = classifyXeroBookingEditSettlement({
      ...base,
      originalPaymentStatus: "PENDING",
      refundMethod: "internet-banking",
    }).financialAction;
    expect(named).toMatchObject({ refundMethod: "internet-banking" });
    expect(named).not.toHaveProperty("noteWording");
  });

  it("words a cash hand-back as cash and keeps the bank-transfer method it settles by (#3536)", () => {
    const cash = classifyXeroBookingEditSettlement({
      hasIssuedXeroInvoice: true,
      originalPaymentStatus: "SUCCEEDED",
      priceDiffCents: -2500,
      refundMethod: "internet-banking",
      handedBackInCash: true,
    });
    expect(cash.financialAction).toMatchObject({
      type: "modification-credit-note",
      refundMethod: "internet-banking",
      noteWording: "cash",
    });

    // MUTATION: without the flag the same hand-back is not worded as cash.
    expect(
      classifyXeroBookingEditSettlement({
        hasIssuedXeroInvoice: true,
        originalPaymentStatus: "SUCCEEDED",
        priceDiffCents: -2500,
        refundMethod: "internet-banking",
      }).financialAction,
    ).not.toHaveProperty("noteWording");
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
      allocatedGiveBackCents: 0,
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
    mocks.enqueueXeroRefundCreditNoteOperation.mockResolvedValue({
      queueOperationId: "op-refund",
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
    expect(followForIntent).toHaveBeenCalledWith("pi_additional");
  });

  it("#4299 N-b: records no primary-invoice update, queued or skipped, for an organiser-paid bank place", async () => {
    const decision = await queueXeroBookingEditSettlement({
      organiserBankPlace: true,
      bookingId: "place_1",
      bookingModificationId: "mod_place",
      hasIssuedXeroInvoice: true,
      originalPaymentStatus: "SUCCEEDED",
      priceDiffCents: 4500,
      changeFeeCents: 500,
      datesChanged: true,
    });
    expect(decision.primaryInvoiceUpdateAction.type).toBe("none");
    expect(mocks.recordSkippedXeroBookingInvoiceUpdateOperation).not.toHaveBeenCalled();
    expect(mocks.enqueueXeroBookingInvoiceUpdateOperation).not.toHaveBeenCalled();
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

  it("queues a refund credit note for a card reduction, and nothing when the payment id is missing", async () => {
    const decision = await queueXeroBookingEditSettlement({
      bookingId: "booking_2",
      bookingModificationId: "mod_2",
      createdByMemberId: "admin_1",
      hasIssuedXeroInvoice: true,
      originalPaymentStatus: "SUCCEEDED",
      priceDiffCents: -3000,
      datesChanged: false,
      paymentId: "payment_2",
    });

    expect(decision.financialAction.type).toBe("refund-credit-note");
    expect(mocks.enqueueXeroRefundCreditNoteOperation).toHaveBeenCalledWith(
      "payment_2",
      3000,
      expect.objectContaining({ refundMethod: "card", createdByMemberId: "admin_1" }),
    );
    expect(mocks.enqueueXeroModificationCreditNoteOperation).not.toHaveBeenCalled();
    expect(mocks.enqueueXeroSupplementaryInvoiceOperation).not.toHaveBeenCalled();

    mocks.enqueueXeroRefundCreditNoteOperation.mockClear();
    await queueXeroBookingEditSettlement({
      bookingId: "booking_2",
      bookingModificationId: "mod_2",
      hasIssuedXeroInvoice: true,
      originalPaymentStatus: "SUCCEEDED",
      priceDiffCents: -3000,
      datesChanged: false,
    });
    expect(mocks.enqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
    expect(mocks.enqueueXeroModificationCreditNoteOperation).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
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

  it("hands the booking-edit wordings to the modification credit note enqueue (#3536)", async () => {
    await queueXeroBookingEditSettlement({
      bookingId: "booking_3",
      bookingModificationId: "mod_3",
      hasIssuedXeroInvoice: true,
      originalPaymentStatus: "PENDING",
      priceDiffCents: -3000,
      settlementMethod: "card",
      refundedThroughStripe: false,
    });
    const [correction] = mocks.enqueueXeroModificationCreditNoteOperation.mock.calls[0];
    expect(correction).toMatchObject({ noteWording: "invoice-correction" });
    expect(correction).not.toHaveProperty("refundMethod");

    mocks.enqueueXeroModificationCreditNoteOperation.mockClear();
    await queueXeroBookingEditSettlement({
      bookingId: "booking_4",
      bookingModificationId: "mod_4",
      hasIssuedXeroInvoice: true,
      originalPaymentStatus: "SUCCEEDED",
      priceDiffCents: -3000,
      refundMethod: "internet-banking",
      handedBackInCash: true,
    });
    expect(mocks.enqueueXeroModificationCreditNoteOperation).toHaveBeenCalledWith(
      expect.objectContaining({ refundMethod: "internet-banking", noteWording: "cash" }),
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

  it("MUTATION (#3809): a credit election beside applied credit given back queues the unallocated note AND an allocated note for the give-back", async () => {
    await queueXeroBookingEditSettlement({
      bookingId: "booking_4",
      bookingModificationId: "mod_4",
      createdByMemberId: "admin_1",
      hasIssuedXeroInvoice: true,
      originalPaymentStatus: "SUCCEEDED",
      priceDiffCents: -15000,
      settlementMethod: "credit",
      settlementAmountCents: 10000,
      appliedCreditGiveBackCents: 5000,
      datesChanged: false,
    });

    expect(mocks.enqueueXeroModificationAccountCreditNoteOperation).toHaveBeenCalledWith(
      expect.objectContaining({ refundAmountCents: 10000, bookingModificationId: "mod_4" }),
      expect.anything(),
    );
    expect(mocks.enqueueXeroModificationCreditNoteOperation).toHaveBeenCalledWith(
      expect.objectContaining({ refundAmountCents: 5000, bookingModificationId: "mod_4", refundMethod: "account-credit" }),
      expect.anything(),
    );
  });

  it("MUTATION (#3993): a card refund beside applied credit given back queues the refund note and the scoped give-back", async () => {
    await queueXeroBookingEditSettlement({
      bookingId: "booking_5",
      bookingModificationId: "mod_5",
      createdByMemberId: "admin_1",
      hasIssuedXeroInvoice: true,
      originalPaymentStatus: "SUCCEEDED",
      priceDiffCents: -15000,
      settlementMethod: "card",
      settlementAmountCents: 10000,
      refundedThroughStripe: true,
      appliedCreditGiveBackCents: 5000,
      datesChanged: false,
      paymentId: "payment_5",
    });

    expect(mocks.enqueueXeroRefundCreditNoteOperation).toHaveBeenCalledWith(
      "payment_5",
      10000,
      expect.objectContaining({ refundMethod: "card", createdByMemberId: "admin_1" }),
    );
    const calls = mocks.enqueueXeroModificationCreditNoteOperation.mock.calls.map((call) => call[0]);
    expect(calls).toEqual([
      expect.objectContaining({ refundAmountCents: 5000, refundMethod: "account-credit", reviewTaskId: "applied-credit-give-back" }),
    ]);
  });

  it("MUTATION (#3809 L1): a give-back beside a review task's card refund takes a scope of its own, never the review task's", async () => {
    await queueXeroBookingEditSettlement({
      bookingId: "booking_6",
      bookingModificationId: "mod_6",
      reviewTaskId: "task-9",
      hasIssuedXeroInvoice: true,
      originalPaymentStatus: "SUCCEEDED",
      priceDiffCents: -5000,
      settlementMethod: "card",
      settlementAmountCents: 5000,
      appliedCreditGiveBackCents: 5000,
      datesChanged: false,
      paymentId: "payment_6",
    });

    expect(mocks.enqueueXeroRefundCreditNoteOperation).toHaveBeenCalledWith(
      "payment_6",
      5000,
      expect.objectContaining({ refundMethod: "card", reviewTaskId: "task-9" }),
    );
    const scopes = mocks.enqueueXeroModificationCreditNoteOperation.mock.calls.map((call) => call[0].reviewTaskId);
    expect(scopes).toEqual(["task-9:applied-credit-give-back"]);
  });

  it("MUTATION (#3809 delta H1): applied credit given back with nothing else returned is ONE note, under the give-back's own scope - never the edit's own", async () => {
    await queueXeroBookingEditSettlement({
      bookingId: "booking_7",
      bookingModificationId: "mod_7",
      hasIssuedXeroInvoice: true,
      originalPaymentStatus: "SUCCEEDED",
      priceDiffCents: -5000,
      settlementMethod: "card",
      settlementAmountCents: 0,
      refundedThroughStripe: true,
      appliedCreditGiveBackCents: 4000,
      datesChanged: false,
    });

    const calls = mocks.enqueueXeroModificationCreditNoteOperation.mock.calls.map((call) => call[0]);
    expect(calls).toEqual([
      expect.objectContaining({ refundAmountCents: 4000, refundMethod: "account-credit", reviewTaskId: "applied-credit-give-back" }),
    ]);
  });
});

describe("an invoice correction is decided from the bank receipt, not the aggregate (#3979 review E)", () => {
  const reduction = {
    hasIssuedXeroInvoice: true,
    priceDiffCents: -10_000,
    refundedThroughStripe: false,
    // #1765: a card capture refunded before the switch reads REFUNDED.
    originalPaymentStatus: "REFUNDED",
  };

  it("classifies a reduction of a never-paid invoice as a correction when no receipt was captured", () => {
    const decision = classifyXeroBookingEditSettlement({ ...reduction, internetBankingReceiptCaptured: false });
    expect(decision.financialAction).toMatchObject({ type: "modification-credit-note", noteWording: "invoice-correction" });
    expect(decision.financialAction).not.toHaveProperty("refundMethod");
  });

  it("keeps the refund wording once a receipt was captured", () => {
    const decision = classifyXeroBookingEditSettlement({ ...reduction, internetBankingReceiptCaptured: true });
    expect(decision.financialAction).not.toMatchObject({ noteWording: "invoice-correction" });
    expect(decision.financialAction).toMatchObject({ refundMethod: "internet-banking" });
  });

  it("the queue reads the receipt in exactly that case, and words the note a correction", async () => {
    receiptFindFirst.mockResolvedValue(null);
    mocks.enqueueXeroModificationCreditNoteOperation.mockResolvedValue({ queueOperationId: null });

    await queueXeroBookingEditSettlement({ ...reduction, bookingId: "booking-1", bookingModificationId: "mod-1" });

    expect(receiptFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ payment: { bookingId: "booking-1" }, source: "INTERNET_BANKING" }) }),
    );
    expect(mocks.enqueueXeroModificationCreditNoteOperation).toHaveBeenCalledWith(
      expect.objectContaining({ noteWording: "invoice-correction" }),
      expect.anything(),
    );
  });

  it("the queue asks nothing for an unpaid aggregate", async () => {
    mocks.enqueueXeroModificationCreditNoteOperation.mockResolvedValue({ queueOperationId: null });

    await queueXeroBookingEditSettlement({
      ...reduction,
      originalPaymentStatus: "PENDING",
      bookingId: "booking-1",
      bookingModificationId: "mod-1",
    });

    expect(receiptFindFirst).not.toHaveBeenCalled();
  });
});

describe("a card refund is recorded before its Xero note is queued (#3993)", () => {
  it("each card-refund door awaits the Stripe refund, then queues the settlement", () => {
    const repoRoot = resolve(__dirname, "../../..");
    const doors: Array<[string, string, string]> = [
      ["src/lib/booking-batch-modification-service.ts", "await executeBookingModificationRefund(", "queueXeroBookingEditSettlement({"],
      ["src/lib/booking-date-modification-service.ts", "await executeBookingModificationRefund(", "queueXeroBookingEditSettlement({"],
      ["src/app/api/bookings/[id]/guests/[guestId]/route.ts", "await executeBookingModificationRefund(", "queueGuestRemovalXeroSettlement("],
      ["src/lib/booking-guest-acceptance-reprice.ts", "await executeBookingModificationRefund(", "queueXeroBookingEditSettlement({"],
      ["src/lib/edit-financial-review-settlement.ts", "await executeEditReviewCardRefund(", "await dispatchEditReviewXeroSettlement("],
    ];
    for (const [file, earlier, later] of doors) {
      const source = readFileSync(resolve(repoRoot, file), "utf8");
      const earlierAt = source.indexOf(earlier);
      const laterAt = source.indexOf(later);
      expect(earlierAt, file).toBeGreaterThanOrEqual(0);
      expect(laterAt, file).toBeGreaterThan(earlierAt);
    }
  });
});
