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
  memberFindUnique: vi.fn(),
  memberUpdate: vi.fn(),
  memberCreditAggregate: vi.fn(),
  memberCreditCreate: vi.fn(),
  memberCreditFindMany: vi.fn(),
  memberCreditUpdate: vi.fn(),
  memberCreditUpdateMany: vi.fn(),
  memberCreditNoteAllocationAggregate: vi.fn(),
  memberCreditNoteAllocationFindMany: vi.fn(),
  linkFindMany: vi.fn(),
  auditLogCreate: vi.fn(),
  bookingFindMany: vi.fn(),
  bookingUpdate: vi.fn(),
  // #2265 (#2319): the guarded claim that clears a stale credit election on a
  // terminal flip.
  bookingUpdateMany: vi.fn(),
  // Split-parent describe helper (getProvisionalNonMemberChildSummary) reads the
  // provisional non-member child via prisma.booking.findFirst; default null =
  // not a split parent.
  bookingFindFirst: vi.fn().mockResolvedValue(null),
  bookingModificationFindMany: vi.fn(),
  paymentFindMany: vi.fn(),
  paymentFindUnique: vi.fn(),
  paymentUpdate: vi.fn(),
  paymentUpdateMany: vi.fn(),
  paymentTransactionUpdateMany: vi.fn(),
  paymentTransactionCreate: vi.fn(),
  memberCreditFindFirst: vi.fn(),
  reconcileBedAllocations: vi.fn(),
  // #2576 §9: an inbound Xero PAID is a confirmation, so it records the bounded
  // hosting re-evaluation with the PAID claim and drains it after the commit.
  enqueueOwnHostingCoverage: vi.fn(),
  settleHostingCoverage: vi.fn(),
  recordBookingEvent: vi.fn(),
  txExecuteRaw: vi.fn(),
  subscriptionFindMany: vi.fn(),
  groupSettlementFindFirst: vi.fn(),
  groupSettlementFindUnique: vi.fn(),
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
  // #2109 FIX-3: the inbound reconciler now gates the "looks like a
  // subscription" decision on a STRONG match via hasStrongSubscriptionInvoiceMatch.
  hasStrongSubscriptionInvoiceMatch: vi.fn(),
  buildSubscriptionInvoiceMatchOptions: vi.fn(),
  getAccountMapping: vi.fn(),
  lodgeFindFirst: vi.fn(),
  acquireLodgeCapacityLock: vi.fn(),
  checkCapacity: vi.fn(),
  processWaitlist: vi.fn(),
  txLinkFindFirst: vi.fn(),
  txOperationFindFirst: vi.fn(),
  txOperationFindMany: vi.fn(),
  repairLegacyAppliedCreditNoteAllocationsForBooking: vi.fn(),
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
      findUnique: mocks.memberFindUnique,
      update: mocks.memberUpdate,
    },
    memberCredit: {
      aggregate: mocks.memberCreditAggregate,
      create: mocks.memberCreditCreate,
      findMany: mocks.memberCreditFindMany,
      update: mocks.memberCreditUpdate,
      updateMany: mocks.memberCreditUpdateMany,
    },
    memberCreditNoteAllocation: {
      findMany: mocks.memberCreditNoteAllocationFindMany,
    },
    xeroObjectLink: {
      findMany: mocks.linkFindMany,
    },
    auditLog: {
      create: mocks.auditLogCreate,
    },
    booking: {
      findMany: mocks.bookingFindMany,
      findFirst: mocks.bookingFindFirst,
      update: mocks.bookingUpdate,
      updateMany: mocks.bookingUpdateMany,
    },
    bookingModification: {
      findMany: mocks.bookingModificationFindMany,
    },
    payment: {
      findMany: mocks.paymentFindMany,
      update: mocks.paymentUpdate,
      updateMany: mocks.paymentUpdateMany,
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
      findUnique: mocks.groupSettlementFindUnique,
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

vi.mock("@/lib/xero-applied-credit-allocation-repair", () => ({
  repairLegacyAppliedCreditNoteAllocationsForBooking:
    mocks.repairLegacyAppliedCreditNoteAllocationsForBooking,
}));

vi.mock("@/lib/email", () => ({
  sendBookingConfirmedEmail: vi.fn().mockResolvedValue(undefined),
  sendBookingCancelledEmail: vi.fn().mockResolvedValue(undefined),
  sendAdminPaymentFailureAlert: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/capacity", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/capacity");

  return {
    ...actual,
    acquireLodgeCapacityLock: mocks.acquireLodgeCapacityLock,
    checkCapacityForGuestRanges: mocks.checkCapacity,
  };
});

vi.mock("@/lib/waitlist", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/waitlist");

  return {
    ...actual,
    processWaitlistForDates: mocks.processWaitlist,
  };
});

vi.mock("@/lib/group-settlement", () => ({
  applyGroupSettlementSucceededFromInvoice: mocks.applyGroupSettlementFromInvoice,
}));

// #2576 §9. Mocked at the module boundary like the bed-allocation and group-settlement
// collaborators above. The real seam reads the booking and the lodge policy through the
// PAID transaction's client, and this suite drives that transaction with a fake — so
// without these the enqueue throws, the whole PAID transition rolls back, and the
// inbound event lands on the FAILED retry backoff. That is the CORRECT production
// behaviour (§8 requires the obligation to commit WITH the transition, the transition is
// idempotent, and a deferred retry is louder than a silently skipped obligation), which
// is why the fix is here in the fixture rather than by making the enqueue best-effort.
vi.mock("@/lib/adult-member-hosting-review", () => ({
  enqueueOwnHostingCoverageReevaluation: mocks.enqueueOwnHostingCoverage,
}));

vi.mock("@/lib/adult-member-hosting-coverage-drain", () => ({
  settleHostingCoverageAfterCommit: mocks.settleHostingCoverage,
}));

vi.mock("@/lib/bed-allocation-lifecycle", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/bed-allocation-lifecycle");

  return {
    ...actual,
    reconcileBedAllocationsForBooking: mocks.reconcileBedAllocations,
    reconcileBedAllocationsForBookingWithLodgeLockHeld:
      mocks.reconcileBedAllocations,
  };
});

vi.mock("@/lib/booking-events", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/booking-events");

  return {
    ...actual,
    recordBookingEvent: mocks.recordBookingEvent,
  };
});

vi.mock("@/lib/xero-sync", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/xero-sync");

  return {
    ...actual,
    startXeroSyncOperation: mocks.startXeroSyncOperation,
    completeXeroSyncOperation: mocks.completeXeroSyncOperation,
    failXeroSyncOperation: mocks.failXeroSyncOperation,
    upsertXeroObjectLink: mocks.upsertXeroObjectLink,
  };
});

vi.mock("@/lib/xero-links", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/xero-links");

  return {
    ...actual,
    buildXeroContactUrl: (id: string) => `https://xero.test/contact/${id}`,
    buildXeroInvoiceUrl: (id: string) => `https://xero.test/invoice/${id}`,
  };
});

vi.mock("@/lib/xero", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/xero");

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

// #1208: xero-inbound-reconciliation now imports these from the source domain
// modules directly (not the @/lib/xero facade), so the doubles are attached to
// those modules. The (now-inert) facade mock above is left as-is; real
// callXeroApi / XeroDailyLimitError from xero-api-client are preserved.
vi.mock("@/lib/xero-api-client", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/xero-api-client");

  return {
    ...actual,
    getAuthenticatedXeroClient: mocks.getAuthenticatedXeroClient,
  };
});

vi.mock("@/lib/xero-membership-sync", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/xero-membership-sync");

  return {
    ...actual,
    checkMembershipStatus: mocks.checkMembershipStatus,
    refreshAllMembershipStatuses: mocks.refreshAllMembershipStatuses,
    // #2109 FIX-3: the inbound reconciler resolves match options then gates on a
    // STRONG match. Both are mocked; the default (set in beforeEach) mirrors the
    // legacy account-203 / text detection, and the FIX-3 tests swap in the REAL
    // hasStrongSubscriptionInvoiceMatch with controlled options to exercise the
    // union-only gate.
    buildSubscriptionInvoiceMatchOptions: mocks.buildSubscriptionInvoiceMatchOptions,
    hasStrongSubscriptionInvoiceMatch: mocks.hasStrongSubscriptionInvoiceMatch,
  };
});

vi.mock("@/lib/xero-contact-cache", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/xero-contact-cache");

  return {
    ...actual,
    refreshXeroContactCachesFromContact: mocks.refreshXeroContactCachesFromContact,
  };
});

vi.mock("@/lib/xero-bulk-contact-sync", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/xero-bulk-contact-sync");

  return {
    ...actual,
    syncContactsFromXero: mocks.syncContactsFromXero,
  };
});

import {
  processStoredXeroInboundEvents,
  runXeroInboundReconciliationCycle,
  replayStoredXeroInboundEvent,
  XeroInboundReplayError,
} from "@/lib/xero-inbound-reconciliation";
import {
  sendAdminPaymentFailureAlert,
  sendBookingCancelledEmail,
  sendBookingConfirmedEmail,
} from "@/lib/email";
import logger from "@/lib/logger";

describe("processStoredXeroInboundEvents", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // #2262: sendBookingConfirmedEmail now RETURNS its send outcome so the
    // manual mark-paid path can report an honest receipt. This suite only cares
    // that it was called, so a benign "sent" stub keeps the mock type-correct.
    vi.mocked(sendBookingConfirmedEmail).mockResolvedValue({
      status: "sent",
    } as Awaited<ReturnType<typeof sendBookingConfirmedEmail>>);
    vi.mocked(sendBookingCancelledEmail).mockResolvedValue(undefined);
    vi.mocked(sendAdminPaymentFailureAlert).mockResolvedValue(undefined);
    mocks.checkCapacity.mockResolvedValue({ available: true });
    mocks.processWaitlist.mockResolvedValue(undefined);
    mocks.txLinkFindFirst.mockResolvedValue(null);
    mocks.txOperationFindFirst.mockResolvedValue(null);
    mocks.txOperationFindMany.mockResolvedValue([]);
    mocks.memberCreditNoteAllocationAggregate.mockResolvedValue({
      _sum: { amountCents: 0 },
    });
    mocks.memberCreditNoteAllocationFindMany.mockResolvedValue([]);
    mocks.inboundUpdateMany.mockResolvedValue({ count: 1 });
    mocks.xeroSyncOperationFindMany.mockResolvedValue([]);
    mocks.xeroSyncCursorFindUnique.mockResolvedValue(null);
    mocks.lodgeFindFirst.mockResolvedValue({ id: "lodge-1" });
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
        $executeRaw: mocks.txExecuteRaw,
        $queryRaw: mocks.txExecuteRaw,
        lodge: {
          findFirst: mocks.lodgeFindFirst,
        },
        processedWebhookEvent: {
          deleteMany: mocks.processedDeleteMany,
        },
        xeroInboundEvent: {
          update: mocks.inboundUpdate,
        },
        payment: {
          findUnique: mocks.paymentFindUnique,
          update: mocks.paymentUpdate,
        },
        paymentTransaction: {
          updateMany: mocks.paymentTransactionUpdateMany,
          create: mocks.paymentTransactionCreate,
        },
        booking: {
          update: mocks.bookingUpdate,
          updateMany: mocks.bookingUpdateMany,
        },
        memberCredit: {
          findFirst: mocks.memberCreditFindFirst,
          findMany: mocks.memberCreditFindMany,
          create: mocks.memberCreditCreate,
          update: mocks.memberCreditUpdate,
          updateMany: mocks.memberCreditUpdateMany,
          aggregate: mocks.memberCreditAggregate,
        },
        memberCreditNoteAllocation: {
          aggregate: mocks.memberCreditNoteAllocationAggregate,
        },
        xeroSyncOperation: {
          findMany: mocks.txOperationFindMany,
        },
        member: {
          findUnique: mocks.memberFindUnique,
          update: mocks.memberUpdate,
        },
      })
    );
    mocks.getAccountMapping.mockResolvedValue("203");
    // #2109 FIX-3 defaults: options resolve to the single-code (off) set, and
    // the strong-match gate mirrors the legacy account-203 / text detection so
    // every existing invoice test keeps its behaviour.
    mocks.buildSubscriptionInvoiceMatchOptions.mockResolvedValue({
      accountCode: "203",
      itemCodes: [],
      primaryItemCode: null,
      textFallbackEnabled: true,
    });
    mocks.hasStrongSubscriptionInvoiceMatch.mockImplementation(
      (
        invoices: Array<{
          lineItems?: Array<{ accountCode?: string }>;
          reference?: string;
        }>,
      ) =>
        invoices.some(
          (invoice) =>
            invoice.lineItems?.some(
              (lineItem) => lineItem.accountCode === "203",
            ) ||
            (invoice.reference ?? "")
              .toLowerCase()
              .includes("annual member subscription"),
        ),
    );
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
    mocks.linkFindMany.mockResolvedValue([]);
    mocks.memberCreditUpdate.mockResolvedValue({ id: "credit_1" });
    mocks.memberCreditUpdateMany.mockResolvedValue({ count: 0 });
    mocks.auditLogCreate.mockResolvedValue({});
    mocks.bookingFindMany.mockResolvedValue([]);
    mocks.bookingUpdate.mockResolvedValue({});
    mocks.bookingUpdateMany.mockResolvedValue({ count: 1 });
    mocks.bookingModificationFindMany.mockResolvedValue([]);
    mocks.paymentFindMany.mockResolvedValue([]);
    mocks.paymentFindUnique.mockResolvedValue(null);
    mocks.paymentUpdate.mockResolvedValue({});
    mocks.paymentUpdateMany.mockResolvedValue({ count: 0 });
    mocks.paymentTransactionUpdateMany.mockResolvedValue({ count: 1 });
    mocks.paymentTransactionCreate.mockResolvedValue({});
    mocks.memberCreditFindFirst.mockResolvedValue(null);
    mocks.reconcileBedAllocations.mockResolvedValue(undefined);
    mocks.acquireLodgeCapacityLock.mockResolvedValue(undefined);
    mocks.recordBookingEvent.mockResolvedValue(undefined);
    mocks.txExecuteRaw.mockResolvedValue(1);
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
    mocks.memberFindUnique.mockResolvedValue({
      id: "mem_1",
      email: "member@example.com",
      passwordHash: "not-deleted",
      xeroContactId: null,
      dateOfBirth: null,
      joinedDate: null,
      phoneNumber: null,
      streetAddressLine1: null,
      postalAddressLine1: null,
    });
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
      select: { id: true },
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
      }),
      expect.objectContaining({ store: expect.any(Object) }),
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

  // #2109 FIX-3: a member-less invoice matched ONLY via a union-only
  // fee-schedule code (no account-203, no primary/fallback code, no text match)
  // must NOT be treated as a subscription — so it writes no SUBSCRIPTION_INVOICE
  // audit rows and triggers no per-member checkMembershipStatus refresh. Uses
  // the REAL hasStrongSubscriptionInvoiceMatch with union options.
  it("does not treat a union-only inbound invoice as a subscription (no audit rows, no member refresh)", async () => {
    const { hasStrongSubscriptionInvoiceMatch } = (await vi.importActual("@/lib/xero-membership-sync")) as typeof import("@/lib/xero-membership-sync");
    mocks.hasStrongSubscriptionInvoiceMatch.mockImplementation(
      hasStrongSubscriptionInvoiceMatch,
    );
    mocks.buildSubscriptionInvoiceMatchOptions.mockResolvedValue({
      accountCode: "203",
      itemCodes: ["FULL-ADULT", "SUBS"],
      primaryItemCode: "SUBS",
      textFallbackEnabled: false,
    });

    mocks.inboundFindMany.mockResolvedValue([
      {
        id: "evt_union",
        source: "webhook",
        eventCategory: "INVOICE",
        eventType: "UPDATE",
        resourceId: "inv_union",
        correlationKey: "corr_union",
        payload: { resourceId: "inv_union" },
      },
    ]);
    mocks.processedCreate.mockResolvedValue({ id: "processed_union" });
    mocks.linkFindMany.mockResolvedValue([]);
    mocks.paymentFindMany.mockResolvedValue([]);
    mocks.memberFindMany.mockResolvedValue([]);
    const accountingApi = {
      getInvoice: vi.fn().mockResolvedValue({
        body: {
          invoices: [
            {
              invoiceID: "inv_union",
              invoiceNumber: "INV-UNION",
              date: "2026-04-10",
              status: "AUTHORISED",
              reference: "Hut booking",
              contact: { contactID: "contact_1" },
              // Union-only: a shared fee-schedule/hut code, no account-203 or
              // primary/fallback code, no subscription text.
              lineItems: [{ accountCode: "200", itemCode: "FULL-ADULT" }],
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

    expect(mocks.checkMembershipStatus).not.toHaveBeenCalled();
    expect(mocks.auditLogCreate).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "xero.subscription.reconciled" }),
      }),
    );
  });

  // #2109 FIX-3: an account-203 invoice IS a strong match, so it still writes the
  // SUBSCRIPTION_INVOICE audit link and refreshes the member as before.
  it("still treats an account-203 inbound invoice as a subscription (links + member refresh)", async () => {
    const { hasStrongSubscriptionInvoiceMatch } = (await vi.importActual("@/lib/xero-membership-sync")) as typeof import("@/lib/xero-membership-sync");
    mocks.hasStrongSubscriptionInvoiceMatch.mockImplementation(
      hasStrongSubscriptionInvoiceMatch,
    );
    mocks.buildSubscriptionInvoiceMatchOptions.mockResolvedValue({
      accountCode: "203",
      itemCodes: ["FULL-ADULT", "SUBS"],
      primaryItemCode: "SUBS",
      textFallbackEnabled: false,
    });

    mocks.inboundFindMany.mockResolvedValue([
      {
        id: "evt_203",
        source: "webhook",
        eventCategory: "INVOICE",
        eventType: "UPDATE",
        resourceId: "inv_203",
        correlationKey: "corr_203",
        payload: { resourceId: "inv_203" },
      },
    ]);
    mocks.processedCreate.mockResolvedValue({ id: "processed_203" });
    mocks.linkFindMany.mockResolvedValue([]);
    mocks.paymentFindMany.mockResolvedValue([]);
    mocks.memberFindMany.mockResolvedValue([{ id: "mem_1" }]);
    mocks.checkMembershipStatus.mockResolvedValue({
      status: "PAID",
      xeroInvoiceId: "inv_203",
    });
    const accountingApi = {
      getInvoice: vi.fn().mockResolvedValue({
        body: {
          invoices: [
            {
              invoiceID: "inv_203",
              invoiceNumber: "INV-203",
              date: "2026-04-10",
              status: "AUTHORISED",
              reference: "Renewal",
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

    await expect(processStoredXeroInboundEvents()).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.checkMembershipStatus).toHaveBeenCalledWith("mem_1", 2026);
    expect(mocks.auditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "xero.subscription.reconciled",
          subjectMemberId: "mem_1",
          entityType: "Member",
          metadata: expect.objectContaining({ role: "SUBSCRIPTION_INVOICE" }),
        }),
      }),
    );
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
            lodgeId: "lodge-1",
            checkIn: new Date("2026-07-10"),
            checkOut: new Date("2026-07-12"),
            status: "CONFIRMED",
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
    // The reconciliation now reloads the payment inside the finalization
    // transaction via tx.payment.findUnique. internetBankingHoldSlots:true
    // marks the booking as already holding its beds, so the paid path runs
    // straight through without a capacity re-check.
    mocks.paymentFindUnique.mockResolvedValue({
      id: "pay_ib_1",
      bookingId: "booking_ib_1",
      amountCents: 12345,
      status: "PENDING",
      source: "INTERNET_BANKING",
      reference: "BOOKING-ABC12345",
      xeroInvoiceId: null,
      xeroInvoiceNumber: null,
      internetBankingHoldSlots: true,
      booking: {
        id: "booking_ib_1",
        memberId: "mem_1",
        lodgeId: "lodge-1",
        checkIn: new Date("2026-07-10"),
        checkOut: new Date("2026-07-12"),
        status: "CONFIRMED",
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
    });
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
        // Refunded rows keep their refund bookkeeping on replays (#1357).
        status: { notIn: ["REFUNDED", "PARTIALLY_REFUNDED"] },
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
    expect(mocks.bookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "booking_ib_1", status: "CONFIRMED" },
      data: {
        status: "PAID",
        draftExpiresAt: null,
      },
    });
    expect(mocks.paymentFindUnique).toHaveBeenCalledTimes(2);
    expect(mocks.acquireLodgeCapacityLock).toHaveBeenCalledWith(
      expect.anything(),
      "lodge-1",
    );
    expect(mocks.acquireLodgeCapacityLock.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.paymentFindUnique.mock.invocationCallOrder[1],
    );
    expect(mocks.paymentFindUnique.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.bookingUpdateMany.mock.invocationCallOrder.at(-1)!,
    );
    expect(mocks.bookingUpdateMany.mock.invocationCallOrder.at(-1)!).toBeLessThan(
      mocks.reconcileBedAllocations.mock.invocationCallOrder[0],
    );
    expect(mocks.reconcileBedAllocations.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.enqueueOwnHostingCoverage.mock.invocationCallOrder[0],
    );
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
      { bookingId: "booking_ib_1", recipientMemberId: "mem_1" },
      "member@example.com",
      "Alice",
      new Date("2026-07-10"),
      new Date("2026-07-12"),
      1,
      12345,
      // Multi-lodge phase 8: the options now carry the booking's lodge so
      // the email renders that lodge's identity (undefined here because the
      // fixture booking has no lodgeId).
      { lodgeId: "lodge-1" }
    );
  });

  /**
   * #2265 (#2319 door 2). An invoice raised at the full price and then paid in
   * full by bank transfer cannot retroactively "apply" a stored credit election:
   * debiting the member's balance for money they have already sent as cash would
   * invent a charge, not honour a choice. So the settle clears the election and
   * says so — never a stale column on a settled booking, and never a silent one.
   *
   * Reachable through the blue/green drain (an old-colour switch-to-Internet-
   * Banking raises the full-price invoice without reading this column) and through
   * any future invoice-raising path that forgets to consume.
   */
  it("clears a stale credit election when an Internet Banking invoice settles, and reports it (#2265)", async () => {
    const bookingWithElection = {
      id: "booking_ib_1",
      memberId: "mem_1",
      checkIn: new Date("2026-07-10"),
      checkOut: new Date("2026-07-12"),
      status: "PAYMENT_PENDING",
      finalPriceCents: 12345,
      discountCents: 0,
      promoAdjustmentCents: 0,
      creditElectionCents: 4500,
      member: {
        email: "member@example.com",
        firstName: "Alice",
        lastName: "Smith",
      },
      guests: [{ id: "guest_1" }],
      promoRedemption: null,
    };
    mocks.inboundFindMany.mockResolvedValue([
      {
        id: "evt_ib_election",
        source: "webhook",
        eventCategory: "INVOICE",
        eventType: "UPDATE",
        resourceId: "inv_ib_election",
        correlationKey: "corr_ib_election",
        payload: { resourceId: "inv_ib_election" },
      },
    ]);
    mocks.processedCreate.mockResolvedValue({ id: "processed_ib_election" });
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
        { id: "pay_ib_1", xeroInvoiceId: null, xeroInvoiceNumber: null },
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
          booking: bookingWithElection,
        },
      ])
      .mockResolvedValueOnce([
        { id: "pay_ib_1", bookingId: "booking_ib_1", booking: { memberId: "mem_1" } },
      ]);
    // internetBankingHoldSlots keeps this on the already-holding path, so the
    // settle runs straight through to the PAID flip with no capacity re-check.
    mocks.paymentFindUnique.mockResolvedValue({
      id: "pay_ib_1",
      bookingId: "booking_ib_1",
      amountCents: 12345,
      status: "PENDING",
      source: "INTERNET_BANKING",
      reference: "BOOKING-ABC12345",
      xeroInvoiceId: null,
      xeroInvoiceNumber: null,
      internetBankingHoldSlots: true,
      booking: bookingWithElection,
    });
    mocks.subscriptionFindMany.mockResolvedValue([]);
    mocks.getAuthenticatedXeroClient.mockResolvedValue({
      xero: {
        accountingApi: {
          getInvoice: vi.fn().mockResolvedValue({
            body: {
              invoices: [
                {
                  invoiceID: "inv_ib_election",
                  invoiceNumber: "INV-IB-ELECT",
                  date: "2026-07-01",
                  status: "PAID",
                  fullyPaidOnDate: "2026-07-02",
                  contact: { contactID: "contact_1" },
                  payments: [
                    {
                      paymentID: "xpay_ib_1",
                      amount: 123.45,
                      invoiceNumber: "INV-IB-ELECT",
                      status: "PAID",
                    },
                  ],
                  lineItems: [{ accountCode: "200" }],
                },
              ],
            },
          }),
        },
      },
      tenantId: "tenant_1",
    });

    await expect(processStoredXeroInboundEvents()).resolves.toMatchObject({
      succeeded: 1,
      failed: 0,
    });

    // Guarded claim on the exact amount read: a consumer that got there first is
    // never clobbered.
    expect(mocks.bookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "booking_ib_1", creditElectionCents: 4500 },
      data: { creditElectionCents: null },
    });
    // The booking still settles exactly as it did before — the PAID flip itself
    // is untouched by this change.
    expect(mocks.bookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "booking_ib_1", status: "PAYMENT_PENDING" },
      data: { status: "PAID", draftExpiresAt: null },
    });
    // The member's note, and the officer's.
    expect(mocks.auditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "booking.credit_election.unapplied",
        entityId: "booking_ib_1",
        subjectMemberId: "mem_1",
        metadata: expect.objectContaining({
          creditElectionCents: 4500,
          // #2262 delta MED-2: the LIVE balance rides the row too, so nothing
          // downstream can quote the elected figure as still available. This
          // member's balance is the suite default of zero.
          availableCreditCents: 0,
          refundableCents: 0,
          xeroInvoiceId: "inv_ib_election",
        }),
      }),
    });
    expect(vi.mocked(sendAdminPaymentFailureAlert)).toHaveBeenCalledWith(
      expect.objectContaining({
        // Clamped: their balance is gone, so there is nothing to hand back.
        amountCents: 0,
        paymentIntentId: "inv_ib_election",
        errorMessage: expect.stringContaining("never debited"),
      })
    );
  });

  it("threads the provisional non-member child into the Internet-Banking split-parent confirmation email (#1942 FIX 4a)", async () => {
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
        { id: "pay_ib_1", xeroInvoiceId: null, xeroInvoiceNumber: null },
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
    mocks.paymentFindUnique.mockResolvedValue({
      id: "pay_ib_1",
      bookingId: "booking_ib_1",
      amountCents: 12345,
      status: "PENDING",
      source: "INTERNET_BANKING",
      reference: "BOOKING-ABC12345",
      xeroInvoiceId: null,
      xeroInvoiceNumber: null,
      internetBankingHoldSlots: true,
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
    });
    mocks.subscriptionFindMany.mockResolvedValue([]);
    // This IB parent is a split parent: describe its provisional non-member
    // child so the confirmation email carries the provisional section.
    const holdUntil = new Date("2026-07-03T00:30:00.000Z");
    mocks.bookingFindFirst.mockResolvedValue({
      nonMemberHoldUntil: holdUntil,
      _count: { guests: 2 },
    });
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

    expect(sendBookingConfirmedEmail).toHaveBeenCalledWith(
      { bookingId: "booking_ib_1", recipientMemberId: "mem_1" },
      "member@example.com",
      "Alice",
      new Date("2026-07-10"),
      new Date("2026-07-12"),
      1,
      12345,
      expect.objectContaining({
        provisionalGuests: { guestCount: 2, holdUntil },
      }),
    );
  });

  function mockCapacityFailInboundEvent(
    params: {
      amountPaid?: number;
      invoicePayments?: unknown[];
      // #1771: set on the POST-lock (locked) booking so the reconcile reads a
      // persisted capacity override. Defaults null -> the existing capacity-fail
      // pin is byte-identical.
      capacityOverriddenAt?: Date | null;
    } = {}
  ) {
    // Capture the exact transaction client the reconcile passes to its
    // callback so callers can prove the outbox enqueue committed atomically
    // with the local credit (same tx object), not via post-commit
    // fire-and-forget.
    const txRef: { current: unknown } = { current: null };
    mocks.transaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          $executeRaw: mocks.txExecuteRaw,
          $queryRaw: mocks.txExecuteRaw,
          lodge: {
            findFirst: mocks.lodgeFindFirst,
          },
          processedWebhookEvent: {
            deleteMany: mocks.processedDeleteMany,
          },
          xeroInboundEvent: {
            update: mocks.inboundUpdate,
          },
          payment: {
            findUnique: mocks.paymentFindUnique,
            update: mocks.paymentUpdate,
          },
          paymentTransaction: {
            updateMany: mocks.paymentTransactionUpdateMany,
            create: mocks.paymentTransactionCreate,
          },
          booking: {
            update: mocks.bookingUpdate,
            updateMany: mocks.bookingUpdateMany,
          },
          memberCredit: {
            findFirst: mocks.memberCreditFindFirst,
            create: mocks.memberCreditCreate,
            aggregate: mocks.memberCreditAggregate,
          },
          // The in-tx enqueue reads its dedup lookups through this same client.
          xeroObjectLink: {
            findFirst: mocks.txLinkFindFirst,
          },
          xeroSyncOperation: {
            findFirst: mocks.txOperationFindFirst,
          },
        };
        txRef.current = tx;
        return callback(tx);
      }
    );
    mocks.checkCapacity.mockResolvedValue({ available: false });

    mocks.inboundFindMany.mockResolvedValue([
      {
        id: "evt_ib_cap",
        source: "webhook",
        eventCategory: "INVOICE",
        eventType: "UPDATE",
        resourceId: "inv_ib_cap",
        correlationKey: "corr_ib_cap",
        payload: { resourceId: "inv_ib_cap" },
      },
    ]);
    mocks.processedCreate.mockResolvedValue({ id: "processed_ib_cap" });
    mocks.linkFindMany
      .mockResolvedValueOnce([
        {
          localModel: "Payment",
          localId: "pay_ib_cap",
          xeroObjectType: "INVOICE",
          role: "PRIMARY_INVOICE",
        },
      ])
      .mockResolvedValueOnce([]);
    mocks.paymentFindMany
      .mockResolvedValueOnce([
        {
          id: "pay_ib_cap",
          xeroInvoiceId: null,
          xeroInvoiceNumber: null,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "pay_ib_cap",
          bookingId: "booking_ib_cap",
          amountCents: 12345,
          status: "PENDING",
          source: "INTERNET_BANKING",
          reference: "BOOKING-CAP12345",
          xeroInvoiceId: null,
          xeroInvoiceNumber: null,
          booking: {
            id: "booking_ib_cap",
            memberId: "mem_cap",
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
            lodgeId: "lodge_ib_cap",
            guests: [{ id: "guest_cap", nights: [] }],
            promoRedemption: null,
          },
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "pay_ib_cap",
          bookingId: "booking_ib_cap",
          booking: { memberId: "mem_cap" },
        },
      ]);
    // Reloaded inside the finalization transaction. internetBankingHoldSlots is
    // false, so the reconcile re-checks capacity (mocked unavailable) and takes
    // the capacity-fail path.
    mocks.paymentFindUnique.mockResolvedValue({
      id: "pay_ib_cap",
      bookingId: "booking_ib_cap",
      amountCents: 12345,
      status: "PENDING",
      source: "INTERNET_BANKING",
      reference: "BOOKING-CAP12345",
      xeroInvoiceId: null,
      xeroInvoiceNumber: null,
      internetBankingHoldSlots: false,
      booking: {
        id: "booking_ib_cap",
        memberId: "mem_cap",
        lodgeId: "lodge_ib_cap",
        checkIn: new Date("2026-07-10"),
        checkOut: new Date("2026-07-12"),
        status: "PAYMENT_PENDING",
        finalPriceCents: 12345,
        discountCents: 0,
        promoAdjustmentCents: 0,
        // #1771: null unless the caller marks this booking as an admin overbook.
        capacityOverriddenAt: params.capacityOverriddenAt ?? null,
        guests: [{ id: "guest_cap", nights: [] }],
        member: {
          email: "member@example.com",
          firstName: "Alice",
          lastName: "Smith",
        },
        promoRedemption: null,
      },
    });
    mocks.memberCreditFindFirst.mockResolvedValue(null);
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_account_credit_cap" });
    const accountingApi = {
      getInvoice: vi.fn().mockResolvedValue({
        body: {
          invoices: [
            {
              invoiceID: "inv_ib_cap",
              invoiceNumber: "INV-IB-CAP",
              date: "2026-07-01",
              status: "PAID",
              fullyPaidOnDate: "2026-07-02",
              contact: { contactID: "contact_1" },
              ...(params.amountPaid !== undefined
                ? { amountPaid: params.amountPaid }
                : {}),
              payments: params.invoicePayments ?? [
                {
                  paymentID: "xpay_ib_cap",
                  amount: 123.45,
                  invoiceNumber: "INV-IB-CAP",
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

    return txRef;
  }

  it("enqueues the offsetting Xero account-credit note inside the reconcile transaction when a late Internet Banking payment lands after capacity is gone", async () => {
    const txRef = mockCapacityFailInboundEvent();

    await expect(processStoredXeroInboundEvents()).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    // The booking was cancelled and the offsetting local credit was created in
    // the same transaction.
    expect(mocks.bookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "booking_ib_cap", status: "PAYMENT_PENDING" },
      data: {
        status: "CANCELLED",
        draftExpiresAt: null,
      },
    });
    expect(mocks.memberCreditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        memberId: "mem_cap",
        amountCents: 12345,
        type: "CANCELLATION_REFUND",
        sourceBookingId: "booking_ib_cap",
      }),
    });

    // The account-credit note outbox operation was queued through the SAME
    // transaction client (store === the captured tx), proving it commits
    // atomically with the credit rather than post-commit fire-and-forget.
    expect(txRef.current).not.toBeNull();
    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "OUTBOUND",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "Payment",
        localId: "pay_ib_cap",
        requestPayload: expect.objectContaining({
          queueType: "ACCOUNT_CREDIT_NOTE",
          refundAmountCents: 12345,
        }),
        store: txRef.current,
      })
    );
    // The enqueue's dedup lookups went through the transaction client.
    expect(mocks.txLinkFindFirst).toHaveBeenCalledTimes(1);
    expect(mocks.txOperationFindFirst).toHaveBeenCalledTimes(1);
    // Not the paid path.
    expect(sendBookingConfirmedEmail).not.toHaveBeenCalled();
  });

  // #1771 — a PAYMENT_PENDING Internet Banking booking deliberately admitted
  // over the ceiling by an admin carries a persisted capacityOverriddenAt
  // marker. A late payment landing over capacity must SETTLE it (status -> PAID),
  // not cancel it and mint an offsetting credit note. (The non-overridden pin is
  // the preceding cancel+mint test.)
  it("settles an over-capacity Internet Banking booking with a persisted capacity override to PAID instead of cancelling and minting a credit (#1771)", async () => {
    mockCapacityFailInboundEvent({ capacityOverriddenAt: new Date("2026-06-01") });

    await expect(processStoredXeroInboundEvents()).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    // Settled, not cancelled.
    expect(mocks.bookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "booking_ib_cap", status: "PAYMENT_PENDING" },
      data: { status: "PAID", draftExpiresAt: null },
    });
    expect(mocks.bookingUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "CANCELLED" }),
      })
    );
    // No offsetting credit note is minted or enqueued.
    expect(mocks.memberCreditCreate).not.toHaveBeenCalled();
    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalledWith(
      expect.objectContaining({ entityType: "CREDIT_NOTE" })
    );
  });

  it("takes BOTH the global lock(1) and the booking's per-lodge lock before the capacity claim (H2)", async () => {
    // The PAYMENT_PENDING (no hold slots) reconcile is a net-new capacity claim
    // (available -> PAID, unavailable -> CANCELLED + credit). It must keep the
    // global pg_advisory_xact_lock(1) that sequences IB webhook processing AND
    // additionally serialise on the booking's per-lodge lock, or per-lodge
    // booking creators (who no longer contend on lock(1)) race the claim.
    mockCapacityFailInboundEvent();

    await processStoredXeroInboundEvents();

    // We are on the capacity-claim branch (booking cancelled, credit minted).
    expect(mocks.bookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "booking_ib_cap", status: "PAYMENT_PENDING" },
      data: { status: "CANCELLED", draftExpiresAt: null },
    });

    const rawCalls = mocks.txExecuteRaw.mock.calls as unknown[][];
    const sqlOf = (call: unknown[]) => (call[0] as string[]).join("?");
    // Global webhook-sequencing lock still taken (composition preserved).
    expect(
      rawCalls.some((c) => sqlOf(c).includes("pg_advisory_xact_lock(1)"))
    ).toBe(true);
    // ...AND the per-lodge capacity lock keyed to the booking's lodge.
    expect(mocks.acquireLodgeCapacityLock).toHaveBeenCalledWith(
      expect.anything(),
      "lodge_ib_cap",
    );
  });

  // #1587: an unheld PAYMENT_PENDING reconcile takes the booking's lodge lock
  // and re-reads the booking before the capacity claim (the H2 fix). This helper
  // drives the exact interleaving the fix guards: the PRE-lock read (full member
  // include) still shows PAYMENT_PENDING, but the POST-lodge-lock read (guests-
  // only include) shows a status a concurrent actor set inside the lock wait
  // window. Distinguishing the two reads by include shape lets the post-lock
  // snapshot differ from the pre-lock one.
  function mockPostLockReconcileEvent(params: {
    lockedBookingStatus: "CANCELLED" | "PAYMENT_PENDING";
    capacityAvailable: boolean;
  }) {
    const txOperationUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    mocks.transaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          $executeRaw: mocks.txExecuteRaw,
          $queryRaw: mocks.txExecuteRaw,
          lodge: { findFirst: mocks.lodgeFindFirst },
          processedWebhookEvent: { deleteMany: mocks.processedDeleteMany },
          xeroInboundEvent: { update: mocks.inboundUpdate },
          payment: {
            findUnique: mocks.paymentFindUnique,
            update: mocks.paymentUpdate,
          },
          paymentTransaction: {
            updateMany: mocks.paymentTransactionUpdateMany,
            findFirst: vi.fn().mockResolvedValue({ id: "ptx_primary" }),
            create: mocks.paymentTransactionCreate,
          },
          booking: {
            update: mocks.bookingUpdate,
            updateMany: mocks.bookingUpdateMany,
          },
          memberCredit: {
            findFirst: mocks.memberCreditFindFirst,
            create: mocks.memberCreditCreate,
            aggregate: mocks.memberCreditAggregate,
          },
          xeroObjectLink: { findFirst: mocks.txLinkFindFirst },
          xeroSyncOperation: {
            findFirst: mocks.txOperationFindFirst,
            updateMany: txOperationUpdateMany,
          },
        };
        return callback(tx);
      }
    );
    mocks.checkCapacity.mockResolvedValue({ available: params.capacityAvailable });

    mocks.inboundFindMany.mockResolvedValue([
      {
        id: "evt_ib_pl",
        source: "webhook",
        eventCategory: "INVOICE",
        eventType: "UPDATE",
        resourceId: "inv_ib_pl",
        correlationKey: "corr_ib_pl",
        payload: { resourceId: "inv_ib_pl" },
      },
    ]);
    mocks.processedCreate.mockResolvedValue({ id: "processed_ib_pl" });
    mocks.linkFindMany
      .mockResolvedValueOnce([
        {
          localModel: "Payment",
          localId: "pay_ib_pl",
          xeroObjectType: "INVOICE",
          role: "PRIMARY_INVOICE",
        },
      ])
      .mockResolvedValueOnce([]);

    // Pre-lock snapshot: still PAYMENT_PENDING and holding no beds, so the
    // reconcile enters the lodge-lock / re-read block. Full member/guest graph,
    // and it is the object routed into the credit-mint arm (payment status
    // PENDING => the arm's paymentNeverSettled guard mints).
    const freshPreLock = {
      id: "pay_ib_pl",
      bookingId: "booking_ib_pl",
      amountCents: 12345,
      status: "PENDING",
      source: "INTERNET_BANKING",
      reference: "BOOKING-PL123456",
      xeroInvoiceId: null,
      xeroInvoiceNumber: null,
      internetBankingHoldSlots: false,
      xeroRefundCreditNoteId: null,
      booking: {
        id: "booking_ib_pl",
        memberId: "mem_pl",
        lodgeId: "lodge_ib_pl",
        checkIn: new Date("2026-07-10"),
        checkOut: new Date("2026-07-12"),
        status: "PAYMENT_PENDING",
        finalPriceCents: 12345,
        discountCents: 0,
        promoAdjustmentCents: 0,
        guests: [{ id: "guest_pl", nights: [] }],
        member: {
          email: "member@example.com",
          firstName: "Alice",
          lastName: "Smith",
        },
        promoRedemption: null,
      },
    };
    // Post-lock snapshot: what the reconcile sees AFTER taking the lodge lock.
    // The guests-only include (no member) is how the mock distinguishes it from
    // the pre-lock read.
    const lockedPostLock = {
      ...freshPreLock,
      booking: {
        ...freshPreLock.booking,
        status: params.lockedBookingStatus,
      },
    };

    mocks.paymentFindMany
      .mockResolvedValueOnce([
        { id: "pay_ib_pl", xeroInvoiceId: null, xeroInvoiceNumber: null },
      ])
      .mockResolvedValueOnce([freshPreLock])
      .mockResolvedValueOnce([
        {
          id: "pay_ib_pl",
          bookingId: "booking_ib_pl",
          booking: { memberId: "mem_pl" },
        },
      ]);

    // The reconcile loop reads the payment twice inside its transaction: once
    // under the global lock and once after adding the lodge lock.
    let paymentReadCount = 0;
    mocks.paymentFindUnique.mockImplementation(() =>
      Promise.resolve(paymentReadCount++ === 0 ? freshPreLock : lockedPostLock),
    );

    mocks.memberCreditFindFirst.mockResolvedValue(null);
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_account_credit_pl" });
    const accountingApi = {
      getInvoice: vi.fn().mockResolvedValue({
        body: {
          invoices: [
            {
              invoiceID: "inv_ib_pl",
              invoiceNumber: "INV-IB-PL",
              date: "2026-07-01",
              status: "PAID",
              fullyPaidOnDate: "2026-07-02",
              contact: { contactID: "contact_1" },
              payments: [
                {
                  paymentID: "xpay_ib_pl",
                  amount: 123.45,
                  invoiceNumber: "INV-IB-PL",
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
  }

  it("routes a booking cancelled inside the lodge-lock window into the credit-mint arm instead of resurrecting it to PAID (#1587)", async () => {
    mockPostLockReconcileEvent({
      lockedBookingStatus: "CANCELLED",
      capacityAvailable: true,
    });

    await expect(processStoredXeroInboundEvents()).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    // We reached the post-lock position: the booking's per-lodge lock was taken
    // and the re-read ran BEFORE the interception.
    expect(mocks.acquireLodgeCapacityLock).toHaveBeenCalledWith(
      expect.anything(),
      "lodge_ib_pl",
    );

    // The load-bearing assertion: NO status write at all — the booking is never
    // flipped to PAID (no phantom capacity claim) and the arm never touches
    // booking.update. The interception fired before the capacity gate.
    expect(mocks.bookingUpdate).not.toHaveBeenCalled();
    expect(mocks.checkCapacity).not.toHaveBeenCalled();

    // The cash was routed into the already-cancelled credit-mint arm: the
    // member keeps their money as account credit, keyed on the cancelled-booking
    // description this pipeline dedups against.
    expect(mocks.memberCreditCreate).toHaveBeenCalledWith({
      data: {
        memberId: "mem_pl",
        amountCents: 12345,
        type: "CANCELLATION_REFUND",
        description:
          "Internet Banking payment credit for cancelled booking booking_",
        sourceBookingId: "booking_ib_pl",
      },
    });
    expect(sendBookingCancelledEmail).toHaveBeenCalledWith(
      { bookingId: "booking_ib_pl", recipientMemberId: "mem_pl" },
      "member@example.com",
      "Alice",
      expect.any(Date),
      expect.any(Date),
      12345,
      "credit",
      0,
      "lodge_ib_pl"
    );
    expect(sendBookingConfirmedEmail).not.toHaveBeenCalled();
  });

  it("still flips a booking that is unchanged after the lodge-lock re-read to PAID (#1587)", async () => {
    mockPostLockReconcileEvent({
      lockedBookingStatus: "PAYMENT_PENDING",
      capacityAvailable: true,
    });

    await expect(processStoredXeroInboundEvents()).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    // The #1587 guard falls through cleanly for a still-active booking: the
    // capacity gate runs and the PAID flip happens exactly as before.
    expect(mocks.checkCapacity).toHaveBeenCalled();
    expect(mocks.bookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "booking_ib_pl", status: "PAYMENT_PENDING" },
      data: {
        status: "PAID",
        draftExpiresAt: null,
      },
    });
    expect(mocks.memberCreditCreate).not.toHaveBeenCalled();
    expect(sendBookingConfirmedEmail).toHaveBeenCalled();
  });

  it("clamps the late-capacity-failure credit to the invoice's cash on a mixed invoice (#1459)", async () => {
    // The capacity-fail arm mints too: a live booking's invoice half-paid in
    // cash and half written off must credit only the cash portion.
    mockCapacityFailInboundEvent({ amountPaid: 61.72, invoicePayments: [] });

    await expect(processStoredXeroInboundEvents()).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.memberCreditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        memberId: "mem_cap",
        amountCents: 6172,
        sourceBookingId: "booking_ib_cap",
      }),
    });
    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        localId: "pay_ib_cap",
        requestPayload: expect.objectContaining({
          queueType: "ACCOUNT_CREDIT_NOTE",
          refundAmountCents: 6172,
        }),
      })
    );
    expect(mocks.recordBookingEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "CREDITED", amountCents: 6172 })
    );
    expect(sendBookingCancelledEmail).toHaveBeenCalledWith(
      { bookingId: "booking_ib_cap", recipientMemberId: "mem_cap" },
      "member@example.com",
      "Alice",
      expect.any(Date),
      expect.any(Date),
      6172,
      "credit",
      0,
      "lodge_ib_cap"
    );
    // #19: the late-capacity-failure waitlist re-processing is scoped to the
    // cancelled booking's own lodge, not the default lodge.
    expect(mocks.processWaitlist).toHaveBeenCalledWith(
      expect.objectContaining({ lodgeId: "lodge_ib_cap" })
    );
    const [alertArgs] = vi.mocked(sendAdminPaymentFailureAlert).mock.calls[0];
    expect(alertArgs.amountCents).toBe(6172);
    expect(alertArgs.errorMessage).toContain("mixed invoice");
  });

  // #1357 (F17): a member paying the stale open invoice of an already-cancelled
  // booking must not land silently — the money becomes an idempotent member
  // credit with its offsetting Xero account-credit note enqueued in the SAME
  // transaction, plus an admin alert and a member email.
  const txOperationUpdateMany = vi.fn().mockResolvedValue({ count: 1 });

  function mockAlreadyCancelledInboundEvent(params: {
    paymentStatus: string;
    existingCredit: { id: string; amountCents?: number } | null;
    // `null` omits the payments key entirely (degraded payload shape, #1435).
    invoicePayments?: unknown[] | null;
    amountPaid?: number;
    invoiceOverpayments?: unknown[];
    invoicePrepayments?: unknown[];
    xeroRefundCreditNoteId?: string | null;
  }) {
    const txRef: { current: unknown } = { current: null };
    txOperationUpdateMany.mockClear();
    mocks.transaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          $executeRaw: mocks.txExecuteRaw,
          processedWebhookEvent: { deleteMany: mocks.processedDeleteMany },
          xeroInboundEvent: { update: mocks.inboundUpdate },
          payment: {
            findUnique: mocks.paymentFindUnique,
            update: mocks.paymentUpdate,
          },
          paymentTransaction: {
            updateMany: mocks.paymentTransactionUpdateMany,
            findFirst: vi.fn().mockResolvedValue({ id: "ptx_primary" }),
            create: mocks.paymentTransactionCreate,
          },
          booking: { update: mocks.bookingUpdate },
          memberCredit: {
            findFirst: mocks.memberCreditFindFirst,
            create: mocks.memberCreditCreate,
            aggregate: mocks.memberCreditAggregate,
          },
          xeroObjectLink: { findFirst: mocks.txLinkFindFirst },
          xeroSyncOperation: {
            findFirst: mocks.txOperationFindFirst,
            updateMany: txOperationUpdateMany,
          },
        };
        txRef.current = tx;
        return callback(tx);
      }
    );

    mocks.inboundFindMany.mockResolvedValue([
      {
        id: "evt_ib_cancelled",
        source: "webhook",
        eventCategory: "INVOICE",
        eventType: "UPDATE",
        resourceId: "inv_ib_cancelled",
        correlationKey: "corr_ib_cancelled",
        payload: { resourceId: "inv_ib_cancelled" },
      },
    ]);
    mocks.processedCreate.mockResolvedValue({ id: "processed_ib_cancelled" });
    mocks.linkFindMany
      .mockResolvedValueOnce([
        {
          localModel: "Payment",
          localId: "pay_ib_cancelled",
          xeroObjectType: "INVOICE",
          role: "PRIMARY_INVOICE",
        },
      ])
      .mockResolvedValueOnce([]);
    const booking = {
      id: "booking_ib_cancelled",
      memberId: "mem_cancelled",
      lodgeId: "lodge_ib_ac",
      checkIn: new Date("2026-07-10"),
      checkOut: new Date("2026-07-12"),
      status: "CANCELLED",
      finalPriceCents: 12345,
      discountCents: 0,
      promoAdjustmentCents: 0,
      guests: [{ id: "guest_cancelled", nights: [] }],
      member: {
        email: "member@example.com",
        firstName: "Alice",
        lastName: "Smith",
      },
      promoRedemption: null,
    };
    mocks.paymentFindMany
      .mockResolvedValueOnce([
        {
          id: "pay_ib_cancelled",
          xeroInvoiceId: null,
          xeroInvoiceNumber: null,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "pay_ib_cancelled",
          bookingId: "booking_ib_cancelled",
          amountCents: 12345,
          status: params.paymentStatus,
          source: "INTERNET_BANKING",
          reference: "BOOKING-CANC1234",
          xeroInvoiceId: null,
          xeroInvoiceNumber: null,
          booking,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "pay_ib_cancelled",
          bookingId: "booking_ib_cancelled",
          booking: { memberId: "mem_cancelled" },
        },
      ]);
    mocks.paymentFindUnique.mockResolvedValue({
      id: "pay_ib_cancelled",
      bookingId: "booking_ib_cancelled",
      amountCents: 12345,
      status: params.paymentStatus,
      source: "INTERNET_BANKING",
      reference: "BOOKING-CANC1234",
      xeroInvoiceId: params.paymentStatus === "SUCCEEDED" ? "inv_ib_cancelled" : null,
      xeroInvoiceNumber:
        params.paymentStatus === "SUCCEEDED" ? "INV-IB-CANCELLED" : null,
      internetBankingHoldSlots: true,
      xeroRefundCreditNoteId: params.xeroRefundCreditNoteId ?? null,
      booking,
    });
    mocks.memberCreditFindFirst.mockResolvedValue(params.existingCredit);
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_account_credit_cancelled" });
    const accountingApi = {
      getInvoice: vi.fn().mockResolvedValue({
        body: {
          invoices: [
            {
              invoiceID: "inv_ib_cancelled",
              invoiceNumber: "INV-IB-CANCELLED",
              date: "2026-07-01",
              status: "PAID",
              fullyPaidOnDate: "2026-07-02",
              contact: { contactID: "contact_1" },
              ...(params.amountPaid !== undefined
                ? { amountPaid: params.amountPaid }
                : {}),
              ...(params.invoiceOverpayments
                ? { overpayments: params.invoiceOverpayments }
                : {}),
              ...(params.invoicePrepayments
                ? { prepayments: params.invoicePrepayments }
                : {}),
              ...(params.invoicePayments === null
                ? {}
                : {
                    payments: params.invoicePayments ?? [
                      {
                        paymentID: "xpay_ib_cancelled",
                        amount: 123.45,
                        invoiceNumber: "INV-IB-CANCELLED",
                        status: "AUTHORISED",
                      },
                    ],
                  }),
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

    return txRef;
  }

  it("credits and alerts when an Internet Banking payment lands on an already-cancelled booking (#1357)", async () => {
    const txRef = mockAlreadyCancelledInboundEvent({
      paymentStatus: "PENDING",
      existingCredit: null,
    });

    await expect(processStoredXeroInboundEvents()).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    // The booking keeps its CANCELLED status — no status write at all.
    expect(mocks.bookingUpdate).not.toHaveBeenCalled();
    // The credit dedupe keys on THIS pipeline's own descriptions — never on
    // amount, which collides with unrelated cancellation-flow credit rows.
    expect(mocks.memberCreditFindFirst).toHaveBeenCalledWith({
      where: {
        memberId: "mem_cancelled",
        sourceBookingId: "booking_ib_cancelled",
        type: "CANCELLATION_REFUND",
        description: {
          in: [
            "Internet Banking payment credit for booking booking_",
            "Internet Banking payment credit for cancelled booking booking_",
          ],
        },
      },
      // amountCents feeds the later-cash delta detection (#1459).
      select: { id: true, amountCents: true },
    });
    // The now-obsolete invoice-clearing refund note was retired in the SAME
    // transaction (real cash arrived; the note would post a fictional refund).
    expect(txOperationUpdateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        localId: "pay_ib_cancelled",
        status: "PENDING",
        correlationKey: {
          startsWith: "payment:pay_ib_cancelled:refund-credit-note:",
        },
      }),
      data: { status: "CANCELLED" },
    });
    expect(mocks.memberCreditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        memberId: "mem_cancelled",
        amountCents: 12345,
        type: "CANCELLATION_REFUND",
        sourceBookingId: "booking_ib_cancelled",
      }),
    });
    // The offsetting account-credit note was enqueued through the SAME
    // transaction client as the credit.
    expect(txRef.current).not.toBeNull();
    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        localModel: "Payment",
        localId: "pay_ib_cancelled",
        requestPayload: expect.objectContaining({
          queueType: "ACCOUNT_CREDIT_NOTE",
          refundAmountCents: 12345,
        }),
        store: txRef.current,
      })
    );
    expect(sendAdminPaymentFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 12345,
        errorMessage: expect.stringContaining("already-cancelled booking"),
      })
    );
    expect(sendBookingCancelledEmail).toHaveBeenCalledWith(
      {
        bookingId: "booking_ib_cancelled",
        recipientMemberId: "mem_cancelled",
      },
      "member@example.com",
      "Alice",
      expect.any(Date),
      expect.any(Date),
      12345,
      "credit",
      0,
      "lodge_ib_ac"
    );
    expect(sendBookingConfirmedEmail).not.toHaveBeenCalled();
  });

  it("stays silent on a webhook replay for an already-credited cancelled booking (#1357)", async () => {
    mockAlreadyCancelledInboundEvent({
      paymentStatus: "SUCCEEDED",
      existingCredit: { id: "credit_existing" },
    });

    await expect(processStoredXeroInboundEvents()).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    // Replay: no second credit, no second account-credit outbox row (the
    // pipeline's own inbound-event operation rows don't count), no alert spam.
    expect(mocks.memberCreditCreate).not.toHaveBeenCalled();
    const accountCreditEnqueues = mocks.startXeroSyncOperation.mock.calls.filter(
      ([input]) => input?.requestPayload?.queueType === "ACCOUNT_CREDIT_NOTE"
    );
    expect(accountCreditEnqueues).toHaveLength(0);
    expect(sendAdminPaymentFailureAlert).not.toHaveBeenCalled();
    expect(sendBookingCancelledEmail).not.toHaveBeenCalled();
  });

  // The killer counter-case (#1357 review): our OWN invoice-clearing credit
  // notes flip invoices to PAID by ALLOCATION — zero cash. Every ordinary
  // unpaid-IB cancellation produces this event, and it must mint nothing.
  it("mints nothing when the invoice was cleared by credit allocation, not cash (#1357)", async () => {
    mockAlreadyCancelledInboundEvent({
      paymentStatus: "FAILED",
      existingCredit: null,
      amountPaid: 0,
      invoicePayments: [],
    });

    await expect(processStoredXeroInboundEvents()).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.memberCreditCreate).not.toHaveBeenCalled();
    const accountCreditEnqueues = mocks.startXeroSyncOperation.mock.calls.filter(
      ([input]) => input?.requestPayload?.queueType === "ACCOUNT_CREDIT_NOTE"
    );
    expect(accountCreditEnqueues).toHaveLength(0);
    expect(txOperationUpdateMany).not.toHaveBeenCalled();
    expect(sendAdminPaymentFailureAlert).not.toHaveBeenCalled();
    expect(sendBookingCancelledEmail).not.toHaveBeenCalled();
    // #1435: not only is nothing minted — nothing SETTLES either. The FAILED
    // payment and its PRIMARY transaction keep their status (money never
    // arrived), no fallback SUCCEEDED transaction row is created, and the
    // only writes are identifier stamps (linkage, never status) so a later
    // real-cash event for this invoice still matches the payment.
    expect(mocks.paymentTransactionCreate).not.toHaveBeenCalled();
    for (const [args] of mocks.paymentTransactionUpdateMany.mock.calls) {
      expect(args.data.status).toBeUndefined();
    }
    expect(mocks.paymentTransactionUpdateMany).toHaveBeenCalledWith({
      where: {
        paymentId: { in: ["pay_ib_cancelled"] },
        source: "INTERNET_BANKING",
        kind: "PRIMARY",
        xeroInvoiceId: null,
      },
      data: {
        xeroInvoiceId: "inv_ib_cancelled",
        xeroInvoiceNumber: "INV-IB-CANCELLED",
      },
    });
    expect(mocks.paymentUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ["pay_ib_cancelled"] }, xeroInvoiceId: null },
      data: {
        xeroInvoiceId: "inv_ib_cancelled",
        xeroInvoiceNumber: "INV-IB-CANCELLED",
      },
    });
    for (const [args] of mocks.paymentUpdate.mock.calls) {
      expect(args.data.status).toBeUndefined();
    }
    expect(mocks.bookingUpdate).not.toHaveBeenCalled();
  });

  // #1459: a mixed invoice — the member part-pays a cancelled booking's stale
  // open invoice in cash while the remainder is cleared by credit allocation —
  // reports PAID with amountPaid equal to ONLY the cash portion. The mint must
  // track the cash that actually arrived, never the payment's face amount.
  it("mints only the cash portion of a mixed cash-plus-allocation invoice (#1459)", async () => {
    mockAlreadyCancelledInboundEvent({
      paymentStatus: "PENDING",
      existingCredit: null,
      amountPaid: 61.72,
      invoicePayments: [],
    });

    await expect(processStoredXeroInboundEvents()).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    // The credit, its offsetting Xero account-credit note, the member email,
    // and the booking event all carry the CASH portion — one consistent
    // amount everywhere.
    expect(mocks.memberCreditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        memberId: "mem_cancelled",
        amountCents: 6172,
        type: "CANCELLATION_REFUND",
        sourceBookingId: "booking_ib_cancelled",
      }),
    });
    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        localId: "pay_ib_cancelled",
        requestPayload: expect.objectContaining({
          queueType: "ACCOUNT_CREDIT_NOTE",
          refundAmountCents: 6172,
        }),
      })
    );
    expect(mocks.recordBookingEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "CREDITED",
        amountCents: 6172,
        reason: expect.stringContaining("cash portion"),
      })
    );
    expect(sendBookingCancelledEmail).toHaveBeenCalledWith(
      {
        bookingId: "booking_ib_cancelled",
        recipientMemberId: "mem_cancelled",
      },
      "member@example.com",
      "Alice",
      expect.any(Date),
      expect.any(Date),
      6172,
      "credit",
      0,
      "lodge_ib_ac"
    );
    // The admin alert names both amounts so the operator can verify the
    // allocation source (routine clearing-note echo vs. write-off vs. an
    // applied member credit note).
    expect(sendAdminPaymentFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 6172,
        errorMessage: expect.stringContaining("mixed invoice"),
      })
    );
    const [alertArgs] = vi.mocked(sendAdminPaymentFailureAlert).mock.calls[0];
    expect(alertArgs.errorMessage).toContain("$61.72");
    expect(alertArgs.errorMessage).toContain("$123.45");
    // Remainder cash never auto-credits — the alert says so up front.
    expect(alertArgs.errorMessage).toContain("NOT credit automatically");
    // Exactly one alert, and the clearing-note retirement still runs on the
    // partial-mint path (the invoice is settled; executing the pending note
    // would book a fictional cash refund).
    expect(sendAdminPaymentFailureAlert).toHaveBeenCalledTimes(1);
    expect(txOperationUpdateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        localId: "pay_ib_cancelled",
        status: "PENDING",
        correlationKey: {
          startsWith: "payment:pay_ib_cancelled:refund-credit-note:",
        },
      }),
      data: { status: "CANCELLED" },
    });
    // The partial mint is visible in the reconcile result that lands in the
    // inbound audit metadata.
    expect(mocks.auditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "xero.invoice.reconciled",
        metadata: expect.objectContaining({
          internetBankingPaymentSync: expect.objectContaining({
            creditedInternetBankingBookings: 1,
            partialCashCreditedInternetBankingBookings: 1,
          }),
        }),
      }),
    });
  });

  it("mints the full amount when amountPaid exactly covers the payment (#1459)", async () => {
    mockAlreadyCancelledInboundEvent({
      paymentStatus: "PENDING",
      existingCredit: null,
      amountPaid: 123.45,
      invoicePayments: [],
    });

    await expect(processStoredXeroInboundEvents()).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.memberCreditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ amountCents: 12345 }),
    });
    const [alertArgs] = vi.mocked(sendAdminPaymentFailureAlert).mock.calls[0];
    expect(alertArgs.errorMessage).not.toContain("mixed invoice");
    expect(alertArgs.errorMessage).not.toContain("could not be fully verified");
  });

  it("stays silent on a mixed-invoice replay whose cash matches the minted credit (#1459)", async () => {
    // The state a partial mint leaves behind: payment settled, pipeline
    // credit for the cash portion, same mixed payload replayed.
    mockAlreadyCancelledInboundEvent({
      paymentStatus: "SUCCEEDED",
      existingCredit: { id: "credit_existing", amountCents: 6172 },
      amountPaid: 61.72,
      invoicePayments: [],
    });

    await expect(processStoredXeroInboundEvents()).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.memberCreditCreate).not.toHaveBeenCalled();
    expect(sendAdminPaymentFailureAlert).not.toHaveBeenCalled();
    expect(sendBookingCancelledEmail).not.toHaveBeenCalled();
  });

  it("alerts with the delta when verified later cash exceeds the minted credit (#1459)", async () => {
    // After a partial mint the operator fixes the wrong allocation and the
    // member banks the remainder: the next PAID event carries MORE verified
    // cash than was credited. The gates stop a second mint (deliberate), so
    // the reconcile must say so instead of staying silent.
    mockAlreadyCancelledInboundEvent({
      paymentStatus: "SUCCEEDED",
      existingCredit: { id: "credit_existing", amountCents: 6172 },
      amountPaid: 123.45,
      invoicePayments: [],
    });

    await expect(processStoredXeroInboundEvents()).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.memberCreditCreate).not.toHaveBeenCalled();
    expect(sendBookingCancelledEmail).not.toHaveBeenCalled();
    expect(sendAdminPaymentFailureAlert).toHaveBeenCalledTimes(1);
    const [alertArgs] = vi.mocked(sendAdminPaymentFailureAlert).mock.calls[0];
    expect(alertArgs.amountCents).toBe(6173);
    expect(alertArgs.errorMessage).toContain("$61.73");
    expect(alertArgs.errorMessage).toContain("$123.45");
    expect(alertArgs.errorMessage).toContain("$61.72");
    expect(alertArgs.errorMessage).toContain("never credits automatically");
  });

  it("caps the aggregate mint at the invoice's cash across two never-settled payments on one invoice (#1505)", async () => {
    // Two never-settled Internet Banking payments (distinct cancelled
    // bookings) are matched to ONE invoice whose cash ($100.00) covers only
    // part of their combined face ($80.00 + $80.00). The #1459 per-payment
    // clamp alone would mint min($80, $100) = $80 for EACH — $160 aggregate,
    // more than the invoice's cash. The #1505 aggregate cap apportions the
    // invoice's cash: the first payment mints its full $80, the second is
    // capped at the $20 remaining, so the aggregate is EXACTLY the invoice's
    // $100 cash — never more.
    mocks.inboundFindMany.mockResolvedValue([
      {
        id: "evt_ib_agg",
        source: "webhook",
        eventCategory: "INVOICE",
        eventType: "UPDATE",
        resourceId: "inv_ib_agg",
        correlationKey: "corr_ib_agg",
        payload: { resourceId: "inv_ib_agg" },
      },
    ]);
    mocks.processedCreate.mockResolvedValue({ id: "processed_ib_agg" });
    mocks.linkFindMany
      .mockResolvedValueOnce([
        {
          localModel: "Payment",
          localId: "pay_ib_agg_a",
          xeroObjectType: "INVOICE",
          role: "PRIMARY_INVOICE",
        },
        {
          localModel: "Payment",
          localId: "pay_ib_agg_b",
          xeroObjectType: "INVOICE",
          role: "PRIMARY_INVOICE",
        },
      ])
      .mockResolvedValueOnce([]);

    const bookingA = {
      id: "booking_ib_agg_a",
      memberId: "mem_agg_a",
      checkIn: new Date("2026-07-10"),
      checkOut: new Date("2026-07-12"),
      status: "CANCELLED",
      finalPriceCents: 8000,
      discountCents: 0,
      promoAdjustmentCents: 0,
      guests: [{ id: "guest_agg_a", nights: [] }],
      member: { email: "alice@example.com", firstName: "Alice", lastName: "Smith" },
      promoRedemption: null,
    };
    const bookingB = {
      id: "booking_ib_agg_b",
      memberId: "mem_agg_b",
      checkIn: new Date("2026-07-14"),
      checkOut: new Date("2026-07-16"),
      status: "CANCELLED",
      finalPriceCents: 8000,
      discountCents: 0,
      promoAdjustmentCents: 0,
      guests: [{ id: "guest_agg_b", nights: [] }],
      member: { email: "bob@example.com", firstName: "Bob", lastName: "Jones" },
      promoRedemption: null,
    };

    // syncLinkedPaymentInvoiceMetadata then syncInternetBankingPaymentsForPaidInvoice.
    mocks.paymentFindMany
      .mockResolvedValueOnce([
        { id: "pay_ib_agg_a", xeroInvoiceId: null, xeroInvoiceNumber: null },
        { id: "pay_ib_agg_b", xeroInvoiceId: null, xeroInvoiceNumber: null },
      ])
      .mockResolvedValueOnce([
        {
          id: "pay_ib_agg_a",
          bookingId: "booking_ib_agg_a",
          amountCents: 8000,
          status: "PENDING",
          source: "INTERNET_BANKING",
          reference: "BOOKING-AGGA",
          xeroInvoiceId: null,
          xeroInvoiceNumber: null,
          booking: bookingA,
        },
        {
          id: "pay_ib_agg_b",
          bookingId: "booking_ib_agg_b",
          amountCents: 8000,
          status: "PENDING",
          source: "INTERNET_BANKING",
          reference: "BOOKING-AGGB",
          xeroInvoiceId: null,
          xeroInvoiceNumber: null,
          booking: bookingB,
        },
      ])
      // resolveXeroAuditSubjects, resolving the audit-log subjects for the two
      // Payment→INVOICE links.
      .mockResolvedValueOnce([
        {
          id: "pay_ib_agg_a",
          bookingId: "booking_ib_agg_a",
          booking: { memberId: "mem_agg_a" },
        },
        {
          id: "pay_ib_agg_b",
          bookingId: "booking_ib_agg_b",
          booking: { memberId: "mem_agg_b" },
        },
      ]);

    const freshById: Record<string, unknown> = {
      pay_ib_agg_a: {
        id: "pay_ib_agg_a",
        bookingId: "booking_ib_agg_a",
        amountCents: 8000,
        status: "PENDING",
        source: "INTERNET_BANKING",
        reference: "BOOKING-AGGA",
        xeroInvoiceId: null,
        xeroInvoiceNumber: null,
        internetBankingHoldSlots: true,
        xeroRefundCreditNoteId: null,
        booking: bookingA,
      },
      pay_ib_agg_b: {
        id: "pay_ib_agg_b",
        bookingId: "booking_ib_agg_b",
        amountCents: 8000,
        status: "PENDING",
        source: "INTERNET_BANKING",
        reference: "BOOKING-AGGB",
        xeroInvoiceId: null,
        xeroInvoiceNumber: null,
        internetBankingHoldSlots: true,
        xeroRefundCreditNoteId: null,
        booking: bookingB,
      },
    };
    mocks.paymentFindUnique.mockImplementation(
      async ({ where }: { where: { id: string } }) => freshById[where.id] ?? null
    );
    mocks.memberCreditFindFirst.mockResolvedValue(null);
    // Simulate the DB accumulation the aggregate cap reads back under the
    // advisory lock: booking A has minted nothing when A's cap is computed;
    // A's $80.00 credit is committed and visible when B's cap is computed.
    mocks.memberCreditAggregate
      .mockResolvedValueOnce({ _sum: { amountCents: 0 } })
      .mockResolvedValueOnce({ _sum: { amountCents: 8000 } });
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_agg" });

    const txOperationUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    mocks.transaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          $executeRaw: mocks.txExecuteRaw,
          processedWebhookEvent: { deleteMany: mocks.processedDeleteMany },
          xeroInboundEvent: { update: mocks.inboundUpdate },
          payment: {
            findUnique: mocks.paymentFindUnique,
            update: mocks.paymentUpdate,
          },
          paymentTransaction: {
            updateMany: mocks.paymentTransactionUpdateMany,
            findFirst: vi.fn().mockResolvedValue({ id: "ptx_primary" }),
            create: mocks.paymentTransactionCreate,
          },
          booking: { update: mocks.bookingUpdate },
          memberCredit: {
            findFirst: mocks.memberCreditFindFirst,
            create: mocks.memberCreditCreate,
            aggregate: mocks.memberCreditAggregate,
          },
          xeroObjectLink: { findFirst: mocks.txLinkFindFirst },
          xeroSyncOperation: {
            findFirst: mocks.txOperationFindFirst,
            updateMany: txOperationUpdateMany,
          },
        })
    );

    const accountingApi = {
      getInvoice: vi.fn().mockResolvedValue({
        body: {
          invoices: [
            {
              invoiceID: "inv_ib_agg",
              invoiceNumber: "INV-IB-AGG",
              date: "2026-07-01",
              status: "PAID",
              fullyPaidOnDate: "2026-07-02",
              contact: { contactID: "contact_1" },
              amountPaid: 100.0,
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

    // Two credits: the first payment's full face, the second apportioned to the
    // invoice's remaining cash.
    const mintedAmounts = mocks.memberCreditCreate.mock.calls.map(
      ([args]) => args.data.amountCents
    );
    expect(mintedAmounts).toEqual([8000, 2000]);
    // The invariant: the aggregate mint equals EXACTLY the invoice's cash — the
    // per-payment clamp alone would have minted 8000 + 8000 = 16000.
    expect(mintedAmounts.reduce((a, b) => a + b, 0)).toBe(10000);
    expect(mocks.memberCreditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        amountCents: 8000,
        sourceBookingId: "booking_ib_agg_a",
      }),
    });
    expect(mocks.memberCreditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        amountCents: 2000,
        sourceBookingId: "booking_ib_agg_b",
      }),
    });

    // The offsetting account-credit notes mirror the minted (not face) amounts.
    const enqueuedAmounts = mocks.startXeroSyncOperation.mock.calls
      .filter(([input]) => input?.requestPayload?.queueType === "ACCOUNT_CREDIT_NOTE")
      .map(([input]) => input.requestPayload.refundAmountCents);
    expect(enqueuedAmounts).toEqual([8000, 2000]);

    // The capped payment raises a loud alert naming the aggregate-cap reason —
    // never a silent overmint.
    const cappedAlert = vi
      .mocked(sendAdminPaymentFailureAlert)
      .mock.calls.map(([args]) => args)
      .find((args) => args.amountCents === 2000);
    expect(cappedAlert).toBeDefined();
    expect(cappedAlert?.errorMessage).toContain(
      "aggregate credit across all payments on one invoice can never exceed the invoice's cash"
    );
    expect(cappedAlert?.errorMessage).toContain("remaining cash");

    // Both bookings are credited; exactly one of them is a partial (capped) mint.
    expect(mocks.auditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "xero.invoice.reconciled",
        metadata: expect.objectContaining({
          internetBankingPaymentSync: expect.objectContaining({
            creditedInternetBankingBookings: 2,
            partialCashCreditedInternetBankingBookings: 1,
          }),
        }),
      }),
    });
  });

  it("floors the mint at verified cash when an allocation component is unreadable (#1459)", async () => {
    // A usable amountPaid plus a number-less overpayment stub: the verified
    // floor mints (never the full-amount fallback, which could over-credit),
    // and the alert flags the figures as unverified.
    mockAlreadyCancelledInboundEvent({
      paymentStatus: "PENDING",
      existingCredit: null,
      amountPaid: 61.72,
      invoicePayments: [],
      invoiceOverpayments: [{ overpaymentID: "xover_degraded" }],
    });

    await expect(processStoredXeroInboundEvents()).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.memberCreditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ amountCents: 6172 }),
    });
    const [alertArgs] = vi.mocked(sendAdminPaymentFailureAlert).mock.calls[0];
    expect(alertArgs.errorMessage).toContain("mixed invoice");
    expect(alertArgs.errorMessage).toContain("could not be fully verified");
  });

  it("sizes the mint from a prepayment total when appliedAmount is absent, flagged unverified (#1459)", async () => {
    // The total is an upper bound (the prepayment may be partly applied
    // elsewhere) — still clamped, and the alert marks the figure unverified.
    mockAlreadyCancelledInboundEvent({
      paymentStatus: "PENDING",
      existingCredit: null,
      amountPaid: 0,
      invoicePayments: [],
      invoicePrepayments: [{ prepaymentID: "xpre_1", total: 61.72 }],
    });

    await expect(processStoredXeroInboundEvents()).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.memberCreditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ amountCents: 6172 }),
    });
    const [alertArgs] = vi.mocked(sendAdminPaymentFailureAlert).mock.calls[0];
    expect(alertArgs.errorMessage).toContain("mixed invoice");
    expect(alertArgs.errorMessage).toContain("could not be fully verified");
  });

  it("alerts instead of settling silently when cash-classified evidence quantifies to zero (#1459)", async () => {
    // Classifier and quantifier disagree: an overpayment entry with an
    // explicit zero allocation passes the boolean cash gate but proves no
    // money. The payment settles (gate semantics unchanged) with no credit —
    // that state must never be silent.
    mockAlreadyCancelledInboundEvent({
      paymentStatus: "PENDING",
      existingCredit: null,
      amountPaid: 0,
      invoicePayments: [],
      invoiceOverpayments: [{ overpaymentID: "xover_zero", appliedAmount: 0 }],
    });

    await expect(processStoredXeroInboundEvents()).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.memberCreditCreate).not.toHaveBeenCalled();
    const accountCreditEnqueues = mocks.startXeroSyncOperation.mock.calls.filter(
      ([input]) => input?.requestPayload?.queueType === "ACCOUNT_CREDIT_NOTE"
    );
    expect(accountCreditEnqueues).toHaveLength(0);
    expect(sendBookingCancelledEmail).not.toHaveBeenCalled();
    expect(sendAdminPaymentFailureAlert).toHaveBeenCalledTimes(1);
    const [alertArgs] = vi.mocked(sendAdminPaymentFailureAlert).mock.calls[0];
    expect(alertArgs.errorMessage).toContain("quantifies to zero");
  });

  it("clamps the mint to the payment amount when the invoice cash exceeds it (#1459)", async () => {
    // A combined or over-collected invoice can carry more cash than this
    // payment's share; the mint never exceeds the payment's own amount.
    mockAlreadyCancelledInboundEvent({
      paymentStatus: "PENDING",
      existingCredit: null,
      amountPaid: 999.99,
      invoicePayments: [],
    });

    await expect(processStoredXeroInboundEvents()).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.memberCreditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ amountCents: 12345 }),
    });
    // Full-amount mint: the standard alert, not the mixed-invoice one.
    expect(sendAdminPaymentFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 12345,
        errorMessage: expect.stringContaining("already-cancelled booking"),
      })
    );
    const [alertArgs] = vi.mocked(sendAdminPaymentFailureAlert).mock.calls[0];
    expect(alertArgs.errorMessage).not.toContain("mixed invoice");
  });

  it("sizes the mint from overpayment allocations (#1459)", async () => {
    // Operator-reconciled overpayment cash: amountPaid stays 0 (allocations
    // accrue to amountCredited) but the applied overpayment is real member
    // money — it both passes the cash gate (#1435) and sizes the mint.
    mockAlreadyCancelledInboundEvent({
      paymentStatus: "PENDING",
      existingCredit: null,
      amountPaid: 0,
      invoicePayments: [],
      invoiceOverpayments: [
        { overpaymentID: "xover_cancelled", appliedAmount: 61.72, total: 200.0 },
      ],
    });

    await expect(processStoredXeroInboundEvents()).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.memberCreditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ amountCents: 6172 }),
    });
    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        requestPayload: expect.objectContaining({
          queueType: "ACCOUNT_CREDIT_NOTE",
          refundAmountCents: 6172,
        }),
      })
    );
    expect(sendAdminPaymentFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 6172,
        errorMessage: expect.stringContaining("mixed invoice"),
      })
    );
  });

  it("falls back to the full payment amount when cash evidence is positive but unquantifiable (#1459)", async () => {
    // Degraded payload: a non-DELETED payment record with no usable amount
    // proves cash arrived but not how much. Under-crediting silently is worse
    // than the pre-#1459 behavior, so the mint falls back to the payment's
    // full amount (the fresh getInvoice fetch always carries the amount
    // fields, so this only guards degraded shapes).
    mockAlreadyCancelledInboundEvent({
      paymentStatus: "PENDING",
      existingCredit: null,
      invoicePayments: [
        { paymentID: "xpay_no_amount", status: "AUTHORISED" },
      ],
    });

    await expect(processStoredXeroInboundEvents()).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.memberCreditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ amountCents: 12345 }),
    });
    const [alertArgs] = vi.mocked(sendAdminPaymentFailureAlert).mock.calls[0];
    expect(alertArgs.errorMessage).not.toContain("mixed invoice");
    // The fallback is flagged: the operator is told the figures were not
    // verifiable from the payload.
    expect(alertArgs.errorMessage).toContain("could not be fully verified");
  });

  // A paid-then-cancelled booking's replayed event is old, already-settled
  // money: the cancellation flow applied its refund policy, and this pipeline
  // must neither mint a new credit nor clobber the refund bookkeeping.
  it("keeps refund state and mints nothing on a paid-then-cancelled replay (#1357)", async () => {
    mockAlreadyCancelledInboundEvent({
      paymentStatus: "PARTIALLY_REFUNDED",
      existingCredit: null,
    });

    await expect(processStoredXeroInboundEvents()).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    // Never settled is false — no credit despite cash evidence on the invoice.
    expect(mocks.memberCreditCreate).not.toHaveBeenCalled();
    expect(sendAdminPaymentFailureAlert).not.toHaveBeenCalled();
    // The identifier backfill runs, but the (PARTIALLY_)REFUNDED status is
    // never overwritten back to SUCCEEDED.
    for (const [args] of mocks.paymentUpdate.mock.calls) {
      expect(args.data.status).toBeUndefined();
    }
    // The PRIMARY transaction update excludes refunded rows.
    expect(mocks.paymentTransactionUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { notIn: ["REFUNDED", "PARTIALLY_REFUNDED"] },
        }),
      })
    );
  });

  // #1435: the settlement loop itself is cash-gated, not just the #1357
  // credit-minting branch — a PAID event produced by credit-note ALLOCATION
  // (the app's own bookkeeping echo) must settle nothing on the NORMAL
  // PAYMENT_PENDING path either.
  function mockPendingInternetBankingInboundEvent(params: {
    // `null` omits the payments key entirely (degraded payload shape).
    invoicePayments?: unknown[] | null;
    amountPaid?: number;
    invoiceOverpayments?: unknown[];
  }) {
    mocks.inboundFindMany.mockResolvedValue([
      {
        id: "evt_ib_gate",
        source: "webhook",
        eventCategory: "INVOICE",
        eventType: "UPDATE",
        resourceId: "inv_ib_gate",
        correlationKey: "corr_ib_gate",
        payload: { resourceId: "inv_ib_gate" },
      },
    ]);
    mocks.processedCreate.mockResolvedValue({ id: "processed_ib_gate" });
    mocks.linkFindMany
      .mockResolvedValueOnce([
        {
          localModel: "Payment",
          localId: "pay_ib_gate",
          xeroObjectType: "INVOICE",
          role: "PRIMARY_INVOICE",
        },
      ])
      .mockResolvedValueOnce([]);
    const booking = {
      id: "booking_ib_gate",
      memberId: "mem_gate",
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
      guests: [{ id: "guest_gate" }],
      promoRedemption: null,
    };
    mocks.paymentFindMany
      .mockResolvedValueOnce([
        { id: "pay_ib_gate", xeroInvoiceId: null, xeroInvoiceNumber: null },
      ])
      .mockResolvedValueOnce([
        {
          id: "pay_ib_gate",
          bookingId: "booking_ib_gate",
          amountCents: 12345,
          status: "PENDING",
          source: "INTERNET_BANKING",
          reference: "BOOKING-GATE1234",
          xeroInvoiceId: null,
          xeroInvoiceNumber: null,
          booking,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "pay_ib_gate",
          bookingId: "booking_ib_gate",
          booking: { memberId: "mem_gate" },
        },
      ]);
    mocks.paymentFindUnique.mockResolvedValue({
      id: "pay_ib_gate",
      bookingId: "booking_ib_gate",
      amountCents: 12345,
      status: "PENDING",
      source: "INTERNET_BANKING",
      reference: "BOOKING-GATE1234",
      xeroInvoiceId: null,
      xeroInvoiceNumber: null,
      internetBankingHoldSlots: true,
      booking,
    });
    mocks.subscriptionFindMany.mockResolvedValue([]);
    const accountingApi = {
      getInvoice: vi.fn().mockResolvedValue({
        body: {
          invoices: [
            {
              invoiceID: "inv_ib_gate",
              invoiceNumber: "INV-IB-GATE",
              date: "2026-07-01",
              status: "PAID",
              fullyPaidOnDate: "2026-07-02",
              contact: { contactID: "contact_1" },
              ...(params.amountPaid !== undefined
                ? { amountPaid: params.amountPaid }
                : {}),
              ...(params.invoicePayments === null
                ? {}
                : {
                    payments: params.invoicePayments ?? [
                      {
                        paymentID: "xpay_ib_gate",
                        amount: 123.45,
                        invoiceNumber: "INV-IB-GATE",
                        status: "AUTHORISED",
                      },
                    ],
                  }),
              ...(params.invoiceOverpayments !== undefined
                ? { overpayments: params.invoiceOverpayments }
                : {}),
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
  }

  it("does not settle the payment or booking when the PAID invoice was cleared by credit allocation (#1435)", async () => {
    mockPendingInternetBankingInboundEvent({
      amountPaid: 0,
      invoicePayments: [],
    });

    await expect(processStoredXeroInboundEvents()).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    // Nothing settles anywhere in the loop: the PENDING payment and its
    // PRIMARY transaction keep their status, the booking stays
    // PAYMENT_PENDING, and no confirmation goes out — the invoice was
    // cleared by a credit note, not cash. The only writes are identifier
    // stamps (linkage, never status).
    expect(mocks.paymentTransactionCreate).not.toHaveBeenCalled();
    for (const [args] of mocks.paymentTransactionUpdateMany.mock.calls) {
      expect(args.data.status).toBeUndefined();
    }
    expect(mocks.paymentTransactionUpdateMany).toHaveBeenCalledWith({
      where: {
        paymentId: { in: ["pay_ib_gate"] },
        source: "INTERNET_BANKING",
        kind: "PRIMARY",
        xeroInvoiceId: null,
      },
      data: {
        xeroInvoiceId: "inv_ib_gate",
        xeroInvoiceNumber: "INV-IB-GATE",
      },
    });
    for (const [args] of mocks.paymentUpdate.mock.calls) {
      expect(args.data.status).toBeUndefined();
    }
    expect(mocks.bookingUpdate).not.toHaveBeenCalled();
    expect(mocks.memberCreditCreate).not.toHaveBeenCalled();
    expect(mocks.recordBookingEvent).not.toHaveBeenCalled();
    expect(sendBookingConfirmedEmail).not.toHaveBeenCalled();
    // The booking is still LIVE (PAYMENT_PENDING) — an operator cleared its
    // invoice in Xero, and nothing else will ever settle or expire it, so
    // the admins are alerted instead of parking it silently.
    expect(sendAdminPaymentFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 12345,
        errorMessage: expect.stringContaining("credit-note allocation"),
        paymentIntentId: "inv_ib_gate",
      })
    );
    // The skip is visible: counted in the reconcile result that lands in the
    // inbound audit metadata.
    expect(mocks.auditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "xero.invoice.reconciled",
        metadata: expect.objectContaining({
          internetBankingPaymentSync: expect.objectContaining({
            matchedInternetBankingPayments: 1,
            skippedNoCashEvidencePayments: 1,
            paidInternetBankingBookings: 0,
          }),
        }),
      }),
    });
  });

  it("settles a mixed cash-plus-credit invoice on its cash evidence (#1435)", async () => {
    // Part of the invoice arrived as cash, the rest was credit-allocated:
    // Xero reports PAID with a positive amountPaid (allocations accrue to
    // amountCredited). Cash evidence present — settlement proceeds.
    mockPendingInternetBankingInboundEvent({ amountPaid: 61.72 });

    await expect(processStoredXeroInboundEvents()).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.paymentUpdate).toHaveBeenCalledWith({
      where: { id: "pay_ib_gate" },
      data: {
        status: "SUCCEEDED",
        xeroInvoiceId: "inv_ib_gate",
        xeroInvoiceNumber: "INV-IB-GATE",
      },
    });
    expect(mocks.bookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "booking_ib_gate", status: "PAYMENT_PENDING" },
      data: { status: "PAID", draftExpiresAt: null },
    });
    expect(sendBookingConfirmedEmail).toHaveBeenCalled();
  });

  it("fails the event when the PAID payload carries neither amountPaid nor payments (#1435 owner default)", async () => {
    mockPendingInternetBankingInboundEvent({ invoicePayments: null });

    // Owner-approved default: a payload that proves nothing settles nothing
    // — and instead of completing as a terminal silent skip, the event FAILS
    // into the inbound retry machinery, which re-fetches the invoice fresh
    // on every sweep. A transient payload degradation self-heals; a
    // persistent one stays loud and operator-replayable.
    await expect(processStoredXeroInboundEvents()).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 0,
      failed: 1,
      skipped: 0,
    });

    expect(mocks.inboundUpdate).toHaveBeenCalledWith({
      where: { id: "evt_ib_gate" },
      data: expect.objectContaining({
        status: "FAILED",
        errorMessage: expect.stringContaining("cash evidence"),
      }),
    });
    // Nothing settled and nothing was stamped: the evidence was
    // indeterminate, not a confirmed allocation-only PAID.
    expect(mocks.paymentTransactionUpdateMany).not.toHaveBeenCalled();
    expect(mocks.paymentTransactionCreate).not.toHaveBeenCalled();
    expect(mocks.paymentUpdateMany).not.toHaveBeenCalled();
    for (const [args] of mocks.paymentUpdate.mock.calls) {
      expect(args.data.status).toBeUndefined();
    }
    expect(mocks.bookingUpdate).not.toHaveBeenCalled();
    expect(sendBookingConfirmedEmail).not.toHaveBeenCalled();
    expect(sendAdminPaymentFailureAlert).not.toHaveBeenCalled();
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: "inv_ib_gate", matchedPayments: 1 }),
      expect.stringContaining("neither amountPaid nor payments")
    );
  });

  it("settles when the invoice was cleared by an operator-applied overpayment (#1435)", async () => {
    // Real member money reconciled Xero-side as an Overpayment and allocated
    // to the invoice: amountPaid stays 0 (allocations accrue to
    // amountCredited), but the overpayments collection is present. The app
    // itself can only produce credit-note allocations, so this can never be
    // the clearing-note echo — it must settle.
    mockPendingInternetBankingInboundEvent({
      amountPaid: 0,
      invoicePayments: [],
      invoiceOverpayments: [{ overpaymentID: "xover_1", total: 123.45 }],
    });

    await expect(processStoredXeroInboundEvents()).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.bookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "booking_ib_gate", status: "PAYMENT_PENDING" },
      data: { status: "PAID", draftExpiresAt: null },
    });
    expect(sendBookingConfirmedEmail).toHaveBeenCalled();
    expect(sendAdminPaymentFailureAlert).not.toHaveBeenCalled();
  });

  it("treats DELETED payment records as no cash evidence (#1435)", async () => {
    // amountPaid absent, and the only payment record was reversed: the
    // fallback must not read a DELETED payment as money.
    mockPendingInternetBankingInboundEvent({
      invoicePayments: [
        { paymentID: "xpay_deleted", amount: 123.45, status: "DELETED" },
      ],
    });

    await expect(processStoredXeroInboundEvents()).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.paymentTransactionCreate).not.toHaveBeenCalled();
    for (const [args] of mocks.paymentTransactionUpdateMany.mock.calls) {
      expect(args.data.status).toBeUndefined();
    }
    expect(mocks.bookingUpdate).not.toHaveBeenCalled();
    expect(sendBookingConfirmedEmail).not.toHaveBeenCalled();
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
              // #1435: group settlement is cash-gated too — the paid
              // fixture carries real cash evidence.
              amountPaid: 246.9,
              payments: [
                {
                  paymentID: "xpay_settle_1",
                  amount: 246.9,
                  invoiceNumber: "INV-SETTLE-001",
                  status: "AUTHORISED",
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

  it("fails the inbound event when applying a paid group settlement throws, so it is retried (#1887)", async () => {
    // A transient apply failure (DB contention, lock timeout, capacity-lock
    // conflict) must not complete the event as PROCESSED: the settlement
    // would sit PENDING forever — never retried — while the organiser's
    // money is in the bank, and the group-settlement expiry path could later
    // cancel the whole group's child bookings despite payment. Same durable
    // deferral as #1435: the event FAILS into the inbound retry machinery,
    // which re-fetches the invoice fresh on every backoff sweep.
    mocks.inboundFindMany.mockResolvedValue([
      {
        id: "evt_settle_retry",
        source: "webhook",
        eventCategory: "INVOICE",
        eventType: "UPDATE",
        resourceId: "inv_settle_retry",
        correlationKey: "corr_settle_retry",
        payload: { resourceId: "inv_settle_retry" },
      },
    ]);
    mocks.processedCreate.mockResolvedValue({ id: "processed_settle_retry" });
    mocks.linkFindMany.mockResolvedValue([]);
    mocks.xeroSyncOperationFindMany.mockResolvedValue([]);
    mocks.paymentFindMany.mockResolvedValue([]);
    mocks.subscriptionFindMany.mockResolvedValue([]);
    mocks.groupSettlementFindFirst.mockResolvedValue({
      id: "settle_retry",
      status: "PENDING",
    });
    mocks.applyGroupSettlementFromInvoice.mockRejectedValue(
      new Error("lock timeout applying group settlement")
    );
    const accountingApi = {
      getInvoice: vi.fn().mockResolvedValue({
        body: {
          invoices: [
            {
              invoiceID: "inv_settle_retry",
              invoiceNumber: "INV-SETTLE-RETRY",
              date: "2026-07-01",
              status: "PAID",
              fullyPaidOnDate: "2026-07-02",
              contact: { contactID: "contact_1" },
              amountPaid: 246.9,
              payments: [
                {
                  paymentID: "xpay_settle_retry",
                  amount: 246.9,
                  invoiceNumber: "INV-SETTLE-RETRY",
                  status: "AUTHORISED",
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
      succeeded: 0,
      failed: 1,
      skipped: 0,
    });

    expect(mocks.applyGroupSettlementFromInvoice).toHaveBeenCalledWith(
      "inv_settle_retry"
    );
    expect(mocks.inboundUpdate).toHaveBeenCalledWith({
      where: { id: "evt_settle_retry" },
      data: expect.objectContaining({
        status: "FAILED",
        errorMessage: expect.stringContaining("lock timeout"),
      }),
    });
    // Nothing was settled and no child booking flipped PAID on this pass.
    expect(mocks.bookingUpdate).not.toHaveBeenCalled();
  });

  it("keeps a mismatched group settlement terminal: alerts admins without failing the event (#1033)", async () => {
    // amount_mismatch is an expected business outcome (a child booking
    // changed while the combined invoice sat open), not a transient fault:
    // the event completes PROCESSED — no FAILED retry loop — and operators
    // are alerted to reconcile manually.
    mocks.inboundFindMany.mockResolvedValue([
      {
        id: "evt_settle_mismatch",
        source: "webhook",
        eventCategory: "INVOICE",
        eventType: "UPDATE",
        resourceId: "inv_settle_mismatch",
        correlationKey: "corr_settle_mismatch",
        payload: { resourceId: "inv_settle_mismatch" },
      },
    ]);
    mocks.processedCreate.mockResolvedValue({ id: "processed_settle_mismatch" });
    mocks.linkFindMany.mockResolvedValue([]);
    mocks.xeroSyncOperationFindMany.mockResolvedValue([]);
    mocks.paymentFindMany.mockResolvedValue([]);
    mocks.subscriptionFindMany.mockResolvedValue([]);
    mocks.groupSettlementFindFirst.mockResolvedValue({
      id: "settle_mismatch",
      status: "PENDING",
    });
    mocks.applyGroupSettlementFromInvoice.mockResolvedValue({
      outcome: "amount_mismatch",
      settledBookingIds: [],
    });
    mocks.groupSettlementFindUnique.mockResolvedValue({
      amountCents: 24690,
      groupBooking: {
        organiserMember: { firstName: "Olive", lastName: "Organiser" },
        organiserBooking: {
          checkIn: new Date("2026-08-01T00:00:00.000Z"),
          checkOut: new Date("2026-08-03T00:00:00.000Z"),
        },
      },
    });
    const accountingApi = {
      getInvoice: vi.fn().mockResolvedValue({
        body: {
          invoices: [
            {
              invoiceID: "inv_settle_mismatch",
              invoiceNumber: "INV-SETTLE-MISMATCH",
              date: "2026-07-01",
              status: "PAID",
              fullyPaidOnDate: "2026-07-02",
              contact: { contactID: "contact_1" },
              amountPaid: 246.9,
              payments: [
                {
                  paymentID: "xpay_settle_mismatch",
                  amount: 246.9,
                  invoiceNumber: "INV-SETTLE-MISMATCH",
                  status: "AUTHORISED",
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

    expect(sendAdminPaymentFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        memberName: "Olive Organiser",
        amountCents: 24690,
        errorMessage: expect.stringContaining("no longer matches"),
        paymentIntentId: "inv_settle_mismatch",
      })
    );
    // The settlement stays PENDING for manual reconciliation: no child
    // booking flipped PAID.
    expect(mocks.bookingUpdate).not.toHaveBeenCalled();
  });

  it("alerts operators when a paid group invoice is fenced by cancellation (#1881)", async () => {
    mocks.inboundFindMany.mockResolvedValue([
      {
        id: "evt_settle_cancelled",
        source: "webhook",
        eventCategory: "INVOICE",
        eventType: "UPDATE",
        resourceId: "inv_settle_cancelled",
        correlationKey: "corr_settle_cancelled",
        payload: { resourceId: "inv_settle_cancelled" },
      },
    ]);
    mocks.processedCreate.mockResolvedValue({ id: "processed_settle_cancelled" });
    mocks.linkFindMany.mockResolvedValue([]);
    mocks.xeroSyncOperationFindMany.mockResolvedValue([]);
    mocks.paymentFindMany.mockResolvedValue([]);
    mocks.subscriptionFindMany.mockResolvedValue([]);
    mocks.groupSettlementFindFirst.mockResolvedValue({
      id: "settle_cancelled",
      status: "FAILED",
    });
    mocks.applyGroupSettlementFromInvoice.mockResolvedValue({
      outcome: "cancelled",
      settledBookingIds: [],
    });
    mocks.groupSettlementFindUnique.mockResolvedValue({
      amountCents: 24690,
      groupBooking: {
        organiserMember: { firstName: "Olive", lastName: "Organiser" },
        organiserBooking: {
          checkIn: new Date("2026-08-01T00:00:00.000Z"),
          checkOut: new Date("2026-08-03T00:00:00.000Z"),
        },
      },
    });
    const accountingApi = {
      getInvoice: vi.fn().mockResolvedValue({
        body: {
          invoices: [
            {
              invoiceID: "inv_settle_cancelled",
              invoiceNumber: "INV-SETTLE-CANCELLED",
              date: "2026-07-01",
              status: "PAID",
              fullyPaidOnDate: "2026-07-02",
              contact: { contactID: "contact_1" },
              amountPaid: 246.9,
              payments: [
                {
                  paymentID: "xpay_settle_cancelled",
                  amount: 246.9,
                  invoiceNumber: "INV-SETTLE-CANCELLED",
                  status: "AUTHORISED",
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

    expect(sendAdminPaymentFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        memberName: "Olive Organiser",
        amountCents: 24690,
        errorMessage: expect.stringContaining("paid after the organiser cancelled"),
        paymentIntentId: "inv_settle_cancelled",
      })
    );
    expect(mocks.bookingUpdate).not.toHaveBeenCalled();
  });

  it("does not settle a group when its combined invoice was cleared by credit allocation (#1435)", async () => {
    mocks.inboundFindMany.mockResolvedValue([
      {
        id: "evt_settle_alloc",
        source: "webhook",
        eventCategory: "INVOICE",
        eventType: "UPDATE",
        resourceId: "inv_settle_alloc",
        correlationKey: "corr_settle_alloc",
        payload: { resourceId: "inv_settle_alloc" },
      },
    ]);
    mocks.processedCreate.mockResolvedValue({ id: "processed_settle_alloc" });
    mocks.linkFindMany.mockResolvedValue([]);
    mocks.xeroSyncOperationFindMany.mockResolvedValue([]);
    mocks.paymentFindMany.mockResolvedValue([]);
    mocks.subscriptionFindMany.mockResolvedValue([]);
    mocks.groupSettlementFindFirst.mockResolvedValue({
      id: "settle_alloc",
      status: "PENDING",
    });
    const accountingApi = {
      getInvoice: vi.fn().mockResolvedValue({
        body: {
          invoices: [
            {
              invoiceID: "inv_settle_alloc",
              invoiceNumber: "INV-SETTLE-ALLOC",
              date: "2026-07-01",
              status: "PAID",
              fullyPaidOnDate: "2026-07-02",
              contact: { contactID: "contact_1" },
              // Written off in Xero with a credit note: PAID, zero cash.
              amountPaid: 0,
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

    // Zero cash: the settlement stays PENDING (the group-settlement reaper
    // owns its expiry), and no child booking flips PAID.
    expect(mocks.applyGroupSettlementFromInvoice).not.toHaveBeenCalled();
    expect(mocks.bookingUpdate).not.toHaveBeenCalled();
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

  it("repairs an admin-adjustment-minted note (no CANCELLATION_REFUND provenance) whose final allocation was deleted in Xero (#1925)", async () => {
    mocks.inboundFindMany.mockResolvedValue([
      {
        id: "evt_1925",
        source: "webhook",
        eventCategory: "CREDIT_NOTE",
        eventType: "UPDATE",
        resourceId: "cn_admin_1",
        correlationKey: "corr_1925",
        payload: { resourceId: "cn_admin_1" },
      },
    ]);
    mocks.processedCreate.mockResolvedValue({ id: "processed_1925" });

    // No CANCELLATION_REFUND rows exist for this note; the fallback (#1925)
    // resolves the applied-credit context from the precise slice + active link.
    mocks.memberCreditNoteAllocationFindMany.mockResolvedValue([
      {
        id: "slice_admin_1",
        appliedToBookingId: "bk_admin_1",
        memberCredit: { memberId: "mem_admin_1" },
      },
    ]);

    mocks.linkFindMany.mockImplementation(async (args?: { where?: Record<string, unknown> }) => {
      const where = (args?.where ?? {}) as {
        xeroObjectType?: string;
        role?: { in?: string[] } | string;
      };
      if (where.xeroObjectType === "CREDIT_NOTE") {
        // No pre-existing ACCOUNT_CREDIT_NOTE link: the gate must open via the
        // #1925 local-provenance fallback, not an inherited link.
        return [];
      }
      if (
        where.xeroObjectType === "ALLOCATION" &&
        typeof where.role === "object" &&
        where.role?.in?.includes("APPLIED_CREDIT_ALLOCATION")
      ) {
        // Active allocation link proving Xero previously carried the allocation
        // (used by both the fallback resolver and the deleted-target diff).
        return [
          {
            localModel: "MemberCreditNoteAllocation",
            localId: "slice_admin_1",
            metadata: {
              creditNoteId: "cn_admin_1",
              invoiceId: "inv_admin_1",
              amountCents: 3000,
            },
          },
        ];
      }
      return [];
    });

    mocks.memberCreditFindMany.mockImplementation(async (args?: { where?: { type?: string } }) => {
      const type = args?.where?.type;
      if (type === "CANCELLATION_REFUND") {
        return []; // force the #1925 fallback
      }
      if (type === "BOOKING_APPLIED") {
        return [
          {
            id: "hist_admin_1",
            amountCents: -3000,
            description: "Applied to booking bk_admin_",
            xeroCreditNoteId: "cn_admin_1",
          },
        ];
      }
      return [];
    });

    mocks.paymentFindMany.mockImplementation(
      async (args?: { where?: Record<string, unknown>; select?: Record<string, unknown> }) => {
        const where = (args?.where ?? {}) as {
          id?: { in?: string[] };
          booking?: { memberId?: string };
          OR?: Array<Record<string, unknown>>;
        };
        if (where.id?.in) {
          if (args?.select?.refundedAmountCents) {
            return [
              {
                id: "pay_admin_1",
                amountCents: 12000,
                refundedAmountCents: 0,
                status: "SUCCEEDED",
                source: "INTERNET_BANKING",
              },
            ];
          }
          return [
            {
              id: "pay_admin_1",
              bookingId: "bk_admin_1",
              booking: { memberId: "mem_admin_1" },
            },
          ];
        }
        if (where.booking?.memberId) {
          return [{ id: "pay_admin_1", bookingId: "bk_admin_1" }];
        }
        if (where.OR) {
          const isDirectRefundLookup = where.OR.some(
            (clause) => "xeroRefundCreditNoteId" in clause,
          );
          if (isDirectRefundLookup) {
            return [];
          }
          return [
            {
              id: "pay_admin_1",
              bookingId: "bk_admin_1",
              amountCents: 12000,
              creditAppliedCents: 3000,
              booking: { memberId: "mem_admin_1" },
            },
          ];
        }
        return [];
      },
    );

    mocks.memberCreditUpdateMany.mockResolvedValue({ count: 0 });
    mocks.memberCreditNoteAllocationAggregate.mockResolvedValue({
      _sum: { amountCents: 0 },
    });
    mocks.memberCreditAggregate
      .mockResolvedValueOnce({ _sum: { amountCents: 0 } }) // unstamped
      .mockResolvedValueOnce({ _sum: { amountCents: -3000 } }) // current ledger
      .mockResolvedValue({ _sum: { amountCents: 0 } }); // post-offset total
    mocks.paymentFindUnique.mockResolvedValue({ creditAppliedCents: 3000 });
    mocks.memberCreditCreate.mockResolvedValue({});
    mocks.repairLegacyAppliedCreditNoteAllocationsForBooking.mockResolvedValue(0);

    const accountingApi = {
      getCreditNote: vi.fn().mockResolvedValue({
        body: {
          creditNotes: [
            {
              creditNoteID: "cn_admin_1",
              creditNoteNumber: "CN-ADMIN-001",
              total: 30,
              appliedAmount: 0,
              remainingCredit: 30,
              allocations: [], // final allocation deleted at the provider
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

    // The deleted final allocation is reconciled to zero: a single +3000 offset
    // is appended (append-only) to net the historical -3000 application.
    expect(mocks.memberCreditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        amountCents: 3000,
        type: "BOOKING_APPLIED",
        appliedToBookingId: "bk_admin_1",
        xeroCreditNoteId: "cn_admin_1",
      }),
    });
    expect(mocks.paymentUpdate).toHaveBeenCalledWith({
      where: { id: "pay_admin_1" },
      data: { creditAppliedCents: 0 },
    });
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      "op_1",
      expect.objectContaining({
        responsePayload: expect.objectContaining({
          // The fallback opened the applied-credit repair gate for a note with
          // no CANCELLATION_REFUND provenance, and the deleted-final-allocation
          // reconciliation ran against the resolved payment.
          matchedAccountCreditPayments: 1,
          matchedAllocatedPayments: 1,
          updatedAppliedPayments: 1,
        }),
      }),
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
          amountCents: 12000,
          creditAppliedCents: 0,
          booking: {
            memberId: "mem_credit_1",
          },
        },
      ]);
    // The applied-credit repair re-reads the payment's current creditAppliedCents
    // under the advisory lock before comparing against the aggregated total.
    mocks.paymentFindUnique.mockResolvedValue({ creditAppliedCents: 0 });
    mocks.memberCreditNoteAllocationAggregate.mockResolvedValue({
      _sum: { amountCents: 2500 },
    });
    mocks.memberCreditAggregate
      .mockResolvedValueOnce({ _sum: { amountCents: 0 } })
      .mockResolvedValueOnce({ _sum: { amountCents: -2500 } })
      .mockResolvedValue({ _sum: { amountCents: -2500 } });
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

  it("reconciles deletion of the final account-credit allocation from the inbound provider response", async () => {
    mocks.inboundFindMany.mockResolvedValue([{
      id: "evt_delete_alloc",
      source: "webhook",
      eventCategory: "CREDIT_NOTE",
      eventType: "UPDATE",
      resourceId: "cn_credit_delete_alloc",
      correlationKey: "corr_delete_alloc",
      payload: { resourceId: "cn_credit_delete_alloc" },
    }]);
    mocks.processedCreate.mockResolvedValue({ id: "processed_delete_alloc" });
    mocks.linkFindMany
      .mockResolvedValueOnce([{
        localModel: "Payment",
        localId: "pay_credit_source_1",
        xeroObjectType: "CREDIT_NOTE",
        role: "ACCOUNT_CREDIT_NOTE",
      }])
      .mockResolvedValueOnce([{
        localId: "pay_credit_source_1",
        xeroObjectId: "cn_credit_delete_alloc",
        metadata: { total: 97, status: "AUTHORISED" },
      }])
      .mockResolvedValueOnce([])
      // Provider allocations are now empty, but this still-active completion
      // link proves the note previously targeted inv_booking_1.
      .mockResolvedValueOnce([{
        metadata: {
          creditNoteId: "cn_credit_delete_alloc",
          invoiceId: "inv_booking_1",
          amountCents: 2500,
        },
      }])
      .mockResolvedValueOnce([]);
    mocks.paymentFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: "pay_credit_source_1",
        bookingId: "bk123456789",
        booking: { memberId: "mem_credit_1" },
      }])
      .mockResolvedValueOnce([{
        id: "pay_credit_source_1",
        amountCents: 12000,
        refundedAmountCents: 0,
        status: "SUCCEEDED",
      }])
      .mockResolvedValueOnce([{
        id: "pay_booking_1",
        bookingId: "bk234567890",
        xeroInvoiceId: "inv_booking_1",
        amountCents: 12000,
        creditAppliedCents: 2500,
        booking: { memberId: "mem_credit_1" },
      }]);
    mocks.memberCreditFindMany.mockResolvedValue([{
      id: "historical_applied_1",
      amountCents: -2500,
      description: "Applied to booking bk234567",
      xeroCreditNoteId: "cn_credit_delete_alloc",
    }]);
    mocks.paymentFindUnique.mockResolvedValue({ creditAppliedCents: 2500 });
    mocks.memberCreditNoteAllocationAggregate.mockResolvedValue({
      _sum: { amountCents: 0 },
    });
    mocks.memberCreditAggregate
      .mockResolvedValueOnce({ _sum: { amountCents: 0 } })
      .mockResolvedValueOnce({ _sum: { amountCents: -2500 } })
      .mockResolvedValue({ _sum: { amountCents: 0 } });
    mocks.getAuthenticatedXeroClient.mockResolvedValue({
      xero: {
        accountingApi: {
          getCreditNote: vi.fn().mockResolvedValue({
            body: {
              creditNotes: [{
                creditNoteID: "cn_credit_delete_alloc",
                creditNoteNumber: "CN-AC-DELETE-001",
                total: 97,
                appliedAmount: 0,
                remainingCredit: 97,
                allocations: [],
                payments: [],
              }],
            },
          }),
        },
      },
      tenantId: "tenant_1",
    });

    await expect(processStoredXeroInboundEvents()).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });
    expect(
      mocks.repairLegacyAppliedCreditNoteAllocationsForBooking,
    ).toHaveBeenCalledWith(
      "bk234567890",
      "inv_booking_1",
      expect.anything(),
      {
        providerTarget: {
          xeroCreditNoteId: "cn_credit_delete_alloc",
          amountCents: 0,
        },
      },
    );
    expect(mocks.memberCreditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        amountCents: 2500,
        xeroCreditNoteId: "cn_credit_delete_alloc",
      }),
    });
    expect(mocks.paymentUpdate).toHaveBeenCalledWith({
      where: { id: "pay_booking_1" },
      data: { creditAppliedCents: 0 },
    });
  });

  it("repairs applied-credit ledger state atomically under the advisory lock and clamps to the payment amount", async () => {
    mocks.inboundFindMany.mockResolvedValue([
      {
        id: "evt_clamp",
        source: "webhook",
        eventCategory: "CREDIT_NOTE",
        eventType: "UPDATE",
        resourceId: "cn_credit_clamp",
        correlationKey: "corr_clamp",
        payload: { resourceId: "cn_credit_clamp" },
      },
    ]);
    mocks.processedCreate.mockResolvedValue({ id: "processed_clamp" });
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
          xeroObjectId: "cn_credit_clamp",
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
          // The applied-credit aggregate below (5000) exceeds this payment amount,
          // so the write must clamp to amountCents (2000), never over-credit.
          amountCents: 2000,
          creditAppliedCents: 0,
          booking: {
            memberId: "mem_credit_1",
          },
        },
      ]);
    mocks.paymentFindUnique.mockResolvedValue({ creditAppliedCents: 0 });
    mocks.memberCreditNoteAllocationAggregate.mockResolvedValue({
      _sum: { amountCents: 5000 },
    });
    mocks.memberCreditAggregate
      .mockResolvedValueOnce({ _sum: { amountCents: 0 } })
      .mockResolvedValueOnce({ _sum: { amountCents: -5000 } })
      .mockResolvedValue({ _sum: { amountCents: -5000 } });
    const accountingApi = {
      getCreditNote: vi.fn().mockResolvedValue({
        body: {
          creditNotes: [
            {
              creditNoteID: "cn_credit_clamp",
              creditNoteNumber: "CN-AC-CLAMP-001",
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

    // The repair runs inside a per-payment transaction whose first statement is
    // the shared reconcile advisory lock.
    expect(mocks.transaction).toHaveBeenCalled();
    expect(mocks.txExecuteRaw).toHaveBeenCalled();
    expect(
      mocks.repairLegacyAppliedCreditNoteAllocationsForBooking,
    ).toHaveBeenCalledWith(
      "bk234567890",
      "inv_booking_1",
      expect.anything(),
      {
        providerTarget: {
          xeroCreditNoteId: "cn_credit_clamp",
          amountCents: 2500,
        },
      },
    );
    // Clamped to the payment amount, not the raw 5000 aggregate.
    expect(mocks.paymentUpdate).toHaveBeenCalledWith({
      where: { id: "pay_booking_1" },
      data: {
        creditAppliedCents: 2000,
      },
    });
  });
});

describe("runXeroInboundReconciliationCycle", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.inboundUpdateMany.mockResolvedValue({ count: 1 });
    mocks.xeroSyncOperationFindMany.mockResolvedValue([]);
    mocks.processedCreate.mockRejectedValue({ code: "P2002" });
    // #2109 FIX-3 defaults (see the processStored describe for rationale).
    mocks.buildSubscriptionInvoiceMatchOptions.mockResolvedValue({
      accountCode: "203",
      itemCodes: [],
      primaryItemCode: null,
      textFallbackEnabled: true,
    });
    mocks.hasStrongSubscriptionInvoiceMatch.mockImplementation(
      (
        invoices: Array<{
          lineItems?: Array<{ accountCode?: string }>;
          reference?: string;
        }>,
      ) =>
        invoices.some(
          (invoice) =>
            invoice.lineItems?.some(
              (lineItem) => lineItem.accountCode === "203",
            ) ||
            (invoice.reference ?? "")
              .toLowerCase()
              .includes("annual member subscription"),
        ),
    );
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
        $executeRaw: mocks.txExecuteRaw,
        $queryRaw: mocks.txExecuteRaw,
        lodge: {
          findFirst: mocks.lodgeFindFirst,
        },
        processedWebhookEvent: {
          deleteMany: mocks.processedDeleteMany,
        },
        xeroInboundEvent: {
          update: mocks.inboundUpdate,
        },
        payment: {
          findUnique: mocks.paymentFindUnique,
          update: mocks.paymentUpdate,
        },
        paymentTransaction: {
          updateMany: mocks.paymentTransactionUpdateMany,
          create: mocks.paymentTransactionCreate,
        },
        booking: {
          update: mocks.bookingUpdate,
          updateMany: mocks.bookingUpdateMany,
        },
        memberCredit: {
          findFirst: mocks.memberCreditFindFirst,
          findMany: mocks.memberCreditFindMany,
          create: mocks.memberCreditCreate,
          update: mocks.memberCreditUpdate,
          aggregate: mocks.memberCreditAggregate,
        },
      })
    );
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_replay" });
    // #2109 FIX-3 defaults (see the processStored describe for rationale).
    mocks.buildSubscriptionInvoiceMatchOptions.mockResolvedValue({
      accountCode: "203",
      itemCodes: [],
      primaryItemCode: null,
      textFallbackEnabled: true,
    });
    mocks.hasStrongSubscriptionInvoiceMatch.mockImplementation(
      (
        invoices: Array<{
          lineItems?: Array<{ accountCode?: string }>;
          reference?: string;
        }>,
      ) =>
        invoices.some(
          (invoice) =>
            invoice.lineItems?.some(
              (lineItem) => lineItem.accountCode === "203",
            ) ||
            (invoice.reference ?? "")
              .toLowerCase()
              .includes("annual member subscription"),
        ),
    );
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
