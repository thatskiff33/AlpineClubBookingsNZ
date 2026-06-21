import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  inboundFindMany: vi.fn(),
  inboundFindUnique: vi.fn(),
  inboundUpdateMany: vi.fn(),
  inboundUpdate: vi.fn(),
  xeroContactCacheUpsert: vi.fn(),
  refreshXeroContactCachesFromContact: vi.fn(),
  processedCreate: vi.fn(),
  processedDeleteMany: vi.fn(),
  transaction: vi.fn(),
  xeroSyncOperationFindMany: vi.fn(),
  xeroSyncCursorFindUnique: vi.fn(),
  memberFindMany: vi.fn(),
  memberUpdate: vi.fn(),
  memberCreditAggregate: vi.fn(),
  memberCreditCreate: vi.fn(),
  memberCreditFindMany: vi.fn(),
  memberCreditUpdate: vi.fn(),
  memberCreditUpdateMany: vi.fn(),
  linkFindMany: vi.fn(),
  auditLogCreate: vi.fn(),
  bookingFindMany: vi.fn(),
  bookingUpdate: vi.fn(),
  bookingModificationFindMany: vi.fn(),
  paymentFindMany: vi.fn(),
  paymentUpdate: vi.fn(),
  paymentTransactionUpdateMany: vi.fn(),
  paymentTransactionCreate: vi.fn(),
  subscriptionFindMany: vi.fn(),
  groupSettlementFindFirst: vi.fn(),
  applyGroupSettlementFromInvoice: vi.fn(),
  syncContactsFromXero: vi.fn(),
  refreshAllMembershipStatuses: vi.fn(),
  startXeroSyncOperation: vi.fn(),
  completeXeroSyncOperation: vi.fn(),
  failXeroSyncOperation: vi.fn(),
  upsertXeroObjectLink: vi.fn(),
  getAuthenticatedXeroClient: vi.fn(),
  withXeroRetry: vi.fn(),
  checkMembershipStatus: vi.fn(),
  getAccountMapping: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    xeroInboundEvent: {
      findMany: mocks.inboundFindMany,
      findUnique: mocks.inboundFindUnique,
      updateMany: mocks.inboundUpdateMany,
      update: mocks.inboundUpdate,
    },
    xeroContactCache: {
      upsert: mocks.xeroContactCacheUpsert,
    },
    processedWebhookEvent: {
      create: mocks.processedCreate,
      deleteMany: mocks.processedDeleteMany,
    },
    xeroSyncOperation: {
      findMany: mocks.xeroSyncOperationFindMany,
    },
    xeroSyncCursor: {
      findUnique: mocks.xeroSyncCursorFindUnique,
    },
    member: {
      findMany: mocks.memberFindMany,
      update: mocks.memberUpdate,
    },
    memberCredit: {
      aggregate: mocks.memberCreditAggregate,
      create: mocks.memberCreditCreate,
      findMany: mocks.memberCreditFindMany,
      update: mocks.memberCreditUpdate,
      updateMany: mocks.memberCreditUpdateMany,
    },
    xeroObjectLink: {
      findMany: mocks.linkFindMany,
    },
    auditLog: {
      create: mocks.auditLogCreate,
    },
    booking: {
      findMany: mocks.bookingFindMany,
      update: mocks.bookingUpdate,
    },
    bookingModification: {
      findMany: mocks.bookingModificationFindMany,
    },
    payment: {
      findMany: mocks.paymentFindMany,
      update: mocks.paymentUpdate,
    },
    paymentTransaction: {
      updateMany: mocks.paymentTransactionUpdateMany,
      create: mocks.paymentTransactionCreate,
    },
    memberSubscription: {
      findMany: mocks.subscriptionFindMany,
    },
    groupBookingSettlement: {
      findFirst: mocks.groupSettlementFindFirst,
    },
    $transaction: mocks.transaction,
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

vi.mock("@/lib/email", () => ({
  sendBookingConfirmedEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/group-settlement", () => ({
  applyGroupSettlementSucceededFromInvoice: mocks.applyGroupSettlementFromInvoice,
}));

vi.mock("@/lib/xero-sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/xero-sync")>();

  return {
    ...actual,
    startXeroSyncOperation: mocks.startXeroSyncOperation,
    completeXeroSyncOperation: mocks.completeXeroSyncOperation,
    failXeroSyncOperation: mocks.failXeroSyncOperation,
    upsertXeroObjectLink: mocks.upsertXeroObjectLink,
  };
});

vi.mock("@/lib/xero-links", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/xero-links")>();

  return {
    ...actual,
    buildXeroContactUrl: (id: string) => `https://xero.test/contact/${id}`,
    buildXeroInvoiceUrl: (id: string) => `https://xero.test/invoice/${id}`,
  };
});

vi.mock("@/lib/xero", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/xero")>();

  return {
    ...actual,
    checkMembershipStatus: mocks.checkMembershipStatus,
    getAccountMapping: mocks.getAccountMapping,
    getAuthenticatedXeroClient: mocks.getAuthenticatedXeroClient,
    refreshXeroContactCachesFromContact: mocks.refreshXeroContactCachesFromContact,
    syncContactsFromXero: mocks.syncContactsFromXero,
    refreshAllMembershipStatuses: mocks.refreshAllMembershipStatuses,
    withXeroRetry: mocks.withXeroRetry,
    findSubscriptionInvoice: (
      invoices: Array<{ lineItems?: Array<{ accountCode?: string }>; reference?: string }>
    ) =>
      invoices.find(
        (invoice) =>
          invoice.lineItems?.some((lineItem) => lineItem.accountCode === "203") ||
          (invoice.reference ?? "").toLowerCase().includes("annual member subscription")
      ) ?? null,
  };
});

import {
  processStoredXeroInboundEvents,
  runXeroInboundReconciliationCycle,
  replayStoredXeroInboundEvent,
  XeroInboundReplayError,
} from "@/lib/xero-inbound-reconciliation";
import { sendBookingConfirmedEmail } from "@/lib/email";

describe("processStoredXeroInboundEvents", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(sendBookingConfirmedEmail).mockResolvedValue(undefined);
    mocks.inboundUpdateMany.mockResolvedValue({ count: 1 });
    mocks.xeroSyncOperationFindMany.mockResolvedValue([]);
    mocks.xeroSyncCursorFindUnique.mockResolvedValue(null);
    mocks.refreshXeroContactCachesFromContact.mockResolvedValue({
      cachedContact: {
        contactId: "contact_1",
        name: "Contact One",
        firstName: "Contact",
        lastName: "One",
        emailAddress: "contact@example.com",
        companyNumber: null,
        contactStatus: "ACTIVE",
        phoneCountryCode: "64",
        phoneAreaCode: "27",
        phoneNumber: "1234567",
        streetAddressLine1: "1 Alpine Way",
        streetAddressLine2: null,
        streetCity: "Wanaka",
        streetRegion: "Otago",
        streetPostalCode: "9305",
        streetCountry: "NZ",
        postalAddressLine1: "PO Box 1",
        postalAddressLine2: null,
        postalCity: "Wanaka",
        postalRegion: "Otago",
        postalPostalCode: "9343",
        postalCountry: "NZ",
      },
      groupMemberships: {
        contactId: "contact_1",
        observed: true,
        contactGroupsSeen: 1,
        membershipsAdded: 1,
        membershipsRemoved: 0,
        groupsTouched: 1,
      },
    });
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        processedWebhookEvent: {
          deleteMany: mocks.processedDeleteMany,
        },
        xeroInboundEvent: {
          update: mocks.inboundUpdate,
        },
      })
    );
    mocks.getAccountMapping.mockResolvedValue("203");
    mocks.refreshAllMembershipStatuses.mockResolvedValue({
      seasonYear: 2026,
      cursorFrom: null,
      cursorTo: "2026-04-14T00:05:00.000Z",
      changedInvoices: 0,
      changedInvoiceIds: [],
      affectedMembers: 0,
      checked: 0,
      updated: 0,
      errors: 0,
      errorDetails: [],
    });
    mocks.withXeroRetry.mockImplementation(async (fn: () => Promise<unknown>) => fn());
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_1" });
    mocks.memberCreditAggregate.mockResolvedValue({
      _sum: {
        amountCents: 0,
      },
    });
    mocks.memberCreditCreate.mockResolvedValue({ id: "credit_1" });
    mocks.memberCreditFindMany.mockResolvedValue([]);
    mocks.memberCreditUpdate.mockResolvedValue({ id: "credit_1" });
    mocks.memberCreditUpdateMany.mockResolvedValue({ count: 0 });
    mocks.auditLogCreate.mockResolvedValue({});
    mocks.bookingFindMany.mockResolvedValue([]);
    mocks.bookingUpdate.mockResolvedValue({});
    mocks.bookingModificationFindMany.mockResolvedValue([]);
    mocks.paymentFindMany.mockResolvedValue([]);
    mocks.paymentUpdate.mockResolvedValue({});
    mocks.paymentTransactionUpdateMany.mockResolvedValue({ count: 1 });
    mocks.paymentTransactionCreate.mockResolvedValue({});
    mocks.subscriptionFindMany.mockResolvedValue([]);
  });

  it("only automatically retries failed inbound events after the retry backoff window", async () => {
    mocks.inboundFindMany.mockResolvedValue([]);

    await expect(processStoredXeroInboundEvents()).resolves.toEqual({
      found: 0,
      processed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.inboundFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { status: "RECEIVED" },
            {
              status: "FAILED",
              updatedAt: {
                lte: expect.any(Date),
              },
            },
          ],
        }),
      })
    );
  });

  it("marks duplicate inbound events as processed without re-running reconciliation", async () => {
    mocks.inboundFindMany.mockResolvedValue([
      {
        id: "evt_1",
        source: "webhook",
        eventCategory: "CONTACT",
        eventType: "UPDATE",
        resourceId: "contact_1",
        correlationKey: "corr_1",
        payload: {},
      },
    ]);
    mocks.processedCreate.mockRejectedValue({ code: "P2002" });

    await expect(processStoredXeroInboundEvents()).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 0,
      failed: 0,
      skipped: 1,
    });

    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
    expect(mocks.inboundUpdate).toHaveBeenCalledWith({
      where: { id: "evt_1" },
      data: expect.objectContaining({
        status: "PROCESSED",
      }),
    });
  });

  it("redacts sensitive error text when a stored inbound event fails", async () => {
    mocks.inboundFindMany.mockResolvedValue([
      {
        id: "evt_1",
        source: "webhook",
        eventCategory: "CONTACT",
        eventType: "UPDATE",
        resourceId: "contact_1",
        correlationKey: "corr_1",
        payload: {},
      },
    ]);
    mocks.processedCreate.mockResolvedValue({ id: "processed_1" });
    mocks.startXeroSyncOperation.mockRejectedValue(
      new Error("Xero failed with client_secret=pi_123_secret_liveSecret")
    );

    await expect(processStoredXeroInboundEvents()).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 0,
      failed: 1,
      skipped: 0,
    });

    expect(mocks.inboundUpdate).toHaveBeenCalledWith({
      where: { id: "evt_1" },
      data: {
        status: "FAILED",
        errorMessage: "Xero failed with client_secret=[REDACTED]",
        processedAt: null,
      },
    });
    expect(mocks.processedDeleteMany).toHaveBeenCalledWith({
      where: {
        eventId: "corr_1",
        source: "xero",
      },
    });
  });

  it("reconciles linked contact events and backfills missing member fields", async () => {
    mocks.inboundFindMany.mockResolvedValue([
      {
        id: "evt_1",
        source: "webhook",
        eventCategory: "CONTACT",
        eventType: "UPDATE",
        resourceId: "contact_1",
        correlationKey: "corr_1",
        payload: { resourceId: "contact_1" },
      },
    ]);
    mocks.processedCreate.mockResolvedValue({ id: "processed_1" });
    mocks.linkFindMany.mockResolvedValue([{ localId: "mem_1" }]);
    mocks.memberFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "mem_1",
          xeroContactId: null,
          dateOfBirth: null,
          phoneCountryCode: null,
          phoneAreaCode: null,
          phoneNumber: null,
          streetAddressLine1: null,
          postalAddressLine1: null,
          joinedDate: null,
        },
      ]);
    const accountingApi = {
      getContact: vi.fn().mockResolvedValue({
        body: {
          contacts: [
            {
              contactID: "contact_1",
              companyNumber: "01/02/2000",
              phones: [
                {
                  phoneType: "MOBILE",
                  phoneCountryCode: "64",
                  phoneAreaCode: "27",
                  phoneNumber: "1234567",
                },
              ],
              addresses: [
                {
                  addressType: "STREET",
                  addressLine1: "1 Alpine Way",
                  city: "Wanaka",
                  region: "Otago",
                  postalCode: "9305",
                  country: "NZ",
                },
                {
                  addressType: "POBOX",
                  addressLine1: "PO Box 1",
                  city: "Wanaka",
                  region: "Otago",
                  postalCode: "9343",
                  country: "NZ",
                },
              ],
            },
          ],
        },
      }),
      getInvoices: vi.fn().mockResolvedValue({
        body: {
          invoices: [{ date: "2024-04-10" }],
        },
      }),
    };
    mocks.getAuthenticatedXeroClient.mockResolvedValue({
      xero: { accountingApi },
      tenantId: "tenant_1",
    });

    const result = await processStoredXeroInboundEvents();
    expect(result).toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.memberUpdate).toHaveBeenCalledWith({
      where: { id: "mem_1" },
      data: expect.objectContaining({
        xeroContactId: "contact_1",
        phoneCountryCode: "64",
        phoneAreaCode: "27",
        phoneNumber: "1234567",
        streetAddressLine1: "1 Alpine Way",
        postalAddressLine1: "PO Box 1",
        joinedDate: new Date("2024-04-10"),
      }),
    });
    expect(mocks.refreshXeroContactCachesFromContact).toHaveBeenCalledWith(
      expect.objectContaining({
        contactID: "contact_1",
      }),
      expect.any(Date)
    );
    expect(mocks.upsertXeroObjectLink).toHaveBeenCalledWith(
      expect.objectContaining({
        localModel: "Member",
        localId: "mem_1",
        xeroObjectId: "contact_1",
        role: "CONTACT",
      })
    );
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      "op_1",
      expect.objectContaining({
        responsePayload: expect.objectContaining({
          contactGroupsSeen: 1,
          groupMembershipsAdded: 1,
          groupMembershipsRemoved: 0,
        }),
        xeroObjectType: "CONTACT",
        xeroObjectId: "contact_1",
      })
    );
    expect(mocks.auditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "xero.contact.reconciled",
        subjectMemberId: "mem_1",
        entityType: "Member",
        entityId: "mem_1",
        category: "xero",
        metadata: expect.objectContaining({
          source: "xero-inbound-contact",
          xeroObjectId: "contact_1",
          changedFields: expect.arrayContaining([
            "xeroContactId",
            "phoneCountryCode",
            "streetAddressLine1",
            "joinedDate",
          ]),
        }),
      }),
    });
  });

  it("reconciles invoice events into payment metadata and membership refresh", async () => {
    mocks.inboundFindMany.mockResolvedValue([
      {
        id: "evt_2",
        source: "webhook",
        eventCategory: "INVOICE",
        eventType: "UPDATE",
        resourceId: "inv_1",
        correlationKey: "corr_2",
        payload: { resourceId: "inv_1" },
      },
    ]);
    mocks.processedCreate.mockResolvedValue({ id: "processed_2" });
    mocks.linkFindMany
      .mockResolvedValueOnce([
        {
          localModel: "Payment",
          localId: "pay_1",
          xeroObjectType: "INVOICE",
          role: "PRIMARY_INVOICE",
        },
      ])
      .mockResolvedValueOnce([]);
    mocks.paymentFindMany
      .mockResolvedValueOnce([
        {
          id: "pay_1",
          xeroInvoiceId: null,
          xeroInvoiceNumber: null,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "pay_1",
          bookingId: "booking_1",
          booking: { memberId: "mem_1" },
        },
      ]);
    mocks.subscriptionFindMany.mockResolvedValue([]);
    mocks.memberFindMany.mockResolvedValue([{ id: "mem_1" }]);
    mocks.checkMembershipStatus.mockResolvedValue({
      status: "PAID",
      xeroInvoiceId: "inv_1",
    });
    const accountingApi = {
      getInvoice: vi.fn().mockResolvedValue({
        body: {
          invoices: [
            {
              invoiceID: "inv_1",
              invoiceNumber: "INV-001",
              date: "2026-04-10",
              contact: { contactID: "contact_1" },
              lineItems: [{ accountCode: "203" }],
            },
          ],
        },
      }),
    };
    mocks.getAuthenticatedXeroClient.mockResolvedValue({
      xero: { accountingApi },
      tenantId: "tenant_1",
    });

    const result = await processStoredXeroInboundEvents();
    expect(result).toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.paymentUpdate).toHaveBeenCalledWith({
      where: { id: "pay_1" },
      data: {
        xeroInvoiceId: "inv_1",
        xeroInvoiceNumber: "INV-001",
      },
    });
    expect(mocks.checkMembershipStatus).toHaveBeenCalledWith("mem_1", 2026);
    expect(mocks.upsertXeroObjectLink).toHaveBeenCalledWith(
      expect.objectContaining({
        localModel: "Payment",
        localId: "pay_1",
        xeroObjectId: "inv_1",
        role: "PRIMARY_INVOICE",
      })
    );
    expect(mocks.auditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "xero.invoice.reconciled",
        subjectMemberId: "mem_1",
        entityType: "Payment",
        entityId: "pay_1",
        category: "xero",
        metadata: expect.objectContaining({
          source: "xero-inbound-invoice",
          xeroObjectId: "inv_1",
          invoiceNumber: "INV-001",
          matchedPayments: 1,
          updatedPayments: 1,
        }),
      }),
    });
  });

  it("marks Internet Banking bookings paid when the linked Xero invoice is paid", async () => {
    mocks.inboundFindMany.mockResolvedValue([
      {
        id: "evt_ib_1",
        source: "webhook",
        eventCategory: "INVOICE",
        eventType: "UPDATE",
        resourceId: "inv_ib_1",
        correlationKey: "corr_ib_1",
        payload: { resourceId: "inv_ib_1" },
      },
    ]);
    mocks.processedCreate.mockResolvedValue({ id: "processed_ib_1" });
    mocks.linkFindMany
      .mockResolvedValueOnce([
        {
          localModel: "Payment",
          localId: "pay_ib_1",
          xeroObjectType: "INVOICE",
          role: "PRIMARY_INVOICE",
        },
      ])
      .mockResolvedValueOnce([]);
    mocks.paymentFindMany
      .mockResolvedValueOnce([
        {
          id: "pay_ib_1",
          xeroInvoiceId: null,
          xeroInvoiceNumber: null,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "pay_ib_1",
          bookingId: "booking_ib_1",
          amountCents: 12345,
          status: "PENDING",
          source: "INTERNET_BANKING",
          reference: "BOOKING-ABC12345",
          xeroInvoiceId: null,
          xeroInvoiceNumber: null,
          booking: {
            id: "booking_ib_1",
            memberId: "mem_1",
            checkIn: new Date("2026-07-10"),
            checkOut: new Date("2026-07-12"),
            status: "PAYMENT_PENDING",
            finalPriceCents: 12345,
            discountCents: 0,
            promoAdjustmentCents: 0,
            member: {
              email: "member@example.com",
              firstName: "Alice",
              lastName: "Smith",
            },
            guests: [{ id: "guest_1" }],
            promoRedemption: null,
          },
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "pay_ib_1",
          bookingId: "booking_ib_1",
          booking: { memberId: "mem_1" },
        },
      ]);
    mocks.subscriptionFindMany.mockResolvedValue([]);
    const accountingApi = {
      getInvoice: vi.fn().mockResolvedValue({
        body: {
          invoices: [
            {
              invoiceID: "inv_ib_1",
              invoiceNumber: "INV-IB-001",
              date: "2026-07-01",
              status: "PAID",
              fullyPaidOnDate: "2026-07-02",
              contact: { contactID: "contact_1" },
              payments: [
                {
                  paymentID: "xpay_ib_1",
                  amount: 123.45,
                  invoiceNumber: "INV-IB-001",
                  status: "PAID",
                },
              ],
              lineItems: [{ accountCode: "200" }],
            },
          ],
        },
      }),
    };
    mocks.getAuthenticatedXeroClient.mockResolvedValue({
      xero: { accountingApi },
      tenantId: "tenant_1",
    });

    await expect(processStoredXeroInboundEvents()).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.paymentTransactionUpdateMany).toHaveBeenCalledWith({
      where: {
        paymentId: "pay_ib_1",
        source: "INTERNET_BANKING",
        kind: "PRIMARY",
      },
      data: {
        status: "SUCCEEDED",
        xeroInvoiceId: "inv_ib_1",
        xeroInvoiceNumber: "INV-IB-001",
      },
    });
    expect(mocks.paymentUpdate).toHaveBeenCalledWith({
      where: { id: "pay_ib_1" },
      data: {
        status: "SUCCEEDED",
        xeroInvoiceId: "inv_ib_1",
        xeroInvoiceNumber: "INV-IB-001",
      },
    });
    expect(mocks.bookingUpdate).toHaveBeenCalledWith({
      where: { id: "booking_ib_1" },
      data: {
        status: "PAID",
        draftExpiresAt: null,
      },
    });
    expect(mocks.auditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "booking.payment.confirmed",
        subjectMemberId: "mem_1",
        entityType: "Booking",
        entityId: "booking_ib_1",
        category: "payment",
        metadata: expect.objectContaining({
          paymentSource: "INTERNET_BANKING",
          xeroInvoiceId: "inv_ib_1",
          amountCents: 12345,
        }),
      }),
    });
    expect(sendBookingConfirmedEmail).toHaveBeenCalledWith(
      "member@example.com",
      "Alice",
      new Date("2026-07-10"),
      new Date("2026-07-12"),
      1,
      12345,
      undefined
    );
  });

  it("settles an organiser group when its combined invoice is paid", async () => {
    mocks.inboundFindMany.mockResolvedValue([
      {
        id: "evt_settle_1",
        source: "webhook",
        eventCategory: "INVOICE",
        eventType: "UPDATE",
        resourceId: "inv_settle_1",
        correlationKey: "corr_settle_1",
        payload: { resourceId: "inv_settle_1" },
      },
    ]);
    mocks.processedCreate.mockResolvedValue({ id: "processed_settle_1" });
    mocks.linkFindMany.mockResolvedValue([]);
    mocks.xeroSyncOperationFindMany.mockResolvedValue([]);
    mocks.paymentFindMany.mockResolvedValue([]);
    mocks.subscriptionFindMany.mockResolvedValue([]);
    mocks.groupSettlementFindFirst.mockResolvedValue({
      id: "settle_1",
      status: "PENDING",
    });
    mocks.applyGroupSettlementFromInvoice.mockResolvedValue({
      outcome: "settled",
      settledBookingIds: ["child_1", "child_2"],
    });
    const accountingApi = {
      getInvoice: vi.fn().mockResolvedValue({
        body: {
          invoices: [
            {
              invoiceID: "inv_settle_1",
              invoiceNumber: "INV-SETTLE-001",
              date: "2026-07-01",
              status: "PAID",
              fullyPaidOnDate: "2026-07-02",
              contact: { contactID: "contact_1" },
              payments: [],
              lineItems: [{ accountCode: "200" }],
            },
          ],
        },
      }),
    };
    mocks.getAuthenticatedXeroClient.mockResolvedValue({
      xero: { accountingApi },
      tenantId: "tenant_1",
    });

    await expect(processStoredXeroInboundEvents()).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.groupSettlementFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          xeroInvoiceId: "inv_settle_1",
          source: "INTERNET_BANKING",
        }),
      })
    );
    expect(mocks.applyGroupSettlementFromInvoice).toHaveBeenCalledWith(
      "inv_settle_1"
    );
  });

  it("does not settle a group when the matched settlement is already succeeded", async () => {
    mocks.inboundFindMany.mockResolvedValue([
      {
        id: "evt_settle_2",
        source: "webhook",
        eventCategory: "INVOICE",
        eventType: "UPDATE",
        resourceId: "inv_settle_2",
        correlationKey: "corr_settle_2",
        payload: { resourceId: "inv_settle_2" },
      },
    ]);
    mocks.processedCreate.mockResolvedValue({ id: "processed_settle_2" });
    mocks.linkFindMany.mockResolvedValue([]);
    mocks.xeroSyncOperationFindMany.mockResolvedValue([]);
    mocks.paymentFindMany.mockResolvedValue([]);
    mocks.subscriptionFindMany.mockResolvedValue([]);
    mocks.groupSettlementFindFirst.mockResolvedValue({
      id: "settle_2",
      status: "SUCCEEDED",
    });
    const accountingApi = {
      getInvoice: vi.fn().mockResolvedValue({
        body: {
          invoices: [
            {
              invoiceID: "inv_settle_2",
              invoiceNumber: "INV-SETTLE-002",
              date: "2026-07-01",
              status: "PAID",
              fullyPaidOnDate: "2026-07-02",
              contact: { contactID: "contact_1" },
              payments: [],
              lineItems: [{ accountCode: "200" }],
            },
          ],
        },
      }),
    };
    mocks.getAuthenticatedXeroClient.mockResolvedValue({
      xero: { accountingApi },
      tenantId: "tenant_1",
    });

    await expect(processStoredXeroInboundEvents()).resolves.toMatchObject({
      succeeded: 1,
      failed: 0,
    });

    expect(mocks.applyGroupSettlementFromInvoice).not.toHaveBeenCalled();
  });

  it("recovers missing supplementary invoice and payment links from the outbound operation ledger", async () => {
    mocks.inboundFindMany.mockResolvedValue([
      {
        id: "evt_2b",
        source: "webhook",
        eventCategory: "INVOICE",
        eventType: "UPDATE",
        resourceId: "inv_sup_1",
        correlationKey: "corr_2b",
        payload: { resourceId: "inv_sup_1" },
      },
    ]);
    mocks.processedCreate.mockResolvedValue({ id: "processed_2b" });
    mocks.linkFindMany.mockResolvedValueOnce([]);
    mocks.xeroSyncOperationFindMany.mockResolvedValue([
      {
        localModel: "BookingModification",
        localId: "mod_1",
      },
    ]);
    mocks.paymentFindMany.mockResolvedValue([]);
    mocks.subscriptionFindMany.mockResolvedValue([]);
    const accountingApi = {
      getInvoice: vi.fn().mockResolvedValue({
        body: {
          invoices: [
            {
              invoiceID: "inv_sup_1",
              invoiceNumber: "INV-SUP-001",
              date: "2026-04-10",
              contact: { contactID: "contact_1" },
              payments: [
                {
                  paymentID: "xpay_sup_1",
                  amount: 30,
                  invoiceNumber: "INV-SUP-001",
                  status: "PAID",
                },
              ],
              lineItems: [{ accountCode: "200" }],
            },
          ],
        },
      }),
    };
    mocks.getAuthenticatedXeroClient.mockResolvedValue({
      xero: { accountingApi },
      tenantId: "tenant_1",
    });

    await expect(processStoredXeroInboundEvents()).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.upsertXeroObjectLink).toHaveBeenCalledWith(
      expect.objectContaining({
        localModel: "BookingModification",
        localId: "mod_1",
        xeroObjectType: "INVOICE",
        xeroObjectId: "inv_sup_1",
        role: "SUPPLEMENTARY_INVOICE",
      })
    );
    expect(mocks.upsertXeroObjectLink).toHaveBeenCalledWith(
      expect.objectContaining({
        localModel: "BookingModification",
        localId: "mod_1",
        xeroObjectType: "PAYMENT",
        xeroObjectId: "xpay_sup_1",
        role: "SUPPLEMENTARY_INVOICE_PAYMENT",
        metadata: expect.objectContaining({
          invoiceId: "inv_sup_1",
          amount: 30,
          status: "PAID",
        }),
      })
    );
  });

  it("reconciles payment events into restored payment links and subscription refresh", async () => {
    mocks.inboundFindMany.mockResolvedValue([
      {
        id: "evt_3",
        source: "webhook",
        eventCategory: "PAYMENT",
        eventType: "CREATE",
        resourceId: "xpay_1",
        correlationKey: "corr_3",
        payload: { resourceId: "xpay_1" },
      },
    ]);
    mocks.processedCreate.mockResolvedValue({ id: "processed_3" });
    mocks.linkFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          localModel: "Payment",
          localId: "pay_1",
          xeroObjectType: "INVOICE",
          role: "PRIMARY_INVOICE",
        },
        {
          localModel: "MemberSubscription",
          localId: "sub_1",
          xeroObjectType: "SUBSCRIPTION",
          role: "SUBSCRIPTION_INVOICE",
        },
      ])
      .mockResolvedValueOnce([]);
    mocks.paymentFindMany.mockResolvedValue([
      {
        id: "pay_1",
        xeroInvoiceId: null,
        xeroInvoiceNumber: null,
      },
    ]);
    mocks.subscriptionFindMany.mockResolvedValue([
      {
        id: "sub_1",
        memberId: "mem_1",
        seasonYear: 2026,
      },
    ]);
    mocks.checkMembershipStatus.mockResolvedValue({
      status: "PAID",
      xeroInvoiceId: "inv_1",
    });
    const accountingApi = {
      getPayment: vi.fn().mockResolvedValue({
        body: {
          payments: [
            {
              paymentID: "xpay_1",
              amount: 123.45,
              invoiceNumber: "INV-001",
              invoice: {
                invoiceID: "inv_1",
                invoiceNumber: "INV-001",
              },
            },
          ],
        },
      }),
    };
    mocks.getAuthenticatedXeroClient.mockResolvedValue({
      xero: { accountingApi },
      tenantId: "tenant_1",
    });

    const result = await processStoredXeroInboundEvents();
    expect(result).toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.paymentUpdate).toHaveBeenCalledWith({
      where: { id: "pay_1" },
      data: {
        xeroInvoiceId: "inv_1",
        xeroInvoiceNumber: "INV-001",
      },
    });
    expect(mocks.checkMembershipStatus).toHaveBeenCalledWith("mem_1", 2026);
    expect(mocks.upsertXeroObjectLink).toHaveBeenCalledWith(
      expect.objectContaining({
        localModel: "Payment",
        localId: "pay_1",
        xeroObjectType: "PAYMENT",
        xeroObjectId: "xpay_1",
        role: "INVOICE_PAYMENT",
      })
    );
  });

  it("reconciles credit note events into canonical links, allocations, and refund payments", async () => {
    mocks.inboundFindMany.mockResolvedValue([
      {
        id: "evt_4",
        source: "webhook",
        eventCategory: "CREDIT_NOTE",
        eventType: "UPDATE",
        resourceId: "cn_1",
        correlationKey: "corr_4",
        payload: { resourceId: "cn_1" },
      },
    ]);
    mocks.processedCreate.mockResolvedValue({ id: "processed_4" });
    mocks.linkFindMany
      .mockResolvedValueOnce([
        {
          localModel: "Payment",
          localId: "pay_1",
          xeroObjectType: "CREDIT_NOTE",
          role: "REFUND_CREDIT_NOTE",
        },
      ])
      .mockResolvedValueOnce([
        {
          localId: "pay_1",
          xeroObjectId: "cn_1",
          metadata: {
            total: 50,
            status: "AUTHORISED",
          },
        },
      ])
      .mockResolvedValueOnce([]);
    mocks.paymentFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "pay_1",
          xeroRefundCreditNoteId: null,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "pay_1",
          amountCents: 10000,
          refundedAmountCents: 0,
          status: "SUCCEEDED",
        },
      ]);
    const accountingApi = {
      getCreditNote: vi.fn().mockResolvedValue({
        body: {
          creditNotes: [
            {
              creditNoteID: "cn_1",
              creditNoteNumber: "CN-001",
              total: 50,
              appliedAmount: 50,
              remainingCredit: 0,
              allocations: [
                {
                  amount: 50,
                  invoice: { invoiceID: "inv_1" },
                },
              ],
              payments: [
                {
                  paymentID: "refund_payment_1",
                  amount: 50,
                  creditNoteNumber: "CN-001",
                },
              ],
            },
          ],
        },
      }),
    };
    mocks.getAuthenticatedXeroClient.mockResolvedValue({
      xero: { accountingApi },
      tenantId: "tenant_1",
    });

    await expect(processStoredXeroInboundEvents()).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.paymentUpdate).toHaveBeenCalledWith({
      where: { id: "pay_1" },
      data: {
        xeroRefundCreditNoteId: "cn_1",
      },
    });
    expect(mocks.paymentUpdate).toHaveBeenCalledWith({
      where: { id: "pay_1" },
      data: {
        refundedAmountCents: 5000,
        status: "PARTIALLY_REFUNDED",
      },
    });
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      "op_1",
      expect.objectContaining({
        responsePayload: expect.objectContaining({
          matchedAccountCreditPayments: 0,
          matchedRefundedPayments: 1,
          allocationsUpdated: 1,
          refundPaymentsUpdated: 1,
          relatedLinksUpdated: 1,
          updatedRefundedPayments: 1,
          updatedCredits: 0,
        }),
      })
    );
  });

  it("reconciles account-credit note events into member credit Xero links", async () => {
    mocks.inboundFindMany.mockResolvedValue([
      {
        id: "evt_5",
        source: "webhook",
        eventCategory: "CREDIT_NOTE",
        eventType: "UPDATE",
        resourceId: "cn_credit_1",
        correlationKey: "corr_5",
        payload: { resourceId: "cn_credit_1" },
      },
    ]);
    mocks.processedCreate.mockResolvedValue({ id: "processed_5" });
    mocks.linkFindMany
      .mockResolvedValueOnce([
        {
          localModel: "Payment",
          localId: "pay_credit_1",
          xeroObjectType: "CREDIT_NOTE",
          role: "ACCOUNT_CREDIT_NOTE",
        },
      ])
      .mockResolvedValueOnce([
        {
          localId: "pay_credit_1",
          xeroObjectId: "cn_credit_1",
          metadata: {
            total: 97,
            status: "AUTHORISED",
          },
        },
      ])
      .mockResolvedValueOnce([]);
    mocks.paymentFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "pay_credit_1",
          bookingId: "bk123456789",
          booking: {
            memberId: "mem_credit_1",
          },
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "pay_credit_1",
          amountCents: 12000,
          refundedAmountCents: 0,
          status: "SUCCEEDED",
        },
      ]);
    mocks.memberCreditUpdateMany.mockResolvedValue({ count: 1 });
    const accountingApi = {
      getCreditNote: vi.fn().mockResolvedValue({
        body: {
          creditNotes: [
            {
              creditNoteID: "cn_credit_1",
              creditNoteNumber: "CN-AC-001",
              total: 97,
              appliedAmount: 25,
              remainingCredit: 72,
              allocations: [],
              payments: [],
            },
          ],
        },
      }),
    };
    mocks.getAuthenticatedXeroClient.mockResolvedValue({
      xero: { accountingApi },
      tenantId: "tenant_1",
    });

    const result = await processStoredXeroInboundEvents();
    expect(result).toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.memberCreditUpdateMany).toHaveBeenCalledWith({
      where: {
        memberId: "mem_credit_1",
        sourceBookingId: "bk123456789",
        amountCents: 9700,
        type: "CANCELLATION_REFUND",
        description: "Cancellation refund for booking bk123456",
        xeroCreditNoteId: null,
      },
      data: {
        xeroCreditNoteId: "cn_credit_1",
      },
    });
    expect(mocks.paymentUpdate).toHaveBeenCalledWith({
      where: { id: "pay_credit_1" },
      data: {
        refundedAmountCents: 9700,
        status: "PARTIALLY_REFUNDED",
      },
    });
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      "op_1",
      expect.objectContaining({
        responsePayload: expect.objectContaining({
          matchedAccountCreditPayments: 1,
          matchedRefundedPayments: 1,
          updatedRefundedPayments: 1,
          updatedCredits: 1,
          refundPaymentsUpdated: 0,
        }),
      })
    );
  });

  it("recovers missing account-credit payment links from member credits during credit note reconciliation", async () => {
    mocks.inboundFindMany.mockResolvedValue([
      {
        id: "evt_5a",
        source: "webhook",
        eventCategory: "CREDIT_NOTE",
        eventType: "UPDATE",
        resourceId: "cn_credit_recover_1",
        correlationKey: "corr_5a",
        payload: { resourceId: "cn_credit_recover_1" },
      },
    ]);
    mocks.processedCreate.mockResolvedValue({ id: "processed_5a" });
    mocks.linkFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mocks.memberCreditFindMany.mockResolvedValue([
      {
        sourceBookingId: "book_credit_recover_1",
      },
    ]);
    mocks.paymentFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "pay_credit_recover_1",
          bookingId: "book_credit_recover_1",
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "pay_credit_recover_1",
          bookingId: "book_credit_recover_1",
          booking: {
            memberId: "mem_credit_recover_1",
          },
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "pay_credit_recover_1",
          amountCents: 12000,
          refundedAmountCents: 0,
          status: "SUCCEEDED",
        },
      ]);
    mocks.memberCreditUpdateMany.mockResolvedValue({ count: 0 });
    const accountingApi = {
      getCreditNote: vi.fn().mockResolvedValue({
        body: {
          creditNotes: [
            {
              creditNoteID: "cn_credit_recover_1",
              creditNoteNumber: "CN-CREDIT-RECOVER-001",
              total: 97,
              appliedAmount: 0,
              remainingCredit: 97,
              allocations: [],
              payments: [],
            },
          ],
        },
      }),
    };
    mocks.getAuthenticatedXeroClient.mockResolvedValue({
      xero: { accountingApi },
      tenantId: "tenant_1",
    });

    await expect(processStoredXeroInboundEvents()).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.upsertXeroObjectLink).toHaveBeenCalledWith(
      expect.objectContaining({
        localModel: "Payment",
        localId: "pay_credit_recover_1",
        xeroObjectType: "CREDIT_NOTE",
        xeroObjectId: "cn_credit_recover_1",
        role: "ACCOUNT_CREDIT_NOTE",
      })
    );
    expect(mocks.paymentUpdate).toHaveBeenCalledWith({
      where: { id: "pay_credit_recover_1" },
      data: {
        refundedAmountCents: 9700,
        status: "PARTIALLY_REFUNDED",
      },
    });
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      "op_1",
      expect.objectContaining({
        responsePayload: expect.objectContaining({
          matchedAccountCreditPayments: 1,
          matchedRefundedPayments: 1,
          updatedRefundedPayments: 1,
        }),
      })
    );
  });

  it("reconciles modification credit note allocations into local refunded payment state", async () => {
    mocks.inboundFindMany.mockResolvedValue([
      {
        id: "evt_5b",
        source: "webhook",
        eventCategory: "CREDIT_NOTE",
        eventType: "UPDATE",
        resourceId: "cn_mod_1",
        correlationKey: "corr_5b",
        payload: { resourceId: "cn_mod_1" },
      },
    ]);
    mocks.processedCreate.mockResolvedValue({ id: "processed_5b" });
    mocks.linkFindMany
      .mockResolvedValueOnce([
        {
          localModel: "BookingModification",
          localId: "mod_1",
          xeroObjectType: "CREDIT_NOTE",
          role: "MODIFICATION_CREDIT_NOTE",
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          localId: "pay_mod_1",
          xeroObjectId: "alloc_mod_1",
          metadata: {
            creditNoteId: "cn_mod_1",
            amountCents: 2500,
          },
        },
      ]);
    mocks.paymentFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "pay_mod_1",
          xeroInvoiceId: "inv_mod_1",
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "pay_mod_1",
          amountCents: 10000,
          refundedAmountCents: 0,
          status: "SUCCEEDED",
        },
      ]);
    const accountingApi = {
      getCreditNote: vi.fn().mockResolvedValue({
        body: {
          creditNotes: [
            {
              creditNoteID: "cn_mod_1",
              creditNoteNumber: "CN-MOD-001",
              total: 25,
              appliedAmount: 25,
              remainingCredit: 0,
              allocations: [
                {
                  amount: 25,
                  invoice: { invoiceID: "inv_mod_1" },
                },
              ],
              payments: [],
            },
          ],
        },
      }),
    };
    mocks.getAuthenticatedXeroClient.mockResolvedValue({
      xero: { accountingApi },
      tenantId: "tenant_1",
    });

    await expect(processStoredXeroInboundEvents()).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.paymentUpdate).toHaveBeenCalledWith({
      where: { id: "pay_mod_1" },
      data: {
        refundedAmountCents: 2500,
        status: "PARTIALLY_REFUNDED",
      },
    });
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      "op_1",
      expect.objectContaining({
        responsePayload: expect.objectContaining({
          matchedRefundedPayments: 1,
          updatedRefundedPayments: 1,
        }),
      })
    );
  });

  it("recovers missing modification credit note links from the outbound operation ledger", async () => {
    mocks.inboundFindMany.mockResolvedValue([
      {
        id: "evt_5d",
        source: "webhook",
        eventCategory: "CREDIT_NOTE",
        eventType: "UPDATE",
        resourceId: "cn_mod_recover_1",
        correlationKey: "corr_5d",
        payload: { resourceId: "cn_mod_recover_1" },
      },
    ]);
    mocks.processedCreate.mockResolvedValue({ id: "processed_5d" });
    mocks.linkFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          localId: "pay_mod_recover_1",
          xeroObjectId: "alloc_mod_recover_1",
          metadata: {
            creditNoteId: "cn_mod_recover_1",
            amountCents: 2500,
          },
        },
      ]);
    mocks.xeroSyncOperationFindMany.mockResolvedValue([
      {
        localModel: "BookingModification",
        localId: "mod_recover_1",
      },
    ]);
    mocks.paymentFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "pay_mod_recover_1",
          xeroInvoiceId: "inv_mod_recover_1",
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "pay_mod_recover_1",
          amountCents: 10000,
          refundedAmountCents: 0,
          status: "SUCCEEDED",
        },
      ]);
    const accountingApi = {
      getCreditNote: vi.fn().mockResolvedValue({
        body: {
          creditNotes: [
            {
              creditNoteID: "cn_mod_recover_1",
              creditNoteNumber: "CN-MOD-RECOVER-001",
              total: 25,
              appliedAmount: 25,
              remainingCredit: 0,
              allocations: [
                {
                  amount: 25,
                  invoice: { invoiceID: "inv_mod_recover_1" },
                },
              ],
              payments: [],
            },
          ],
        },
      }),
    };
    mocks.getAuthenticatedXeroClient.mockResolvedValue({
      xero: { accountingApi },
      tenantId: "tenant_1",
    });

    await expect(processStoredXeroInboundEvents()).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.upsertXeroObjectLink).toHaveBeenCalledWith(
      expect.objectContaining({
        localModel: "BookingModification",
        localId: "mod_recover_1",
        xeroObjectType: "CREDIT_NOTE",
        xeroObjectId: "cn_mod_recover_1",
        role: "MODIFICATION_CREDIT_NOTE",
      })
    );
    expect(mocks.upsertXeroObjectLink).toHaveBeenCalledWith(
      expect.objectContaining({
        localModel: "BookingModification",
        localId: "mod_recover_1",
        xeroObjectType: "ALLOCATION",
        role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
      })
    );
    expect(mocks.paymentUpdate).toHaveBeenCalledWith({
      where: { id: "pay_mod_recover_1" },
      data: {
        refundedAmountCents: 2500,
        status: "PARTIALLY_REFUNDED",
      },
    });
  });

  it("clears refunded payment state when a modification credit note is voided", async () => {
    mocks.inboundFindMany.mockResolvedValue([
      {
        id: "evt_5c",
        source: "webhook",
        eventCategory: "CREDIT_NOTE",
        eventType: "UPDATE",
        resourceId: "cn_mod_void_1",
        correlationKey: "corr_5c",
        payload: { resourceId: "cn_mod_void_1" },
      },
    ]);
    mocks.processedCreate.mockResolvedValue({ id: "processed_5c" });
    mocks.linkFindMany
      .mockResolvedValueOnce([
        {
          localModel: "BookingModification",
          localId: "mod_1",
          xeroObjectType: "CREDIT_NOTE",
          role: "MODIFICATION_CREDIT_NOTE",
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mocks.paymentFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "pay_mod_void_1",
          xeroInvoiceId: "inv_mod_void_1",
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "pay_mod_void_1",
          amountCents: 10000,
          refundedAmountCents: 2500,
          status: "PARTIALLY_REFUNDED",
        },
      ]);
    const accountingApi = {
      getCreditNote: vi.fn().mockResolvedValue({
        body: {
          creditNotes: [
            {
              creditNoteID: "cn_mod_void_1",
              creditNoteNumber: "CN-MOD-VOID-001",
              status: "VOIDED",
              total: 25,
              appliedAmount: 25,
              remainingCredit: 0,
              allocations: [
                {
                  amount: 25,
                  invoice: { invoiceID: "inv_mod_void_1" },
                },
              ],
              payments: [],
            },
          ],
        },
      }),
    };
    mocks.getAuthenticatedXeroClient.mockResolvedValue({
      xero: { accountingApi },
      tenantId: "tenant_1",
    });

    await expect(processStoredXeroInboundEvents()).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.paymentUpdate).toHaveBeenCalledWith({
      where: { id: "pay_mod_void_1" },
      data: {
        refundedAmountCents: 0,
        status: "SUCCEEDED",
      },
    });
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      "op_1",
      expect.objectContaining({
        responsePayload: expect.objectContaining({
          matchedRefundedPayments: 1,
          updatedRefundedPayments: 1,
        }),
      })
    );
  });

  it("reconciles account-credit note allocations into local applied-credit ledger state", async () => {
    mocks.inboundFindMany.mockResolvedValue([
      {
        id: "evt_6",
        source: "webhook",
        eventCategory: "CREDIT_NOTE",
        eventType: "UPDATE",
        resourceId: "cn_credit_alloc_1",
        correlationKey: "corr_6",
        payload: { resourceId: "cn_credit_alloc_1" },
      },
    ]);
    mocks.processedCreate.mockResolvedValue({ id: "processed_6" });
    mocks.linkFindMany
      .mockResolvedValueOnce([
        {
          localModel: "Payment",
          localId: "pay_credit_source_1",
          xeroObjectType: "CREDIT_NOTE",
          role: "ACCOUNT_CREDIT_NOTE",
        },
      ])
      .mockResolvedValueOnce([
        {
          localId: "pay_credit_source_1",
          xeroObjectId: "cn_credit_alloc_1",
          metadata: {
            total: 97,
            status: "AUTHORISED",
          },
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          localModel: "Payment",
          localId: "pay_booking_1",
          xeroObjectType: "INVOICE",
          role: "PRIMARY_INVOICE",
        },
      ]);
    mocks.paymentFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "pay_credit_source_1",
          bookingId: "bk123456789",
          booking: {
            memberId: "mem_credit_1",
          },
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "pay_credit_source_1",
          amountCents: 12000,
          refundedAmountCents: 0,
          status: "SUCCEEDED",
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "pay_booking_1",
          bookingId: "bk234567890",
          creditAppliedCents: 0,
          booking: {
            memberId: "mem_credit_1",
          },
        },
      ]);
    mocks.memberCreditAggregate.mockResolvedValue({
      _sum: {
        amountCents: -2500,
      },
    });
    const accountingApi = {
      getCreditNote: vi.fn().mockResolvedValue({
        body: {
          creditNotes: [
            {
              creditNoteID: "cn_credit_alloc_1",
              creditNoteNumber: "CN-AC-ALLOC-001",
              total: 97,
              appliedAmount: 25,
              remainingCredit: 72,
              allocations: [
                {
                  amount: 25,
                  invoice: { invoiceID: "inv_booking_1" },
                },
              ],
              payments: [],
            },
          ],
        },
      }),
    };
    mocks.getAuthenticatedXeroClient.mockResolvedValue({
      xero: { accountingApi },
      tenantId: "tenant_1",
    });

    const result = await processStoredXeroInboundEvents();
    expect(result).toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.memberCreditCreate).toHaveBeenCalledWith({
      data: {
        memberId: "mem_credit_1",
        amountCents: -2500,
        type: "BOOKING_APPLIED",
        description: "Applied to booking bk234567",
        appliedToBookingId: "bk234567890",
        xeroCreditNoteId: "cn_credit_alloc_1",
      },
    });
    expect(mocks.paymentUpdate).toHaveBeenCalledWith({
      where: { id: "pay_booking_1" },
      data: {
        creditAppliedCents: 2500,
      },
    });
    expect(mocks.paymentUpdate).toHaveBeenCalledWith({
      where: { id: "pay_credit_source_1" },
      data: {
        refundedAmountCents: 9700,
        status: "PARTIALLY_REFUNDED",
      },
    });
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      "op_1",
      expect.objectContaining({
        responsePayload: expect.objectContaining({
          matchedRefundedPayments: 1,
          updatedRefundedPayments: 1,
          matchedAllocatedPayments: 1,
          createdAppliedCredits: 1,
          updatedAppliedCredits: 0,
          updatedAppliedPayments: 1,
          skippedAppliedCreditAllocations: 0,
        }),
      })
    );
  });
});

describe("runXeroInboundReconciliationCycle", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.inboundUpdateMany.mockResolvedValue({ count: 1 });
    mocks.xeroSyncOperationFindMany.mockResolvedValue([]);
    mocks.processedCreate.mockRejectedValue({ code: "P2002" });
    mocks.syncContactsFromXero.mockResolvedValue({
      created: [],
      updated: [{ memberId: "mem_1" }],
      skippedNoChanges: 1,
      skippedNoEmail: [],
      skippedOther: [],
      errors: [],
      total: 2,
    });
    mocks.refreshAllMembershipStatuses.mockResolvedValue({
      seasonYear: 2026,
      cursorFrom: "2026-04-14T00:00:00.000Z",
      cursorTo: "2026-04-14T00:05:00.000Z",
      changedInvoices: 1,
      changedInvoiceIds: [],
      affectedMembers: 1,
      checked: 1,
      updated: 1,
      errors: 0,
      errorDetails: [],
    });
  });

  it("drains multiple inbound batches and runs the membership cursor reconcile", async () => {
    mocks.inboundFindMany
      .mockResolvedValueOnce([
        {
          id: "evt_1",
          source: "webhook",
          eventCategory: "CONTACT",
          eventType: "UPDATE",
          resourceId: "contact_1",
          correlationKey: "corr_1",
          payload: {},
        },
      ])
      .mockResolvedValueOnce([]);
    mocks.xeroSyncCursorFindUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        cursorDateTime: new Date("2026-04-14T00:04:00.000Z"),
      })
      .mockResolvedValueOnce(null);

    await expect(
      runXeroInboundReconciliationCycle({
        batchSize: 1,
        maxBatches: 3,
      })
    ).resolves.toEqual({
      inbound: {
        batches: 2,
        found: 1,
        processed: 1,
        succeeded: 0,
        failed: 0,
        skipped: 1,
      },
      contactReconciliation: {
        cursorFrom: null,
        cursorTo: "2026-04-14T00:04:00.000Z",
        total: 2,
        created: 0,
        updated: 1,
        skippedNoChanges: 1,
        skippedNoEmail: 0,
        skippedOther: 0,
        errors: 0,
      },
      membershipReconciliation: {
        seasonYear: 2026,
        cursorFrom: "2026-04-14T00:00:00.000Z",
        cursorTo: "2026-04-14T00:05:00.000Z",
        changedInvoices: 1,
        changedInvoiceIds: [],
        affectedMembers: 1,
        checked: 1,
        updated: 1,
        errors: 0,
        errorDetails: [],
      },
      invoiceReconciliation: {
        processed: 0,
        succeeded: 0,
        failed: 0,
        errorDetails: [],
        skipped: true,
        reason:
          "No changed membership invoices required invoice-linked reconciliation.",
      },
    });

    expect(mocks.syncContactsFromXero).toHaveBeenCalledTimes(1);
    expect(mocks.refreshAllMembershipStatuses).toHaveBeenCalledWith(2026);
  });

  it("skips duplicate contact and membership cursor refreshes when the cursors are still fresh", async () => {
    mocks.inboundFindMany.mockResolvedValue([]);
    mocks.xeroSyncCursorFindUnique
      .mockResolvedValueOnce({
        cursorDateTime: new Date("2026-04-14T00:10:00.000Z"),
        lastSuccessfulSyncAt: new Date(),
      })
      .mockResolvedValueOnce({
        cursorDateTime: new Date("2026-04-14T00:00:00.000Z"),
        lastSuccessfulSyncAt: new Date(),
      });

    await expect(
      runXeroInboundReconciliationCycle({
        seasonYear: 2026,
      })
    ).resolves.toEqual({
      inbound: {
        batches: 1,
        found: 0,
        processed: 0,
        succeeded: 0,
        failed: 0,
        skipped: 0,
      },
      contactReconciliation: {
        cursorFrom: "2026-04-14T00:10:00.000Z",
        cursorTo: null,
        total: 0,
        created: 0,
        updated: 0,
        skippedNoChanges: 0,
        skippedNoEmail: 0,
        skippedOther: 0,
        errors: 0,
        skipped: true,
        reason:
          "Contact cursor was refreshed recently; skipping duplicate incremental reconcile.",
      },
      membershipReconciliation: {
        seasonYear: 2026,
        cursorFrom: "2026-04-14T00:00:00.000Z",
        cursorTo: null,
        changedInvoices: 0,
        changedInvoiceIds: [],
        affectedMembers: 0,
        checked: 0,
        updated: 0,
        errors: 0,
        errorDetails: [],
        skipped: true,
        reason:
          "Membership cursor was refreshed recently; skipping duplicate incremental reconcile.",
      },
      invoiceReconciliation: {
        processed: 0,
        succeeded: 0,
        failed: 0,
        errorDetails: [],
        skipped: true,
        reason:
          "No changed membership invoices required invoice-linked reconciliation.",
      },
    });

    expect(mocks.syncContactsFromXero).not.toHaveBeenCalled();
    expect(mocks.refreshAllMembershipStatuses).not.toHaveBeenCalled();
  });

  it("reconciles changed membership invoices into linked invoice metadata", async () => {
    mocks.inboundFindMany.mockResolvedValue([]);
    mocks.xeroSyncCursorFindUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        cursorDateTime: new Date("2026-04-14T00:04:00.000Z"),
      })
      .mockResolvedValueOnce(null);
    mocks.refreshAllMembershipStatuses.mockResolvedValue({
      seasonYear: 2026,
      cursorFrom: "2026-04-14T00:00:00.000Z",
      cursorTo: "2026-04-14T00:05:00.000Z",
      changedInvoices: 1,
      changedInvoiceIds: ["inv_1"],
      affectedMembers: 1,
      checked: 1,
      updated: 1,
      errors: 0,
      errorDetails: [],
    });
    mocks.linkFindMany
      .mockResolvedValueOnce([
        {
          localModel: "Payment",
          localId: "pay_1",
          xeroObjectType: "INVOICE",
          role: "PRIMARY_INVOICE",
        },
      ])
      .mockResolvedValueOnce([]);
    mocks.paymentFindMany.mockResolvedValue([
      {
        id: "pay_1",
        xeroInvoiceId: null,
        xeroInvoiceNumber: null,
      },
    ]);
    const accountingApi = {
      getInvoice: vi.fn().mockResolvedValue({
        body: {
          invoices: [
            {
              invoiceID: "inv_1",
              invoiceNumber: "INV-001",
              date: "2026-04-10",
              contact: { contactID: "contact_1" },
              lineItems: [{ accountCode: "203" }],
            },
          ],
        },
      }),
    };
    mocks.getAuthenticatedXeroClient.mockResolvedValue({
      xero: { accountingApi },
      tenantId: "tenant_1",
    });

    await expect(
      runXeroInboundReconciliationCycle({
        batchSize: 1,
        maxBatches: 1,
      })
    ).resolves.toEqual({
      inbound: {
        batches: 1,
        found: 0,
        processed: 0,
        succeeded: 0,
        failed: 0,
        skipped: 0,
      },
      contactReconciliation: {
        cursorFrom: null,
        cursorTo: "2026-04-14T00:04:00.000Z",
        total: 2,
        created: 0,
        updated: 1,
        skippedNoChanges: 1,
        skippedNoEmail: 0,
        skippedOther: 0,
        errors: 0,
      },
      membershipReconciliation: {
        seasonYear: 2026,
        cursorFrom: "2026-04-14T00:00:00.000Z",
        cursorTo: "2026-04-14T00:05:00.000Z",
        changedInvoices: 1,
        changedInvoiceIds: ["inv_1"],
        affectedMembers: 1,
        checked: 1,
        updated: 1,
        errors: 0,
        errorDetails: [],
      },
      invoiceReconciliation: {
        processed: 1,
        succeeded: 1,
        failed: 0,
        errorDetails: [],
      },
    });

    expect(mocks.paymentUpdate).toHaveBeenCalledWith({
      where: { id: "pay_1" },
      data: {
        xeroInvoiceId: "inv_1",
        xeroInvoiceNumber: "INV-001",
      },
    });
    expect(mocks.checkMembershipStatus).not.toHaveBeenCalled();
  });
});

describe("replayStoredXeroInboundEvent", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.inboundUpdateMany.mockResolvedValue({ count: 1 });
    mocks.xeroSyncOperationFindMany.mockResolvedValue([]);
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        processedWebhookEvent: {
          deleteMany: mocks.processedDeleteMany,
        },
        xeroInboundEvent: {
          update: mocks.inboundUpdate,
        },
      })
    );
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_replay" });
  });

  it("replays a stored inbound event and clears the previous dedupe claim", async () => {
    const processedAt = new Date("2026-04-14T08:00:00Z");
    mocks.inboundFindUnique
      .mockResolvedValueOnce({
        id: "evt_replay",
        correlationKey: "corr_replay",
        status: "FAILED",
        errorMessage: "old failure",
        processedAt: null,
      })
      .mockResolvedValueOnce({
        id: "evt_replay",
        status: "PROCESSED",
        errorMessage: null,
        processedAt,
      });
    mocks.inboundFindMany.mockResolvedValue([
      {
        id: "evt_replay",
        source: "webhook",
        eventCategory: "PAYMENT",
        eventType: "UPDATE",
        resourceId: "pay_1",
        correlationKey: "corr_replay",
        payload: { resourceId: "pay_1" },
      },
    ]);
    mocks.processedCreate.mockResolvedValue({ id: "processed_replay" });
    mocks.linkFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          localModel: "Payment",
          localId: "pay_1",
          xeroObjectType: "INVOICE",
          role: "PRIMARY_INVOICE",
        },
      ])
      .mockResolvedValueOnce([]);
    mocks.paymentFindMany.mockResolvedValue([
      {
        id: "pay_1",
        xeroInvoiceId: null,
        xeroInvoiceNumber: null,
      },
    ]);
    mocks.subscriptionFindMany.mockResolvedValue([]);
    const accountingApi = {
      getPayment: vi.fn().mockResolvedValue({
        body: {
          payments: [
            {
              paymentID: "pay_1",
              amount: 42,
              invoiceNumber: "INV-042",
              invoice: {
                invoiceID: "inv_42",
                invoiceNumber: "INV-042",
              },
            },
          ],
        },
      }),
    };
    mocks.getAuthenticatedXeroClient.mockResolvedValue({
      xero: { accountingApi },
      tenantId: "tenant_1",
    });

    await expect(replayStoredXeroInboundEvent("evt_replay")).resolves.toEqual({
      result: {
        found: 1,
        processed: 1,
        succeeded: 1,
        failed: 0,
        skipped: 0,
      },
      event: {
        id: "evt_replay",
        status: "PROCESSED",
        errorMessage: null,
        processedAt,
      },
    });

    expect(mocks.processedDeleteMany).toHaveBeenCalledWith({
      where: {
        eventId: "corr_replay",
        source: "xero",
      },
    });
    expect(mocks.inboundUpdate).toHaveBeenCalledWith({
      where: {
        id: "evt_replay",
      },
      data: {
        status: "RECEIVED",
        errorMessage: null,
        processedAt: null,
      },
    });
  });

  it("rejects replay when the event is already processing", async () => {
    mocks.inboundFindUnique.mockResolvedValue({
      id: "evt_processing",
      correlationKey: "corr_processing",
      status: "PROCESSING",
      errorMessage: null,
      processedAt: null,
    });

    await expect(replayStoredXeroInboundEvent("evt_processing")).rejects.toMatchObject({
      name: "XeroInboundReplayError",
      message: "This inbound event is already being processed.",
      status: 409,
    } satisfies Partial<XeroInboundReplayError>);

    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("allows an operator to take over a stale PROCESSING event (issue #819/#815)", async () => {
    // Claimed PROCESSING 30 minutes ago, well past the staleness threshold, so
    // the worker is presumed dead and the row should be recoverable.
    const staleClaimedAt = new Date(Date.now() - 30 * 60_000);
    mocks.inboundFindUnique
      .mockResolvedValueOnce({
        id: "evt_stale",
        correlationKey: "corr_stale",
        status: "PROCESSING",
        errorMessage: null,
        processedAt: null,
        updatedAt: staleClaimedAt,
      })
      .mockResolvedValueOnce({
        id: "evt_stale",
        status: "RECEIVED",
        errorMessage: null,
        processedAt: null,
      });
    // Nothing is reprocessed in this focused test; we only assert the takeover
    // path resets the row instead of refusing it with a 409.
    mocks.inboundFindMany.mockResolvedValue([]);

    await expect(
      replayStoredXeroInboundEvent("evt_stale"),
    ).resolves.toMatchObject({
      event: { id: "evt_stale", status: "RECEIVED" },
    });

    expect(mocks.transaction).toHaveBeenCalled();
    expect(mocks.inboundUpdate).toHaveBeenCalledWith({
      where: { id: "evt_stale" },
      data: {
        status: "RECEIVED",
        errorMessage: null,
        processedAt: null,
      },
    });
  });
});
