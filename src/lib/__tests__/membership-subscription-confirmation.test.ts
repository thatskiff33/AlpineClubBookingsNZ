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
  categoryFee: vi.fn(),
  familyMode: vi.fn(),
  audit: vi.fn(),
  enqueue: vi.fn(),
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
vi.mock("@/lib/authoritative-fees", () => ({
  getEffectiveMembershipAnnualFee: mocks.fee,
  getEffectiveSubscriptionCategoryFee: mocks.categoryFee,
  getFamilyBillingMode: mocks.familyMode,
}));
vi.mock("@/lib/xero-mappings", () => ({ getResolvedAccountMapping: mocks.mapping }));
vi.mock("@/lib/audit", () => ({ createAuditLog: mocks.audit }));
vi.mock("@/lib/xero-subscription-invoices", () => ({ enqueueMembershipSubscriptionChargeOperation: mocks.enqueue }));

import {
  buildSubscriptionBillingPreview,
  confirmSubscriptionBillingPreview,
  queueApprovedMembershipSubscriptionCharges,
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
    // Subscription-category decoupling: no category fee by default — this
    // file's default member has no subscriptionCategory on their assignment.
    mocks.categoryFee.mockResolvedValue(null);
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
        // No per-covered-member membershipTypeId/Name — those audit columns
        // were dropped from the subscription-category redesign (write-only,
        // nothing ever read them back).
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

  it("rechecks an archived stored role default during confirm and snapshots one charge", async () => {
    mocks.memberFindMany.mockResolvedValue([{
      id: "member-1", firstName: "Member", lastName: "One", email: "member@example.test",
      role: "USER", ageTier: "ADULT", seasonalMembershipAssignments: [], familyGroupMemberships: [],
    }]);
    mocks.typeFindMany.mockImplementation(async ({ where }: { where: { key: { in: string[] }; isActive?: boolean } }) =>
      where.key.in.includes("FULL") && where.isActive !== true
        ? [{ id: "type-full", key: "FULL", name: "Full", isActive: false, subscriptionBehavior: "REQUIRED" }]
        : []);
    const preview = await buildSubscriptionBillingPreview({
      seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z"),
    });
    expect(preview.entries).toHaveLength(1);
    expect(preview.entries[0]).toMatchObject({ membershipTypeId: "type-full", membershipAnnualFeeId: "fee-1" });
    const result = await confirmSubscriptionBillingPreview({
      preview, expectedConfirmationToken: preview.confirmationToken, source: "ANNUAL_BATCH",
    });
    expect(result.chargeIds).toEqual(["charge-1"]);
    expect(mocks.typeFindMany).toHaveBeenCalledTimes(2);
    expect(mocks.chargeUpsert).toHaveBeenCalledTimes(1);
    expect(mocks.chargeUpsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ membershipTypeId: "type-full", membershipAnnualFeeId: "fee-1" }),
    }));
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

  /** A kid whose closed family charge had only the kid's payment reversed (#4110). */
  function seedPartlyReversedClosedFamily() {
    mocks.fee.mockResolvedValue({ id: "fee-family", amountCents: 30_000, billingBasis: "PER_FAMILY", prorationRule: "NONE" });
    mocks.memberFindMany.mockResolvedValue([{
      id: "member-1", firstName: "Kid", lastName: "Member", email: "kid@example.test",
      role: "USER", seasonalMembershipAssignments: [{ membershipType: {
        id: "type-1", key: "FAMILY", name: "Family", subscriptionBehavior: "REQUIRED",
      } }],
      familyGroupMemberships: [{ familyGroupId: "family-1", familyGroup: { billingMembership: {
        familyGroupId: "family-1",
        member: { id: "parent-1", firstName: "Parent", lastName: "Member", email: "parent@example.test", active: true, archivedAt: null },
      } } }],
    }]);
    mocks.chargeFindMany.mockResolvedValue([{
      id: "charge-closed", createdAt: new Date("2026-06-01T00:00:00.000Z"),
      familyGroupId: "family-1", membershipTypeId: "type-1", billingBasis: "PER_FAMILY", status: "NOT_REQUIRED",
      coverage: [
        { memberName: "Parent Member", subscriptionStatusAtClose: "PAID", subscription: { memberId: "parent-1", status: "PAID", member: { billingFamilyGroupId: null, familyGroupMemberships: [{ familyGroupId: "family-1" }] } } },
        { memberName: "Kid Member", subscriptionStatusAtClose: "PAID", subscription: { memberId: "member-1", status: "NOT_INVOICED", member: { billingFamilyGroupId: null, familyGroupMemberships: [{ familyGroupId: "family-1" }] } } },
      ],
    }]);
    mocks.chargeUpsert.mockResolvedValue({ id: "charge-rebill" });
  }

  it("confirming through a partly-reversed closed family invoices the family fee and leaves no OPEN warning behind (#4110 owner decision)", async () => {
    seedPartlyReversedClosedFamily();
    const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-07-13T00:00:00.000Z") });
    expect(preview.exceptions.map((item) => item.code)).toEqual(["CLOSED_FAMILY_PARTLY_REVERSED"]);

    const result = await confirmSubscriptionBillingPreview({
      preview, expectedConfirmationToken: preview.confirmationToken, source: "ANNUAL_BATCH", confirmedByMemberId: "officer-1",
    });

    expect(mocks.chargeUpsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ familyGroupId: "family-1", chargedAmountCents: 30_000, recipientMemberId: "parent-1" }),
    }));
    expect(mocks.exceptionUpsert).not.toHaveBeenCalled();
    expect(result).toEqual({ chargeIds: ["charge-rebill"], exceptionCount: 0 });
    // The officer's confirm bills the family, so a warning an earlier approval
    // left OPEN is superseded: its fingerprint is not kept out of the resolve.
    const warningFingerprint = preview.exceptions[0]!.fingerprint;
    const resolve = mocks.exceptionUpdateMany.mock.calls[0]![0] as { where: { fingerprint?: { notIn: string[] } } };
    expect(resolve.where.fingerprint?.notIn ?? []).not.toContain(warningFingerprint);
    // The officer's audit row records the warning they confirmed through (#4110 review F7).
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    const [entry] = mocks.audit.mock.calls[0]! as [{ memberId: string; details: string }];
    expect(entry.memberId).toBe("officer-1");
    expect(JSON.parse(entry.details)).toMatchObject({
      source: "ANNUAL_BATCH",
      chargeCount: 1,
      exceptionCount: 0,
      totalCents: 30_000,
      acknowledgedWarnings: [{
        code: "CLOSED_FAMILY_PARTLY_REVERSED",
        familyGroupId: "family-1",
        context: { closedChargeId: "charge-closed", reversedMemberNames: ["Kid Member"] },
      }],
    });
  });

  it("membership approval withholds a partly-reversed closed family: no charge, the warning OPEN for Finance, and counted (#4110 review F2)", async () => {
    seedPartlyReversedClosedFamily();

    const result = await queueApprovedMembershipSubscriptionCharges({
      memberIds: ["member-1"],
      approvedByMemberId: "approver-1",
      decisionDate: new Date("2026-07-13T00:00:00.000Z"),
    });

    // No officer saw the warning, so the family is not invoiced.
    expect(mocks.chargeUpsert).not.toHaveBeenCalled();
    expect(mocks.operationCreate).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
    // The warning is left OPEN for Finance, saying why it was not invoiced.
    expect(mocks.exceptionUpsert).toHaveBeenCalledTimes(1);
    const upsert = mocks.exceptionUpsert.mock.calls[0]![0] as {
      update: { status: string; message: string; source: string };
      create: { code: string; message: string; source: string; familyGroupId: string };
    };
    expect(upsert.update).toMatchObject({ status: "OPEN", source: "NEW_MEMBER_APPROVAL" });
    expect(upsert.create).toMatchObject({ code: "CLOSED_FAMILY_PARTLY_REVERSED", source: "NEW_MEMBER_APPROVAL", familyGroupId: "family-1" });
    expect(upsert.create.message).toContain("It was not invoiced on membership approval");
    // Counted, so the approver sees "requires Finance review".
    expect(result).toEqual({ chargeIds: [], exceptionCount: 1 });
    // The approver's audit row records it as withheld, not acknowledged.
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    const details = JSON.parse((mocks.audit.mock.calls[0]![0] as { details: string }).details) as Record<string, unknown>;
    expect(details).toMatchObject({ source: "NEW_MEMBER_APPROVAL", chargeCount: 0, exceptionCount: 1, acknowledgedWarnings: [], totalCents: 0 });
  });

  it("membership approval withholds the family when the only standing payment is under an OLDER closed charge (review round 4 F-B)", async () => {
    seedPartlyReversedClosedFamily();
    const row = (memberId: string, memberName: string, status: string) => ({
      memberName, subscriptionStatusAtClose: "PAID",
      subscription: { memberId, status, member: { billingFamilyGroupId: null, familyGroupMemberships: [{ familyGroupId: "family-1" }] } },
    });
    const closed = (id: string, createdAt: string, coverage: unknown[]) => ({
      id, createdAt: new Date(createdAt), familyGroupId: "family-1", membershipTypeId: "type-1",
      billingBasis: "PER_FAMILY", status: "NOT_REQUIRED", coverage,
    });
    // The parent's payment stands under the older charge; the newest covered
    // only the kid, who was reversed. Newest decides: re-bill, with the warning.
    mocks.chargeFindMany.mockResolvedValue([
      closed("charge-newer", "2026-06-01T00:00:00.000Z", [row("member-1", "Kid Member", "NOT_INVOICED")]),
      closed("charge-older", "2026-05-01T00:00:00.000Z", [row("parent-1", "Parent Member", "PAID")]),
    ]);

    const result = await queueApprovedMembershipSubscriptionCharges({
      memberIds: ["member-1"],
      approvedByMemberId: "approver-1",
      decisionDate: new Date("2026-07-13T00:00:00.000Z"),
    });

    expect(mocks.chargeUpsert).not.toHaveBeenCalled();
    expect(mocks.exceptionUpsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ code: "CLOSED_FAMILY_PARTLY_REVERSED", source: "NEW_MEMBER_APPROVAL" }),
    }));
    expect(result).toEqual({ chargeIds: [], exceptionCount: 1 });
  });

  it("membership approval withholds a re-bill that sits beside a member's own Xero invoice (review round 5 item 2)", async () => {
    seedPartlyReversedClosedFamily();
    mocks.chargeFindMany.mockResolvedValue([{
      id: "charge-closed", createdAt: new Date("2026-06-01T00:00:00.000Z"),
      familyGroupId: "family-1", membershipTypeId: "type-1", billingBasis: "PER_FAMILY", status: "NOT_REQUIRED",
      coverage: [
        // The parent's payment at the close was reversed: the family is billed again.
        { memberName: "Parent Member", subscriptionStatusAtClose: "PAID", subscription: { memberId: "parent-1", status: "NOT_INVOICED", xeroInvoiceId: null, xeroInvoiceNumber: null, member: { billingFamilyGroupId: null, familyGroupMemberships: [{ familyGroupId: "family-1" }] } } },
        // The kid, exempt at the close, holds Finance's difference invoice.
        { memberName: "Kid Member", subscriptionStatusAtClose: "NOT_REQUIRED", subscription: { memberId: "member-1", status: "UNPAID", xeroInvoiceId: "xi-diff", xeroInvoiceNumber: "INV-DIFF", member: { billingFamilyGroupId: null, familyGroupMemberships: [{ familyGroupId: "family-1" }] } } },
      ],
    }]);
    // The kid's invoice is a bare live invoice the #2161 hold reads; as their
    // difference invoice it passes, and the re-bill is flagged beside it.
    mocks.familyGroupMemberFindMany.mockResolvedValue([{
      familyGroupId: "family-1", memberId: "member-1",
      member: {
        firstName: "Kid", lastName: "Member", role: "USER", dateOfBirth: null, ageTier: "ADULT",
        seasonalMembershipAssignments: [{ membershipType: { id: "type-1", key: "FAMILY", name: "Family", subscriptionBehavior: "REQUIRED" } }],
        subscriptions: [{ xeroInvoiceId: "xi-diff", xeroInvoiceNumber: "INV-DIFF", status: "UNPAID", chargeCoverage: [] }],
      },
    }]);

    const result = await queueApprovedMembershipSubscriptionCharges({
      memberIds: ["member-1"],
      approvedByMemberId: "approver-1",
      decisionDate: new Date("2026-07-13T00:00:00.000Z"),
    });

    expect(mocks.chargeUpsert).not.toHaveBeenCalled();
    expect(mocks.exceptionUpsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ code: "CLOSED_FAMILY_REBILL_BESIDE_INVOICE", source: "NEW_MEMBER_APPROVAL" }),
    }));
    expect(result).toEqual({ chargeIds: [], exceptionCount: 1 });
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

  describe("subscription category decoupling", () => {
    beforeEach(() => {
      mocks.categoryFee.mockResolvedValue({
        id: "cat-fee-1", amountCents: 20_000, prorationRule: "NONE",
      });
      mocks.memberFindMany.mockResolvedValue([{
        id: "member-1", firstName: "Member", lastName: "One", email: "member@example.test",
        role: "USER",
        seasonalMembershipAssignments: [{
          membershipType: { id: "type-1", key: "FULL", name: "Full", subscriptionBehavior: "REQUIRED" },
          subscriptionCategory: { id: "cat-1", key: "couple", name: "Couple", isActive: true },
        }],
        familyGroupMemberships: [],
      }]);
    });

    it("mints a charge on the category axis with membershipType* null and subscriptionCategory* populated", async () => {
      const preview = await buildSubscriptionBillingPreview({
        seasonYear: 2026,
        decisionDate: new Date("2026-07-13T00:00:00.000Z"),
      });
      expect(preview.entries).toHaveLength(1);
      await confirmSubscriptionBillingPreview({
        preview,
        expectedConfirmationToken: preview.confirmationToken,
        source: "ANNUAL_BATCH",
      });
      expect(mocks.chargeUpsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({
          membershipAnnualFeeId: null,
          membershipTypeId: null,
          membershipTypeKey: null,
          membershipTypeName: null,
          subscriptionCategoryId: "cat-1",
          subscriptionCategoryKey: "couple",
          subscriptionCategoryName: "Couple",
          subscriptionCategoryFeeId: "cat-fee-1",
          billingBasis: "PER_FAMILY",
          chargedAmountCents: 20_000,
          // No per-covered-member membershipTypeId/Name — dropped from the
          // redesign (write-only, nothing ever read them back).
          coverage: {
            create: [{
              subscriptionId: "subscription-1", memberId: "member-1", memberName: "Member One",
            }],
          },
        }),
      }));
    });
  });
});
