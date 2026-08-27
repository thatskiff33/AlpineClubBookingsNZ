import { beforeEach, describe, expect, it, vi } from "vitest";
import { Invoice } from "xero-node";

const mocks = vi.hoisted(() => ({
  memberFindUnique: vi.fn(),
  memberFindMany: vi.fn(),
  subscriptionFindUnique: vi.fn(),
  subscriptionFindFirst: vi.fn(),
  subscriptionFindMany: vi.fn(),
  subscriptionUpsert: vi.fn(),
  subscriptionUpdateMany: vi.fn(),
  subscriptionCreateMany: vi.fn(),
  subscriptionDeleteMany: vi.fn(),
  subscriptionUpdate: vi.fn(),
  objectLinkUpdateMany: vi.fn(),
  transaction: vi.fn(),
  coverageFindMany: vi.fn(),
  coverageFindFirst: vi.fn(),
  coverageUpdateMany: vi.fn(),
  chargeUpdateMany: vi.fn(),
  getInvoice: vi.fn(),
  getInvoices: vi.fn(),
  getOnlineInvoice: vi.fn(),
  startOperation: vi.fn(),
  completeOperation: vi.fn(),
  enqueueHostingCoverage: vi.fn().mockResolvedValue(0),
  settleHostingCoverage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findUnique: mocks.memberFindUnique, findMany: mocks.memberFindMany },
    memberSubscription: {
      findUnique: mocks.subscriptionFindUnique,
      findFirst: mocks.subscriptionFindFirst,
      findMany: mocks.subscriptionFindMany,
      upsert: mocks.subscriptionUpsert,
      update: mocks.subscriptionUpdate,
      updateMany: mocks.subscriptionUpdateMany,
      createMany: mocks.subscriptionCreateMany,
      deleteMany: mocks.subscriptionDeleteMany,
    },
    xeroObjectLink: { updateMany: mocks.objectLinkUpdateMany },
    membershipSubscriptionChargeCoverage: {
      findMany: mocks.coverageFindMany,
      findFirst: mocks.coverageFindFirst,
      updateMany: mocks.coverageUpdateMany,
    },
    membershipSubscriptionCharge: { updateMany: mocks.chargeUpdateMany },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/member-subscription-eligibility", () => ({
  requiresPaidSubscriptionForAgeTierFromSettings: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/lib/member-subscription-defaults", () => ({
  roleNeverRequiresSubscription: vi.fn().mockReturnValue(false),
}));
vi.mock("@/lib/xero-api-client", () => ({
  XeroDailyLimitError: class XeroDailyLimitError extends Error {},
  getAuthenticatedXeroClient: vi.fn().mockResolvedValue({
    tenantId: "tenant-1",
    xero: {
      accountingApi: {
        getInvoice: mocks.getInvoice,
        getInvoices: mocks.getInvoices,
        getOnlineInvoice: mocks.getOnlineInvoice,
      },
    },
  }),
  callXeroApi: vi.fn(async (callback: () => Promise<unknown>) => callback()),
}));
vi.mock("@/lib/xero-sync", () => ({
  buildXeroIdempotencyKey: vi.fn().mockReturnValue("sync-key"),
  startXeroSyncOperation: mocks.startOperation,
  completeXeroSyncOperation: mocks.completeOperation,
  failXeroSyncOperation: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/xero-sync-cursors", () => ({
  getXeroSyncCursor: vi.fn().mockResolvedValue(null),
  getXeroSyncCursorMetadata: vi.fn().mockReturnValue({ retryMemberIds: [] }),
  parseXeroError: vi.fn((error: Error) => error.message),
  throttle: vi.fn().mockResolvedValue(undefined),
  upsertXeroSyncCursor: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/adult-member-hosting-review", () => ({
  enqueueHostingCoverageReevaluationForMember: mocks.enqueueHostingCoverage,
}));
vi.mock("@/lib/adult-member-hosting-coverage-drain", () => ({
  settleHostingCoverageAfterCommit: mocks.settleHostingCoverage,
}));

import {
  checkMembershipStatus,
  flushMemberSubscriptionHistory,
  refreshAllMembershipStatuses,
} from "@/lib/xero-membership-sync";

describe("membership charge reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.memberFindUnique.mockResolvedValue({
      id: "family-member-2",
      role: "USER",
      ageTier: "ADULT",
      xeroContactId: null,
    });
    mocks.subscriptionFindUnique.mockResolvedValue({
      id: "subscription-2",
      status: "UNPAID",
      xeroInvoiceId: "invoice-family",
      xeroInvoiceNumber: "INV-42",
      xeroOnlineInvoiceUrl: "https://in.xero.com/invoice-family",
      paidAt: null,
      chargeCoverage: [
        { charge: { xeroInvoiceId: "invoice-family" } },
      ],
    });
    mocks.startOperation.mockResolvedValue({ id: "operation-1" });
    mocks.subscriptionUpsert.mockResolvedValue({ id: "subscription-2" });
    mocks.subscriptionUpdateMany.mockResolvedValue({ count: 1 });
    mocks.subscriptionCreateMany.mockResolvedValue({ count: 0 });
    mocks.subscriptionFindFirst.mockResolvedValue({
      status: "UNPAID", xeroInvoiceId: "invoice-family", paidAt: null,
      xeroOnlineInvoiceUrl: "https://in.xero.com/invoice-family",
    });
    mocks.coverageFindMany.mockResolvedValue([]);
    mocks.coverageFindFirst.mockResolvedValue(null);
    mocks.coverageUpdateMany.mockResolvedValue({ count: 1 });
    mocks.chargeUpdateMany.mockResolvedValue({ count: 1 });
    mocks.subscriptionUpdate.mockResolvedValue({ id: "subscription-2", voidGeneration: 1 });
    // #2147: releaseVoidedSubscriptionInvoice runs inside prisma.$transaction —
    // pass a tx client exposing the delegates it writes.
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback({
      membershipSubscriptionChargeCoverage: { findFirst: mocks.coverageFindFirst, updateMany: mocks.coverageUpdateMany },
      membershipSubscriptionCharge: { updateMany: mocks.chargeUpdateMany },
      memberSubscription: {
        findUnique: mocks.subscriptionFindUnique,
        upsert: mocks.subscriptionUpsert,
        update: mocks.subscriptionUpdate,
        updateMany: mocks.subscriptionUpdateMany,
        createMany: mocks.subscriptionCreateMany,
      },
      xeroObjectLink: { updateMany: mocks.objectLinkUpdateMany },
    }));
    mocks.memberFindMany.mockResolvedValue([]);
    mocks.getOnlineInvoice.mockResolvedValue({ body: { onlineInvoices: [{ onlineInvoiceUrl: "https://in.xero.com/invoice-family" }] } });
    mocks.getInvoice.mockResolvedValue({
      body: {
        invoices: [
          {
            invoiceID: "invoice-family",
            invoiceNumber: "INV-42",
            type: Invoice.TypeEnum.ACCREC,
            status: Invoice.StatusEnum.AUTHORISED,
            dueDate: new Date("2099-04-30T00:00:00.000Z"),
          },
        ],
      },
    });
  });

  it("never downgrades a manually marked-paid row lacking a Xero invoice link (#1944)", async () => {
    // A subscription marked paid outside the Xero pipeline carries a
    // manuallyMarkedPaidAt with no xeroInvoiceId. checkMembershipStatus must
    // return the manual PAID as-is and touch neither the local row nor Xero.
    mocks.subscriptionFindUnique.mockResolvedValue({
      id: "sub-manual",
      status: "PAID",
      manuallyMarkedPaidAt: new Date("2026-05-01T00:00:00.000Z"),
      xeroInvoiceId: null,
      xeroInvoiceNumber: null,
      xeroOnlineInvoiceUrl: null,
      paidAt: new Date("2026-05-01T00:00:00.000Z"),
      chargeCoverage: [],
    });

    const result = await checkMembershipStatus("family-member-2", 2026);

    expect(result.status).toBe("PAID");
    expect(mocks.subscriptionUpsert).not.toHaveBeenCalled();
    expect(mocks.getInvoice).not.toHaveBeenCalled();
    expect(mocks.getInvoices).not.toHaveBeenCalled();
    expect(mocks.startOperation).not.toHaveBeenCalled();
  });

  it("releases a voided invoice: nulls the link, marks the charge VOIDED, bumps voidGeneration (#2147)", async () => {
    // The member's covering invoice is voided in Xero. checkMembershipStatus
    // must set NOT_INVOICED (no longer locked out), release the active coverage
    // claim, mark the covering charge VOIDED, and bump voidGeneration.
    mocks.subscriptionFindUnique.mockResolvedValue({
      id: "sub-void",
      status: "UNPAID",
      xeroInvoiceId: "invoice-void",
      xeroInvoiceNumber: "INV-V",
      xeroOnlineInvoiceUrl: "https://in.xero.com/invoice-void",
      paidAt: null,
      chargeCoverage: [{ charge: { xeroInvoiceId: "invoice-void" } }],
    });
    mocks.coverageFindFirst.mockResolvedValue({ id: "cov-void", chargeId: "charge-void" });
    mocks.getInvoice.mockResolvedValue({
      body: { invoices: [{
        invoiceID: "invoice-void",
        invoiceNumber: "INV-V",
        type: Invoice.TypeEnum.ACCREC,
        status: Invoice.StatusEnum.VOIDED,
      }] },
    });

    const result = await checkMembershipStatus("family-member-2", 2026);

    expect(result.status).toBe("NOT_INVOICED");
    // Coverage claim released, not deleted.
    expect(mocks.coverageUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "cov-void", releasedAt: null },
      data: { releasedAt: expect.any(Date) },
    }));
    // Charge marked VOIDED (kept for audit).
    expect(mocks.chargeUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "charge-void", status: { not: "VOIDED" } },
      data: expect.objectContaining({ status: "VOIDED" }),
    }));
    // voidGeneration bumped so a re-bill mints a new charge.
    expect(mocks.subscriptionUpdate).toHaveBeenCalledWith({
      where: { id: "sub-void" },
      data: { voidGeneration: { increment: 1 } },
    });
    // Subscription invoice link nulled, guarded on the voided invoice id.
    expect(mocks.subscriptionUpdateMany).toHaveBeenCalledWith({
      where: { memberId: "family-member-2", seasonYear: 2026, xeroInvoiceId: "invoice-void" },
      data: {
        status: "NOT_INVOICED",
        xeroInvoiceId: null,
        xeroInvoiceNumber: null,
        xeroOnlineInvoiceUrl: null,
        paidAt: null,
      },
    });
    // No blind PAID/UNPAID write of the voided invoice back onto the row.
    expect(mocks.subscriptionUpsert).not.toHaveBeenCalled();
    expect(mocks.enqueueHostingCoverage).toHaveBeenCalledWith(
      "family-member-2",
      expect.any(Object),
      // #3123: the club's day, resolved before the transaction opened.
      expect.any(Date),
      { cause: "SYSTEM_CHANGE" },
    );
    expect(mocks.settleHostingCoverage).toHaveBeenCalledWith({ limit: 50 });
  });

  it("refreshes a non-recipient family subscription by its immutable charge invoice", async () => {
    const result = await checkMembershipStatus("family-member-2", 2026);

    expect(result).toMatchObject({
      status: "UNPAID",
      xeroInvoiceId: "invoice-family",
    });
    expect(mocks.getInvoice).toHaveBeenCalledWith("tenant-1", "invoice-family");
    expect(mocks.getInvoices).not.toHaveBeenCalled();
    expect(mocks.subscriptionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          status: "UNPAID",
          xeroInvoiceId: "invoice-family",
          // A write that links a real Xero invoice is authoritative and clears
          // any manual mark-paid provenance, so a row can never read e.g.
          // "UNPAID (manual)" (#1944).
          manuallyMarkedPaidAt: null,
          manuallyMarkedPaidByMemberId: null,
          manualPaymentNote: null,
        }),
      })
    );
  });

  it("preserves a manual mark-paid that lands mid-sync instead of blind-writing NOT_INVOICED (#1944)", async () => {
    // At the guard read the row is not yet manually paid…
    mocks.subscriptionFindUnique
      .mockResolvedValueOnce({
        id: "sub-mid",
        status: "NOT_INVOICED",
        manuallyMarkedPaidAt: null,
        xeroInvoiceId: null,
        xeroInvoiceNumber: null,
        xeroOnlineInvoiceUrl: null,
        paidAt: null,
      })
      .mockResolvedValueOnce({
        id: "sub-mid",
        status: "NOT_INVOICED",
        xeroInvoiceId: null,
        xeroInvoiceNumber: null,
        xeroOnlineInvoiceUrl: null,
        paidAt: null,
        chargeCoverage: [{ charge: { xeroInvoiceId: "invoice-family" } }],
      })
      // …after the write fence skips the row, the surviving read shows the
      // manual PAID that a treasurer recorded during the Xero round-trips.
      .mockResolvedValueOnce({
        status: "PAID",
        paidAt: new Date("2026-07-15T00:00:00.000Z"),
        xeroOnlineInvoiceUrl: null,
      });
    // Xero no longer has the charge invoice, so discovery derives NOT_INVOICED…
    mocks.getInvoice.mockResolvedValue({ body: { invoices: [] } });
    // …but the fenced updateMany matches nothing (the row is now manual-PAID
    // with no invoice link) and create-if-missing hits the existing row.
    mocks.subscriptionUpdateMany.mockResolvedValue({ count: 0 });
    mocks.subscriptionCreateMany.mockResolvedValue({ count: 0 });

    const result = await checkMembershipStatus("family-member-2", 2026);

    expect(result.status).toBe("PAID");
    expect(mocks.subscriptionUpsert).not.toHaveBeenCalled();
    expect(mocks.subscriptionUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ manuallyMarkedPaidAt: null }, { xeroInvoiceId: { not: null } }],
        }),
        data: expect.objectContaining({ status: "NOT_INVOICED" }),
      })
    );
    expect(mocks.subscriptionCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true })
    );
    expect(mocks.completeOperation).toHaveBeenCalledWith(
      "operation-1",
      expect.objectContaining({
        responsePayload: expect.objectContaining({
          nextStatus: "PAID",
          preservedManualPayment: true,
        }),
      })
    );
  });

  it("maps a changed shared paid invoice to every active covered family member", async () => {
    const members = [
      { id: "recipient", email: "recipient@example.test", firstName: "Bill", lastName: "Member", xeroContactId: "contact-1", updatedAt: new Date() },
      { id: "non-recipient", email: "child@example.test", firstName: "Child", lastName: "Member", xeroContactId: null, updatedAt: new Date() },
    ];
    mocks.getInvoices.mockResolvedValue({
      body: { invoices: [{
        invoiceID: "invoice-family",
        contact: { contactID: "contact-1" },
        status: Invoice.StatusEnum.PAID,
        type: Invoice.TypeEnum.ACCREC,
      }] },
    });
    mocks.coverageFindMany.mockResolvedValue(members.map((member) => ({
      charge: { xeroInvoiceId: "invoice-family" },
      subscription: { member },
    })));
    mocks.memberFindMany.mockResolvedValue(members);
    mocks.memberFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      ...members.find((member) => member.id === where.id),
      role: "USER",
      ageTier: "ADULT",
    }));
    mocks.subscriptionFindUnique.mockResolvedValue({
      id: "subscription-family",
      status: "UNPAID",
      xeroInvoiceId: "invoice-family",
      xeroInvoiceNumber: "INV-42",
      xeroOnlineInvoiceUrl: "https://in.xero.com/invoice-family",
      paidAt: null,
      chargeCoverage: [{ charge: { xeroInvoiceId: "invoice-family" } }],
    });
    mocks.getInvoice.mockResolvedValue({
      body: { invoices: [{
        invoiceID: "invoice-family",
        invoiceNumber: "INV-42",
        type: Invoice.TypeEnum.ACCREC,
        status: Invoice.StatusEnum.PAID,
        fullyPaidOnDate: new Date("2026-07-14T00:00:00.000Z"),
      }] },
    });

    const result = await refreshAllMembershipStatuses(2026);

    expect(result).toMatchObject({ affectedMembers: 2, checked: 2, updated: 2, errors: 0 });
    expect(mocks.subscriptionUpsert).toHaveBeenCalledTimes(2);
    for (const member of members) {
      expect(mocks.subscriptionUpsert).toHaveBeenCalledWith(expect.objectContaining({
        where: { memberId_seasonYear: { memberId: member.id, seasonYear: 2026 } },
        update: expect.objectContaining({ status: "PAID", xeroInvoiceId: "invoice-family" }),
      }));
    }
    expect(mocks.enqueueHostingCoverage).toHaveBeenCalledTimes(2);
    expect(mocks.settleHostingCoverage).toHaveBeenCalledTimes(2);
  });
});

describe("flushMemberSubscriptionHistory (#1944)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
      callback({
        memberSubscription: {
          findMany: mocks.subscriptionFindMany,
          deleteMany: mocks.subscriptionDeleteMany,
        },
        xeroObjectLink: { updateMany: mocks.objectLinkUpdateMany },
      })
    );
    mocks.objectLinkUpdateMany.mockResolvedValue({ count: 1 });
    mocks.subscriptionDeleteMany.mockImplementation(
      async ({ where }: { where: { id: { in: string[] } } }) => ({ count: where.id.in.length })
    );
  });

  it("never deletes a manually marked-paid row on contact link/push/unlink resync", async () => {
    // A manual mark-paid records a real cash payment taken outside Xero. If the
    // flush destroyed it, a later re-sync would recreate NOT_INVOICED and the
    // billing sweep would re-invoice the member who already paid — the exact
    // mid-season Xero-adoption scenario this feature exists for.
    mocks.subscriptionFindMany.mockResolvedValue([
      { id: "sub-derived", seasonYear: 2026, manuallyMarkedPaidAt: null, chargeCoverage: [] },
      { id: "sub-manual", seasonYear: 2026, manuallyMarkedPaidAt: new Date("2026-07-01T00:00:00.000Z"), chargeCoverage: [] },
      { id: "sub-covered", seasonYear: 2025, manuallyMarkedPaidAt: null, chargeCoverage: [{ id: "coverage-1" }] },
    ]);

    const result = await flushMemberSubscriptionHistory("member-1");

    // Only the legacy/unbilled derived row is reset; the manual-PAID row and the
    // charge-covered row are financial history and survive.
    expect(mocks.subscriptionDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["sub-derived"] } },
    });
    expect(mocks.objectLinkUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ localId: { in: ["sub-derived"] } }),
      })
    );
    expect(mocks.enqueueHostingCoverage).toHaveBeenCalledWith(
      "member-1",
      expect.any(Object),
      // #3123: the club's day, resolved before the transaction opened.
      expect.any(Date),
      { cause: "SYSTEM_CHANGE" },
    );
    expect(mocks.settleHostingCoverage).toHaveBeenCalledWith({ limit: 50 });
    expect(result.deletedCount).toBe(1);
  });

  it("deletes nothing when every row is manual-PAID or charge-covered", async () => {
    mocks.subscriptionFindMany.mockResolvedValue([
      { id: "sub-manual", seasonYear: 2026, manuallyMarkedPaidAt: new Date("2026-07-01T00:00:00.000Z"), chargeCoverage: [] },
      { id: "sub-covered", seasonYear: 2025, manuallyMarkedPaidAt: null, chargeCoverage: [{ id: "coverage-1" }] },
    ]);

    const result = await flushMemberSubscriptionHistory("member-1");

    expect(mocks.subscriptionDeleteMany).not.toHaveBeenCalled();
    expect(mocks.objectLinkUpdateMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({ deletedCount: 0, deactivatedLinkCount: 0 });
  });
});
