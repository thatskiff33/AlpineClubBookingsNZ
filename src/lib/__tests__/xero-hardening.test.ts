import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  memberFindMany: vi.fn(),
  paymentFindMany: vi.fn(),
  subscriptionFindMany: vi.fn(),
  linkFindMany: vi.fn(),
  linkCreateMany: vi.fn(),
  operationCount: vi.fn(),
  operationFindMany: vi.fn(),
  operationCreateMany: vi.fn(),
  emailFindFirst: vi.fn(),
  sendRepeatedFailureAlert: vi.fn(),
  sendReconciliationReportAlert: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findMany: mocks.memberFindMany,
    },
    payment: {
      findMany: mocks.paymentFindMany,
    },
    memberSubscription: {
      findMany: mocks.subscriptionFindMany,
    },
    xeroObjectLink: {
      findMany: mocks.linkFindMany,
      createMany: mocks.linkCreateMany,
    },
    xeroSyncOperation: {
      count: mocks.operationCount,
      findMany: mocks.operationFindMany,
      createMany: mocks.operationCreateMany,
    },
    emailLog: {
      findFirst: mocks.emailFindFirst,
    },
  },
}));

vi.mock("@/lib/email", () => ({
  sendAdminXeroRepeatedFailureAlert: mocks.sendRepeatedFailureAlert,
  sendAdminXeroReconciliationReportAlert: mocks.sendReconciliationReportAlert,
}));

vi.mock("@/lib/logger", () => ({
  default: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  backfillHistoricalXeroObjectLinks,
  buildXeroReconciliationReport,
  maybeNotifyXeroRepeatedFailure,
} from "@/lib/xero-hardening";

describe("maybeNotifyXeroRepeatedFailure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.operationCount.mockResolvedValue(3);
    mocks.emailFindFirst.mockResolvedValue(null);
    mocks.sendRepeatedFailureAlert.mockResolvedValue(undefined);
  });

  it("sends an alert once a correlation key has repeated failures", async () => {
    const result = await maybeNotifyXeroRepeatedFailure({
      id: "op_1",
      correlationKey: "payment:pay_1:invoice:v1",
      entityType: "INVOICE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: "pay_1",
      lastErrorMessage: "Rate limit exceeded",
      xeroObjectType: "INVOICE",
      xeroObjectId: "inv_1",
      xeroObjectUrl: null,
    });

    expect(result).toEqual({
      triggered: true,
      failureCount: 3,
    });
    expect(mocks.sendRepeatedFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "Repeated Xero Failure: payment:pay_1:invoice:v1",
        correlationKey: "payment:pay_1:invoice:v1",
        failureCount: 3,
        localUrl: "/admin/xero/records/Payment/pay_1",
      })
    );
  });

  it("suppresses alerts when one has already been sent in the current window", async () => {
    mocks.emailFindFirst.mockResolvedValue({ id: "email_1" });

    const result = await maybeNotifyXeroRepeatedFailure({
      id: "op_1",
      correlationKey: "payment:pay_1:invoice:v1",
      entityType: "INVOICE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: "pay_1",
      lastErrorMessage: "Rate limit exceeded",
      xeroObjectType: "INVOICE",
      xeroObjectId: "inv_1",
      xeroObjectUrl: null,
    });

    expect(result).toEqual({
      triggered: false,
      failureCount: 3,
    });
    expect(mocks.sendRepeatedFailureAlert).not.toHaveBeenCalled();
  });
});

describe("buildXeroReconciliationReport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("summarises canonical drift, repeated failures, and unsupported partials", async () => {
    mocks.memberFindMany.mockResolvedValue([
      { id: "mem_1", xeroContactId: "contact_1" },
    ]);
    mocks.paymentFindMany.mockResolvedValue([
      { id: "pay_1", xeroInvoiceId: "inv_1", xeroRefundCreditNoteId: "cn_1" },
    ]);
    mocks.subscriptionFindMany.mockResolvedValue([
      { id: "sub_1", xeroInvoiceId: "subinv_1" },
    ]);
    mocks.linkFindMany.mockResolvedValue([
      {
        localModel: "Member",
        localId: "mem_1",
        xeroObjectType: "CONTACT",
        xeroObjectId: "contact_1",
        role: "CONTACT",
      },
      {
        localModel: "Payment",
        localId: "pay_1",
        xeroObjectType: "INVOICE",
        xeroObjectId: "inv_old",
        role: "PRIMARY_INVOICE",
      },
      {
        localModel: "Payment",
        localId: "pay_1",
        xeroObjectId: "cn_1",
        xeroObjectType: "CREDIT_NOTE",
        role: "REFUND_CREDIT_NOTE",
      },
      {
        localModel: "MemberSubscription",
        localId: "sub_1",
        xeroObjectType: "SUBSCRIPTION",
        xeroObjectId: "subinv_1",
        role: "SUBSCRIPTION_INVOICE",
      },
      {
        localModel: "MemberSubscription",
        localId: "sub_1",
        xeroObjectType: "SUBSCRIPTION",
        xeroObjectId: "subinv_old",
        role: "SUBSCRIPTION_INVOICE",
      },
    ]);
    mocks.operationFindMany.mockResolvedValueOnce([
      {
        id: "op_4",
        direction: "OUTBOUND",
        correlationKey: "contact:mem_1:repair-gap:v1",
        entityType: "CONTACT",
        operationType: "CREATE",
        localModel: "Member",
        localId: "mem_1",
        lastErrorMessage: "Manual repair needed",
        replayable: true,
        requestPayload: null,
        responsePayload: null,
        status: "PARTIAL",
        xeroObjectType: "CONTACT",
        xeroObjectId: "contact_1",
        createdAt: new Date("2026-04-13T10:15:00Z"),
        startedAt: null,
        xeroObjectNumber: null,
        xeroObjectUrl: null,
      },
      {
        id: "op_3",
        direction: "OUTBOUND",
        correlationKey: "payment:pay_1:invoice:v1",
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "Payment",
        localId: "pay_1",
        lastErrorMessage: "Timeout",
        replayable: true,
        requestPayload: null,
        responsePayload: null,
        status: "FAILED",
        xeroObjectType: "INVOICE",
        xeroObjectId: "inv_1",
        createdAt: new Date("2026-04-13T10:10:00Z"),
        startedAt: null,
        xeroObjectNumber: "INV-001",
        xeroObjectUrl: null,
      },
      {
        id: "op_2",
        direction: "OUTBOUND",
        correlationKey: "payment:pay_1:invoice:v1",
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "Payment",
        localId: "pay_1",
        lastErrorMessage: "Timeout",
        replayable: true,
        requestPayload: null,
        responsePayload: {
          invoice: {
            invoices: [{ total: 45.67 }],
          },
        },
        status: "PARTIAL",
        xeroObjectType: "INVOICE",
        xeroObjectId: "inv_1",
        createdAt: new Date("2026-04-13T10:00:00Z"),
        startedAt: null,
        xeroObjectNumber: "INV-001",
        xeroObjectUrl: null,
      },
      {
        id: "op_1",
        direction: "OUTBOUND",
        correlationKey: "payment:pay_1:invoice:v1",
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "Payment",
        localId: "pay_1",
        lastErrorMessage: "Timeout",
        replayable: true,
        requestPayload: null,
        responsePayload: null,
        status: "FAILED",
        xeroObjectType: "INVOICE",
        xeroObjectId: "inv_1",
        createdAt: new Date("2026-04-13T09:55:00Z"),
        startedAt: null,
        xeroObjectNumber: "INV-001",
        xeroObjectUrl: null,
      },
    ]);
    mocks.operationCount.mockResolvedValue(2);
    mocks.operationFindMany.mockResolvedValueOnce([
      {
        id: "op_pending_1",
        direction: "OUTBOUND",
        correlationKey: "payment:pay_1:invoice:v1",
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "Payment",
        localId: "pay_1",
        status: "PENDING",
        lastErrorMessage: null,
        xeroObjectType: "INVOICE",
        xeroObjectId: "inv_1",
        xeroObjectNumber: "INV-001",
        xeroObjectUrl: null,
        startedAt: null,
        createdAt: new Date("2026-04-13T11:00:00Z"),
      },
    ]);

    const report = await buildXeroReconciliationReport({
      now: new Date("2026-04-13T12:00:00Z"),
    });

    expect(report.summary).toEqual({
      missingMemberContactLinks: 0,
      missingPaymentInvoiceLinks: 1,
      missingPaymentRefundCreditNoteLinks: 0,
      missingSubscriptionInvoiceLinks: 0,
      mismatchedCanonicalLinks: 1,
      staleCanonicalLinks: 2,
      duplicateActiveCanonicalLinks: 1,
      stalePendingOperations: 2,
      recentFailedOperations: 2,
      recentPartialOperations: 2,
      unsupportedPartialOperations: 1,
      repeatedFailureCorrelations: 1,
      issueCategoryCount: 9,
      issueTotalCount: 13,
    });
    expect(report.repeatedFailures).toEqual([
      expect.objectContaining({
        correlationKey: "payment:pay_1:invoice:v1",
        failureCount: 3,
        localUrl: "/admin/xero/records/Payment/pay_1",
        latestOperationId: "op_3",
        xeroObjectUrl: "https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=inv_1",
      }),
    ]);
    expect(report.unsupportedPartials).toEqual([
      expect.objectContaining({
        operationId: "op_4",
        localUrl: "/admin/members/mem_1",
        xeroObjectUrl: "https://go.xero.com/Contacts/View/contact_1",
        reason: "This partial Xero operation does not have a repair handler yet.",
      }),
    ]);
    expect(report.issueSections).toEqual([
      expect.objectContaining({
        id: "unsupported-partials",
        severity: "critical",
        count: 1,
        items: [
          expect.objectContaining({
            operationId: "op_4",
            localUrl: "/admin/members/mem_1",
          }),
        ],
      }),
      expect.objectContaining({
        id: "repeated-failures",
        severity: "critical",
        count: 1,
        items: [
          expect.objectContaining({
            operationId: "op_3",
            latestErrorMessage: "Timeout",
          }),
        ],
      }),
      expect.objectContaining({
        id: "stale-pending-operations",
        severity: "warning",
        count: 2,
        items: [
          expect.objectContaining({
            operationId: "op_pending_1",
            operationStatus: "PENDING",
          }),
        ],
      }),
      expect.objectContaining({
        id: "canonical-link-drift",
        severity: "warning",
        count: 5,
      }),
      expect.objectContaining({
        id: "recent-failed-partial-operations",
        severity: "info",
        count: 4,
      }),
    ]);
  });
});

describe("backfillHistoricalXeroObjectLinks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.linkFindMany.mockResolvedValue([]);
    mocks.operationFindMany.mockResolvedValue([]);
    mocks.linkCreateMany.mockResolvedValue({ count: 1 });
    mocks.operationCreateMany.mockResolvedValue({ count: 1 });
  });

  it("creates missing canonical links and synthetic backfill ledger rows", async () => {
    mocks.memberFindMany.mockResolvedValue([
      { id: "mem_1", xeroContactId: "contact_1" },
    ]);
    mocks.paymentFindMany.mockResolvedValue([
      {
        id: "pay_1",
        xeroInvoiceId: "inv_1",
        xeroInvoiceNumber: "INV-001",
        xeroRefundCreditNoteId: "cn_1",
      },
    ]);
    mocks.subscriptionFindMany.mockResolvedValue([
      {
        id: "sub_1",
        seasonYear: 2026,
        xeroInvoiceId: "subinv_1",
        xeroInvoiceNumber: "SUB-001",
        xeroOnlineInvoiceUrl: "https://pay.xero.com/subinv_1",
      },
    ]);

    const result = await backfillHistoricalXeroObjectLinks();

    expect(result.totals).toEqual({
      scanned: 4,
      createdLinks: 4,
      createdOperations: 4,
    });
    expect(mocks.linkCreateMany).toHaveBeenCalledTimes(4);
    expect(mocks.operationCreateMany).toHaveBeenCalledTimes(4);
    expect(mocks.linkCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({
            localModel: "Member",
            localId: "mem_1",
            role: "CONTACT",
          }),
        ]),
      })
    );
    expect(mocks.operationCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({
            operationType: "BACKFILL_LINK",
            localModel: "Member",
            localId: "mem_1",
            status: "SUCCEEDED",
          }),
        ]),
      })
    );
  });
});
