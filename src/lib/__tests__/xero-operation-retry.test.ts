import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  // `INV-PAY-101`: the settlement decision the repair leg shares with the
  // inline leg reads the Stripe account and the bank-transfer refund account
  // through these.
  getAccountMapping: vi.fn(),
  getResolvedAccountMapping: vi.fn(),
  findUniqueOperation: vi.fn(),
  updateManyOperation: vi.fn(),
  findUniqueSubscriptionCharge: vi.fn(),
  // #3994 F1: the requeue looks for a sibling resolved after the row was queued.
  findFirstOperation: vi.fn(),
  findUniquePayment: vi.fn(),
  findUniqueMember: vi.fn(),
  updatePayment: vi.fn(),
  findUniqueBookingModification: vi.fn(),
  findUniqueBooking: vi.fn(),
  findFirstPaymentTransaction: vi.fn(),
  completeXeroSyncOperation: vi.fn(),
  failXeroSyncOperation: vi.fn(),
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
  findManyXeroObjectLink: vi.fn().mockResolvedValue([]),
  // #3924 round 10: a late charge's change invoice is told by its approval
  // task, and one already linked in Xero is refused.
  findUniqueManualRefundTask: vi.fn().mockResolvedValue(null),
  // #3924 round 12: what the linked change invoice's 409 names - the close's
  // share, and the card refunds no note answers.
  findLateCaptureRefundPaidAnotherWay: vi.fn().mockResolvedValue(null),
  readUnnotedLateCaptureCardRefunds: vi
    .fn()
    .mockResolvedValue({ byHandCents: 0, mayBeInXeroCents: 0, notesCanStillLand: false, notedLaterCents: 0 }),
  findFirstXeroObjectLink: vi.fn().mockResolvedValue(null),
  // #3548: the one read-back-then-settle the repair leg hands a note to.
  finishRefundCreditNoteSettlement: vi.fn().mockResolvedValue({ refundPaymentErr: null }),
  allocateCreditNoteToInvoice: vi.fn(),
  checkMembershipStatus: vi.fn(),
  createXeroMembershipCancellationCreditNote: vi.fn(),
  allocateAppliedCreditForBooking: vi.fn(),
  deallocateExcessAppliedCreditForBooking: vi.fn(),
  // #3953 round 9: the replay's recordPayment, asked again under the change's anchor lock.
  supplementaryReplayMayRecordPayment: vi.fn(),
  // #4494: the PARTIAL repair's credit-release check for a gap invoice (resets to undefined: repair as before).
  skipPartialGapRepairPayment: vi.fn(),
}));

vi.mock("@/lib/credit-release-xero-payment", () => ({
  skipPartialGapRepairPayment: async (...args: unknown[]) => (await mocks.skipPartialGapRepairPayment(...args)) ?? null,
}));

vi.mock("@/lib/additional-capture-receipt-gate", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/additional-capture-receipt-gate")),
  supplementaryReplayMayRecordPayment: async (...args: unknown[]) =>
    (await mocks.supplementaryReplayMayRecordPayment(...args)) ?? { recordPayment: true, raisedUnpaid: false },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    xeroSyncOperation: {
      findUnique: mocks.findUniqueOperation,
      updateMany: mocks.updateManyOperation,
      findFirst: mocks.findFirstOperation,
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
    // #3971: a subscription invoice retry reads its charge first.
    membershipSubscriptionCharge: {
      findUnique: mocks.findUniqueSubscriptionCharge,
    },
    // #3535: a PARTIAL clearing note's repair skips targets already allocated.
    xeroObjectLink: {
      findMany: mocks.findManyXeroObjectLink,
      findFirst: mocks.findFirstXeroObjectLink,
    },
    manualRefundTask: {
      findUnique: mocks.findUniqueManualRefundTask,
    },
  },
}));

vi.mock("@/lib/xero-contact-sync", () => ({
  buildXeroContactUpdatePayload: mocks.buildXeroContactUpdatePayload,
  shouldRepairXeroContactNameOrder: mocks.shouldRepairXeroContactNameOrder,
}));

vi.mock("@/lib/xero-mappings", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/xero-mappings");
  return {
    ...actual,
    getAccountMapping: mocks.getAccountMapping,
    getResolvedAccountMapping: mocks.getResolvedAccountMapping,
  };
});

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
  finishRefundCreditNoteSettlement: mocks.finishRefundCreditNoteSettlement,
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

vi.mock("@/lib/late-capture-paid-another-way", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/late-capture-paid-another-way")),
  findLateCaptureRefundPaidAnotherWay: mocks.findLateCaptureRefundPaidAnotherWay,
}));
vi.mock("@/lib/late-capture-refund-credit-note", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/late-capture-refund-credit-note")),
  readUnnotedLateCaptureCardRefunds: mocks.readUnnotedLateCaptureCardRefunds,
}));

vi.mock("@/lib/xero-sync", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/xero-sync");

  return {
    ...actual,
    completeXeroSyncOperation: mocks.completeXeroSyncOperation,
    failXeroSyncOperation: mocks.failXeroSyncOperation,
  };
});

import {
  getXeroOperationRetryMeta,
  PARTIAL_REPAIR_CLAIM_LOST_MESSAGE,
  retryAbandonedItsClaim,
  retryXeroSyncOperation,
  XeroOperationNotReplayableError,
  XeroOperationResolvedInXeroError,
  XeroOperationRetryError,
} from "@/lib/xero-operation-retry";
import { RESOLVED_IN_XERO_RETRY_REASON } from "@/lib/xero-operation-resolution";
import {
  XERO_OUTBOX_CREDIT_NOTE_ALLOCATION_TYPE,
  XERO_OUTBOX_APPLIED_CREDIT_ALLOCATION_TYPE,
  XERO_OUTBOX_APPLIED_CREDIT_DEALLOCATION_TYPE,
  XERO_OUTBOX_GROUP_SETTLEMENT_INVOICE_TYPE,
} from "@/lib/xero-operation-outbox-payload";
import { CLUB_NAME } from "@/config/club-identity";
import { PRIMARY_INVOICE_NOTHING_LEFT_DUE_REASON } from "@/lib/xero-primary-invoice-fee-at-link";
import { PARTIAL_REPAIR_EMAIL_STILL_FAILED_MESSAGE } from "@/lib/xero-partial-invoice-repair-amount";
import { XERO_PARTIAL_REPAIR_RUNNING_CODE, XERO_REFUND_NOTE_REPAIR_RUNNING_CODE } from "@/lib/xero-stale-operations";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { cardRefundNoteKeyTag } from "@/lib/card-refund-paid-another-way-cash";

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
    manuallyResolvedAt: null,
    ...overrides,
  };
}

const RESOLVED_AT = new Date("2026-06-20T00:00:00.000Z");

describe("resolved in Xero is never re-run (#3635, INV-INT-025)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstOperation.mockResolvedValue(null);
    mocks.updateManyOperation.mockResolvedValue({ count: 1 });
  });

  it.each([
    ["a failed booking invoice", {}],
    ["a failed booking invoice update", { operationType: "UPDATE" }],
    [
      "a failed group settlement invoice",
      {
        localModel: "GroupBookingSettlement",
        localId: "settlement_1",
        queueType: XERO_OUTBOX_GROUP_SETTLEMENT_INVOICE_TYPE,
      },
    ],
  ])("refuses %s the officer resolved, whatever else would allow it", (_label, overrides) => {
    const live = makeOperation(overrides);
    // The control: the same row unresolved is retryable, so only the mark
    // can be what refuses it.
    expect(getXeroOperationRetryMeta(live).supported).toBe(true);
    expect(getXeroOperationRetryMeta({ ...live, manuallyResolvedAt: RESOLVED_AT })).toEqual({
      supported: false,
      reason: RESOLVED_IN_XERO_RETRY_REASON,
    });
  });

  it.each([
    ["allocation", XERO_OUTBOX_APPLIED_CREDIT_ALLOCATION_TYPE, "ALLOCATE"],
    ["deallocation", XERO_OUTBOX_APPLIED_CREDIT_DEALLOCATION_TYPE, "UPDATE"],
  ])(
    "an applied-credit %s resolved before this release stays retryable, so its fence can converge (#3635 N2)",
    async (_label, queueType, operationType) => {
      const resolvedBeforeRelease = makeOperation({
        entityType: "ALLOCATION",
        operationType,
        localModel: "Payment",
        localId: "pay_1",
        queueType,
        requestPayload: { queueType, bookingId: "book_1", paymentId: "pay_1" },
        manuallyResolvedAt: RESOLVED_AT,
      });
      expect(getXeroOperationRetryMeta(resolvedBeforeRelease)).toEqual({
        supported: true,
        reason: null,
      });
      mocks.findUniqueOperation.mockResolvedValue(resolvedBeforeRelease);

      await expect(retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST)).resolves.toEqual({
        message: expect.stringContaining("Queued applied-credit"),
      });
      expect(mocks.updateManyOperation).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "PENDING" }) })
      );
    }
  );

  it("retryXeroSyncOperation re-reads the row and 409s a resolved one without claiming it or calling Xero", async () => {
    mocks.findUniqueOperation.mockResolvedValue(makeOperation({ manuallyResolvedAt: RESOLVED_AT }));
    mocks.findUniquePayment.mockResolvedValue({ bookingId: "book_123" });

    await expect(
      retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" })
    ).rejects.toBeInstanceOf(XeroOperationResolvedInXeroError);
    await expect(
      retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST)
    ).rejects.toMatchObject({ status: 409, message: RESOLVED_IN_XERO_RETRY_REASON });
    expect(mocks.updateManyOperation).not.toHaveBeenCalled();
    expect(mocks.createXeroInvoiceForBooking).not.toHaveBeenCalled();
  });

  it("a resolve landing between the read and the claim makes the claim lose (no mint)", async () => {
    // The read saw the row unresolved; the claim's `manuallyResolvedAt: null`
    // guard is what matches nothing once the officer's mark has landed.
    // First read: unresolved. The re-read after the lost claim: resolved.
    mocks.findUniqueOperation
      .mockResolvedValueOnce(makeOperation())
      .mockResolvedValueOnce({ manuallyResolvedAt: RESOLVED_AT });
    mocks.findUniquePayment.mockResolvedValue({ bookingId: "book_123" });
    mocks.updateManyOperation.mockImplementation(async (args: { where: Record<string, unknown> }) => ({
      count: args.where.manuallyResolvedAt === null ? 0 : 1,
    }));

    // The resolved error, not "claimed by another retry", so the drain closes
    // its queued row CANCELLED rather than FAILED.
    await expect(retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST)).rejects.toBeInstanceOf(
      XeroOperationResolvedInXeroError
    );
    expect(mocks.createXeroInvoiceForBooking).not.toHaveBeenCalled();
  });
});

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

  it("gives a stray subscription invoice (raised after its charge was closed as paid) its own reason, not a payload repair (#4098 review)", () => {
    expect(
      getXeroOperationRetryMeta(
        makeOperation({
          status: "PARTIAL",
          localModel: "MembershipSubscriptionCharge",
          localId: "charge-1",
          xeroObjectId: "inv_stray",
          responsePayload: { conflict: "STRAY_INVOICE_AFTER_CLOSE", invoice: { invoiceID: "inv_stray" }, adopted: false, email: null },
        })
      )
    ).toEqual({
      supported: false,
      reason: expect.stringMatching(/^The membership charge was closed as already paid while this invoice was being raised.*Void it in Xero promptly.*then mark this operation resolved\. There is nothing to retry\.$/),
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

// #3535: a FAILED booking-anchored invoice-clearing note (hold expiry, the
// never-captured cancel, the repair re-queue) was refused by the retry screen,
// leaving the unpaid invoice open with no way back.
describe("booking-anchored clearing note retries (#3535)", () => {
  const clearingOperation = (requestPayload: Record<string, unknown>, queueType: string | null = "MODIFICATION_CREDIT_NOTE") =>
    makeOperation({
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel: "Booking",
      localId: "booking_7",
      queueType,
      requestPayload,
    });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstOperation.mockResolvedValue(null);
    mocks.updateManyOperation.mockResolvedValue({ count: 1 });
  });

  it("marks a failed clearing note retryable from its queued or its executed payload", () => {
    expect(
      getXeroOperationRetryMeta(
        clearingOperation({
          queueType: "MODIFICATION_CREDIT_NOTE",
          bookingId: "booking_7",
          refundAmountCents: 15000,
          bookingModificationId: null,
          clearsUnpaidInvoice: true,
        })
      )
    ).toEqual({ supported: true, reason: null });
    expect(
      getXeroOperationRetryMeta(
        clearingOperation(
          { invoiceId: "inv_7", refundAmountCents: 15000, clearsUnpaidInvoice: true },
          null
        )
      )
    ).toEqual({ supported: true, reason: null });
  });

  it("refuses a booking-anchored row with no recorded amount", () => {
    expect(
      getXeroOperationRetryMeta(clearingOperation({ queueType: "MODIFICATION_CREDIT_NOTE", bookingId: "booking_7" }))
        .supported
    ).toBe(false);
  });

  it("replays the recorded amount and keeps the clearing wording", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      clearingOperation(
        { invoiceId: "inv_7", refundAmountCents: 15000, clearsUnpaidInvoice: true },
        null
      )
    );
    mocks.createXeroCreditNoteForModification.mockResolvedValue("cn_7");

    await expect(
      retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" })
    ).resolves.toEqual({ message: "Retried Xero invoice-clearing credit note creation." });

    expect(mocks.createXeroCreditNoteForModification).toHaveBeenCalledWith({
      bookingId: "booking_7",
      refundAmountCents: 15000,
      createdByMemberId: "admin_1",
      repairExistingLink: true,
      clearsUnpaidInvoice: true,
      format: CLUB_FORMAT_TEST,
    });
    const [params] = mocks.createXeroCreditNoteForModification.mock.calls[0]!;
    expect(params).not.toHaveProperty("refundMethod");
  });
});

describe("retryXeroSyncOperation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstOperation.mockResolvedValue(null);
    mocks.getAccountMapping.mockResolvedValue("606");
    // Unset by default: a bank-transfer refund note is left unsettled.
    mocks.getResolvedAccountMapping.mockResolvedValue({
      code: null,
      itemCode: null,
      codeExplicitlyConfigured: false,
    });
    mocks.findUniqueMember.mockResolvedValue(null);
    mocks.updateManyOperation.mockResolvedValue({ count: 1 });
    // #4256: a completion onto the claim lands unless a test says it lost.
    mocks.completeXeroSyncOperation.mockResolvedValue({ id: "op_123" });
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
      retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" })
    ).resolves.toEqual({ message: "Retried Xero refund credit note creation." });

    // Delta mode re-entered: the watermark is threaded through (the value is
    // advisory — createXeroCreditNote recomputes coverage at execution time).
    expect(mocks.createXeroCreditNote).toHaveBeenCalledWith("pay_9", 3000, {
      createdByMemberId: "admin_1",
      repairExistingLink: true,
      watermarkCents: 8000,
    });
  });

  it("carries a queued refund method into the replay (INV-PAY-101)", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "CREDIT_NOTE",
        localId: "pay_9",
        queueType: "REFUND_CREDIT_NOTE",
        requestPayload: {
          queueType: "REFUND_CREDIT_NOTE",
          refundAmountCents: 3000,
          watermarkCents: 8000,
          refundMethod: "internet-banking",
        },
      })
    );

    await retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" });

    expect(mocks.createXeroCreditNote).toHaveBeenCalledWith("pay_9", 3000, {
      createdByMemberId: "admin_1",
      repairExistingLink: true,
      watermarkCents: 8000,
      refundMethod: "internet-banking",
    });
  });

  it.each([
    {
      shape: "queued",
      queueType: "REFUND_CREDIT_NOTE",
      requestPayload: {
        queueType: "REFUND_CREDIT_NOTE",
        refundAmountCents: 3000,
        watermarkCents: 8000,
        refundMethod: "internet-banking",
        noteWording: "cash",
        reviewTaskId: "task_review",
      },
    },
    {
      shape: "executed",
      queueType: null,
      requestPayload: {
        creditNotes: [{ lineItems: [{ unitAmount: 30 }] }],
        allocation: { invoiceId: "inv_1", amount: 30 },
        refundMethod: "internet-banking",
        noteWording: "cash",
        reviewTaskId: "task_review",
        watermarkCents: 8000,
        perDelta: true,
      },
    },
  ])("MUTATION (#3935): a $shape review hand-back row keeps the officer's cash wording on retry, keyed as before", async ({ queueType, requestPayload }) => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({ entityType: "CREDIT_NOTE", localId: "pay_9", queueType, requestPayload })
    );

    await retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" });

    expect(mocks.createXeroCreditNote).toHaveBeenCalledWith("pay_9", 3000, {
      createdByMemberId: "admin_1",
      repairExistingLink: true,
      watermarkCents: 8000,
      refundMethod: "internet-banking",
      noteWording: "cash",
      reviewTaskId: "task_review",
    });
  });

  it("MUTATION (#3935): a stored cash wording beside a card method is not replayed", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "CREDIT_NOTE",
        localId: "pay_9",
        queueType: "REFUND_CREDIT_NOTE",
        requestPayload: {
          queueType: "REFUND_CREDIT_NOTE",
          refundAmountCents: 3000,
          watermarkCents: 8000,
          refundMethod: "card",
          noteWording: "cash",
        },
      })
    );

    await retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" });

    expect(mocks.createXeroCreditNote.mock.calls[0]![2]).not.toHaveProperty("noteWording");
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
      retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" })
    ).resolves.toEqual({ message: "Retried Xero refund credit note creation." });

    expect(mocks.createXeroCreditNote).toHaveBeenCalledWith("pay_9", 3000, {
      createdByMemberId: "admin_1",
      repairExistingLink: true,
      watermarkCents: 0,
    });
  });

  it("MUTATION (#4312): a failed card refund note whose payload an older worker rewrote still retries as that refund's own note, from its key", async () => {
    // `createXeroCreditNote` rewrites the payload before the Xero call; an older
    // release's worker writes no `cardRefundId`, but the row's key still names it.
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "CREDIT_NOTE",
        localId: "pay_9",
        queueType: "REFUND_CREDIT_NOTE",
        correlationKey: `payment:pay_9:refund-credit-note${cardRefundNoteKeyTag("re_late")}0:v3`,
        requestPayload: {
          creditNotes: [{ lineItems: [{ unitAmount: 30 }] }],
          allocation: { invoiceId: "inv_1", amount: 30 },
        },
      })
    );

    await retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" });

    expect(mocks.createXeroCreditNote).toHaveBeenCalledWith("pay_9", 3000, {
      createdByMemberId: "admin_1",
      repairExistingLink: true,
      watermarkCents: 0,
      cardRefundId: "re_late",
    });
  });

  it("#4312: a card refund note's payload names its refund first", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "CREDIT_NOTE",
        localId: "pay_9",
        queueType: "REFUND_CREDIT_NOTE",
        correlationKey: `payment:pay_9:refund-credit-note${cardRefundNoteKeyTag("re_key")}0:v3`,
        requestPayload: { queueType: "REFUND_CREDIT_NOTE", refundAmountCents: 3000, cardRefundId: "re_payload" },
      })
    );

    await retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" });

    expect(mocks.createXeroCreditNote.mock.calls[0]![2]).toMatchObject({ cardRefundId: "re_payload" });
  });

  it("MUTATION (#3880 F2): an inline row (no queue type) re-enters delta mode from the watermark its payload recorded", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "CREDIT_NOTE",
        localId: "pay_9",
        queueType: null,
        requestPayload: {
          creditNotes: [{ lineItems: [{ unitAmount: 30 }] }],
          allocation: { invoiceId: "inv_1", amount: 30 },
          refundMethod: "internet-banking",
          reviewTaskId: "task_review",
          watermarkCents: 8000,
          perDelta: true,
        },
      })
    );

    await retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" });

    expect(mocks.createXeroCreditNote).toHaveBeenCalledWith("pay_9", 3000, {
      createdByMemberId: "admin_1",
      repairExistingLink: true,
      watermarkCents: 8000,
      refundMethod: "internet-banking",
      reviewTaskId: "task_review",
    });
  });

  it("MUTATION (#3880 F2): an inline row with a review task and no recorded watermark is still a delta run", async () => {
    // Single-note mode would call the cancellation's note this review refund's
    // cover, or raise a `v1` note that later hides the cancellation's own.
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "CREDIT_NOTE",
        localId: "pay_9",
        queueType: null,
        requestPayload: {
          creditNotes: [{ lineItems: [{ unitAmount: 30 }] }],
          allocation: { invoiceId: "inv_1", amount: 30 },
          refundMethod: "internet-banking",
          reviewTaskId: "task_review",
        },
      })
    );

    await retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" });

    expect(mocks.createXeroCreditNote).toHaveBeenCalledWith("pay_9", 3000, expect.objectContaining({ watermarkCents: 0, reviewTaskId: "task_review" }));
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
      retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" })
    ).resolves.toEqual({ message: "Retried Xero account-credit note creation." });

    expect(mocks.createUnappliedXeroCreditNote).toHaveBeenCalledWith("pay_9", 4500, CLUB_FORMAT_TEST, {
      createdByMemberId: "admin_1",
      repairExistingLink: true,
    });
  });

  it("replays booking invoice creation through the booking payment relationship, CLAIMING the row first (#2262 H3)", async () => {
    mocks.findUniqueOperation.mockResolvedValue(makeOperation());
    mocks.findUniquePayment.mockResolvedValue({ bookingId: "book_123" });
    mocks.createXeroInvoiceForBooking.mockResolvedValue("inv_1");

    await expect(
      retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" })
    ).resolves.toEqual({
      message: "Retried Xero booking invoice creation.",
    });

    // The claim makes the retry visible to the manual mark-paid settle-time
    // fence (RUNNING is in its in-flight set) for the whole execution, and the
    // threaded syncOperationId means completion lands on THIS row.
    expect(mocks.updateManyOperation).toHaveBeenCalledWith({
      // #3635: a resolve landing after the read makes the claim lose.
      where: {
        id: "op_123",
        status: { in: ["FAILED", "PARTIAL"] },
        manuallyResolvedAt: null,
        // #4256: a mark non-replayable landing after the read loses it too.
        replayable: true,
      },
      data: { status: "RUNNING", startedAt: expect.any(Date) },
    });
    expect(mocks.createXeroInvoiceForBooking).toHaveBeenCalledWith("book_123", {
      createdByMemberId: "admin_1",
      repairExistingLink: true,
      syncOperation: expect.objectContaining({ id: "op_123" }),
    });
    // The claim strictly precedes the mint call.
    expect(
      mocks.updateManyOperation.mock.invocationCallOrder[0]
    ).toBeLessThan(mocks.createXeroInvoiceForBooking.mock.invocationCallOrder[0]);
  });

  it.each([
    { recorded: { skipped: true, refusal: "ORGANISER_PAID_INTERNET_BANKING" }, says: /^No invoice was created: The group organiser paid this place by internet banking/ },
    { recorded: { skipped: true, reason: "Booking was manually marked paid" }, says: /manually marked paid \(cash \/ off-Xero\)/ },
  ])("#4299 B1: a refused booking-invoice retry names the fence the handler recorded ($recorded.refusal)", async ({ recorded, says }) => {
    mocks.findUniqueOperation.mockResolvedValueOnce(makeOperation()).mockResolvedValueOnce({ responsePayload: recorded });
    mocks.findUniquePayment.mockResolvedValue({ bookingId: "book_123" });
    mocks.createXeroInvoiceForBooking.mockResolvedValue(null);

    const { message } = await retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" });
    expect(message).toMatch(says);
  });

  it("409s a booking-invoice retry whose claim lost (already queued or claimed elsewhere) without calling Xero (#2262 H3)", async () => {
    mocks.findUniqueOperation.mockResolvedValue(makeOperation());
    mocks.findUniquePayment.mockResolvedValue({ bookingId: "book_123" });
    mocks.updateManyOperation.mockResolvedValue({ count: 0 });

    await expect(
      retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" })
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("already claimed"),
    });
    expect(mocks.createXeroInvoiceForBooking).not.toHaveBeenCalled();
  });

  it("returns the claimed original to FAILED when the invoice handler throws before it owns completion (#3462)", async () => {
    mocks.findUniqueOperation.mockResolvedValue(makeOperation());
    mocks.findUniquePayment.mockResolvedValue({ bookingId: "book_123" });
    const refusal = new Error("Matched Xero contact is already linked to another member");
    // The clock moves while the handler runs, as it does in production: the
    // frozen clock would otherwise make a fresh `new Date()` at abandon time
    // indistinguishable from the claim's own stamp.
    mocks.createXeroInvoiceForBooking.mockImplementation(async () => {
      vi.setSystemTime(new Date(Date.now() + 1_000));
      throw refusal;
    });
    mocks.failXeroSyncOperation.mockResolvedValue({ id: "op_123", status: "FAILED" });

    await expect(
      retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" })
    ).rejects.toBe(refusal);

    // The abandon is guarded on THIS claim: still RUNNING, still the instant
    // the claim stamped - so a row the handler already completed stays put.
    const claimData = mocks.updateManyOperation.mock.calls[0][0].data;
    expect(claimData.status).toBe("RUNNING");
    expect(mocks.failXeroSyncOperation).toHaveBeenCalledTimes(1);
    const [abandonedClaim, abandonedError, , abandonOptions] =
      mocks.failXeroSyncOperation.mock.calls[0];
    expect(abandonedClaim).toEqual({ id: "op_123", startedAt: claimData.startedAt });
    expect(abandonedClaim.startedAt).toBe(claimData.startedAt);
    expect(abandonedError).toBe(refusal);
    expect(abandonOptions).toEqual({ retryClaim: true });
    // ...and the REQUEUE drain may say the original is back to FAILED.
    expect(retryAbandonedItsClaim(refusal)).toBe(true);
  });

  it("does not report an abandon that matched nothing (#3462)", async () => {
    mocks.findUniqueOperation.mockResolvedValue(makeOperation());
    mocks.findUniquePayment.mockResolvedValue({ bookingId: "book_123" });
    const refusal = new Error("Handler closed the row itself, then threw");
    mocks.createXeroInvoiceForBooking.mockRejectedValue(refusal);
    // The guarded abandon found the row no longer this RUNNING claim.
    mocks.failXeroSyncOperation.mockResolvedValue(null);

    await expect(
      retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" })
    ).rejects.toBe(refusal);
    expect(retryAbandonedItsClaim(refusal)).toBe(false);
  });

  it("still reports the handler's own error when the abandon write itself fails (#3462)", async () => {
    mocks.findUniqueOperation.mockResolvedValue(makeOperation());
    mocks.findUniquePayment.mockResolvedValue({ bookingId: "book_123" });
    const refusal = new Error("Missing hut fees account code");
    mocks.createXeroInvoiceForBooking.mockRejectedValue(refusal);
    mocks.failXeroSyncOperation.mockRejectedValue(new Error("database unavailable"));

    await expect(
      retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" })
    ).rejects.toBe(refusal);
  });

  it("does not abandon anything when the invoice handler completes (#3462)", async () => {
    mocks.findUniqueOperation.mockResolvedValue(makeOperation());
    mocks.findUniquePayment.mockResolvedValue({ bookingId: "book_123" });
    mocks.createXeroInvoiceForBooking.mockResolvedValue("inv_1");

    await retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" });
    expect(mocks.failXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("reports the manual mark-paid abandon honestly instead of a false 'Retried' success (#2262 H3)", async () => {
    mocks.findUniqueOperation.mockResolvedValue(makeOperation());
    mocks.findUniquePayment.mockResolvedValue({ bookingId: "book_123" });
    // The handler's provenance re-check abandoned the mint (returns null after
    // closing the operation CANCELLED itself).
    mocks.createXeroInvoiceForBooking.mockResolvedValue(null);

    await expect(
      retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" })
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
      retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" })
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
      retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" })
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

    await retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" });

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

    await retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" });

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

    await retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" });

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
      retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" }),
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

    await retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" });

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
      retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" })
    ).resolves.toEqual({
      message: "Retried Xero account-credit note creation.",
    });

    expect(mocks.createUnappliedXeroCreditNote).toHaveBeenCalledWith("pay_123", 2345, CLUB_FORMAT_TEST, {
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

    await retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" });

    expect(mocks.createXeroSupplementaryInvoice).toHaveBeenCalledWith({
      format: CLUB_FORMAT_TEST,
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
      retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" })
    ).resolves.toEqual({
      message:
        "Retried the second Xero supplementary invoice for a settled booking-review share.",
    });

    expect(mocks.createXeroSupplementaryInvoice).toHaveBeenCalledWith({
      format: CLUB_FORMAT_TEST,
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
      retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" })
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

    await retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" });

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

    await retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" });

    expect(mocks.createXeroSupplementaryInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ recordPayment: false })
    );
  });

  it("MUTATION #3953 round 9: a replay asked to record the payment asks again under the change's lock, and replays unpaid where a capture's receipt records it", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "BookingModification",
        localId: "mod_receipt",
        requestPayload: {
          queueType: "SUPPLEMENTARY_INVOICE",
          bookingId: "book_123",
          priceDiffCents: 2500,
          changeFeeCents: 500,
          paymentIntentId: "pi_change",
        },
      })
    );
    mocks.findUniqueBookingModification.mockResolvedValue({
      bookingId: "book_123",
      priceDiffCents: 2500,
      changeFeeCents: 500,
      createdAt: new Date("2026-07-01T00:00:00Z"),
    });
    mocks.supplementaryReplayMayRecordPayment.mockResolvedValueOnce({ recordPayment: false, raisedUnpaid: true });

    // Round 11: the officer is told it was raised unpaid, and why.
    await expect(retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" })).resolves.toEqual({
      message: "Retried Xero supplementary invoice creation, raised unpaid: the card payment it would record is recorded by its own receipt, or overlaps a credit-release payment.",
    });

    expect(mocks.supplementaryReplayMayRecordPayment).toHaveBeenCalledWith({
      operationId: "op_123",
      bookingId: "book_123",
      bookingModificationId: "mod_receipt",
    });
    expect(mocks.createXeroSupplementaryInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ recordPayment: false })
    );
  });

  // #3953 round 10: a #3980 gap invoice's coverage record (`primaryInvoiceGap`,
  // `coveredPaymentIntentIds`, `coveredCaptureCents`) is never an input to the
  // create - the outbox dispatch passes none either; it lives on the QUEUED
  // row, which the replay never rewrites and which stays FAILED (not
  // CANCELLED), so the readers that filter on `queueType` keep finding it. The
  // replay's own row is a direct call's, with no `queueType`, invisible to them.
  it("replays a #3980 gap invoice with its queued amounts and payment, leaving its coverage record on the queued row (#3953)", async () => {
    const gapPayload = {
      queueType: "SUPPLEMENTARY_INVOICE",
      bookingId: "book_123",
      bookingModificationId: "mod_gap",
      priceDiffCents: 0,
      changeFeeCents: 2500,
      recordPayment: true,
      primaryInvoiceGap: true,
      coveredPaymentIntentIds: ["pi_change"],
      coveredCaptureCents: { pi_change: 2500 },
    };
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "BookingModification",
        localId: "mod_gap",
        requestPayload: gapPayload,
      })
    );
    mocks.findUniqueBookingModification.mockResolvedValue({
      bookingId: "book_123",
      priceDiffCents: 9999,
      changeFeeCents: 9999,
      createdAt: new Date("2026-07-01T00:00:00Z"),
    });

    await retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" });

    expect(mocks.createXeroSupplementaryInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "book_123",
        bookingModificationId: "mod_gap",
        priceDiffCents: 0,
        changeFeeCents: 2500,
        recordPayment: true,
      })
    );
    expect(mocks.createXeroSupplementaryInvoice.mock.calls[0]![0]).not.toHaveProperty("syncOperationId");
    // The queued row - the coverage record - is never rewritten by the replay.
    expect(
      mocks.updateManyOperation.mock.calls.filter(([args]) => "requestPayload" in ((args as { data?: object }).data ?? {}))
    ).toEqual([]);
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

    await retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" });

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

    await retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" });

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

    await retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" });

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
      retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" })
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

    await retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" });

    expect(mocks.createXeroSupplementaryInvoice).toHaveBeenCalledWith({
      format: CLUB_FORMAT_TEST,
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
      retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" })
    ).resolves.toEqual({
      message: "Retried Xero modification credit note creation.",
    });

    expect(mocks.createXeroCreditNoteForModification).toHaveBeenCalledWith({
      format: CLUB_FORMAT_TEST,
      bookingId: "book_123",
      refundAmountCents: 2500,
      bookingModificationId: "mod_123",
      createdByMemberId: "admin_1",
      repairExistingLink: true,
    });
  });

  it("replays a stored booking-edit wording with the credit note (#3536)", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "BookingModification",
        localId: "mod_cash",
        requestPayload: {
          queueType: "MODIFICATION_CREDIT_NOTE",
          bookingId: "book_123",
          refundAmountCents: 2500,
          bookingModificationId: "mod_cash",
          refundMethod: "internet-banking",
          noteWording: "cash",
        },
      })
    );
    mocks.findUniqueBookingModification.mockResolvedValue({
      bookingId: "book_123",
      priceDiffCents: -2500,
      changeFeeCents: 0,
    });

    await retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" });

    expect(mocks.createXeroCreditNoteForModification).toHaveBeenCalledWith(
      expect.objectContaining({ refundMethod: "internet-banking", noteWording: "cash" })
    );
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

    await retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" });

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

    await retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" });

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
      retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" })
    ).resolves.toEqual({
      message: "Retried Xero modification account-credit note creation.",
    });

    expect(mocks.createUnappliedXeroCreditNoteForModification).toHaveBeenCalledWith({
      format: CLUB_FORMAT_TEST,
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

    await retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" });

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

    await retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" });

    expect(mocks.createXeroCreditNoteForModification).toHaveBeenCalledWith({
      format: CLUB_FORMAT_TEST,
      bookingId: "book_123",
      refundAmountCents: 500,
      bookingModificationId: "mod_mixed_net",
      createdByMemberId: "admin_1",
      repairExistingLink: true,
    });
  });

  it("MUTATION: #3791 - rebuilds a review task's share under its own task-scoped keys", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "BookingModification",
        localId: "mod_review",
        requestPayload: {
          queueType: "MODIFICATION_CREDIT_NOTE",
          bookingId: "book_123",
          refundAmountCents: 1000,
          bookingModificationId: "mod_review",
          reviewTaskId: "task_7",
          refundMethod: "account-credit",
        },
      })
    );
    mocks.findUniqueBookingModification.mockResolvedValue({
      bookingId: "book_123",
      priceDiffCents: -2500,
      changeFeeCents: 0,
    });

    await retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" });

    expect(mocks.createXeroCreditNoteForModification).toHaveBeenCalledWith(
      expect.objectContaining({ refundAmountCents: 1000, reviewTaskId: "task_7", refundMethod: "account-credit" }),
    );
  });

  it("MUTATION: #3791 - retries a FAILED review account note on a PARKED anchor from its executed payload, never from the anchor's zero net", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "BookingModification",
        localId: "mod_parked",
        queueType: "MODIFICATION_ACCOUNT_CREDIT_NOTE",
        // The shape `createUnappliedXeroCreditNote` leaves after it ran.
        requestPayload: {
          creditNotes: [{ type: "ACCRECCREDIT" }],
          refundAmountCents: 2500,
          queueType: "MODIFICATION_ACCOUNT_CREDIT_NOTE",
          bookingId: "book_123",
          paymentId: "pay_123",
          bookingModificationId: "mod_parked",
          reviewTaskId: "task_9",
        },
      })
    );
    // The parked edit moved no money of its own.
    mocks.findUniqueBookingModification.mockResolvedValue({ bookingId: "book_123", priceDiffCents: 0, changeFeeCents: 0 });

    await retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" });

    expect(mocks.createUnappliedXeroCreditNoteForModification).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "pay_123", refundAmountCents: 2500, bookingModificationId: "mod_parked", reviewTaskId: "task_9" }),
    );
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
      retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" })
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
      retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" })
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

  // #4010: the repair records the cash the create would have recorded — the
  // figure stored with the invoice link, capped for applied account credit —
  // not the invoice total. The total is only an older operation's fallback.
  describe("primary invoice PARTIAL repair sizes at the stored cash figure (#4010)", () => {
    // `attempted` undefined models a record written before #4010 stored it.
    const storedAtLink = (
      primaryInvoiceCashCents: number,
      xeroInvoiceId = "inv_123",
      primaryInvoiceAttemptedCashCents: number | undefined = primaryInvoiceCashCents,
    ) => ({
      invoices: [{ lineItems: [{ quantity: 1, unitAmount: 100 }] }],
      primaryInvoiceBilledFee: {
        xeroInvoiceId,
        billedChangeFeeCents: 0,
        billedTotalCents: 10_000,
        recordedChangeFeeCentsAtLink: 0,
        primaryInvoiceCashCents,
        ...(primaryInvoiceAttemptedCashCents === undefined ? {} : { primaryInvoiceAttemptedCashCents }),
      },
    });
    const partialPrimary = (requestPayload: unknown) =>
      makeOperation({
        status: "PARTIAL",
        xeroObjectId: "inv_123",
        requestPayload,
        responsePayload: {
          invoice: { invoices: [{ total: 100 }] },
          paymentError: { message: "Xero rejected the payment" },
        },
      });
    const repairedPaymentCents = () => {
      expect(mocks.createXeroPaymentForInvoice).toHaveBeenCalledTimes(1);
      const call = mocks.createXeroPaymentForInvoice.mock.calls[0][0];
      expect(call.metadata.amountCents).toBe(call.amountCents);
      expect(call.idempotencyKey).toBe("payment:pay_123:invoice-payment:v1");
      return call.amountCents;
    };

    it("card plus applied credit: records the card cash (total less credit), not the total", async () => {
      // $100 invoice, $20 of it paid by applied credit: the card paid $80.
      mocks.findUniqueOperation.mockResolvedValue(partialPrimary(storedAtLink(8_000)));
      await expect(
        retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" })
      ).resolves.toEqual({ message: "Repaired Xero booking invoice payment recording." });
      expect(repairedPaymentCents()).toBe(8_000);
    });

    // #4010 review: the stored cash is floored at an earlier unmatched payment
    // on the invoice; the repair records what the create tried to pay.
    it.each([
      { floored: 6_000, attempted: 4_000 },
      { floored: 3_000, attempted: 2_000 },
    ])("records the attempted $attempted, never the floored $floored", async ({ floored, attempted }) => {
      mocks.findUniqueOperation.mockResolvedValue(partialPrimary(storedAtLink(floored, "inv_123", attempted)));
      await retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" });
      expect(repairedPaymentCents()).toBe(attempted);
    });

    it("a record from before the attempted figure falls back to the stored cash", async () => {
      mocks.findUniqueOperation.mockResolvedValue(partialPrimary(storedAtLink(8_000, "inv_123", undefined)));
      await retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" });
      expect(repairedPaymentCents()).toBe(8_000);
    });

    it("card only: the stored figure is the total, so the repair is unchanged", async () => {
      mocks.findUniqueOperation.mockResolvedValue(partialPrimary(storedAtLink(10_000)));
      await retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" });
      expect(repairedPaymentCents()).toBe(10_000);
    });

    it("an operation from before the stored figure falls back to the invoice total", async () => {
      // Pre-#3955: no record at all.
      mocks.findUniqueOperation.mockResolvedValue(
        partialPrimary({ invoices: [{ lineItems: [{ quantity: 1, unitAmount: 100 }] }] }),
      );
      await retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" });
      expect(repairedPaymentCents()).toBe(10_000);
    });

    it("a record without the cash figure (pre-round-5) or for another invoice also falls back", async () => {
      const withoutCash: Record<string, unknown> = { ...storedAtLink(8_000, "inv_123", undefined).primaryInvoiceBilledFee };
      delete withoutCash.primaryInvoiceCashCents;
      for (const requestPayload of [
        { ...storedAtLink(8_000), primaryInvoiceBilledFee: withoutCash },
        storedAtLink(8_000, "inv_other"),
      ]) {
        vi.clearAllMocks();
        mocks.findUniqueOperation.mockResolvedValue(partialPrimary(requestPayload));
        await retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" });
        expect(repairedPaymentCents()).toBe(10_000);
      }
    });

    it("a stored figure of zero records no payment and says the credit took it, not that the invoice was zero", async () => {
      mocks.findUniqueOperation.mockResolvedValue(partialPrimary(storedAtLink(0)));
      await expect(
        retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" })
      ).resolves.toEqual({
        message:
          "Marked Xero booking invoice as repaired without payment recording: its applied account credit leaves no card cash to record.",
      });
      expect(mocks.createXeroPaymentForInvoice).not.toHaveBeenCalled();
      expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
        expect.objectContaining({ id: "op_123" }),
        expect.objectContaining({
          status: "SUCCEEDED",
          responsePayload: expect.objectContaining({
            paymentSkipped: true,
            paymentSkipReason: PRIMARY_INVOICE_NOTHING_LEFT_DUE_REASON,
          }),
        }),
        { retryClaim: true, alert: false },
      );
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
      retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" })
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
      retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" })
    ).rejects.toThrow();
    expect(mocks.createXeroPaymentForInvoice).not.toHaveBeenCalled();
  });

  it("refuses it for a withheld-at-creation PARTIAL too (#2929)", async () => {
    // Same hazard, second reason. Like the case above, this payload carries NO
    // `paymentSkipped`, so the refusal has to come from the withhold key
    // itself -- which is the point of checking it rather than trusting that an
    // Internet Banking operation always says its payment was skipped.
    const withheldAtCreation = makeOperation({
      status: "PARTIAL",
      xeroObjectId: "inv_123",
      responsePayload: {
        invoice: { invoices: [{ total: 45.67 }] },
        paymentError: null,
        invoiceEmailWithheldByCreationChoice: true,
      },
    });
    mocks.findUniqueOperation.mockResolvedValue(withheldAtCreation);

    expect(getXeroOperationRetryMeta(withheldAtCreation).supported).toBe(false);
    await expect(
      retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" })
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
      retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" })
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
      retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" })
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

  it("MUTATION #4494: a PARTIAL gap invoice whose payment would overlap the credit-release sweep's share is closed with no payment", async () => {
    const operation = makeOperation({
      status: "PARTIAL",
      localModel: "BookingModification",
      localId: "mod_123",
      xeroObjectId: "inv_sup_123",
      requestPayload: { primaryInvoiceGap: true, bookingId: "booking_1", coveredPaymentIntentIds: ["pi_release"] },
      responsePayload: { invoice: { invoices: [{ total: 30 }] } },
    });
    mocks.findUniqueOperation.mockResolvedValue(operation);
    const paymentOutcome = { payment: null, paymentSkipped: true, paymentSkipReason: "Not recorded: credit release." };
    mocks.skipPartialGapRepairPayment.mockResolvedValueOnce({ paymentOutcome, message: "Closed without recording a payment." });

    await expect(retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" })).resolves.toEqual({
      message: "Closed without recording a payment.",
    });
    expect(mocks.skipPartialGapRepairPayment).toHaveBeenCalledWith(operation, expect.objectContaining({ id: "op_123" }));
    expect(mocks.createXeroPaymentForInvoice).not.toHaveBeenCalled();
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({ id: "op_123" }),
      expect.objectContaining({ responsePayload: expect.objectContaining(paymentOutcome) }),
      expect.anything(),
    );
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
      retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" })
    ).resolves.toEqual({
      message: "Marked zero-total Xero booking invoice as repaired without payment recording.",
    });

    expect(mocks.createXeroPaymentForInvoice).not.toHaveBeenCalled();
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({ id: "op_123" }),
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
      }),
      { retryClaim: true, alert: false },
    );
  });

  it("repairs the refund payment leg against the account the original leg recorded (INV-PAY-101)", async () => {
    mocks.getResolvedAccountMapping.mockResolvedValue({
      code: "090",
      itemCode: null,
      codeExplicitlyConfigured: true,
    });
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        status: "PARTIAL",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        xeroObjectId: "cn_123",
        requestPayload: {
          allocation: { invoiceId: "inv_123", amount: 12.34 },
          refundMethod: "internet-banking",
        },
        responsePayload: {},
      })
    );
    mocks.updatePayment.mockResolvedValue({ id: "pay_123" });

    await retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" });

    expect(mocks.finishRefundCreditNoteSettlement).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: expect.objectContaining({ id: "op_123" }),
        paymentId: "pay_123",
        creditNoteId: "cn_123",
        originalInvoiceId: "inv_123",
        refundMethod: "internet-banking",
        refundMethodRecorded: true,
      })
    );
  });

  it("leaves a recorded bank-transfer note unsettled on repair while no refund account is chosen (INV-PAY-101)", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        status: "PARTIAL",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        xeroObjectId: "cn_123",
        requestPayload: {
          allocation: { invoiceId: "inv_123", amount: 12.34 },
          refundMethod: "internet-banking",
        },
        responsePayload: {},
      })
    );
    mocks.updatePayment.mockResolvedValue({ id: "pay_123" });

    await retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" });

    // The settlement decision (unsettled while no account is chosen) runs
    // inside the shared leg, pinned in xero-refund-note-crash-window.test.ts;
    // the repair hands it the method the row recorded.
    expect(mocks.finishRefundCreditNoteSettlement).toHaveBeenCalledWith(
      expect.objectContaining({ refundMethod: "internet-banking", refundMethodRecorded: true })
    );
  });

  it("never settles a legacy note for a non-Stripe payment from the Stripe account on repair (INV-PAY-101)", async () => {
    // A pre-#3529 row carries no method. Its payment was internet banking, so
    // nothing in the ledger says a transfer was made; the old repair would
    // have marked the note paid from the Stripe account.
    mocks.getResolvedAccountMapping.mockResolvedValue({
      code: "090",
      itemCode: null,
      codeExplicitlyConfigured: true,
    });
    mocks.findUniquePayment.mockResolvedValue({ id: "pay_123", source: "INTERNET_BANKING" });
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        status: "PARTIAL",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        xeroObjectId: "cn_123",
        requestPayload: { allocation: { invoiceId: "inv_123", amount: 12.34 } },
        responsePayload: {},
      })
    );
    mocks.updatePayment.mockResolvedValue({ id: "pay_123" });

    await retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" });

    // A method nobody recorded, read off an internet-banking payment: the
    // shared leg's `resolveRefundSettlement` leaves it unsettled.
    expect(mocks.finishRefundCreditNoteSettlement).toHaveBeenCalledWith(
      expect.objectContaining({ refundMethod: "internet-banking", refundMethodRecorded: false })
    );
  });

  it("does not re-repair a note that was left unsettled by design (INV-PAY-101)", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        status: "PARTIAL",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        xeroObjectId: "cn_123",
        requestPayload: {
          allocation: { invoiceId: "inv_123", amount: 12.34 },
          refundMethod: "internet-banking",
        },
        responsePayload: { refundPaymentSkipped: true, refundPaymentSkipReason: "unset" },
      })
    );
    mocks.updatePayment.mockResolvedValue({ id: "pay_123" });

    await retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" });

    expect(mocks.finishRefundCreditNoteSettlement).not.toHaveBeenCalled();
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({ id: "op_123" }),
      expect.objectContaining({
        status: "SUCCEEDED",
        responsePayload: expect.objectContaining({ refundPaymentSkipped: true, refundPaymentSkipReason: "unset" }),
      }),
      { retryClaim: true },
    );
  });

  it("MUTATION (INV-ADDPAY-041): a PARTIAL row's repair never writes a note Xero voided into the payment's pointer", async () => {
    mocks.findUniquePayment.mockResolvedValue({ id: "pay_123", source: "STRIPE" });
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        status: "PARTIAL", entityType: "CREDIT_NOTE", operationType: "CREATE", xeroObjectId: "cn_123",
        requestPayload: { allocation: { invoiceId: "inv_123", amount: 12.34 } },
        responsePayload: { allocation: { allocations: [{ amount: 12.34 }] } },
      })
    );
    mocks.findManyXeroObjectLink.mockImplementation((async ({ where }: any) =>
      where?.role === "REFUND_CREDIT_NOTE" ? [{ xeroObjectId: "cn_123", metadata: { amountCents: 1234, status: "VOIDED" } }] : []) as never);
    mocks.updatePayment.mockResolvedValue({ id: "pay_123" });

    try {
      await retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" });

      expect(mocks.updatePayment).not.toHaveBeenCalledWith(expect.objectContaining({ data: { xeroRefundCreditNoteId: "cn_123" } }));
    } finally {
      mocks.findManyXeroObjectLink.mockImplementation((async () => []) as never);
    }
  });

  it("repairs partial refund credit note follow-up actions", async () => {
    mocks.findUniquePayment.mockResolvedValue({ id: "pay_123", source: "STRIPE" });
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
      retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" })
    ).resolves.toEqual({
      message: "Repaired Xero refund credit note follow-up actions.",
    });

    expect(mocks.allocateCreditNoteToInvoice).not.toHaveBeenCalled();
    expect(mocks.updatePayment).toHaveBeenCalledWith({
      where: { id: "pay_123" },
      data: { xeroRefundCreditNoteId: "cn_123" },
    });
    expect(mocks.finishRefundCreditNoteSettlement).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: expect.objectContaining({ id: "op_123" }),
        paymentId: "pay_123",
        originalInvoiceId: "inv_123",
        creditNoteId: "cn_123",
        // `INV-PAY-101`: a pre-#3529 row carries no method, and this payment's
        // source is Stripe, so the repair settles it as the card refund it was.
        refundMethod: "card",
        refundMethodRecorded: false,
      })
    );
  });

  it("surfaces a payment that fails in the shared leg, which has already left the row PARTIAL (#3548)", async () => {
    mocks.findUniquePayment.mockResolvedValue({ id: "pay_123", source: "STRIPE" });
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        status: "PARTIAL",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        xeroObjectId: "cn_123",
        requestPayload: { allocation: { invoiceId: "inv_123", amount: 12.34 } },
        responsePayload: {},
      })
    );
    mocks.updatePayment.mockResolvedValue({ id: "pay_123" });
    mocks.finishRefundCreditNoteSettlement.mockResolvedValueOnce({ refundPaymentErr: new Error("Xero 503") });

    await expect(retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST)).rejects.toThrow("Xero 503");
  });

  it("repairs failed refund credit note creates from the existing Xero credit note", async () => {
    mocks.findUniquePayment.mockResolvedValue({ id: "pay_123", source: "STRIPE" });
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
      retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" })
    ).resolves.toEqual({
      message: "Repaired Xero refund credit note follow-up actions.",
    });

    expect(mocks.createXeroCreditNote).not.toHaveBeenCalled();
    expect(mocks.allocateCreditNoteToInvoice).not.toHaveBeenCalled();
    expect(mocks.updatePayment).toHaveBeenCalledWith({
      where: { id: "pay_123" },
      data: { xeroRefundCreditNoteId: "cn_legacy_123" },
    });
    expect(mocks.finishRefundCreditNoteSettlement).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: expect.objectContaining({ id: "op_123" }),
        paymentId: "pay_123",
        originalInvoiceId: "inv_legacy_123",
        creditNoteId: "cn_legacy_123",
        refundMethod: "card",
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
      retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" })
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

  // #3535: a clearing note planned across the primary and a supplementary
  // invoice replays exactly that plan, skipping the target already allocated.
  it("repairs a partial clearing note across its recorded invoices, skipping one already allocated", async () => {
    mocks.findManyXeroObjectLink.mockResolvedValueOnce([
      { metadata: { creditNoteId: "cn_clear", invoiceId: "inv_primary", amountCents: 30000 } },
      // A different note's allocation to the same invoice does not count.
      { metadata: { creditNoteId: "cn_other", invoiceId: "inv_supp", amountCents: 11000 } },
    ]);
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        status: "PARTIAL",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "Booking",
        localId: "booking_7",
        xeroObjectId: "cn_clear",
        requestPayload: {
          invoiceId: "inv_primary",
          refundAmountCents: 41000,
          clearsUnpaidInvoice: true,
          allocations: [
            { invoiceId: "inv_primary", amountCents: 30000 },
            { invoiceId: "inv_supp", amountCents: 11000 },
          ],
        },
      })
    );

    await expect(
      retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" })
    ).resolves.toEqual({ message: "Repaired Xero modification credit note allocation." });

    expect(mocks.allocateCreditNoteToInvoice).toHaveBeenCalledTimes(1);
    expect(mocks.allocateCreditNoteToInvoice).toHaveBeenCalledWith("cn_clear", "inv_supp", 11000, {
      localModel: "Booking",
      localId: "booking_7",
      role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
      createdByMemberId: "admin_1",
    });
  });

  // #3535: a plan whose invoice id was redacted into storage is refused, never
  // replayed against "[REDACTED]".
  it("refuses to replay a clearing note's plan when an invoice id in it was redacted", async () => {
    const redactedPlan = makeOperation({
      status: "PARTIAL",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel: "Booking",
      localId: "booking_7",
      xeroObjectId: "cn_clear",
      requestPayload: {
        invoiceId: "inv_primary",
        refundAmountCents: 41000,
        allocations: [
          { invoiceId: "inv_primary", amountCents: 30000 },
          { invoiceId: "[REDACTED]", amountCents: 11000 },
        ],
      },
    });
    expect(getXeroOperationRetryMeta(redactedPlan)).toEqual({
      supported: false,
      reason: expect.stringContaining("redacted invoice id"),
    });
    mocks.findUniqueOperation.mockResolvedValue(redactedPlan);
    await expect(
      retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" })
    ).rejects.toThrow(/redacted invoice id/);
    expect(mocks.allocateCreditNoteToInvoice).not.toHaveBeenCalled();
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
      retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" })
    ).resolves.toEqual({
      message: "Retried Xero membership cancellation credit note creation.",
    });

    expect(mocks.createXeroMembershipCancellationCreditNote).toHaveBeenCalledWith({
      subscriptionId: "sub_123",
      requestId: "request_1",
      participantId: "participant_1",
      createdByMemberId: "admin_1",
      syncOperation: expect.objectContaining({ id: "op_123" }),
    });
  });

  // #3635: a kept late capture's invoice goes back to the outbox from its
  // queued payload, which its worker keeps beside the request it sent.
  it("returns a failed or partial kept late-capture invoice to the outbox with its queued payload", async () => {
    const queued = {
      queueType: "KEPT_LATE_CAPTURE_INVOICE",
      bookingId: "booking_1",
      manualRefundTaskId: "task_kept",
      paymentIntentId: "pi_kept",
      capturedCents: 24000,
      capturedOn: "2026-06-10",
    };
    for (const status of ["FAILED", "PARTIAL"] as const) {
      mocks.updateManyOperation.mockReset();
      const operation = makeOperation({
        status,
        localModel: "ManualRefundTask",
        localId: "task_kept",
        queueType: "KEPT_LATE_CAPTURE_INVOICE",
        requestPayload: { ...queued, invoices: [{ type: "ACCREC" }] },
      });
      expect(getXeroOperationRetryMeta(operation)).toEqual({ supported: true, reason: null });
      mocks.findUniqueOperation.mockResolvedValue(operation);
      mocks.updateManyOperation.mockResolvedValue({ count: 1 });

      await expect(retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST)).resolves.toEqual({
        message: "Queued the kept-payment Xero invoice for retry.",
      });
      expect(mocks.updateManyOperation).toHaveBeenCalledWith({
        where: { id: "op_123", status: { in: ["FAILED", "PARTIAL"] }, manuallyResolvedAt: null },
        data: expect.objectContaining({ status: "PENDING", requestPayload: queued }),
      });
    }

    // Unreadable cents are never guessed.
    expect(
      getXeroOperationRetryMeta(
        makeOperation({
          localModel: "ManualRefundTask",
          localId: "task_kept",
          queueType: "KEPT_LATE_CAPTURE_INVOICE",
          requestPayload: { ...queued, capturedCents: null },
        }),
      ).supported,
    ).toBe(false);
  });

  // #3924 round 9 (`INV-PAY-122`): a late card charge's change invoice that
  // FAILED goes back to the outbox on its own row, so its worker - not an
  // inline replay minting a row that does not name the charge - records the
  // invoice where the charge's receipt reads it, and queues the note a
  // "Paid another way" close waits for.
  it("MUTATION: returns a FAILED late-capture change invoice to the outbox on its own row, never replaying it inline", async () => {
    const queued = {
      queueType: "SUPPLEMENTARY_INVOICE",
      bookingId: "book_123",
      priceDiffCents: 3000,
      changeFeeCents: 0,
      bookingModificationId: "mod_123",
      recordPayment: true,
      paymentIntentId: "pi_late",
      keptLateCaptureDay: "2026-06-10",
      invoices: [{ type: "ACCREC" }],
    };
    const operation = makeOperation({
      status: "FAILED",
      entityType: "INVOICE",
      operationType: "CREATE",
      localModel: "BookingModification",
      localId: "mod_123",
      queueType: "SUPPLEMENTARY_INVOICE",
      requestPayload: queued,
    });
    mocks.findUniqueOperation.mockResolvedValue(operation);
    mocks.updateManyOperation.mockResolvedValue({ count: 1 });
    mocks.findUniqueManualRefundTask.mockResolvedValueOnce({ id: "task_late" });

    await expect(retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST)).resolves.toEqual({
      message: "Queued the late card charge's change invoice for retry.",
    });
    expect(mocks.findUniqueManualRefundTask).toHaveBeenCalledWith({
      where: { lateCaptureApprovalIntentId: "pi_late" },
      select: { id: true },
    });
    expect(mocks.updateManyOperation).toHaveBeenCalledWith({
      where: { id: "op_123", status: "FAILED", manuallyResolvedAt: null },
      // #3953 round 11: the stored payload - the intent the note step reads,
      // and the charge day - is kept as it stands, never written back.
      data: expect.objectContaining({ status: "PENDING" }),
    });
    expect(mocks.updateManyOperation.mock.calls[0]![0].data).not.toHaveProperty("requestPayload");
    expect(mocks.createXeroSupplementaryInvoice).not.toHaveBeenCalled();
  });

  it("MUTATION #3953 round 11: decides the late charge's change invoice again under the change's lock before requeueing it, and never writes back the payload it read", async () => {
    const queued = {
      queueType: "SUPPLEMENTARY_INVOICE",
      bookingId: "book_123",
      priceDiffCents: 3000,
      changeFeeCents: 0,
      bookingModificationId: "mod_123",
      recordPayment: true,
      paymentIntentId: "pi_late",
    };
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        status: "FAILED",
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "BookingModification",
        localId: "mod_123",
        queueType: "SUPPLEMENTARY_INVOICE",
        requestPayload: queued,
      }),
    );
    mocks.updateManyOperation.mockResolvedValue({ count: 1 });
    mocks.findUniqueManualRefundTask.mockResolvedValueOnce({ id: "task_late" });
    // A receipt's switch (or this check) set the row unpaid since it was read.
    mocks.supplementaryReplayMayRecordPayment.mockResolvedValueOnce({ recordPayment: false, raisedUnpaid: true });

    await retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST);

    expect(mocks.supplementaryReplayMayRecordPayment).toHaveBeenCalledWith({
      operationId: "op_123",
      bookingId: "book_123",
      bookingModificationId: "mod_123",
    });
    expect(mocks.supplementaryReplayMayRecordPayment.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.updateManyOperation.mock.invocationCallOrder[0]!,
    );
    for (const [args] of mocks.updateManyOperation.mock.calls) {
      expect((args as { data: object }).data).not.toHaveProperty("requestPayload");
    }
  });

  // #3924 round 10 (finding 2): one whose change is already linked to its
  // invoice in Xero is never sent again.
  it("MUTATION: round 10: refuses with a 409 a late charge's change invoice already linked in Xero, and says to mark it resolved", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        status: "FAILED",
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "BookingModification",
        localId: "mod_123",
        queueType: "SUPPLEMENTARY_INVOICE",
        requestPayload: {
          queueType: "SUPPLEMENTARY_INVOICE",
          bookingId: "book_123",
          priceDiffCents: 3000,
          changeFeeCents: 0,
          bookingModificationId: "mod_123",
          recordPayment: true,
          paymentIntentId: "pi_late",
        },
      }),
    );
    mocks.findUniqueManualRefundTask.mockResolvedValueOnce({ id: "task_late" });
    mocks.findFirstXeroObjectLink.mockResolvedValueOnce({ xeroObjectId: "inv_linked" });

    const refused = retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST);
    await expect(refused).rejects.toBeInstanceOf(XeroOperationRetryError);
    await expect(refused).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("Mark this operation resolved as fixed in Xero instead"),
    });
    // Round 12: no close and no card refund yet - nothing is said not to be
    // recorded by hand, and a later card refund is.
    await expect(refused).rejects.toMatchObject({
      message: expect.stringMatching(
        /instead, and do that first, before recording anything by hand in Xero\. If this charge is refunded to the card, record that refund by hand in Xero: once this operation is resolved the app raises no refund note for it\.$/,
      ),
    });
    await expect(refused).rejects.not.toMatchObject({ message: expect.stringMatching(/Do not record/) });
    // Round 11 (`INV-SSOT`): the receipt reader's own link query.
    expect(mocks.findFirstXeroObjectLink).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [{ localModel: "BookingModification", localId: "mod_123" }],
          xeroObjectType: "INVOICE",
          role: "SUPPLEMENTARY_INVOICE",
          active: true,
        },
        select: { xeroObjectId: true },
      }),
    );
    expect(mocks.updateManyOperation).not.toHaveBeenCalled();
    expect(mocks.createXeroSupplementaryInvoice).not.toHaveBeenCalled();
  });

  // #3924 round 12 (F1): once the row is resolved, a refund closed as paid
  // another way reads the linked invoice as its receipt and its note follows,
  // but every card-refund path reads the row resolved by hand - so the 409
  // says which share to record by hand and which never to.
  describe("round 12: what the linked change invoice's 409 says to record by hand", () => {
    const linkedLateChange = () =>
      makeOperation({
        status: "FAILED",
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "BookingModification",
        localId: "mod_123",
        queueType: "SUPPLEMENTARY_INVOICE",
        requestPayload: {
          queueType: "SUPPLEMENTARY_INVOICE",
          bookingId: "book_123",
          priceDiffCents: 40000,
          changeFeeCents: 0,
          bookingModificationId: "mod_123",
          recordPayment: true,
          paymentIntentId: "pi_late",
        },
      });
    const refusal = async ({
      closeCents,
      cardCents,
      mayBeInXeroCents = 0,
      notesCanStillLand = false,
      notedLaterCents = 0,
    }: {
      closeCents: number | null;
      cardCents: number;
      mayBeInXeroCents?: number;
      notesCanStillLand?: boolean;
      notedLaterCents?: number;
    }) => {
      mocks.findUniqueOperation.mockResolvedValue(linkedLateChange());
      mocks.findUniqueManualRefundTask.mockResolvedValueOnce({ id: "task_late" });
      mocks.findUniqueManualRefundTask.mockResolvedValueOnce({ paymentId: "payment_1" });
      mocks.findFirstXeroObjectLink.mockResolvedValueOnce({ xeroObjectId: "inv_linked" });
      mocks.findLateCaptureRefundPaidAnotherWay.mockResolvedValueOnce(
        closeCents === null ? null : { id: "close_1", paymentId: "payment_1", amountCents: closeCents },
      );
      mocks.readUnnotedLateCaptureCardRefunds.mockResolvedValueOnce({
        byHandCents: cardCents,
        mayBeInXeroCents,
        notesCanStillLand,
        notedLaterCents,
      });
      const error = await retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(XeroOperationRetryError);
      expect(error).toMatchObject({ status: 409 });
      expect(mocks.updateManyOperation).not.toHaveBeenCalled();
      return (error as Error).message;
    };

    it("MUTATION: card only - the whole card refund is recorded by hand, and nothing is said not to be", async () => {
      const message = await refusal({ closeCents: null, cardCents: 40000 });
      expect(message).toMatch(/Record the \$400\.00 refunded to the card by hand in Xero: once this operation is resolved the app raises no refund note for a card refund of this charge\.$/);
      expect(message).not.toMatch(/Do not record/);
      expect(mocks.readUnnotedLateCaptureCardRefunds).toHaveBeenCalledWith("payment_1", "pi_late");
    });

    it("MUTATION: split - the close's share is not recorded by hand, the card share is", async () => {
      const message = await refusal({ closeCents: 25000, cardCents: 15000 });
      expect(message).toMatch(/Do not record the \$250\.00 paid back another way by hand: the app raises that refund note against the invoice already there, through the nightly credit check or the Xero repair tool\./);
      expect(message).toMatch(/Record the \$150\.00 refunded to the card by hand in Xero/);
    });

    it("MUTATION: close only - nothing to record by hand", async () => {
      const message = await refusal({ closeCents: 40000, cardCents: 0 });
      expect(message).toMatch(/Do not record the \$400\.00 paid back another way by hand/);
      expect(message).not.toMatch(/Record the|record that refund by hand/);
    });

    // Round 13: a $0 close leaves nothing paid back another way, so the
    // officer is still told a later card refund is theirs to record.
    it("MUTATION: round 13: a $0 close with no card refund still says to record any later card refund by hand", async () => {
      const message = await refusal({ closeCents: 0, cardCents: 0 });
      expect(message).not.toMatch(/Do not record/);
      expect(message).toMatch(/If this charge is refunded to the card, record that refund by hand in Xero: once this operation is resolved the app raises no refund note for it\.$/);
    });

    // Round 14: the row is resolved before anything is recorded by hand -
    // until then a card note waiting for the receipt may still be sent.
    it("MUTATION: round 14: says to mark the row resolved first, before recording anything by hand", async () => {
      const message = await refusal({ closeCents: null, cardCents: 40000 });
      expect(message).toMatch(
        /^This late card charge's change invoice is already in Xero, so retrying it could raise a second invoice\. Mark this operation resolved as fixed in Xero instead, and do that first, before recording anything by hand in Xero\. /,
      );
    });

    // Round 14: a card note sent without a reply may be in Xero - named apart,
    // never in the amount to record by hand, and checked in Xero first.
    it("MUTATION: round 14: a card note sent without a reply is named apart, to check in Xero before recording", async () => {
      const message = await refusal({ closeCents: null, cardCents: 25000, mayBeInXeroCents: 15000 });
      expect(message).toMatch(/Record the \$250\.00 refunded to the card by hand in Xero/);
      expect(message).toMatch(
        /A refund credit note for \$150\.00 refunded to the card may be in Xero: the app tried to send it and cannot tell whether Xero took it\. Check Xero for that credit note first, and record that \$150\.00 by hand only if Xero does not hold it\.$/,
      );
      expect(message).not.toMatch(/If this charge is refunded to the card/);
      const onlySent = await refusal({ closeCents: null, cardCents: 0, mayBeInXeroCents: 15000 });
      expect(onlySent).not.toMatch(/Record the|If this charge is refunded to the card/);
      expect(onlySent).toMatch(/Check Xero for that credit note first/);
    });

    // Round 14: while the card verdict still names an invoice in Xero, the
    // app's card notes land against it, and nothing says the app raises no
    // note. Round 15: what no note asks for yet is noted the next time the app
    // notes this charge, so the officer is told NOT to record it by hand.
    it("MUTATION: round 15: while card notes can still land, says the app notes the gap later and never to record it by hand", async () => {
      const message = await refusal({ closeCents: null, cardCents: 0, notesCanStillLand: true, notedLaterCents: 5000 });
      expect(message).toMatch(
        /Do not record the \$50\.00 refunded to the card that no refund note answers yet by hand: the app notes it against this charge's receipt in Xero the next time it notes this charge, as it notes this charge's other card refunds\.$/,
      );
      expect(message).not.toMatch(/Record the|raises no refund note/);
      const nothing = await refusal({ closeCents: null, cardCents: 0, notesCanStillLand: true });
      expect(nothing).not.toMatch(/Record the|Do not record|If this charge is refunded to the card|raises no refund note/);
    });
  });

  // #3924 round 10 (finding 3): an ordinary card edit's invoice names its
  // `paymentIntentId` too, but no approval task owns it: the inline replay.
  it("MUTATION: round 10: an ordinary card edit's FAILED invoice - an intent no approval task owns - keeps the inline replay", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        status: "FAILED",
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "BookingModification",
        localId: "mod_123",
        queueType: "SUPPLEMENTARY_INVOICE",
        requestPayload: {
          queueType: "SUPPLEMENTARY_INVOICE",
          bookingId: "book_123",
          priceDiffCents: 3000,
          changeFeeCents: 0,
          bookingModificationId: "mod_123",
          recordPayment: true,
          paymentIntentId: "pi_card_edit",
        },
      }),
    );
    mocks.findUniqueBookingModification.mockResolvedValue({ bookingId: "book_123", priceDiffCents: 3000, changeFeeCents: 0 });
    await retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST);
    expect(mocks.findUniqueManualRefundTask).toHaveBeenCalledWith({
      where: { lateCaptureApprovalIntentId: "pi_card_edit" },
      select: { id: true },
    });
    expect(mocks.createXeroSupplementaryInvoice).toHaveBeenCalledTimes(1);
    expect(mocks.updateManyOperation).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "PENDING" }) }),
    );
  });

  it("replays a change invoice that names no late charge inline, as before", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        status: "FAILED",
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "BookingModification",
        localId: "mod_123",
        requestPayload: {
          queueType: "SUPPLEMENTARY_INVOICE",
          bookingId: "book_123",
          priceDiffCents: 3000,
          changeFeeCents: 0,
          bookingModificationId: "mod_123",
          recordPayment: true,
        },
      })
    );
    mocks.findUniqueBookingModification.mockResolvedValue({ bookingId: "book_123", priceDiffCents: 3000, changeFeeCents: 0 });
    await retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST);
    expect(mocks.createXeroSupplementaryInvoice).toHaveBeenCalledTimes(1);
  });

  // #3635 composition (`INV-INT-025`): a kept late-capture invoice an officer
  // recorded by hand in Xero is never re-run - refused on read, and a resolve
  // landing between the read and the requeue makes the claim lose.
  it("never re-runs a kept late-capture invoice resolved in Xero", async () => {
    const queued = {
      queueType: "KEPT_LATE_CAPTURE_INVOICE",
      bookingId: "booking_1",
      manualRefundTaskId: "task_kept",
      paymentIntentId: "pi_kept",
      capturedCents: 24000,
      capturedOn: "2026-06-10",
    };
    const kept = makeOperation({
      localModel: "ManualRefundTask",
      localId: "task_kept",
      queueType: "KEPT_LATE_CAPTURE_INVOICE",
      requestPayload: { ...queued, invoices: [{ type: "ACCREC" }] },
    });
    const resolved = { ...kept, manuallyResolvedAt: RESOLVED_AT };
    expect(getXeroOperationRetryMeta(resolved)).toEqual({
      supported: false,
      reason: RESOLVED_IN_XERO_RETRY_REASON,
    });
    mocks.findUniqueOperation.mockResolvedValue(resolved);
    await expect(retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST)).rejects.toBeInstanceOf(
      XeroOperationResolvedInXeroError
    );
    expect(mocks.updateManyOperation).not.toHaveBeenCalled();

    mocks.findUniqueOperation
      .mockReset()
      .mockResolvedValueOnce(kept)
      .mockResolvedValueOnce({ ...resolved });
    mocks.updateManyOperation.mockImplementation(async (args: { where: Record<string, unknown> }) => ({
      count: args.where.manuallyResolvedAt === null ? 0 : 1,
    }));
    await expect(retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST)).rejects.toBeInstanceOf(
      XeroOperationResolvedInXeroError
    );
  });

  // #3642: the combined group invoice's rows go back to the outbox; a failed
  // abandon VOID used to be terminal, with no Retry and no alert.
  it("returns a failed group settlement VOID to the outbox with its queued payload", async () => {
    const payload = {
      queueType: "GROUP_SETTLEMENT_INVOICE_VOID",
      settlementId: "settle_1",
      xeroInvoiceId: "inv_1",
    };
    const operation = makeOperation({
      operationType: "UPDATE",
      localModel: "GroupBookingSettlement",
      localId: "settle_1",
      queueType: "GROUP_SETTLEMENT_INVOICE_VOID",
      requestPayload: payload,
    });
    expect(getXeroOperationRetryMeta(operation)).toEqual({ supported: true, reason: null });
    mocks.findUniqueOperation.mockResolvedValue(operation);
    mocks.updateManyOperation.mockResolvedValue({ count: 1 });

    await expect(retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST)).resolves.toEqual({
      message: "Queued the group settlement invoice operation for retry.",
    });
    expect(mocks.updateManyOperation).toHaveBeenCalledWith({
      where: { id: "op_123", status: "FAILED", manuallyResolvedAt: null },
      data: expect.objectContaining({ status: "PENDING", requestPayload: payload }),
    });
  });

  // #3994 review F1: the shared requeue refuses every outbox-run kind the same way.
  it("refuses to requeue a group settlement invoice whose sibling was resolved in Xero after it was queued", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        localModel: "GroupBookingSettlement",
        localId: "settle_1",
        queueType: "GROUP_SETTLEMENT_INVOICE",
        correlationKey: "group-settlement:settle_1:invoice:v1",
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
      })
    );
    mocks.findFirstOperation.mockResolvedValue({
      id: "op_resolved_sibling",
      manuallyResolvedAt: new Date("2026-06-10T00:00:00.000Z"),
    });

    await expect(retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("mark this operation resolved too"),
    });
    expect(mocks.updateManyOperation).not.toHaveBeenCalled();
  });

  it("rebuilds a failed group settlement CREATE's queued payload, which its worker overwrote", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        localModel: "GroupBookingSettlement",
        localId: "settle_1",
        queueType: "GROUP_SETTLEMENT_INVOICE",
        requestPayload: { invoices: [{ type: "ACCREC" }] },
      })
    );
    mocks.updateManyOperation.mockResolvedValue({ count: 1 });

    await retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST);

    expect(mocks.updateManyOperation).toHaveBeenCalledWith({
      where: { id: "op_123", status: "FAILED", manuallyResolvedAt: null },
      data: expect.objectContaining({
        status: "PENDING",
        requestPayload: { queueType: "GROUP_SETTLEMENT_INVOICE", settlementId: "settle_1" },
      }),
    });
  });

  it("refuses to retry a group settlement operation that is not FAILED, or was already requeued", async () => {
    const running = makeOperation({
      status: "PARTIAL",
      localModel: "GroupBookingSettlement",
      localId: "settle_1",
      queueType: "GROUP_SETTLEMENT_INVOICE",
    });
    expect(getXeroOperationRetryMeta(running).supported).toBe(false);

    mocks.findUniqueOperation.mockResolvedValue({ ...running, status: "FAILED" });
    mocks.updateManyOperation.mockResolvedValue({ count: 0 });
    await expect(retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("answers 409, not a uniqueness 500, when the organiser already queued the same attempt again (#3642 D6)", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        localModel: "GroupBookingSettlement",
        localId: "settle_1",
        queueType: "GROUP_SETTLEMENT_INVOICE",
      })
    );
    mocks.updateManyOperation.mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" })
    );

    await expect(retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST)).rejects.toMatchObject({
      status: 409,
    });
  });

  // #3971: every subscription invoice failed on a redacted charge id and this
  // screen said "not supported by the current replay helper", so the officer
  // could only mark it non-replayable or resolved.
  describe("membership subscription invoice retry (#3971)", () => {
    const LEGACY_STORED_PAYLOAD = {
      queueType: "MEMBERSHIP_SUBSCRIPTION_INVOICE",
      chargeId: "[REDACTED]",
    };
    const failedSubscriptionInvoice = (overrides: Record<string, unknown> = {}) =>
      makeOperation({
        localModel: "MembershipSubscriptionCharge",
        localId: "charge_1",
        queueType: "MEMBERSHIP_SUBSCRIPTION_INVOICE",
        requestPayload: LEGACY_STORED_PAYLOAD,
        ...overrides,
      });
    const unInvoicedCharge = {
      status: "QUEUED",
      billingBasis: "INVOICE",
      xeroInvoiceId: null,
      xeroInvoiceNumber: null,
    };

    it("offers Retry on a failed row stored with the blanked chargeId", () => {
      expect(getXeroOperationRetryMeta(failedSubscriptionInvoice())).toEqual({
        supported: true,
        reason: null,
      });
      // The queue-type column alone is enough, and the payload alone is enough.
      expect(
        getXeroOperationRetryMeta(failedSubscriptionInvoice({ requestPayload: null })).supported,
      ).toBe(true);
      expect(
        getXeroOperationRetryMeta(failedSubscriptionInvoice({ queueType: undefined })).supported,
      ).toBe(true);
    });

    it("offers no Retry for a row not anchored on a charge, or not FAILED", () => {
      expect(
        getXeroOperationRetryMeta(failedSubscriptionInvoice({ localId: null })),
      ).toEqual({
        supported: false,
        reason: "This invoice retry path is not supported by the current replay helper.",
      });
      expect(getXeroOperationRetryMeta(failedSubscriptionInvoice({ status: "SUCCEEDED" })).supported).toBe(false);
    });

    it("returns the row to the outbox keyed by its localId, under the same row and correlation key", async () => {
      mocks.findUniqueOperation.mockResolvedValue(failedSubscriptionInvoice());
      mocks.findUniqueSubscriptionCharge.mockResolvedValue(unInvoicedCharge);
      mocks.updateManyOperation.mockResolvedValue({ count: 1 });

      await expect(retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST)).resolves.toEqual({
        message: "Queued the membership subscription invoice for retry.",
      });
      expect(mocks.findUniqueSubscriptionCharge).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "charge_1" } }),
      );
      expect(mocks.updateManyOperation).toHaveBeenCalledTimes(1);
      expect(mocks.updateManyOperation).toHaveBeenCalledWith({
        where: { id: "op_123", status: "FAILED", manuallyResolvedAt: null },
        data: expect.objectContaining({
          status: "PENDING",
          // The blanked id is dropped, not carried back into the queue.
          requestPayload: { queueType: "MEMBERSHIP_SUBSCRIPTION_INVOICE" },
        }),
      });
      // Nothing runs inline: the outbox claim is the one execution authority.
      expect(mocks.createXeroInvoiceForBooking).not.toHaveBeenCalled();
      expect(mocks.createXeroEntranceFeeInvoice).not.toHaveBeenCalled();
    });

    it("refuses a charge that already has a Xero invoice, so this screen never raises a second", async () => {
      mocks.findUniqueOperation.mockResolvedValue(failedSubscriptionInvoice());
      mocks.findUniqueSubscriptionCharge.mockResolvedValue({
        ...unInvoicedCharge,
        status: "EMAILED",
        xeroInvoiceId: "inv_1",
        xeroInvoiceNumber: "INV-0042",
      });

      await expect(retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST)).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining("already has Xero invoice INV-0042"),
      });
      expect(mocks.updateManyOperation).not.toHaveBeenCalled();
    });

    it("refuses a charge that no longer needs an invoice, and a charge that is gone", async () => {
      mocks.findUniqueOperation.mockResolvedValue(failedSubscriptionInvoice());
      for (const charge of [
        { ...unInvoicedCharge, status: "VOIDED" },
        { ...unInvoicedCharge, status: "NOT_REQUIRED" },
        { ...unInvoicedCharge, billingBasis: "NO_INVOICE" },
      ]) {
        mocks.findUniqueSubscriptionCharge.mockResolvedValue(charge);
        await expect(retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST)).rejects.toMatchObject({
          status: 409,
        });
      }
      mocks.findUniqueSubscriptionCharge.mockResolvedValue(null);
      await expect(retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST)).rejects.toMatchObject({
        status: 404,
      });
      expect(mocks.updateManyOperation).not.toHaveBeenCalled();
    });

    // #3994 review F1: the outbox cancels a copy whose sibling an officer
    // resolved after it was queued, so the retry refuses up front instead of
    // reporting a queued retry that never runs.
    it("refuses, before any write, when a sibling for the same charge was resolved in Xero after this row was queued", async () => {
      const queuedAt = new Date("2026-06-01T00:00:00.000Z");
      mocks.findUniqueOperation.mockResolvedValue(
        failedSubscriptionInvoice({ correlationKey: "membership-charge:charge_1:invoice-and-email:v1", createdAt: queuedAt }),
      );
      mocks.findUniqueSubscriptionCharge.mockResolvedValue(unInvoicedCharge);
      mocks.findFirstOperation.mockResolvedValue({
        id: "op_resolved_sibling",
        manuallyResolvedAt: new Date("2026-06-10T00:00:00.000Z"),
      });

      await expect(retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST)).rejects.toMatchObject({
        status: 409,
        message: expect.stringMatching(/op_resolved_sibling[\s\S]*Retry on the charge in Subscription billing/),
      });
      expect(mocks.findFirstOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: { not: "op_123" },
            correlationKey: "membership-charge:charge_1:invoice-and-email:v1",
            manuallyResolvedAt: { gt: queuedAt },
          }),
        }),
      );
      expect(mocks.updateManyOperation).not.toHaveBeenCalled();
    });

    it("answers 409 while another attempt for the same charge is live (the active-correlation-key index)", async () => {
      mocks.findUniqueOperation.mockResolvedValue(failedSubscriptionInvoice());
      mocks.findUniqueSubscriptionCharge.mockResolvedValue(unInvoicedCharge);
      mocks.updateManyOperation.mockRejectedValue(
        Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
      );

      await expect(retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST)).rejects.toMatchObject({
        status: 409,
      });
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
      retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" })
    ).resolves.toEqual({ message: "Queued applied-credit allocation retry." });

    expect(mocks.updateManyOperation).toHaveBeenCalledWith({
      // No resolved guard: applied-credit rows are retry-only (#3635 N2).
      where: {
        id: "op_123",
        status: { in: ["FAILED", "PARTIAL"] },
      },
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
        retryXeroSyncOperation("child_op_1", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" }),
        retryXeroSyncOperation("child_op_1", CLUB_FORMAT_TEST, { createdByMemberId: "admin_2" }),
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
        retryXeroSyncOperation("legacy_child_1", CLUB_FORMAT_TEST, {
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
      retryXeroSyncOperation("repair_allocation_1", CLUB_FORMAT_TEST, {
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
    await expect(retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST)).resolves.toEqual({
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
      retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST),
      retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST),
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
    await expect(retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST)).resolves.toEqual({
      message: "Queued applied-credit deallocation retry.",
    });
  });

  it("throws a typed retry error for unsupported operations", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        status: "PARTIAL",
      })
    );

    await expect(retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST)).rejects.toMatchObject({
      name: "XeroOperationRetryError",
      status: 400,
    } satisfies Partial<XeroOperationRetryError>);
  });
});

// #4256: the PARTIAL repairs claim their row first, PARTIAL -> RUNNING, like
// every other retry that writes the original. A resolve, a mark or a second
// retry landing after the read makes the claim lose: nothing written, no Xero.
describe("PARTIAL repairs claim the original before they write or call Xero (#4256)", () => {
  const partialInvoice = (totalDollars: number, extra: Record<string, unknown> = {}) =>
    makeOperation({
      status: "PARTIAL",
      xeroObjectId: "inv_123",
      xeroObjectNumber: "INV-0042",
      responsePayload: {
        invoice: { invoices: [{ total: totalDollars }] },
        paymentError: { message: "Xero 503" },
        ...extra,
      },
    });
  const partialRefundNote = () =>
    makeOperation({
      status: "PARTIAL",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      xeroObjectId: "cn_123",
      requestPayload: { allocation: { invoiceId: "inv_123", amount: 12.34 } },
      responsePayload: {},
    });
  const branches = [
    ["the invoice payment repair", () => partialInvoice(45.67)],
    ["the zero-cash invoice repair", () => partialInvoice(0)],
    ["the refund-note repair", partialRefundNote],
  ] as const;
  const noSideEffect = () => {
    expect(mocks.createXeroPaymentForInvoice).not.toHaveBeenCalled();
    expect(mocks.finishRefundCreditNoteSettlement).not.toHaveBeenCalled();
    expect(mocks.completeXeroSyncOperation).not.toHaveBeenCalled();
    expect(mocks.updatePayment).not.toHaveBeenCalled();
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstOperation.mockResolvedValue(null);
    mocks.updateManyOperation.mockResolvedValue({ count: 1 });
    mocks.findUniquePayment.mockResolvedValue({ id: "pay_123", source: "STRIPE" });
    mocks.createXeroPaymentForInvoice.mockResolvedValue("xpay_1");
    mocks.finishRefundCreditNoteSettlement.mockResolvedValue({ refundPaymentErr: null });
    mocks.completeXeroSyncOperation.mockResolvedValue({ id: "op_123" });
    mocks.findFirstXeroObjectLink.mockResolvedValue(null);
    mocks.findManyXeroObjectLink.mockResolvedValue([]);
  });

  it.each(branches)("MUTATION: %s claims PARTIAL only, unresolved and replayable, before anything else", async (_label, row) => {
    mocks.findUniqueOperation.mockResolvedValue(row());
    await retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST, { createdByMemberId: "admin_1" });

    expect(mocks.updateManyOperation.mock.calls[0][0]).toEqual({
      where: { id: "op_123", status: "PARTIAL", manuallyResolvedAt: null, replayable: true },
      // #4256 review F1: the marker a stale reset reads to return a dead repair to PARTIAL.
      data: { status: "RUNNING", startedAt: expect.any(Date), lastErrorCode: XERO_PARTIAL_REPAIR_RUNNING_CODE },
    });
    const claimOrder = mocks.updateManyOperation.mock.invocationCallOrder[0];
    for (const sideEffect of [
      mocks.createXeroPaymentForInvoice,
      mocks.finishRefundCreditNoteSettlement,
      mocks.completeXeroSyncOperation,
      mocks.updatePayment,
    ]) {
      for (const order of sideEffect.mock.invocationCallOrder) expect(claimOrder).toBeLessThan(order);
    }
  });

  it.each(branches)("MUTATION: a resolve landing before %s claims makes it write nothing and call Xero for nothing", async (_label, row) => {
    // The read saw the row unresolved; the re-read after the lost claim sees the mark.
    mocks.findUniqueOperation
      .mockResolvedValueOnce(row())
      .mockResolvedValueOnce({ manuallyResolvedAt: RESOLVED_AT, requestPayload: null });
    mocks.updateManyOperation.mockImplementation(async (args: { where: Record<string, unknown> }) => ({
      count: args.where.manuallyResolvedAt === null ? 0 : 1,
    }));

    await expect(retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST)).rejects.toBeInstanceOf(
      XeroOperationResolvedInXeroError,
    );
    noSideEffect();
  });

  it.each(branches)("MUTATION: a mark non-replayable landing before %s claims makes it write nothing", async (_label, row) => {
    mocks.findUniqueOperation
      .mockResolvedValueOnce(row())
      .mockResolvedValueOnce({ manuallyResolvedAt: null, requestPayload: null, replayable: false });
    mocks.updateManyOperation.mockImplementation(async (args: { where: Record<string, unknown> }) => ({
      count: args.where.replayable === true ? 0 : 1,
    }));

    const refusal = retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST);
    // Its own class, so the queued-retry drain skips its row (review, permissions F1).
    await expect(refusal).rejects.toBeInstanceOf(XeroOperationNotReplayableError);
    await expect(refusal).rejects.toMatchObject({
      status: 409,
      message: "This operation is not marked replayable.",
    });
    noSideEffect();
  });

  it.each(branches)("MUTATION: %s loses to a write that took the row out of PARTIAL (Mark failed, a requeue)", async (_label, row) => {
    mocks.findUniqueOperation
      .mockResolvedValueOnce(row())
      .mockResolvedValueOnce({ manuallyResolvedAt: null, requestPayload: null });
    // The row is no longer PARTIAL: only a PARTIAL-only claim misses it.
    mocks.updateManyOperation.mockImplementation(async (args: { where: { status?: unknown } }) => ({
      count: args.where.status === "PARTIAL" ? 0 : 1,
    }));

    await expect(retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("already claimed"),
    });
    noSideEffect();
  });

  it.each(branches)("MUTATION: two retries racing on %s run its side effect once", async (_label, row) => {
    mocks.findUniqueOperation.mockImplementation(async () => ({ ...row(), manuallyResolvedAt: null }));
    let status = "PARTIAL";
    mocks.updateManyOperation.mockImplementation(async (args: { where: { status?: unknown }; data: { status?: string } }) => {
      const matches =
        args.where.status === status ||
        (typeof args.where.status === "object" &&
          (args.where.status as { in?: string[] } | null)?.in?.includes(status));
      if (!matches) return { count: 0 };
      if (args.data.status) status = args.data.status;
      return { count: 1 };
    });

    const results = await Promise.allSettled([
      retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST),
      retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    // One run's worth: at most one payment write, one settle, one completion.
    for (const sideEffect of [
      mocks.createXeroPaymentForInvoice,
      mocks.finishRefundCreditNoteSettlement,
      mocks.completeXeroSyncOperation,
    ]) {
      expect(sideEffect.mock.calls.length).toBeLessThanOrEqual(1);
    }
  });

  it("closes the repaired invoice row SUCCEEDED with the payment, keeping its invoice number", async () => {
    mocks.findUniqueOperation.mockResolvedValue(partialInvoice(45.67));
    await retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST);
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(expect.objectContaining({ id: "op_123" }), {
      status: "SUCCEEDED",
      responsePayload: expect.objectContaining({
        invoice: { invoices: [{ total: 45.67 }] },
        payment: { paymentID: "xpay_1", amount: 45.67 },
        paymentError: null,
      }),
      xeroObjectType: "INVOICE",
      xeroObjectId: "inv_123",
      xeroObjectNumber: "INV-0042",
    }, { retryClaim: true, alert: false });
  });

  it("leaves it PARTIAL while its invoice email fault remains, which the repair does not send", async () => {
    mocks.findUniqueOperation.mockResolvedValue(partialInvoice(45.67, { invoiceEmailError: "SES refused" }));
    await retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST);
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({ id: "op_123" }),
      expect.objectContaining({
        status: "PARTIAL",
        responsePayload: expect.objectContaining({ paymentError: null, invoiceEmailError: "SES refused" }),
        // #4256 review: the stale payment fault's message is replaced.
        lastErrorMessage: PARTIAL_REPAIR_EMAIL_STILL_FAILED_MESSAGE,
      }),
      { retryClaim: true, alert: false },
    );
  });

  it("MUTATION: a failed payment write gives the row back PARTIAL with its payload, guarded on this claim", async () => {
    mocks.findUniqueOperation.mockResolvedValue(partialInvoice(45.67));
    const refusal = new Error("Xero 503 again");
    mocks.createXeroPaymentForInvoice.mockRejectedValue(refusal);

    await expect(retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST)).rejects.toBe(refusal);

    const claim = mocks.updateManyOperation.mock.calls[0][0];
    expect(mocks.updateManyOperation.mock.calls[1][0]).toEqual({
      where: { id: "op_123", status: "RUNNING", startedAt: claim.data.startedAt },
      data: {
        status: "PARTIAL",
        lastErrorCode: null,
        lastErrorMessage: "Xero 503 again",
        completedAt: expect.any(Date),
      },
    });
    // Not FAILED, which would replace the payload the repair reads.
    expect(mocks.failXeroSyncOperation).not.toHaveBeenCalled();
    expect(mocks.completeXeroSyncOperation).not.toHaveBeenCalled();
    expect(retryAbandonedItsClaim(refusal)).toBe(false);
  });

  it("a refund-note leg that completed the row itself before throwing is not overwritten", async () => {
    mocks.findUniqueOperation.mockResolvedValue(partialRefundNote());
    mocks.finishRefundCreditNoteSettlement.mockResolvedValueOnce({ refundPaymentErr: new Error("Xero 503") });
    // The shared leg already wrote PARTIAL, so the claim's give-back matches nothing.
    mocks.updateManyOperation.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    await expect(retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST)).rejects.toThrow("Xero 503");
    expect(mocks.updateManyOperation.mock.calls[1][0].where).toMatchObject({ status: "RUNNING" });
    expect(mocks.failXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("refuses a row read as not replayable with its own error, before any claim", async () => {
    mocks.findUniqueOperation.mockResolvedValue({ ...partialInvoice(45.67), replayable: false });
    const refusal = retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST);
    await expect(refusal).rejects.toBeInstanceOf(XeroOperationNotReplayableError);
    await expect(refusal).rejects.toMatchObject({ status: 400 });
    expect(mocks.updateManyOperation).not.toHaveBeenCalled();
    noSideEffect();
  });

  it("sends Xero the stored cash, and completes onto its own claim with no repeated-failure alert", async () => {
    mocks.findUniqueOperation.mockResolvedValue(partialInvoice(45.67));
    await retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST);
    expect(mocks.createXeroPaymentForInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 4567, invoiceId: "inv_123", idempotencyKey: "payment:pay_123:invoice-payment:v1" }),
    );
    const claimedAt = mocks.updateManyOperation.mock.calls[0][0].data.startedAt;
    expect(mocks.completeXeroSyncOperation.mock.calls[0][0]).toEqual({ id: "op_123", startedAt: claimedAt });
    expect(mocks.completeXeroSyncOperation.mock.calls[0][2]).toEqual({ retryClaim: true, alert: false });
  });

  it("a zero-cash repair with an email fault stays PARTIAL, records no payment and says the email is what is left", async () => {
    mocks.findUniqueOperation.mockResolvedValue(partialInvoice(0, { invoiceEmailError: "SES refused" }));
    await retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST);
    expect(mocks.createXeroPaymentForInvoice).not.toHaveBeenCalled();
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({ id: "op_123" }),
      expect.objectContaining({
        status: "PARTIAL",
        responsePayload: expect.objectContaining({ payment: null, paymentError: null, paymentSkipped: true }),
        lastErrorMessage: PARTIAL_REPAIR_EMAIL_STILL_FAILED_MESSAGE,
      }),
      { retryClaim: true, alert: false },
    );
  });

  it("a give-back records the Xero status code of the error that stopped the repair", async () => {
    mocks.findUniqueOperation.mockResolvedValue(partialInvoice(45.67));
    const refusal = Object.assign(new Error("Service Unavailable"), { response: { statusCode: 503 } });
    mocks.createXeroPaymentForInvoice.mockRejectedValue(refusal);

    await expect(retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST)).rejects.toBe(refusal);
    expect(mocks.updateManyOperation.mock.calls[1][0].data).toMatchObject({
      status: "PARTIAL",
      lastErrorCode: "503",
      lastErrorMessage: "Service Unavailable",
    });
  });

  it.each([
    ["the payment repair", 45.67, PARTIAL_REPAIR_CLAIM_LOST_MESSAGE],
    ["the zero-cash repair", 0, "This operation was reset while the repair ran, so it was not closed. Retry it once to close it."],
  ])("MUTATION: %s whose completion lost its claim never reports it repaired", async (_label, total, message) => {
    mocks.findUniqueOperation.mockResolvedValue(partialInvoice(total));
    // An operator's Mark failed / Reset stale running took the claim back mid-run.
    mocks.completeXeroSyncOperation.mockResolvedValue(null);
    await expect(retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST)).resolves.toEqual({ message });
  });

  const paymentLink = (metadata: Record<string, unknown>, xeroObjectId = "xpay_earlier") => ({
    xeroObjectId,
    xeroObjectType: "PAYMENT",
    role: "INVOICE_PAYMENT",
    metadata,
  });

  it.each([
    ["the repair's own link (amountCents)", { invoiceId: "inv_123", amountCents: 4567 }],
    ["the create's or the inbound sync's link (dollar amount)", { invoiceId: "inv_123", amount: 45.67, status: "AUTHORISED" }],
  ])("MUTATION: a payment already recorded for this invoice at this amount - %s - is never sent again; the row closes on it", async (_label, metadata) => {
    mocks.findUniqueOperation.mockResolvedValue(partialInvoice(45.67));
    mocks.findManyXeroObjectLink.mockResolvedValue([paymentLink(metadata)]);

    await expect(retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST)).resolves.toEqual({
      message: "The payment was already recorded in Xero; closed the operation without paying again.",
    });
    expect(mocks.findManyXeroObjectLink).toHaveBeenCalledWith({
      where: {
        localModel: "Payment",
        localId: "pay_123",
        xeroObjectType: "PAYMENT",
        role: "INVOICE_PAYMENT",
        active: true,
        metadata: { path: ["invoiceId"], equals: "inv_123" },
      },
      select: { xeroObjectId: true, xeroObjectType: true, role: true, metadata: true },
    });
    expect(mocks.createXeroPaymentForInvoice).not.toHaveBeenCalled();
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({ id: "op_123" }),
      expect.objectContaining({
        status: "SUCCEEDED",
        responsePayload: expect.objectContaining({ paymentError: null, payment: { paymentID: "xpay_earlier", amount: 45.67 } }),
      }),
      { retryClaim: true, alert: false },
    );
  });

  // Review C: the inbound sync links every payment Xero reports on the invoice.
  it.each([
    ["a DELETED payment", { invoiceId: "inv_123", amount: 45.67, status: "DELETED" }],
    ["a VOIDED payment", { invoiceId: "inv_123", amountCents: 4567, status: "VOIDED" }],
    ["a part payment of a different amount", { invoiceId: "inv_123", amount: 20, status: "AUTHORISED" }],
    ["a payment against another invoice", { invoiceId: "inv_other", amount: 45.67, status: "AUTHORISED" }],
    ["a link with no readable amount", { invoiceId: "inv_123", status: "AUTHORISED" }],
  ])("MUTATION: %s is not this repair's payment, so the repair still pays", async (_label, metadata) => {
    mocks.findUniqueOperation.mockResolvedValue(partialInvoice(45.67));
    mocks.findManyXeroObjectLink.mockResolvedValue([paymentLink(metadata)]);

    await expect(retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST)).resolves.toEqual({
      message: "Repaired Xero booking invoice payment recording.",
    });
    expect(mocks.createXeroPaymentForInvoice).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 4567 }));
    expect(mocks.completeXeroSyncOperation.mock.calls[0][1].responsePayload.payment).toEqual({ paymentID: "xpay_1", amount: 45.67 });
  });

  it("a closing-on-the-recorded-payment whose completion lost its claim says the payment is already recorded (review D)", async () => {
    mocks.findUniqueOperation.mockResolvedValue(partialInvoice(45.67));
    mocks.findManyXeroObjectLink.mockResolvedValue([paymentLink({ invoiceId: "inv_123", amountCents: 4567 })]);
    mocks.completeXeroSyncOperation.mockResolvedValue(null);

    await expect(retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST)).resolves.toEqual({
      message: "The payment is already recorded in Xero; retry once to close this operation.",
    });
  });

  describe("the FAILED refund-note repair claims its row too (review F3)", () => {
    const failedRefundNote = () => ({ ...partialRefundNote(), status: "FAILED" });

    // #4356: its own marker, not the PARTIAL one, so a stale reset still gives
    // it back FAILED, and no other caller's late outcome lands on the claim.
    it("MUTATION: claims FAILED only before it settles, with its own repair marker, and completes onto the claim", async () => {
      mocks.findUniqueOperation.mockResolvedValue(failedRefundNote());
      await retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST);

      const claim = mocks.updateManyOperation.mock.calls[0][0];
      expect(claim).toEqual({
        where: { id: "op_123", status: "FAILED", manuallyResolvedAt: null, replayable: true },
        data: { status: "RUNNING", startedAt: expect.any(Date), lastErrorCode: XERO_REFUND_NOTE_REPAIR_RUNNING_CODE },
      });
      expect(mocks.updateManyOperation.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.finishRefundCreditNoteSettlement.mock.invocationCallOrder[0],
      );
      expect(mocks.finishRefundCreditNoteSettlement).toHaveBeenCalledWith(
        expect.objectContaining({ operation: { id: "op_123", startedAt: claim.data.startedAt }, retryClaim: true }),
      );
    });

    it.each(["FAILED", "PARTIAL"])("reports claim lost when a %s note's recorded-payment completion returns null", async (status) => {
      mocks.findUniqueOperation.mockResolvedValue({
        ...failedRefundNote(), status, responsePayload: { refundPaymentSkipped: true },
      });
      mocks.completeXeroSyncOperation.mockResolvedValueOnce(null);

      await expect(retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST)).resolves.toEqual({
        message: PARTIAL_REPAIR_CLAIM_LOST_MESSAGE,
      });
      expect(mocks.completeXeroSyncOperation).toHaveBeenCalled();
      expect(mocks.finishRefundCreditNoteSettlement).not.toHaveBeenCalled();
    });

    // #4356: a row another caller completed PARTIAL after the read is not this repair's to take.
    it("MUTATION: a row that went PARTIAL after its read is already claimed, and it settles nothing", async () => {
      mocks.findUniqueOperation
        .mockResolvedValueOnce(failedRefundNote())
        .mockResolvedValueOnce({ manuallyResolvedAt: null, requestPayload: null });
      // The row now reads PARTIAL: only a claim that still matches PARTIAL takes it.
      mocks.updateManyOperation.mockImplementation(async (args: { where: { status?: unknown } }) => ({
        count: args.where.status === "FAILED" ? 0 : 1,
      }));

      await expect(retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST)).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining("already claimed"),
      });
      noSideEffect();
    });

    it("MUTATION: a resolve landing before its claim makes it settle nothing", async () => {
      mocks.findUniqueOperation
        .mockResolvedValueOnce(failedRefundNote())
        .mockResolvedValueOnce({ manuallyResolvedAt: RESOLVED_AT, requestPayload: null });
      mocks.updateManyOperation.mockResolvedValue({ count: 0 });

      await expect(retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST)).rejects.toBeInstanceOf(
        XeroOperationResolvedInXeroError,
      );
      noSideEffect();
    });

    it("a throw before the leg completes abandons the claim to FAILED, guarded on it", async () => {
      mocks.findUniqueOperation.mockResolvedValue(failedRefundNote());
      const refusal = new Error("Credit note cn_123 is VOIDED in Xero");
      mocks.finishRefundCreditNoteSettlement.mockRejectedValueOnce(refusal);

      await expect(retryXeroSyncOperation("op_123", CLUB_FORMAT_TEST)).rejects.toBe(refusal);
      const claimedAt = mocks.updateManyOperation.mock.calls[0][0].data.startedAt;
      expect(mocks.failXeroSyncOperation).toHaveBeenCalledWith({ id: "op_123", startedAt: claimedAt }, refusal, undefined, {
        retryClaim: true,
      });
    });
  });
});
