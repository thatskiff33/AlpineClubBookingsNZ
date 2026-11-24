import { describe, expect, it, vi } from "vitest";

// #5190 review: the impact list speaks for the members the billing run
// considers, reading their season rows with the same untouched-row select the
// clear-up and the row note use.

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/age-tier", () => ({
  getAgeTierSettingsStrict: async () => [
    { tier: "CHILD", minAge: 5, maxAge: 12, label: "Child", sortOrder: 1, subscriptionRequiredForBooking: false },
    { tier: "ADULT", minAge: 18, maxAge: null, label: "Adult", sortOrder: 3, subscriptionRequiredForBooking: true },
  ],
}));
vi.mock("@/lib/membership-lockout-settings", () => ({
  loadMembershipLockoutSettingsStrict: async () => ({
    requiredTypeAgeRule: "NOT_CHOSEN",
    liabilityAgeSource: "NOT_CHOSEN",
  }),
}));
vi.mock("@/lib/membership-type-policy", () => ({
  resolveMembershipTypePoliciesForMembers: async () =>
    new Map([["m1", { subscriptionBehavior: "BASED_ON_AGE_TIER" }]]),
}));

import { SUBSCRIPTION_BILLING_POPULATION_WHERE } from "@/lib/subscription-billing-population";
import { buildSubscriptionLiabilityImpact } from "@/lib/subscription-liability-impact";
import { SEASON_ROW_STATE_SELECT } from "@/lib/subscription-season-row-note";

describe("buildSubscriptionLiabilityImpact reads the billing population (#5190)", () => {
  it("filters members as the billing run does and reads rows with the shared select", async () => {
    const findMany = vi.fn(async () => [
      {
        id: "m1",
        firstName: "Stale",
        lastName: "Row",
        ageTier: "ADULT",
        dateOfBirth: null,
        subscriptions: [
          {
            status: "NOT_REQUIRED",
            xeroInvoiceId: null,
            xeroInvoiceNumber: null,
            manuallyMarkedPaidAt: null,
            chargeCoverage: [],
          },
        ],
      },
    ]);
    const impact = await buildSubscriptionLiabilityImpact({ member: { findMany } } as never, {
      seasonYear: 2026,
      proposed: { requiredTypeAgeRule: "ALWAYS_OWES", liabilityAgeSource: "SEASON_START" },
    });
    const args = (findMany.mock.calls[0] as unknown as [
      { where: unknown; select: { subscriptions: { select: unknown } } },
    ])[0];
    expect(args.where).toEqual(SUBSCRIPTION_BILLING_POPULATION_WHERE);
    expect(args.select.subscriptions.select).toEqual({
      ...SEASON_ROW_STATE_SELECT,
      xeroInvoiceNumber: true,
    });
    // The untouched NOT_REQUIRED row of a member the rule says owes is stale.
    expect(impact.staleRecords).toEqual([{ memberId: "m1", name: expect.any(String) }]);
  });
});
