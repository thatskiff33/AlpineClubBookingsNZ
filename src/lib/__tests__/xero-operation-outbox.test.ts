import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirstLink: vi.fn(),
  findUniqueBooking: vi.fn(),
  findUniqueMember: vi.fn(),
  findUniqueMemberSubscription: vi.fn(),
  findUniquePayment: vi.fn(),
  findFirstPaymentTransaction: vi.fn(),
  findFirstOperation: vi.fn(),
  findManyOperations: vi.fn(),
  updateManyOperation: vi.fn(),
  startXeroSyncOperation: vi.fn(),
  completeXeroSyncOperation: vi.fn(),
  failXeroSyncOperation: vi.fn(),
  findCanonicalPaymentRefundCreditNote: vi.fn(),
  upsertXeroObjectLink: vi.fn(),
  getEntranceFeeContext: vi.fn(),
  createUnappliedXeroCreditNote: vi.fn(),
  allocateCreditNoteToInvoice: vi.fn(),
  createXeroCreditNote: vi.fn(),
  createXeroCreditNoteForModification: vi.fn(),
  createXeroEntranceFeeInvoice: vi.fn(),
  createXeroInvoiceForBooking: vi.fn(),
  updateXeroBookingInvoiceForBooking: vi.fn(),
  createXeroSupplementaryInvoice: vi.fn(),
  createXeroMembershipCancellationCreditNote: vi.fn(),
  syncXeroMembershipCancellationContact: vi.fn(),
  isXeroConnected: vi.fn().mockResolvedValue(false),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
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
    },
  },
}));

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
  upsertXeroObjectLink: mocks.upsertXeroObjectLink,
}));

vi.mock("@/lib/xero", () => ({
  allocateCreditNoteToInvoice: mocks.allocateCreditNoteToInvoice,
  buildEntranceFeeInvoiceIdempotencyKey: (
    memberId: string,
    category: string,
    amountCents: number
  ) => `member:${memberId}:entrance-fee-invoice:${category}:${amountCents}:v1`,
  createUnappliedXeroCreditNote: mocks.createUnappliedXeroCreditNote,
  createXeroCreditNote: mocks.createXeroCreditNote,
  createXeroCreditNoteForModification: mocks.createXeroCreditNoteForModification,
  getEntranceFeeContext: mocks.getEntranceFeeContext,
  createXeroEntranceFeeInvoice: mocks.createXeroEntranceFeeInvoice,
  createXeroInvoiceForBooking: mocks.createXeroInvoiceForBooking,
  updateXeroBookingInvoiceForBooking: mocks.updateXeroBookingInvoiceForBooking,
  createXeroSupplementaryInvoice: mocks.createXeroSupplementaryInvoice,
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
  enqueueXeroEntranceFeeInvoiceOperation,
  enqueueXeroMembershipCancellationContactOperation,
  enqueueXeroMembershipCancellationCreditNoteOperation,
  enqueueXeroModificationCreditNoteOperation,
  enqueueXeroRefundCreditNoteOperation,
  enqueueXeroSupplementaryInvoiceOperation,
  processQueuedXeroOutboxOperations,
  reapStaleWaitingPaymentXeroOutboxOperations,
  releaseXeroSupplementaryInvoiceOperationsForPaymentIntent,
} from "@/lib/xero-operation-outbox";

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
      message: "Xero entrance fee invoice queued for background processing.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "OUTBOUND",
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "Member",
        localId: "member_1",
        status: "PENDING",
        idempotencyKey: "member:member_1:entrance-fee-invoice:ADULT:15000:v1",
        correlationKey: "member:member_1:entrance-fee-invoice:ADULT:15000:v1",
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
      message: "Xero entrance fee invoice queued for background processing.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "member:member_1:entrance-fee-invoice:ADULT:12345:v1",
        correlationKey: "member:member_1:entrance-fee-invoice:ADULT:12345:v1",
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
      message: "No entrance fee is configured for this member category.",
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
      xeroRefundCreditNoteId: null,
    });
    mocks.findFirstOperation.mockResolvedValue(null);
    mocks.findCanonicalPaymentRefundCreditNote.mockResolvedValue(null);
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_credit_note_1" });
  });

  it("creates a pending primary Xero sync operation for refund credit notes", async () => {
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
        },
      })
    );
  });

  it("skips queueing when the refund credit note is already linked", async () => {
    mocks.findUniquePayment.mockResolvedValue({
      id: "payment_1",
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

describe("processQueuedXeroOutboxOperations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateManyOperation.mockResolvedValue({ count: 1 });
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

  it("claims and processes queued refund credit note operations", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_credit_note_1",
        localId: "payment_1",
        localModel: "Payment",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "REFUND_CREDIT_NOTE",
          refundAmountCents: 5000,
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

    expect(mocks.createXeroCreditNote).toHaveBeenCalledWith("payment_1", 5000, {
      createdByMemberId: "admin_1",
      syncOperationId: "op_credit_note_1",
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
});

describe("reapStaleWaitingPaymentXeroOutboxOperations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstPaymentTransaction.mockResolvedValue(null);
    mocks.updateManyOperation.mockResolvedValue({ count: 0 });
  });

  it("reaps WAITING_PAYMENT operations whose linked PaymentTransaction is FAILED", async () => {
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

    expect(mocks.findFirstPaymentTransaction).toHaveBeenCalledWith({
      where: {
        stripePaymentIntentId: "pi_failed_abc",
        status: "FAILED",
      },
      select: { id: true },
    });
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
