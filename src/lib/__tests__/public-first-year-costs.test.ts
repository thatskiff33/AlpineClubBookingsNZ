import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  membershipTypes: vi.fn(),
  ageTiers: vi.fn(),
  lockoutSettings: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: {
  publicContentSettings: { findUnique: mocks.settings },
  membershipType: { findMany: mocks.membershipTypes },
  ageTierSetting: { findMany: mocks.ageTiers },
  membershipLockoutSettings: { findUnique: mocks.lockoutSettings },
} }));

import { loadPublicFirstYearCosts } from "@/lib/public-first-year-costs";
import { CLUB_FORMAT_TEST, CLUB_FORMAT_TEST_OTHER } from "./support/club-format-fixture";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.lockoutSettings.mockResolvedValue(null);
  mocks.settings.mockImplementation(({ select }: { select: Record<string, boolean> }) =>
    Object.fromEntries(Object.keys(select).map((key) => [key, true])),
  );
});

describe("loadPublicFirstYearCosts (#4295)", () => {
  const tiers = [
    { tier: "YOUTH", label: "Youth", sortOrder: 1, subscriptionRequiredForBooking: true },
    { tier: "ADULT", label: "Adult", sortOrder: 2, subscriptionRequiredForBooking: true },
  ];
  const annual = (ageTier: string | null, amountCents: number, extra: Record<string, unknown> = {}) => ({
    ageTier, amountCents, billingBasis: "PER_MEMBER", prorationRule: "NONE", ...extra,
  });
  const row = (label: string, amountCents: number, feeLabel: string) => ({ label, fee: { amountCents, label: feeLabel } });
  const heading = "Joining fee plus first year's subscription";
  const type = (extra: Record<string, unknown>) => ({
    key: "T", name: "T", ageGroupsApply: false, subscriptionBehavior: "REQUIRED", joiningFees: [], annualFees: [], ...extra,
  });

  it("adds the joining fee to the annual fee per tier and a per-family fee once", async () => {
    mocks.ageTiers.mockResolvedValue(tiers);
    mocks.membershipTypes.mockResolvedValue([
      type({ key: "FULL", name: "Full Member", ageGroupsApply: true,
        joiningFees: [{ ageTier: "ADULT", amountCents: 32000 }, { ageTier: "YOUTH", amountCents: 12000 }],
        annualFees: [annual("ADULT", 7000), annual("YOUTH", 3500)] }),
      type({ key: "FAMILY", name: "Family", ageGroupsApply: true,
        joiningFees: [{ ageTier: null, amountCents: 36000 }],
        annualFees: [annual(null, 14000, { billingBasis: "PER_FAMILY" })] }),
    ]);
    await expect(loadPublicFirstYearCosts(CLUB_FORMAT_TEST)).resolves.toEqual([
      { heading, rows: [
        row("Full Member — Youth", 15500, "$155.00"),
        row("Full Member — Adult", 39000, "$390.00"),
        row("Family", 50000, "$500.00"),
      ] },
    ]);
  });

  it("orders rows by the type order, then the configured age order, whatever order the rows arrive in", async () => {
    mocks.ageTiers.mockResolvedValue(tiers);
    mocks.membershipTypes.mockResolvedValue([
      type({ key: "B", name: "Bb", ageGroupsApply: false, joiningFees: [{ ageTier: null, amountCents: 100 }], annualFees: [annual(null, 100)] }),
      type({ key: "A", name: "Aa", ageGroupsApply: true,
        joiningFees: [{ ageTier: "ADULT", amountCents: 100 }, { ageTier: "YOUTH", amountCents: 100 }],
        annualFees: [annual("ADULT", 100), annual("YOUTH", 100)] }),
    ]);
    const [group] = await loadPublicFirstYearCosts(CLUB_FORMAT_TEST);
    expect(group.rows.map((r) => r.label)).toEqual(["Bb", "Aa — Youth", "Aa — Adult"]);
  });

  it("uses the newest joining and annual rows (rows arrive effectiveFrom desc)", async () => {
    mocks.ageTiers.mockResolvedValue(tiers);
    mocks.membershipTypes.mockResolvedValue([
      type({ key: "FULL", name: "Full", ageGroupsApply: true,
        joiningFees: [{ ageTier: "ADULT", amountCents: 32000 }, { ageTier: "ADULT", amountCents: 1 }],
        annualFees: [annual("ADULT", 8500), annual("ADULT", 7000)] }),
    ]);
    await expect(loadPublicFirstYearCosts(CLUB_FORMAT_TEST)).resolves.toEqual([
      { heading, rows: [row("Full — Adult", 40500, "$405.00")] },
    ]);
    const select = mocks.membershipTypes.mock.calls[0][0].select;
    expect(select.joiningFees.where).toEqual(select.annualFees.where);
    expect(select.joiningFees.orderBy).toEqual([{ effectiveFrom: "desc" }]);
    expect(select.annualFees.orderBy).toEqual([{ effectiveFrom: "desc" }]);
  });

  it("falls back to the flat joining row for a tier with none of its own", async () => {
    mocks.ageTiers.mockResolvedValue(tiers);
    mocks.membershipTypes.mockResolvedValue([
      type({ key: "FULL", name: "Full", ageGroupsApply: true,
        joiningFees: [{ ageTier: null, amountCents: 10000 }], annualFees: [annual("ADULT", 7000)] }),
    ]);
    await expect(loadPublicFirstYearCosts(CLUB_FORMAT_TEST)).resolves.toEqual([
      { heading, rows: [row("Full — Adult", 17000, "$170.00")] },
    ]);
  });

  it("falls back to the flat annual row for a tier with none of its own, and adds no bare-type row", async () => {
    mocks.ageTiers.mockResolvedValue(tiers);
    mocks.membershipTypes.mockResolvedValue([
      type({ key: "FULL", name: "Full", ageGroupsApply: true,
        joiningFees: [{ ageTier: "ADULT", amountCents: 32000 }, { ageTier: "YOUTH", amountCents: 12000 }],
        annualFees: [annual(null, 7000)] }),
    ]);
    await expect(loadPublicFirstYearCosts(CLUB_FORMAT_TEST)).resolves.toEqual([
      { heading, rows: [row("Full — Youth", 19000, "$190.00"), row("Full — Adult", 39000, "$390.00")] },
    ]);
  });

  it("reads only the flat rows of a type without age groups", async () => {
    mocks.ageTiers.mockResolvedValue(tiers);
    mocks.membershipTypes.mockResolvedValue([
      type({ key: "ORG", name: "Org", ageGroupsApply: false,
        joiningFees: [{ ageTier: null, amountCents: 10000 }, { ageTier: "ADULT", amountCents: 99900 }],
        annualFees: [annual("ADULT", 88800), annual(null, 20000)] }),
    ]);
    await expect(loadPublicFirstYearCosts(CLUB_FORMAT_TEST)).resolves.toEqual([
      { heading, rows: [row("Org", 30000, "$300.00")] },
    ]);
  });

  it("counts a no-invoice fee as nothing whatever its amount or proration, and drops a type that totals zero", async () => {
    mocks.membershipTypes.mockResolvedValue([
      type({ key: "LIFE", name: "Life", joiningFees: [{ ageTier: null, amountCents: 5000 }],
        annualFees: [annual(null, 9999, { billingBasis: "NO_INVOICE", prorationRule: "REMAINING_MONTHS_INCLUSIVE" })] }),
      type({ key: "GUEST", name: "Guest", annualFees: [annual(null, 0, { billingBasis: "NO_INVOICE" })] }),
    ]);
    await expect(loadPublicFirstYearCosts(CLUB_FORMAT_TEST)).resolves.toEqual([
      { heading, rows: [row("Life", 5000, "$50.00")] },
    ]);
  });

  it("leaves out a tier with no annual fee set, rather than showing the joining fee as the total", async () => {
    mocks.membershipTypes.mockResolvedValue([
      type({ key: "FAMILY", name: "Family", ageGroupsApply: true, joiningFees: [{ ageTier: null, amountCents: 36000 }] }),
    ]);
    await expect(loadPublicFirstYearCosts(CLUB_FORMAT_TEST)).resolves.toEqual([]);
  });

  it("adds no subscription for a type whose subscription is not required", async () => {
    mocks.membershipTypes.mockResolvedValue([
      type({ key: "HON", name: "Honorary", subscriptionBehavior: "NOT_REQUIRED",
        joiningFees: [{ ageTier: null, amountCents: 5000 }], annualFees: [annual(null, 7000)] }),
    ]);
    await expect(loadPublicFirstYearCosts(CLUB_FORMAT_TEST)).resolves.toEqual([
      { heading, rows: [row("Honorary", 5000, "$50.00")] },
    ]);
  });

  describe("a type priced by age tier, where a tier may not need a subscription", () => {
    const exemptChild = [
      { tier: "CHILD", label: "Child", sortOrder: 0, subscriptionRequiredForBooking: false },
      { tier: "ADULT", label: "Adult", sortOrder: 2, subscriptionRequiredForBooking: true },
    ];
    const joiningFees = [{ ageTier: "ADULT", amountCents: 32000 }, { ageTier: "CHILD", amountCents: 1000 }];

    it("adds nothing for the exempt tier on a per-member fee", async () => {
      mocks.ageTiers.mockResolvedValue(exemptChild);
      mocks.membershipTypes.mockResolvedValue([
        type({ key: "FULL", name: "Full", ageGroupsApply: true, subscriptionBehavior: "BASED_ON_AGE_TIER",
          joiningFees, annualFees: [annual(null, 7000)] }),
      ]);
      await expect(loadPublicFirstYearCosts(CLUB_FORMAT_TEST)).resolves.toEqual([
        { heading, rows: [row("Full — Child", 1000, "$10.00"), row("Full — Adult", 39000, "$390.00")] },
      ]);
    });

    it("still adds a per-family fee to the exempt tier", async () => {
      mocks.ageTiers.mockResolvedValue(exemptChild);
      mocks.membershipTypes.mockResolvedValue([
        type({ key: "FULL", name: "Full", ageGroupsApply: true, subscriptionBehavior: "BASED_ON_AGE_TIER",
          joiningFees, annualFees: [annual(null, 14000, { billingBasis: "PER_FAMILY" })] }),
      ]);
      await expect(loadPublicFirstYearCosts(CLUB_FORMAT_TEST)).resolves.toEqual([
        { heading, rows: [row("Full — Child", 15000, "$150.00"), row("Full — Adult", 46000, "$460.00")] },
      ]);
    });

    // #5190 Edge 1: an always-required type charges every tier until the club
    // chooses AGE_TIER_EXEMPTS, which the public figure follows like billing.
    it("follows the club's rule for an exempt tier on an always-required type", async () => {
      mocks.ageTiers.mockResolvedValue(exemptChild);
      mocks.membershipTypes.mockResolvedValue([
        type({ key: "FULL", name: "Full", ageGroupsApply: true, subscriptionBehavior: "REQUIRED",
          joiningFees, annualFees: [annual(null, 7000)] }),
      ]);
      await expect(loadPublicFirstYearCosts(CLUB_FORMAT_TEST)).resolves.toEqual([
        { heading, rows: [row("Full — Child", 8000, "$80.00"), row("Full — Adult", 39000, "$390.00")] },
      ]);
      mocks.lockoutSettings.mockResolvedValue({ requiredTypeAgeRule: "AGE_TIER_EXEMPTS", liabilityAgeSource: "SEASON_START" });
      await expect(loadPublicFirstYearCosts(CLUB_FORMAT_TEST)).resolves.toEqual([
        { heading, rows: [row("Full — Child", 1000, "$10.00"), row("Full — Adult", 39000, "$390.00")] },
      ]);
    });

    it("keeps the exempt tier when no annual fee resolves for it at all", async () => {
      mocks.ageTiers.mockResolvedValue(exemptChild);
      mocks.membershipTypes.mockResolvedValue([
        type({ key: "FULL", name: "Full", ageGroupsApply: true, subscriptionBehavior: "BASED_ON_AGE_TIER",
          joiningFees, annualFees: [annual("ADULT", 7000)] }),
      ]);
      await expect(loadPublicFirstYearCosts(CLUB_FORMAT_TEST)).resolves.toEqual([
        { heading, rows: [row("Full — Child", 1000, "$10.00"), row("Full — Adult", 39000, "$390.00")] },
      ]);
    });
  });

  it("shows 'up to' when the annual fee is prorated, and not for a no-invoice one", async () => {
    mocks.membershipTypes.mockResolvedValue([
      type({ key: "ORG", name: "Org", joiningFees: [{ ageTier: null, amountCents: 1000 }],
        annualFees: [annual(null, 9000, { prorationRule: "REMAINING_MONTHS_INCLUSIVE" })] }),
    ]);
    await expect(loadPublicFirstYearCosts(CLUB_FORMAT_TEST)).resolves.toEqual([
      { heading, rows: [{ label: "Org", fee: { amountCents: 10000, label: "up to $100.00" } }] },
    ]);
  });

  it("formats the total in the club's format", async () => {
    mocks.membershipTypes.mockResolvedValue([
      type({ key: "ORG", name: "Org", joiningFees: [{ ageTier: null, amountCents: 1000 }], annualFees: [annual(null, 9000)] }),
    ]);
    const [group] = await loadPublicFirstYearCosts(CLUB_FORMAT_TEST_OTHER);
    expect(group.rows[0].fee.label).toBe(new Intl.NumberFormat("de-CH", { style: "currency", currency: "CHF" }).format(100));
  });

  it("limits to one listed type, and an unlisted type gives the empty state", async () => {
    mocks.membershipTypes.mockResolvedValue([
      type({ key: "FULL", name: "Full", joiningFees: [{ ageTier: null, amountCents: 1000 }], annualFees: [annual(null, 2000)] }),
      type({ key: "FAMILY", name: "Family", joiningFees: [{ ageTier: null, amountCents: 3000 }], annualFees: [annual(null, 4000)] }),
    ]);
    await expect(loadPublicFirstYearCosts(CLUB_FORMAT_TEST, { typeKey: "family" })).resolves.toEqual([
      { heading, rows: [row("Family", 7000, "$70.00")] },
    ]);
    await expect(loadPublicFirstYearCosts(CLUB_FORMAT_TEST, { typeKey: "NOT_LISTED" })).resolves.toEqual([]);
  });

  it.each([["entranceFees"], ["annualFees"]])("renders nothing while the %s opt-in is off", async (off) => {
    mocks.settings.mockImplementation(({ select }: { select: Record<string, boolean> }) =>
      Object.fromEntries(Object.keys(select).map((key) => [key, key !== off])),
    );
    mocks.membershipTypes.mockResolvedValue([
      type({ key: "FULL", name: "Full", joiningFees: [{ ageTier: null, amountCents: 1000 }], annualFees: [annual(null, 2000)] }),
    ]);
    await expect(loadPublicFirstYearCosts(CLUB_FORMAT_TEST)).resolves.toEqual([]);
    expect(mocks.membershipTypes).not.toHaveBeenCalled();
  });
});
