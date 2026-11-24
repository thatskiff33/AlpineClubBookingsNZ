import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  buildImpact: vi.fn(),
}));
vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/club-time/server", () => ({ clubTimeZone: async () => "Pacific/Auckland" }));
vi.mock("@/lib/subscription-liability-impact", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/subscription-liability-impact")),
  buildSubscriptionLiabilityImpact: mocks.buildImpact,
}));

import { GET } from "@/app/api/admin/membership-lockout-settings/liability-impact/route";
import {
  classifyLiabilityImpact,
  type LiabilityImpactFacts,
} from "@/lib/subscription-liability-impact";

// #5190: before a club opts in to a liability rule, the officer reads who it
// changes. This pins the comparison on the two edges the issue names, and that
// the endpoint previews only a rule the club could actually save.

const AGE_TIER_SETTINGS = [
  { tier: "CHILD" as const, minAge: 5, maxAge: 12, label: "Child", sortOrder: 1, subscriptionRequiredForBooking: false },
  { tier: "YOUTH" as const, minAge: 13, maxAge: 17, label: "Youth", sortOrder: 2, subscriptionRequiredForBooking: true },
  { tier: "ADULT" as const, minAge: 18, maxAge: null, label: "Adult", sortOrder: 3, subscriptionRequiredForBooking: true },
];
const NOT_CHOSEN = { requiredTypeAgeRule: "NOT_CHOSEN", liabilityAgeSource: "NOT_CHOSEN" } as const;

function facts(
  memberId: string,
  subscriptionBehavior: LiabilityImpactFacts["subscriptionBehavior"],
  ageTier: "CHILD" | "YOUTH" | "ADULT",
  seasonRow: Partial<NonNullable<LiabilityImpactFacts["seasonRow"]>> | null = null,
): LiabilityImpactFacts {
  return {
    memberId,
    name: memberId,
    subscriptionBehavior,
    member: { ageTier, dateOfBirth: null },
    seasonRow: seasonRow && {
      status: "NOT_INVOICED",
      xeroInvoiceId: null,
      xeroInvoiceNumber: null,
      manuallyMarkedPaidAt: null,
      chargeCoverage: [],
      ...seasonRow,
    },
  };
}

function classify(proposed: { requiredTypeAgeRule: "ALWAYS_OWES" | "AGE_TIER_EXEMPTS"; liabilityAgeSource: "SEASON_START" | "SEASON_END" }, members: LiabilityImpactFacts[]) {
  return classifyLiabilityImpact({
    seasonYear: 2026,
    current: NOT_CHOSEN,
    proposed,
    ageTierSettings: AGE_TIER_SETTINGS,
    members,
  });
}

describe("classifyLiabilityImpact (#5190)", () => {
  it("Edge 1: a REQUIRED-type child is billed today but may book; each choice changes one side", () => {
    const child = facts("child", "REQUIRED", "CHILD", { status: "UNPAID", xeroInvoiceNumber: "INV-7" });

    const alwaysOwes = classify({ requiredTypeAgeRule: "ALWAYS_OWES", liabilityAgeSource: "SEASON_START" }, [child]);
    expect(alwaysOwes.newlyOwing).toEqual([
      { memberId: "child", name: "child", billingChanges: false, accessChanges: true },
    ]);
    expect(alwaysOwes.noLongerOwing).toEqual([]);

    const ageExempts = classify({ requiredTypeAgeRule: "AGE_TIER_EXEMPTS", liabilityAgeSource: "SEASON_START" }, [child]);
    expect(ageExempts.noLongerOwing).toEqual([
      { memberId: "child", name: "child", billingChanges: true, accessChanges: false, unpaidInvoiceNumber: "INV-7" },
    ]);
    expect(ageExempts.newlyOwing).toEqual([]);
  });

  it("Edge 2: a saved NOT_REQUIRED row on a liable age-based member stops exempting them, and is a stale record", () => {
    const youth = facts("youth", "BASED_ON_AGE_TIER", "YOUTH", { status: "NOT_REQUIRED" });
    const impact = classify({ requiredTypeAgeRule: "AGE_TIER_EXEMPTS", liabilityAgeSource: "SEASON_START" }, [youth]);

    expect(impact.newlyOwing).toEqual([
      { memberId: "youth", name: "youth", billingChanges: false, accessChanges: true },
    ]);
    expect(impact.staleRecords).toEqual([{ memberId: "youth", name: "youth" }]);
  });

  it("lists nobody whose answers do not move, and never a covered, invoiced or marked row as stale", () => {
    const members = [
      facts("adult", "REQUIRED", "ADULT", { status: "PAID" }),
      facts("life", "NOT_REQUIRED", "ADULT", { status: "NOT_REQUIRED" }),
      facts("covered", "BASED_ON_AGE_TIER", "YOUTH", { status: "NOT_REQUIRED", chargeCoverage: [{ id: "claim" }] }),
      facts("invoiced", "BASED_ON_AGE_TIER", "YOUTH", { status: "NOT_REQUIRED", xeroInvoiceId: "x" }),
      facts("marked", "BASED_ON_AGE_TIER", "YOUTH", { status: "NOT_REQUIRED", manuallyMarkedPaidAt: new Date() }),
    ];
    const impact = classify({ requiredTypeAgeRule: "AGE_TIER_EXEMPTS", liabilityAgeSource: "SEASON_START" }, members);

    expect(impact.newlyOwing.map((member) => member.memberId)).toEqual(["covered", "invoiced", "marked"]);
    expect(impact.noLongerOwing).toEqual([]);
    expect(impact.staleRecords).toEqual([]);
  });
});

describe("GET /api/admin/membership-lockout-settings/liability-impact (#5190)", () => {
  const get = (query: string) =>
    GET(new NextRequest(`http://localhost/api/admin/membership-lockout-settings/liability-impact${query}`));

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ ok: true, session: { user: { id: "admin-1" } } });
    mocks.buildImpact.mockResolvedValue({ newlyOwing: [], noLongerOwing: [] });
  });

  it("requires membership view", async () => {
    mocks.requireAdmin.mockResolvedValueOnce({
      ok: false,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    });
    const response = await get("?requiredTypeAgeRule=ALWAYS_OWES&liabilityAgeSource=SEASON_START");
    expect(response.status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({ permission: { area: "membership", level: "view" } });
    expect(mocks.buildImpact).not.toHaveBeenCalled();
  });

  it.each([
    ["no proposal", ""],
    ["half a proposal", "?requiredTypeAgeRule=ALWAYS_OWES"],
    ["not chosen", "?requiredTypeAgeRule=NOT_CHOSEN&liabilityAgeSource=NOT_CHOSEN"],
    ["age today", "?requiredTypeAgeRule=ALWAYS_OWES&liabilityAgeSource=CURRENT_AGE"],
  ])("refuses %s", async (_label, query) => {
    const response = await get(query);
    expect(response.status).toBe(400);
    expect(mocks.buildImpact).not.toHaveBeenCalled();
  });

  // #5190 review: the list is membership-view data, but an unpaid invoice
  // number is finance data, shown only to a caller who also holds finance view.
  describe("unpaid invoice numbers", () => {
    const noLongerOwing = [
      { memberId: "m1", name: "Sam Child", billingChanges: true, accessChanges: false, unpaidInvoiceNumber: "INV-0042" },
    ];
    const proposal = "?requiredTypeAgeRule=AGE_TIER_EXEMPTS&liabilityAgeSource=SEASON_START";
    const signedInWith = (adminPermissionMatrix: Record<string, string>) =>
      mocks.requireAdmin.mockResolvedValue({
        ok: true,
        session: { user: { id: "officer-1", accessRoles: ["USER"], adminPermissionMatrix } },
      });

    beforeEach(() => {
      mocks.buildImpact.mockResolvedValue({ newlyOwing: [], noLongerOwing: structuredClone(noLongerOwing) });
    });

    it("are hidden from a membership-only caller", async () => {
      signedInWith({ membership: "view" });
      const body = await (await get(proposal)).json();
      expect(body.invoiceNumbersShown).toBe(false);
      expect(body.impact.noLongerOwing).toEqual([{ ...noLongerOwing[0], unpaidInvoiceNumber: null }]);
      expect(JSON.stringify(body)).not.toContain("INV-0042");
    });

    it("are shown to a caller who also holds finance view", async () => {
      signedInWith({ membership: "view", finance: "view" });
      const body = await (await get(proposal)).json();
      expect(body.invoiceNumbersShown).toBe(true);
      expect(body.impact.noLongerOwing).toEqual(noLongerOwing);
    });
  });

  it("previews a saveable rule for the club's current season", async () => {
    const response = await get("?requiredTypeAgeRule=AGE_TIER_EXEMPTS&liabilityAgeSource=SEASON_END");
    expect(response.status).toBe(200);
    expect(mocks.buildImpact).toHaveBeenCalledWith(expect.anything(), {
      seasonYear: 2026,
      proposed: { requiredTypeAgeRule: "AGE_TIER_EXEMPTS", liabilityAgeSource: "SEASON_END" },
    });
  });
});
