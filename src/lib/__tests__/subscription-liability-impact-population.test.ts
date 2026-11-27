import { describe, expect, it, vi } from "vitest";
import { requireCalendarDate } from "@/lib/club-time";

// #5190 review: the impact list speaks for the members the billing run
// considers, reading their season rows with the same untouched-row select the
// clear-up and the row note use. Its stale-record list is the clear-up's own
// selection for the proposed rule, so it names exactly the rows saving resets.

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
const findStaleNotRequiredRows = vi.hoisted(() =>
  vi.fn(async () => [{ memberId: "gone", name: "Archived Member", inBillingPopulation: false }]),
);
vi.mock("@/lib/member-subscription-defaults", () => ({ findStaleNotRequiredRows }));
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
      today: requireCalendarDate("2026-07-01"),
    });
    const args = (findMany.mock.calls[0] as unknown as [
      { where: unknown; select: { subscriptions: { select: unknown } } },
    ])[0];
    expect(args.where).toEqual(SUBSCRIPTION_BILLING_POPULATION_WHERE);
    expect(args.select.subscriptions.select).toEqual({
      ...SEASON_ROW_STATE_SELECT,
      xeroInvoiceNumber: true,
    });
    // Stale records come from the clear-up's selection, under the proposed
    // rule, including a member outside the billing population. Each row's
    // members-list status is read under the stored settings, which the members
    // list shows today (owner decision 22 Nov 2026).
    expect(findStaleNotRequiredRows).toHaveBeenCalledWith(expect.anything(), {
      seasonYear: 2026,
      settings: { requiredTypeAgeRule: "ALWAYS_OWES", liabilityAgeSource: "SEASON_START" },
      listSettings: { requiredTypeAgeRule: "NOT_CHOSEN", liabilityAgeSource: "NOT_CHOSEN" },
      today: "2026-07-01",
    });
    expect(impact.staleRecords).toEqual([
      { memberId: "gone", name: "Archived Member", inBillingPopulation: false },
    ]);
  });
});
