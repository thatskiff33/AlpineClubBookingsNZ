import type { AgeTier, MembershipTypeSubscriptionBehavior, Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Mid-season age-ups in the subscription billing run under "Age today" (#5190
 * PR 3; `INV-MONEY-051`..`053`): what the planner raises for each kind of
 * change, what it refuses to raise twice, when it says "settle in Xero"
 * instead, and what the confirm writes.
 *
 * Season 2026 runs 2026-04-01 to 2027-03-31. The default tiers exempt CHILD
 * (5-9) and bill YOUTH (10-17) and ADULT (18+). A birthday on 15 June leaves
 * ten whole months, June included.
 */

const mocks = vi.hoisted(() => ({
  effectiveFee: vi.fn(),
  mapping: vi.fn(),
  startOperation: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/authoritative-fees", () => ({ getEffectiveMembershipAnnualFee: mocks.effectiveFee }));
vi.mock("@/lib/xero-mappings", () => ({ getResolvedAccountMapping: mocks.mapping }));
vi.mock("@/lib/xero-sync", () => ({
  buildXeroIdempotencyKey: (...parts: unknown[]) => parts.join(":"),
  startXeroSyncOperation: mocks.startOperation,
}));

import { AGE_TIER_DEFAULTS, type AgeTierSettingData } from "@/lib/policies/age-tier";
import { liabilityRuleFor, type SubscriptionLiabilitySettings } from "@/lib/policies/subscription";
import type {
  SubscriptionBillingAgeUpAdjustment,
  SubscriptionBillingPlanEntry,
} from "@/lib/membership-subscription-billing-types";
import {
  ageUpCreditIdempotencyKey,
  ageUpTopUpChargeKey,
  confirmAgeUpAdjustments,
  createAgeUpPlanner,
  seasonChargeLiabilityRule,
  type AgeUpPlanMember,
  type AgeUpWarning,
} from "@/lib/subscription-age-up-billing";

const SEASON = 2026;
const AGE_TODAY: SubscriptionLiabilitySettings = {
  requiredTypeAgeRule: "AGE_TIER_EXEMPTS",
  liabilityAgeSource: "CURRENT_AGE",
};
const day = (value: string) => new Date(`${value}T00:00:00.000Z`);

type TypeRef = { id: string; key: string; name: string; subscriptionBehavior: MembershipTypeSubscriptionBehavior };
const FULL: TypeRef = { id: "type-full", key: "FULL", name: "Full", subscriptionBehavior: "BASED_ON_AGE_TIER" };

type Member = AgeUpPlanMember & { type: TypeRef };

function member(id: string, dateOfBirth: string, ageTier: AgeTier, overrides: Partial<Member> = {}): Member {
  return {
    id,
    firstName: id.charAt(0).toUpperCase() + id.slice(1),
    lastName: "Member",
    email: `${id}@example.test`,
    dateOfBirth: day(dateOfBirth),
    joinedDate: null,
    ageTier,
    seasonalMembershipAssignments: [{ subscriptionCategory: null }],
    type: FULL,
    ...overrides,
  };
}

/** Turns 18 on 2026-06-15: Youth at season start, Adult from that day. */
const turnsEighteen = (overrides: Partial<Member> = {}) => member("ella", "2008-06-15", "YOUTH", overrides);
/** Turns 10 on 2026-06-15: an exempt Child at season start, a Youth from that day. */
const turnsTen = (overrides: Partial<Member> = {}) => member("tom", "2016-06-15", "CHILD", overrides);

type Fee = { id: string; amountCents: number; billingBasis: "PER_MEMBER" | "PER_FAMILY" | "NO_INVOICE" };
let fees: Partial<Record<AgeTier, Fee>>;

/** The season charge this app already holds for a member, as the planner reads it. */
type StoredRow = {
  id: string;
  memberId: string;
  chargeCoverage: Array<{
    charge: {
      billingBasis: string;
      membershipTypeId: string | null;
      membershipAnnualFeeId: string | null;
      annualAmountCents: number;
      decisionDate: Date;
      _count: { coverage: number };
    };
  }>;
  ageUpAdjustments: Array<{ ageUpDate: Date; kind: "TOP_UP" | "CREDIT"; status: string }>;
};
let stored: StoredRow[];

function seasonRow(memberId: string, charge: Partial<StoredRow["chargeCoverage"][number]["charge"]> | null, adjustments: StoredRow["ageUpAdjustments"] = []): StoredRow {
  return {
    id: `subscription-${memberId}`,
    memberId,
    chargeCoverage: charge === null ? [] : [{
      charge: {
        billingBasis: "PER_MEMBER",
        membershipTypeId: FULL.id,
        membershipAnnualFeeId: "fee-YOUTH",
        annualAmountCents: 6_000,
        decisionDate: day("2026-04-10"),
        _count: { coverage: 1 },
        ...charge,
      },
    }],
    ageUpAdjustments: adjustments,
  };
}

/** A season entry this run is about to raise for the member alone. */
function entryFor(memberId: string, annualAmountCents: number, overrides: Record<string, unknown> = {}) {
  return {
    billingBasis: "PER_MEMBER",
    membershipTypeId: FULL.id,
    coveredMembers: [{ id: memberId }],
    annualAmountCents,
    ...overrides,
  } as unknown as SubscriptionBillingPlanEntry;
}

function planner(options: {
  settings?: SubscriptionLiabilitySettings;
  decisionDate?: string;
  scoped?: boolean;
  xeroInvoicingOff?: boolean;
  ageTierSettings?: AgeTierSettingData[];
} = {}) {
  const warnings: AgeUpWarning[] = [];
  const db = {
    memberSubscription: {
      findMany: vi.fn(async (args: { where: { memberId: { in: string[] } } }) =>
        stored.filter((row) => args.where.memberId.in.includes(row.memberId))),
    },
    membershipAnnualFee: {
      findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) =>
        args.where.id.in.map((id) => ({ id, ageTier: id.replace("fee-", "") as AgeTier }))),
    },
  };
  const built = createAgeUpPlanner({
    db: db as unknown as Prisma.TransactionClient,
    seasonYear: SEASON,
    decisionDate: day(options.decisionDate ?? "2026-07-01"),
    yearEndMonth: 3,
    rule: liabilityRuleFor("billing", options.settings ?? AGE_TODAY),
    scoped: options.scoped ?? false,
    xeroInvoicingOff: options.xeroInvoicingOff ?? false,
    ageTierSettings: async () => options.ageTierSettings ?? AGE_TIER_DEFAULTS,
    feeFor: async (_typeId, tier) => (tier ? fees[tier] ?? null : null) as never,
    warn: (warning) => warnings.push(warning),
  });
  const plan = (members: Member[], entries: SubscriptionBillingPlanEntry[] = []) =>
    built.planAdjustments({ members, entries, membershipTypeOf: (one) => one.type });
  return { built, plan, warnings, db };
}

beforeEach(() => {
  vi.clearAllMocks();
  fees = {
    YOUTH: { id: "fee-YOUTH", amountCents: 6_000, billingBasis: "PER_MEMBER" },
    ADULT: { id: "fee-ADULT", amountCents: 12_000, billingBasis: "PER_MEMBER" },
  };
  stored = [];
  mocks.effectiveFee.mockImplementation(async ({ ageTier }: { ageTier: AgeTier | null }) =>
    (ageTier ? fees[ageTier] ?? null : null));
  mocks.mapping.mockResolvedValue({ code: "200", itemCode: "SUB", codeExplicitlyConfigured: true });
});

describe("the rule the season charge is billed by (INV-MONEY-051)", () => {
  it("is the season-start age under \"Age today\", and the club's own rule otherwise", () => {
    const ageToday = liabilityRuleFor("billing", AGE_TODAY);
    expect(seasonChargeLiabilityRule(ageToday)).toEqual({ ...ageToday, ageSource: "SEASON_START" });
    const seasonEnd = liabilityRuleFor("billing", { ...AGE_TODAY, liabilityAgeSource: "SEASON_END" });
    expect(seasonChargeLiabilityRule(seasonEnd)).toBe(seasonEnd);
  });
});

describe("a member who ages into owing: the part-season charge (INV-MONEY-051)", () => {
  it("is priced at the new tier and decided on the birthday", async () => {
    const { built, warnings } = planner();

    expect(await built.partSeasonCharge(turnsTen(), FULL)).toEqual({
      feeTier: "YOUTH",
      decisionDate: day("2026-06-15"),
    });
    expect(warnings).toEqual([]);
  });

  it("is not raised before the birthday, and is raised on the day itself", async () => {
    expect(await planner({ decisionDate: "2026-06-14" }).built.partSeasonCharge(turnsTen(), FULL)).toBeNull();
    expect(await planner({ decisionDate: "2026-06-15" }).built.partSeasonCharge(turnsTen(), FULL)).not.toBeNull();
  });

  it("is decided on the join date for a member who joined after their birthday", async () => {
    const joinedLater = turnsTen({ joinedDate: day("2026-09-03") });

    expect(await planner({ decisionDate: "2026-10-01" }).built.partSeasonCharge(joinedLater, FULL))
      .toMatchObject({ decisionDate: day("2026-09-03") });
  });

  it("prices a type that always requires a subscription by the member's stored tier", async () => {
    const required: TypeRef = { ...FULL, id: "type-required", subscriptionBehavior: "REQUIRED" };

    expect(await planner().built.partSeasonCharge(turnsTen(), required)).toMatchObject({ feeTier: "CHILD" });
  });

  it("is not raised for a member who already owed at the season's start", async () => {
    expect(await planner().built.partSeasonCharge(turnsEighteen(), FULL)).toBeNull();
  });

  it("is not raised by a membership approval, which bills only its own members", async () => {
    expect(await planner({ scoped: true }).built.partSeasonCharge(turnsTen(), FULL)).toBeNull();
  });

  it("is not raised under any other age source", async () => {
    const seasonStart = { ...AGE_TODAY, liabilityAgeSource: "SEASON_START" } as const;
    expect(await planner({ settings: seasonStart }).built.partSeasonCharge(turnsTen(), FULL)).toBeNull();
  });

  it("warns instead when the new tier's fee is billed to the family on one invoice", async () => {
    fees.YOUTH = { id: "fee-YOUTH", amountCents: 6_000, billingBasis: "PER_FAMILY" };
    const { built, plan, warnings } = planner();
    const tom = turnsTen();

    expect(await built.partSeasonCharge(tom, FULL)).toBeNull();

    expect(warnings).toEqual([expect.objectContaining({
      memberId: "tom",
      membershipTypeId: FULL.id,
      message: "Tom Member's age group changed from Child to Youth on 2026-06-15, but their membership fee is billed to their family on one invoice. Settle the age-group change in Xero.",
      context: { memberName: "Tom Member", ageUpDate: "2026-06-15", fromAgeTier: "CHILD", toAgeTier: "YOUTH" },
    })]);
    // Warned once: the adjustments pass does not name them a second time.
    expect(await plan([tom])).toEqual([]);
    expect(warnings).toHaveLength(1);
  });
});

describe("a member who moves to a dearer tier: the top-up (INV-MONEY-052)", () => {
  const expectedTopUp: SubscriptionBillingAgeUpAdjustment = {
    key: "2026:age-up:ella:2026-06-15",
    kind: "TOP_UP",
    seasonYear: SEASON,
    memberId: "ella",
    memberName: "Ella Member",
    ageUpDate: "2026-06-15",
    fromAgeTier: "YOUTH",
    toAgeTier: "ADULT",
    coveredMonths: 10,
    fromAnnualCents: 6_000,
    toAnnualCents: 12_000,
    // (12000 - 6000) x 10 / 12.
    amountCents: 5_000,
    description: "Full membership 2026 - 2027 (10 months) — age group change, Youth to Adult",
    membershipTypeId: FULL.id,
    membershipTypeKey: "FULL",
    membershipTypeName: "Full",
    recipient: { id: "ella", name: "Ella Member", email: "ella@example.test" },
    xeroAccountCode: "200",
    xeroItemCode: "SUB",
  };

  it("is the fee difference for the months left, measured from the season charge this run raises", async () => {
    const { plan, warnings } = planner();

    expect(await plan([turnsEighteen()], [entryFor("ella", 6_000)])).toEqual([expectedTopUp]);
    expect(warnings).toEqual([]);
  });

  it("is measured from the season charge already raised, at the new tier's fee on the day that charge was priced", async () => {
    stored = [seasonRow("ella", { annualAmountCents: 6_000, decisionDate: day("2026-04-10") })];
    const { plan, db } = planner();

    expect(await plan([turnsEighteen()])).toEqual([expectedTopUp]);

    // A fee-schedule change since April is not billed as an age-up.
    expect(mocks.effectiveFee).toHaveBeenCalledWith(
      { membershipTypeId: FULL.id, ageTier: "ADULT" },
      day("2026-04-10"),
      db,
    );
  });

  it("rounds half a cent up", async () => {
    // (12001 - 6000) x 10 / 12 = 5000.83.
    fees.ADULT = { id: "fee-ADULT", amountCents: 12_001, billingBasis: "PER_MEMBER" };
    const [topUp] = await planner().plan([turnsEighteen()], [entryFor("ella", 6_000)]);
    expect(topUp).toMatchObject({ amountCents: 5_001 });

    // (12007 - 6000) x 1 / 12 = 500.58, for a birthday in the season's last month.
    fees.ADULT = { id: "fee-ADULT", amountCents: 12_007, billingBasis: "PER_MEMBER" };
    const march = member("ella", "2009-03-20", "YOUTH");
    const [late] = await planner({ decisionDate: "2027-03-25" }).plan([march], [entryFor("ella", 6_000)]);
    expect(late).toMatchObject({ coveredMonths: 1, amountCents: 501 });
  });

  it("is not raised before the birthday", async () => {
    expect(await planner({ decisionDate: "2026-06-14" }).plan([turnsEighteen()], [entryFor("ella", 6_000)])).toEqual([]);
  });

  it("is not raised when both tiers cost the same", async () => {
    fees.ADULT = { id: "fee-ADULT", amountCents: 6_000, billingBasis: "PER_MEMBER" };
    const { plan, warnings } = planner();

    expect(await plan([turnsEighteen()], [entryFor("ella", 6_000)])).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("is not raised for a type whose price does not follow age", async () => {
    const required: TypeRef = { ...FULL, id: "type-required", subscriptionBehavior: "REQUIRED" };
    const ella = turnsEighteen({ type: required });

    expect(await planner().plan([ella], [entryFor("ella", 6_000, { membershipTypeId: required.id })])).toEqual([]);
  });

  it("is not raised by a membership approval or under another age source", async () => {
    expect(await planner({ scoped: true }).plan([turnsEighteen()], [entryFor("ella", 6_000)])).toEqual([]);
    const seasonEnd = { ...AGE_TODAY, liabilityAgeSource: "SEASON_END" } as const;
    expect(await planner({ settings: seasonEnd }).plan([turnsEighteen()], [entryFor("ella", 6_000)])).toEqual([]);
  });

  it("is withheld, like every invoice, while the subscription income account is not mapped", async () => {
    mocks.mapping.mockResolvedValue({ code: "200", itemCode: null, codeExplicitlyConfigured: false });

    expect(await planner().plan([turnsEighteen()], [entryFor("ella", 6_000)])).toEqual([]);
  });

  it("is listed without an account, and without reading the mapping, in the read-only view while Xero is off", async () => {
    const [topUp] = await planner({ xeroInvoicingOff: true }).plan([turnsEighteen()], [entryFor("ella", 6_000)]);

    expect(topUp).toMatchObject({ kind: "TOP_UP", amountCents: 5_000, xeroAccountCode: null, xeroItemCode: null });
    expect(mocks.mapping).not.toHaveBeenCalled();
  });

  it("lists several members in key order, which the confirmation token depends on", async () => {
    const zoe = member("zoe", "2008-05-02", "YOUTH");
    const adam = member("adam", "2008-06-20", "YOUTH");

    const planned = await planner().plan([zoe, adam], [entryFor("zoe", 6_000), entryFor("adam", 6_000)]);

    expect(planned.map((item) => item.key)).toEqual(["2026:age-up:adam:2026-06-20", "2026:age-up:zoe:2026-05-02"]);
    // May leaves eleven months, June ten.
    expect(planned.map((item) => item.amountCents)).toEqual([5_000, 5_500]);
  });
});

describe("a member who moves to a cheaper tier, or out of owing: the credit (INV-MONEY-053)", () => {
  it("is the fee difference for the months left when the new tier is cheaper", async () => {
    fees = {
      YOUTH: { id: "fee-YOUTH", amountCents: 9_000, billingBasis: "PER_MEMBER" },
      ADULT: { id: "fee-ADULT", amountCents: 6_000, billingBasis: "PER_MEMBER" },
    };

    const [credit] = await planner().plan([turnsEighteen()], [entryFor("ella", 9_000)]);

    expect(credit).toMatchObject({
      kind: "CREDIT",
      fromAnnualCents: 9_000,
      toAnnualCents: 6_000,
      coveredMonths: 10,
      // (9000 - 6000) x 10 / 12, as a positive amount.
      amountCents: 2_500,
      description: "Full membership 2026 - 2027 (10 months) — age group change credit, Youth to Adult",
      // A credit is not an invoice line of this app's.
      xeroAccountCode: null,
      xeroItemCode: null,
    });
  });

  it("is the whole fee for the months left when the new tier owes nothing", async () => {
    // A club whose adults do not owe a subscription.
    const adultsExempt = AGE_TIER_DEFAULTS.map((tier) =>
      tier.tier === "ADULT" ? { ...tier, subscriptionRequiredForBooking: false } : tier);
    const { plan } = planner({ ageTierSettings: adultsExempt });

    const [credit] = await plan([turnsEighteen()], [entryFor("ella", 6_000)]);

    expect(credit).toMatchObject({ kind: "CREDIT", fromAnnualCents: 6_000, toAnnualCents: 0, amountCents: 5_000 });
    // No fee is looked up for a tier that owes nothing.
    expect(mocks.effectiveFee).not.toHaveBeenCalled();
  });

  it("is the mirror image of the top-up, to the cent", async () => {
    fees = {
      YOUTH: { id: "fee-YOUTH", amountCents: 12_001, billingBasis: "PER_MEMBER" },
      ADULT: { id: "fee-ADULT", amountCents: 6_000, billingBasis: "PER_MEMBER" },
    };

    const [credit] = await planner().plan([turnsEighteen()], [entryFor("ella", 12_001)]);

    expect(credit).toMatchObject({ kind: "CREDIT", amountCents: 5_001 });
  });
});

describe("an age-up is settled once (INV-MONEY-052)", () => {
  it.each(["PENDING", "CREDITED_ON_INVOICE", "CREDITED_TO_ACCOUNT"])(
    "raises nothing, and says nothing, when its adjustment already exists (%s)",
    async (status) => {
      stored = [seasonRow("ella", {}, [{ ageUpDate: day("2026-06-15"), kind: "TOP_UP", status }])];
      const { plan, warnings } = planner();

      expect(await plan([turnsEighteen()])).toEqual([]);
      expect(warnings).toEqual([]);
    },
  );

  it("does not raise a voided top-up again, and tells the officer why", async () => {
    stored = [seasonRow("ella", {}, [{ ageUpDate: day("2026-06-15"), kind: "TOP_UP", status: "VOIDED" }])];
    const { plan, warnings } = planner();

    expect(await plan([turnsEighteen()])).toEqual([]);
    expect(warnings).toEqual([expect.objectContaining({
      memberId: "ella",
      message: expect.stringContaining("its top-up invoice was voided in Xero, so it is not raised again"),
    })]);
  });

  it("is not blocked by an adjustment for a different day", async () => {
    stored = [seasonRow("ella", {}, [{ ageUpDate: day("2026-05-01"), kind: "TOP_UP", status: "PENDING" }])];

    expect(await planner().plan([turnsEighteen()])).toHaveLength(1);
  });

  it("raises nothing more for a member this run bills a part-season charge", async () => {
    const { built, plan, warnings, db } = planner();
    const tom = turnsTen();
    await built.partSeasonCharge(tom, FULL);

    expect(await plan([tom], [entryFor("tom", 6_000)])).toEqual([]);
    expect(db.memberSubscription.findMany).not.toHaveBeenCalled();
    expect(warnings).toEqual([]);
  });

  it("raises nothing more for a member whose part-season charge was billed by an earlier run", async () => {
    // Covered already, so the main loop never asks about them; the stored
    // charge was decided on the birthday, which is what makes it part-season.
    stored = [seasonRow("tom", { decisionDate: day("2026-06-15") })];
    const { plan, warnings } = planner();

    expect(await plan([turnsTen()])).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

describe("a season charge this app cannot adjust is settled in Xero (the shared-invoice exception)", () => {
  const warned = async (members: Member[], entries: SubscriptionBillingPlanEntry[] = []) => {
    const { plan, warnings } = planner();
    expect(await plan(members, entries)).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toMatch(/Settle the age-group change in Xero\.$/);
    return warnings[0]!.message;
  };

  it("when the season charge is the family's", async () => {
    stored = [seasonRow("ella", { billingBasis: "PER_FAMILY", _count: { coverage: 3 } })];
    expect(await warned([turnsEighteen()])).toContain("their season subscription is on a shared or no-invoice charge");
  });

  it("when one per-member charge covers more than this member", async () => {
    stored = [seasonRow("ella", { _count: { coverage: 2 } })];
    expect(await warned([turnsEighteen()])).toContain("their season subscription is on a shared or no-invoice charge");
  });

  it("when the season charge is for another membership type", async () => {
    stored = [seasonRow("ella", { membershipTypeId: "type-other" })];
    expect(await warned([turnsEighteen()])).toContain("their season subscription is on a shared or no-invoice charge");
  });

  it("when the season charge was priced for a different age group than they started the season in", async () => {
    stored = [seasonRow("ella", { membershipAnnualFeeId: "fee-ADULT", annualAmountCents: 12_000 })];
    expect(await warned([turnsEighteen()])).toContain("their season subscription was priced for the Adult age group");
  });

  it("when nothing of this app's bills their season at all", async () => {
    // No stored charge and no entry: paid by hand, or on an older invoice.
    stored = [seasonRow("ella", null)];
    expect(await warned([turnsEighteen()])).toContain("their season subscription was not billed by this app");
  });

  it("when this run bills their season on the family's entry, not their own", async () => {
    const family = entryFor("ella", 20_000, { billingBasis: "PER_FAMILY", coveredMembers: [{ id: "ella" }, { id: "parent" }] });
    expect(await warned([turnsEighteen()], [family])).toContain("their season subscription was not billed by this app");
  });

  it("when the new tier's fee is billed to the family", async () => {
    fees.ADULT = { id: "fee-ADULT", amountCents: 12_000, billingBasis: "PER_FAMILY" };
    expect(await warned([turnsEighteen()], [entryFor("ella", 6_000)])).toContain("the Adult fee is not billed per member");
  });

  it("when the new tier has no fee", async () => {
    delete fees.ADULT;
    expect(await warned([turnsEighteen()], [entryFor("ella", 6_000)])).toContain("Full has no Adult fee");
  });

  it("when a member aged into owing but is already covered by a charge that is not their part-season one", async () => {
    stored = [seasonRow("tom", { decisionDate: day("2026-04-10") })];
    expect(await warned([turnsTen()])).toContain("their season subscription is already on an invoice this app cannot add to");
  });

  it("when a category charge covers a member who moved into owing", async () => {
    const inCategory = turnsTen({ seasonalMembershipAssignments: [{ subscriptionCategory: { isActive: true } }] });
    expect(await warned([inCategory])).toContain("their subscription is a category charge shared with their family");
  });

  it("says nothing about a category member whose move does not change whether they owe", async () => {
    // A category fee is flat: Youth to Adult costs the same.
    const inCategory = turnsEighteen({ seasonalMembershipAssignments: [{ subscriptionCategory: { isActive: true } }] });
    const { plan, warnings } = planner();

    expect(await plan([inCategory], [entryFor("ella", 6_000)])).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("still bills a member on a retired category by their own type", async () => {
    const retired = turnsEighteen({ seasonalMembershipAssignments: [{ subscriptionCategory: { isActive: false } }] });

    expect(await planner().plan([retired], [entryFor("ella", 6_000)])).toHaveLength(1);
  });
});

/**
 * The confirm's writes, against a transaction double that records each call.
 * The duplicate-key and race behaviour on a real database is in
 * `subscription-age-up.realdb.test.ts`.
 */
describe("confirmAgeUpAdjustments", () => {
  const item = (overrides: Partial<SubscriptionBillingAgeUpAdjustment> = {}): SubscriptionBillingAgeUpAdjustment => ({
    key: "2026:age-up:ella:2026-06-15",
    kind: "TOP_UP",
    seasonYear: SEASON,
    memberId: "ella",
    memberName: "Ella Member",
    ageUpDate: "2026-06-15",
    fromAgeTier: "YOUTH",
    toAgeTier: "ADULT",
    coveredMonths: 10,
    fromAnnualCents: 6_000,
    toAnnualCents: 12_000,
    amountCents: 5_000,
    description: "Full membership 2026 - 2027 (10 months) — age group change, Youth to Adult",
    membershipTypeId: FULL.id,
    membershipTypeKey: "FULL",
    membershipTypeName: "Full",
    recipient: { id: "ella", name: "Ella Member", email: "ella@example.test" },
    xeroAccountCode: "200",
    xeroItemCode: "SUB",
    ...overrides,
  });

  function transaction(existingAdjustment: { id: string } | null = null) {
    const tx = {
      memberSubscription: { upsert: vi.fn(async () => ({ id: "subscription-ella" })) },
      memberSubscriptionAgeUpAdjustment: {
        findUnique: vi.fn(async () => existingAdjustment),
        create: vi.fn(async () => ({ id: "adjustment-1" })),
      },
      membershipSubscriptionCharge: { upsert: vi.fn(async () => ({ id: "charge-top-up" })) },
    };
    return { tx, client: tx as unknown as Prisma.TransactionClient };
  }

  const confirm = (client: Prisma.TransactionClient, items: SubscriptionBillingAgeUpAdjustment[]) =>
    confirmAgeUpAdjustments(client, {
      preview: { ageUpAdjustments: items, dueDays: 30 },
      source: "ANNUAL_BATCH",
      confirmedByMemberId: "officer-1",
    });

  it("writes a top-up as a charge with one line and no coverage, links it, and queues its invoice", async () => {
    const { tx, client } = transaction();

    expect(await confirm(client, [item()])).toEqual(["charge-top-up"]);

    const key = ageUpTopUpChargeKey("subscription-ella", "2026-06-15");
    expect(tx.membershipSubscriptionCharge.upsert).toHaveBeenCalledTimes(1);
    const charge = tx.membershipSubscriptionCharge.upsert.mock.calls[0]![0 as never] as unknown as {
      where: unknown; update: unknown; create: Record<string, unknown>;
    };
    expect(charge.where).toEqual({ idempotencyKey: key });
    // A second confirm that reaches the upsert changes nothing on the charge.
    expect(charge.update).toEqual({});
    expect(charge.create).toMatchObject({
      idempotencyKey: key,
      seasonYear: SEASON,
      source: "ANNUAL_BATCH",
      status: "QUEUED",
      billingBasis: "PER_MEMBER",
      prorationRule: "REMAINING_MONTHS_INCLUSIVE",
      // The annual difference, and the part of it charged.
      annualAmountCents: 6_000,
      chargedAmountCents: 5_000,
      coveredMonths: 10,
      decisionDate: day("2026-06-15"),
      coverageStart: day("2026-06-01"),
      coverageEnd: day("2027-03-31"),
      recipientMemberId: "ella",
      recipientEmail: "ella@example.test",
      dueDays: 30,
      xeroAccountCode: "200",
      xeroItemCode: "SUB",
      invoiceReference: `MEMSUB-${key.slice(0, 24)}`,
      confirmedByMemberId: "officer-1",
      components: {
        create: [{
          label: "Age group change",
          description: "Full membership 2026 - 2027 (10 months) — age group change, Youth to Adult",
          annualAmountCents: 6_000,
          chargedAmountCents: 5_000,
          prorated: true,
          xeroAccountCode: "200",
          xeroItemCode: "SUB",
          sortOrder: 0,
        }],
      },
    });
    // The member's season row stays covered by their season charge alone.
    expect(charge.create).not.toHaveProperty("coverage");

    expect(tx.memberSubscriptionAgeUpAdjustment.create).toHaveBeenCalledWith({
      data: {
        memberSubscriptionId: "subscription-ella",
        memberId: "ella",
        seasonYear: SEASON,
        ageUpDate: day("2026-06-15"),
        kind: "TOP_UP",
        fromAgeTier: "YOUTH",
        toAgeTier: "ADULT",
        coveredMonths: 10,
        fromAnnualCents: 6_000,
        toAnnualCents: 12_000,
        amountCents: 5_000,
        description: "Full membership 2026 - 2027 (10 months) — age group change, Youth to Adult",
        chargeId: "charge-top-up",
      },
    });

    expect(mocks.startOperation).toHaveBeenCalledTimes(1);
    expect(mocks.startOperation).toHaveBeenCalledWith(expect.objectContaining({
      entityType: "INVOICE",
      localId: "charge-top-up",
      status: "PENDING",
      correlationKey: "membership-charge:charge-top-up:invoice-and-email:v1",
      idempotencyKey: "membership-charge:charge-top-up:invoice-and-email:v1",
      store: client,
    }));
  });

  it("writes a credit as an adjustment with one queued operation, and no charge", async () => {
    const { tx, client } = transaction();
    const credit = item({ kind: "CREDIT", fromAnnualCents: 9_000, toAnnualCents: 6_000, amountCents: 2_500, xeroAccountCode: null, xeroItemCode: null });

    expect(await confirm(client, [credit])).toEqual([]);

    expect(tx.membershipSubscriptionCharge.upsert).not.toHaveBeenCalled();
    expect(tx.memberSubscriptionAgeUpAdjustment.create).toHaveBeenCalledTimes(1);
    expect(tx.memberSubscriptionAgeUpAdjustment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: "CREDIT", amountCents: 2_500, memberSubscriptionId: "subscription-ella" }),
      select: { id: true },
    });
    expect(tx.memberSubscriptionAgeUpAdjustment.create.mock.calls[0]![0 as never]).not.toHaveProperty("data.chargeId");
    expect(mocks.startOperation).toHaveBeenCalledTimes(1);
    expect(mocks.startOperation).toHaveBeenCalledWith({
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel: "MemberSubscriptionAgeUpAdjustment",
      localId: "adjustment-1",
      queueType: "AGE_UP_CREDIT",
      requestPayload: { queueType: "AGE_UP_CREDIT", adjustmentId: "adjustment-1" },
      status: "PENDING",
      idempotencyKey: ageUpCreditIdempotencyKey("adjustment-1"),
      correlationKey: ageUpCreditIdempotencyKey("adjustment-1"),
      createdByMemberId: "officer-1",
      store: client,
    });
  });

  it.each(["TOP_UP", "CREDIT"] as const)(
    "writes and queues nothing for a %s whose adjustment already exists",
    async (kind) => {
      const { tx, client } = transaction({ id: "adjustment-earlier" });

      expect(await confirm(client, [item({ kind })])).toEqual([]);

      expect(tx.memberSubscriptionAgeUpAdjustment.findUnique).toHaveBeenCalledWith({
        where: { memberSubscriptionId_ageUpDate: { memberSubscriptionId: "subscription-ella", ageUpDate: day("2026-06-15") } },
        select: { id: true },
      });
      expect(tx.memberSubscriptionAgeUpAdjustment.create).not.toHaveBeenCalled();
      expect(tx.membershipSubscriptionCharge.upsert).not.toHaveBeenCalled();
      expect(mocks.startOperation).not.toHaveBeenCalled();
    },
  );

  it("refuses a top-up with no Xero account rather than queue an invoice that cannot be raised", async () => {
    const { tx, client } = transaction();

    await expect(confirm(client, [item({ xeroAccountCode: null })])).rejects.toThrow("no resolved Xero account code");

    expect(tx.membershipSubscriptionCharge.upsert).not.toHaveBeenCalled();
    expect(tx.memberSubscriptionAgeUpAdjustment.create).not.toHaveBeenCalled();
  });

  it("keys the top-up charge on the subscription and the day, so a re-priced re-run finds the same charge", () => {
    expect(ageUpTopUpChargeKey("subscription-ella", "2026-06-15")).toBe(ageUpTopUpChargeKey("subscription-ella", "2026-06-15"));
    expect(ageUpTopUpChargeKey("subscription-ella", "2026-06-15")).not.toBe(ageUpTopUpChargeKey("subscription-ella", "2026-06-16"));
    expect(ageUpTopUpChargeKey("subscription-ella", "2026-06-15")).not.toBe(ageUpTopUpChargeKey("subscription-other", "2026-06-15"));
  });
});
