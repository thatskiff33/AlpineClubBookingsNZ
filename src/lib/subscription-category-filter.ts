import type { Prisma } from "@prisma/client";

/**
 * Sentinel value for the members-list "Subscription category" filter that
 * matches members billed as Individual this season: no current-season
 * assignment with a category set, which includes members with no assignment
 * at all. Shared by the toolbar (client), the list and export services
 * (server) and their tests. Real category ids are cuids, so this literal
 * cannot collide with one.
 */
export const NO_SUBSCRIPTION_CATEGORY_VALUE = "NONE";

/**
 * The one where-clause for the members-list category filter, used by both the
 * list and the CSV export so the exported roster matches the screen. Judged on
 * the CURRENT season's assignment, the same row the list's Type – Tier column
 * and category label are read from. Returns null when no filter applies.
 */
export function subscriptionCategoryFilterWhere(
  value: string | null | undefined,
  currentSeasonYear: number,
): Prisma.MemberWhereInput | null {
  if (!value) return null;
  if (value === NO_SUBSCRIPTION_CATEGORY_VALUE) {
    return {
      seasonalMembershipAssignments: {
        none: {
          seasonYear: currentSeasonYear,
          subscriptionCategoryId: { not: null },
        },
      },
    };
  }
  return {
    seasonalMembershipAssignments: {
      some: {
        seasonYear: currentSeasonYear,
        subscriptionCategoryId: value,
      },
    },
  };
}
