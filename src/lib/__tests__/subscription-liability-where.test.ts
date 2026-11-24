import type {
  AgeTier,
  MembershipTypeSubscriptionBehavior,
  Role,
  SubscriptionStatus,
} from "@prisma/client";
import { describe, expect, it } from "vitest";

import { matchesWhere } from "@/lib/__tests__/support/prisma-where";
import {
  effectiveSubscriptionBehavior,
  isSubscriptionNotRequiredForMembershipType,
} from "@/lib/membership-types";
import type { AgeTierSettingData } from "@/lib/policies/age-tier";
import type { SubscriptionLiabilitySettings } from "@/lib/policies/subscription";
import {
  MEMBER_LIST_SUBSCRIPTION_STATUS_FILTERS,
  memberListSubscriptionFilterConditions,
  subscriptionNotRequiredMemberConditions,
} from "@/lib/subscription-liability-where";
import {
  listSubscriptionStatus,
  notRequiredRowBillingNote,
} from "@/lib/subscription-season-row-note";

// #5190: the admin members list, its CSV export and the subscriptions list
// filter "subscription not required" in SQL and then show the shared rule's own
// answer per row (billing side until the club chooses, owner decision Q2). If the two disagree, a member is listed under the wrong filter.
// This holds the SQL form to the rule over the same members, for every setting.

const SEASON = 2026;

// INFANT and CHILD are age-exempt; YOUTH and ADULT owe a subscription. The bands
// cover every age, as the age-tier settings screen requires.
const AGE_TIER_SETTINGS: AgeTierSettingData[] = [
  { tier: "INFANT", minAge: 0, maxAge: 4, label: "Infant", sortOrder: 0, subscriptionRequiredForBooking: false },
  { tier: "CHILD", minAge: 5, maxAge: 12, label: "Child", sortOrder: 1, subscriptionRequiredForBooking: false },
  { tier: "YOUTH", minAge: 13, maxAge: 17, label: "Youth", sortOrder: 2, subscriptionRequiredForBooking: true },
  { tier: "ADULT", minAge: 18, maxAge: null, label: "Adult", sortOrder: 3, subscriptionRequiredForBooking: true },
];

const SETTINGS: SubscriptionLiabilitySettings[] = [
  { requiredTypeAgeRule: "NOT_CHOSEN", liabilityAgeSource: "NOT_CHOSEN" },
  { requiredTypeAgeRule: "ALWAYS_OWES", liabilityAgeSource: "SEASON_START" },
  { requiredTypeAgeRule: "ALWAYS_OWES", liabilityAgeSource: "SEASON_END" },
  { requiredTypeAgeRule: "AGE_TIER_EXEMPTS", liabilityAgeSource: "SEASON_START" },
  { requiredTypeAgeRule: "AGE_TIER_EXEMPTS", liabilityAgeSource: "SEASON_END" },
];

// Season 2026 runs 2026-04-01 to 2027-03-31. These dates of birth sit either
// side of the CHILD/YOUTH boundary (13th birthday) at each end of the season.
const DATES_OF_BIRTH: Array<Date | null> = [
  null,
  new Date("2013-04-01T00:00:00.000Z"), // 13 on the first day: YOUTH all season
  new Date("2013-04-02T00:00:00.000Z"), // 12 at the start, 13 at the end
  new Date("2014-03-31T00:00:00.000Z"), // 12 at the start, 13 on the last day
  new Date("2014-04-01T00:00:00.000Z"), // 12 all season
  new Date("2023-06-01T00:00:00.000Z"), // INFANT
  new Date("1980-01-01T00:00:00.000Z"), // ADULT
];

const STORED_TIERS: AgeTier[] = ["CHILD", "YOUTH", "ADULT", "NOT_APPLICABLE"];
const ROLES: Role[] = ["USER", "ADMIN"];
const ASSIGNMENTS: Array<MembershipTypeSubscriptionBehavior | null> = [
  null,
  "REQUIRED",
  "NOT_REQUIRED",
  "BASED_ON_AGE_TIER",
];
const ROW_STATUSES: Array<SubscriptionStatus | null> = [null, "NOT_REQUIRED", "PAID"];

interface FakeMember {
  role: Role;
  ageTier: AgeTier;
  dateOfBirth: Date | null;
  assignment: MembershipTypeSubscriptionBehavior | null;
  rowStatus: SubscriptionStatus | null;
}

function* members(): Generator<FakeMember> {
  for (const role of ROLES)
    for (const ageTier of STORED_TIERS)
      for (const dateOfBirth of DATES_OF_BIRTH)
        for (const assignment of ASSIGNMENTS)
          for (const rowStatus of ROW_STATUSES)
            yield { role, ageTier, dateOfBirth, assignment, rowStatus };
}

function asRow(member: FakeMember) {
  return {
    role: member.role,
    ageTier: member.ageTier,
    dateOfBirth: member.dateOfBirth,
    seasonalMembershipAssignments: member.assignment
      ? [{ seasonYear: SEASON, membershipType: { subscriptionBehavior: member.assignment } }]
      : [],
    subscriptions: member.rowStatus
      ? [{ seasonYear: SEASON, status: member.rowStatus }]
      : [],
  };
}

function ruleSaysNotRequired(
  member: FakeMember,
  liabilitySettings: SubscriptionLiabilitySettings,
  seasonRowStatus: SubscriptionStatus | null,
) {
  return isSubscriptionNotRequiredForMembershipType({
    subscriptionBehavior: effectiveSubscriptionBehavior(member.assignment, member.role),
    member,
    seasonRowStatus,
    seasonYear: SEASON,
    ageTierSettings: AGE_TIER_SETTINGS,
    liabilitySettings,
  });
}

describe("subscriptionNotRequiredMemberConditions matches the shared liability rule", () => {
  it.each(SETTINGS)(
    "agrees member for member under %o",
    (liabilitySettings) => {
      const where = {
        OR: subscriptionNotRequiredMemberConditions({
          seasonYear: SEASON,
          ageTierSettings: AGE_TIER_SETTINGS,
          liabilitySettings,
        }),
      };
      let exempt = 0;
      for (const member of members()) {
        const expected = ruleSaysNotRequired(member, liabilitySettings, member.rowStatus);
        if (expected) exempt += 1;
        expect(matchesWhere(asRow(member), where), JSON.stringify(member)).toBe(expected);
      }
      // Neither side may agree by matching everyone or no one.
      expect(exempt).toBeGreaterThan(0);
      expect(exempt).toBeLessThan([...members()].length);
    },
  );

  it.each(SETTINGS)(
    "without the season-row clause, agrees with the rule judging no row, under %o",
    (liabilitySettings) => {
      const where = {
        OR: subscriptionNotRequiredMemberConditions({
          seasonYear: SEASON,
          ageTierSettings: AGE_TIER_SETTINGS,
          liabilitySettings,
          includeSeasonRowExemption: false,
        }),
      };
      for (const member of members()) {
        expect(matchesWhere(asRow(member), where), JSON.stringify(member)).toBe(
          ruleSaysNotRequired(member, liabilitySettings, null),
        );
      }
    },
  );

  // Owner decision Q2 (#5190, 22 Nov 2026): the lists follow billing until the
  // club chooses. An organisation or school account carries the NOT_APPLICABLE
  // tier and no date of birth; on a REQUIRED type it is listed as owing while
  // NOT_CHOSEN (booking access would let it book), then follows the choice.
  it("lists an organisation on a REQUIRED type as owing while NOT_CHOSEN, then follows the club's choice", () => {
    const organisation: FakeMember = {
      role: "USER",
      ageTier: "NOT_APPLICABLE",
      dateOfBirth: null,
      assignment: "REQUIRED",
      rowStatus: null,
    };
    const listedNotRequired = (liabilitySettings: SubscriptionLiabilitySettings) => {
      const sql = matchesWhere(asRow(organisation), {
        OR: subscriptionNotRequiredMemberConditions({
          seasonYear: SEASON,
          ageTierSettings: AGE_TIER_SETTINGS,
          liabilitySettings,
        }),
      });
      expect(sql).toBe(ruleSaysNotRequired(organisation, liabilitySettings, null));
      return sql;
    };
    expect(listedNotRequired({ requiredTypeAgeRule: "NOT_CHOSEN", liabilityAgeSource: "NOT_CHOSEN" })).toBe(false);
    expect(listedNotRequired({ requiredTypeAgeRule: "AGE_TIER_EXEMPTS", liabilityAgeSource: "SEASON_START" })).toBe(true);
    expect(listedNotRequired({ requiredTypeAgeRule: "AGE_TIER_EXEMPTS", liabilityAgeSource: "SEASON_END" })).toBe(true);
    expect(listedNotRequired({ requiredTypeAgeRule: "ALWAYS_OWES", liabilityAgeSource: "SEASON_START" })).toBe(false);
  });

  // The members list and CSV export ask for owing members with `NOT: { OR }`.
  // A NULL comparison inside that negation is unknown in PostgreSQL and drops
  // the row from BOTH filters, so a member with no date of birth must meet
  // only two-valued clauses (the evaluator throws on an unknown under NOT).
  it.each(SETTINGS)(
    "negated, still places every member (no date of birth included) under %o",
    (liabilitySettings) => {
      const where = {
        NOT: {
          OR: subscriptionNotRequiredMemberConditions({
            seasonYear: SEASON,
            ageTierSettings: AGE_TIER_SETTINGS,
            liabilitySettings,
          }),
        },
      };
      for (const member of members()) {
        expect(matchesWhere(asRow(member), where), JSON.stringify(member)).toBe(
          !ruleSaysNotRequired(member, liabilitySettings, member.rowStatus),
        );
      }
    },
  );
});

// #5190 review (owner decision 22 Nov 2026): a saved "Not required" row the
// billing side treats as owing shows billing's status with a note. Every list
// filter must hold exactly the members whose row shows that status (#2149),
// so each member below matches one filter: the one its row displays.
describe("memberListSubscriptionFilterConditions matches the displayed status", () => {
  const FILTERS = ["NOT_REQUIRED", "NONE", ...MEMBER_LIST_SUBSCRIPTION_STATUS_FILTERS];
  const ROWS: Array<{ status: SubscriptionStatus; covered: boolean } | null> = [
    null,
    { status: "NOT_REQUIRED", covered: false },
    { status: "NOT_REQUIRED", covered: true },
    { status: "NOT_INVOICED", covered: false },
    { status: "PAID", covered: false },
  ];

  function* listMembers() {
    for (const role of ROLES)
      for (const ageTier of STORED_TIERS)
        for (const dateOfBirth of DATES_OF_BIRTH)
          for (const assignment of ASSIGNMENTS)
            for (const row of ROWS)
              for (const active of [true, false])
                yield { role, ageTier, dateOfBirth, assignment, row, active };
  }
  type ListMember = ReturnType<typeof listMembers> extends Generator<infer T> ? T : never;

  function dbRow(member: ListMember) {
    return {
      ...asRow({ ...member, rowStatus: null }),
      active: member.active,
      archivedAt: null,
      subscriptions: member.row
        ? [{
            seasonYear: SEASON,
            status: member.row.status,
            xeroInvoiceId: null,
            manuallyMarkedPaidAt: null,
            chargeCoverage: member.row.covered ? [{ id: "claim", releasedAt: null }] : [],
          }]
        : [],
    };
  }

  function displayed(member: ListMember, liabilitySettings: SubscriptionLiabilitySettings) {
    const seasonRow = member.row
      ? {
          status: member.row.status,
          xeroInvoiceId: null,
          manuallyMarkedPaidAt: null,
          chargeCoverage: member.row.covered ? [{ id: "claim" }] : [],
        }
      : null;
    const facts = {
      subscriptionBehavior: effectiveSubscriptionBehavior(member.assignment, member.role),
      member: { ...member, archivedAt: null },
      seasonYear: SEASON,
      ageTierSettings: AGE_TIER_SETTINGS,
      liabilitySettings,
    };
    return (
      listSubscriptionStatus({
        notRequired: isSubscriptionNotRequiredForMembershipType({
          ...facts,
          seasonRowStatus: seasonRow?.status,
        }),
        seasonRowStatus: seasonRow?.status,
        billingNote: notRequiredRowBillingNote({ ...facts, seasonRow }),
      }) ?? "NONE"
    );
  }

  it.each(SETTINGS)("places every member under the filter its row shows, under %o", (liabilitySettings) => {
    const notRequiredConditions = subscriptionNotRequiredMemberConditions({
      seasonYear: SEASON,
      ageTierSettings: AGE_TIER_SETTINGS,
      liabilitySettings,
    });
    let noted = 0;
    for (const member of listMembers()) {
      const shown = displayed(member, liabilitySettings);
      if (member.row?.status === "NOT_REQUIRED" && shown === "NOT_INVOICED") noted += 1;
      const matched = FILTERS.filter((filter) =>
        matchesWhere(dbRow(member), {
          AND: memberListSubscriptionFilterConditions(filter, {
            seasonYear: SEASON,
            notRequiredConditions,
          }),
        }),
      );
      expect(matched, JSON.stringify(member)).toEqual([shown]);
    }
    // Under NOT_CHOSEN billing ignores the saved row, so some rows are noted.
    if (liabilitySettings.requiredTypeAgeRule === "NOT_CHOSEN") expect(noted).toBeGreaterThan(0);
  });

  it("shows a noted member as not invoiced, under that filter only", () => {
    const member: ListMember = {
      role: "USER",
      ageTier: "ADULT",
      dateOfBirth: null,
      assignment: "BASED_ON_AGE_TIER",
      row: { status: "NOT_REQUIRED", covered: false },
      active: true,
    };
    const liabilitySettings = SETTINGS[0];
    expect(displayed(member, liabilitySettings)).toBe("NOT_INVOICED");
    const notRequiredConditions = subscriptionNotRequiredMemberConditions({
      seasonYear: SEASON,
      ageTierSettings: AGE_TIER_SETTINGS,
      liabilitySettings,
    });
    for (const filter of FILTERS) {
      expect(
        matchesWhere(dbRow(member), {
          AND: memberListSubscriptionFilterConditions(filter, { seasonYear: SEASON, notRequiredConditions }),
        }),
        filter,
      ).toBe(filter === "NOT_INVOICED");
    }
  });
});
