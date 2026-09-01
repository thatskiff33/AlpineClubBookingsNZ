import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUniqueOperation: vi.fn(),
  updateManyOperation: vi.fn(),
  findUniquePayment: vi.fn(),
  findUniqueMember: vi.fn(),
  updatePayment: vi.fn(),
  findUniqueBookingModification: vi.fn(),
  findUniqueBooking: vi.fn(),
  findFirstPaymentTransaction: vi.fn(),
  completeXeroSyncOperation: vi.fn(),
  buildXeroContactUpdatePayload: vi.fn(),
  shouldRepairXeroContactNameOrder: vi.fn(),
  findOrCreateXeroContact: vi.fn(),
  updateXeroContact: vi.fn(),
  createXeroInvoiceForBooking: vi.fn(),
  updateXeroBookingInvoiceForBooking: vi.fn(),
  createXeroEntranceFeeInvoice: vi.fn(),
  createXeroSupplementaryInvoice: vi.fn(),
  createXeroPaymentForInvoice: vi.fn(),
  createXeroCreditNote: vi.fn(),
  createUnappliedXeroCreditNote: vi.fn(),
  createUnappliedXeroCreditNoteForModification: vi.fn(),
  createXeroCreditNoteForModification: vi.fn(),
  createXeroRefundPaymentForInvoice: vi.fn(),
  allocateCreditNoteToInvoice: vi.fn(),
  checkMembershipStatus: vi.fn(),
  createXeroMembershipCancellationCreditNote: vi.fn(),
  allocateAppliedCreditForBooking: vi.fn(),
  deallocateExcessAppliedCreditForBooking: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    xeroSyncOperation: {
      findUnique: mocks.findUniqueOperation,
      updateMany: mocks.updateManyOperation,
    },
    payment: {
      findUnique: mocks.findUniquePayment,
      update: mocks.updatePayment,
    },
    member: {
      findUnique: mocks.findUniqueMember,
    },
    bookingModification: {
      findUnique: mocks.findUniqueBookingModification,
    },
    booking: {
      findUnique: mocks.findUniqueBooking,
    },
    paymentTransaction: {
      findFirst: mocks.findFirstPaymentTransaction,
    },
  },
}));

vi.mock("@/lib/xero-contact-sync", () => ({
  buildXeroContactUpdatePayload: mocks.buildXeroContactUpdatePayload,
  shouldRepairXeroContactNameOrder: mocks.shouldRepairXeroContactNameOrder,
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
  createUnappliedXeroCreditNoteForModification:
    mocks.createUnappliedXeroCreditNoteForModification,
  createXeroCreditNoteForModification: mocks.createXeroCreditNoteForModification,
  createXeroRefundPaymentForInvoice: mocks.createXeroRefundPaymentForInvoice,
  allocateCreditNoteToInvoice: mocks.allocateCreditNoteToInvoice,
  checkMembershipStatus: mocks.checkMembershipStatus,
}));

vi.mock("@/lib/membership-cancellation-xero", () => ({
  createXeroMembershipCancellationCreditNote: mocks.createXeroMembershipCancellationCreditNote,
}));

vi.mock("@/lib/xero-applied-credit-allocation", () => ({
  allocateAppliedCreditForBooking: mocks.allocateAppliedCreditForBooking,
}));
vi.mock("@/lib/xero-applied-credit-deallocation", () => ({
  deallocateExcessAppliedCreditForBooking: mocks.deallocateExcessAppliedCreditForBooking,
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
import {
  XERO_OUTBOX_CREDIT_NOTE_ALLOCATION_TYPE,
  XERO_OUTBOX_APPLIED_CREDIT_ALLOCATION_TYPE,
  XERO_OUTBOX_APPLIED_CREDIT_DEALLOCATION_TYPE,
} from "@/lib/xero-operation-outbox-payload";
import { CLUB_NAME } from "@/config/club-identity";

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
    xeroObjectNumber: null,
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

  it("sums a multi-line invoice request payload when the response total is absent (regression, #1932 E6)", () => {
    // Subscription invoices are now multi-line (one line per fee component).
    // readStoredInvoiceTotalCents must still recover a repairable total by
    // summing quantity*unitAmount across every line when no response total exists.
    expect(
      getXeroOperationRetryMeta(
        makeOperation({
          status: "PARTIAL",
          xeroObjectId: "inv_multi",
          responsePayload: null,
          requestPayload: {
            invoices: [{ lineItems: [
              { quantity: 1, unitAmount: 90 },
              { quantity: 1, unitAmount: 30 },
              { quantity: 2, unitAmount: 15 },
            ] }],
          },
        })
      )
    ).toEqual({ supported: true, reason: null });
  });

  it("blocks partial repairs when the stored invoice state is incomplete", () => {
    expect(getXeroOperationRetryMeta(makeOperation({ status: "PARTIAL" })).supported).toBe(false);
    expect(getXeroOperationRetryMeta(makeOperation({ status: "PARTIAL" })).reason).toContain(
      "incomplete"
    );
  });

  it("allows member contact updates to be rebuilt from the current member record", () => {
    const result = getXeroOperationRetryMeta(
      makeOperation({
        entityType: "CONTACT",
        operationType: "UPDATE",
        localModel: "Member",
        localId: "mem_123",
        requestPayload: null,
      })
    );

    expect(result).toEqual({
      supported: true,
      reason: null,
    });
  });

  it("marks failed membership cancellation credit note operations as retryable", () => {
    const result = getXeroOperationRetryMeta(
      makeOperation({
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "MemberSubscription",
        localId: "sub_123",
        requestPayload: {
          requestId: "request_1",
          participantId: "participant_1",
        },
      })
    );

    expect(result).toEqual({
      supported: true,
      reason: null,
    });
  });

  it("rejects membership cancellation credit note retries with an incomplete stored payload", () => {
    const result = getXeroOperationRetryMeta(
      makeOperation({
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "MemberSubscription",
        localId: "sub_123",
        requestPayload: { requestId: "request_1" },
      })
    );

    expect(result).toEqual({
      supported: false,
      reason: "This credit note retry path is not supported by the current replay helper.",
    });
  });

  it("requires a complete stored payload for non-member contact updates", () => {
    const result = getXeroOperationRetryMeta(
      makeOperation({
        entityType: "CONTACT",
        operationType: "UPDATE",
        localModel: "ExternalContact",
        localId: "external_123",
        requestPayload: { contacts: [{}] },
      })
    );

    expect(result).toEqual({
      supported: false,
      reason: "Stored contact update payload is incomplete.",
    });
  });

  it("supports an applied-credit allocation queued op (#1620)", () => {
    // The op carries the {queueType, bookingId} queued payload, NOT the
    // creditNoteId/invoiceId/amountCents shape the generic allocation parser
    // wants — without the dedicated branch this would strand on FAILED.
    const result = getXeroOperationRetryMeta(
      makeOperation({
        entityType: "ALLOCATION",
        operationType: "ALLOCATE",
        localModel: "Payment",
        localId: "pay_123",
        requestPayload: {
          queueType: XERO_OUTBOX_APPLIED_CREDIT_ALLOCATION_TYPE,
          bookingId: "b1",
        },
      })
    );

    expect(result).toEqual({ supported: true, reason: null });
  });

  it("blocks direct retry of an attributable applied-credit child allocation", () => {
    const result = getXeroOperationRetryMeta(
      makeOperation({
        entityType: "ALLOCATION",
        operationType: "ALLOCATE",
        localModel: "MemberCreditNoteAllocation",
        localId: "slice_1",
        requestPayload: {
          creditNoteId: "cn_1",
          invoiceId: "inv_1",
          amountCents: 2500,
          appliedCreditContext: {
            parentOperationId: "parent_op_1",
            bookingId: "booking_1",
            paymentId: "payment_1",
          },
        },
      }),
    );

    expect(result).toEqual({
      supported: false,
      reason:
        "Retry the serialized parent applied-credit operation parent_op_1; this child allocation cannot run inline.",
    });
  });

  it.each([
    ["existing-note", "MemberCreditNoteAllocation", "slice_legacy_1"],
    ["minted remainder", "Payment", "payment_legacy_1"],
  ])(
    "blocks a contextless legacy %s child allocation",
    (_label, localModel, localId) => {
      const result = getXeroOperationRetryMeta(
        makeOperation({
          entityType: "ALLOCATION",
          operationType: "ALLOCATE",
          localModel,
          localId,
          requestPayload: {
            creditNoteId: "cn_legacy_1",
            invoiceId: "inv_legacy_1",
            amountCents: 2500,
          },
        }),
      );

      expect(result).toEqual({
        supported: false,
        reason:
          "This legacy applied-credit child allocation must be retried through its serialized parent workflow.",
      });
    },
  );

  it("preserves unrelated queue-shaped Payment allocation retries", () => {
    expect(
      getXeroOperationRetryMeta(
        makeOperation({
          entityType: "ALLOCATION",
          operationType: "ALLOCATE",
          localModel: "Payment",
          localId: "payment_repair_1",
          requestPayload: {
            queueType: XERO_OUTBOX_CREDIT_NOTE_ALLOCATION_TYPE,
            creditNoteId: "cn_repair_1",
            invoiceId: "inv_repair_1",
            amountCents: 1200,
            role: "CREDIT_NOTE_ALLOCATION",
          },
        }),
      ),
    ).toEqual({ supported: true, reason: null });
  });
});

describe("retryXeroSyncOperation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUniqueMember.mockResolvedValue(null);
    mocks.updateManyOperation.mockResolvedValue({ count: 1 });
    // No SUCCEEDED ADDITIONAL capture exists unless a test says so (#1882).
    mocks.findFirstPaymentTransaction.mockResolvedValue(null);
    mocks.shouldRepairXeroContactNameOrder.mockResolvedValue(false);
    mocks.buildXeroContactUpdatePayload.mockImplementation((member) => ({
      firstName: member.firstName,
      lastName: member.lastName,
      email: member.email,
      dateOfBirth: member.dateOfBirth,
      phoneCountryCode: member.phoneCountryCode,
      phoneAreaCode: member.phoneAreaCode,
      phoneNumber: member.phoneNumber,
      streetAddressLine1: member.streetAddressLine1,
      streetAddressLine2: member.streetAddressLine2,
      streetCity: member.streetCity,
      streetRegion: member.streetRegion,
      streetPostalCode: member.streetPostalCode,
      streetCountry: member.streetCountry,
      postalAddressLine1: member.postalAddressLine1,
      postalAddressLine2: member.postalAddressLine2,
      postalCity: member.postalCity,
      postalRegion: member.postalRegion,
      postalPostalCode: member.postalPostalCode,
      postalCountry: member.postalCountry,
    }));
  });

  it("replays a queued-shape refund credit note op in delta mode (#1354)", async () => {
    // An op that failed BEFORE its handler overwrote requestPayload still
    // carries the enqueue-time queued shape. Pre-#1354 the parser returned
    // null ("Stored credit note payload is incomplete.") — a permanent
    // dead-end after an operator stale-reset.
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "CREDIT_NOTE",
        localId: "pay_9",
        queueType: "REFUND_CREDIT_NOTE",
        requestPayload: {
          queueType: "REFUND_CREDIT_NOTE",
          refundAmountCents: 3000,
          watermarkCents: 8000,
        },
      })
    );

    await expect(
      retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" })
    ).resolves.toEqual({ message: "Retried Xero refund credit note creation." });

    // Delta mode re-entered: the watermark is threaded through (the value is
    // advisory — createXeroCreditNote recomputes coverage at execution time).
    expect(mocks.createXeroCreditNote).toHaveBeenCalledWith("pay_9", 3000, {
      createdByMemberId: "admin_1",
      repairExistingLink: true,
      watermarkCents: 8000,
    });
  });

  it("re-enters delta mode via the queueType column when the payload was overwritten (#1354)", async () => {
    // Overwritten (Xero-request-shaped) payload with no watermark: the
    // denormalized enqueue-time queueType still marks it as a per-delta op.
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "CREDIT_NOTE",
        localId: "pay_9",
        queueType: "REFUND_CREDIT_NOTE",
        requestPayload: {
          creditNotes: [{ lineItems: [{ unitAmount: 30 }] }],
          allocation: { invoiceId: "inv_1", amount: 30 },
        },
      })
    );

    await expect(
      retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" })
    ).resolves.toEqual({ message: "Retried Xero refund credit note creation." });

    expect(mocks.createXeroCreditNote).toHaveBeenCalledWith("pay_9", 3000, {
      createdByMemberId: "admin_1",
      repairExistingLink: true,
      watermarkCents: 0,
    });
  });

  it("replays a queued-shape account-credit note op (#1354)", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "CREDIT_NOTE",
        localId: "pay_9",
        queueType: "ACCOUNT_CREDIT_NOTE",
        requestPayload: {
          queueType: "ACCOUNT_CREDIT_NOTE",
          refundAmountCents: 4500,
        },
      })
    );

    await expect(
      retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" })
    ).resolves.toEqual({ message: "Retried Xero account-credit note creation." });

    expect(mocks.createUnappliedXeroCreditNote).toHaveBeenCalledWith("pay_9", 4500, {
      createdByMemberId: "admin_1",
      repairExistingLink: true,
    });
  });

  it("replays booking invoice creation through the booking payment relationship, CLAIMING the row first (#2262 H3)", async () => {
    mocks.findUniqueOperation.mockResolvedValue(makeOperation());
    mocks.findUniquePayment.mockResolvedValue({ bookingId: "book_123" });
    mocks.createXeroInvoiceForBooking.mockResolvedValue("inv_1");

    await expect(
      retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" })
    ).resolves.toEqual({
      message: "Retried Xero booking invoice creation.",
    });

    // The claim makes the retry visible to the manual mark-paid settle-time
    // fence (RUNNING is in its in-flight set) for the whole execution, and the
    // threaded syncOperationId means completion lands on THIS row.
    expect(mocks.updateManyOperation).toHaveBeenCalledWith({
      where: { id: "op_123", status: { in: ["FAILED", "PARTIAL"] } },
      data: { status: "RUNNING", startedAt: expect.any(Date) },
    });
    expect(mocks.createXeroInvoiceForBooking).toHaveBeenCalledWith("book_123", {
      createdByMemberId: "admin_1",
      repairExistingLink: true,
      syncOperationId: "op_123",
    });
    // The claim strictly precedes the mint call.
    expect(
      mocks.updateManyOperation.mock.invocationCallOrder[0]
    ).toBeLessThan(mocks.createXeroInvoiceForBooking.mock.invocationCallOrder[0]);
  });

  it("409s a booking-invoice retry whose claim lost (already queued or claimed elsewhere) without calling Xero (#2262 H3)", async () => {
    mocks.findUniqueOperation.mockResolvedValue(makeOperation());
    mocks.findUniquePayment.mockResolvedValue({ bookingId: "book_123" });
    mocks.updateManyOperation.mockResolvedValue({ count: 0 });

    await expect(
      retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" })
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("already claimed"),
    });
    expect(mocks.createXeroInvoiceForBooking).not.toHaveBeenCalled();
  });

  it("reports the manual mark-paid abandon honestly instead of a false 'Retried' success (#2262 H3)", async () => {
    mocks.findUniqueOperation.mockResolvedValue(makeOperation());
    mocks.findUniquePayment.mockResolvedValue({ bookingId: "book_123" });
    // The handler's provenance re-check abandoned the mint (returns null after
    // closing the operation CANCELLED itself).
    mocks.createXeroInvoiceForBooking.mockResolvedValue(null);

    await expect(
      retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" })
    ).resolves.toEqual({
      message: expect.stringContaining("No invoice was created"),
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
      message: "Retried Xero joining fee invoice creation.",
    });

    expect(mocks.createXeroEntranceFeeInvoice).toHaveBeenCalledWith("mem_123", {
      createdByMemberId: "admin_1",
      repairExistingLink: true,
    });
  });

  it("replays non-member contact updates using the stored request payload", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "CONTACT",
        operationType: "UPDATE",
        localModel: "ExternalContact",
        localId: "external_123",
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
      expect.objectContaining({
        localModel: "ExternalContact",
        localId: "external_123",
        createdByMemberId: "admin_1",
        preserveXeroName: false,
      })
    );
  });

  it("rebuilds member contact updates from the current member when the stored payload is redacted", async () => {
    const currentMember = {
      xeroContactId: "xero_contact_current",
      firstName: "Janet",
      lastName: "Doe",
      email: "janet@example.com",
      dateOfBirth: new Date(Date.UTC(1991, 4, 6)),
      phoneCountryCode: "64",
      phoneAreaCode: "27",
      phoneNumber: "7654321",
      streetAddressLine1: "2 Current Street",
      streetAddressLine2: null,
      streetCity: "Rotorua",
      streetRegion: "Bay of Plenty",
      streetPostalCode: "3010",
      streetCountry: "NZ",
      postalAddressLine1: "PO Box 100",
      postalAddressLine2: null,
      postalCity: "Rotorua",
      postalRegion: "Bay of Plenty",
      postalPostalCode: "3040",
      postalCountry: "NZ",
    };
    mocks.findUniqueMember.mockResolvedValue(currentMember);
    mocks.shouldRepairXeroContactNameOrder.mockResolvedValue(true);
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "CONTACT",
        operationType: "UPDATE",
        localModel: "Member",
        localId: "mem_123",
        requestPayload: {
          contacts: [
            {
              contactID: "xero_contact_old",
              firstName: "Jane",
              lastName: "Doe",
              emailAddress: "[REDACTED]",
              phones: [{ phoneNumber: "[REDACTED]" }],
            },
          ],
        },
      })
    );

    await retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" });

    expect(mocks.updateXeroContact).toHaveBeenCalledWith(
      "xero_contact_current",
      undefined,
      expect.objectContaining({
        localModel: "Member",
        localId: "mem_123",
        createdByMemberId: "admin_1",
        preserveXeroName: false,
      })
    );
  });

  it("replays non-member contact updates that intentionally preserve the Xero contact name", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "CONTACT",
        operationType: "UPDATE",
        localModel: "ExternalContact",
        localId: "external_123",
        requestPayload: {
          contacts: [
            {
              contactID: "xero_contact_1",
              emailAddress: "jane@example.com",
              phones: [
                {
                  phoneCountryCode: "64",
                  phoneAreaCode: "21",
                  phoneNumber: "7654321",
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
        email: "jane@example.com",
        phoneCountryCode: "64",
        phoneAreaCode: "21",
        phoneNumber: "7654321",
      }),
      expect.objectContaining({
        localModel: "ExternalContact",
        localId: "external_123",
        createdByMemberId: "admin_1",
        preserveXeroName: true,
      })
    );
  });

  it("refuses a Member retry when the current contact is gone instead of replaying stored PII", async () => {
    mocks.findUniqueMember.mockResolvedValue(null);
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "CONTACT",
        operationType: "UPDATE",
        localModel: "Member",
        localId: "deleted-member",
        requestPayload: {
          contacts: [
            {
              contactID: "stale-contact",
              firstName: "Former",
              lastName: "Member",
              emailAddress: "former@example.test",
            },
          ],
        },
      }),
    );

    await expect(
      retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" }),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("do not replay the stored contact payload"),
    });
    expect(mocks.updateXeroContact).not.toHaveBeenCalled();
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
      // No queued payload and no SUCCEEDED ADDITIONAL capture in this
      // scenario, so the retry must not record cash (#1882).
      recordPayment: false,
      repairExistingLink: true,
    });
  });

  /**
   * #3193 fix round: A SECOND ASK that Xero rejected.
   *
   * It is anchored on the review task whose settled share it bills - the anchor
   * that keeps the booking change's own reads from raising it to the combined
   * total. Nothing here knew that anchor, so this screen's only
   * supplementary-invoice branch (`BookingModification`) did not match and a
   * failed second ask had no retry at all, while the booking's audit trail
   * already said the amount was being billed.
   *
   * THIS TEST IS THE BRANCH, NOT THE ROUTE TO IT (second pass). The payload
   * below is hand-built, so on its own it proves only that the replay sends the
   * queued share. That a Xero rejection actually LEAVES such a payload behind is
   * the other half, and it was false when this branch was written: the create
   * path replaced the payload with the Xero body before calling Xero, so this
   * branch was unreachable for the very failure it was added for. That half is
   * proven from the real create path in
   * `xero-supplementary-invoices.test.ts` -> "a second ask survives a Xero
   * rejection replayably (#3193)", and the shape below is what that run writes:
   * the queued fields with the refused `invoices` body beside them.
   */
  it("replays a second supplementary invoice from its queued payload (#3193)", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "ManualRefundTask",
        localId: "task_2",
        requestPayload: {
          queueType: "SUPPLEMENTARY_INVOICE",
          bookingId: "book_123",
          priceDiffCents: 3000,
          changeFeeCents: 0,
          bookingModificationId: "mod_123",
          shortfallReviewTaskId: "task_2",
          recordPayment: false,
          // The refused Xero body the create path records beside the queued
          // fields. Present here so this row is the shape a real rejection
          // leaves, rather than a cleaner one that never reaches this screen.
          invoices: [{ total: 30 }],
        },
      })
    );

    await expect(
      retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" })
    ).resolves.toEqual({
      message:
        "Retried the second Xero supplementary invoice for a settled booking-review share.",
    });

    expect(mocks.createXeroSupplementaryInvoice).toHaveBeenCalledWith({
      bookingId: "book_123",
      // THE SHARE, NEVER THE TOTAL, on the replay as on the original.
      priceDiffCents: 3000,
      changeFeeCents: 0,
      bookingModificationId: "mod_123",
      shortfallReviewTaskId: "task_2",
      createdByMemberId: "admin_1",
      // A second ask is raised only because the change's invoice had already
      // gone out, so on the card route the card was taken at the earlier figure
      // and nothing has been paid against this one.
      recordPayment: false,
      repairExistingLink: true,
    });
  });

  /**
   * AND IT REFUSES RATHER THAN GUESSES when the payload is gone. The change's
   * own invoice can be rebuilt from the `BookingModification` row; a second ask
   * cannot, because the share it bills lives only in the payload. Rebuilding
   * from the task's current amount would be a claim about what this row was
   * queued with.
   *
   * This is now the LAST RESORT rather than the ordinary Xero-rejection ending,
   * which is what it silently was before the create path stopped replacing the
   * payload. It stays pinned because the refusal must never quietly become a
   * rebuild.
   */
  it("refuses to replay a second supplementary invoice whose payload was overwritten", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "ManualRefundTask",
        localId: "task_2",
        requestPayload: { invoices: [{ total: 30 }] },
      })
    );

    await expect(
      retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" })
    ).rejects.toThrow(/cannot be replayed from this screen/);
    expect(mocks.createXeroSupplementaryInvoice).not.toHaveBeenCalled();
  });

  // #1356: a surviving queued payload wins over the modification record — the
  // Xero idempotency key embeds the amounts, so replaying the stored values
  // keeps the retry deduplicable against the original attempt (a pre-#1356
  // clamped operation must NOT re-bill under a fresh signed key).
  it("replays the STORED payload amounts over the record for key stability (#1356)", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "BookingModification",
        localId: "mod_legacy",
        requestPayload: {
          queueType: "SUPPLEMENTARY_INVOICE",
          bookingId: "book_123",
          priceDiffCents: 0,
          changeFeeCents: 1000,
        },
      })
    );
    mocks.findUniqueBookingModification.mockResolvedValue({
      bookingId: "book_123",
      priceDiffCents: -500,
      changeFeeCents: 1000,
    });

    await retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" });

    expect(mocks.createXeroSupplementaryInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        priceDiffCents: 0,
        changeFeeCents: 1000,
      })
    );
  });

  // F7 (#1882): the retry branch must thread recordPayment exactly like the
  // outbox dispatch (`recordPayment: payload.recordPayment ?? true`). A
  // positive-delta edit with no confirmed additional Stripe payment (e.g. an
  // unpaid Internet-Banking supplementary invoice) is queued with
  // recordPayment=false; a retry that drops the flag lets the worker default
  // to true and books a phantom Stripe-clearing payment for cash that was
  // never captured.
  it("replays the STORED recordPayment=false so a retry cannot record phantom cash (#1882)", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "BookingModification",
        localId: "mod_ib_unpaid",
        requestPayload: {
          queueType: "SUPPLEMENTARY_INVOICE",
          bookingId: "book_123",
          priceDiffCents: 2500,
          changeFeeCents: 500,
          recordPayment: false,
        },
      })
    );
    mocks.findUniqueBookingModification.mockResolvedValue({
      bookingId: "book_123",
      priceDiffCents: 2500,
      changeFeeCents: 500,
      createdAt: new Date("2026-07-01T00:00:00Z"),
    });

    await retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" });

    expect(mocks.createXeroSupplementaryInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ recordPayment: false })
    );
  });

  it("defaults a stored payload without the flag to recordPayment=true like the outbox dispatch (#1882)", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "BookingModification",
        localId: "mod_pre_flag",
        requestPayload: {
          queueType: "SUPPLEMENTARY_INVOICE",
          bookingId: "book_123",
          priceDiffCents: 2500,
          changeFeeCents: 500,
        },
      })
    );
    mocks.findUniqueBookingModification.mockResolvedValue({
      bookingId: "book_123",
      priceDiffCents: 2500,
      changeFeeCents: 500,
      createdAt: new Date("2026-07-01T00:00:00Z"),
    });

    await retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" });

    expect(mocks.createXeroSupplementaryInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ recordPayment: true })
    );
  });

  // F7 (#1882): the worker overwrites requestPayload with the raw Xero request
  // shape before calling Xero, so a FAILED op from a real Xero error has lost
  // the recordPayment flag. The retry must then derive it from capture
  // evidence — a SUCCEEDED ADDITIONAL Stripe transaction for this booking
  // matching the modification net — and never record cash without evidence.
  it("derives recordPayment=false when the overwritten payload has no capture evidence (#1882)", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "BookingModification",
        localId: "mod_overwritten",
        requestPayload: {
          invoices: [{ lineItems: [{ unitAmount: 30 }] }],
        },
      })
    );
    mocks.findUniqueBookingModification.mockResolvedValue({
      bookingId: "book_123",
      priceDiffCents: 2500,
      changeFeeCents: 500,
      createdAt: new Date("2026-07-01T00:00:00Z"),
    });
    mocks.findFirstPaymentTransaction.mockResolvedValue(null);

    await retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" });

    expect(mocks.findFirstPaymentTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          payment: { bookingId: "book_123" },
          kind: "ADDITIONAL",
          source: "STRIPE",
          status: "SUCCEEDED",
          amountCents: 3000,
        }),
      })
    );
    expect(mocks.createXeroSupplementaryInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ recordPayment: false })
    );
  });

  it("records payment on an overwritten-payload retry only with a SUCCEEDED ADDITIONAL capture (#1882)", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "BookingModification",
        localId: "mod_captured",
        requestPayload: {
          invoices: [{ lineItems: [{ unitAmount: 30 }] }],
        },
      })
    );
    mocks.findUniqueBookingModification.mockResolvedValue({
      bookingId: "book_123",
      priceDiffCents: 2500,
      changeFeeCents: 500,
      createdAt: new Date("2026-07-01T00:00:00Z"),
    });
    mocks.findFirstPaymentTransaction.mockResolvedValue({ id: "txn_1" });

    await retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" });

    expect(mocks.createXeroSupplementaryInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ recordPayment: true })
    );
  });

  it("refuses to rebuild a supplementary invoice whose signed net is not billable (#1356)", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "BookingModification",
        localId: "mod_net_negative",
      })
    );
    mocks.findUniqueBookingModification.mockResolvedValue({
      bookingId: "book_123",
      priceDiffCents: -1500,
      changeFeeCents: 1000,
    });

    await expect(
      retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" })
    ).rejects.toThrow("no longer has a billable Xero delta");
    expect(mocks.createXeroSupplementaryInvoice).not.toHaveBeenCalled();
  });

  // #1356 (F16): the rebuilt supplementary invoice must keep the SIGNED price
  // reduction so its lines sum to the net, matching the primary queue path.
  it("replays mixed-sign supplementary invoices with the signed reduction (#1356)", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "BookingModification",
        localId: "mod_mixed",
      })
    );
    mocks.findUniqueBookingModification.mockResolvedValue({
      bookingId: "book_123",
      priceDiffCents: -500,
      changeFeeCents: 1000,
    });

    await retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" });

    expect(mocks.createXeroSupplementaryInvoice).toHaveBeenCalledWith({
      bookingId: "book_123",
      priceDiffCents: -500,
      changeFeeCents: 1000,
      bookingModificationId: "mod_mixed",
      createdByMemberId: "admin_1",
      // No queued payload and no SUCCEEDED ADDITIONAL capture in this
      // scenario, so the retry must not record cash (#1882).
      recordPayment: false,
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

  // #1356: the enqueued policy-limited refund amount wins over any rebuild —
  // the modification row does not record the settlement cap, and the amount
  // is embedded in the Xero idempotency key.
  it("replays the STORED policy-limited credit-note amount over the record (#1356)", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "BookingModification",
        localId: "mod_policy",
        requestPayload: {
          queueType: "MODIFICATION_CREDIT_NOTE",
          bookingId: "book_123",
          refundAmountCents: 2500,
          bookingModificationId: "mod_policy",
        },
      })
    );
    mocks.findUniqueBookingModification.mockResolvedValue({
      bookingId: "book_123",
      priceDiffCents: -10000,
      changeFeeCents: 0,
    });

    await retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" });

    expect(mocks.createXeroCreditNoteForModification).toHaveBeenCalledWith(
      expect.objectContaining({ refundAmountCents: 2500 })
    );
  });

  it("recovers the stored amount from an executor-overwritten credit-note payload (#1356)", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "BookingModification",
        localId: "mod_overwritten",
        requestPayload: {
          creditNotes: [{ lineItems: [{ quantity: 1, unitAmount: 25 }] }],
          invoiceId: "inv_orig",
          refundAmountCents: 2500,
        },
      })
    );
    mocks.findUniqueBookingModification.mockResolvedValue({
      bookingId: "book_123",
      priceDiffCents: -10000,
      changeFeeCents: 0,
    });

    await retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" });

    expect(mocks.createXeroCreditNoteForModification).toHaveBeenCalledWith(
      expect.objectContaining({ refundAmountCents: 2500 })
    );
  });

  // #1356: an account-credit settlement rebuilds as an UNAPPLIED credit note —
  // the member already holds the matching spendable credit locally, so an
  // invoice-applied note would double-count the reduction.
  it("replays account-credit modification ops as unapplied credit notes (#1356)", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "BookingModification",
        localId: "mod_account",
        requestPayload: {
          queueType: "MODIFICATION_ACCOUNT_CREDIT_NOTE",
          bookingId: "book_123",
          paymentId: "pay_123",
          refundAmountCents: 3750,
          bookingModificationId: "mod_account",
        },
      })
    );
    mocks.findUniqueBookingModification.mockResolvedValue({
      bookingId: "book_123",
      priceDiffCents: -5000,
      changeFeeCents: 0,
    });

    await expect(
      retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" })
    ).resolves.toEqual({
      message: "Retried Xero modification account-credit note creation.",
    });

    expect(mocks.createUnappliedXeroCreditNoteForModification).toHaveBeenCalledWith({
      paymentId: "pay_123",
      refundAmountCents: 3750,
      bookingModificationId: "mod_account",
      createdByMemberId: "admin_1",
    });
    expect(mocks.createXeroCreditNoteForModification).not.toHaveBeenCalled();
  });

  it("discriminates account-credit ops via the queueType column when the payload was overwritten (#1356)", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "BookingModification",
        localId: "mod_account_overwritten",
        queueType: "MODIFICATION_ACCOUNT_CREDIT_NOTE",
        requestPayload: {
          creditNotes: [{ lineItems: [{ quantity: 1, unitAmount: 37.5 }] }],
        },
      })
    );
    mocks.findUniqueBookingModification.mockResolvedValue({
      bookingId: "book_123",
      priceDiffCents: -3750,
      changeFeeCents: 0,
    });
    mocks.findUniqueBooking.mockResolvedValue({
      payment: { id: "pay_123" },
    });

    await retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" });

    expect(mocks.createUnappliedXeroCreditNoteForModification).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "pay_123",
        refundAmountCents: 3750,
      })
    );
    expect(mocks.createXeroCreditNoteForModification).not.toHaveBeenCalled();
  });

  // #1356 (F16): the rebuilt modification credit note refunds the NET of the
  // signed components — |priceDiff| alone would over-credit by the fee on a
  // mixed-sign reduction-plus-fee edit.
  it("replays mixed-sign modification credit notes for the net, not |priceDiff| (#1356)", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "BookingModification",
        localId: "mod_mixed_net",
      })
    );
    mocks.findUniqueBookingModification.mockResolvedValue({
      bookingId: "book_123",
      priceDiffCents: -1000,
      changeFeeCents: 500,
    });

    await retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" });

    expect(mocks.createXeroCreditNoteForModification).toHaveBeenCalledWith({
      bookingId: "book_123",
      refundAmountCents: 500,
      bookingModificationId: "mod_mixed_net",
      createdByMemberId: "admin_1",
      repairExistingLink: true,
    });
  });

  it("refuses to rebuild a modification credit note when the signed net is not a reduction (#1356)", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "BookingModification",
        localId: "mod_net_positive",
      })
    );
    mocks.findUniqueBookingModification.mockResolvedValue({
      bookingId: "book_123",
      priceDiffCents: -500,
      changeFeeCents: 1000,
    });

    await expect(
      retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" })
    ).rejects.toThrow("no longer has a refundable Xero delta");
    expect(mocks.createXeroCreditNoteForModification).not.toHaveBeenCalled();
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
      reference: `${CLUB_NAME} invoice payment pay_123`,
      role: "INVOICE_PAYMENT",
      createdByMemberId: "admin_1",
      metadata: {
        invoiceId: "inv_123",
        amountCents: 4567,
      },
    });
  });

  // #2258 round-2, money-adjacent: an invoice can be PARTIAL because only its
  // EMAIL failed, and every such case is an INTERNET_BANKING booking whose Xero
  // payment is deliberately skipped because the member has not paid. Repairing
  // one records a bank payment against an unpaid invoice and falsely settles it.
  it("refuses the payment repair when the PARTIAL was email-only, not a payment fault", async () => {
    const emailOnlyPartial = makeOperation({
      status: "PARTIAL",
      xeroObjectId: "inv_123",
      responsePayload: {
        invoice: { invoices: [{ total: 45.67 }] },
        paymentError: null,
        paymentSkipped: true,
        invoiceEmailError: { message: "emailInvoice failed" },
      },
    });
    mocks.findUniqueOperation.mockResolvedValue(emailOnlyPartial);

    // Not offered in the panel...
    const meta = getXeroOperationRetryMeta(emailOnlyPartial);
    expect(meta.supported).toBe(false);
    expect(meta.reason).toContain("falsely settle");

    // ...and not performed if invoked anyway.
    await expect(
      retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" })
    ).rejects.toThrow();
    expect(mocks.createXeroPaymentForInvoice).not.toHaveBeenCalled();
  });

  it("refuses it for a withheld-by-No-emails PARTIAL too", async () => {
    const withheldPartial = makeOperation({
      status: "PARTIAL",
      xeroObjectId: "inv_123",
      responsePayload: {
        invoice: { invoices: [{ total: 45.67 }] },
        paymentError: null,
        invoiceEmailWithheldByNoEmails: true,
      },
    });
    mocks.findUniqueOperation.mockResolvedValue(withheldPartial);

    expect(getXeroOperationRetryMeta(withheldPartial).supported).toBe(false);
    await expect(
      retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" })
    ).rejects.toThrow();
    expect(mocks.createXeroPaymentForInvoice).not.toHaveBeenCalled();
  });

  it("still repairs a genuine payment fault, and a legacy payload of unknown shape", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        status: "PARTIAL",
        xeroObjectId: "inv_123",
        responsePayload: {
          invoice: { invoices: [{ total: 45.67 }] },
          paymentError: { message: "Xero rejected the payment" },
        },
      })
    );

    await expect(
      retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" })
    ).resolves.toEqual({
      message: "Repaired Xero booking invoice payment recording.",
    });
    expect(mocks.createXeroPaymentForInvoice).toHaveBeenCalled();
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
      reference: `${CLUB_NAME} supplementary payment mod_123`,
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

  it("replays membership cancellation credit note creation using the stored request payload", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "MemberSubscription",
        localId: "sub_123",
        requestPayload: {
          requestId: "request_1",
          participantId: "participant_1",
        },
      })
    );

    await expect(
      retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" })
    ).resolves.toEqual({
      message: "Retried Xero membership cancellation credit note creation.",
    });

    expect(mocks.createXeroMembershipCancellationCreditNote).toHaveBeenCalledWith({
      subscriptionId: "sub_123",
      requestId: "request_1",
      participantId: "participant_1",
      createdByMemberId: "admin_1",
      syncOperationId: "op_123",
    });
  });

  it("atomically queues applied-credit allocation for sole outbox execution", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "ALLOCATION",
        operationType: "ALLOCATE",
        localModel: "Payment",
        localId: "pay_123",
        requestPayload: {
          queueType: XERO_OUTBOX_APPLIED_CREDIT_ALLOCATION_TYPE,
          bookingId: "b1",
        },
      })
    );

    await expect(
      retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" })
    ).resolves.toEqual({ message: "Queued applied-credit allocation retry." });

    expect(mocks.updateManyOperation).toHaveBeenCalledWith({
      where: { id: "op_123", status: { in: ["FAILED", "PARTIAL"] } },
      data: {
        status: "PENDING",
        startedAt: null,
        completedAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });
    expect(mocks.allocateAppliedCreditForBooking).not.toHaveBeenCalled();
    expect(mocks.allocateCreditNoteToInvoice).not.toHaveBeenCalled();
  });

  it("never executes a failed applied-credit child inline after its parent can race deallocation", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "ALLOCATION",
        operationType: "ALLOCATE",
        localModel: "MemberCreditNoteAllocation",
        localId: "slice_1",
        requestPayload: {
          creditNoteId: "cn_1",
          invoiceId: "inv_1",
          amountCents: 2500,
          appliedCreditContext: {
            parentOperationId: "parent_op_1",
            bookingId: "booking_1",
            paymentId: "payment_1",
          },
        },
      }),
    );

    await expect(
      Promise.all([
        retryXeroSyncOperation("child_op_1", { createdByMemberId: "admin_1" }),
        retryXeroSyncOperation("child_op_1", { createdByMemberId: "admin_2" }),
      ]),
    ).rejects.toThrow("Retry the serialized parent applied-credit operation parent_op_1");
    expect(mocks.allocateCreditNoteToInvoice).not.toHaveBeenCalled();
    expect(mocks.updateManyOperation).not.toHaveBeenCalled();
  });

  it.each([
    ["existing-note", "MemberCreditNoteAllocation", "slice_legacy_1"],
    ["minted remainder", "Payment", "payment_legacy_1"],
  ])(
    "never executes a contextless legacy %s child inline",
    async (_label, localModel, localId) => {
      mocks.findUniqueOperation.mockResolvedValue(
        makeOperation({
          entityType: "ALLOCATION",
          operationType: "ALLOCATE",
          localModel,
          localId,
          requestPayload: {
            creditNoteId: "cn_legacy_1",
            invoiceId: "inv_legacy_1",
            amountCents: 2500,
          },
        }),
      );

      await expect(
        retryXeroSyncOperation("legacy_child_1", {
          createdByMemberId: "admin_1",
        }),
      ).rejects.toThrow(
        "This legacy applied-credit child allocation must be retried through its serialized parent workflow.",
      );
      expect(mocks.allocateCreditNoteToInvoice).not.toHaveBeenCalled();
      expect(mocks.updateManyOperation).not.toHaveBeenCalled();
    },
  );

  it("still executes an unrelated queue-shaped Payment allocation retry", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "ALLOCATION",
        operationType: "ALLOCATE",
        localModel: "Payment",
        localId: "payment_repair_1",
        requestPayload: {
          queueType: XERO_OUTBOX_CREDIT_NOTE_ALLOCATION_TYPE,
          creditNoteId: "cn_repair_1",
          invoiceId: "inv_repair_1",
          amountCents: 1200,
          role: "CREDIT_NOTE_ALLOCATION",
        },
      }),
    );

    await expect(
      retryXeroSyncOperation("repair_allocation_1", {
        createdByMemberId: "admin_1",
      }),
    ).resolves.toEqual({ message: "Retried Xero credit note allocation." });
    expect(mocks.allocateCreditNoteToInvoice).toHaveBeenCalledWith(
      "cn_repair_1",
      "inv_repair_1",
      1200,
      {
        localModel: "Payment",
        localId: "payment_repair_1",
        createdByMemberId: "admin_1",
      },
    );
  });
  it("queues checkpointed applied-credit deallocation without an inline provider call", async () => {
    mocks.findUniqueOperation.mockResolvedValue(makeOperation({
      entityType: "ALLOCATION",
      operationType: "UPDATE",
      localModel: "Payment",
      localId: "pay_123",
      requestPayload: {
        queueType: XERO_OUTBOX_APPLIED_CREDIT_DEALLOCATION_TYPE,
        bookingId: "b1",
        checkpoint: { allocationIds: ["alloc-1"] },
      },
    }));
    await expect(retryXeroSyncOperation("op_123")).resolves.toEqual({
      message: "Queued applied-credit deallocation retry.",
    });
    expect(mocks.deallocateExcessAppliedCreditForBooking).not.toHaveBeenCalled();
  });

  it("lets only one of two simultaneous applied-credit retries win the CAS", async () => {
    mocks.findUniqueOperation.mockResolvedValue(makeOperation({
      entityType: "ALLOCATION",
      operationType: "UPDATE",
      localModel: "Payment",
      localId: "pay_123",
      requestPayload: {
        queueType: XERO_OUTBOX_APPLIED_CREDIT_DEALLOCATION_TYPE,
        bookingId: "b1",
        checkpoint: { allocationIds: ["alloc-1"] },
      },
    }));
    mocks.updateManyOperation
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    const results = await Promise.allSettled([
      retryXeroSyncOperation("op_123"),
      retryXeroSyncOperation("op_123"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(mocks.deallocateExcessAppliedCreditForBooking).not.toHaveBeenCalled();
  });

  it("accepts PARTIAL applied-credit operations for outbox requeue", async () => {
    mocks.findUniqueOperation.mockResolvedValue(makeOperation({
      status: "PARTIAL",
      entityType: "ALLOCATION",
      operationType: "UPDATE",
      localModel: "Payment",
      localId: "pay_123",
      requestPayload: {
        queueType: XERO_OUTBOX_APPLIED_CREDIT_DEALLOCATION_TYPE,
        bookingId: "b1",
      },
    }));
    await expect(retryXeroSyncOperation("op_123")).resolves.toEqual({
      message: "Queued applied-credit deallocation retry.",
    });
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
