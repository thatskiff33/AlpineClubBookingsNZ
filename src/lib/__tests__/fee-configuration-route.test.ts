import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const values = {
  requireAdmin: vi.fn(),
  hasAdminAreaAccess: vi.fn(),
  revalidatePath: vi.fn(),
  createAuditLog: vi.fn(),
  membershipTypeFindMany: vi.fn(),
  membershipTypeFindUnique: vi.fn(),
  membershipFeeFindFirst: vi.fn(),
  membershipFeeFindUnique: vi.fn(),
  membershipFeeCreate: vi.fn(),
  membershipFeeUpdate: vi.fn(),
  membershipFeeDelete: vi.fn(),
  componentCreateMany: vi.fn(),
  componentDeleteMany: vi.fn(),
  joiningFeeFindFirst: vi.fn(),
  joiningFeeFindUnique: vi.fn(),
  joiningFeeCreate: vi.fn(),
  joiningFeeUpdate: vi.fn(),
  joiningFeeDelete: vi.fn(),
  familyGroupFindMany: vi.fn(),
  familyGroupFindUnique: vi.fn(),
  familyGroupUpdate: vi.fn(),
  familyGroupMemberFindUnique: vi.fn(),
  memberFindUnique: vi.fn(),
  memberUpdate: vi.fn(),
  itemMappingFindFirst: vi.fn(),
  accountMappingFindUnique: vi.fn(),
  billingSettingsFindUnique: vi.fn(),
    executeRaw: vi.fn(),
  subscriptionCategoryFindMany: vi.fn(),
  subscriptionCategoryFindUnique: vi.fn(),
  subscriptionCategoryFeeFindFirst: vi.fn(),
  subscriptionCategoryFeeFindUnique: vi.fn(),
  subscriptionCategoryFeeCreate: vi.fn(),
  subscriptionCategoryFeeUpdate: vi.fn(),
  subscriptionCategoryFeeDelete: vi.fn(),
  categoryComponentCreateMany: vi.fn(),
  categoryComponentDeleteMany: vi.fn(),
  };
  const prisma = {
  membershipType: { findMany: values.membershipTypeFindMany, findUnique: values.membershipTypeFindUnique },
  membershipAnnualFee: {
    findFirst: values.membershipFeeFindFirst, findUnique: values.membershipFeeFindUnique,
    create: values.membershipFeeCreate, update: values.membershipFeeUpdate, delete: values.membershipFeeDelete,
  },
  membershipAnnualFeeComponent: {
    createMany: values.componentCreateMany, deleteMany: values.componentDeleteMany,
  },
  subscriptionCategory: { findMany: values.subscriptionCategoryFindMany, findUnique: values.subscriptionCategoryFindUnique },
  subscriptionCategoryFee: {
    findFirst: values.subscriptionCategoryFeeFindFirst, findUnique: values.subscriptionCategoryFeeFindUnique,
    create: values.subscriptionCategoryFeeCreate, update: values.subscriptionCategoryFeeUpdate, delete: values.subscriptionCategoryFeeDelete,
  },
  subscriptionCategoryFeeComponent: {
    createMany: values.categoryComponentCreateMany, deleteMany: values.categoryComponentDeleteMany,
  },
  joiningFee: {
    findFirst: values.joiningFeeFindFirst,
    findUnique: values.joiningFeeFindUnique, create: values.joiningFeeCreate,
    update: values.joiningFeeUpdate, delete: values.joiningFeeDelete,
  },
  familyGroup: { findMany: values.familyGroupFindMany, findUnique: values.familyGroupFindUnique, update: values.familyGroupUpdate },
  familyGroupMember: { findUnique: values.familyGroupMemberFindUnique },
  member: { findUnique: values.memberFindUnique, update: values.memberUpdate },
  xeroItemCodeMapping: { findFirst: values.itemMappingFindFirst },
  xeroAccountMapping: { findUnique: values.accountMappingFindUnique },
  membershipSubscriptionBillingSettings: { findUnique: values.billingSettingsFindUnique },
  $executeRaw: values.executeRaw,
  $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) => callback(prisma));
  return { ...values, prisma };
});

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/admin-permissions", () => ({ hasAdminAreaAccess: mocks.hasAdminAreaAccess }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/audit", () => ({ createAuditLog: mocks.createAuditLog }));

import { GET, POST } from "@/app/api/admin/fee-configuration/route";

const session = { user: { id: "admin-1", adminPermissionMatrix: { finance: "edit" } } };
function post(body: unknown) {
  return POST(new Request("http://localhost/api/admin/fee-configuration", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }));
}

describe("fee configuration route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ ok: true, session });
    mocks.hasAdminAreaAccess.mockReturnValue(true);
    mocks.membershipTypeFindMany.mockResolvedValue([]);
    mocks.membershipTypeFindUnique.mockResolvedValue({ id: "type-1" });
    mocks.membershipFeeFindFirst.mockResolvedValue(null);
    mocks.membershipFeeFindUnique.mockResolvedValue(null);
    mocks.membershipFeeCreate.mockResolvedValue({ id: "fee-1" });
    mocks.membershipFeeUpdate.mockResolvedValue({ id: "fee-1" });
    mocks.membershipFeeDelete.mockResolvedValue({ id: "fee-1" });
    mocks.componentCreateMany.mockResolvedValue({ count: 1 });
    mocks.componentDeleteMany.mockResolvedValue({ count: 0 });
    mocks.joiningFeeFindFirst.mockResolvedValue(null);
    mocks.joiningFeeFindUnique.mockResolvedValue(null);
    mocks.joiningFeeCreate.mockResolvedValue({ id: "joining-1" });
    mocks.joiningFeeUpdate.mockResolvedValue({ id: "joining-1" });
    mocks.joiningFeeDelete.mockResolvedValue({ id: "joining-1" });
    mocks.familyGroupFindMany.mockResolvedValue([]);
    mocks.familyGroupFindUnique.mockResolvedValue({ id: "family-1" });
    mocks.familyGroupMemberFindUnique.mockResolvedValue({ id: "membership-1", member: { active: true, archivedAt: null } });
    mocks.memberFindUnique.mockResolvedValue({ id: "member-1" });
    mocks.memberUpdate.mockResolvedValue({ id: "member-1" });
    mocks.familyGroupUpdate.mockResolvedValue({ id: "family-1" });
    mocks.itemMappingFindFirst.mockResolvedValue(null);
    mocks.accountMappingFindUnique.mockResolvedValue(null);
    // No settings row -> behaviour-preserving default (family billing mode).
    mocks.billingSettingsFindUnique.mockResolvedValue(null);
    mocks.subscriptionCategoryFindMany.mockResolvedValue([]);
    mocks.subscriptionCategoryFindUnique.mockResolvedValue({ id: "cat-1" });
    mocks.subscriptionCategoryFeeFindFirst.mockResolvedValue(null);
    mocks.subscriptionCategoryFeeFindUnique.mockResolvedValue(null);
    mocks.subscriptionCategoryFeeCreate.mockResolvedValue({ id: "cat-fee-1" });
    mocks.subscriptionCategoryFeeUpdate.mockResolvedValue({ id: "cat-fee-1" });
    mocks.subscriptionCategoryFeeDelete.mockResolvedValue({ id: "cat-fee-1" });
    mocks.categoryComponentCreateMany.mockResolvedValue({ count: 1 });
    mocks.categoryComponentDeleteMany.mockResolvedValue({ count: 0 });
  });

  it("requires finance view for reads", async () => {
    const response = Response.json({ error: "Forbidden" }, { status: 403 });
    mocks.requireAdmin.mockResolvedValueOnce({ ok: false, response });
    expect((await GET()).status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({ permission: { area: "finance", level: "view" } });
  });

  it("requires finance edit before parsing writes", async () => {
    const forbidden = Response.json({ error: "Forbidden" }, { status: 403 });
    mocks.requireAdmin.mockResolvedValueOnce({ ok: false, response: forbidden });
    expect((await post({ action: "not-even-parsed" })).status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({ permission: { area: "finance", level: "edit" } });
  });

  it("rejects invalid mutation input", async () => {
    expect((await post({ action: "CREATE_JOINING_FEE", membershipTypeId: "type-1", ageTier: "ADULT", amountCents: 12.5, effectiveFrom: "bad" })).status).toBe(400);
  });

  it("returns an explicit read-only capability for finance viewers", async () => {
    mocks.hasAdminAreaAccess.mockReturnValue(false);
    await expect((await GET()).json()).resolves.toMatchObject({ canEdit: false });
  });

  it("surfaces only an EXPLICITLY-configured default income account code (#2068, F1)", async () => {
    // No xeroAccountMapping row -> subscriptionIncome is not explicitly
    // configured, so the invoice build would refuse to bill. The editor must NOT
    // advertise the hard-coded "203" fallback; it surfaces null instead.
    await expect((await GET()).json()).resolves.toMatchObject({ defaultInvoiceAccountCode: null });
    // An explicitly configured mapping is surfaced as-is.
    mocks.accountMappingFindUnique.mockResolvedValueOnce({ code: "215", itemCode: null });
    await expect((await GET()).json()).resolves.toMatchObject({ defaultInvoiceAccountCode: "215" });
  });

  it("creates and audits a membership schedule, then invalidates public pages", async () => {
    const response = await post({
      action: "CREATE_MEMBERSHIP_FEE", membershipTypeId: "type-1", amountCents: 12345,
      billingBasis: "PER_MEMBER", prorationRule: "NONE", effectiveFrom: "2026-07-13", effectiveTo: null,
    });
    expect(response.status).toBe(200);
    expect(mocks.membershipFeeCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ membershipTypeId: "type-1", amountCents: 12345 }) });
    expect(mocks.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "fee-configuration.create_membership_fee", targetId: "fee-1" }), mocks.prisma);
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("updates and deletes a joining fee schedule", async () => {
    mocks.joiningFeeFindUnique.mockResolvedValue({ id: "joining-1", membershipTypeId: "type-1", ageTier: "ADULT" });
    expect((await post({ action: "UPDATE_JOINING_FEE", id: "joining-1", amountCents: 5000, effectiveFrom: "2026-08-01", effectiveTo: null })).status).toBe(200);
    expect(mocks.joiningFeeUpdate).toHaveBeenCalledWith({ where: { id: "joining-1" }, data: expect.objectContaining({ amountCents: 5000 }) });
    expect((await post({ action: "DELETE_JOINING_FEE", id: "joining-1" })).status).toBe(200);
    expect(mocks.joiningFeeDelete).toHaveBeenCalledWith({ where: { id: "joining-1" } });
  });

  it("updates/deletes membership, creates entrance, clears family, and revalidates every action", async () => {
    // Same amount + basis -> no component reconciliation required (#1932, E6).
    mocks.membershipFeeFindUnique.mockResolvedValue({ id: "fee-1", membershipTypeId: "type-1", amountCents: 2000, billingBasis: "PER_MEMBER" });
    expect((await post({ action: "UPDATE_MEMBERSHIP_FEE", id: "fee-1", amountCents: 2000, billingBasis: "PER_MEMBER", prorationRule: "NONE", effectiveFrom: "2026-08-01", effectiveTo: null })).status).toBe(200);
    expect((await post({ action: "DELETE_MEMBERSHIP_FEE", id: "fee-1" })).status).toBe(200);
    expect((await post({ action: "CREATE_JOINING_FEE", membershipTypeId: "type-1", ageTier: "YOUTH", amountCents: 2500, effectiveFrom: "2026-08-01", effectiveTo: null })).status).toBe(200);
    expect((await post({ action: "SET_FAMILY_BILLING_MEMBER", familyGroupId: "family-1", billingMemberId: null })).status).toBe(200);
    expect(mocks.familyGroupUpdate).toHaveBeenCalledWith({ where: { id: "family-1" }, data: { billingMembershipId: null } });
    expect(mocks.revalidatePath).toHaveBeenCalledTimes(4);
  });

  it("auto-creates the default component when creating a membership fee (#1932, E6)", async () => {
    const response = await post({
      action: "CREATE_MEMBERSHIP_FEE", membershipTypeId: "type-1", amountCents: 12345,
      billingBasis: "PER_MEMBER", prorationRule: "NONE", effectiveFrom: "2026-07-13", effectiveTo: null,
    });
    expect(response.status).toBe(200);
    expect(mocks.componentCreateMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ membershipAnnualFeeId: "fee-1", label: "Annual membership fee", amountCents: 12345, prorate: true, sortOrder: 0 })],
    });
  });

  it("copies a same-amount predecessor's components onto a new effective-dated fee (#1932, E6)", async () => {
    mocks.membershipFeeFindFirst
      .mockResolvedValueOnce(null) // overlap check: no overlap
      .mockResolvedValueOnce({ // predecessor lookup
        id: "fee-0", amountCents: 20000,
        components: [
          { label: "Base membership", amountCents: 15000, prorate: true, xeroAccountCode: null, xeroItemCode: null, sortOrder: 0 },
          { label: "Work party fee", amountCents: 5000, prorate: false, xeroAccountCode: "260", xeroItemCode: null, sortOrder: 1 },
        ],
      });
    const response = await post({
      action: "CREATE_MEMBERSHIP_FEE", membershipTypeId: "type-1", amountCents: 20000,
      billingBasis: "PER_MEMBER", prorationRule: "NONE", effectiveFrom: "2027-07-01", effectiveTo: null,
    });
    expect(response.status).toBe(200);
    expect(mocks.componentCreateMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ label: "Base membership", amountCents: 15000, prorate: true }),
        expect.objectContaining({ label: "Work party fee", amountCents: 5000, prorate: false, xeroAccountCode: "260" }),
      ],
    });
  });

  it("replaces components atomically and validates the sum when supplied (#1932, E6)", async () => {
    const response = await post({
      action: "CREATE_MEMBERSHIP_FEE", membershipTypeId: "type-1", amountCents: 20000,
      billingBasis: "PER_MEMBER", prorationRule: "NONE", effectiveFrom: "2026-07-13", effectiveTo: null,
      components: [
        { label: "Base membership", amountCents: 15000, prorate: true, sortOrder: 0 },
        { label: "Work party fee", amountCents: 5000, prorate: false, sortOrder: 1 },
      ],
    });
    expect(response.status).toBe(200);
    expect(mocks.componentCreateMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ label: "Base membership", amountCents: 15000 }),
        expect.objectContaining({ label: "Work party fee", amountCents: 5000 }),
      ],
    });
  });

  it("rejects components that do not sum to the fee amount (#1932, E6)", async () => {
    const response = await post({
      action: "CREATE_MEMBERSHIP_FEE", membershipTypeId: "type-1", amountCents: 20000,
      billingBasis: "PER_MEMBER", prorationRule: "NONE", effectiveFrom: "2026-07-13", effectiveTo: null,
      components: [{ label: "Base membership", amountCents: 19999, prorate: true, sortOrder: 0 }],
    });
    expect(response.status).toBe(422);
    expect(mocks.componentCreateMany).not.toHaveBeenCalled();
  });

  it("rejects a fee-amount edit that does not reconcile its components (#1932, E6)", async () => {
    mocks.membershipFeeFindUnique.mockResolvedValue({ id: "fee-1", membershipTypeId: "type-1", amountCents: 1000, billingBasis: "PER_MEMBER" });
    const response = await post({
      action: "UPDATE_MEMBERSHIP_FEE", id: "fee-1", amountCents: 2000,
      billingBasis: "PER_MEMBER", prorationRule: "NONE", effectiveFrom: "2026-08-01", effectiveTo: null,
    });
    expect(response.status).toBe(422);
    expect(mocks.componentCreateMany).not.toHaveBeenCalled();
  });

  it("accepts a fee-amount edit that reconciles its components in the same request (#1932, E6)", async () => {
    mocks.membershipFeeFindUnique.mockResolvedValue({ id: "fee-1", membershipTypeId: "type-1", amountCents: 1000, billingBasis: "PER_MEMBER" });
    const response = await post({
      action: "UPDATE_MEMBERSHIP_FEE", id: "fee-1", amountCents: 2000,
      billingBasis: "PER_MEMBER", prorationRule: "NONE", effectiveFrom: "2026-08-01", effectiveTo: null,
      components: [{ label: "Annual membership fee", amountCents: 2000, prorate: true, sortOrder: 0 }],
    });
    expect(response.status).toBe(200);
    expect(mocks.componentDeleteMany).toHaveBeenCalledWith({ where: { membershipAnnualFeeId: "fee-1" } });
    expect(mocks.componentCreateMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ amountCents: 2000 })],
    });
  });

  it("sets a member's billing family when the chosen group is one of their families (#1932, E6)", async () => {
    mocks.familyGroupMemberFindUnique.mockResolvedValueOnce({ id: "membership-1" });
    const response = await post({ action: "SET_MEMBER_BILLING_FAMILY", memberId: "member-1", billingFamilyGroupId: "family-1" });
    expect(response.status).toBe(200);
    expect(mocks.memberUpdate).toHaveBeenCalledWith({ where: { id: "member-1" }, data: { billingFamilyGroupId: "family-1" } });
    expect(mocks.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "fee-configuration.set_member_billing_family", targetId: "member-1" }), mocks.prisma);
  });

  it("clears a member's billing family without a membership check (#1932, E6)", async () => {
    const response = await post({ action: "SET_MEMBER_BILLING_FAMILY", memberId: "member-1", billingFamilyGroupId: null });
    expect(response.status).toBe(200);
    expect(mocks.memberUpdate).toHaveBeenCalledWith({ where: { id: "member-1" }, data: { billingFamilyGroupId: null } });
  });

  it("rejects a billing family the member does not belong to (#1932, E6)", async () => {
    mocks.familyGroupMemberFindUnique.mockResolvedValueOnce(null);
    const response = await post({ action: "SET_MEMBER_BILLING_FAMILY", memberId: "member-1", billingFamilyGroupId: "family-9" });
    expect(response.status).toBe(422);
    expect(mocks.memberUpdate).not.toHaveBeenCalled();
  });

  it("returns not found for stale update and delete targets", async () => {
    expect((await post({ action: "UPDATE_MEMBERSHIP_FEE", id: "missing", amountCents: 2000, billingBasis: "PER_MEMBER", prorationRule: "NONE", effectiveFrom: "2026-08-01", effectiveTo: null })).status).toBe(404);
    expect((await post({ action: "DELETE_JOINING_FEE", id: "missing" })).status).toBe(404);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("rejects an overlapping range without writing", async () => {
    mocks.membershipFeeFindFirst.mockResolvedValueOnce({ id: "existing" });
    const response = await post({
      action: "CREATE_MEMBERSHIP_FEE", membershipTypeId: "type-1", amountCents: 100,
      billingBasis: "PER_MEMBER", prorationRule: "NONE", effectiveFrom: "2026-07-13", effectiveTo: null,
    });
    expect(response.status).toBe(409);
    expect(mocks.membershipFeeCreate).not.toHaveBeenCalled();
  });

  it("rejects a family recipient outside the active family and accepts a valid member", async () => {
    mocks.familyGroupMemberFindUnique.mockResolvedValueOnce(null);
    expect((await post({ action: "SET_FAMILY_BILLING_MEMBER", familyGroupId: "family-1", billingMemberId: "outsider" })).status).toBe(422);
    expect(mocks.familyGroupUpdate).not.toHaveBeenCalled();

    mocks.familyGroupMemberFindUnique.mockResolvedValueOnce({ id: "membership-1", member: { active: true, archivedAt: null } });
    expect((await post({ action: "SET_FAMILY_BILLING_MEMBER", familyGroupId: "family-1", billingMemberId: "member-1" })).status).toBe(200);
    expect(mocks.familyGroupUpdate).toHaveBeenCalledWith({ where: { id: "family-1" }, data: { billingMembershipId: "membership-1" } });
  });

  it("reports the family billing mode and flags billing exceptions in family mode", async () => {
    mocks.familyGroupFindMany.mockResolvedValue([
      { id: "family-1", name: "Alpha", billingMembershipId: null, billingMembership: null, memberships: [] },
    ]);
    const body = await (await GET()).json();
    expect(body.familyBillingMode).toBe("BILL_FAMILY_VIA_BILLING_MEMBER");
    // A membered family with no recipient is an exception in family mode.
    expect(body.familyGroups[0].billingException).toBe(true);
  });

  it("hides exceptions and reports individual mode when the club bills members individually", async () => {
    mocks.billingSettingsFindUnique.mockResolvedValue({ familyBillingMode: "BILL_MEMBERS_INDIVIDUALLY" });
    mocks.familyGroupFindMany.mockResolvedValue([
      { id: "family-1", name: "Alpha", billingMembershipId: null, billingMembership: null, memberships: [] },
    ]);
    const body = await (await GET()).json();
    expect(body.familyBillingMode).toBe("BILL_MEMBERS_INDIVIDUALLY");
    // Same recipient-less family raises no exception under individual billing.
    expect(body.familyGroups[0].billingException).toBe(false);
  });

  // Review finding: the built-in "Individual" sentinel must never reach this
  // card's own category picker (it defaulted to it, being sortOrder 0 and
  // always first) — excluded at the query itself, not filtered client-side.
  it("excludes the built-in Individual category from the subscription-category-fees list", async () => {
    await GET();
    expect(mocks.subscriptionCategoryFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isBuiltIn: false } }),
    );
  });

  it("allows a per-family schedule in family mode", async () => {
    const response = await post({
      action: "CREATE_MEMBERSHIP_FEE", membershipTypeId: "type-1", amountCents: 20000,
      billingBasis: "PER_FAMILY", prorationRule: "NONE", effectiveFrom: "2026-07-13", effectiveTo: null,
    });
    expect(response.status).toBe(200);
    expect(mocks.membershipFeeCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ billingBasis: "PER_FAMILY" }) });
  });

  it("blocks a per-family schedule server-side when the club bills members individually", async () => {
    mocks.billingSettingsFindUnique.mockResolvedValue({ familyBillingMode: "BILL_MEMBERS_INDIVIDUALLY" });
    const response = await post({
      action: "CREATE_MEMBERSHIP_FEE", membershipTypeId: "type-1", amountCents: 20000,
      billingBasis: "PER_FAMILY", prorationRule: "NONE", effectiveFrom: "2026-07-13", effectiveTo: null,
    });
    expect(response.status).toBe(409);
    expect(mocks.membershipFeeCreate).not.toHaveBeenCalled();
    // Per-member schedules are still accepted under individual billing.
    expect((await post({
      action: "CREATE_MEMBERSHIP_FEE", membershipTypeId: "type-1", amountCents: 20000,
      billingBasis: "PER_MEMBER", prorationRule: "NONE", effectiveFrom: "2026-07-13", effectiveTo: null,
    })).status).toBe(200);
  });

  describe("per-age-tier annual fees (#2067)", () => {
    it("creates a per-age-tier annual fee row", async () => {
      const response = await post({
        action: "CREATE_MEMBERSHIP_FEE", membershipTypeId: "type-1", ageTier: "YOUTH", amountCents: 6000,
        billingBasis: "PER_MEMBER", prorationRule: "NONE", effectiveFrom: "2026-07-13", effectiveTo: null,
      });
      expect(response.status).toBe(200);
      expect(mocks.membershipFeeCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({ membershipTypeId: "type-1", ageTier: "YOUTH", amountCents: 6000 }),
      });
    });

    it("defaults a create with no ageTier to the flat NULL-tier row", async () => {
      await post({
        action: "CREATE_MEMBERSHIP_FEE", membershipTypeId: "type-1", amountCents: 12000,
        billingBasis: "PER_MEMBER", prorationRule: "NONE", effectiveFrom: "2026-07-13", effectiveTo: null,
      });
      expect(mocks.membershipFeeCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({ ageTier: null }),
      });
    });

    it("rejects a per-family fee carrying an age tier with 409 (decision 1)", async () => {
      const response = await post({
        action: "CREATE_MEMBERSHIP_FEE", membershipTypeId: "type-1", ageTier: "ADULT", amountCents: 6000,
        billingBasis: "PER_FAMILY", prorationRule: "NONE", effectiveFrom: "2026-07-13", effectiveTo: null,
      });
      expect(response.status).toBe(409);
      expect(mocks.membershipFeeCreate).not.toHaveBeenCalled();
    });

    it("allows a per-tier fee to coexist with a flat per-member fee", async () => {
      // same-tier overlap: none; cross-tier mix (flat PER_FAMILY): none; predecessor: none.
      mocks.membershipFeeFindFirst.mockResolvedValue(null);
      const response = await post({
        action: "CREATE_MEMBERSHIP_FEE", membershipTypeId: "type-1", ageTier: "ADULT", amountCents: 6000,
        billingBasis: "PER_MEMBER", prorationRule: "NONE", effectiveFrom: "2026-07-13", effectiveTo: null,
      });
      expect(response.status).toBe(200);
      expect(mocks.membershipFeeCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({ ageTier: "ADULT" }),
      });
    });

    it("rejects a same-tier overlapping window", async () => {
      mocks.membershipFeeFindFirst.mockResolvedValueOnce({ id: "fee-adult" }); // same-tier overlap hit
      const response = await post({
        action: "CREATE_MEMBERSHIP_FEE", membershipTypeId: "type-1", ageTier: "ADULT", amountCents: 6000,
        billingBasis: "PER_MEMBER", prorationRule: "NONE", effectiveFrom: "2026-07-13", effectiveTo: null,
      });
      expect(response.status).toBe(409);
      expect(mocks.membershipFeeCreate).not.toHaveBeenCalled();
    });

    it("blocks a flat per-family window overlapping per-tier fees for the same type", async () => {
      mocks.membershipFeeFindFirst
        .mockResolvedValueOnce(null) // same-tier (flat) overlap: none
        .mockResolvedValueOnce({ id: "fee-youth" }); // cross-tier mix: a per-tier row overlaps
      const response = await post({
        action: "CREATE_MEMBERSHIP_FEE", membershipTypeId: "type-1", amountCents: 20000,
        billingBasis: "PER_FAMILY", prorationRule: "NONE", effectiveFrom: "2026-07-13", effectiveTo: null,
      });
      expect(response.status).toBe(409);
      expect(mocks.membershipFeeCreate).not.toHaveBeenCalled();
    });

    it("blocks a per-tier fee overlapping a flat per-family window", async () => {
      mocks.membershipFeeFindFirst
        .mockResolvedValueOnce(null) // same-tier overlap: none
        .mockResolvedValueOnce({ id: "fee-family" }); // cross-tier mix: a flat PER_FAMILY row overlaps
      const response = await post({
        action: "CREATE_MEMBERSHIP_FEE", membershipTypeId: "type-1", ageTier: "ADULT", amountCents: 6000,
        billingBasis: "PER_MEMBER", prorationRule: "NONE", effectiveFrom: "2026-07-13", effectiveTo: null,
      });
      expect(response.status).toBe(409);
      expect(mocks.membershipFeeCreate).not.toHaveBeenCalled();
    });

    it("copies only a same-tier predecessor's components onto a new tier fee", async () => {
      mocks.membershipFeeFindFirst
        .mockResolvedValueOnce(null) // same-tier overlap: none
        .mockResolvedValueOnce(null) // cross-tier mix (flat PER_FAMILY): none
        .mockResolvedValueOnce({ // same-tier YOUTH predecessor
          id: "fee-youth-0", amountCents: 6000,
          components: [{ label: "Youth base", amountCents: 6000, prorate: true, xeroAccountCode: null, xeroItemCode: null, sortOrder: 0 }],
        });
      const response = await post({
        action: "CREATE_MEMBERSHIP_FEE", membershipTypeId: "type-1", ageTier: "YOUTH", amountCents: 6000,
        billingBasis: "PER_MEMBER", prorationRule: "NONE", effectiveFrom: "2027-07-01", effectiveTo: null,
      });
      expect(response.status).toBe(200);
      // The predecessor lookup is scoped to the SAME tier.
      expect(mocks.membershipFeeFindFirst).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ membershipTypeId: "type-1", ageTier: "YOUTH", id: { not: "fee-1" } }),
      }));
      expect(mocks.componentCreateMany).toHaveBeenCalledWith({
        data: [expect.objectContaining({ label: "Youth base", amountCents: 6000 })],
      });
    });
  });

  // Subscription-category decoupling: a flat fee, independent of membership
  // type — no ageTier, no billingBasis, no individual-billing-mode gate.
  describe("subscription category fees", () => {
    it("creates a subscription category fee with a default component", async () => {
      const response = await post({
        action: "CREATE_SUBSCRIPTION_CATEGORY_FEE", subscriptionCategoryId: "cat-1",
        amountCents: 20000, prorationRule: "NONE", effectiveFrom: "2026-07-13", effectiveTo: null,
      });
      expect(response.status).toBe(200);
      expect(mocks.subscriptionCategoryFeeCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({ subscriptionCategoryId: "cat-1", amountCents: 20000 }),
      });
      expect(mocks.categoryComponentCreateMany).toHaveBeenCalledWith({
        data: [expect.objectContaining({ label: "Subscription fee", amountCents: 20000 })],
      });
    });

    it("404s creating a fee for an unknown subscription category", async () => {
      mocks.subscriptionCategoryFindUnique.mockResolvedValue(null);
      const response = await post({
        action: "CREATE_SUBSCRIPTION_CATEGORY_FEE", subscriptionCategoryId: "cat-missing",
        amountCents: 20000, prorationRule: "NONE", effectiveFrom: "2026-07-13", effectiveTo: null,
      });
      expect(response.status).toBe(404);
      expect(mocks.subscriptionCategoryFeeCreate).not.toHaveBeenCalled();
    });

    // Review finding: the built-in "Individual" sentinel is a routing signal,
    // never a priced category — rejected even if something bypasses the
    // card's own picker (which excludes it via `where: { isBuiltIn: false }`,
    // asserted separately below).
    it("rejects creating a fee for the built-in Individual category", async () => {
      mocks.subscriptionCategoryFindUnique.mockResolvedValue({ id: "cat-individual", isBuiltIn: true });
      const response = await post({
        action: "CREATE_SUBSCRIPTION_CATEGORY_FEE", subscriptionCategoryId: "cat-individual",
        amountCents: 20000, prorationRule: "NONE", effectiveFrom: "2026-07-13", effectiveTo: null,
      });
      expect(response.status).toBe(409);
      expect(mocks.subscriptionCategoryFeeCreate).not.toHaveBeenCalled();
    });

    it("rejects an overlapping effective window", async () => {
      mocks.subscriptionCategoryFeeFindFirst.mockResolvedValue({ id: "cat-fee-existing" });
      const response = await post({
        action: "CREATE_SUBSCRIPTION_CATEGORY_FEE", subscriptionCategoryId: "cat-1",
        amountCents: 20000, prorationRule: "NONE", effectiveFrom: "2026-07-13", effectiveTo: null,
      });
      expect(response.status).toBe(409);
      expect(mocks.subscriptionCategoryFeeCreate).not.toHaveBeenCalled();
    });

    it("rejects unknown fields (no ageTier/billingBasis concept)", async () => {
      const response = await post({
        action: "CREATE_SUBSCRIPTION_CATEGORY_FEE", subscriptionCategoryId: "cat-1",
        amountCents: 20000, prorationRule: "NONE", effectiveFrom: "2026-07-13", effectiveTo: null,
        billingBasis: "PER_FAMILY",
      });
      expect(response.status).toBe(400);
      expect(mocks.subscriptionCategoryFeeCreate).not.toHaveBeenCalled();
    });

    it("requires reconciled components when the amount changes on update", async () => {
      mocks.subscriptionCategoryFeeFindUnique.mockResolvedValue({ id: "cat-fee-1", subscriptionCategoryId: "cat-1", amountCents: 20000 });
      const response = await post({
        action: "UPDATE_SUBSCRIPTION_CATEGORY_FEE", id: "cat-fee-1",
        amountCents: 25000, prorationRule: "NONE", effectiveFrom: "2026-07-13", effectiveTo: null,
      });
      expect(response.status).toBe(422);
      expect(mocks.categoryComponentCreateMany).not.toHaveBeenCalled();
    });

    it("deletes a subscription category fee", async () => {
      mocks.subscriptionCategoryFeeFindUnique.mockResolvedValue({ id: "cat-fee-1", subscriptionCategoryId: "cat-1" });
      const response = await post({ action: "DELETE_SUBSCRIPTION_CATEGORY_FEE", id: "cat-fee-1" });
      expect(response.status).toBe(200);
      expect(mocks.subscriptionCategoryFeeDelete).toHaveBeenCalledWith({ where: { id: "cat-fee-1" } });
    });

    it("404s deleting an unknown subscription category fee", async () => {
      mocks.subscriptionCategoryFeeFindUnique.mockResolvedValue(null);
      const response = await post({ action: "DELETE_SUBSCRIPTION_CATEGORY_FEE", id: "cat-fee-missing" });
      expect(response.status).toBe(404);
      expect(mocks.subscriptionCategoryFeeDelete).not.toHaveBeenCalled();
    });
  });
});
