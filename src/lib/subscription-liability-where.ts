import type { Prisma } from "@prisma/client";

import type { CalendarDate } from "@/lib/club-time";
import { dateOfBirthPrefilterBoundForMinAge } from "@/lib/date-of-birth-prefilter";
import { NON_MEMBER_ROLE_VALUES, OPERATIONAL_ROLE_VALUES } from "@/lib/member-roles";
import {
  getSeasonStartCalendarDate,
  type AgeTierSettingData,
} from "@/lib/policies/age-tier";
import {
  ADMIN_LIST_LIABILITY_SIDE,
  getSeasonEndCalendarDate,
  liabilityRuleFor,
  type LiabilityAgeTierSource,
  type SubscriptionLiabilitySettings,
} from "@/lib/policies/subscription";
import {
  NOT_REQUIRED_ROW_BILLING_STATUS,
  notRequiredRowBillingNoteWhere,
} from "@/lib/subscription-season-row-note";

/**
 * The SQL form of "this member owes no subscription this season" (#5190): the
 * shared liability rule (`resolveMemberSubscriptionLiability`) on the side the
 * admin lists show (`ADMIN_LIST_LIABILITY_SIDE`, billing until the club chooses
 * a rule — owner decision Q2, 22 Nov 2026) as a Prisma `OR` list, for the admin members list, its CSV export and the
 * subscriptions list, which filter in the database and then display the rule's
 * own answer per row. Built from the same settings as the rule, and held to it
 * by `subscription-liability-where.test.ts`, which evaluates both over the same
 * members.
 *
 * A member's effective type is their season assignment, else their role's
 * built-in default (`effectiveSubscriptionBehavior`). No role default is
 * `BASED_ON_AGE_TIER`, so a clause that needs that type needs an assignment.
 */
export function subscriptionNotRequiredMemberConditions(input: {
  seasonYear: number;
  ageTierSettings: AgeTierSettingData[];
  liabilitySettings: SubscriptionLiabilitySettings;
  /**
   * Whether to include the saved-row exemption clause, for a side whose rule
   * lets a saved row exempt (only booking access while the club has not
   * chosen, so never the lists' billing side today; kept so the SQL mirrors the
   * rule on any side). A caller that judges rows separately (the subscriptions
   * list) leaves it out.
   */
  includeSeasonRowExemption?: boolean;
}): Prisma.MemberWhereInput[] {
  const { seasonYear } = input;
  const rule = liabilityRuleFor(ADMIN_LIST_LIABILITY_SIDE, input.liabilitySettings);
  const assignedBehavior = (subscriptionBehavior: "NOT_REQUIRED" | "BASED_ON_AGE_TIER") => ({
    seasonalMembershipAssignments: {
      some: { seasonYear, membershipType: { subscriptionBehavior } },
    },
  });
  const exemptTier = exemptAgeTierWhere(
    rule.ageSource,
    seasonYear,
    input.ageTierSettings,
  );
  return [
    // #2149: the role's default type is NOT_REQUIRED and no assignment overrides it.
    {
      AND: [
        { seasonalMembershipAssignments: { none: { seasonYear } } },
        { role: { in: [...OPERATIONAL_ROLE_VALUES, ...NON_MEMBER_ROLE_VALUES] } },
      ],
    },
    assignedBehavior("NOT_REQUIRED"),
    // #2041 (only while NOT_CHOSEN): a BASED_ON_AGE_TIER member's saved
    // NOT_REQUIRED row.
    ...(rule.seasonRowExempts && input.includeSeasonRowExemption !== false
      ? [{
          ...assignedBehavior("BASED_ON_AGE_TIER"),
          subscriptions: { some: { seasonYear, status: "NOT_REQUIRED" as const } },
        }]
      : []),
    // An exempt age tier: for any type when the rule lets the tier exempt a
    // REQUIRED type, otherwise only for a BASED_ON_AGE_TIER assignment.
    rule.requiredTypeAgeRule === "AGE_TIER_EXEMPTS"
      ? exemptTier
      : { AND: [assignedBehavior("BASED_ON_AGE_TIER"), exemptTier] },
  ];
}

/**
 * Members whose liability tier, read from `source`, is not subscription-liable.
 * The stored-tier set includes `NOT_APPLICABLE`, which the rule never treats as
 * liable. A DOB-derived source matches each exempt tier's age band as a
 * date-of-birth range on the reference day, using the age-up cron's exact bound
 * (`dateOfBirthPrefilterBoundForMinAge`); a member with no date of birth keeps
 * their stored tier, as the rule does.
 */
function exemptAgeTierWhere(
  source: LiabilityAgeTierSource,
  seasonYear: number,
  ageTierSettings: AgeTierSettingData[],
): Prisma.MemberWhereInput {
  const exemptSettings = ageTierSettings.filter(
    (setting) => !setting.subscriptionRequiredForBooking,
  );
  const storedTierExempt: Prisma.MemberWhereInput = {
    ageTier: { in: [...exemptSettings.map((setting) => setting.tier), "NOT_APPLICABLE"] },
  };
  if (source === "STORED_TIER") return storedTierExempt;
  const reference: CalendarDate =
    source === "SEASON_START"
      ? getSeasonStartCalendarDate(seasonYear)
      : getSeasonEndCalendarDate(seasonYear);
  return {
    OR: [
      { AND: [{ dateOfBirth: null }, storedTierExempt] },
      ...exemptSettings.map((setting) => ({
        dateOfBirth: {
          // Explicit: under a caller's `NOT: { OR }` a NULL comparison is
          // unknown and would drop a no-DOB member from both sides.
          not: null,
          // Born before this day: at least `minAge` on the reference day.
          lt: dateOfBirthPrefilterBoundForMinAge(reference, setting.minAge),
          // Born on or after this day: not yet `maxAge + 1`.
          ...(setting.maxAge === null
            ? {}
            : { gte: dateOfBirthPrefilterBoundForMinAge(reference, setting.maxAge + 1) }),
        },
      })),
    ],
  };
}

/** The saved-row statuses the members list and its CSV export filter on. */
export const MEMBER_LIST_SUBSCRIPTION_STATUS_FILTERS = [
  "PAID",
  "UNPAID",
  "OVERDUE",
  "NOT_INVOICED",
] as const;

/**
 * The members list's and CSV export's subscription filter (#2149, #5190), one
 * definition for both. Each value matches exactly the members whose row shows
 * that status (`listSubscriptionStatus`): "NOT_REQUIRED" the lists' exempt set
 * plus an owing member's un-noted saved "Not required" row; "NONE" an owing
 * member with no row; a status an owing member whose row has
 * it, and "NOT_INVOICED" also a noted saved "Not required" row
 * (`notRequiredRowBillingNoteWhere`). An unknown value filters nothing.
 */
export function memberListSubscriptionFilterConditions(
  filter: string | null | undefined,
  input: { seasonYear: number; notRequiredConditions: Prisma.MemberWhereInput[] },
): Prisma.MemberWhereInput[] {
  const { seasonYear, notRequiredConditions } = input;
  const owing: Prisma.MemberWhereInput = { NOT: { OR: notRequiredConditions } };
  const noted = notRequiredRowBillingNoteWhere({ seasonYear, notRequiredConditions });
  if (filter === "NOT_REQUIRED") {
    return [
      {
        OR: [
          ...notRequiredConditions,
          // An owing member whose saved "Not required" row carries no note
          // (covered, outside the billing population) still shows that row.
          {
            AND: [
              owing,
              { subscriptions: { some: { seasonYear, status: "NOT_REQUIRED" } } },
              { NOT: noted },
            ],
          },
        ],
      },
    ];
  }
  if (filter === "NONE") {
    // #2149: no separate role exclusion; the conditions exempt bare
    // operational/non-member accounts through the role's default type.
    return [owing, { subscriptions: { none: { seasonYear } } }];
  }
  if (
    !filter ||
    !(MEMBER_LIST_SUBSCRIPTION_STATUS_FILTERS as readonly string[]).includes(filter)
  ) {
    return [];
  }
  const savedStatus: Prisma.MemberWhereInput = {
    subscriptions: {
      some: { seasonYear, status: filter as (typeof MEMBER_LIST_SUBSCRIPTION_STATUS_FILTERS)[number] },
    },
  };
  if (filter !== NOT_REQUIRED_ROW_BILLING_STATUS) return [owing, savedStatus];
  return [
    {
      OR: [
        { AND: [owing, savedStatus] },
        noted,
      ],
    },
  ];
}
