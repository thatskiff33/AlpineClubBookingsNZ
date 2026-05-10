import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUniqueOperation: vi.fn(),
  findUniquePayment: vi.fn(),
  updatePayment: vi.fn(),
  findUniqueBookingModification: vi.fn(),
  completeXeroSyncOperation: vi.fn(),
  findOrCreateXeroContact: vi.fn(),
  updateXeroContact: vi.fn(),
  createXeroInvoiceForBooking: vi.fn(),
  updateXeroBookingInvoiceForBooking: vi.fn(),
  createXeroEntranceFeeInvoice: vi.fn(),
  createXeroSupplementaryInvoice: vi.fn(),
  createXeroPaymentForInvoice: vi.fn(),
  createXeroCreditNote: vi.fn(),
  createUnappliedXeroCreditNote: vi.fn(),
  createXeroCreditNoteForModification: vi.fn(),
  createXeroRefundPaymentForInvoice: vi.fn(),
  allocateCreditNoteToInvoice: vi.fn(),
  checkMembershipStatus: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    xeroSyncOperation: {
      findUnique: mocks.findUniqueOperation,
    },
    payment: {
      findUnique: mocks.findUniquePayment,
      update: mocks.updatePayment,
    },
    bookingModification: {
      findUnique: mocks.findUniqueBookingModification,
    },
  },
}));

vi.mock("@/lib/xero", () => ({
  findOrCreateXeroContact: mocks.findOrCreateXeroContact,
  updateXeroContact: mocks.updateXeroContact,
  createXeroInvoiceForBooking: mocks.createXeroInvoiceForBooking,
  updateXeroBookingInvoiceForBooking: mocks.updateXeroBookingInvoiceForBooking,
  createXeroEntranceFeeInvoice: mocks.createXeroEntranceFeeInvoice,
  createXeroSupplementaryInvoice: mocks.createXeroSupplementaryInvoice,
  createXeroPaymentForInvoice: mocks.createXeroPaymentForInvoice,
  createXeroCreditNote: mocks.createXeroCreditNote,
  createUnappliedXeroCreditNote: mocks.createUnappliedXeroCreditNote,
  createXeroCreditNoteForModification: mocks.createXeroCreditNoteForModification,
  createXeroRefundPaymentForInvoice: mocks.createXeroRefundPaymentForInvoice,
  allocateCreditNoteToInvoice: mocks.allocateCreditNoteToInvoice,
  checkMembershipStatus: mocks.checkMembershipStatus,
}));

vi.mock("@/lib/xero-sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/xero-sync")>();

  return {
    ...actual,
    completeXeroSyncOperation: mocks.completeXeroSyncOperation,
  };
});

import {
  getXeroOperationRetryMeta,
  retryXeroSyncOperation,
  XeroOperationRetryError,
} from "@/lib/xero-operation-retry";

function makeOperation(overrides: Record<string, unknown> = {}) {
  return {
    id: "op_123",
    status: "FAILED",
    replayable: true,
    direction: "OUTBOUND",
    entityType: "INVOICE",
    operationType: "CREATE",
    localModel: "Payment",
    localId: "pay_123",
    requestPayload: null,
    responsePayload: null,
    xeroObjectId: null,
    ...overrides,
  };
}

describe("getXeroOperationRetryMeta", () => {
  it("marks failed payment invoice operations as retryable", () => {
    expect(getXeroOperationRetryMeta(makeOperation())).toEqual({
      supported: true,
      reason: null,
    });
  });

  it("marks failed payment invoice update operations as retryable", () => {
    expect(
      getXeroOperationRetryMeta(
        makeOperation({
          operationType: "UPDATE",
        })
      )
    ).toEqual({
      supported: true,
      reason: null,
    });
  });

  it("marks repairable partial invoice operations as supported", () => {
    expect(
      getXeroOperationRetryMeta(
        makeOperation({
          status: "PARTIAL",
          xeroObjectId: "inv_123",
          responsePayload: {
            invoice: {
              invoices: [{ total: 45.67 }],
            },
          },
        })
      )
    ).toEqual({
      supported: true,
      reason: null,
    });
  });

  it("blocks partial repairs when the stored invoice state is incomplete", () => {
    expect(getXeroOperationRetryMeta(makeOperation({ status: "PARTIAL" })).supported).toBe(false);
    expect(getXeroOperationRetryMeta(makeOperation({ status: "PARTIAL" })).reason).toContain(
      "incomplete"
    );
  });

  it("requires a complete stored payload for contact updates", () => {
    const result = getXeroOperationRetryMeta(
      makeOperation({
        entityType: "CONTACT",
        operationType: "UPDATE",
        localModel: "Member",
        localId: "mem_123",
        requestPayload: { contacts: [{}] },
      })
    );

    expect(result).toEqual({
      supported: false,
      reason: "Stored contact update payload is incomplete.",
    });
  });
});

describe("retryXeroSyncOperation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("replays booking invoice creation through the booking payment relationship", async () => {
    mocks.findUniqueOperation.mockResolvedValue(makeOperation());
    mocks.findUniquePayment.mockResolvedValue({ bookingId: "book_123" });

    await expect(
      retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" })
    ).resolves.toEqual({
      message: "Retried Xero booking invoice creation.",
    });

    expect(mocks.createXeroInvoiceForBooking).toHaveBeenCalledWith("book_123", {
      createdByMemberId: "admin_1",
      repairExistingLink: true,
    });
  });

  it("replays booking invoice updates through the booking payment relationship", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        operationType: "UPDATE",
      })
    );
    mocks.findUniquePayment.mockResolvedValue({ bookingId: "book_123" });

    await expect(
      retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" })
    ).resolves.toEqual({
      message: "Retried Xero booking invoice update.",
    });

    expect(mocks.updateXeroBookingInvoiceForBooking).toHaveBeenCalledWith("book_123", {
      createdByMemberId: "admin_1",
      repairExistingLink: true,
    });
  });

  it("replays entrance-fee invoice creation with contact relink enabled", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        localModel: "Member",
        localId: "mem_123",
      })
    );

    await expect(
      retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" })
    ).resolves.toEqual({
      message: "Retried Xero entrance fee invoice creation.",
    });

    expect(mocks.createXeroEntranceFeeInvoice).toHaveBeenCalledWith("mem_123", {
      createdByMemberId: "admin_1",
      repairExistingLink: true,
    });
  });

  it("replays contact updates using the stored request payload", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "CONTACT",
        operationType: "UPDATE",
        localModel: "Member",
        localId: "mem_123",
        requestPayload: {
          contacts: [
            {
              contactID: "xero_contact_1",
              firstName: "Jane",
              lastName: "Doe",
              emailAddress: "jane@example.com",
              companyNumber: "02/03/1990",
              phones: [
                {
                  phoneCountryCode: "64",
                  phoneAreaCode: "21",
                  phoneNumber: "1234567",
                },
              ],
              addresses: [
                {
                  addressType: "STREET",
                  addressLine1: "1 Test Street",
                  city: "Auckland",
                  region: "Auckland",
                  postalCode: "1010",
                  country: "NZ",
                },
                {
                  addressType: "POBOX",
                  addressLine1: "PO Box 99",
                  city: "Auckland",
                  region: "Auckland",
                  postalCode: "1140",
                  country: "NZ",
                },
              ],
            },
          ],
        },
      })
    );

    await retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" });

    expect(mocks.updateXeroContact).toHaveBeenCalledWith(
      "xero_contact_1",
      expect.objectContaining({
        firstName: "Jane",
        lastName: "Doe",
        email: "jane@example.com",
        phoneCountryCode: "64",
        phoneAreaCode: "21",
        phoneNumber: "1234567",
        streetAddressLine1: "1 Test Street",
        postalAddressLine1: "PO Box 99",
        dateOfBirth: new Date(Date.UTC(1990, 2, 2)),
      }),
      {
        localModel: "Member",
        localId: "mem_123",
        createdByMemberId: "admin_1",
      }
    );
  });

  it("replays payment credit note creation using the stored refund amount", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "Payment",
        localId: "pay_123",
        requestPayload: {
          allocation: {
            invoiceId: "inv_123",
            amount: 12.34,
          },
        },
      })
    );

    await retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" });

    expect(mocks.createXeroCreditNote).toHaveBeenCalledWith("pay_123", 1234, {
      createdByMemberId: "admin_1",
      repairExistingLink: true,
    });
  });

  it("replays unapplied account-credit creation with contact relink enabled", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "Payment",
        localId: "pay_123",
        requestPayload: {
          creditNotes: [
            {
              lineItems: [{ unitAmount: 23.45 }],
            },
          ],
        },
      })
    );

    await expect(
      retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" })
    ).resolves.toEqual({
      message: "Retried Xero account-credit note creation.",
    });

    expect(mocks.createUnappliedXeroCreditNote).toHaveBeenCalledWith("pay_123", 2345, {
      createdByMemberId: "admin_1",
      repairExistingLink: true,
    });
  });

  it("replays supplementary invoice creation for booking modifications", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "BookingModification",
        localId: "mod_123",
      })
    );
    mocks.findUniqueBookingModification.mockResolvedValue({
      bookingId: "book_123",
      priceDiffCents: 2500,
      changeFeeCents: 500,
    });

    await retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" });

    expect(mocks.createXeroSupplementaryInvoice).toHaveBeenCalledWith({
      bookingId: "book_123",
      priceDiffCents: 2500,
      changeFeeCents: 500,
      bookingModificationId: "mod_123",
      createdByMemberId: "admin_1",
      repairExistingLink: true,
    });
  });

  it("replays modification credit note creation with contact relink enabled", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "BookingModification",
        localId: "mod_123",
      })
    );
    mocks.findUniqueBookingModification.mockResolvedValue({
      bookingId: "book_123",
      priceDiffCents: -2500,
      changeFeeCents: 0,
    });

    await expect(
      retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" })
    ).resolves.toEqual({
      message: "Retried Xero modification credit note creation.",
    });

    expect(mocks.createXeroCreditNoteForModification).toHaveBeenCalledWith({
      bookingId: "book_123",
      refundAmountCents: 2500,
      bookingModificationId: "mod_123",
      createdByMemberId: "admin_1",
      repairExistingLink: true,
    });
  });

  it("repairs partial booking invoice payment recording", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        status: "PARTIAL",
        xeroObjectId: "inv_123",
        responsePayload: {
          invoice: {
            invoices: [{ total: 45.67 }],
          },
        },
      })
    );

    await expect(
      retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" })
    ).resolves.toEqual({
      message: "Repaired Xero booking invoice payment recording.",
    });

    expect(mocks.createXeroPaymentForInvoice).toHaveBeenCalledWith({
      localModel: "Payment",
      localId: "pay_123",
      invoiceId: "inv_123",
      amountCents: 4567,
      idempotencyKey: "payment:pay_123:invoice-payment:v1",
      reference: "Tokoroa Alpine Club invoice payment pay_123",
      role: "INVOICE_PAYMENT",
      createdByMemberId: "admin_1",
      metadata: {
        invoiceId: "inv_123",
        amountCents: 4567,
      },
    });
  });

  it("repairs partial supplementary invoice payment recording", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        status: "PARTIAL",
        localModel: "BookingModification",
        localId: "mod_123",
        xeroObjectId: "inv_sup_123",
        responsePayload: {
          invoice: {
            invoices: [{ total: 30 }],
          },
        },
      })
    );

    await expect(
      retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" })
    ).resolves.toEqual({
      message: "Repaired Xero supplementary invoice payment recording.",
    });

    expect(mocks.createXeroPaymentForInvoice).toHaveBeenCalledWith({
      localModel: "BookingModification",
      localId: "mod_123",
      invoiceId: "inv_sup_123",
      amountCents: 3000,
      idempotencyKey: "booking-mod:mod_123:supplementary-payment:3000:v1",
      reference: "Tokoroa Alpine Club supplementary payment mod_123",
      role: "SUPPLEMENTARY_INVOICE_PAYMENT",
      createdByMemberId: "admin_1",
      metadata: {
        invoiceId: "inv_sup_123",
        amountCents: 3000,
      },
    });
  });

  it("marks zero-total booking invoice partials as repaired without creating a payment", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        status: "PARTIAL",
        xeroObjectId: "inv_zero",
        responsePayload: {
          invoice: {
            invoices: [{ total: 0 }],
          },
        },
      })
    );

    await expect(
      retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" })
    ).resolves.toEqual({
      message: "Marked zero-total Xero booking invoice as repaired without payment recording.",
    });

    expect(mocks.createXeroPaymentForInvoice).not.toHaveBeenCalled();
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      "op_123",
      expect.objectContaining({
        status: "SUCCEEDED",
        xeroObjectType: "INVOICE",
        xeroObjectId: "inv_zero",
        responsePayload: expect.objectContaining({
          payment: null,
          paymentError: null,
          paymentSkipped: true,
          paymentSkipReason: "Zero-total invoice does not require Xero payment recording.",
        }),
      })
    );
  });

  it("repairs partial refund credit note follow-up actions", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        status: "PARTIAL",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        xeroObjectId: "cn_123",
        requestPayload: {
          allocation: {
            invoiceId: "inv_123",
            amount: 12.34,
          },
        },
        responsePayload: {
          allocation: {
            allocations: [{ amount: 12.34 }],
          },
        },
      })
    );
    mocks.updatePayment.mockResolvedValue({ id: "pay_123" });

    await expect(
      retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" })
    ).resolves.toEqual({
      message: "Repaired Xero refund credit note follow-up actions.",
    });

    expect(mocks.allocateCreditNoteToInvoice).not.toHaveBeenCalled();
    expect(mocks.updatePayment).toHaveBeenCalledWith({
      where: { id: "pay_123" },
      data: { xeroRefundCreditNoteId: "cn_123" },
    });
    expect(mocks.createXeroRefundPaymentForInvoice).toHaveBeenCalledWith({
      paymentId: "pay_123",
      invoiceId: "inv_123",
      creditNoteId: "cn_123",
      refundAmountCents: 1234,
      createdByMemberId: "admin_1",
    });
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      "op_123",
      expect.objectContaining({
        status: "SUCCEEDED",
        xeroObjectType: "CREDIT_NOTE",
        xeroObjectId: "cn_123",
        responsePayload: expect.objectContaining({
          allocation: null,
          allocationSkipped: true,
          allocationSkipReason:
            "Refund credit notes are settled via a credit-note payment instead of invoice allocation.",
          refundPaymentError: null,
        }),
      })
    );
  });

  it("repairs failed refund credit note creates from the existing Xero credit note", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        status: "FAILED",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        xeroObjectId: "cn_legacy_123",
        xeroObjectNumber: "CN-123",
        requestPayload: {
          allocation: {
            invoiceId: "inv_legacy_123",
            amount: 0.1,
          },
        },
        responsePayload: "{\"response\":{\"statusCode\":400}}",
      })
    );
    mocks.updatePayment.mockResolvedValue({ id: "pay_123" });

    await expect(
      retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" })
    ).resolves.toEqual({
      message: "Repaired Xero refund credit note follow-up actions.",
    });

    expect(mocks.createXeroCreditNote).not.toHaveBeenCalled();
    expect(mocks.allocateCreditNoteToInvoice).not.toHaveBeenCalled();
    expect(mocks.updatePayment).toHaveBeenCalledWith({
      where: { id: "pay_123" },
      data: { xeroRefundCreditNoteId: "cn_legacy_123" },
    });
    expect(mocks.createXeroRefundPaymentForInvoice).toHaveBeenCalledWith({
      paymentId: "pay_123",
      invoiceId: "inv_legacy_123",
      creditNoteId: "cn_legacy_123",
      refundAmountCents: 10,
      createdByMemberId: "admin_1",
    });
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      "op_123",
      expect.objectContaining({
        status: "SUCCEEDED",
        xeroObjectType: "CREDIT_NOTE",
        xeroObjectId: "cn_legacy_123",
        xeroObjectNumber: "CN-123",
      })
    );
  });

  it("repairs partial modification credit note allocations", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        status: "PARTIAL",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "BookingModification",
        localId: "mod_123",
        xeroObjectId: "cn_123",
        requestPayload: {
          invoiceId: "inv_123",
          refundAmountCents: 2500,
        },
      })
    );

    await expect(
      retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" })
    ).resolves.toEqual({
      message: "Repaired Xero modification credit note allocation.",
    });

    expect(mocks.allocateCreditNoteToInvoice).toHaveBeenCalledWith(
      "cn_123",
      "inv_123",
      2500,
      {
        localModel: "BookingModification",
        localId: "mod_123",
        role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
        createdByMemberId: "admin_1",
      }
    );
  });

  it("throws a typed retry error for unsupported operations", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        status: "PARTIAL",
      })
    );

    await expect(retryXeroSyncOperation("op_123")).rejects.toMatchObject({
      name: "XeroOperationRetryError",
      status: 400,
    } satisfies Partial<XeroOperationRetryError>);
  });
});
