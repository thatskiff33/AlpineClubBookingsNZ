import { beforeEach, describe, expect, it, vi } from "vitest";

// #2041: checkMembershipStatus must honour BASED_ON_AGE_TIER dominance — an
// already-swept tier-exempt member (NOT_REQUIRED season row) must not be
// re-marked required by a Xero sync after a manual mid-season tier promotion.
const mocks = vi.hoisted(() => ({
  memberFindUnique: vi.fn(),
  subFindUnique: vi.fn(),
  updateMany: vi.fn(),
  createMany: vi.fn(),
  resolvePolicy: vi.fn(),
  lockoutSettings: vi.fn(),
  enqueueHostingCoverage: vi.fn(async () => 0),
  settleHostingCoverage: vi.fn(async () => ({})),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: (() => {
    const client = {
    member: { findUnique: mocks.memberFindUnique },
    booking: { findMany: vi.fn(async () => []) },
    memberSubscription: {
      findUnique: mocks.subFindUnique,
      updateMany: mocks.updateMany,
      createMany: mocks.createMany,
    },
    };
    return {
      ...client,
      $transaction: (cb: (tx: typeof client) => unknown) => cb(client),
    };
  })(),
}));
vi.mock("@/lib/adult-member-hosting-review", () => ({
  enqueueHostingCoverageReevaluationForMember: mocks.enqueueHostingCoverage,
}));
vi.mock("@/lib/adult-member-hosting-coverage-drain", () => ({
  settleHostingCoverageAfterCommit: mocks.settleHostingCoverage,
}));
vi.mock("@/lib/membership-type-policy", () => ({
  resolveMembershipTypePolicyForMember: mocks.resolvePolicy,
}));
// CHILD is age-exempt; YOUTH and ADULT owe a subscription.
vi.mock("@/lib/age-tier", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/age-tier")),
  getAgeTierSettings: vi.fn(async () => [
    { tier: "CHILD", minAge: 5, maxAge: 12, label: "Child", sortOrder: 1, subscriptionRequiredForBooking: false },
    { tier: "YOUTH", minAge: 13, maxAge: 17, label: "Youth", sortOrder: 2, subscriptionRequiredForBooking: true },
    { tier: "ADULT", minAge: 18, maxAge: null, label: "Adult", sortOrder: 3, subscriptionRequiredForBooking: true },
  ]),
}));
vi.mock("@/lib/membership-lockout-settings", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/membership-lockout-settings")),
  loadMembershipLockoutSettings: mocks.lockoutSettings,
  loadMembershipLockoutSettingsStrict: mocks.lockoutSettings,
}));
const NOT_CHOSEN = { requiredTypeAgeRule: "NOT_CHOSEN", liabilityAgeSource: "NOT_CHOSEN" };

import { checkMembershipStatus } from "@/lib/xero-membership-sync";

describe("checkMembershipStatus BASED_ON_AGE_TIER dominance (#2041)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // writeXeroDerivedSubscriptionState updates the existing row (fence matches
    // manuallyMarkedPaidAt = null), so count is 1 and it never creates.
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.createMany.mockResolvedValue({ count: 0 });
    mocks.lockoutSettings.mockResolvedValue({ mode: "HARD_BLOCK", ...NOT_CHOSEN });
  });

  it("while NOT_CHOSEN, a NOT_REQUIRED row dominates: an exempt member promoted to a requiring tier stays NOT_REQUIRED", async () => {
    mocks.memberFindUnique.mockResolvedValue({ id: "m1", role: "USER", ageTier: "YOUTH", xeroContactId: null });
    mocks.subFindUnique.mockResolvedValue({
      status: "NOT_REQUIRED", manuallyMarkedPaidAt: null, xeroInvoiceId: null,
      xeroOnlineInvoiceUrl: null, paidAt: null,
    });
    mocks.resolvePolicy.mockResolvedValue({ subscriptionBehavior: "BASED_ON_AGE_TIER" });
    // Stored YOUTH would require one.

    const result = await checkMembershipStatus("m1", 2026);

    expect(result.status).toBe("NOT_REQUIRED");
    expect(mocks.resolvePolicy).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueHostingCoverage).toHaveBeenCalledWith(
      "m1",
      expect.anything(),
      // #3123: the club's day, resolved before the transaction opened.
      expect.any(Date),
      { cause: "SYSTEM_CHANGE" },
    );
    expect(mocks.settleHostingCoverage).toHaveBeenCalledTimes(1);
  });

  it("consults the type policy (membership type is the sole authority, #2149), then defers to the age-tier flag", async () => {
    // #2149: role-based exemption dropped — checkMembershipStatus now always
    // resolves the effective membership type. A non-NOT_REQUIRED type with no
    // dominating NOT_REQUIRED row falls through to the per-age-tier flag.
    mocks.memberFindUnique.mockResolvedValue({ id: "m1", role: "USER", ageTier: "CHILD", xeroContactId: null });
    mocks.subFindUnique.mockResolvedValue({
      status: "NOT_INVOICED", manuallyMarkedPaidAt: null, xeroInvoiceId: null,
      xeroOnlineInvoiceUrl: null, paidAt: null,
    });
    mocks.resolvePolicy.mockResolvedValue({ subscriptionBehavior: "REQUIRED" });
    // Exempt CHILD on a REQUIRED type: exempt on the access side while NOT_CHOSEN.

    const result = await checkMembershipStatus("m1", 2026);

    expect(result.status).toBe("NOT_REQUIRED");
    expect(mocks.resolvePolicy).toHaveBeenCalledTimes(1);
  });

  it("once the club has chosen, the season row exempts nobody and its REQUIRED-type rule decides (#5190)", async () => {
    mocks.lockoutSettings.mockResolvedValue({
      mode: "HARD_BLOCK",
      requiredTypeAgeRule: "ALWAYS_OWES",
      liabilityAgeSource: "SEASON_START",
    });
    mocks.memberFindUnique.mockResolvedValue({ id: "m1", role: "USER", ageTier: "YOUTH", dateOfBirth: null, xeroContactId: null });
    mocks.subFindUnique.mockResolvedValue({
      status: "NOT_REQUIRED", manuallyMarkedPaidAt: null, xeroInvoiceId: null,
      xeroOnlineInvoiceUrl: null, paidAt: null,
    });
    mocks.resolvePolicy.mockResolvedValue({ subscriptionBehavior: "BASED_ON_AGE_TIER" });
    await expect(checkMembershipStatus("m1", 2026)).resolves.toMatchObject({ status: "NOT_INVOICED" });

    mocks.memberFindUnique.mockResolvedValue({ id: "m1", role: "USER", ageTier: "CHILD", dateOfBirth: null, xeroContactId: null });
    mocks.subFindUnique.mockResolvedValue({
      status: "NOT_INVOICED", manuallyMarkedPaidAt: null, xeroInvoiceId: null,
      xeroOnlineInvoiceUrl: null, paidAt: null,
    });
    mocks.resolvePolicy.mockResolvedValue({ subscriptionBehavior: "REQUIRED" });
    await expect(checkMembershipStatus("m1", 2026)).resolves.toMatchObject({ status: "NOT_INVOICED" });
  });

  it("a NOT_REQUIRED membership type is never billed regardless of role (#2149)", async () => {
    // A bare ADMIN/LODGE account resolves via the role→default-type fallback to
    // its own NOT_REQUIRED built-in type; the age-tier flag is never consulted.
    mocks.memberFindUnique.mockResolvedValue({ id: "m1", role: "ADMIN", ageTier: "ADULT", xeroContactId: null });
    mocks.subFindUnique.mockResolvedValue({
      status: "NOT_INVOICED", manuallyMarkedPaidAt: null, xeroInvoiceId: null,
      xeroOnlineInvoiceUrl: null, paidAt: null,
    });
    mocks.resolvePolicy.mockResolvedValue({ subscriptionBehavior: "NOT_REQUIRED" });

    const result = await checkMembershipStatus("m1", 2026);

    expect(result.status).toBe("NOT_REQUIRED");
    expect(mocks.resolvePolicy).toHaveBeenCalledTimes(1);
  });

  it("REQUIRED types are byte-unchanged: a NOT_REQUIRED row does NOT dominate; the required path runs", async () => {
    mocks.memberFindUnique.mockResolvedValue({ id: "m1", role: "USER", ageTier: "YOUTH", xeroContactId: null });
    mocks.subFindUnique.mockResolvedValue({
      status: "NOT_REQUIRED", manuallyMarkedPaidAt: null, xeroInvoiceId: null,
      xeroOnlineInvoiceUrl: null, paidAt: null,
    });
    mocks.resolvePolicy.mockResolvedValue({ subscriptionBehavior: "REQUIRED" });

    const result = await checkMembershipStatus("m1", 2026);

    // Required path (no Xero contact, no immutable charge invoice) returns
    // NOT_INVOICED — the dominance branch did NOT fire for a REQUIRED type.
    expect(result.status).toBe("NOT_INVOICED");
  });
});
