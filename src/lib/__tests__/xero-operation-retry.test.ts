import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUniqueOperation: vi.fn(),
  findUniquePayment: vi.fn(),
  findUniqueBookingModification: vi.fn(),
  findOrCreateXeroContact: vi.fn(),
  updateXeroContact: vi.fn(),
  createXeroInvoiceForBooking: vi.fn(),
  createXeroEntranceFeeInvoice: vi.fn(),
  createXeroSupplementaryInvoice: vi.fn(),
  createXeroCreditNote: vi.fn(),
  createUnappliedXeroCreditNote: vi.fn(),
  createXeroCreditNoteForModification: vi.fn(),
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
  createXeroEntranceFeeInvoice: mocks.createXeroEntranceFeeInvoice,
  createXeroSupplementaryInvoice: mocks.createXeroSupplementaryInvoice,
  createXeroCreditNote: mocks.createXeroCreditNote,
  createUnappliedXeroCreditNote: mocks.createUnappliedXeroCreditNote,
  createXeroCreditNoteForModification: mocks.createXeroCreditNoteForModification,
  allocateCreditNoteToInvoice: mocks.allocateCreditNoteToInvoice,
  checkMembershipStatus: mocks.checkMembershipStatus,
}));

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

  it("blocks automatic retry for partial operations in this pass", () => {
    expect(getXeroOperationRetryMeta(makeOperation({ status: "PARTIAL" })).supported).toBe(false);
    expect(getXeroOperationRetryMeta(makeOperation({ status: "PARTIAL" })).reason).toContain("partial");
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
    });
  });

  it("throws a typed retry error for unsupported operations", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        status: "PARTIAL",
      })
    );

    await expect(retryXeroSyncOperation("op_123")).rejects.toMatchObject<XeroOperationRetryError>({
      name: "XeroOperationRetryError",
      status: 400,
    });
  });
});
