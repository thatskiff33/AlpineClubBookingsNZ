import { describe, expect, it, vi } from "vitest";

/**
 * Booking access around a mid-season age-up under "Age today" (#5190 PR 3,
 * `INV-LOCKOUT-020`; owner decisions 20 and 27 Nov 2026):
 *
 *  - a member who ages INTO owing may book until their part-season invoice is
 *    issued, and is held to it from then on;
 *  - an issued, unpaid top-up holds a member back even on a paid season;
 *  - a credit, and a top-up that is not issued, is paid or was voided, never does.
 *
 * Season 2026 runs 2026-04-01 to 2027-03-31; the default tiers exempt CHILD
 * (5-9) and bill YOUTH (10-17) and ADULT (18+).
 */

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { requireCalendarDate } from "@/lib/club-time";
import { AGE_TIER_DEFAULTS } from "@/lib/policies/age-tier";
import type { SubscriptionLiabilitySettings } from "@/lib/policies/subscription";
import {
  ISSUED_UNPAID_AGE_UP_TOP_UP,
  loadMemberSubscriptionSettlements,
  resolveMemberSubscriptionSettlement,
  subscriptionIsSettled,
  subscriptionIsUnpaid,
  type SubscriptionSettlementDb,
} from "@/lib/subscription-lockout-facts";

const SEASON = 2026;
const AGE_TODAY: SubscriptionLiabilitySettings = {
  requiredTypeAgeRule: "AGE_TIER_EXEMPTS",
  liabilityAgeSource: "CURRENT_AGE",
};
const day = (value: string) => new Date(`${value}T00:00:00.000Z`);

/** Turns 10 on 2026-06-15: a Child at season start, a Youth from that day. */
const TURNS_TEN = { dateOfBirth: day("2016-06-15"), ageTier: "CHILD" as const };
/** Turns 18 on 2026-06-15: owes at both tiers. */
const TURNS_EIGHTEEN = { dateOfBirth: day("2008-06-15"), ageTier: "YOUTH" as const };

type SeasonStatus = "PAID" | "UNPAID" | "OVERDUE" | "NOT_INVOICED" | "NOT_REQUIRED";

function settle(input: {
  member?: typeof TURNS_TEN | typeof TURNS_EIGHTEEN;
  status?: SeasonStatus | null;
  today?: string;
  issuedUnpaidAgeUpTopUp?: boolean;
  liabilitySettings?: SubscriptionLiabilitySettings;
}) {
  return resolveMemberSubscriptionSettlement({
    subscriptionBehavior: "BASED_ON_AGE_TIER",
    subscriptionStatus: input.status ?? null,
    coveredByNoInvoiceCharge: false,
    issuedUnpaidAgeUpTopUp: input.issuedUnpaidAgeUpTopUp ?? false,
    member: input.member ?? TURNS_TEN,
    seasonYear: SEASON,
    today: requireCalendarDate(input.today ?? "2026-07-01"),
    ageTierSettings: AGE_TIER_DEFAULTS,
    liabilitySettings: input.liabilitySettings ?? AGE_TODAY,
  });
}

describe("a member who ages into owing has a grace until their part-season invoice is issued (INV-LOCKOUT-020)", () => {
  it.each([null, "NOT_INVOICED", "NOT_REQUIRED"] as const)(
    "may book after the birthday while nothing is issued (season row %s)",
    (status) => {
      const settlement = settle({ status });
      expect(settlement.subscriptionRequired).toBe(false);
      expect(subscriptionIsSettled(settlement)).toBe(true);
    },
  );

  it.each(["UNPAID", "OVERDUE"] as const)(
    "is held to the part-season invoice once it is issued (season row %s)",
    (status) => {
      const settlement = settle({ status });
      expect(settlement).toEqual({ subscriptionRequired: true, subscriptionPaid: false });
      expect(subscriptionIsUnpaid(settlement)).toBe(true);
    },
  );

  it("is settled again once the part-season invoice is paid", () => {
    expect(subscriptionIsSettled(settle({ status: "PAID" }))).toBe(true);
  });

  it("owes nothing the day before the birthday, issued or not", () => {
    for (const status of [null, "UNPAID"] as const) {
      expect(settle({ status, today: "2026-06-14" }).subscriptionRequired).toBe(false);
    }
    // ...and the grace starts on the birthday itself.
    expect(settle({ status: "UNPAID", today: "2026-06-15" }).subscriptionRequired).toBe(true);
  });

  it("gives no grace to a member who already owed at the season's start", () => {
    // Youth at season start, Adult from 2026-06-15: they owed all along.
    const settlement = settle({ member: TURNS_EIGHTEEN, status: "NOT_INVOICED" });
    expect(settlement).toEqual({ subscriptionRequired: true, subscriptionPaid: false });
  });

  it("is a rule of \"Age today\" only: the season-end age owes from the first day, with no grace", () => {
    const seasonEnd = { ...AGE_TODAY, liabilityAgeSource: "SEASON_END" } as const;
    expect(settle({ status: "NOT_INVOICED", liabilitySettings: seasonEnd }).subscriptionRequired).toBe(true);
    // ...and the season-start age never owes this season.
    const seasonStart = { ...AGE_TODAY, liabilityAgeSource: "SEASON_START" } as const;
    expect(settle({ status: "UNPAID", liabilitySettings: seasonStart }).subscriptionRequired).toBe(false);
  });
});

describe("an issued, unpaid top-up is part of what a member owes (INV-LOCKOUT-020)", () => {
  it("holds back a member whose season subscription is paid", () => {
    const settlement = settle({ member: TURNS_EIGHTEEN, status: "PAID", issuedUnpaidAgeUpTopUp: true });
    expect(settlement).toEqual({ subscriptionRequired: true, subscriptionPaid: false });
    expect(subscriptionIsUnpaid(settlement)).toBe(true);
  });

  it("releases them once it is no longer issued and unpaid", () => {
    expect(subscriptionIsSettled(settle({ member: TURNS_EIGHTEEN, status: "PAID" }))).toBe(true);
  });
});

/**
 * The loader's database double applies the adjustment filter the loader sends,
 * so these cases prove the shared select (`ISSUED_UNPAID_AGE_UP_TOP_UP`) keeps
 * every adjustment that must not block out of the answer.
 */
type Adjustment = {
  id: string;
  kind: "TOP_UP" | "CREDIT";
  status: "PENDING" | "CREDITED_ON_INVOICE" | "CREDITED_TO_ACCOUNT" | "VOIDED";
  xeroInvoiceStatus: SeasonStatus | null;
};

function dbWith(adjustments: Adjustment[], settings: SubscriptionLiabilitySettings = AGE_TODAY) {
  const clubTimeSettings = { findUnique: vi.fn(async () => ({ timeZone: "Pacific/Auckland" })) };
  const db = {
    memberSubscription: {
      findMany: vi.fn(async (args: { select: { ageUpAdjustments: typeof ISSUED_UNPAID_AGE_UP_TOP_UP } }) => {
        const { where, take } = args.select.ageUpAdjustments;
        const statuses: readonly string[] = where.xeroInvoiceStatus.in;
        return [{
          memberId: "member-1",
          status: "PAID" as const,
          chargeCoverage: [],
          ageUpAdjustments: adjustments
            .filter((row) =>
              row.kind === where.kind &&
              row.status === where.status &&
              row.xeroInvoiceStatus !== null &&
              statuses.includes(row.xeroInvoiceStatus))
            .slice(0, take)
            .map((row) => ({ id: row.id })),
        }];
      }),
    },
    member: { findMany: vi.fn(async () => [{ id: "member-1", ...TURNS_EIGHTEEN }]) },
    membershipLockoutSettings: { findUnique: vi.fn(async () => settings) },
    clubTimeSettings,
  };
  return { db: db as unknown as SubscriptionSettlementDb, clubTimeSettings };
}

async function loaded(adjustments: Adjustment[], today: string | null = "2026-07-01") {
  const { db } = dbWith(adjustments);
  const settlements = await loadMemberSubscriptionSettlements(db, {
    memberIds: ["member-1"],
    seasonYear: SEASON,
    subscriptionBehaviorByMember: new Map([["member-1", "BASED_ON_AGE_TIER" as const]]),
    readAgeTierSettings: async () => AGE_TIER_DEFAULTS,
    ...(today ? { today: requireCalendarDate(today) } : {}),
  });
  return settlements.get("member-1");
}

describe("which adjustments hold a paid member back, as the loader reads them", () => {
  const topUp = (overrides: Partial<Adjustment> = {}): Adjustment => ({
    id: "adjustment-1", kind: "TOP_UP", status: "PENDING", xeroInvoiceStatus: "UNPAID", ...overrides,
  });

  it.each(["UNPAID", "OVERDUE"] as const)("an issued top-up that is %s does", async (xeroInvoiceStatus) => {
    expect(subscriptionIsUnpaid(await loaded([topUp({ xeroInvoiceStatus })]))).toBe(true);
  });

  it("a top-up whose invoice is not issued yet does not", async () => {
    expect(subscriptionIsSettled(await loaded([topUp({ xeroInvoiceStatus: null })]))).toBe(true);
  });

  it("a paid top-up does not", async () => {
    expect(subscriptionIsSettled(await loaded([topUp({ xeroInvoiceStatus: "PAID" })]))).toBe(true);
  });

  it("a voided top-up does not, even though its invoice was last seen unpaid", async () => {
    expect(subscriptionIsSettled(await loaded([topUp({ status: "VOIDED" })]))).toBe(true);
  });

  it.each(["PENDING", "CREDITED_ON_INVOICE", "CREDITED_TO_ACCOUNT"] as const)(
    "a credit never does (%s)",
    async (status) => {
      // A credit carries no invoice status; one is set here to prove the kind
      // alone keeps it out.
      const credit: Adjustment = { id: "adjustment-2", kind: "CREDIT", status, xeroInvoiceStatus: "UNPAID" };
      expect(subscriptionIsSettled(await loaded([credit]))).toBe(true);
    },
  );
});

describe("the day the loader reads ages on", () => {
  const caller = (settings: SubscriptionLiabilitySettings, today?: string) => {
    const { db, clubTimeSettings } = dbWith([], settings);
    const settlements = loadMemberSubscriptionSettlements(db, {
      memberIds: ["member-1"],
      seasonYear: SEASON,
      subscriptionBehaviorByMember: new Map([["member-1", "BASED_ON_AGE_TIER" as const]]),
      readAgeTierSettings: async () => AGE_TIER_DEFAULTS,
      ...(today ? { today: requireCalendarDate(today) } : {}),
    });
    return { settlements, clubTimeSettings };
  };

  it("is the club's today, read through the caller's own client, for a club on \"Age today\"", async () => {
    const { settlements, clubTimeSettings } = caller(AGE_TODAY);
    await settlements;
    expect(clubTimeSettings.findUnique).toHaveBeenCalledTimes(1);
  });

  it("is the caller's day when it passes one: no second read", async () => {
    const { settlements, clubTimeSettings } = caller(AGE_TODAY, "2026-07-01");
    await settlements;
    expect(clubTimeSettings.findUnique).not.toHaveBeenCalled();
  });

  it("is not read at all for a club on another age source", async () => {
    const { settlements, clubTimeSettings } = caller({ ...AGE_TODAY, liabilityAgeSource: "SEASON_START" });
    await settlements;
    expect(clubTimeSettings.findUnique).not.toHaveBeenCalled();
  });
});
