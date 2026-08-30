import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  findFirstLink: vi.fn(),
  findUniqueBooking: vi.fn(),
  findUniqueMember: vi.fn(),
  findUniqueMemberSubscription: vi.fn(),
  findUniquePayment: vi.fn(),
  findUniqueGroupSettlement: vi.fn(),
  findFirstPaymentTransaction: vi.fn(),
  findFirstOperation: vi.fn(),
  findManyOperations: vi.fn(),
  updateManyOperation: vi.fn(),
  updateOperation: vi.fn(),
  startXeroSyncOperation: vi.fn(),
  completeXeroSyncOperation: vi.fn(),
  failXeroSyncOperation: vi.fn(),
  findCanonicalPaymentRefundCreditNote: vi.fn(),
  sumCoveredRefundCreditNoteCents: vi.fn(),
  resolveStripeCashRefundEvidence: vi.fn(),
  upsertXeroObjectLink: vi.fn(),
  getEntranceFeeContext: vi.fn(),
  createUnappliedXeroCreditNote: vi.fn(),
  createUnappliedXeroCreditNoteForModification: vi.fn(),
  allocateCreditNoteToInvoice: vi.fn(),
  createXeroCreditNote: vi.fn(),
  createXeroCreditNoteForModification: vi.fn(),
  allocateAppliedCreditForBooking: vi.fn(),
  deallocateExcessAppliedCreditForBooking: vi.fn(),
  createXeroEntranceFeeInvoice: vi.fn(),
  createXeroInvoiceForBooking: vi.fn(),
  createXeroInvoiceForGroupSettlement: vi.fn(),
  voidXeroInvoiceForCancelledGroupSettlement: vi.fn(),
  createXeroMembershipSubscriptionInvoice: vi.fn(),
  updateXeroBookingInvoiceForBooking: vi.fn(),
  createXeroSupplementaryInvoice: vi.fn(),
  createXeroMembershipCancellationCreditNote: vi.fn(),
  syncXeroMembershipCancellationContact: vi.fn(),
  isXeroConnected: vi.fn().mockResolvedValue(false),
  executeRaw: vi.fn(),
}));

// #3170 fix round: `enqueueXeroSupplementaryInvoiceOperation` now decides
// link-check -> queued-check -> write inside ONE advisory-locked transaction, so
// the double has to serve the transaction client too. It is the SAME object, so
// every existing assertion on `mocks.*` reads the in-transaction calls unchanged,
// and `mocks.executeRaw` is where the lock statement lands.
vi.mock("@/lib/prisma", () => {
  const client: Record<string, unknown> = {
    booking: {
      findUnique: mocks.findUniqueBooking,
    },
    member: {
      findUnique: mocks.findUniqueMember,
    },
    memberSubscription: {
      findUnique: mocks.findUniqueMemberSubscription,
    },
    payment: {
      findUnique: mocks.findUniquePayment,
    },
    groupBookingSettlement: {
      findUnique: mocks.findUniqueGroupSettlement,
    },
    paymentTransaction: {
      findFirst: mocks.findFirstPaymentTransaction,
    },
    xeroObjectLink: {
      findFirst: mocks.findFirstLink,
    },
    xeroSyncOperation: {
      findFirst: mocks.findFirstOperation,
      findMany: mocks.findManyOperations,
      updateMany: mocks.updateManyOperation,
      update: mocks.updateOperation,
    },
    $executeRaw: mocks.executeRaw,
    $transaction: (fn: (tx: unknown) => unknown) => fn(client),
  };
  return { prisma: client };
});

vi.mock("@/lib/logger", () => ({
  default: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@/lib/xero-sync", () => ({
  buildXeroIdempotencyKey: (...parts: Array<string | number | boolean | null | undefined>) =>
    parts
      .filter((part): part is string | number | boolean => part !== null && part !== undefined && part !== "")
      .map((part) => String(part))
      .join(":"),
  startXeroSyncOperation: mocks.startXeroSyncOperation,
  completeXeroSyncOperation: mocks.completeXeroSyncOperation,
  failXeroSyncOperation: mocks.failXeroSyncOperation,
  findCanonicalPaymentRefundCreditNote: mocks.findCanonicalPaymentRefundCreditNote,
  sumCoveredRefundCreditNoteCents: mocks.sumCoveredRefundCreditNoteCents,
  upsertXeroObjectLink: mocks.upsertXeroObjectLink,
}));

// #2902: the STRIPE enqueue cap reads provider-backed cash evidence, never
// the refundedAmountCents mirror. Resolution rules are unit-tested in
// stripe-cash-refund-evidence.test.ts; the default here (cash === mirror)
// keeps the pre-#2902 stepped-refund scenarios meaning what they said.
vi.mock("@/lib/stripe-cash-refund-evidence", () => ({
  resolveStripeCashRefundEvidence: mocks.resolveStripeCashRefundEvidence,
}));

vi.mock("@/lib/xero-group-settlement-invoices", () => ({
  createXeroInvoiceForGroupSettlement: mocks.createXeroInvoiceForGroupSettlement,
  voidXeroInvoiceForCancelledGroupSettlement:
    mocks.voidXeroInvoiceForCancelledGroupSettlement,
}));
vi.mock("@/lib/xero-subscription-invoices", () => ({
  createXeroMembershipSubscriptionInvoice: mocks.createXeroMembershipSubscriptionInvoice,
}));

// #1208: xero-operation-outbox now imports from the source domain modules
// directly (not the @/lib/xero facade), so the doubles mock those modules.
vi.mock("@/lib/xero-booking-invoices", () => ({
  createXeroInvoiceForBooking: mocks.createXeroInvoiceForBooking,
  updateXeroBookingInvoiceForBooking: mocks.updateXeroBookingInvoiceForBooking,
}));

vi.mock("@/lib/xero-credit-notes", () => ({
  allocateCreditNoteToInvoice: mocks.allocateCreditNoteToInvoice,
  createUnappliedXeroCreditNote: mocks.createUnappliedXeroCreditNote,
  createUnappliedXeroCreditNoteForModification:
    mocks.createUnappliedXeroCreditNoteForModification,
  createXeroCreditNote: mocks.createXeroCreditNote,
}));

vi.mock("@/lib/xero-entrance-fee-invoices", () => ({
  createXeroEntranceFeeInvoice: mocks.createXeroEntranceFeeInvoice,
}));

vi.mock("@/lib/xero-mappings", () => ({
  buildEntranceFeeInvoiceIdempotencyKey: (
    memberId: string,
    category: string,
    amountCents: number
  ) => `member:${memberId}:joining-fee-invoice:${category}:${amountCents}:v2`,
  getEntranceFeeContext: mocks.getEntranceFeeContext,
}));

vi.mock("@/lib/xero-applied-credit-allocation", () => ({
  allocateAppliedCreditForBooking: mocks.allocateAppliedCreditForBooking,
}));
vi.mock("@/lib/xero-applied-credit-deallocation", () => ({
  deallocateExcessAppliedCreditForBooking: mocks.deallocateExcessAppliedCreditForBooking,
}));
vi.mock("@/lib/xero-modification-credit-notes", () => ({
  createXeroCreditNoteForModification: mocks.createXeroCreditNoteForModification,
}));

vi.mock("@/lib/xero-supplementary-invoices", () => ({
  createXeroSupplementaryInvoice: mocks.createXeroSupplementaryInvoice,
}));

vi.mock("@/lib/xero-token-store", () => ({
  isXeroConnected: mocks.isXeroConnected,
}));

vi.mock("@/lib/membership-cancellation-xero", () => ({
  createXeroMembershipCancellationCreditNote:
    mocks.createXeroMembershipCancellationCreditNote,
  syncXeroMembershipCancellationContact: mocks.syncXeroMembershipCancellationContact,
}));

import {
  enqueueXeroAccountCreditNoteOperation,
  enqueueXeroBookingInvoiceOperation,
  enqueueXeroBookingInvoiceUpdateOperation,
  enqueueXeroCreditNoteAllocationOperation,
  enqueueXeroGroupSettlementInvoiceOperation,
  enqueueXeroEntranceFeeInvoiceOperation,
  enqueueXeroMembershipCancellationContactOperation,
  enqueueXeroMembershipCancellationCreditNoteOperation,
  enqueueXeroModificationAccountCreditNoteOperation,
  enqueueXeroModificationCreditNoteOperation,
  enqueueXeroRefundCreditNoteOperation,
  enqueueXeroSupplementaryInvoiceOperation,
  processQueuedXeroOutboxOperations,
  reapStaleWaitingPaymentXeroOutboxOperations,
  releaseXeroSupplementaryInvoiceOperationsForPaymentIntent,
  restatePendingSupplementaryInvoiceAmount,
} from "@/lib/xero-operation-outbox";
import { XERO_OUTBOX_QUEUE_TYPES } from "@/lib/xero-operation-outbox-payload";
import { XeroAppliedCreditOperationBusyError } from "@/lib/xero-applied-credit-operation-serialization";

describe("enqueueXeroEntranceFeeInvoiceOperation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstLink.mockResolvedValue(null);
    mocks.findUniqueBooking.mockResolvedValue({
      id: "booking_1",
      payment: {
        xeroInvoiceId: null,
      },
    });
    mocks.findUniquePayment.mockResolvedValue({
      id: "payment_1",
      xeroRefundCreditNoteId: null,
    });
    mocks.findFirstOperation.mockResolvedValue(null);
    mocks.getEntranceFeeContext.mockResolvedValue({
      category: "ADULT",
      feeMapping: {
        itemCode: "EF-ADULT",
        amountCents: 15000,
      },
    });
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_entrance_1" });
  });

  it("creates a pending primary Xero sync operation for entrance fee invoices", async () => {
    await expect(
      enqueueXeroEntranceFeeInvoiceOperation("member_1", {
        createdByMemberId: "admin_1",
      })
    ).resolves.toEqual({
      queueOperationId: "op_entrance_1",
      message: "Xero joining fee invoice queued for background processing.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "OUTBOUND",
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "Member",
        localId: "member_1",
        status: "PENDING",
        idempotencyKey: "member:member_1:joining-fee-invoice:ADULT:15000:v2",
        correlationKey: "member:member_1:joining-fee-invoice:ADULT:15000:v2",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "ENTRANCE_FEE_INVOICE",
          category: "ADULT",
          itemCode: "EF-ADULT",
          feeAmountCents: 15000,
        },
      })
    );
  });

  it("queues entrance fee invoices with admin amount and narration overrides", async () => {
    await expect(
      enqueueXeroEntranceFeeInvoiceOperation("member_1", {
        createdByMemberId: "admin_1",
        amountCents: 12345,
        description: "Entrance fee waived to adjusted family rate",
      })
    ).resolves.toEqual({
      queueOperationId: "op_entrance_1",
      message: "Xero joining fee invoice queued for background processing.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "member:member_1:joining-fee-invoice:ADULT:12345:v2",
        correlationKey: "member:member_1:joining-fee-invoice:ADULT:12345:v2",
        requestPayload: {
          queueType: "ENTRANCE_FEE_INVOICE",
          category: "ADULT",
          itemCode: "EF-ADULT",
          feeAmountCents: 12345,
          description: "Entrance fee waived to adjusted family rate",
        },
      })
    );
  });

  it("skips queueing when there is no configured entrance fee", async () => {
    mocks.getEntranceFeeContext.mockResolvedValue({
      category: "CHILD",
      feeMapping: {
        itemCode: null,
        amountCents: null,
      },
    });

    await expect(
      enqueueXeroEntranceFeeInvoiceOperation("member_1")
    ).resolves.toEqual({
      queueOperationId: null,
      message: "No joining fee is configured for this membership type.",
    });

    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });
});

describe("enqueueXeroBookingInvoiceOperation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstLink.mockResolvedValue(null);
    mocks.findUniqueBooking.mockResolvedValue({
      id: "booking_1",
      payment: {
        id: "payment_1",
        xeroInvoiceId: null,
      },
    });
    mocks.findFirstOperation.mockResolvedValue(null);
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_booking_1" });
  });

  it("creates a pending primary Xero sync operation for booking invoices", async () => {
    await expect(
      enqueueXeroBookingInvoiceOperation("booking_1", {
        createdByMemberId: "admin_1",
      })
    ).resolves.toEqual({
      queueOperationId: "op_booking_1",
      message: "Xero booking invoice queued for background processing.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "OUTBOUND",
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "Payment",
        localId: "payment_1",
        status: "PENDING",
        idempotencyKey: "booking:booking_1:invoice:v1",
        correlationKey: "booking:booking_1:invoice:v1",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "BOOKING_INVOICE",
          bookingId: "booking_1",
        },
      })
    );
  });

  it("skips queueing when the booking payment is already linked to Xero", async () => {
    mocks.findUniqueBooking.mockResolvedValue({
      id: "booking_1",
      payment: {
        id: "payment_1",
        xeroInvoiceId: "inv_existing",
      },
    });

    await expect(
      enqueueXeroBookingInvoiceOperation("booking_1")
    ).resolves.toEqual({
      queueOperationId: null,
      message: "Xero booking invoice already linked for this booking.",
    });

    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });
});

describe("enqueueXeroBookingInvoiceUpdateOperation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUniqueBooking.mockResolvedValue({
      id: "booking_1",
      checkIn: new Date("2026-05-30T00:00:00.000Z"),
      checkOut: new Date("2026-05-31T00:00:00.000Z"),
      payment: {
        id: "payment_1",
        xeroInvoiceId: "inv_existing",
      },
    });
    mocks.findFirstOperation.mockResolvedValue(null);
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_booking_update_1" });
  });

  it("creates a pending Xero sync operation for primary booking invoice updates", async () => {
    await expect(
      enqueueXeroBookingInvoiceUpdateOperation("booking_1", {
        createdByMemberId: "admin_1",
      })
    ).resolves.toEqual({
      queueOperationId: "op_booking_update_1",
      message: "Xero booking invoice update queued for background processing.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "OUTBOUND",
        entityType: "INVOICE",
        operationType: "UPDATE",
        localModel: "Payment",
        localId: "payment_1",
        status: "PENDING",
        idempotencyKey: "booking:booking_1:invoice-update:inv_existing:2026-05-30:2026-05-31:v1",
        correlationKey: "booking:booking_1:invoice-update:inv_existing:2026-05-30:2026-05-31:v1",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "BOOKING_INVOICE_UPDATE",
          bookingId: "booking_1",
          xeroInvoiceId: "inv_existing",
        },
      })
    );
  });

  it("skips queueing when there is no original Xero invoice", async () => {
    mocks.findUniqueBooking.mockResolvedValue({
      id: "booking_1",
      checkIn: new Date("2026-05-30T00:00:00.000Z"),
      checkOut: new Date("2026-05-31T00:00:00.000Z"),
      payment: {
        id: "payment_1",
        xeroInvoiceId: null,
      },
    });

    await expect(
      enqueueXeroBookingInvoiceUpdateOperation("booking_1")
    ).resolves.toEqual({
      queueOperationId: null,
      message: "No original Xero invoice exists for this booking.",
    });

    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });
});

describe("enqueueXeroSupplementaryInvoiceOperation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstLink.mockResolvedValue(null);
    mocks.findUniqueBooking.mockResolvedValue({
      id: "booking_1",
      payment: {
        xeroInvoiceId: "inv_existing",
      },
    });
    mocks.findFirstOperation.mockResolvedValue(null);
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_supplementary_1" });
  });

  it("creates a pending Xero sync operation for supplementary invoices", async () => {
    await expect(
      enqueueXeroSupplementaryInvoiceOperation(
        {
          bookingId: "booking_1",
          priceDiffCents: 2500,
          changeFeeCents: 500,
          bookingModificationId: "mod_1",
        },
        {
          createdByMemberId: "admin_1",
        }
      )
    ).resolves.toEqual({
      queueOperationId: "op_supplementary_1",
      message: "Xero supplementary invoice queued for background processing.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "OUTBOUND",
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "BookingModification",
        localId: "mod_1",
        status: "PENDING",
        idempotencyKey: "booking-mod:mod_1:supplementary-invoice:2500:500:v1",
        correlationKey: "booking-mod:mod_1:supplementary-invoice:2500:500:v1",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "SUPPLEMENTARY_INVOICE",
          bookingId: "booking_1",
          priceDiffCents: 2500,
          changeFeeCents: 500,
          bookingModificationId: "mod_1",
          recordPayment: true,
          paymentIntentId: null,
          waitForConfirmedAdditionalPayment: false,
        },
      })
    );
  });

  // #1356 (F16): mixed-sign components stay signed through the queue so the
  // executor can bill the exact net; a net that is not positive never becomes
  // a supplementary invoice (it belongs to the credit-note paths).
  it("queues mixed-sign components signed when the net is positive (#1356)", async () => {
    await expect(
      enqueueXeroSupplementaryInvoiceOperation(
        {
          bookingId: "booking_1",
          priceDiffCents: -500,
          changeFeeCents: 1000,
          bookingModificationId: "mod_mixed",
        },
        {
          createdByMemberId: "admin_1",
        }
      )
    ).resolves.toEqual({
      queueOperationId: "op_supplementary_1",
      message: "Xero supplementary invoice queued for background processing.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "booking-mod:mod_mixed:supplementary-invoice:-500:1000:v1",
        requestPayload: expect.objectContaining({
          priceDiffCents: -500,
          changeFeeCents: 1000,
        }),
      })
    );
  });

  it("skips mixed-sign modifications whose net is not positive (#1356)", async () => {
    await expect(
      enqueueXeroSupplementaryInvoiceOperation(
        {
          bookingId: "booking_1",
          priceDiffCents: -1500,
          changeFeeCents: 1000,
          bookingModificationId: "mod_negative_net",
        },
        {
          createdByMemberId: "admin_1",
        }
      )
    ).resolves.toEqual({
      queueOperationId: null,
      message: "No supplementary invoice is required for this modification.",
    });

    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("can hold supplementary invoices until additional Stripe payment succeeds", async () => {
    await expect(
      enqueueXeroSupplementaryInvoiceOperation(
        {
          bookingId: "booking_1",
          priceDiffCents: 2500,
          changeFeeCents: 500,
          bookingModificationId: "mod_1",
        },
        {
          createdByMemberId: "admin_1",
          paymentIntentId: "pi_additional",
          waitForConfirmedAdditionalPayment: true,
          recordPayment: true,
        }
      )
    ).resolves.toEqual({
      queueOperationId: "op_supplementary_1",
      message: "Xero supplementary invoice is waiting for confirmed additional payment.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "WAITING_PAYMENT",
        requestPayload: expect.objectContaining({
          paymentIntentId: "pi_additional",
          waitForConfirmedAdditionalPayment: true,
          recordPayment: true,
        }),
      })
    );
  });

  it("releases waiting supplementary invoice operations after payment confirmation", async () => {
    mocks.findManyOperations.mockResolvedValue([{ id: "op_supplementary_1" }]);
    mocks.updateManyOperation.mockResolvedValue({ count: 1 });

    await expect(
      releaseXeroSupplementaryInvoiceOperationsForPaymentIntent("pi_additional")
    ).resolves.toEqual({
      released: 1,
      queueOperationIds: ["op_supplementary_1"],
    });

    expect(mocks.updateManyOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ["op_supplementary_1"] },
          status: "WAITING_PAYMENT",
        }),
        data: expect.objectContaining({
          status: "PENDING",
          startedAt: null,
        }),
      })
    );
  });
});

describe("enqueueXeroRefundCreditNoteOperation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstLink.mockResolvedValue(null);
    mocks.findUniquePayment.mockResolvedValue({
      id: "payment_1",
      source: "INTERNET_BANKING",
      refundedAmountCents: 5000,
      xeroRefundCreditNoteId: null,
    });
    mocks.findFirstOperation.mockResolvedValue(null);
    mocks.findCanonicalPaymentRefundCreditNote.mockResolvedValue(null);
    mocks.sumCoveredRefundCreditNoteCents.mockResolvedValue(0);
    // Default: every refunded cent is provider-backed cash, so pre-#2902
    // scenarios keep their arithmetic. #2902 cases override per test.
    mocks.resolveStripeCashRefundEvidence.mockImplementation(
      async (payment: { refundedAmountCents: number }) => ({
        cashRefundCents: payment.refundedAmountCents,
        countedRefundCents: payment.refundedAmountCents,
        refundLedgerRowCount: 1,
        accountCreditCents: 0,
        source: "provider-ledger",
      })
    );
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_credit_note_1" });
  });

  it("creates a pending primary Xero sync operation for non-Stripe refund credit notes", async () => {
    await expect(
      enqueueXeroRefundCreditNoteOperation("payment_1", 5000, {
        createdByMemberId: "admin_1",
      })
    ).resolves.toEqual({
      queueOperationId: "op_credit_note_1",
      message: "Xero refund credit note queued for background processing.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "OUTBOUND",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "Payment",
        localId: "payment_1",
        status: "PENDING",
        idempotencyKey: "payment:payment_1:refund-credit-note:5000:v1",
        correlationKey: "payment:payment_1:refund-credit-note:5000:v1",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "REFUND_CREDIT_NOTE",
          refundAmountCents: 5000,
          watermarkCents: 5000,
        },
      })
    );
    // Non-Stripe payments never consult the cumulative refund watermark.
    expect(mocks.sumCoveredRefundCreditNoteCents).not.toHaveBeenCalled();
  });

  // #1357 (F17): a transaction-scoped enqueue must route EVERY internal
  // read/write through the caller's client so the outbox row commits
  // atomically with the caller's release (and the dedupe sees uncommitted
  // state), never through the global prisma client.
  it("routes all reads and the insert through the caller's store client", async () => {
    const store = {
      payment: {
        findUnique: vi.fn().mockResolvedValue({
          id: "payment_1",
          source: "INTERNET_BANKING",
          refundedAmountCents: 5000,
          xeroRefundCreditNoteId: null,
        }),
        update: vi.fn(),
      },
      xeroSyncOperation: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    };

    await expect(
      enqueueXeroRefundCreditNoteOperation("payment_1", 5000, {
        createdByMemberId: "cron",
        store: store as never,
      })
    ).resolves.toEqual({
      queueOperationId: "op_credit_note_1",
      message: "Xero refund credit note queued for background processing.",
    });

    expect(store.payment.findUnique).toHaveBeenCalledTimes(1);
    expect(store.xeroSyncOperation.findFirst).toHaveBeenCalledTimes(1);
    // The global-prisma delegates stayed untouched.
    expect(mocks.findUniquePayment).not.toHaveBeenCalled();
    expect(mocks.findFirstOperation).not.toHaveBeenCalled();
    // Helpers and the operation insert received the same client.
    expect(mocks.findCanonicalPaymentRefundCreditNote).toHaveBeenCalledWith(
      "payment_1",
      store
    );
    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        localId: "payment_1",
        store,
      })
    );
  });

  it("queues the uncovered delta with a v2 watermark key for a second Stripe refund", async () => {
    mocks.findUniquePayment.mockResolvedValue({
      id: "payment_1",
      source: "STRIPE",
      refundedAmountCents: 8000,
      xeroRefundCreditNoteId: "cn_1",
    });
    mocks.sumCoveredRefundCreditNoteCents.mockResolvedValue(5000);

    await expect(
      enqueueXeroRefundCreditNoteOperation("payment_1", 3000, {
        createdByMemberId: "admin_1",
      })
    ).resolves.toEqual({
      queueOperationId: "op_credit_note_1",
      message: "Xero refund credit note queued for background processing.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "payment:payment_1:refund-credit-note:8000:v2",
        correlationKey: "payment:payment_1:refund-credit-note:8000:v2",
        requestPayload: {
          queueType: "REFUND_CREDIT_NOTE",
          refundAmountCents: 3000,
          watermarkCents: 8000,
        },
      })
    );
  });

  it("skips a replayed Stripe delta once the notes already cover the refund", async () => {
    mocks.findUniquePayment.mockResolvedValue({
      id: "payment_1",
      source: "STRIPE",
      refundedAmountCents: 8000,
      xeroRefundCreditNoteId: "cn_1",
    });
    mocks.sumCoveredRefundCreditNoteCents.mockResolvedValue(8000);

    await expect(
      enqueueXeroRefundCreditNoteOperation("payment_1", 3000)
    ).resolves.toEqual({
      queueOperationId: null,
      message:
        "No provider-backed Stripe cash refund remains uncovered by refund credit notes for this payment.",
    });

    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("enqueues nothing for an account-credit-only cancellation whose cash evidence is zero (#2902)", async () => {
    mocks.findUniquePayment.mockResolvedValue({
      id: "payment_1",
      bookingId: "booking_1",
      source: "STRIPE",
      // The mirror moved (the cancellation ran applyLocalRefundAllocation)
      // but no Stripe cash ever did.
      refundedAmountCents: 34100,
      xeroRefundCreditNoteId: null,
    });
    mocks.sumCoveredRefundCreditNoteCents.mockResolvedValue(0);
    mocks.resolveStripeCashRefundEvidence.mockResolvedValue({
      cashRefundCents: 0,
      countedRefundCents: 0,
      refundLedgerRowCount: 0,
      accountCreditCents: 34100,
      source: "legacy-mirror",
    });

    await expect(
      enqueueXeroRefundCreditNoteOperation("payment_1", 34100)
    ).resolves.toEqual({
      queueOperationId: null,
      message:
        "No provider-backed Stripe cash refund remains uncovered by refund credit notes for this payment.",
    });

    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("caps a mixed-disposition delta at the cash evidence, not the mirror (#2902)", async () => {
    mocks.findUniquePayment.mockResolvedValue({
      id: "payment_1",
      bookingId: "booking_1",
      source: "STRIPE",
      // 9000 mirror = 4000 Stripe cash + 5000 account credit.
      refundedAmountCents: 9000,
      xeroRefundCreditNoteId: null,
    });
    mocks.sumCoveredRefundCreditNoteCents.mockResolvedValue(1000);
    mocks.resolveStripeCashRefundEvidence.mockResolvedValue({
      cashRefundCents: 4000,
      countedRefundCents: 4000,
      refundLedgerRowCount: 2,
      accountCreditCents: 0,
      source: "provider-ledger",
    });

    await enqueueXeroRefundCreditNoteOperation("payment_1", 9000);

    // min(requested 9000, cash 4000 − covered 1000) = 3000 — never the
    // mirror-based 8000. The watermark stays covered + note.
    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        requestPayload: {
          queueType: "REFUND_CREDIT_NOTE",
          refundAmountCents: 3000,
          watermarkCents: 4000,
        },
      })
    );
  });

  it("gives two equal Stripe deltas distinct watermark correlation keys", async () => {
    mocks.findUniquePayment.mockResolvedValue({
      id: "payment_1",
      source: "STRIPE",
      refundedAmountCents: 5000,
      xeroRefundCreditNoteId: null,
    });
    mocks.sumCoveredRefundCreditNoteCents.mockResolvedValue(0);
    await enqueueXeroRefundCreditNoteOperation("payment_1", 5000);

    mocks.findUniquePayment.mockResolvedValue({
      id: "payment_1",
      source: "STRIPE",
      refundedAmountCents: 10000,
      xeroRefundCreditNoteId: "cn_1",
    });
    mocks.sumCoveredRefundCreditNoteCents.mockResolvedValue(5000);
    await enqueueXeroRefundCreditNoteOperation("payment_1", 5000);

    const firstKey = mocks.startXeroSyncOperation.mock.calls[0][0].correlationKey;
    const secondKey = mocks.startXeroSyncOperation.mock.calls[1][0].correlationKey;
    expect(firstKey).toBe("payment:payment_1:refund-credit-note:5000:v2");
    expect(secondKey).toBe("payment:payment_1:refund-credit-note:10000:v2");
    expect(firstKey).not.toBe(secondKey);
  });

  it("keeps the legacy single-note skip for non-Stripe payments already linked", async () => {
    mocks.findUniquePayment.mockResolvedValue({
      id: "payment_1",
      source: "INTERNET_BANKING",
      refundedAmountCents: 5000,
      xeroRefundCreditNoteId: "cn_existing",
    });
    mocks.findCanonicalPaymentRefundCreditNote.mockResolvedValue({
      xeroObjectId: "cn_existing",
      xeroObjectNumber: "CN-1",
      source: "payment",
    });

    await expect(
      enqueueXeroRefundCreditNoteOperation("payment_1", 5000)
    ).resolves.toEqual({
      queueOperationId: null,
      message: "Xero refund credit note already linked for this payment.",
    });

    expect(mocks.sumCoveredRefundCreditNoteCents).not.toHaveBeenCalled();
    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("skips queueing when the webhook delta is zero", async () => {
    await expect(
      enqueueXeroRefundCreditNoteOperation("payment_1", 0)
    ).resolves.toEqual({
      queueOperationId: null,
      message: "No additional Xero refund credit note is required for this payment.",
    });

    expect(mocks.findCanonicalPaymentRefundCreditNote).not.toHaveBeenCalled();
    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });
});

describe("enqueueXeroAccountCreditNoteOperation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstLink.mockResolvedValue(null);
    mocks.findUniquePayment.mockResolvedValue({
      id: "payment_1",
    });
    mocks.findFirstOperation.mockResolvedValue(null);
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_account_credit_1" });
  });

  it("creates a pending primary Xero sync operation for account-credit notes", async () => {
    await expect(
      enqueueXeroAccountCreditNoteOperation("payment_1", 4200, {
        createdByMemberId: "admin_1",
      })
    ).resolves.toEqual({
      queueOperationId: "op_account_credit_1",
      message: "Xero account-credit note queued for background processing.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "OUTBOUND",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "Payment",
        localId: "payment_1",
        status: "PENDING",
        idempotencyKey: "payment:payment_1:unapplied-credit-note:4200:v1",
        correlationKey: "payment:payment_1:unapplied-credit-note:4200:v1",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "ACCOUNT_CREDIT_NOTE",
          refundAmountCents: 4200,
        },
      })
    );
  });

  it("skips queueing when the account-credit note is already linked", async () => {
    mocks.findFirstLink.mockResolvedValue({ id: "link_account_credit_1" });

    await expect(
      enqueueXeroAccountCreditNoteOperation("payment_1", 4200)
    ).resolves.toEqual({
      queueOperationId: null,
      message: "Xero account-credit note already linked for this payment.",
    });

    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("reads and enqueues through the supplied transaction store, leaving the global prisma client untouched", async () => {
    // Fresh store fns distinct from the global prisma mock so the assertions
    // below actually prove the store — not the global client — was used.
    const storePaymentFindUnique = vi.fn().mockResolvedValue({ id: "payment_1" });
    const storeLinkFindFirst = vi.fn().mockResolvedValue(null);
    const storeOperationFindFirst = vi.fn().mockResolvedValue(null);
    const store = {
      payment: { findUnique: storePaymentFindUnique },
      xeroObjectLink: { findFirst: storeLinkFindFirst },
      xeroSyncOperation: { findFirst: storeOperationFindFirst },
    } as unknown as Prisma.TransactionClient;

    await expect(
      enqueueXeroAccountCreditNoteOperation("payment_1", 4200, { store })
    ).resolves.toEqual({
      queueOperationId: "op_account_credit_1",
      message: "Xero account-credit note queued for background processing.",
    });

    // Every read went through the store.
    expect(storePaymentFindUnique).toHaveBeenCalledTimes(1);
    expect(storeLinkFindFirst).toHaveBeenCalledTimes(1);
    expect(storeOperationFindFirst).toHaveBeenCalledTimes(1);
    // The global prisma client was never touched.
    expect(mocks.findUniquePayment).not.toHaveBeenCalled();
    expect(mocks.findFirstLink).not.toHaveBeenCalled();
    expect(mocks.findFirstOperation).not.toHaveBeenCalled();
    // The store is threaded into the operation writer so the row commits in-tx.
    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "Payment",
        localId: "payment_1",
        store,
      })
    );
  });

  it("dedups on an existing queued operation read through the supplied store", async () => {
    const storePaymentFindUnique = vi.fn().mockResolvedValue({ id: "payment_1" });
    const storeLinkFindFirst = vi.fn().mockResolvedValue(null);
    const storeOperationFindFirst = vi
      .fn()
      .mockResolvedValue({ id: "existing_queued_op" });
    const store = {
      payment: { findUnique: storePaymentFindUnique },
      xeroObjectLink: { findFirst: storeLinkFindFirst },
      xeroSyncOperation: { findFirst: storeOperationFindFirst },
    } as unknown as Prisma.TransactionClient;

    await expect(
      enqueueXeroAccountCreditNoteOperation("payment_1", 4200, { store })
    ).resolves.toEqual({
      queueOperationId: "existing_queued_op",
      message: "Xero account-credit note is already queued for background processing.",
    });

    expect(storeOperationFindFirst).toHaveBeenCalledTimes(1);
    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
    expect(mocks.findFirstOperation).not.toHaveBeenCalled();
  });
});

describe("enqueueXeroModificationCreditNoteOperation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstLink.mockResolvedValue(null);
    mocks.findUniqueBooking.mockResolvedValue({
      id: "booking_1",
      payment: {
        xeroInvoiceId: "inv_existing",
      },
    });
    mocks.findFirstOperation.mockResolvedValue(null);
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_mod_credit_note_1" });
  });

  it("creates a pending Xero sync operation for modification credit notes", async () => {
    await expect(
      enqueueXeroModificationCreditNoteOperation(
        {
          bookingId: "booking_1",
          refundAmountCents: 3200,
          bookingModificationId: "mod_1",
        },
        {
          createdByMemberId: "admin_1",
        }
      )
    ).resolves.toEqual({
      queueOperationId: "op_mod_credit_note_1",
      message: "Xero modification credit note queued for background processing.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "OUTBOUND",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "BookingModification",
        localId: "mod_1",
        status: "PENDING",
        idempotencyKey: "booking-mod:mod_1:mod-credit-note:3200:v1",
        correlationKey: "booking-mod:mod_1:mod-credit-note:3200:v1",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "MODIFICATION_CREDIT_NOTE",
          bookingId: "booking_1",
          refundAmountCents: 3200,
          bookingModificationId: "mod_1",
        },
      })
    );
  });
});

describe("enqueueXeroModificationAccountCreditNoteOperation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstLink.mockResolvedValue(null);
    mocks.findUniqueBooking.mockResolvedValue({
      id: "booking_1",
      payment: {
        id: "payment_1",
      },
    });
    mocks.findFirstOperation.mockResolvedValue(null);
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_mod_account_credit_1" });
  });

  it("creates a pending Xero sync operation for modification account-credit notes", async () => {
    await expect(
      enqueueXeroModificationAccountCreditNoteOperation(
        {
          bookingId: "booking_1",
          refundAmountCents: 3750,
          bookingModificationId: "mod_1",
        },
        {
          createdByMemberId: "admin_1",
        }
      )
    ).resolves.toEqual({
      queueOperationId: "op_mod_account_credit_1",
      message: "Xero modification account-credit note queued for background processing.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "OUTBOUND",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "BookingModification",
        localId: "mod_1",
        status: "PENDING",
        idempotencyKey: "booking-mod:mod_1:mod-account-credit-note:3750:v1",
        correlationKey: "booking-mod:mod_1:mod-account-credit-note:3750:v1",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "MODIFICATION_ACCOUNT_CREDIT_NOTE",
          bookingId: "booking_1",
          paymentId: "payment_1",
          refundAmountCents: 3750,
          bookingModificationId: "mod_1",
        },
      })
    );
  });
});

describe("enqueueXeroCreditNoteAllocationOperation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstLink.mockResolvedValue(null);
    mocks.findFirstOperation.mockResolvedValue(null);
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_allocation_1" });
  });

  it("creates a pending Xero sync operation for credit-note allocations", async () => {
    await expect(
      enqueueXeroCreditNoteAllocationOperation(
        {
          localModel: "BookingModification",
          localId: "mod_1",
          creditNoteId: "cn_1",
          invoiceId: "inv_1",
          amountCents: 3200,
          role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
        },
        {
          createdByMemberId: "admin_1",
        }
      )
    ).resolves.toEqual({
      queueOperationId: "op_allocation_1",
      message: "Xero credit-note allocation queued for background processing.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "OUTBOUND",
        entityType: "ALLOCATION",
        operationType: "ALLOCATE",
        localModel: "BookingModification",
        localId: "mod_1",
        status: "PENDING",
        idempotencyKey:
          "credit-note:cn_1:invoice:inv_1:allocation:3200:MODIFICATION_CREDIT_NOTE_ALLOCATION:v1",
        correlationKey:
          "credit-note:cn_1:invoice:inv_1:allocation:3200:MODIFICATION_CREDIT_NOTE_ALLOCATION:v1",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "CREDIT_NOTE_ALLOCATION",
          creditNoteId: "cn_1",
          invoiceId: "inv_1",
          amountCents: 3200,
          role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
        },
      })
    );
  });
});

describe("membership cancellation Xero enqueue operations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstLink.mockResolvedValue(null);
    mocks.findFirstOperation.mockResolvedValue(null);
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_cancel_1" });
  });

  it("queues credit notes for unpaid current-season membership subscriptions", async () => {
    mocks.findUniqueMemberSubscription.mockResolvedValue({
      id: "sub_1",
      status: "UNPAID",
      xeroInvoiceId: "inv_sub_1",
    });

    await expect(
      enqueueXeroMembershipCancellationCreditNoteOperation(
        {
          subscriptionId: "sub_1",
          requestId: "request_1",
          participantId: "participant_1",
        },
        { createdByMemberId: "admin_1" }
      )
    ).resolves.toEqual({
      queueOperationId: "op_cancel_1",
      message: "Xero membership cancellation credit note queued for background processing.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "OUTBOUND",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "MemberSubscription",
        localId: "sub_1",
        status: "PENDING",
        idempotencyKey:
          "member-subscription:sub_1:membership-cancellation-credit:participant_1:v1",
        correlationKey:
          "member-subscription:sub_1:membership-cancellation-credit:participant_1:v1",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "MEMBERSHIP_CANCELLATION_CREDIT_NOTE",
          subscriptionId: "sub_1",
          requestId: "request_1",
          participantId: "participant_1",
        },
      })
    );
  });

  it("does not queue membership cancellation credit notes for paid subscriptions", async () => {
    mocks.findUniqueMemberSubscription.mockResolvedValue({
      id: "sub_1",
      status: "PAID",
      xeroInvoiceId: "inv_sub_1",
    });

    await expect(
      enqueueXeroMembershipCancellationCreditNoteOperation({
        subscriptionId: "sub_1",
        requestId: "request_1",
        participantId: "participant_1",
      })
    ).resolves.toEqual({
      queueOperationId: null,
      message: "No Xero membership cancellation credit note is required for this subscription status.",
    });

    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("queues contact cleanup when the cancelling member has a Xero contact", async () => {
    mocks.findUniqueMember.mockResolvedValue({
      id: "member_1",
      xeroContactId: "contact_1",
    });

    await expect(
      enqueueXeroMembershipCancellationContactOperation(
        {
          memberId: "member_1",
          requestId: "request_1",
          participantId: "participant_1",
        },
        { createdByMemberId: "admin_1" }
      )
    ).resolves.toEqual({
      queueOperationId: "op_cancel_1",
      message: "Xero membership cancellation contact cleanup queued for background processing.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "OUTBOUND",
        entityType: "CONTACT",
        operationType: "UPDATE",
        localModel: "MembershipCancellationRequestParticipant",
        localId: "participant_1",
        status: "PENDING",
        idempotencyKey:
          "membership-cancellation:participant_1:contact:member_1:v1",
        correlationKey:
          "membership-cancellation:participant_1:contact:member_1:v1",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "MEMBERSHIP_CANCELLATION_CONTACT",
          memberId: "member_1",
          requestId: "request_1",
          participantId: "participant_1",
        },
      })
    );
  });
});

describe("enqueueXeroGroupSettlementInvoiceOperation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstLink.mockResolvedValue(null);
    mocks.findUniqueGroupSettlement.mockResolvedValue({
      id: "settle_1",
      xeroInvoiceId: null,
    });
    mocks.findFirstOperation.mockResolvedValue(null);
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_settle_1" });
  });

  it("creates a pending invoice sync operation against the settlement", async () => {
    await expect(
      enqueueXeroGroupSettlementInvoiceOperation("settle_1", {
        createdByMemberId: "admin_1",
      })
    ).resolves.toEqual({
      queueOperationId: "op_settle_1",
      message: "Xero settlement invoice queued for background processing.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "OUTBOUND",
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "GroupBookingSettlement",
        localId: "settle_1",
        status: "PENDING",
        idempotencyKey: "group-settlement:settle_1:invoice:v1",
        correlationKey: "group-settlement:settle_1:invoice:v1",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "GROUP_SETTLEMENT_INVOICE",
          settlementId: "settle_1",
        },
      })
    );
  });

  it("skips queueing when the settlement already carries an invoice", async () => {
    mocks.findUniqueGroupSettlement.mockResolvedValue({
      id: "settle_1",
      xeroInvoiceId: "xinv_existing",
    });

    await expect(
      enqueueXeroGroupSettlementInvoiceOperation("settle_1")
    ).resolves.toEqual({
      queueOperationId: null,
      message: "Xero settlement invoice already linked for this group.",
    });
    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });
});

describe("processQueuedXeroOutboxOperations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateManyOperation.mockResolvedValue({ count: 1 });
  });

  it("scans the pending outbox by the indexed queueType column, not a requestPayload JSON predicate (#1272)", async () => {
    mocks.findManyOperations.mockResolvedValue([]);

    await processQueuedXeroOutboxOperations({ limit: 7 });

    expect(mocks.findManyOperations).toHaveBeenCalledTimes(1);
    const args = mocks.findManyOperations.mock.calls[0][0];
    // The scan now filters on the denormalized `queueType` column via the
    // single-source-of-truth list, keeping status/direction/order/limit intact.
    expect(args.where).toEqual({
      status: "PENDING",
      direction: "OUTBOUND",
      queueType: { in: [...XERO_OUTBOX_QUEUE_TYPES] },
    });
    expect(args.where.queueType.in).toHaveLength(16);
    // The legacy `requestPayload->>'queueType'` OR predicate is gone.
    expect(args.where.OR).toBeUndefined();
    expect(JSON.stringify(args.where)).not.toContain("requestPayload");
    expect(args.orderBy).toEqual({ createdAt: "asc" });
    expect(args.take).toBe(7);
  });

  it("returns a simultaneous applied-credit loser to PENDING instead of stranding it FAILED", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_alloc_busy",
        localId: "payment_1",
        localModel: "Payment",
        createdByMemberId: null,
        requestPayload: {
          queueType: "APPLIED_CREDIT_ALLOCATION",
          bookingId: "booking_1",
        },
      },
      {
        id: "op_dealloc_busy",
        localId: "payment_1",
        localModel: "Payment",
        createdByMemberId: null,
        requestPayload: {
          queueType: "APPLIED_CREDIT_DEALLOCATION",
          bookingId: "booking_1",
        },
      },
    ]);
    mocks.deallocateExcessAppliedCreditForBooking.mockRejectedValue(
      new XeroAppliedCreditOperationBusyError("allocation op is already running")
    );
    mocks.allocateAppliedCreditForBooking.mockRejectedValue(
      new XeroAppliedCreditOperationBusyError("deallocation op is already running")
    );

    await expect(processQueuedXeroOutboxOperations({ limit: 5 })).resolves.toEqual({
      found: 2,
      processed: 2,
      succeeded: 0,
      failed: 0,
      skipped: 2,
    });

    for (const id of ["op_alloc_busy", "op_dealloc_busy"]) {
      expect(mocks.updateManyOperation).toHaveBeenCalledWith({
        where: { id, status: "RUNNING" },
        data: {
          status: "PENDING",
          startedAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      });
    }
    expect(mocks.failXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("busy-requeues a manual retry, then executes its checkpointed deallocation once", async () => {
    const queued = {
      id: "op_dealloc_retry",
      localId: "payment_1",
      localModel: "Payment",
      createdByMemberId: null,
      requestPayload: {
        queueType: "APPLIED_CREDIT_DEALLOCATION",
        bookingId: "booking_1",
        checkpoint: { allocationIds: ["alloc-1"], phase: "BEFORE_DELETE" },
      },
    };
    mocks.findManyOperations.mockResolvedValue([queued]);
    mocks.deallocateExcessAppliedCreditForBooking
      .mockRejectedValueOnce(
        new XeroAppliedCreditOperationBusyError(
          "same-payment allocation is RUNNING",
        ),
      )
      .mockResolvedValueOnce(undefined);

    await expect(processQueuedXeroOutboxOperations({ limit: 1 })).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 0,
      failed: 0,
      skipped: 1,
    });
    expect(mocks.updateManyOperation).toHaveBeenCalledWith({
      where: { id: "op_dealloc_retry", status: "RUNNING" },
      data: {
        status: "PENDING",
        startedAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });

    await expect(processQueuedXeroOutboxOperations({ limit: 1 })).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });
    expect(mocks.deallocateExcessAppliedCreditForBooking).toHaveBeenCalledTimes(2);
    expect(mocks.deallocateExcessAppliedCreditForBooking).toHaveBeenLastCalledWith(
      "booking_1",
      { syncOperationId: "op_dealloc_retry" },
    );
    expect(mocks.failXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("claims and processes queued entrance fee operations", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_entrance_1",
        localId: "member_1",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "ENTRANCE_FEE_INVOICE",
          category: "ADULT",
          itemCode: "EF-ADULT",
          feeAmountCents: 15000,
        },
      },
    ]);
    mocks.createXeroEntranceFeeInvoice.mockResolvedValue("inv_1");

    await expect(processQueuedXeroOutboxOperations({ limit: 5 })).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.createXeroEntranceFeeInvoice).toHaveBeenCalledWith("member_1", {
      createdByMemberId: "admin_1",
      syncOperationId: "op_entrance_1",
      precomputedEntranceFee: {
        category: "ADULT",
        feeMapping: {
          itemCode: "EF-ADULT",
          amountCents: 15000,
        },
      },
    });
  });

  it("claims and processes queued booking invoice operations", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_booking_1",
        localId: "payment_1",
        localModel: "Payment",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "BOOKING_INVOICE",
          bookingId: "booking_1",
        },
      },
    ]);
    mocks.createXeroInvoiceForBooking.mockResolvedValue("inv_1");

    await expect(processQueuedXeroOutboxOperations({ limit: 5 })).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.createXeroInvoiceForBooking).toHaveBeenCalledWith("booking_1", {
      createdByMemberId: "admin_1",
      syncOperationId: "op_booking_1",
    });
  });

  it("claims and processes queued group settlement invoice operations", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_settle_1",
        localId: "settle_1",
        localModel: "GroupBookingSettlement",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "GROUP_SETTLEMENT_INVOICE",
          settlementId: "settle_1",
        },
      },
    ]);
    mocks.createXeroInvoiceForGroupSettlement.mockResolvedValue("xinv_1");

    await expect(processQueuedXeroOutboxOperations({ limit: 5 })).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.createXeroInvoiceForGroupSettlement).toHaveBeenCalledWith(
      "settle_1",
      {
        createdByMemberId: "admin_1",
        syncOperationId: "op_settle_1",
      }
    );
  });

  it("claims and processes queued booking invoice update operations", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_booking_update_1",
        localId: "payment_1",
        localModel: "Payment",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "BOOKING_INVOICE_UPDATE",
          bookingId: "booking_1",
          xeroInvoiceId: "inv_existing",
        },
      },
    ]);
    mocks.updateXeroBookingInvoiceForBooking.mockResolvedValue("inv_existing");

    await expect(processQueuedXeroOutboxOperations({ limit: 5 })).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.updateXeroBookingInvoiceForBooking).toHaveBeenCalledWith("booking_1", {
      createdByMemberId: "admin_1",
      syncOperationId: "op_booking_update_1",
    });
    expect(mocks.updateManyOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          entityType: "INVOICE",
          operationType: "UPDATE",
        }),
      })
    );
  });

  it("claims and processes queued refund credit note operations, forwarding the watermark", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_credit_note_1",
        localId: "payment_1",
        localModel: "Payment",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "REFUND_CREDIT_NOTE",
          refundAmountCents: 3000,
          watermarkCents: 8000,
        },
      },
    ]);
    mocks.createXeroCreditNote.mockResolvedValue("cn_1");

    await expect(processQueuedXeroOutboxOperations({ limit: 5 })).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.createXeroCreditNote).toHaveBeenCalledWith("payment_1", 3000, {
      createdByMemberId: "admin_1",
      syncOperationId: "op_credit_note_1",
      watermarkCents: 8000,
    });
  });

  it("claims and processes queued account-credit note operations", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_account_credit_1",
        localId: "payment_1",
        localModel: "Payment",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "ACCOUNT_CREDIT_NOTE",
          refundAmountCents: 4200,
        },
      },
    ]);
    mocks.createUnappliedXeroCreditNote.mockResolvedValue("cn_account_1");

    await expect(processQueuedXeroOutboxOperations({ limit: 5 })).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.createUnappliedXeroCreditNote).toHaveBeenCalledWith("payment_1", 4200, {
      createdByMemberId: "admin_1",
      syncOperationId: "op_account_credit_1",
    });
  });

  it("claims and processes queued supplementary invoice operations", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_supplementary_1",
        localId: "mod_1",
        localModel: "BookingModification",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "SUPPLEMENTARY_INVOICE",
          bookingId: "booking_1",
          priceDiffCents: 2500,
          changeFeeCents: 500,
          bookingModificationId: "mod_1",
        },
      },
    ]);
    mocks.createXeroSupplementaryInvoice.mockResolvedValue("inv_2");

    await expect(processQueuedXeroOutboxOperations({ limit: 5 })).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.createXeroSupplementaryInvoice).toHaveBeenCalledWith({
      bookingId: "booking_1",
      priceDiffCents: 2500,
      changeFeeCents: 500,
      bookingModificationId: "mod_1",
      recordPayment: true,
      createdByMemberId: "admin_1",
      syncOperationId: "op_supplementary_1",
    });
  });

  it("claims and processes queued modification credit note operations", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_mod_credit_note_1",
        localId: "mod_1",
        localModel: "BookingModification",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "MODIFICATION_CREDIT_NOTE",
          bookingId: "booking_1",
          refundAmountCents: 3200,
          bookingModificationId: "mod_1",
        },
      },
    ]);
    mocks.createXeroCreditNoteForModification.mockResolvedValue("cn_2");

    await expect(processQueuedXeroOutboxOperations({ limit: 5 })).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.createXeroCreditNoteForModification).toHaveBeenCalledWith({
      bookingId: "booking_1",
      refundAmountCents: 3200,
      bookingModificationId: "mod_1",
      createdByMemberId: "admin_1",
      syncOperationId: "op_mod_credit_note_1",
    });
  });

  it("claims and processes queued credit-note allocation operations", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_allocation_1",
        localId: "mod_1",
        localModel: "BookingModification",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "CREDIT_NOTE_ALLOCATION",
          creditNoteId: "cn_1",
          invoiceId: "inv_1",
          amountCents: 3200,
          role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
        },
      },
    ]);
    mocks.allocateCreditNoteToInvoice.mockResolvedValue(undefined);

    await expect(processQueuedXeroOutboxOperations({ limit: 5 })).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.allocateCreditNoteToInvoice).toHaveBeenCalledWith(
      "cn_1",
      "inv_1",
      3200,
      {
        localModel: "BookingModification",
        localId: "mod_1",
        role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
        createdByMemberId: "admin_1",
        syncOperationId: "op_allocation_1",
      }
    );
  });

  it("claims and processes queued membership cancellation credit notes", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_membership_cancel_credit_1",
        localId: "sub_1",
        localModel: "MemberSubscription",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "MEMBERSHIP_CANCELLATION_CREDIT_NOTE",
          subscriptionId: "sub_1",
          requestId: "request_1",
          participantId: "participant_1",
        },
      },
    ]);
    mocks.createXeroMembershipCancellationCreditNote.mockResolvedValue("cn_sub_1");

    await expect(processQueuedXeroOutboxOperations({ limit: 5 })).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.createXeroMembershipCancellationCreditNote).toHaveBeenCalledWith({
      subscriptionId: "sub_1",
      requestId: "request_1",
      participantId: "participant_1",
      createdByMemberId: "admin_1",
      syncOperationId: "op_membership_cancel_credit_1",
    });
    expect(mocks.updateManyOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          entityType: "CREDIT_NOTE",
          operationType: "CREATE",
          localModel: { in: ["MemberSubscription"] },
        }),
      })
    );
  });

  it("claims and processes queued membership cancellation contact cleanup", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_membership_cancel_contact_1",
        localId: "participant_1",
        localModel: "MembershipCancellationRequestParticipant",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "MEMBERSHIP_CANCELLATION_CONTACT",
          memberId: "member_1",
          requestId: "request_1",
          participantId: "participant_1",
        },
      },
    ]);
    mocks.syncXeroMembershipCancellationContact.mockResolvedValue({
      memberId: "member_1",
      xeroContactId: "contact_1",
      addedGroupIds: ["cancelled_group"],
      removedGroupIds: ["adult_group"],
      archived: true,
      skippedReason: null,
    });

    await expect(processQueuedXeroOutboxOperations({ limit: 5 })).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.syncXeroMembershipCancellationContact).toHaveBeenCalledWith({
      memberId: "member_1",
      requestId: "request_1",
      participantId: "participant_1",
      createdByMemberId: "admin_1",
      syncOperationId: "op_membership_cancel_contact_1",
    });
    expect(mocks.updateManyOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          entityType: "CONTACT",
          operationType: "UPDATE",
          localModel: { in: ["MembershipCancellationRequestParticipant"] },
        }),
      })
    );
  });

  it("fails malformed queued payloads", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_entrance_1",
        localModel: "Member",
        localId: "member_1",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "ENTRANCE_FEE_INVOICE",
        },
      },
    ]);

    await expect(processQueuedXeroOutboxOperations()).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 0,
      failed: 1,
      skipped: 0,
    });

    expect(mocks.createXeroEntranceFeeInvoice).not.toHaveBeenCalled();
    expect(mocks.failXeroSyncOperation).toHaveBeenCalledWith(
      "op_entrance_1",
      expect.objectContaining({
        message: "Queued Xero outbox payload is incomplete.",
      })
    );
  });

  it("skips a row it loses the claim race for (updateMany matched zero PENDING rows)", async () => {
    // A concurrent worker already flipped the row out of PENDING, so the
    // conditional claim matches nothing. The single-flight must then skip the
    // row (never dispatch its money-moving handler) rather than double-run it.
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_booking_1",
        localId: "payment_1",
        localModel: "Payment",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "BOOKING_INVOICE",
          bookingId: "booking_1",
        },
      },
    ]);
    mocks.updateManyOperation.mockResolvedValue({ count: 0 });

    await expect(processQueuedXeroOutboxOperations({ limit: 5 })).resolves.toEqual({
      found: 1,
      processed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 1,
    });

    expect(mocks.createXeroInvoiceForBooking).not.toHaveBeenCalled();
  });
});

describe("processQueuedXeroOutboxOperations dispatch domain (#1272)", () => {
  // Directly exercises the real if/else dispatch chain inside
  // `processQueuedXeroOutboxOperations` (not the parallel expected-operation
  // map). Feeding a valid op per queue type and asserting it routes to a
  // handler proves the chain covers exactly `XERO_OUTBOX_QUEUE_TYPES` — closing
  // the gap PR-a's map-based proxy left open. Residual (accepted, per #1272): an
  // orphan dispatch branch for a queueType NOT in the constant is dead code the
  // column scan never surfaces, so a pure black-box test cannot observe it.
  type OutboxFixture = {
    op: {
      id: string;
      localId?: string | null;
      localModel?: string | null;
      createdByMemberId?: string | null;
      requestPayload: Record<string, unknown>;
    };
    handler: ReturnType<typeof vi.fn>;
  };

  const fixtures: Record<
    (typeof XERO_OUTBOX_QUEUE_TYPES)[number],
    OutboxFixture
  > = {
    ENTRANCE_FEE_INVOICE: {
      op: {
        id: "op_entrance_1",
        localId: "member_1",
        localModel: "Member",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "ENTRANCE_FEE_INVOICE",
          category: "ADULT",
          itemCode: "EF-ADULT",
          feeAmountCents: 15000,
        },
      },
      handler: mocks.createXeroEntranceFeeInvoice,
    },
    BOOKING_INVOICE: {
      op: {
        id: "op_booking_1",
        localId: "payment_1",
        localModel: "Payment",
        createdByMemberId: "admin_1",
        requestPayload: { queueType: "BOOKING_INVOICE", bookingId: "booking_1" },
      },
      handler: mocks.createXeroInvoiceForBooking,
    },
    BOOKING_INVOICE_UPDATE: {
      op: {
        id: "op_booking_update_1",
        localId: "payment_1",
        localModel: "Payment",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "BOOKING_INVOICE_UPDATE",
          bookingId: "booking_1",
          xeroInvoiceId: "inv_existing",
        },
      },
      handler: mocks.updateXeroBookingInvoiceForBooking,
    },
    REFUND_CREDIT_NOTE: {
      op: {
        id: "op_credit_note_1",
        localId: "payment_1",
        localModel: "Payment",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "REFUND_CREDIT_NOTE",
          refundAmountCents: 3000,
          watermarkCents: 8000,
        },
      },
      handler: mocks.createXeroCreditNote,
    },
    ACCOUNT_CREDIT_NOTE: {
      op: {
        id: "op_account_credit_1",
        localId: "payment_1",
        localModel: "Payment",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "ACCOUNT_CREDIT_NOTE",
          refundAmountCents: 4200,
        },
      },
      handler: mocks.createUnappliedXeroCreditNote,
    },
    SUPPLEMENTARY_INVOICE: {
      op: {
        id: "op_supplementary_1",
        localId: "mod_1",
        localModel: "BookingModification",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "SUPPLEMENTARY_INVOICE",
          bookingId: "booking_1",
          priceDiffCents: 2500,
          changeFeeCents: 500,
          bookingModificationId: "mod_1",
        },
      },
      handler: mocks.createXeroSupplementaryInvoice,
    },
    MODIFICATION_CREDIT_NOTE: {
      op: {
        id: "op_mod_credit_note_1",
        localId: "mod_1",
        localModel: "BookingModification",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "MODIFICATION_CREDIT_NOTE",
          bookingId: "booking_1",
          refundAmountCents: 3200,
          bookingModificationId: "mod_1",
        },
      },
      handler: mocks.createXeroCreditNoteForModification,
    },
    MODIFICATION_ACCOUNT_CREDIT_NOTE: {
      op: {
        id: "op_mod_account_credit_1",
        localId: "mod_1",
        localModel: "BookingModification",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "MODIFICATION_ACCOUNT_CREDIT_NOTE",
          bookingId: "booking_1",
          paymentId: "payment_1",
          refundAmountCents: 3750,
          bookingModificationId: "mod_1",
        },
      },
      handler: mocks.createUnappliedXeroCreditNoteForModification,
    },
    CREDIT_NOTE_ALLOCATION: {
      op: {
        id: "op_allocation_1",
        localId: "mod_1",
        localModel: "BookingModification",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "CREDIT_NOTE_ALLOCATION",
          creditNoteId: "cn_1",
          invoiceId: "inv_1",
          amountCents: 3200,
          role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
        },
      },
      handler: mocks.allocateCreditNoteToInvoice,
    },
    APPLIED_CREDIT_ALLOCATION: {
      op: {
        id: "op_applied_credit_alloc_1",
        localId: "payment_1",
        localModel: "Payment",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "APPLIED_CREDIT_ALLOCATION",
          bookingId: "booking_1",
        },
      },
      handler: mocks.allocateAppliedCreditForBooking,
    },
    APPLIED_CREDIT_DEALLOCATION: {
      op: {
        id: "op_applied_credit_dealloc_1",
        localId: "payment_1",
        localModel: "Payment",
        requestPayload: { queueType: "APPLIED_CREDIT_DEALLOCATION", bookingId: "booking_1" },
      },
      handler: mocks.deallocateExcessAppliedCreditForBooking,
    },
    MEMBERSHIP_CANCELLATION_CREDIT_NOTE: {
      op: {
        id: "op_membership_cancel_credit_1",
        localId: "sub_1",
        localModel: "MemberSubscription",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "MEMBERSHIP_CANCELLATION_CREDIT_NOTE",
          subscriptionId: "sub_1",
          requestId: "request_1",
          participantId: "participant_1",
        },
      },
      handler: mocks.createXeroMembershipCancellationCreditNote,
    },
    MEMBERSHIP_CANCELLATION_CONTACT: {
      op: {
        id: "op_membership_cancel_contact_1",
        localId: "participant_1",
        localModel: "MembershipCancellationRequestParticipant",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "MEMBERSHIP_CANCELLATION_CONTACT",
          memberId: "member_1",
          requestId: "request_1",
          participantId: "participant_1",
        },
      },
      handler: mocks.syncXeroMembershipCancellationContact,
    },
    GROUP_SETTLEMENT_INVOICE: {
      op: {
        id: "op_settle_1",
        localId: "settle_1",
        localModel: "GroupBookingSettlement",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "GROUP_SETTLEMENT_INVOICE",
          settlementId: "settle_1",
        },
      },
      handler: mocks.createXeroInvoiceForGroupSettlement,
    },
    GROUP_SETTLEMENT_INVOICE_VOID: {
      op: {
        id: "op_settle_void_1",
        localId: "settle_1",
        localModel: "GroupBookingSettlement",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "GROUP_SETTLEMENT_INVOICE_VOID",
          settlementId: "settle_1",
        },
      },
      handler: mocks.voidXeroInvoiceForCancelledGroupSettlement,
    },
    MEMBERSHIP_SUBSCRIPTION_INVOICE: {
      op: {
        id: "op_subscription_charge_1",
        localId: "charge_1",
        localModel: "MembershipSubscriptionCharge",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "MEMBERSHIP_SUBSCRIPTION_INVOICE",
          chargeId: "charge_1",
        },
      },
      handler: mocks.createXeroMembershipSubscriptionInvoice,
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateManyOperation.mockResolvedValue({ count: 1 });
    // Every dispatch target resolves so a routed op reports success.
    mocks.createXeroEntranceFeeInvoice.mockResolvedValue("inv");
    mocks.createXeroInvoiceForBooking.mockResolvedValue("inv");
    mocks.updateXeroBookingInvoiceForBooking.mockResolvedValue("inv");
    mocks.createXeroCreditNote.mockResolvedValue("cn");
    mocks.createUnappliedXeroCreditNote.mockResolvedValue("cn");
    mocks.createXeroSupplementaryInvoice.mockResolvedValue("inv");
    mocks.createXeroCreditNoteForModification.mockResolvedValue("cn");
    mocks.createUnappliedXeroCreditNoteForModification.mockResolvedValue("cn");
    mocks.allocateCreditNoteToInvoice.mockResolvedValue(undefined);
    mocks.allocateAppliedCreditForBooking.mockResolvedValue(undefined);
    mocks.deallocateExcessAppliedCreditForBooking.mockResolvedValue(undefined);
    mocks.createXeroMembershipCancellationCreditNote.mockResolvedValue("cn");
    mocks.syncXeroMembershipCancellationContact.mockResolvedValue({
      memberId: "member_1",
      xeroContactId: "contact_1",
      addedGroupIds: [],
      removedGroupIds: [],
      archived: true,
      skippedReason: null,
    });
    mocks.createXeroInvoiceForGroupSettlement.mockResolvedValue("inv");
    mocks.voidXeroInvoiceForCancelledGroupSettlement.mockResolvedValue(undefined);
    mocks.createXeroMembershipSubscriptionInvoice.mockResolvedValue("inv");
  });

  it("has one dispatch fixture for every queue type and no extras", () => {
    expect(Object.keys(fixtures).sort()).toEqual(
      [...XERO_OUTBOX_QUEUE_TYPES].sort()
    );
  });

  it("routes each XERO_OUTBOX_QUEUE_TYPES member through the real dispatch chain to its own handler", async () => {
    for (const queueType of XERO_OUTBOX_QUEUE_TYPES) {
      const fixture = fixtures[queueType];
      mocks.findManyOperations.mockResolvedValue([fixture.op]);

      const result = await processQueuedXeroOutboxOperations({ limit: 1 });

      // succeeded:1 means it reached a concrete handler; the else-branch throw
      // ("payload is incomplete") would have produced failed:1 instead.
      expect(result).toEqual({
        found: 1,
        processed: 1,
        succeeded: 1,
        failed: 0,
        skipped: 0,
      });
      // Each queue type has a distinct handler, so exactly-once across the loop
      // proves the chain routed this type to the right one.
      expect(fixture.handler).toHaveBeenCalledTimes(1);
    }

    // No queue type slipped through to the incomplete-payload failure.
    expect(mocks.failXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("routes nothing outside the constant: representative non-members hit the incomplete-payload fallthrough", async () => {
    // REQUEUE/BACKFILL carry no outbox queueType and must never be dispatched by
    // this scan; a synthetic unknown stands in for a future stray type. All three
    // reach the else-branch, so none of the money-moving handlers fire.
    mocks.findManyOperations.mockResolvedValue([
      { id: "op_requeue", requestPayload: { queueType: "REQUEUE" } },
      { id: "op_backfill", requestPayload: { queueType: "BACKFILL" } },
      { id: "op_unknown", requestPayload: { queueType: "TOTALLY_NEW_TYPE" } },
    ]);

    await expect(processQueuedXeroOutboxOperations({ limit: 5 })).resolves.toEqual({
      found: 3,
      processed: 3,
      succeeded: 0,
      failed: 3,
      skipped: 0,
    });

    for (const fixture of Object.values(fixtures)) {
      expect(fixture.handler).not.toHaveBeenCalled();
    }
  });
});

describe("reapStaleWaitingPaymentXeroOutboxOperations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstPaymentTransaction.mockResolvedValue(null);
    mocks.updateManyOperation.mockResolvedValue({ count: 0 });
  });

  it("reaps WAITING_PAYMENT operations whose linked PaymentTransaction has been FAILED past the grace window", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_waiting_1",
        createdAt: new Date(),
        requestPayload: { paymentIntentId: "pi_failed_abc" },
      },
    ]);
    mocks.findFirstPaymentTransaction.mockResolvedValue({ id: "txn-failed" });
    mocks.updateManyOperation.mockResolvedValue({ count: 1 });

    const result = await reapStaleWaitingPaymentXeroOutboxOperations();

    // F19 (#1887): the FAILED lookup is now floored by a 24h grace on updatedAt
    // so a not-yet-retried failure cannot be cancelled out from under a
    // same-intent retry that is about to succeed.
    expect(mocks.findFirstPaymentTransaction).toHaveBeenCalledWith({
      where: {
        source: "STRIPE",
        stripePaymentIntentId: "pi_failed_abc",
        status: "FAILED",
        updatedAt: { lte: expect.any(Date) },
      },
      select: { id: true },
    });
    const graceThreshold =
      mocks.findFirstPaymentTransaction.mock.calls[0][0].where.updatedAt.lte;
    // ~24h ago (allow a generous window for test execution time).
    const hoursAgo = (Date.now() - graceThreshold.getTime()) / (60 * 60 * 1000);
    expect(hoursAgo).toBeGreaterThan(23.9);
    expect(hoursAgo).toBeLessThan(24.5);
    expect(mocks.updateManyOperation).toHaveBeenCalledWith({
      where: {
        id: { in: ["op_waiting_1"] },
        status: "WAITING_PAYMENT",
      },
      data: expect.objectContaining({
        status: "CANCELLED",
        lastErrorCode: "STALE_WAITING_PAYMENT",
      }),
    });
    expect(result).toEqual({
      reaped: 1,
      queueOperationIds: ["op_waiting_1"],
    });
  });

  it("does NOT reap a WAITING_PAYMENT op whose linked transaction failed inside the grace window (F19, #1887)", async () => {
    // A FAILED transaction that is still inside the grace window returns no row
    // from the floored query (the DB predicate excludes it), so the op survives
    // for the member's same-intent retry to succeed against.
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_waiting_recent_fail",
        createdAt: new Date(),
        requestPayload: { paymentIntentId: "pi_recent_fail" },
      },
    ]);
    mocks.findFirstPaymentTransaction.mockResolvedValue(null);

    const result = await reapStaleWaitingPaymentXeroOutboxOperations();

    expect(mocks.findFirstPaymentTransaction).toHaveBeenCalledWith({
      where: {
        source: "STRIPE",
        stripePaymentIntentId: "pi_recent_fail",
        status: "FAILED",
        updatedAt: { lte: expect.any(Date) },
      },
      select: { id: true },
    });
    expect(result.reaped).toBe(0);
    expect(mocks.updateManyOperation).not.toHaveBeenCalled();
  });

  it("honours a custom failedTransactionGraceHours override (F19, #1887)", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_waiting_custom",
        createdAt: new Date(),
        requestPayload: { paymentIntentId: "pi_custom" },
      },
    ]);
    mocks.findFirstPaymentTransaction.mockResolvedValue({ id: "txn-failed" });
    mocks.updateManyOperation.mockResolvedValue({ count: 1 });

    await reapStaleWaitingPaymentXeroOutboxOperations({
      failedTransactionGraceHours: 1,
    });

    const graceThreshold =
      mocks.findFirstPaymentTransaction.mock.calls[0][0].where.updatedAt.lte;
    const hoursAgo = (Date.now() - graceThreshold.getTime()) / (60 * 60 * 1000);
    expect(hoursAgo).toBeGreaterThan(0.9);
    expect(hoursAgo).toBeLessThan(1.5);
  });

  it("reaps WAITING_PAYMENT operations older than the staleness threshold", async () => {
    const sixteenDaysAgo = new Date(Date.now() - 16 * 24 * 60 * 60 * 1000);
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_waiting_old",
        createdAt: sixteenDaysAgo,
        requestPayload: { paymentIntentId: "pi_still_pending" },
      },
    ]);
    mocks.updateManyOperation.mockResolvedValue({ count: 1 });

    const result = await reapStaleWaitingPaymentXeroOutboxOperations();

    expect(mocks.findFirstPaymentTransaction).not.toHaveBeenCalled();
    expect(mocks.updateManyOperation).toHaveBeenCalledWith({
      where: {
        id: { in: ["op_waiting_old"] },
        status: "WAITING_PAYMENT",
      },
      data: expect.objectContaining({
        status: "CANCELLED",
        lastErrorCode: "STALE_WAITING_PAYMENT",
      }),
    });
    expect(result.reaped).toBe(1);
  });

  it("leaves recent WAITING_PAYMENT operations with active payments alone", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_waiting_fresh",
        createdAt: new Date(),
        requestPayload: { paymentIntentId: "pi_still_active" },
      },
    ]);
    mocks.findFirstPaymentTransaction.mockResolvedValue(null);

    const result = await reapStaleWaitingPaymentXeroOutboxOperations();

    expect(result.reaped).toBe(0);
    expect(mocks.updateManyOperation).not.toHaveBeenCalled();
  });
});

/**
 * #3170 (epic #2797): ONE EDIT, ONE ASK, on the Xero side.
 *
 * A booking edit whose money could not be valued can raise two review tasks, and
 * an officer may settle both as money owed to the club. The owner's decision is
 * that both contribute to a single request for the total, so the supplementary
 * invoice has to bill $230 rather than $200 and then $30. Queueing the second one
 * is not an option: `enqueueXeroSupplementaryInvoiceOperation` refuses an anchor
 * that already has an active SUPPLEMENTARY_INVOICE link and returns a MESSAGE
 * rather than an error, so the second share would be dropped in silence.
 */
describe("restatePendingSupplementaryInvoiceAmount (#3170)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateManyOperation.mockResolvedValue({ count: 1 });
  });

  function waitingOperation(overrides: Record<string, unknown> = {}) {
    return {
      id: "op_supplementary_1",
      requestPayload: {
        queueType: "SUPPLEMENTARY_INVOICE",
        bookingId: "booking_1",
        priceDiffCents: 20000,
        changeFeeCents: 0,
        bookingModificationId: "mod_1",
        recordPayment: true,
        paymentIntentId: "pi_additional_1",
        waitForConfirmedAdditionalPayment: true,
      },
      ...overrides,
    };
  }

  it("raises the queued invoice to the combined total, key and all", async () => {
    mocks.findManyOperations.mockResolvedValue([waitingOperation()]);

    await expect(
      restatePendingSupplementaryInvoiceAmount({
        bookingModificationId: "mod_1",
        priceDiffCents: 23000,
        changeFeeCents: 0,
      })
    ).resolves.toEqual({ restated: 1, alreadyCovering: 0 });

    expect(mocks.updateManyOperation).toHaveBeenCalledWith({
      where: {
        id: "op_supplementary_1",
        // #3170 fix round (F3): the SAME status predicate the read used. An
        // operation the outbox claimed between the two statements matches
        // nothing here, so the write cannot contradict an ask already going out.
        status: { in: ["PENDING", "WAITING_PAYMENT"] },
      },
      data: {
        requestPayload: expect.objectContaining({
          priceDiffCents: 23000,
          changeFeeCents: 0,
          // Everything else the operation was carrying survives - in particular
          // the intent it is waiting on, without which the payment webhook can
          // never release it.
          paymentIntentId: "pi_additional_1",
          waitForConfirmedAdditionalPayment: true,
        }),
        // The correlation key is built FROM the amount, so leaving it stale would
        // let a later enqueue for the new total find no match and queue a
        // duplicate.
        idempotencyKey: "booking-mod:mod_1:supplementary-invoice:23000:0:v1",
        correlationKey: "booking-mod:mod_1:supplementary-invoice:23000:0:v1",
      },
    });
  });

  it("only looks at operations that have not run yet", async () => {
    mocks.findManyOperations.mockResolvedValue([]);

    await restatePendingSupplementaryInvoiceAmount({
      bookingModificationId: "mod_1",
      priceDiffCents: 23000,
      changeFeeCents: 0,
    });

    // PENDING and WAITING_PAYMENT are the two states in which nothing has reached
    // Xero, so restating changes what WILL be billed rather than contradicting
    // what was. A RUNNING, SUCCEEDED or FAILED operation is left alone and the
    // caller's pre-claim refusal is what stops a share reaching an ask already
    // sent.
    expect(mocks.findManyOperations).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ["PENDING", "WAITING_PAYMENT"] },
          localModel: "BookingModification",
          localId: "mod_1",
          operationType: "CREATE",
          entityType: "INVOICE",
        }),
      })
    );
  });

  /**
   * #3170 fix round (F3). The test above asserted the READ filter and stopped
   * there, which is exactly how the write came to carry no filter at all: the
   * docblock said "only operations that have not run yet" and half the function
   * obeyed it. A row that left PENDING between the read and the write is a row
   * the outbox is already sending, and rewriting its amount contradicts an ask in
   * flight.
   */
  it("counts nothing restated when the operation left PENDING before the write", async () => {
    mocks.findManyOperations.mockResolvedValue([waitingOperation()]);
    // The status-guarded updateMany matches no row: the outbox claimed it.
    mocks.updateManyOperation.mockResolvedValue({ count: 0 });

    await expect(
      restatePendingSupplementaryInvoiceAmount({
        bookingModificationId: "mod_1",
        priceDiffCents: 23000,
        changeFeeCents: 0,
      })
    ).resolves.toEqual({ restated: 0, alreadyCovering: 0 });
  });

  it("a replay at the same figures writes nothing but still reports the operation", async () => {
    mocks.findManyOperations.mockResolvedValue([waitingOperation()]);

    await expect(
      restatePendingSupplementaryInvoiceAmount({
        bookingModificationId: "mod_1",
        priceDiffCents: 20000,
        changeFeeCents: 0,
      })
    ).resolves.toEqual({ restated: 0, alreadyCovering: 1 });

    // Reported, because the caller must NOT then enqueue a second invoice; but
    // not written, because nothing changed.
    expect(mocks.updateManyOperation).not.toHaveBeenCalled();
  });

  /**
   * #3170 fix round (F2, interleaving A) - THE STALE RUN CANNOT LOWER THE ASK.
   *
   * Two settlements of one edit derive their totals independently. Whichever
   * commits last necessarily sees both shares, so the LARGER figure is always the
   * newer one - but the two Xero legs can still land in either order. Without a
   * comparison the stale $200 run's restate lands after the $230 one, takes the
   * queued invoice back down to $200, and returns "restated" - so its caller
   * returns early and nothing ever re-queues the missing $30. The provider leg's
   * compare-and-set never covered this leg; this is that guard, on the accounting
   * side.
   *
   * No database is needed to prove it: a stale total and an already-restated
   * operation are two arguments.
   */
  it("refuses to lower a queued invoice when a stale, smaller total lands last", async () => {
    // The $230 run already restated this operation.
    mocks.findManyOperations.mockResolvedValue([
      waitingOperation({
        requestPayload: {
          ...waitingOperation().requestPayload,
          priceDiffCents: 23000,
        },
      }),
    ]);

    // The $200 run's Xero leg arrives afterwards.
    await expect(
      restatePendingSupplementaryInvoiceAmount({
        bookingModificationId: "mod_1",
        priceDiffCents: 20000,
        changeFeeCents: 0,
      })
    ).resolves.toEqual({ restated: 0, alreadyCovering: 1 });

    // Nothing written: the member is still billed $230.
    expect(mocks.updateManyOperation).not.toHaveBeenCalled();
  });

  /**
   * The control for the guard above: the same two runs in the other order must
   * still RAISE. A guard that refused everything would pass the test above and be
   * useless.
   */
  it("still raises when the larger total lands last", async () => {
    mocks.findManyOperations.mockResolvedValue([waitingOperation()]);

    await expect(
      restatePendingSupplementaryInvoiceAmount({
        bookingModificationId: "mod_1",
        priceDiffCents: 23000,
        changeFeeCents: 0,
      })
    ).resolves.toEqual({ restated: 1, alreadyCovering: 0 });
    expect(mocks.updateManyOperation).toHaveBeenCalled();
  });

  /**
   * "Never lower" is about what the invoice BILLS, which is the sum of its two
   * signed components. Comparing `priceDiffCents` alone would let a queued
   * $200 price + $50 fee be replaced by a $210 price with no fee - a lower net
   * dressed as a higher number.
   */
  it("compares the net the invoice bills, not the price component alone", async () => {
    mocks.findManyOperations.mockResolvedValue([
      waitingOperation({
        requestPayload: {
          ...waitingOperation().requestPayload,
          priceDiffCents: 20000,
          changeFeeCents: 5000,
        },
      }),
    ]);

    await expect(
      restatePendingSupplementaryInvoiceAmount({
        bookingModificationId: "mod_1",
        priceDiffCents: 21000,
        changeFeeCents: 0,
      })
    ).resolves.toEqual({ restated: 0, alreadyCovering: 1 });
    expect(mocks.updateManyOperation).not.toHaveBeenCalled();
  });

  it("reports nothing to restate when this edit has queued no invoice", async () => {
    // The FIRST share's ordinary answer, and what tells the caller to enqueue
    // normally.
    mocks.findManyOperations.mockResolvedValue([]);

    await expect(
      restatePendingSupplementaryInvoiceAmount({
        bookingModificationId: "mod_1",
        priceDiffCents: 20000,
        changeFeeCents: 0,
      })
    ).resolves.toEqual({ restated: 0, alreadyCovering: 0 });

    expect(mocks.updateManyOperation).not.toHaveBeenCalled();
  });
});

/**
 * #3170 fix round (F2, interleaving B) - TWO CONCURRENT SETTLEMENTS, ONE INVOICE.
 *
 * The regression this closes was introduced by the combined request itself.
 * Before it, each share queued its own amount and the concurrent case summed
 * correctly. After it, both settlements restate first (finding nothing, because
 * neither has queued yet) and then both enqueue - and the queued-operation lookup
 * deduped on a correlation key BUILT FROM THE AMOUNT, so $200 and $230 were two
 * different keys, two operations, and two Xero invoices totalling $430 for a $230
 * edit.
 *
 * Two changes close it and both are asserted here: the enqueue decides under a
 * per-anchor advisory lock, and it looks for an outstanding invoice by ANCHOR
 * rather than by amount.
 */
describe("enqueueXeroSupplementaryInvoiceOperation: one invoice per anchor (#3170)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstLink.mockResolvedValue(null);
    mocks.findUniqueBooking.mockResolvedValue({
      id: "booking_1",
      payment: { xeroInvoiceId: "inv_existing" },
    });
    mocks.findFirstOperation.mockResolvedValue(null);
    mocks.findManyOperations.mockResolvedValue([]);
    mocks.updateManyOperation.mockResolvedValue({ count: 1 });
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_supplementary_1" });
  });

  it("takes the per-anchor advisory lock before it decides", async () => {
    await enqueueXeroSupplementaryInvoiceOperation({
      bookingId: "booking_1",
      priceDiffCents: 20000,
      changeFeeCents: 0,
      bookingModificationId: "mod_1",
    });

    expect(mocks.executeRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = mocks.executeRaw.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[],
    ];
    expect(strings.join("?")).toContain("pg_advisory_xact_lock");
    // Namespaced and scoped to the anchor: a different edit does not contend.
    expect(values).toEqual(["xero-supplementary-invoice", "mod_1"]);
  });

  /**
   * The second settlement of the same edit, arriving after the first has queued
   * $200 and asking for the $230 combined total. It must find that invoice
   * DESPITE the amounts differing, and raise it rather than queue its own.
   */
  it("finds the first settlement's invoice by anchor and raises it instead of queueing a second", async () => {
    mocks.findFirstOperation.mockResolvedValue({ id: "op_supplementary_1" });
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_supplementary_1",
        requestPayload: {
          queueType: "SUPPLEMENTARY_INVOICE",
          bookingId: "booking_1",
          priceDiffCents: 20000,
          changeFeeCents: 0,
          bookingModificationId: "mod_1",
        },
      },
    ]);

    await expect(
      enqueueXeroSupplementaryInvoiceOperation({
        bookingId: "booking_1",
        priceDiffCents: 23000,
        changeFeeCents: 0,
        bookingModificationId: "mod_1",
      })
    ).resolves.toEqual({
      queueOperationId: "op_supplementary_1",
      message:
        "Xero supplementary invoice already queued for this change was raised to the combined amount.",
    });

    // ONE invoice, and it bills the combined total.
    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
    expect(mocks.updateManyOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          requestPayload: expect.objectContaining({ priceDiffCents: 23000 }),
        }),
      })
    );
  });

  /**
   * The lookup is by anchor, not by correlation key. This is the assertion that
   * fails if anyone puts the amount-derived key back into the `where`.
   */
  it("looks for an outstanding invoice by anchor, never by the amount-derived key", async () => {
    await enqueueXeroSupplementaryInvoiceOperation({
      bookingId: "booking_1",
      priceDiffCents: 23000,
      changeFeeCents: 0,
      bookingModificationId: "mod_1",
    });

    const where = mocks.findFirstOperation.mock.calls[0]?.[0]?.where as Record<
      string,
      unknown
    >;
    expect(where).toMatchObject({
      localModel: "BookingModification",
      localId: "mod_1",
      queueType: "SUPPLEMENTARY_INVOICE",
      status: { in: ["PENDING", "RUNNING", "WAITING_PAYMENT"] },
    });
    expect(where.correlationKey).toBeUndefined();
  });

  /**
   * The stale run reaching the enqueue rather than the restate: it must not lower
   * what the queued invoice bills, and it must still not queue a second one.
   */
  it("a stale, smaller total neither lowers the queued invoice nor queues a second", async () => {
    mocks.findFirstOperation.mockResolvedValue({ id: "op_supplementary_1" });
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_supplementary_1",
        requestPayload: {
          queueType: "SUPPLEMENTARY_INVOICE",
          bookingId: "booking_1",
          priceDiffCents: 23000,
          changeFeeCents: 0,
          bookingModificationId: "mod_1",
        },
      },
    ]);

    await expect(
      enqueueXeroSupplementaryInvoiceOperation({
        bookingId: "booking_1",
        priceDiffCents: 20000,
        changeFeeCents: 0,
        bookingModificationId: "mod_1",
      })
    ).resolves.toEqual({
      queueOperationId: "op_supplementary_1",
      message:
        "Xero supplementary invoice is already queued for background processing.",
    });

    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
    expect(mocks.updateManyOperation).not.toHaveBeenCalled();
  });
});
