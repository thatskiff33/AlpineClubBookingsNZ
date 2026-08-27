import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settingsFind: vi.fn(),
  coverageFindMany: vi.fn(),
  coverageFindUnique: vi.fn(),
  coverageFindFirst: vi.fn(),
  memberFindMany: vi.fn(),
  typeFindMany: vi.fn(),
  chargeFindMany: vi.fn(),
  familyGroupMemberFindMany: vi.fn(),
  familyGroupMemberGroupBy: vi.fn(),
  familyMarkerFindMany: vi.fn(),
  chargeUpsert: vi.fn(),
  subscriptionUpsert: vi.fn(),
  subscriptionFindMany: vi.fn(),
  exceptionUpdateMany: vi.fn(),
  exceptionUpsert: vi.fn(),
  operationCount: vi.fn(),
  operationCreate: vi.fn(),
  transaction: vi.fn(),
  mapping: vi.fn(),
  fee: vi.fn(),
  familyMode: vi.fn(),
  client: null as unknown,
}));

vi.mock("@/lib/prisma", () => {
  const client = {
    $executeRaw: vi.fn(),
    $transaction: mocks.transaction,
    membershipSubscriptionBillingSettings: { findUnique: mocks.settingsFind },
    membershipSubscriptionChargeCoverage: { findMany: mocks.coverageFindMany, findUnique: mocks.coverageFindUnique, findFirst: mocks.coverageFindFirst },
    membershipSubscriptionCharge: { findMany: mocks.chargeFindMany, upsert: mocks.chargeUpsert },
    familyGroupMember: { findMany: mocks.familyGroupMemberFindMany, groupBy: mocks.familyGroupMemberGroupBy },
    familyGroupSeasonInvoiceMarker: { findMany: mocks.familyMarkerFindMany },
    membershipBillingException: { updateMany: mocks.exceptionUpdateMany, upsert: mocks.exceptionUpsert },
    member: { findMany: mocks.memberFindMany },
    membershipType: { findMany: mocks.typeFindMany },
    memberSubscription: { upsert: mocks.subscriptionUpsert, findMany: mocks.subscriptionFindMany },
    xeroSyncOperation: { count: mocks.operationCount, create: mocks.operationCreate },
  };
  mocks.client = client;
  return { prisma: client };
});
vi.mock("@/lib/authoritative-fees", () => ({ getEffectiveMembershipAnnualFee: mocks.fee, getFamilyBillingMode: mocks.familyMode }));
vi.mock("@/lib/xero-mappings", () => ({ getResolvedAccountMapping: mocks.mapping }));
vi.mock("@/lib/audit", () => ({ createAuditLog: vi.fn() }));

import {
  buildSubscriptionBillingPreview,
  confirmSubscriptionBillingPreview,
  reconcileSubscriptionBillingExceptions,
} from "@/lib/membership-subscription-billing";

describe("membership subscription confirmation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settingsFind.mockResolvedValue({ invoiceDueDays: 30 });
    mocks.familyMode.mockResolvedValue("BILL_FAMILY_VIA_BILLING_MEMBER");
    mocks.coverageFindMany.mockResolvedValue([]);
    mocks.coverageFindUnique.mockResolvedValue(null);
    mocks.coverageFindFirst.mockResolvedValue(null);
    mocks.subscriptionFindMany.mockResolvedValue([]);
    mocks.memberFindMany.mockResolvedValue([{
      id: "member-1", firstName: "Member", lastName: "One", email: "member@example.test",
      role: "USER", seasonalMembershipAssignments: [{ membershipType: {
        id: "type-1", key: "FULL", name: "Full", subscriptionBehavior: "REQUIRED",
      } }], familyGroupMemberships: [],
    }]);
    mocks.typeFindMany.mockResolvedValue([]);
    mocks.chargeFindMany.mockResolvedValue([]);
    mocks.familyGroupMemberFindMany.mockResolvedValue([]);
    mocks.familyGroupMemberGroupBy.mockResolvedValue([]);
    mocks.familyMarkerFindMany.mockResolvedValue([]);
    mocks.fee.mockResolvedValue({
      id: "fee-1", amountCents: 12_000, billingBasis: "PER_MEMBER", prorationRule: "NONE",
    });
    mocks.mapping.mockResolvedValue({ code: "203", itemCode: "SUB", codeExplicitlyConfigured: true });
    mocks.subscriptionUpsert.mockResolvedValue({ id: "subscription-1", memberId: "member-1" });
    mocks.chargeUpsert.mockResolvedValue({ id: "charge-1" });
    mocks.operationCount.mockResolvedValue(0);
    mocks.operationCreate.mockResolvedValue({ id: "operation-1" });
    mocks.transaction.mockImplementation(async (callback: (client: unknown) => unknown) => callback(mocks.client));
  });

  it("atomically snapshots the mapping and coverage, then replays to the existing charge", async () => {
    const preview = await buildSubscriptionBillingPreview({
      seasonYear: 2026,
      decisionDate: new Date("2026-07-13T00:00:00.000Z"),
    });
    const first = await confirmSubscriptionBillingPreview({
      preview,
      expectedConfirmationToken: preview.confirmationToken,
      source: "ANNUAL_BATCH",
    });
    expect(first.chargeIds).toEqual(["charge-1"]);
    expect(mocks.chargeUpsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        xeroAccountCode: "203",
        xeroItemCode: "SUB",
        chargedAmountCents: 12_000,
        coverage: { create: [{ subscriptionId: "subscription-1", memberId: "member-1", memberName: "Member One" }] },
      }),
    }));
    expect(mocks.operationCreate).toHaveBeenCalledTimes(1);

    mocks.coverageFindMany
      .mockResolvedValueOnce([{ memberId: "member-1" }])
      .mockResolvedValueOnce([{ chargeId: "charge-1" }]);
    const replay = await confirmSubscriptionBillingPreview({
      preview,
      expectedConfirmationToken: preview.confirmationToken,
      source: "ANNUAL_BATCH",
    });
    expect(replay.chargeIds).toEqual(["charge-1"]);
    expect(mocks.chargeUpsert).toHaveBeenCalledTimes(1);
    expect(mocks.operationCreate).toHaveBeenCalledTimes(1);
  });

  it("checks only ACTIVE coverage and mints a NEW idempotency key after a void (#2147)", async () => {
    const preview = await buildSubscriptionBillingPreview({
      seasonYear: 2026,
      decisionDate: new Date("2026-07-13T00:00:00.000Z"),
    });

    // voidGeneration 0 (never voided) — key is byte-identical to the pre-#2147 shape.
    mocks.subscriptionUpsert.mockResolvedValue({ id: "subscription-1", memberId: "member-1", voidGeneration: 0 });
    await confirmSubscriptionBillingPreview({
      preview, expectedConfirmationToken: preview.confirmationToken, source: "ANNUAL_BATCH",
    });
    const keyV0 = (mocks.chargeUpsert.mock.calls[0][0] as { where: { idempotencyKey: string } }).where.idempotencyKey;
    // coveredAlready counts only ACTIVE (releasedAt IS NULL) claims — a released
    // claim must NOT suppress the re-bill.
    expect(mocks.coverageFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { subscriptionId: "subscription-1", releasedAt: null } }),
    );

    // Same member/amount but voidGeneration 1 after a void → a DIFFERENT key, so
    // the confirm upsert creates a NEW charge instead of no-op-ing onto the
    // released (VOIDED) one.
    mocks.subscriptionUpsert.mockResolvedValue({ id: "subscription-1", memberId: "member-1", voidGeneration: 1 });
    await confirmSubscriptionBillingPreview({
      preview, expectedConfirmationToken: preview.confirmationToken, source: "ANNUAL_BATCH",
    });
    const keyV1 = (mocks.chargeUpsert.mock.calls[1][0] as { where: { idempotencyKey: string } }).where.idempotencyKey;
    expect(keyV1).not.toBe(keyV0);
  });

  it("freezes one component snapshot per line in the same transaction (#1932, E6)", async () => {
    mocks.fee.mockResolvedValue({
      id: "fee-1", amountCents: 12_000, billingBasis: "PER_MEMBER", prorationRule: "NONE",
      components: [
        { label: "Base membership", amountCents: 9_000, prorate: true, xeroAccountCode: null, xeroItemCode: null, sortOrder: 0 },
        { label: "Work party fee", amountCents: 3_000, prorate: false, xeroAccountCode: "260", xeroItemCode: null, sortOrder: 1 },
      ],
    });
    const preview = await buildSubscriptionBillingPreview({
      seasonYear: 2026,
      decisionDate: new Date("2026-04-01T00:00:00.000Z"),
    });
    await confirmSubscriptionBillingPreview({
      preview,
      expectedConfirmationToken: preview.confirmationToken,
      source: "ANNUAL_BATCH",
    });
    expect(mocks.chargeUpsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        chargedAmountCents: 12_000,
        components: { create: [
          expect.objectContaining({ label: "Base membership", annualAmountCents: 9_000, chargedAmountCents: 9_000, prorated: true, xeroAccountCode: "203", xeroItemCode: "SUB", sortOrder: 0 }),
          expect.objectContaining({ label: "Work party fee", annualAmountCents: 3_000, chargedAmountCents: 3_000, prorated: false, xeroAccountCode: "260", sortOrder: 1 }),
        ] },
      }),
    }));
  });

  describe("BASED_ON_AGE_TIER tier-exempt members (#2041)", () => {
    it("creates a NOT_REQUIRED season row and no charge / no Xero op for an exempt tier", async () => {
      mocks.memberFindMany.mockResolvedValue([{
        id: "child-1", firstName: "Kid", lastName: "One", email: "kid@example.test",
        role: "USER", dateOfBirth: null, ageTier: "CHILD", billingFamilyGroupId: null,
        seasonalMembershipAssignments: [{ membershipType: {
          id: "type-1", key: "FULL", name: "Full", subscriptionBehavior: "BASED_ON_AGE_TIER",
        } }], familyGroupMemberships: [],
      }]);
      const preview = await buildSubscriptionBillingPreview({
        seasonYear: 2026,
        decisionDate: new Date("2026-07-13T00:00:00.000Z"),
      });
      expect(preview.exemptMemberIds).toEqual(["child-1"]);
      expect(preview.entries).toEqual([]);

      const result = await confirmSubscriptionBillingPreview({
        preview,
        expectedConfirmationToken: preview.confirmationToken,
        source: "ANNUAL_BATCH",
      });
      expect(result.chargeIds).toEqual([]);
      expect(mocks.chargeUpsert).not.toHaveBeenCalled();
      expect(mocks.operationCreate).not.toHaveBeenCalled();
      expect(mocks.subscriptionUpsert).toHaveBeenCalledWith({
        where: { memberId_seasonYear: { memberId: "child-1", seasonYear: 2026 } },
        update: {},
        create: { memberId: "child-1", seasonYear: 2026, status: "NOT_REQUIRED" },
      });
    });

    it("#2148: an exempt tier with NO fee row still confirms a NOT_REQUIRED season row (no charge, no Xero op)", async () => {
      mocks.fee.mockResolvedValue(null);
      mocks.memberFindMany.mockResolvedValue([{
        id: "child-1", firstName: "Kid", lastName: "One", email: "kid@example.test",
        role: "USER", dateOfBirth: null, ageTier: "CHILD", billingFamilyGroupId: null,
        seasonalMembershipAssignments: [{ membershipType: {
          id: "type-1", key: "FULL", name: "Full", subscriptionBehavior: "BASED_ON_AGE_TIER",
        } }], familyGroupMemberships: [],
      }]);
      const preview = await buildSubscriptionBillingPreview({
        seasonYear: 2026,
        decisionDate: new Date("2026-07-13T00:00:00.000Z"),
      });
      expect(preview.exceptions).toEqual([]);
      expect(preview.exemptMemberIds).toEqual(["child-1"]);

      const result = await confirmSubscriptionBillingPreview({
        preview,
        expectedConfirmationToken: preview.confirmationToken,
        source: "ANNUAL_BATCH",
      });
      expect(result.chargeIds).toEqual([]);
      expect(mocks.chargeUpsert).not.toHaveBeenCalled();
      expect(mocks.operationCreate).not.toHaveBeenCalled();
      expect(mocks.subscriptionUpsert).toHaveBeenCalledWith({
        where: { memberId_seasonYear: { memberId: "child-1", seasonYear: 2026 } },
        update: {},
        create: { memberId: "child-1", seasonYear: 2026, status: "NOT_REQUIRED" },
      });
    });

    it("never rewrites an already-PAID member (no upsert, no charge) — history intact", async () => {
      mocks.memberFindMany.mockResolvedValue([{
        id: "paid-child", firstName: "Paid", lastName: "Kid", email: "paidkid@example.test",
        role: "USER", dateOfBirth: null, ageTier: "CHILD", billingFamilyGroupId: null,
        seasonalMembershipAssignments: [{ membershipType: {
          id: "type-1", key: "FULL", name: "Full", subscriptionBehavior: "BASED_ON_AGE_TIER",
        } }], familyGroupMemberships: [],
      }]);
      // Already PAID for the season (manual mark-paid): excluded from the sweep
      // entirely, so they are never listed exempt and never re-upserted.
      mocks.subscriptionFindMany.mockResolvedValue([{ memberId: "paid-child" }]);
      const preview = await buildSubscriptionBillingPreview({
        seasonYear: 2026,
        decisionDate: new Date("2026-07-13T00:00:00.000Z"),
      });
      expect(preview.exemptMemberIds).toEqual([]);

      await confirmSubscriptionBillingPreview({
        preview,
        expectedConfirmationToken: preview.confirmationToken,
        source: "ANNUAL_BATCH",
      });
      expect(mocks.subscriptionUpsert).not.toHaveBeenCalled();
      expect(mocks.chargeUpsert).not.toHaveBeenCalled();
    });
  });

  describe("exception resolution provenance + preview reconciliation (#2148, D2)", () => {
    it("confirm stamps CONFIRM provenance when resolving superseded exceptions", async () => {
      mocks.exceptionUpdateMany.mockResolvedValue({ count: 0 });
      const preview = await buildSubscriptionBillingPreview({
        seasonYear: 2026,
        decisionDate: new Date("2026-07-13T00:00:00.000Z"),
      });
      await confirmSubscriptionBillingPreview({
        preview,
        expectedConfirmationToken: preview.confirmationToken,
        source: "ANNUAL_BATCH",
      });
      expect(mocks.exceptionUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
        data: { status: "RESOLVED", resolvedAt: expect.any(Date), resolvedVia: "CONFIRM" },
      }));
      // Whole-club ANNUAL_BATCH: no member-scoping OR filter, so every superseded
      // OPEN exception (including club-level null-member ones) is in range.
      const where = (mocks.exceptionUpdateMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
      expect(where.OR).toBeUndefined();
    });

    it("a NEW_MEMBER_APPROVAL confirm scopes the resolve to its members OR the club-level null-member mapping code (constraint 4)", async () => {
      mocks.exceptionUpdateMany.mockResolvedValue({ count: 0 });
      const preview = await buildSubscriptionBillingPreview({
        seasonYear: 2026,
        decisionDate: new Date("2026-07-13T00:00:00.000Z"),
        memberIds: ["member-1"],
      });
      await confirmSubscriptionBillingPreview({
        preview,
        expectedConfirmationToken: preview.confirmationToken,
        source: "NEW_MEMBER_APPROVAL",
      });
      const where = (mocks.exceptionUpdateMany.mock.calls[0][0] as { where: { OR?: unknown[] } }).where;
      expect(where.OR).toEqual([
        { memberId: { in: expect.arrayContaining(["member-1"]) } },
        { code: "MISSING_XERO_ACCOUNT_MAPPING", memberId: null },
      ]);
    });

    it("reconcile auto-resolves whole-club with PREVIEW_RECONCILE provenance and reports the resolved count", async () => {
      // A fresh whole-club preview with no exceptions -> every OPEN row is superseded.
      mocks.exceptionUpdateMany.mockResolvedValue({ count: 4 });
      const result = await reconcileSubscriptionBillingExceptions({
        seasonYear: 2026,
        decisionDate: new Date("2026-07-13T00:00:00.000Z"),
        yearEndMonth: 3,
      });
      expect(result).toEqual({ resolvedCount: 4 });
      expect(mocks.exceptionUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ seasonYear: 2026, status: "OPEN" }),
        data: { status: "RESOLVED", resolvedAt: expect.any(Date), resolvedVia: "PREVIEW_RECONCILE" },
      }));
      const where = (mocks.exceptionUpdateMany.mock.calls[0][0] as { where: { OR?: unknown; fingerprint?: unknown } }).where;
      // Whole-club scope: no member OR filter, so club-level null-member exceptions
      // are reconciled too (constraint 4). No genuine exception this run -> no
      // fingerprint exclusion, so all superseded OPEN rows resolve.
      expect(where.OR).toBeUndefined();
      expect(where.fingerprint).toBeUndefined();
    });

    it("reconcile preserves a still-genuine exception by excluding its fingerprint", async () => {
      mocks.fee.mockResolvedValue(null);
      // A non-exempt member with no fee -> the fresh preview regenerates a
      // MISSING_FEE_SCHEDULE; reconcile must NOT resolve that fingerprint.
      mocks.memberFindMany.mockResolvedValue([{
        id: "member-1", firstName: "Member", lastName: "One", email: "member@example.test",
        role: "USER", dateOfBirth: null, ageTier: "ADULT", billingFamilyGroupId: null,
        seasonalMembershipAssignments: [{ membershipType: {
          id: "type-1", key: "FULL", name: "Full", subscriptionBehavior: "REQUIRED",
        } }], familyGroupMemberships: [],
      }]);
      mocks.exceptionUpdateMany.mockResolvedValue({ count: 0 });
      await reconcileSubscriptionBillingExceptions({
        seasonYear: 2026,
        decisionDate: new Date("2026-07-13T00:00:00.000Z"),
        yearEndMonth: 3,
      });
      const where = (mocks.exceptionUpdateMany.mock.calls[0][0] as { where: { fingerprint?: { notIn: string[] } } }).where;
      expect(where.fingerprint?.notIn).toHaveLength(1);
    });

    it("reconcile runs under the per-season advisory lock", async () => {
      mocks.exceptionUpdateMany.mockResolvedValue({ count: 0 });
      await reconcileSubscriptionBillingExceptions({
        seasonYear: 2026,
        decisionDate: new Date("2026-07-13T00:00:00.000Z"),
        yearEndMonth: 3,
      });
      const execRaw = (mocks.client as { $executeRaw: ReturnType<typeof vi.fn> }).$executeRaw;
      expect(execRaw).toHaveBeenCalledTimes(1);
    });
  });

  it("raises the interactive transaction timeout above Prisma's 5s default for whole-club batch runs (#1886)", async () => {
    const preview = await buildSubscriptionBillingPreview({
      seasonYear: 2026,
      decisionDate: new Date("2026-07-13T00:00:00.000Z"),
    });
    await confirmSubscriptionBillingPreview({
      preview,
      expectedConfirmationToken: preview.confirmationToken,
      source: "ANNUAL_BATCH",
    });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    const options = mocks.transaction.mock.calls[0][1] as { timeout?: number } | undefined;
    expect(options?.timeout).toBeGreaterThanOrEqual(60_000);
  });
});
